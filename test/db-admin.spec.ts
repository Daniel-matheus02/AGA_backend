/**
 * API de administração do banco de dados — regras que não dependem de Postgres.
 *
 * Cobre o que dá para provar sem banco de dados no ambiente local:
 *  - o digest da chave de setup (comparação em tempo constante) e o corte do
 *    recurso quando DB_ADMIN_SETUP_KEY não está configurada;
 *  - o guard: 403 sem chave, 401 sem token, e a exigência da chave também na
 *    conexão direta ao PostgreSQL;
 *  - os guard rails do serviço de usuários (não se auto-remover, não derrubar o
 *    último ADMIN) e o fluxo de dois passos da exclusão definitiva;
 *  - a montagem do SQL de papéis: identificadores validados e senha sempre como
 *    parâmetro ($1), nunca dentro da string.
 *
 * PrismaService é substituído por um duplo: aqui interessa o comportamento do
 * código do painel, não o do driver.
 */

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DbAdminUsersService } from '../src/dbadmin/db-admin-users.service';
import { DbAdminGuard } from '../src/dbadmin/db-admin.guard';
import { PanelAuthService } from '../src/dbadmin/panel-auth.service';
import { PgAdminRolesService } from '../src/dbadmin/pg-admin-roles.service';
import { parseConnectionString } from '../src/dbadmin/pg-connection.registry';
import { CryptoService } from '../src/common/services/crypto.service';

const SETUP_KEY = 'chave-de-setup-para-teste-com-mais-de-32-chars';
const actor = { sub: 'admin-1', email: 'admin@aga.local', tenantId: 'tenant-1' };

const ENV: Record<string, unknown> = {
  DB_ADMIN_SETUP_KEY: SETUP_KEY,
  DB_ADMIN_TOKEN_TTL_MINUTES: 30,
  DB_ADMIN_PG_CONN_TTL_MINUTES: 15,
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  JWT_ISSUER: 'grupo-aga-api',
  JWT_AUDIENCE: 'grupo-aga-apps',
  TENANT_SLUG: 'grupo-aga',
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  ADMIN_MFA_REQUIRED: false,
};

function configWith(overrides: Record<string, unknown> = {}) {
  const values = { ...ENV, ...overrides };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`missing ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
}

function panelAuth(overrides: Record<string, unknown> = {}) {
  const config = configWith(overrides);
  return new PanelAuthService({} as never, config, new JwtService({}), new CryptoService(config));
}

// --- Chave de setup ---------------------------------------------------------

describe('PanelAuthService — chave de setup', () => {
  it('aceita a chave configurada', () => {
    expect(panelAuth().checkSetupKey(SETUP_KEY)).toBe(true);
  });

  it('recusa chave errada, vazia, de outro tipo ou gigante', () => {
    const auth = panelAuth();
    expect(auth.checkSetupKey('x'.repeat(SETUP_KEY.length))).toBe(false);
    expect(auth.checkSetupKey('')).toBe(false);
    expect(auth.checkSetupKey(undefined)).toBe(false);
    expect(auth.checkSetupKey(12345 as never)).toBe(false);
    expect(auth.checkSetupKey('x'.repeat(600))).toBe(false);
  });

  it('recusa tudo quando DB_ADMIN_SETUP_KEY não está definida e reporta desabilitado', () => {
    const auth = panelAuth({ DB_ADMIN_SETUP_KEY: undefined });
    expect(auth.isEnabled()).toBe(false);
    expect(auth.checkSetupKey(SETUP_KEY)).toBe(false);
    expect(() => auth.requireEnabled()).toThrow(ForbiddenException);
  });

  it('não confunde a chave de setup com o segredo do JWT', () => {
    // O digest usa o JWT_ACCESS_SECRET como chave do HMAC: trocar o segredo
    // invalida as chaves antigas de propósito.
    expect(panelAuth().checkSetupKey(SETUP_KEY)).toBe(true);
    expect(panelAuth({ JWT_ACCESS_SECRET: 'b'.repeat(64) }).checkSetupKey(SETUP_KEY)).toBe(true);
  });
});

// --- Guard ------------------------------------------------------------------

describe('DbAdminGuard', () => {
  /** Requisição mínima no formato que o guard lê (Express-like). */
  const context = (parts: { headers?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, unknown> }) => {
    const headers = parts.headers ?? {};
    const req = {
      headers,
      body: parts.body ?? {},
      query: parts.query ?? {},
      header: (name: string) => headers[name.toLowerCase()],
    };
    return { switchToHttp: () => ({ getRequest: () => req }) } as never;
  };

  it('responde 403 quando o painel está desabilitado, antes de olhar credenciais', async () => {
    const guard = new DbAdminGuard(panelAuth({ DB_ADMIN_SETUP_KEY: undefined }));
    await expect(guard.canActivate(context({}))).rejects.toThrow(ForbiddenException);
  });

  it('responde 403 sem chave de setup', async () => {
    const guard = new DbAdminGuard(panelAuth());
    await expect(guard.canActivate(context({}))).rejects.toThrow(ForbiddenException);
  });

  it('responde 401 com a chave correta e sem token', async () => {
    const guard = new DbAdminGuard(panelAuth());
    await expect(
      guard.canActivate(context({ headers: { 'x-aga-setup-key': SETUP_KEY } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('exige a chave de setup mesmo com um token já emitido', async () => {
    // Conexão privilegiada ao PostgreSQL: token vazado, sozinho, não basta.
    const auth = panelAuth();
    const guard = new DbAdminGuard(auth);
    await expect(
      guard.canActivate(context({ headers: { 'x-panel-token': 'token.de.painel.falso' } })),
    ).rejects.toThrow(ForbiddenException);
  });
});

// --- Token do painel --------------------------------------------------------

describe('PanelAuthService — token do painel', () => {
  const user = { id: 'admin-1', tenantId: 'tenant-1', email: 'admin@aga.local', role: 'ADMIN', status: 'ACTIVE', name: 'Admin' };

  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
  } as never;

  it('recusa token com audience de painel mas assinatura de outro segredo', async () => {
    const auth = panelAuth();
    const other = panelAuth({ JWT_ACCESS_SECRET: 'z'.repeat(64) });
    const forged = await new JwtService({}).signAsync(
      { sub: 'admin-1', scope: 'db-admin-panel', jti: 'j1' },
      { secret: 'z'.repeat(64), issuer: 'grupo-aga-api:db-admin', audience: 'aga-db-admin-panel', expiresIn: 60 },
    );
    void other;
    await expect(auth.verifyPanelToken(forged, false)).rejects.toThrow(UnauthorizedException);
  });

  it('recusa token de painel usado como token de API (audience da aplicação)', async () => {
    const auth = panelAuth();
    const apiToken = await new JwtService({}).signAsync(
      { sub: 'admin-1', scope: 'db-admin-panel', jti: 'j2' },
      { secret: ENV.JWT_ACCESS_SECRET as string, issuer: 'grupo-aga-api', audience: 'grupo-aga-apps', expiresIn: 60 },
    );
    await expect(auth.verifyPanelToken(apiToken, false)).rejects.toThrow(UnauthorizedException);
  });

  it('exige a chave de setup quando o token é usado para conectar ao Postgres', async () => {
    const auth = panelAuth();
    const service = new PanelAuthService(prisma, configWith(), new JwtService({}), new CryptoService(configWith()));
    const token = await service['jwt'].signAsync(
      { sub: 'admin-1', scope: 'db-admin-panel', jti: 'j3' },
      { secret: ENV.JWT_ACCESS_SECRET as string, issuer: 'grupo-aga-api:db-admin', audience: 'aga-db-admin-panel', expiresIn: 60 },
    );
    await expect(auth.verifyPanelToken(token, true, 'chave-errada-com-tamanho-suficiente-000')).rejects.toThrow(UnauthorizedException);
  });
});

// --- Usuários da aplicação --------------------------------------------------

describe('DbAdminUsersService — guard rails', () => {
  function build(target: Record<string, unknown> | null, activeAdmins = 1) {
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(target),
        findUnique: jest.fn().mockResolvedValue(null),
        // listUsers destrincha `_count.sessions` para contar sessões vivas.
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([{ status: 'ACTIVE', _count: { _all: 1 } }]),
        count: jest.fn().mockResolvedValue(activeAdmins),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...target, ...data })),
        delete: jest.fn().mockResolvedValue({ id: 'user-2', email: 'a@b.c' }),
      },
      session: { count: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
      notification: { count: jest.fn().mockResolvedValue(0) },
      creditAccount: { count: jest.fn().mockResolvedValue(0) },
      tracker: { count: jest.fn().mockResolvedValue(0) },
      trackingPoint: { count: jest.fn().mockResolvedValue(0) },
      idempotencyRecord: { count: jest.fn().mockResolvedValue(0) },
      creditRequest: { count: jest.fn().mockResolvedValue(0) },
      order: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
      payment: { count: jest.fn().mockResolvedValue(0) },
      insurancePolicy: { count: jest.fn().mockResolvedValue(0) },
      auditLog: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({}) },
      ledgerEntry: { count: jest.fn().mockResolvedValue(0) },
      merchant: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
    };
    const events = { append: jest.fn().mockResolvedValue({ id: 'evt-1' }) };
    return { prisma, events, service: new DbAdminUsersService(prisma as never, events as never) };
  }

  const CLIENT = {
    id: 'user-2', tenantId: 'tenant-1', role: 'CLIENT', status: 'ACTIVE',
    name: 'Cliente', email: 'cliente@aga.local', merchantId: null, mfaEnabled: false,
  };

  it('nunca devolve passwordHash nem mfaSecretEncrypted na listagem', async () => {
    const { prisma, service } = build(CLIENT);
    prisma.user.findMany.mockResolvedValue([{ ...CLIENT, _count: { sessions: 2 } }]);
    const { users } = await service.listUsers(actor, {});
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.not.objectContaining({ passwordHash: true }) }),
    );
    const raw = users[0] as unknown as Record<string, unknown>;
    // O tipo já não expõe esses campos; a checagem em runtime garante que o
    // select não os traz escondidos no objeto serializado.
    expect(raw.passwordHash).toBeUndefined();
    expect(raw.mfaSecretEncrypted).toBeUndefined();
    expect(raw.activeSessions).toBe(2);
    expect(JSON.stringify(raw)).not.toContain('passwordHash');
  });

  it('recusa excluir a própria conta do operador', async () => {
    const { prisma, service } = build({ ...CLIENT, id: actor.sub, role: 'ADMIN' });
    await expect(service.deleteUser(actor, actor.sub, { force: true })).rejects.toThrow(ForbiddenException);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('recusa excluir o último administrador ativo', async () => {
    const { prisma, service } = build({ ...CLIENT, id: 'admin-2', role: 'ADMIN' }, 0);
    await expect(service.deleteUser(actor, 'admin-2', { force: true })).rejects.toThrow('último administrador ativo');
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('responde 404 para usuário de outro tenant', async () => {
    const { prisma, service } = build(null);
    await expect(service.deleteUser(actor, 'de-outro-tenant', { force: true })).rejects.toThrow(NotFoundException);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('sem force devolve o relatório de dependências e não apaga nada', async () => {
    const { prisma, service } = build(CLIENT);
    const report: any = await service.deleteUser(actor, 'user-2', {});
    expect(report.deleted).toBe(false);
    expect(report.requiresConfirmation).toBe(true);
    expect(report.dependencies).toBeDefined();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('bloqueia a exclusão definitiva quando há histórico financeiro', async () => {
    const { prisma, service } = build(CLIENT);
    prisma.order.count = jest.fn().mockResolvedValue(2);
    await expect(service.deleteUser(actor, 'user-2', { force: true })).rejects.toThrow(BadRequestException);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('com force apaga e registra auditoria + evento na mesma transação', async () => {
    const { prisma, events, service } = build(CLIENT);
    const result: any = await service.deleteUser(actor, 'user-2', { force: true, reason: 'titular' });
    expect(result.deleted).toBe(true);
    expect(prisma.user.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user-2' } }));
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'db-admin.user.deleted', aggregateId: 'user-2' }),
      prisma,
    );
  });

  it('ao bloquear, revoga as sessões abertas', async () => {
    const { prisma, service } = build(CLIENT);
    const result: any = await service.blockUser(actor, 'user-2', { reason: 'pedido do titular' });
    expect(result.revokedSessions).toBe(3);
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-2', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('na troca de senha, zera o lockout e revoga sessões por padrão', async () => {
    const { prisma, service } = build(CLIENT);
    const result: any = await service.changePassword(actor, 'user-2', { newPassword: 'senha-nova-123' });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedLoginCount: 0, lockedUntil: null, passwordHash: expect.stringContaining('$argon2id$') }),
      }),
    );
    expect(result.revokedSessions).toBe(3);
  });

  it('na troca de senha, respeita revokeSessions: false', async () => {
    const { prisma, service } = build(CLIENT);
    const result: any = await service.changePassword(actor, 'user-2', { newPassword: 'senha-nova-123', revokeSessions: false });
    expect(result.sessionsRevoked).toBe(false);
    expect(result.revokedSessions).toBe(0);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('recusa e-mail já usado por outro usuário', async () => {
    const { prisma, service } = build(CLIENT);
    prisma.user.findUnique = jest.fn().mockResolvedValue({ id: 'outro' });
    await expect(service.createUser(actor, { name: 'Novo', email: 'x@y.z', password: 'senha-forte-1', role: 'CLIENT' as never })).rejects.toThrow(ConflictException);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});

// --- Papéis do PostgreSQL ---------------------------------------------------

describe('PgAdminRolesService — guard rails e SQL', () => {
  /**
   * Cliente pg falso respondendo ao catálogo consultado pelo serviço.
   * As linhas seguem as colunas reais de `pg_roles`.
   */
  function buildClient(
    role: Record<string, unknown>,
    extra: { objects?: unknown[]; databases?: unknown[]; superusers?: string } = {},
  ) {
    return {
      query: jest.fn().mockImplementation((sql: string) => {
        if (/FROM pg_roles\s+ORDER BY rolname/.test(sql)) return Promise.resolve({ rows: [role] });
        if (/pg_auth_members/.test(sql)) return Promise.resolve({ rows: [] });
        // `JOIN pg_class` (objetos possuídos) vem antes de `pg_database`.
        if (/pg_class/.test(sql)) return Promise.resolve({ rows: extra.objects ?? [] });
        if (/pg_database/.test(sql)) return Promise.resolve({ rows: extra.databases ?? [] });
        if (/pg_stat_activity/.test(sql)) return Promise.resolve({ rows: [] });
        if (/COUNT\(\*\)/.test(sql)) return Promise.resolve({ rows: [{ total: extra.superusers ?? '2' }] });
        return Promise.resolve({ rows: [] });
      }),
    };
  }

  /** Serviço com um cliente pg injetado (registry e auditoria são duplos). */
  function buildWith(client: { query: jest.Mock }) {
    const registry = {
      // canReadCatalog true: os papéis só são gerenciáveis com leitura do catálogo.
      require: jest.fn().mockReturnValue({ key: 'k', sessionRole: 'postgres', database: 'aga', host: 'localhost', client, canReadCatalog: true, isSuperuser: true }),
      summary: jest.fn().mockReturnValue({ host: 'localhost', database: 'aga' }),
      disconnect: jest.fn().mockResolvedValue(true),
      connect: jest.fn(),
    };
    const prisma = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
    const events = { append: jest.fn().mockResolvedValue({ id: 'evt-1' }) };
    return { client, registry, service: new PgAdminRolesService(registry as never, prisma as never, events as never) };
  }

  function build(role: Record<string, unknown>) {
    return buildWith(buildClient(role));
  }

  /** Uma linha de `pg_roles` como o servidor devolve. */
  const CUSTOM = {
    rolname: 'app_leitura',
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: true,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: -1,
    rolvaliduntil: null,
  };

  it('recusa alterar papéis de sistema (pg_*) e o papel postgres', async () => {
    for (const name of ['pg_monitor', 'postgres']) {
      const { service } = build({ ...CUSTOM, rolname: name });
      await expect(service.alterRole('k', actor, name, { canLogin: false })).rejects.toThrow(ForbiddenException);
    }
  });

  it('recusa alterar o papel da própria sessão do operador', async () => {
    const registry = {
      require: jest.fn().mockReturnValue({ key: 'k', sessionRole: 'operador', database: 'aga', host: 'localhost', client: buildClient({ ...CUSTOM, rolname: 'operador' }) }),
      summary: jest.fn().mockReturnValue({ host: 'localhost', database: 'aga' }),
      disconnect: jest.fn().mockResolvedValue(true),
    };
    const service = new PgAdminRolesService(
      registry as never,
      { auditLog: { create: jest.fn() } } as never,
      { append: jest.fn() } as never,
    );
    await expect(service.setPassword('k', actor, 'operador', 'senha-nova-123')).rejects.toThrow(ForbiddenException);
  });

  it('não deixa rebaixar o último superusuário', async () => {
    const client = buildClient({ ...CUSTOM, rolname: 'unico_super', rolsuper: true }, { superusers: '0' });
    const { service } = buildWith(client);
    await expect(service.alterRole('k', actor, 'unico_super', { superuser: false })).rejects.toThrow('último superusuário');
    expect(client.query.mock.calls.some(([sql]) => /^ALTER ROLE/.test(String(sql)))).toBe(false);
  });

  it('recusa remover papel que possui bancos ou objetos, sem executar DROP', async () => {
    const client = buildClient(CUSTOM, {
      objects: [{ rolname: 'app_leitura', objects: '4' }],
      databases: [{ rolname: 'app_leitura', databases: '1' }],
    });
    const { service } = buildWith(client);
    await expect(service.dropRole('k', actor, 'app_leitura', true)).rejects.toThrow(BadRequestException);
    // Nenhum DROP ROLE foi enviado ao servidor.
    expect(client.query.mock.calls.some(([sql]) => /^DROP ROLE/.test(String(sql)))).toBe(false);
  });

  it('sem force, o drop apenas reporta as dependências', async () => {
    const { service } = build(CUSTOM);
    const report: any = await service.dropRole('k', actor, 'app_leitura', false);
    expect(report.dropped).toBe(false);
    expect(report.requiresConfirmation).toBe(true);
    expect(report.dependencies.databasesOwned).toBe(0);
  });

  it('mascara o hash de senha devolvido pelo servidor', async () => {
    const { service } = build(CUSTOM);
    const { roles } = await service.listRoles('k');
    expect((roles[0] as unknown as Record<string, unknown>).password).toBe('********');
    expect(JSON.stringify(roles[0])).not.toContain('SCRAM');
  });

  it('envia a senha como parâmetro, nunca dentro do SQL', async () => {
    const { client, service } = build(CUSTOM);
    const secret = 'senha-super-secreta-123';
    client.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (/FROM pg_roles\s+ORDER BY rolname/.test(sql)) return Promise.resolve({ rows: [CUSTOM] });
      if (/pg_auth_members|FROM pg_class|FROM pg_database|pg_stat_activity/.test(sql)) return Promise.resolve({ rows: [] });
      if (/ALTER ROLE/.test(sql)) {
        expect(sql).not.toContain(secret);
        expect(params).toEqual([secret]);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    await service.setPassword('k', actor, 'app_leitura', secret);
  });
});

// --- Connection string ------------------------------------------------------

describe('parseConnectionString', () => {
  it('aceita postgresql:// e postgres://', () => {
    expect(parseConnectionString('postgresql://u:p@localhost:5432/aga').database).toBe('aga');
    expect(parseConnectionString('postgres://u:p@db.example.com:5432/outro').host).toBe('db.example.com');
  });

  it('recusa esquema que não é Postgres', () => {
    expect(() => parseConnectionString('mysql://u:p@localhost:3306/aga')).toThrow(BadRequestException);
    expect(() => parseConnectionString('https://example.com')).toThrow(BadRequestException);
  });

  it('recusa URL sem host ou sem banco', () => {
    expect(() => parseConnectionString('postgresql:///aga')).toThrow(BadRequestException);
    expect(() => parseConnectionString('postgresql://user:pass@localhost:5432')).toThrow(BadRequestException);
    expect(() => parseConnectionString('nao-e-url')).toThrow(BadRequestException);
  });
});
