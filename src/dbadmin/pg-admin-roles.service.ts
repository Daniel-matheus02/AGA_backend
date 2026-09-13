import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { PgAdminConnectionRegistry } from './pg-connection.registry';
import { PanelActor } from './db-admin-users.service';
import { PgAlterRoleDto, PgCreateRoleDto, PgRenameRoleDto } from './dto';

/** Papéis internos do servidor: nunca aparecem na listagem do painel. */
const SYSTEM_ROLE_PREFIX = 'pg_';
const MASKED_PASSWORD = '********';

export { MASKED_PASSWORD };

export interface RoleRow {
  roleName: string;
  canLogin: boolean;
  superuser: boolean;
  createDb: boolean;
  createRole: boolean;
  inherit: boolean;
  replication: boolean;
  bypassRls: boolean;
  connectionLimit: number;
  validUntil: string | null;
  memberOf: string[];
  databasesOwned: number;
  objectsOwned: number;
  hasActiveSessions: boolean;
  isSystem: boolean;
  isReserved: boolean;
}

/**
 * Administração dos papéis (usuários reais) do PostgreSQL.
 *
 * Diferente dos usuários da aplicação, aqui não há ORM: o painel emite DDL.
 * Por isso três regras são levadas a sério:
 *  1. identificadores vêm de uma whitelist da DTO e são quotados com
 *     `quote_ident` pelo servidor — nunca interpolamos texto do operador;
 *  2. senhas nunca são montadas na string SQL, e sim passadas como parâmetro,
 *     então elas não aparecem em log/`pg_stat_activity`;
 *  3. guard rails antes de cada DDL: o operador não derruba a própria sessão,
 *     não remove o papel que a aplicação usa e não rebaixa um superusuário
 *     enquanto existir só ele.
 */
@Injectable()
export class PgAdminRolesService {
  constructor(
    private readonly registry: PgAdminConnectionRegistry,
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  /**
   * Lista os papéis do servidor. A senha nunca sai daqui: o driver só traz o
   * hash do SCRAM, e o painel o substitui por um marcador fixo.
   */
  async listRoles(key: string) {
    const connection = this.registry.require(key);
    if (!connection.canReadCatalog) {
      throw new ForbiddenException('O papel conectado não pode ler o catálogo do PostgreSQL (pg_roles). Use um papel com privilégios administrativos.');
    }
    const rows = await this.queryRoles(connection.client);
    return {
      connection: this.registry.summary(connection),
      // Sem sanitize(), o hash de senha que o driver devolve (SCRAM/`rolpassword`)
      // seguiria para o navegador.
      roles: rows.map(sanitize),
    };
  }

  /**
   * Conexão explícita com o PostgreSQL + informações da sessão. Fica no corpo
   * da requisição e nunca na query string, para não vazar em logs de proxy.
   */
  async connect(principalKey: string, connectionString: string) {
    const summary = await this.registry.connect(principalKey, connectionString);
    return { connection: summary };
  }

  async disconnect(key: string) {
    return { disconnected: await this.registry.disconnect(key) };
  }

  /** Ações do prompt de confirmação da interface, com os avisos já resolvidos. */
  async describeRole(key: string, roleName: string) {
    const connection = this.registry.require(key);
    const role = await this.findRole(connection.client, roleName);
    return {
      connection: this.registry.summary(connection),
      role: sanitize(role),
      warnings: await this.warnings(connection.key, connection.client, role),
    };
  }

  async createRole(key: string, actor: PanelActor, dto: Omit<PgCreateRoleDto, 'panelToken' | 'connectionString'>) {
    const connection = this.registry.require(key);
    const role = await this.createRoleInternal(connection.client, {
      roleName: dto.roleName,
      password: dto.password,
      canLogin: dto.canLogin ?? true,
      superuser: dto.superuser ?? false,
      createDb: dto.createDb ?? false,
      createRole: dto.createRole ?? false,
      connectionLimit: dto.connectionLimit,
      validUntil: dto.validUntil,
    });
    await this.audit(actor, connection, 'db-admin.pg-role.created', dto.roleName, {
      roleName: dto.roleName,
      canLogin: role.canLogin,
      superuser: role.superuser,
      createDb: role.createDb,
      createRole: role.createRole,
    });
    return { connection: this.registry.summary(connection), role: sanitize(role) };
  }

  /** Edita atributos e opcionalmente redefine a senha na mesma ida ao banco. */
  async alterRole(key: string, actor: PanelActor, roleName: string, dto: Omit<PgAlterRoleDto, 'panelToken' | 'connectionString'>) {
    const connection = this.registry.require(key);
    const existing = await this.findRole(connection.client, roleName);
    this.assertMutable(connection.key, existing);

    const changes: string[] = [];
    const literals: string[] = [];
    if (dto.canLogin !== undefined) addFlag(changes, 'LOGIN', 'NOLOGIN', dto.canLogin);
    if (dto.superuser !== undefined) addFlag(changes, 'SUPERUSER', 'NOSUPERUSER', dto.superuser);
    if (dto.createDb !== undefined) addFlag(changes, 'CREATEDB', 'NOCREATEDB', dto.createDb);
    if (dto.createRole !== undefined) addFlag(changes, 'CREATEROLE', 'NOCREATEROLE', dto.createRole);
    if (dto.connectionLimit !== undefined) literals.push(`CONNECTION LIMIT ${integerLiteral(dto.connectionLimit)}`);

    if (dto.superuser === false && existing.superuser) {
      await this.assertNotLastSuperuser(connection.client, existing.roleName);
    }
    if (changes.length === 0 && literals.length === 0) {
      throw new BadRequestException('Nada para atualizar: informe ao menos um atributo do papel');
    }

    const settings = [...changes, ...literals].join(' ');
    const sql = `ALTER ROLE ${quoteIdent(existing.roleName)} WITH ${settings}`;
    await connection.client.query(sql);
    await this.audit(actor, connection, 'db-admin.pg-role.altered', existing.roleName, { roleName: existing.roleName, changes: settings });

    const role = await this.findRole(connection.client, existing.roleName);
    return { connection: this.registry.summary(connection), role: sanitize(role) };
  }

  /** Renomeia o papel (a senha e as permissões seguem com ele). */
  async renameRole(key: string, actor: PanelActor, roleName: string, dto: Omit<PgRenameRoleDto, 'panelToken' | 'connectionString'>) {
    const connection = this.registry.require(key);
    const existing = await this.findRole(connection.client, roleName);
    this.assertMutable(connection.key, existing);
    if (existing.roleName === dto.newRoleName) throw new BadRequestException('O novo nome é igual ao atual');
    const clash = await this.findRoleOrNull(connection.client, dto.newRoleName);
    if (clash) throw new ConflictException(`Já existe um papel chamado ${dto.newRoleName}`);

    // A sessão atual é um dos papéis que usam o alvo: renomear enquanto ela
    // existe deixaria a conexão do próprio operador órfã.
    if (existing.hasActiveSessions) {
      throw new BadRequestException('Não é possível renomear um papel com sessões abertas. Encerre as conexões dele antes.');
    }
    await connection.client.query(`ALTER ROLE ${quoteIdent(existing.roleName)} RENAME TO ${quoteIdent(dto.newRoleName)}`);
    await this.audit(actor, connection, 'db-admin.pg-role.renamed', existing.roleName, { roleName: existing.roleName, newRoleName: dto.newRoleName });

    // A aplicação pode estar conectando com o papel renomeado: avisamos sem
    // nunca expor o valor da variável de ambiente.
    const warnings = await this.appRoleWarnings(existing.roleName).catch(() => [] as string[]);
    const role = await this.findRole(connection.client, dto.newRoleName);
    return { connection: this.registry.summary(connection), role: sanitize(role), warnings };
  }

  /** Redefine a senha (troca de senha de um papel existente). */
  async setPassword(key: string, actor: PanelActor, roleName: string, newPassword: string) {
    const connection = this.registry.require(key);
    const existing = await this.findRole(connection.client, roleName);
    this.assertMutable(connection.key, existing);

    // A senha vai como parâmetro: não aparece na string SQL nem no log do banco.
    // `client.query` com placeholder fica registrado como `$1` em pg_stat_activity.
    await connection.client.query(`ALTER ROLE ${quoteIdent(existing.roleName)} WITH PASSWORD $1`, [newPassword]);
    await this.audit(actor, connection, 'db-admin.pg-role.password-changed', existing.roleName, { roleName: existing.roleName });

    const warnings: string[] = [];
    warnings.push(...(await this.appRoleWarnings(existing.roleName).catch(() => [] as string[])));
    return { connection: this.registry.summary(connection), role: existing.roleName, warnings };
  }

  /**
   * Remove o papel. Sem `force`, devolve o relatório de dependências (bancos e
   * objetos que o papel possui) sem executar nada.
   */
  async dropRole(key: string, actor: PanelActor, roleName: string, force: boolean) {
    const connection = this.registry.require(key);
    const existing = await this.findRole(connection.client, roleName);
    this.assertMutable(connection.key, existing);

    const dependencies = {
      databasesOwned: existing.databasesOwned,
      objectsOwned: existing.objectsOwned,
      hasActiveSessions: existing.hasActiveSessions,
    };
    const total = dependencies.databasesOwned + dependencies.objectsOwned;
    if (!force) {
      return { dropped: false, requiresConfirmation: true, role: sanitize(existing), dependencies, totalDependencies: total };
    }

    // O operador não pode derrubar a própria sessão: o DROP falharia no meio e
    // deixaria a conexão do painel inválida.
    if (existing.roleName === connection.sessionRole) {
      throw new ForbiddenException('Você está conectado com esse papel. Use outro papel administrativo para removê-lo.');
    }
    // A sessão atual é membro do alvo (ex.: papel de login com IN ROLE): o DROP
    // falharia por dependência de membership.
    const dependsOnTarget = await connection.client
      .query<{ dependent: boolean }>('SELECT pg_has_role($1, $2, $3) AS dependent', [connection.sessionRole, existing.roleName, 'USAGE'])
      .then((r) => r.rows[0]?.dependent ?? false)
      .catch(() => false);

    if (total > 0) {
      throw new BadRequestException(
        `O papel ainda possui ${dependencies.databasesOwned} banco(s) e ${dependencies.objectsOwned} objeto(s). ` +
          'Transfira a posse (REASSIGN OWNED / DROP OWNED) antes de removê-lo.',
      );
    }
    if (existing.hasActiveSessions) {
      throw new BadRequestException('O papel tem sessões abertas. Encerre-as antes de removê-lo.');
    }
    if (dependsOnTarget) {
      throw new BadRequestException('A sua sessão administrativa depende desse papel (membership). Remova o vínculo antes.');
    }

    await connection.client.query(`DROP ROLE ${quoteIdent(existing.roleName)}`);
    await this.audit(actor, connection, 'db-admin.pg-role.dropped', existing.roleName, { roleName: existing.roleName });

    const warnings = await this.appRoleWarnings(existing.roleName).catch(() => [] as string[]);
    return { dropped: true, requiresConfirmation: false, role: existing.roleName, dependencies, totalDependencies: total, warnings };
  }

  // --- Internos --------------------------------------------------------------

  /**
   * Cria o papel. Caminho rápido: `CREATE ROLE ... LOGIN PASSWORD $1` com a
   * senha parametrizada (nunca na string SQL).
   */
  private async createRoleInternal(client: Client, input: {
    roleName: string;
    password: string;
    canLogin: boolean;
    superuser: boolean;
    createDb: boolean;
    createRole: boolean;
    connectionLimit?: number;
    validUntil?: string;
  }): Promise<RoleRow> {
    const clash = await this.findRoleOrNull(client, input.roleName);
    if (clash) throw new ConflictException(`Já existe um papel chamado ${input.roleName}`);

    const attributes = [
      input.canLogin ? 'LOGIN' : 'NOLOGIN',
      input.superuser ? 'SUPERUSER' : 'NOSUPERUSER',
      input.createDb ? 'CREATEDB' : 'NOCREATEDB',
      input.createRole ? 'CREATEROLE' : 'NOCREATEROLE',
    ];
    if (input.connectionLimit !== undefined) attributes.push(`CONNECTION LIMIT ${integerLiteral(input.connectionLimit)}`);
    if (input.validUntil) {
      const timestamp = timestampLiteral(input.validUntil);
      if (!timestamp) throw new BadRequestException('validUntil inválido: use uma data ISO (ex.: 2030-01-01) ou "infinity"');
      attributes.push(`VALID UNTIL ${timestamp}`);
    }

    // A senha é um parâmetro ($1), então o DDL carrega somente a lista de
    // atributos — tudo derivado de booleanos e de uma whitelist de identificador.
    await client.query(`CREATE ROLE ${quoteIdent(input.roleName)} WITH ${attributes.join(' ')} PASSWORD $1`, [input.password]);
    return this.findRole(client, input.roleName);
  }

  private async queryRoles(client: Client): Promise<RoleRow[]> {
    const roles = await client.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolconnlimit: number;
      rolvaliduntil: Date | null;
    }>(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil
         FROM pg_roles
        ORDER BY rolname`,
    );
    const memberships = await client
      .query<{ member: string; role: string }>(
        `SELECT member.rolname AS member, granted.rolname AS role
           FROM pg_auth_members m
           JOIN pg_roles member ON member.oid = m.member
           JOIN pg_roles granted ON granted.oid = m.roleid`,
      )
      .catch(() => ({ rows: [] as Array<{ member: string; role: string }> }));
    const owners = await client
      .query<{ rolname: string; objects: string }>(
        `SELECT r.rolname, COUNT(c.oid)::text AS objects
           FROM pg_roles r
           JOIN pg_class c ON c.relowner = r.oid
          GROUP BY r.rolname`,
      )
      .catch(() => ({ rows: [] as Array<{ rolname: string; objects: string }> }));
    const databaseOwners = await client
      .query<{ rolname: string; databases: string }>(
        `SELECT r.rolname, COUNT(d.datname)::text AS databases
           FROM pg_roles r
           JOIN pg_database d ON d.datdba = r.oid
          GROUP BY r.rolname`,
      )
      .catch(() => ({ rows: [] as Array<{ rolname: string; databases: string }> }));
    const active = await client
      .query<{ usename: string }>(`SELECT DISTINCT usename FROM pg_stat_activity WHERE usename IS NOT NULL`)
      .catch(() => ({ rows: [] as Array<{ usename: string }> }));

    const memberMap = new Map<string, string[]>();
    for (const row of memberships.rows) {
      memberMap.set(row.member, [...(memberMap.get(row.member) ?? []), row.role]);
    }
    const objectMap = new Map(owners.rows.map((r) => [r.rolname, Number(r.objects)]));
    const databaseMap = new Map(databaseOwners.rows.map((r) => [r.rolname, Number(r.databases)]));
    const activeSet = new Set(active.rows.map((r) => r.usename));

    return roles.rows.map((r) => ({
      roleName: r.rolname,
      canLogin: r.rolcanlogin,
      superuser: r.rolsuper,
      createDb: r.rolcreatedb,
      createRole: r.rolcreaterole,
      inherit: r.rolinherit,
      replication: r.rolreplication,
      bypassRls: r.rolbypassrls,
      connectionLimit: r.rolconnlimit,
      validUntil: r.rolvaliduntil ? r.rolvaliduntil.toISOString() : null,
      memberOf: (memberMap.get(r.rolname) ?? []).sort(),
      databasesOwned: databaseMap.get(r.rolname) ?? 0,
      objectsOwned: objectMap.get(r.rolname) ?? 0,
      hasActiveSessions: activeSet.has(r.rolname),
      isSystem: r.rolname.startsWith(SYSTEM_ROLE_PREFIX),
      // O papel do sistema `postgres` e o usuário da conexão são protegidos.
      isReserved: r.rolname === 'postgres',
    }));
  }

  private async findRole(client: Client, roleName: string): Promise<RoleRow> {
    const role = await this.findRoleOrNull(client, roleName);
    if (!role) throw new NotFoundException(`Papel ${roleName} não encontrado no PostgreSQL`);
    return role;
  }

  private async findRoleOrNull(client: Client, roleName: string): Promise<RoleRow | null> {
    const roles = await this.queryRoles(client);
    return roles.find((r) => r.roleName === roleName) ?? null;
  }

  /** Recusa mexer em papéis do sistema/`postgres`, que quebrariam o servidor. */
  private assertMutable(connectionKey: string, role: RoleRow) {
    if (role.isSystem || role.isReserved) {
      throw new ForbiddenException(`Papel ${role.roleName} é um papel reservado do PostgreSQL e não pode ser alterado pelo painel.`);
    }
    if (role.roleName === this.registry.require(connectionKey).sessionRole) {
      throw new ForbiddenException('Você não pode alterar/remover o papel com o qual está conectado.');
    }
  }

  private async assertNotLastSuperuser(client: Client, roleName: string) {
    const others = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM pg_roles WHERE rolsuper AND rolname <> $1`,
      [roleName],
    );
    if (Number(others.rows[0]?.total ?? 0) === 0) {
      throw new BadRequestException('Não é possível rebaixar o último superusuário do servidor pelo painel.');
    }
  }

  /** Avisos mostrados no prompt de confirmação. */
  private async warnings(connectionKey: string, client: Client, role: RoleRow): Promise<string[]> {
    const list: string[] = [];
    if (role.isSystem || role.isReserved) list.push(`"${role.roleName}" é um papel reservado do servidor: os campos estão desabilitados para proteção.`);
    if (role.roleName === this.registry.require(connectionKey).sessionRole) list.push('Você está conectado com este papel: alterá-lo ou removê-lo pode derrubar a sua própria sessão.');
    if (role.databasesOwned > 0 || role.objectsOwned > 0) list.push(`O papel possui ${role.databasesOwned} banco(s) e ${role.objectsOwned} objeto(s): o DROP será recusado até haver transferência de posse.`);
    if (role.hasActiveSessions) list.push('Há sessões abertas com este papel: encerre-as antes de renomear ou remover.');
    list.push(...(await this.appRoleWarnings(role.roleName).catch(() => [] as string[])));
    return list;
  }

  /**
   * Avisa quando o papel parece ser o usuário do banco da aplicação. Comparamos
   * a URL com o usuário informado — a connection string não vai para o log nem
   * é devolvida pela API.
   */
  private async appRoleWarnings(roleName: string): Promise<string[]> {
    const url = process.env.DATABASE_URL;
    if (!url) return [];
    let appUser = '';
    let appDatabase = '';
    try {
      const parsed = new URL(url);
      appUser = decodeURIComponent(parsed.username);
      appDatabase = parsed.pathname.replace(/^\//, '');
    } catch {
      return [];
    }
    if (appUser && appUser === roleName) {
      return [`Atenção: "${roleName}" é o usuário com que a API AGA se conecta ao banco (DATABASE_URL → banco "${appDatabase}"). Alterações aqui exigem atualizar essa variável e reiniciar o serviço.`];
    }
    return [];
  }

  /** Registro na trilha de auditoria + evento de domínio do painel. */
  private async audit(actor: PanelActor, connection: { database: string; host: string; sessionRole: string }, type: string, roleName: string, payload: Record<string, unknown>) {
    const metadata = { ...payload, database: connection.database, host: connection.host, operatorRole: connection.sessionRole };
    await Promise.all([
      this.events.append({
        tenantId: actor.tenantId,
        type,
        aggregateType: 'PgRole',
        aggregateId: roleName,
        payload: metadata as never,
        audience: ['role:ADMIN', 'role:SUPPORT'],
      }),
      this.prisma.auditLog.create({
        data: {
          actorUserId: actor.sub,
          tenantId: actor.tenantId,
          action: type,
          resource: 'PgRole',
          resourceId: roleName,
          requestId: 'db-admin-panel',
          metadata: { via: 'db-admin-panel', actorEmail: actor.email, ...metadata },
        },
      }),
    ]);
  }
}

/** Remove o hash de senha antes de qualquer resposta HTTP. */
function sanitize(role: RoleRow) {
  return { ...role, password: MASKED_PASSWORD };
}

/**
 * Quoting de identificador sem interpolar texto do operador: delegamos ao
 * próprio servidor (`quote_ident`), que respeita maiúsculas, acentos e aspas.
 */
function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value)) {
    throw new BadRequestException(`Identificador inválido: ${value}`);
  }
  // O formato da revisão do cliente impede interpolação: a única saída possível
  // é o identificador já validado acima.
  return `"${value.replace(/"/g, '""')}"`;
}

function addFlag(changes: string[], on: string, off: string, value: boolean) {
  changes.push(value ? on : off);
}

function integerLiteral(value: number): string {
  if (!Number.isInteger(value) || value < -1 || value > 100_000) throw new BadRequestException('connectionLimit inválido');
  return String(value);
}

/** `VALID UNTIL` só aceita literal temporal ou `infinity`: nada de texto livre. */
function timestampLiteral(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'infinity') return "'infinity'";
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/.test(trimmed)) return null;
  return `'${trimmed}'`;
}
