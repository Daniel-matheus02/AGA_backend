import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';

const REQUIRED_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

/**
 * Uma conexão privilegiada ao PostgreSQL do operador.
 *
 * A connection string fica **somente em memória** e expira sozinha: o painel
 * administra papéis do Postgres, então guardar esse segredo em disco (ou no
 * banco) seria aumentar o raio de dano sem necessidade.
 */
interface OperatorConnection {
  key: string;
  host: string;
  database: string;
  user: string;
  client: Client;
  expiresAt: number;
  /** Identidade devolvida pelo servidor: base dos guard rails (não pode se auto-excluir). */
  sessionRole: string;
  /** Postgres 16+ marca superusers com `rolsuper = true`; pg_has_role é o fallback. */
  isSuperuser: boolean;
  /** Um papel que não pode ler o catálogo não tem como gerenciar outros papéis. */
  canReadCatalog: boolean;
  /** `true` quando é o próprio banco da aplicação (tem tenant/User). */
  isApplicationDatabase: boolean;
  version: number;
  lastUsedAt: number;
}

export interface PgConnectionSummary {
  host: string;
  database: string;
  user: string;
  /** Papel efetivo da sessão (pode diferir do usuário da connection string). */
  sessionRole: string;
  isSuperuser: boolean
  isApplicationDatabase: boolean;
  version: number;
  canReadCatalog: boolean;
  expiresInSeconds: number;
}

/**
 * Registro de conexões abertas pelo operador, com TTL curto e limpeza
 * periódica. Uma conexão por token de painel (a identidade vem do banco,
 * nunca de um identificador enviado pelo cliente).
 */
@Injectable()
export class PgAdminConnectionRegistry implements OnModuleDestroy {
  private readonly connections = new Map<string, OperatorConnection>();
  private readonly ttlMs: number;
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    this.ttlMs = config.getOrThrow<number>('DB_ADMIN_PG_CONN_TTL_MINUTES') * 60_000;
  }

  /**
   * Abre (ou reaproveita) a conexão do operador. Valida o esquema da URL antes
   * de tentar conectar e faz um `SELECT` de identidade para confirmar que as
   * credenciais realmente funcionam.
   */
  async connect(key: string, connectionString: string): Promise<PgConnectionSummary> {
    const parsed = parseConnectionString(connectionString);
    const existing = this.connections.get(key);
    if (existing) return this.summary(existing);

    const client = new Client({
      connectionString,
      // Uma conexão do painel, curta e síncrona: 5s já é muito para um host
      // local, então falhamos rápido em vez de pendurar a requisição.
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      application_name: 'aga-db-admin-panel',
      ssl: shouldUseSsl(parsed.host),
    });

    try {
      await client.connect();
      const identity = await this.probe(client);
      const connection: OperatorConnection = {
        key,
        host: parsed.host,
        database: parsed.database,
        user: parsed.user,
        client,
        expiresAt: Date.now() + this.ttlMs,
        lastUsedAt: Date.now(),
        ...identity,
      };
      this.connections.set(key, connection);
      this.ensureSweeper();
      return this.summary(connection);
    } catch (error) {
      // Nunca ecoamos a connection string: só a mensagem do driver, que já
      // indica host/porta/autenticação sem expor a senha.
      await client.end().catch(() => undefined);
      throw new BadRequestException(`Não foi possível conectar ao PostgreSQL: ${message(error)}`);
    }
  }

  /** Conexão válida do operador, ou 400 pedindo para reconectar. */
  require(key: string): OperatorConnection {
    const connection = this.connections.get(key);
    if (!connection) {
      throw new BadRequestException('Sem conexão ativa com o PostgreSQL. Informe as credenciais do banco novamente.');
    }
    if (connection.expiresAt <= Date.now()) {
      void this.disconnect(key);
      throw new BadRequestException('A conexão com o PostgreSQL expirou por inatividade. Informe as credenciais novamente.');
    }
    connection.lastUsedAt = Date.now();
    return connection;
  }

  summary(connection: OperatorConnection): PgConnectionSummary {
    return {
      host: connection.host,
      database: connection.database,
      user: connection.user,
      sessionRole: connection.sessionRole,
      isSuperuser: connection.isSuperuser,
      isApplicationDatabase: connection.isApplicationDatabase,
      version: connection.version,
      canReadCatalog: connection.canReadCatalog,
      expiresInSeconds: Math.max(0, Math.round((connection.expiresAt - Date.now()) / 1000)),
    };
  }

  async disconnect(key: string): Promise<boolean> {
    const connection = this.connections.get(key);
    if (!connection) return false;
    this.connections.delete(key);
    await connection.client.end().catch(() => undefined);
    return true;
  }

  async onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
    const keys = [...this.connections.keys()];
    this.connections.clear();
    await Promise.all(keys.map((k) => this.disconnect(k)));
  }

  private ensureSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    // Não segura o event loop do processo por causa do sweeper.
    this.sweeper.unref?.();
  }

  private async sweep() {
    const now = Date.now();
    for (const [key, connection] of this.connections) {
      if (connection.expiresAt <= now) await this.disconnect(key);
    }
    if (this.connections.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  /** Identidade e capacidades do papel conectado. */
  private async probe(client: Client) {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    const identity = await client.query<{ session_role: string; is_superuser: boolean }>(
      `SELECT session_user AS session_role,
              (COALESCE(current_setting('is_superuser', true), 'off') = 'on') AS is_superuser`,
    );
    const sessionRole = identity.rows[0]?.session_role ?? '';
    let isSuperuser = identity.rows[0]?.is_superuser ?? false;
    if (!isSuperuser && sessionRole) {
      // Fallback: cobre instalações onde `is_superuser` não vem no GUC.
      const superuser = await client.query<{ super: boolean }>('SELECT pg_has_role($1, 0, $2) AS super', [sessionRole, 'USAGE']).catch(() => null);
      isSuperuser = superuser?.rows[0]?.super ?? false;
    }
    // `rolcatupdate` deixou de existir no Postgres 12: usamos o próprio
    // pg_roles como teste de leitura do catálogo.
    let canReadCatalog = true;
    try {
      await client.query('SELECT 1 FROM pg_roles LIMIT 1');
    } catch {
      canReadCatalog = false;
    }
    // "É o banco da aplicação?" decidido pelo catálogo, sem query em tabela do
    // app: basta o tipo/coluna que a aplicação usa existir.
    const appTable = await client
      .query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'passwordHash'
         ) AS present`,
      )
      .catch(() => null);
    return {
      sessionRole,
      isSuperuser,
      canReadCatalog,
      isApplicationDatabase: appTable?.rows[0]?.present ?? false,
      version: Number(version.rows[0]?.server_version_num ?? 0),
    };
  }
}

/** Valida o esquema da URL antes de entregá-la ao driver. */
export function parseConnectionString(connectionString: string): { host: string; database: string; user: string } {
  let url: URL;
  try {
    url = new URL(connectionString.trim());
  } catch {
    throw new BadRequestException('Connection string inválida. Use postgresql://usuario:senha@host:5432/banco');
  }
  if (!REQUIRED_PROTOCOLS.has(url.protocol)) {
    throw new BadRequestException('A connection string precisa usar o esquema postgresql:// ou postgres://');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) {
    throw new BadRequestException('A connection string precisa de host e nome do banco (postgresql://usuario:senha@host:5432/banco)');
  }
  return { host: url.hostname, database, user: url.username ? decodeURIComponent(url.username) : '' };
}

function shouldUseSsl(host: string): boolean | { rejectUnauthorized: boolean } {
  // Hosts gerenciados (Railway, Neon, Supabase…) exigem TLS; hosts locais e de
  // rede privada geralmente não têm certificado e falhariam com SSL forçado.
  const isLocal = ['localhost', '127.0.0.1', '::1', 'postgres', 'host.docker.internal'].includes(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return isLocal ? false : { rejectUnauthorized: false };
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
