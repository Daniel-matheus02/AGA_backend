import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Smoke test da API de administração do banco (`/v1/db-admin`).
 *
 * É uma API **somente JSON**: a interface é o projeto separado
 * `frontend_user_manager`, não uma página servida aqui. Este spec cobre o que
 * não depende de banco — quais rotas existem, o corte por chave de setup, a
 * emissão/validação do token do painel e a não-vazamento de segredos — com
 * Prisma e Redis substituídos por duplos.
 *
 * A chave de setup precisa existir ANTES do AppModule ser importado, porque o
 * `validateEnvironment` do ConfigModule lê `process.env` no bootstrap.
 */
const SETUP_KEY = 'chave-de-setup-para-teste-com-mais-de-32-chars';
process.env.DB_ADMIN_SETUP_KEY = SETUP_KEY;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://aga:senha@localhost:5432/aga?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'a'.repeat(64);
process.env.JWT_ISSUER = process.env.JWT_ISSUER || 'grupo-aga-api';
process.env.JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'grupo-aga-apps';
process.env.FIELD_ENCRYPTION_KEY_BASE64 = process.env.FIELD_ENCRYPTION_KEY_BASE64 || Buffer.alloc(32, 7).toString('base64');
process.env.TRACKING_WEBHOOK_SECRET = process.env.TRACKING_WEBHOOK_SECRET || 'b'.repeat(32);
process.env.PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || 'c'.repeat(32);
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS || 'http://localhost:5176';

describe('db-admin API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const noop = async () => undefined;
    // Sem Postgres/Redis no ambiente local: os providers são trocados por duplos.
    const prismaStub = {
      $connect: noop,
      $disconnect: noop,
      onModuleInit: noop,
      onModuleDestroy: noop,
      user: { findFirst: async () => null, findUnique: async () => null, count: async () => 0 },
    };
    const redisStub = {
      client: { ping: async () => 'PONG', connect: noop, quit: noop, on: () => undefined },
      subscriber: { connect: noop, quit: noop, subscribe: noop, on: () => undefined },
      onModuleInit: noop,
      onModuleDestroy: noop,
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(RedisService)
      .useValue(redisStub)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  it('anuncia que o painel está habilitado e o TTL do token', async () => {
    const res = await http().get('/v1/db-admin/meta').expect(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.ttlSeconds).toBeGreaterThan(0);
  });

  it('não serve nenhuma página HTML (a interface é outro projeto)', async () => {
    // Se um dia a página voltar a ser servida por aqui, este teste avisa.
    await http().get('/v1/db-admin/ui').expect(404);
    await http().get('/v1/db-admin/status').expect(404);
  });

  it('corta o acesso sem a chave de setup, sem vazar a chave configurada', async () => {
    const res = await http().get('/v1/db-admin/users').expect(403);
    expect(JSON.stringify(res.body)).not.toContain(SETUP_KEY);
  });

  it('com a chave correta e sem token do painel, responde 401', async () => {
    await http().get('/v1/db-admin/users').set('X-AGA-Setup-Key', SETUP_KEY).expect(401);
  });

  it('recusa token do painel inválido', async () => {
    await http()
      .get('/v1/db-admin/users')
      .set('X-AGA-Setup-Key', SETUP_KEY)
      .set('X-Panel-Token', 'token.invalido.aqui')
      .expect(401);
  });

  it('valida o corpo antes de chegar ao serviço (400)', async () => {
    const res = await http()
      .post('/v1/db-admin/auth/login')
      .send({ setupKey: SETUP_KEY, email: 'nao-e-email', password: 'x'.repeat(10) })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain('email');
  });

  it('recusa login com a chave de setup errada (401) e não vaza a chave', async () => {
    const res = await http()
      .post('/v1/db-admin/auth/login')
      .send({ setupKey: 'chave-errada-mas-com-tamanho-suficiente-123456', email: 'admin@aga.local', password: 'x'.repeat(10) })
      .expect(401);
    expect(JSON.stringify(res.body)).not.toContain(SETUP_KEY);
  });

  it('exige a chave de setup também para conectar ao PostgreSQL', async () => {
    await http()
      .post('/v1/db-admin/pg/connect')
      .set('X-Panel-Token', 'token.invalido.aqui')
      .send({ connectionString: 'postgresql://x:y@localhost:5432/z' })
      .expect(403);
  });
});
