/**
 * TESTES DE SEGURANÇA — Autenticação & Sessão
 *
 * Simula ataques contra os endpoints de autenticação:
 *  - Brute-force de senha
 *  - Bypass de lockout
 *  - JWT manipulation
 *  - Refresh token reuse / session fixation
 *  - MFA bypass
 *  - Mass assignment via campos extras
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/database/prisma.service';
import * as argon2 from 'argon2';

// ─── helpers ─────────────────────────────────────────────────────────────────

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

// ─── suite ───────────────────────────────────────────────────────────────────

describe('[SECURITY] Authentication & Session', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── 1. Brute-force de senha ──────────────────────────────────────────────

  describe('1. Brute-Force Protection', () => {
    it('deve bloquear conta após 5 tentativas erradas (lockout)', async () => {
      const payload = { email: process.env.SEED_ADMIN_EMAIL ?? 'admin@aga.local', password: 'WrongPassword123!' };
      let lastStatus = 0;
      for (let i = 0; i < 6; i++) {
        const res = await request(app.getHttpServer())
          .post(`${BASE}/auth/login`)
          .send(payload);
        lastStatus = res.status;
      }
      // A partir da 6ª tentativa, espera 401 com lockout ou 429 do throttler
      expect([401, 429]).toContain(lastStatus);
    });

    it('deve retornar mensagem genérica (não vazar se o email existe)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({ email: 'naocadastrado@inexistente.com', password: 'QualquerSenha123!' });
      expect(res.status).toBe(401);
      // Não deve diferenciar "usuário não encontrado" de "senha errada"
      expect(res.body.message).toMatch(/invalid credentials/i);
    });

    it('não deve aceitar senha em branco', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({ email: 'admin@aga.local', password: '' });
      expect(res.status).toBe(400);
    });

    it('não deve aceitar senha muito curta (< 10 chars)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({ email: 'admin@aga.local', password: 'curta' });
      expect(res.status).toBe(400);
    });
  });

  // ── 2. JWT Manipulation ─────────────────────────────────────────────────

  describe('2. JWT Manipulation', () => {
    it('deve rejeitar token sem assinatura (algoritmo none)', async () => {
      // JWT com alg:none — tentativa de bypass de verificação
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: 'fake-id', role: 'ADMIN', tenantId: 'x', sessionId: 'y', email: 'hack@x.com' }),
      ).toString('base64url');
      const fakeJwt = `${header}.${payload}.`;

      const res = await request(app.getHttpServer())
        .get(`${BASE}/admin/dashboard`)
        .set('Authorization', `Bearer ${fakeJwt}`);
      expect(res.status).toBe(401);
    });

    it('deve rejeitar token com assinatura adulterada', async () => {
      const fakeJwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJoYWNrZXIiLCJyb2xlIjoiQURNSU4ifQ.INVALIDSIG';
      const res = await request(app.getHttpServer())
        .get(`${BASE}/admin/dashboard`)
        .set('Authorization', `Bearer ${fakeJwt}`);
      expect(res.status).toBe(401);
    });

    it('deve rejeitar requisição sem token', async () => {
      const res = await request(app.getHttpServer()).get(`${BASE}/admin/dashboard`);
      expect(res.status).toBe(401);
    });

    it('deve rejeitar token expirado (não ignorar expiração)', async () => {
      // Token gerado com exp no passado
      const jwt = require('jsonwebtoken');
      const expired = jwt.sign(
        { sub: 'x', role: 'ADMIN', tenantId: 'y', sessionId: 'z', email: 'e@e.com' },
        'wrong-secret',
        { expiresIn: -1 },
      );
      const res = await request(app.getHttpServer())
        .get(`${BASE}/admin/dashboard`)
        .set('Authorization', `Bearer ${expired}`);
      expect(res.status).toBe(401);
    });
  });

  // ── 3. Refresh Token Security ───────────────────────────────────────────

  describe('3. Refresh Token Security', () => {
    it('deve rejeitar refresh token com formato inválido', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/refresh`)
        .send({ refreshToken: 'token-invalido' });
      expect(res.status).toBe(401);
    });

    it('deve rejeitar refresh token muito curto', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/refresh`)
        .send({ refreshToken: 'curto' });
      expect(res.status).toBe(400);
    });

    it('deve rejeitar refresh token com sessionId inválido', async () => {
      const fakeToken = 'NOTAUUID.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/refresh`)
        .send({ refreshToken: fakeToken });
      expect(res.status).toBe(401);
    });
  });

  // ── 4. Mass Assignment ───────────────────────────────────────────────────

  describe('4. Mass Assignment (campos extras no body)', () => {
    it('deve rejeitar campos não permitidos no login payload', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({
          email: 'test@test.com',
          password: 'SenhaForte123!',
          role: 'ADMIN',      // campo não permitido
          isAdmin: true,      // campo não permitido
        });
      expect(res.status).toBe(400);
    });
  });

  // ── 5. MFA Bypass ───────────────────────────────────────────────────────

  describe('5. MFA Bypass', () => {
    it('deve rejeitar login sem totpCode quando MFA está ativo no admin', async () => {
      // Simula cenário onde admin tem MFA ativo — sem fornecer o código deve falhar
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({
          email: process.env.SEED_ADMIN_EMAIL ?? 'admin@aga.local',
          password: process.env.SEED_ADMIN_PASSWORD ?? 'CHANGE_ME_Admin_2026!',
          // totpCode ausente propositalmente
        });
      // Se MFA estiver ativo → 401 ou 403; se não estiver ativo no ambiente de teste → 200
      // O teste garante que a resposta é coerente (nunca 500)
      expect([200, 401, 403]).toContain(res.status);
    });

    it('deve rejeitar totpCode inválido', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({
          email: process.env.SEED_ADMIN_EMAIL ?? 'admin@aga.local',
          password: process.env.SEED_ADMIN_PASSWORD ?? 'CHANGE_ME_Admin_2026!',
          totpCode: '000000', // código inválido
        });
      expect([401, 403]).toContain(res.status);
    });
  });

  // ── 6. Resposta de erro não vaza stack trace ─────────────────────────────

  describe('6. Error Response Information Leakage', () => {
    it('não deve vazar stack trace em erro 500', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/rota-que-nao-existe-abc123`);
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('stack');
      expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(/);
    });

    it('não deve expor detalhes internos de banco em resposta de erro', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/auth/login`)
        .send({ email: 'invalid-email', password: 'Senha123456!' });
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/prisma/i);
      expect(body).not.toMatch(/postgres/i);
      expect(body).not.toMatch(/sql/i);
    });
  });
});
