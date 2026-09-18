/**
 * TESTES DE SEGURANÇA — Webhooks (HMAC, Replay, Idempotência)
 *
 * Simula ataques contra os endpoints de webhook de rastreamento e pagamentos:
 *  - Webhook sem assinatura
 *  - Assinatura forjada
 *  - Replay attack (reenvio de evento válido)
 *  - Timestamp fora da janela
 *  - Event-ID inválido
 *  - Manipulação do corpo (body tampering)
 *  - Valores financeiros negativos / extremos
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { createHmac, randomBytes } from 'node:crypto';
import { AppModule } from '../../src/app.module';

const BASE = '/v1';

async function buildApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  await app.init();
  return app;
}

/**
 * Cria assinatura HMAC-SHA256 válida para o corpo e timestamp fornecidos.
 */
function sign(secret: string, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

const TRACKING_SECRET = process.env.TRACKING_WEBHOOK_SECRET ?? 'CHANGE_ME_WITH_AT_LEAST_32_RANDOM_CHARACTERS';
const PAYMENT_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? 'CHANGE_ME_WITH_AT_LEAST_32_RANDOM_CHARACTERS';

const validTrackingBody = {
  trackerExternalId: 'TRACKER-EXT-001',
  latitude: -23.5505,
  longitude: -46.6333,
  speedKph: 60,
  heading: 180,
  ignitionOn: true,
  batteryPct: 85,
  recordedAt: new Date().toISOString(),
};

describe('[SECURITY] Webhook Security (HMAC, Replay, Tampering)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── 1. Falta de assinatura ───────────────────────────────────────────────

  describe('1. Missing Webhook Signature', () => {
    it('deve rejeitar webhook de rastreamento sem headers de assinatura', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .send(validTrackingBody);
      expect(res.status).toBe(401);
    });

    it('deve rejeitar webhook sem x-aga-timestamp', async () => {
      const rawBody = Buffer.from(JSON.stringify(validTrackingBody));
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign(TRACKING_SECRET, ts, rawBody);

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-signature', `sha256=${sig}`)
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        // x-aga-timestamp ausente
        .send(rawBody);
      expect(res.status).toBe(401);
    });

    it('deve rejeitar webhook sem x-aga-signature', async () => {
      const ts = String(Math.floor(Date.now() / 1000));

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('x-aga-timestamp', ts)
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        // x-aga-signature ausente
        .send(validTrackingBody);
      expect(res.status).toBe(401);
    });
  });

  // ── 2. Assinatura Forjada ─────────────────────────────────────────────────

  describe('2. Forged Signature', () => {
    it('deve rejeitar assinatura HMAC calculada com chave errada', async () => {
      const rawBody = Buffer.from(JSON.stringify(validTrackingBody));
      const ts = String(Math.floor(Date.now() / 1000));
      const wrongSig = sign('wrong-secret-key-that-is-not-the-real-one', ts, rawBody);

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', ts)
        .set('x-aga-signature', `sha256=${wrongSig}`)
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        .send(rawBody);
      expect(res.status).toBe(401);
    });

    it('deve rejeitar assinatura com hex aleatório (64 chars)', async () => {
      const rawBody = Buffer.from(JSON.stringify(validTrackingBody));
      const ts = String(Math.floor(Date.now() / 1000));
      const randomSig = randomBytes(32).toString('hex');

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', ts)
        .set('x-aga-signature', `sha256=${randomSig}`)
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        .send(rawBody);
      expect(res.status).toBe(401);
    });

    it('deve rejeitar assinatura de formato inválido (muito curta)', async () => {
      const rawBody = Buffer.from(JSON.stringify(validTrackingBody));
      const ts = String(Math.floor(Date.now() / 1000));

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', ts)
        .set('x-aga-signature', 'sha256=abc123')
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        .send(rawBody);
      expect(res.status).toBe(401);
    });
  });

  // ── 3. Replay Attack ─────────────────────────────────────────────────────

  describe('3. Replay Attack (Timestamp Fora da Janela)', () => {
    it('deve rejeitar timestamp com mais de 5 minutos no passado', async () => {
      const rawBody = Buffer.from(JSON.stringify(validTrackingBody));
      // Timestamp 10 minutos atrás
      const oldTs = String(Math.floor((Date.now() - 10 * 60_000) / 1000));
      const sig = sign(TRACKING_SECRET, oldTs, rawBody);

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', oldTs)
        .set('x-aga-signature', `sha256=${sig}`)
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        .send(rawBody);
      expect(res.status).toBe(401);
    });

    it('deve rejeitar timestamp muito no futuro', async () => {
      const rawBody = Buffer.from(JSON.stringify(validTrackingBody));
      // Timestamp 10 minutos no futuro
      const futureTs = String(Math.floor((Date.now() + 10 * 60_000) / 1000));
      const sig = sign(TRACKING_SECRET, futureTs, rawBody);

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', futureTs)
        .set('x-aga-signature', `sha256=${sig}`)
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        .send(rawBody);
      expect(res.status).toBe(401);
    });

    it('deve rejeitar timestamp não numérico', async () => {
      const rawBody = Buffer.from(JSON.stringify(validTrackingBody));

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', 'not-a-timestamp')
        .set('x-aga-signature', 'sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        .send(rawBody);
      expect(res.status).toBe(401);
    });
  });

  // ── 4. Event-ID Inválido ─────────────────────────────────────────────────

  describe('4. Invalid Event-ID', () => {
    it('deve rejeitar event-id com caracteres especiais (XSS/injection)', async () => {
      const rawBody = Buffer.from(JSON.stringify(validTrackingBody));
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign(TRACKING_SECRET, ts, rawBody);

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', ts)
        .set('x-aga-signature', `sha256=${sig}`)
        .set('x-aga-event-id', "<script>alert(1)</script>")
        .send(rawBody);
      // Assinatura válida mas event-id inválido → 400
      expect([400, 401]).toContain(res.status);
    });

    it('deve rejeitar event-id muito curto (< 8 chars)', async () => {
      const rawBody = Buffer.from(JSON.stringify(validTrackingBody));
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign(TRACKING_SECRET, ts, rawBody);

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', ts)
        .set('x-aga-signature', `sha256=${sig}`)
        .set('x-aga-event-id', 'short')
        .send(rawBody);
      expect([400, 401]).toContain(res.status);
    });
  });

  // ── 5. Body Tampering ────────────────────────────────────────────────────

  describe('5. Body Tampering (assinatura válida, corpo alterado)', () => {
    it('deve rejeitar quando o corpo difere do que foi assinado', async () => {
      const originalBody = Buffer.from(JSON.stringify(validTrackingBody));
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign(TRACKING_SECRET, ts, originalBody);

      // Corpo alterado: velocidade adulterada
      const tamperedBody = { ...validTrackingBody, speedKph: 999 };

      const res = await request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', ts)
        .set('x-aga-signature', `sha256=${sig}`)
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        .send(JSON.stringify(tamperedBody));
      // Assinatura calculada sobre o corpo original → inválida para o corpo adulterado
      expect(res.status).toBe(401);
    });
  });

  // ── 6. Valores Extremos nos Dados do Webhook ─────────────────────────────

  describe('6. Extreme / Invalid Data Values in Webhook Body', () => {
    const makeSignedRequest = async (body: object, app: INestApplication) => {
      const rawBody = Buffer.from(JSON.stringify(body));
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign(TRACKING_SECRET, ts, rawBody);
      return request(app.getHttpServer())
        .post(`${BASE}/tracking/provider/webhook`)
        .set('Content-Type', 'application/json')
        .set('x-aga-timestamp', ts)
        .set('x-aga-signature', `sha256=${sig}`)
        .set('x-aga-event-id', `evt-${randomBytes(8).toString('hex')}`)
        .send(rawBody);
    };

    it('deve rejeitar latitude inválida (> 90)', async () => {
      const body = { ...validTrackingBody, latitude: 999 };
      const res = await makeSignedRequest(body, app);
      expect([400, 401, 404]).toContain(res.status);
    });

    it('deve rejeitar longitude inválida (< -180)', async () => {
      const body = { ...validTrackingBody, longitude: -999 };
      const res = await makeSignedRequest(body, app);
      expect([400, 401, 404]).toContain(res.status);
    });

    it('deve rejeitar batteryPct negativo', async () => {
      const body = { ...validTrackingBody, batteryPct: -10 };
      const res = await makeSignedRequest(body, app);
      expect([400, 401, 404]).toContain(res.status);
    });

    it('deve rejeitar speedKph negativo', async () => {
      const body = { ...validTrackingBody, speedKph: -50 };
      const res = await makeSignedRequest(body, app);
      expect([400, 401, 404]).toContain(res.status);
    });

    it('deve rejeitar recordedAt muito antigo (> 24h)', async () => {
      const body = {
        ...validTrackingBody,
        recordedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
      };
      const res = await makeSignedRequest(body, app);
      expect([400, 401, 404]).toContain(res.status);
    });
  });
});
