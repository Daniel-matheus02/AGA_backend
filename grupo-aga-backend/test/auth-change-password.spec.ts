/**
 * Troca de senha pelo próprio usuário (`AuthService.changePassword`).
 *
 * Spec de unidade: o Prisma é mockado porque o que está sob teste é a regra, não
 * o banco — que a senha atual é exigida, que as *outras* sessões caem e que a de
 * quem pediu sobrevive. Assim o teste roda sem Postgres.
 */

import * as argon2 from 'argon2';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { AuthenticatedUser } from '../src/common/auth.types';

const HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

const USER: AuthenticatedUser = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  role: 'CLIENT',
  sessionId: 'session-current',
  email: 'cliente@aga.local',
};

/** Prisma mockado: registra as escritas para que o teste possa inspecioná-las. */
function buildPrisma(passwordHash: string) {
  const writes: { sessions: unknown[]; users: unknown[] } = { sessions: [], users: [] };
  const tx = {
    session: {
      findMany: jest.fn().mockResolvedValue([{ id: 'session-other-1' }, { id: 'session-other-2' }]),
      updateMany: jest.fn().mockImplementation(async (args: unknown) => {
        writes.sessions.push(args);
        return { count: 2 };
      }),
    },
    user: {
      update: jest.fn().mockImplementation(async (args: unknown) => {
        writes.users.push(args);
        return {};
      }),
    },
  };
  return {
    writes,
    prisma: {
      user: { findUnique: jest.fn().mockResolvedValue({ id: USER.sub, passwordHash }) },
      $transaction: jest.fn().mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as never,
  };
}

function buildService(prisma: unknown) {
  const authEvents = { publishSessionRevoked: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthService(prisma as never, {} as never, {} as never, authEvents as never);
  return { service, authEvents };
}

describe('AuthService.changePassword', () => {
  it('troca a senha quando a senha atual confere e revoga as OUTRAS sessões', async () => {
    const currentHash = await argon2.hash('SenhaAtual123!', HASH_OPTIONS);
    const { prisma, writes } = buildPrisma(currentHash);
    const { service, authEvents } = buildService(prisma);

    const result = await service.changePassword(USER, {
      currentPassword: 'SenhaAtual123!',
      newPassword: 'SenhaNova456!',
    });

    expect(result).toEqual({ ok: true, revokedSessions: 2, sessionsRevoked: true });

    // A sessão de quem pediu nunca entra no filtro de revogação.
    expect(writes.sessions).toHaveLength(1);
    expect(writes.sessions[0]).toMatchObject({
      where: { id: { in: ['session-other-1', 'session-other-2'] } },
    });
    expect(JSON.stringify(writes.sessions[0])).not.toContain(USER.sessionId);

    // A senha gravada é o hash da nova, não a antiga.
    const userUpdate = writes.users[0] as { data: { passwordHash: string } };
    expect(await argon2.verify(userUpdate.data.passwordHash, 'SenhaNova456!')).toBe(true);

    expect(authEvents.publishSessionRevoked).toHaveBeenCalledWith({
      tenantId: USER.tenantId,
      userId: USER.sub,
      reason: 'password-changed',
      sessionIds: ['session-other-1', 'session-other-2'],
    });
  });

  it('zera tentativas falhas e o lockout, para a senha nova funcionar já', async () => {
    const currentHash = await argon2.hash('SenhaAtual123!', HASH_OPTIONS);
    const { prisma, writes } = buildPrisma(currentHash);
    const { service } = buildService(prisma);

    await service.changePassword(USER, {
      currentPassword: 'SenhaAtual123!',
      newPassword: 'SenhaNova456!',
    });

    expect(writes.users[0]).toMatchObject({
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  });

  it('rejeita (401) quando a senha atual está errada e não escreve nada', async () => {
    const currentHash = await argon2.hash('SenhaAtual123!', HASH_OPTIONS);
    const { prisma, writes } = buildPrisma(currentHash);
    const { service, authEvents } = buildService(prisma);

    await expect(
      service.changePassword(USER, { currentPassword: 'SenhaErrada999!', newPassword: 'SenhaNova456!' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(writes.users).toHaveLength(0);
    expect(writes.sessions).toHaveLength(0);
    expect(authEvents.publishSessionRevoked).not.toHaveBeenCalled();
  });

  it('rejeita com a mesma mensagem do login, sem virar oráculo de senha', async () => {
    const currentHash = await argon2.hash('SenhaAtual123!', HASH_OPTIONS);
    const { prisma } = buildPrisma(currentHash);
    const { service } = buildService(prisma);

    await expect(
      service.changePassword(USER, { currentPassword: 'SenhaErrada999!', newPassword: 'SenhaNova456!' }),
    ).rejects.toThrow('Invalid credentials');
  });

  it('preserva as demais sessões quando revokeOtherSessions é false', async () => {
    const currentHash = await argon2.hash('SenhaAtual123!', HASH_OPTIONS);
    const { prisma, writes } = buildPrisma(currentHash);
    const { service, authEvents } = buildService(prisma);

    const result = await service.changePassword(USER, {
      currentPassword: 'SenhaAtual123!',
      newPassword: 'SenhaNova456!',
      revokeOtherSessions: false,
    });

    expect(result).toEqual({ ok: true, revokedSessions: 0, sessionsRevoked: false });
    expect(writes.sessions).toHaveLength(0);
    expect(authEvents.publishSessionRevoked).not.toHaveBeenCalled();
    // A senha ainda é trocada.
    expect(writes.users).toHaveLength(1);
  });
});

/**
 * `GET /auth/me`: o app precisa do perfil vindo do servidor, não do que ele
 * mesmo digitou no login. Este teste garante que a resposta é autoritativa e
 * que o hash da senha nunca escapa no `select`.
 */
describe('AuthService.me', () => {
  function buildMe(record: unknown) {
    const findUnique = jest.fn().mockResolvedValue(record);
    const service = new AuthService(
      { user: { findUnique } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, findUnique };
  }

  it('devolve o perfil lido do banco pelo id do token', async () => {
    const profile = {
      id: USER.sub,
      name: 'Cliente Teste',
      email: 'cliente@aga.local',
      role: 'CLIENT',
      merchantId: null,
      status: 'ACTIVE',
    };
    const { service, findUnique } = buildMe(profile);

    await expect(service.me(USER)).resolves.toEqual(profile);
    // A identidade vem do JWT (`user.sub`), não de parâmetro do cliente.
    expect(findUnique).toHaveBeenCalledWith({ where: { id: USER.sub }, select: expect.any(Object) });
  });

  it('pede um select explícito que NÃO inclui passwordHash', async () => {
    const { service, findUnique } = buildMe({
      id: USER.sub,
      name: 'n',
      email: 'e@e.com',
      role: 'CLIENT',
      merchantId: null,
      status: 'ACTIVE',
    });

    await service.me(USER);

    const select = (findUnique.mock.calls[0][0] as { select: Record<string, boolean> }).select;
    expect(select).not.toHaveProperty('passwordHash');
    // Nenhum campo sensível pode vazar por acidente.
    for (const forbidden of ['passwordHash', 'failedLoginCount', 'lockedUntil', 'cpfHash']) {
      expect(select).not.toHaveProperty(forbidden);
    }
  });

  it('rejeita (401) quando o usuário não existe', async () => {
    const { service } = buildMe(null);
    await expect(service.me(USER)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejeita (401) quando a conta não está ACTIVE', async () => {
    const { service } = buildMe({
      id: USER.sub,
      name: 'n',
      email: 'e@e.com',
      role: 'CLIENT',
      merchantId: null,
      status: 'BLOCKED',
    });
    await expect(service.me(USER)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
