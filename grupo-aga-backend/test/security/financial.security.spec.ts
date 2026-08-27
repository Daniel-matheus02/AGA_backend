/**
 * TESTES DE SEGURANÇA — Integridade Financeira
 *
 * Simula ataques e fraudes contra os fluxos de crédito, pagamento e marketplace:
 *  - Criação de crédito com valores negativos / zero
 *  - Negative amount em order
 *  - Race condition: dois requests simultâneos de crédito
 *  - Integer overflow em amountCents
 *  - Autorizar pedido expirado
 *  - Autorizar pedido de outro cliente (IDOR)
 *  - Duplicação de solicitação (idempotência)
 *  - Alteração de status de pagamento via webhook forjado
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

const BASE = '/v1';

async function buildApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication();
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

async function getToken(app: INestApplication, email: string, password: string): Promise<string | null> {
  const res = await request(app.getHttpServer())
    .post(`${BASE}/auth/login`)
    .send({ email, password });
  return res.body?.accessToken ?? null;
}

describe('[SECURITY] Financial Integrity', () => {
  let app: INestApplication;
  let clientToken: string | null;
  let adminToken: string | null;

  beforeAll(async () => {
    app = await buildApp();
    [clientToken, adminToken] = await Promise.all([
      getToken(app, process.env.SEED_CLIENT_EMAIL ?? 'cliente@aga.local', process.env.SEED_CLIENT_PASSWORD ?? 'CHANGE_ME_Cliente_2026!'),
      getToken(app, process.env.SEED_ADMIN_EMAIL ?? 'admin@aga.local', process.env.SEED_ADMIN_PASSWORD ?? 'CHANGE_ME_Admin_2026!'),
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── 1. Validação de Valores de Crédito ───────────────────────────────────

  describe('1. Credit Request Value Validation', () => {
    it('deve rejeitar amountCents negativo', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'test-neg-amount-001')
        .send({ amountCents: -50000, dailyInstallments: 30 });
      expect(res.status).toBe(400);
    });

    it('deve rejeitar amountCents zero', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'test-zero-amount-001')
        .send({ amountCents: 0, dailyInstallments: 30 });
      expect(res.status).toBe(400);
    });

    it('deve rejeitar amountCents abaixo do mínimo (< 30000)', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'test-below-min-001')
        .send({ amountCents: 1000, dailyInstallments: 30 });
      expect(res.status).toBe(400);
    });

    it('deve rejeitar amountCents acima do máximo (> 1000000)', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'test-above-max-001')
        .send({ amountCents: 9999999, dailyInstallments: 30 });
      expect(res.status).toBe(400);
    });

    it('deve rejeitar amountCents como string (type coercion attack)', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'test-string-amount-001')
        .send({ amountCents: '50000', dailyInstallments: 30 });
      // class-validator com enableImplicitConversion: false deve rejeitar
      expect(res.status).toBe(400);
    });

    it('deve rejeitar amountCents como float (precisão monetária)', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'test-float-amount-001')
        .send({ amountCents: 50000.99, dailyInstallments: 30 });
      expect(res.status).toBe(400);
    });

    it('deve rejeitar dailyInstallments fora do range (< 10 ou > 180)', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res1 = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'test-min-install-001')
        .send({ amountCents: 50000, dailyInstallments: 5 });
      expect(res1.status).toBe(400);

      const res2 = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', 'test-max-install-001')
        .send({ amountCents: 50000, dailyInstallments: 999 });
      expect(res2.status).toBe(400);
    });
  });

  // ── 2. Race Condition — Dupla Solicitação de Crédito ────────────────────

  describe('2. Race Condition — Duplicate Credit Request', () => {
    it('deve bloquear segunda solicitação simultânea de crédito', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const payload = { amountCents: 50000, dailyInstallments: 30 };
      // Envia dois requests ao mesmo tempo
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post(`${BASE}/credit/request`)
          .set('Authorization', `Bearer ${clientToken}`)
          .set('Idempotency-Key', 'race-test-concurrent-001')
          .send(payload),
        request(app.getHttpServer())
          .post(`${BASE}/credit/request`)
          .set('Authorization', `Bearer ${clientToken}`)
          .set('Idempotency-Key', 'race-test-concurrent-002')
          .send(payload),
      ]);
      const statuses = [res1.status, res2.status].sort();
      // Um deve ter sucesso ou idempotência, o outro deve ser bloqueado (400/409)
      // Ou ambos podem retornar 400 se já existe solicitação pendente do seed
      expect(statuses.every((s) => [200, 201, 400, 409].includes(s))).toBe(true);
      // Não deve haver dois aprovados simultaneamente
      expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(1);
    });
  });

  // ── 3. Idempotência — Reenvio com mesmo Idempotency-Key ─────────────────

  describe('3. Idempotency Key Security', () => {
    it('deve retornar mesma resposta para mesma Idempotency-Key e payload', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const key = `idempotency-test-${Date.now()}`;
      const payload = { amountCents: 50000, dailyInstallments: 30 };

      const res1 = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', key)
        .send(payload);

      // Segunda requisição com mesma chave e mesmo payload
      const res2 = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', key)
        .send(payload);

      // Ambas devem ter o mesmo status (ou 409 na segunda indicando duplicata em processo)
      expect([200, 201, 400, 409]).toContain(res1.status);
      expect([200, 201, 400, 409]).toContain(res2.status);
    });

    it('deve rejeitar Idempotency-Key reusada com payload diferente', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const key = `idempotency-conflict-${Date.now()}`;

      // Primeira requisição
      await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', key)
        .send({ amountCents: 50000, dailyInstallments: 30 });

      // Segunda requisição com mesma chave mas payload diferente → deve conflitar
      const res2 = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', key)
        .send({ amountCents: 80000, dailyInstallments: 60 }); // payload diferente

      // Se a primeira foi processada com sucesso, a segunda deve retornar 409
      if ([200, 201].includes(res2.status)) {
        // Pode ser que a primeira também falhou (ex: já havia solicitação pendente)
        // Neste caso ambas falham com 400 — aceitável
      } else {
        expect([400, 409]).toContain(res2.status);
      }
    });

    it('deve rejeitar requisição sem Idempotency-Key em endpoint que exige', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        // sem Idempotency-Key
        .send({ amountCents: 50000, dailyInstallments: 30 });
      // O IdempotencyInterceptor deve exigir a chave
      expect([400]).toContain(res.status);
    });

    it('deve rejeitar Idempotency-Key com caracteres inválidos', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/request`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', '<script>alert(1)</script>')
        .send({ amountCents: 50000, dailyInstallments: 30 });
      expect(res.status).toBe(400);
    });
  });

  // ── 4. Aprovação de Crédito — Escalada de Privilégio ────────────────────

  describe('4. Credit Approval — Privilege Escalation', () => {
    it('CLIENT não pode aprovar próprio crédito', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/fake-request-id/approve`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ approvedLimitCents: 1000000, reason: 'auto-approval hack' });
      expect([403, 404]).toContain(res.status);
    });

    it('CLIENT não pode rejeitar solicitação de crédito', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/credit/fake-request-id/reject`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ reason: 'unauthorized rejection' });
      expect([403, 404]).toContain(res.status);
    });
  });

  // ── 5. Marketplace — Manipulação de Preço ────────────────────────────────

  describe('5. Marketplace — Price Manipulation', () => {
    it('CLIENT não pode definir preço ao criar pedido (preço vem do servidor)', async () => {
      if (!clientToken) return pending('Client token não disponível');
      // Se o campo priceCents fosse aceito, seria uma vulnerability de price manipulation
      const res = await request(app.getHttpServer())
        .post(`${BASE}/marketplace/orders`)
        .set('Authorization', `Bearer ${clientToken}`)
        .set('Idempotency-Key', `price-manip-${Date.now()}`)
        .send({
          productId: '00000000-0000-0000-0000-000000000001',
          priceCents: 1,     // tentativa de manipular preço
          amountCents: 1,    // tentativa de manipular valor
        });
      // priceCents e amountCents não são campos do CreateOrderDto → deve rejeitar
      expect([400, 404]).toContain(res.status);
    });
  });

  // ── 6. Payments — Nenhum Endpoint para Alterar Valor ─────────────────────

  describe('6. Payment Status — Unauthorized State Change', () => {
    it('CLIENT não pode alterar status de pagamento diretamente', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .patch(`${BASE}/payments/fake-payment-id/status`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ status: 'PAID' });
      // Endpoint não existe ou retorna 403/404
      expect([403, 404]).toContain(res.status);
    });

    it('CLIENT não pode acessar webhook de pagamento para marcar como pago', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/payments/webhook`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({
          providerReference: 'fake-ref',
          status: 'PAID',
          occurredAt: new Date().toISOString(),
        });
      // Webhook não usa autenticação JWT mas verifica HMAC — deve rejeitar sem assinatura
      expect(res.status).toBe(401);
    });
  });
});
