/**
 * Remoção lógica de usuário (soft delete) — regras de negócio do AdminService.
 *
 * O backend não tem Postgres/Redis no ambiente local, então este spec cobre a
 * orquestração com PrismaService e EventsService mockados: qual UPDATE é feito,
 * qual sessão é revogada, qual evento é emitido e quais guardas bloqueiam a
 * operação antes de qualquer escrita.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from '../src/admin/admin.service';
import { AuthenticatedUser } from '../src/common/auth.types';

const actor: AuthenticatedUser = {
  sub: 'admin-1',
  tenantId: 'tenant-1',
  role: 'ADMIN',
  merchantId: null,
  sessionId: 'session-actor',
  email: 'admin@aga.local',
};

type Target = { id: string; role: string; status: string; email: string; name: string };

function build(target: Target | null, activeAdmins = 1, revokedSessions = 2) {
  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue(target),
      count: jest.fn().mockResolvedValue(activeAdmins),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...target, ...data })),
    },
    session: { updateMany: jest.fn().mockResolvedValue({ count: revokedSessions }) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
  };
  const events = { append: jest.fn().mockResolvedValue({ id: 'evt-1' }) };
  return { prisma, events, service: new AdminService(prisma as any, events as any) };
}

const CLIENT: Target = { id: 'user-2', role: 'CLIENT', status: 'ACTIVE', email: 'cliente@aga.local', name: 'Cliente' };

describe('AdminService — remoção de usuário', () => {
  it('bloqueia o usuário, revoga as sessões abertas e emite o evento', async () => {
    const { prisma, events, service } = build(CLIENT);
    const result = await service.blockUser(actor, 'user-2', { reason: 'solicitação do titular' });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-2' },
        data: expect.objectContaining({ status: 'BLOCKED', lastBlockReason: 'solicitação do titular' }),
      }),
    );
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-2', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.user.blocked', aggregateId: 'user-2', payload: expect.objectContaining({ revokedSessions: 2 }) }),
      prisma,
    );
    expect(result).toEqual(expect.objectContaining({ id: 'user-2', status: 'BLOCKED', revokedSessions: 2 }));
  });

  it('não devolve passwordHash nem mfaSecretEncrypted', async () => {
    const { service } = build(CLIENT);
    const result: any = await service.blockUser(actor, 'user-2');
    expect(result.passwordHash).toBeUndefined();
    expect(result.mfaSecretEncrypted).toBeUndefined();
  });

  it('recusa remover o próprio acesso', async () => {
    const { prisma, service } = build({ ...CLIENT, id: actor.sub, role: 'ADMIN', email: actor.email });
    await expect(service.blockUser(actor, actor.sub)).rejects.toThrow(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('recusa remover o último administrador ativo do tenant', async () => {
    const { prisma, service } = build({ ...CLIENT, id: 'admin-2', role: 'ADMIN' }, 0);
    await expect(service.blockUser(actor, 'admin-2')).rejects.toThrow('último administrador ativo');
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('permite remover um administrador quando existe outro ativo', async () => {
    const { prisma, service } = build({ ...CLIENT, id: 'admin-2', role: 'ADMIN' }, 1);
    await expect(service.blockUser(actor, 'admin-2')).resolves.toEqual(expect.objectContaining({ status: 'BLOCKED' }));
    expect(prisma.user.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1', role: 'ADMIN', status: 'ACTIVE' }) }),
    );
  });

  it('não deixa remover duas vezes', async () => {
    const { prisma, service } = build({ ...CLIENT, status: 'BLOCKED' });
    await expect(service.blockUser(actor, 'user-2')).rejects.toThrow('já está removido');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('responde 404 para usuário de outro tenant (escopo por tenant)', async () => {
    const { prisma, service } = build(null);
    await expect(service.blockUser(actor, 'user-de-outro-tenant')).rejects.toThrow(NotFoundException);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-de-outro-tenant', tenantId: 'tenant-1' } }),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('restaura o acesso limpando bloqueio e tentativas de login', async () => {
    const { prisma, events, service } = build({ ...CLIENT, status: 'BLOCKED' });
    const result = await service.unblockUser(actor, 'user-2');

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, lastBlockedAt: null, lastBlockReason: null }),
      }),
    );
    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'admin.user.unblocked' }), prisma);
    expect(result).toEqual(expect.objectContaining({ status: 'ACTIVE' }));
  });
});
