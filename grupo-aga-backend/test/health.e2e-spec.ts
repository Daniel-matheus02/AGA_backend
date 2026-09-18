import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Health check. O ambiente vem de `test/setup-e2e-env.cjs` (setupFiles), porque
 * atribuições no topo do spec rodariam depois do `import` hoisted do AppModule.
 *
 * Postgres e Redis são substituídos por duplos: aqui só interessa o roteamento
 * de `/v1/health/live`, que não toca em dependência externa.
 */
describe('health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const noop = async () => undefined;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ $connect: noop, $disconnect: noop, onModuleInit: noop, onModuleDestroy: noop })
      .overrideProvider(RedisService)
      .useValue({
        client: { ping: async () => 'PONG', connect: noop, quit: noop, on: () => undefined },
        subscriber: { connect: noop, quit: noop, subscribe: noop, on: () => undefined },
        onModuleInit: noop,
        onModuleDestroy: noop,
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.init();
  }, 30_000);

  afterAll(() => app.close());

  it('/v1/health/live', () => request(app.getHttpServer()).get('/v1/health/live').expect(200));
});
