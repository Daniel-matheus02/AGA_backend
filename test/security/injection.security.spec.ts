/**
 * TESTES DE SEGURANÇA — Rate Limiting, Injeção & Validação de Entrada
 *
 * Simula ataques de:
 *  - SQL Injection via parâmetros de query e body
 *  - NoSQL Injection (objeto no lugar de string)
 *  - Prototype Pollution
 *  - XSS via campos de texto
 *  - Oversized payloads (DoS)
 *  - Rate limiting global
 *  - Header injection
 *  - Content-Type sniffing
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

async function getToken(
  app: INestApplication,
  email: string,
  password: string,
): Promise<string | null> {
  const res = await request(app.getHttpServer())
    .post(`${BASE}/auth/login`)
    .send({ email, password });
  return res.body?.accessToken ?? null;
}

describe('[SECURITY] Input Validation, Injection & Rate Limiting', () => {
  let app: INestApplication;
  let clientToken: string | null;

  beforeAll(async () => {
    app = await buildApp();
    clientToken = await getToken(
      app,
      process.env.SEED_CLIENT_EMAIL ?? 'cliente@aga.local',
      process.env.SEED_CLIENT_PASSWORD ?? 'CHANGE_ME_Cliente_2026!',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  // ── 1. SQL Injection ──────────────────────────────────────────────────────

  describe('1. SQL Injection Attempts', () => {
    const sqlPayloads = [
      "' OR '1'='1",
      "'; DROP TABLE users; --",
      "' UNION SELECT null, null, null --",
      "1; SELECT * FROM \"User\" --",
      "admin'--",
      "' OR 1=1--",
    ];

    sqlPayloads.forEach((payload) => {
      it(`deve rejeitar SQL injection no email: ${payload.substring(0, 30)}...`, async () => {
        const res = await request(app.getHttpServer())
          .post(`${BASE}/auth/login`)
          .send({ email: payload, password: 'SenhaForte123456!' });
        // Deve retornar 400 (validação) ou 401 — nunca 200 ou 500
        expect([400, 401]).toContain(res.status);
        // Não deve vazar detalhes de SQL
        expect(JSON.stringify(res.body)).not.toMatch(/syntax error/i);
        expect(JSON.stringify(res.body)).not.toMatch(/pg_/i);
      });
    });

    it('deve rejeitar SQL injection em parâmetro de query ?status', async () => {
      if (!clientToken) return pending('Client token não disponível');
      const res = await request(app.getHttpServer())
        .get(`${BASE}/payments/me?status=' OR 1=1 --`)
        .set('Authorization', `Bearer ${clientToken}`);
      // Pagamentos não filtram por status para o CLIENT diretamente, mas não deve crashar
      expect(res.status).not.toBe(500);
    });
  });

  // ── 2. NoSQL / Object Injection ──────────────────────────────────────────

  describe('2. NoSQL / Object Injection', () => {
    it('deve rejeitar objeto no lugar de string no campo email', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({ email: { $gt: '' }, password: 'SenhaForte123456!' });
      expect(res.status).toBe(400);
    });

    it('deve rejeitar array no lugar de string no campo password', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({ email: 'admin@aga.local', password: ['senha1', 'senha2'] });
      expect(res.status).toBe(400);
    });

    it('deve rejeitar null no campo email', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({ email: null, password: 'SenhaForte123456!' });
      expect(res.status).toBe(400);
    });

    it('deve rejeitar boolean no campo email', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({ email: true, password: 'SenhaForte123456!' });
      expect(res.status).toBe(400);
    });
  });

  // ── 3. Prototype Pollution ────────────────────────────────────────────────

  describe('3. Prototype Pollution', () => {
    it('deve ignorar __proto__ no body JSON', async () => {
      const maliciousBody = JSON.parse('{"email":"test@test.com","password":"SenhaForte123456!","__proto__":{"admin":true,"isAdmin":true}}');
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send(maliciousBody);
      // Deve ser rejeitado por forbidNonWhitelisted ou retornar 401
      expect([400, 401]).toContain(res.status);
      // Garante que Object.prototype não foi poluído
      expect((Object.prototype as any).admin).toBeUndefined();
      expect((Object.prototype as any).isAdmin).toBeUndefined();
    });

    it('deve ignorar constructor.prototype no body', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({
          email: 'test@test.com',
          password: 'SenhaForte123456!',
          'constructor': { 'prototype': { 'isAdmin': true } },
        });
      expect([400, 401]).toContain(res.status);
    });
  });

  // ── 4. XSS via campos de texto ───────────────────────────────────────────

  describe('4. XSS Payloads in Input Fields', () => {
    const xssPayloads = [
      '<script>alert(1)</script>',
      '"><img src=x onerror=alert(1)>',
      "javascript:alert('XSS')",
      '<svg onload=alert(1)>',
      '{{7*7}}', // Template injection
    ];

    xssPayloads.forEach((payload) => {
      it(`deve rejeitar ou sanitizar XSS: ${payload.substring(0, 30)}`, async () => {
        const res = await request(app.getHttpServer())
          .post(`${BASE}/auth/login`)
          .send({ email: payload, password: 'SenhaForte123456!' });
        // @IsEmail() deve rejeitar qualquer XSS como email inválido
        expect(res.status).toBe(400);
        // Resposta nunca deve refletir o script sem encoding
        expect(res.text).not.toContain('<script>');
      });
    });
  });

  // ── 5. Oversized Payload (DoS) ───────────────────────────────────────────

  describe('5. Oversized Payload / DoS Protection', () => {
    it('deve rejeitar payload JSON acima de 256kb', async () => {
      const bigString = 'a'.repeat(300 * 1024); // 300kb
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: 'test@test.com', password: bigString }));
      // Express retorna 413 Payload Too Large
      expect([400, 413]).toContain(res.status);
    });

    it('deve rejeitar body urlencoded acima de 64kb', async () => {
      const bigValue = 'a'.repeat(70 * 1024);
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`email=test%40test.com&password=${bigValue}`);
      expect([400, 413]).toContain(res.status);
    });
  });

  // ── 6. Rate Limiting ─────────────────────────────────────────────────────

  describe('6. Rate Limiting (Throttle)', () => {
    it('deve aplicar throttle global após muitas requisições rápidas', async () => {
      const promises = Array.from({ length: 130 }, () =>
        request(app.getHttpServer())
          .get(`${BASE}/health`)
          .then((r) => r.status),
      );
      const statuses = await Promise.all(promises);
      // Ao menos uma deve retornar 429 (throttled)
      expect(statuses).toContain(429);
    });
  });

  // ── 7. Security Headers ───────────────────────────────────────────────────

  describe('7. Security Headers via Helmet', () => {
    it('deve incluir X-Content-Type-Options: nosniff', async () => {
      const res = await request(app.getHttpServer()).get(`${BASE}/health`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('deve incluir X-Frame-Options para evitar clickjacking', async () => {
      const res = await request(app.getHttpServer()).get(`${BASE}/health`);
      const xFrameOptions = res.headers['x-frame-options'];
      expect(xFrameOptions).toBeDefined();
    });

    it('deve incluir Content-Security-Policy', async () => {
      const res = await request(app.getHttpServer()).get(`${BASE}/health`);
      expect(res.headers['content-security-policy']).toBeDefined();
    });

    it('não deve expor X-Powered-By: Express', async () => {
      const res = await request(app.getHttpServer()).get(`${BASE}/health`);
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  // ── 8. CORS ────────────────────────────────────────────────────────────────

  describe('8. CORS Policy', () => {
    it('deve bloquear origem não permitida', async () => {
      const res = await request(app.getHttpServer())
        .options(`${BASE}/auth/login`)
        .set('Origin', 'https://evil-site.com')
        .set('Access-Control-Request-Method', 'POST');
      // Deve retornar erro ou não incluir a origem maliciosa no allow-origin
      const allowOrigin = res.headers['access-control-allow-origin'];
      expect(allowOrigin).not.toBe('https://evil-site.com');
    });

    it('deve permitir origens configuradas em CORS_ORIGINS', async () => {
      const allowedOrigin = 'http://localhost:5173';
      const res = await request(app.getHttpServer())
        .options(`${BASE}/auth/login`)
        .set('Origin', allowedOrigin)
        .set('Access-Control-Request-Method', 'POST');
      const allowOrigin = res.headers['access-control-allow-origin'];
      expect(allowOrigin).toBe(allowedOrigin);
    });
  });

  // ── 9. Content-Type Validation ────────────────────────────────────────────

  describe('9. Content-Type Validation', () => {
    it('deve rejeitar ou tratar corretamente content-type text/plain em endpoint JSON', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .set('Content-Type', 'text/plain')
        .send('email=admin&password=teste');
      // Deve retornar 400 (bad request) ou tratar como string vazia
      expect([400, 415]).toContain(res.status);
    });
  });
});
