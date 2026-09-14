import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { PanelPrincipal } from './panel-auth.service';
import {
  BlockUserDto,
  ChangePasswordDto,
  CreateAppUserDto,
  DeleteUserDto,
  ListAppUsersQueryDto,
  UnlockUserDto,
  UpdateAppUserDto,
} from './dto';

// Mesmos parâmetros de hash do seed, do login e do AdminService: um usuário
// criado aqui entra com o mesmo custo de argon2id dos demais.
const PASSWORD_HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

/** Nunca devolvemos passwordHash para o navegador. */
const USER_PUBLIC_SELECT = {
  id: true,
  tenantId: true,
  merchantId: true,
  role: true,
  status: true,
  name: true,
  email: true,
  failedLoginCount: true,
  lockedUntil: true,
  lastBlockedAt: true,
  lastBlockReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PanelActor = Pick<PanelPrincipal, 'sub' | 'email' | 'tenantId'>;

/**
 * Administração dos usuários da aplicação (tabela `User`) pelo painel.
 *
 * Escopo: sempre o tenant do operador logado. Um id de outro tenant responde
 * 404, nunca vaza existência. Toda operação passa por `assertGuardRails` antes
 * de escrever, para não deixarmos o tenant sem administrador ou sem a própria
 * conta do operador.
 */
@Injectable()
export class DbAdminUsersService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventsService) {}

  // --- Leitura ---------------------------------------------------------------

  /** Lista com filtros e busca textual. Devolve `counts` para os chips do painel. */
  async listUsers(actor: PanelActor, filters: Partial<ListAppUsersQueryDto> = {}) {
    const tenantId = actor.tenantId;
    const search = filters.search?.trim();
    const where: Prisma.UserWhereInput = {
      tenantId,
      ...(filters.role ? { role: filters.role } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : {}),
    };
    const [users, counts] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: { ...USER_PUBLIC_SELECT, _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } } },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
        take: 500,
      }),
      this.prisma.user.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
    ]);
    return {
      tenantId,
      counts: {
        total: counts.reduce((acc, c) => acc + c._count._all, 0),
        active: counts.find((c) => c.status === 'ACTIVE')?._count._all ?? 0,
        blocked: counts.find((c) => c.status === 'BLOCKED')?._count._all ?? 0,
        pending: counts.find((c) => c.status === 'PENDING')?._count._all ?? 0,
      },
      users: users.map(({ _count, ...u }) => ({ ...u, activeSessions: _count.sessions })),
    };
  }

  /** Loja (Lojistas) do tenant, para o vínculo de usuários MERCHANT. */
  async listMerchants(actor: PanelActor) {
    return this.prisma.merchant.findMany({
      where: { tenantId: actor.tenantId },
      select: { id: true, tradeName: true, legalName: true, active: true },
      orderBy: { tradeName: 'asc' },
    });
  }

  /** Detalhe de um usuário, com o que depende dele antes de apagar. */
  async getUser(actor: PanelActor, userId: string) {
    const user = await this.findTenantUser(actor, userId);
    const dependencies = await this.countDependencies(actor.tenantId, user.id);
    return { user, dependencies, totalDependencies: totalOf(dependencies) };
  }

  // --- Escrita ---------------------------------------------------------------

  async createUser(actor: PanelActor, dto: Omit<CreateAppUserDto, 'panelToken'>) {
    const tenantId = actor.tenantId;
    const email = dto.email.trim().toLowerCase();
    await this.assertEmailFree(tenantId, email);
    const passwordHash = await argon2.hash(dto.password, PASSWORD_HASH_OPTIONS);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { tenantId, role: dto.role, status: dto.status ?? 'ACTIVE', name: dto.name.trim(), email, passwordHash },
        select: USER_PUBLIC_SELECT,
      });
      await this.audit(tx, actor, 'db-admin.user.created', 'User', created.id, {
        userId: created.id, role: created.role, email: created.email, status: created.status,
      });
      return created;
    });
  }

  /**
   * Edita cadastro (nome, e-mail, papel, status, loja). Trocar o status
   * para BLOCKED derruba as sessões, igual à remoção lógica do AdminService.
   */
  async updateUser(actor: PanelActor, userId: string, dto: Omit<UpdateAppUserDto, 'panelToken'>) {
    const target = await this.findTenantUser(actor, userId);
    const data: Prisma.UserUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.email !== undefined) {
      const email = dto.email.trim().toLowerCase();
      if (email !== target.email) await this.assertEmailFree(actor.tenantId, email);
      data.email = email;
    }
    if (dto.role !== undefined && dto.role !== target.role) {
      if (target.id === actor.sub) throw new ForbiddenException('Você não pode alterar o próprio perfil pelo painel');
      if (target.role === 'ADMIN' && target.status === 'ACTIVE') await this.assertNotLastActiveAdmin(actor.tenantId, target.id, 'rebaixar');
      data.role = dto.role;
    }
    if (dto.status !== undefined) {
      data.status = dto.status;
      if (dto.status !== 'ACTIVE') {
        if (target.id === actor.sub) throw new ForbiddenException('Você não pode desativar o seu próprio acesso');
        if (target.role === 'ADMIN') await this.assertNotLastActiveAdmin(actor.tenantId, target.id, 'desativar');
      }
    }
    if (dto.merchantId !== undefined) {
      if (dto.merchantId === null) data.merchant = { disconnect: true };
      else {
        const merchant = await this.prisma.merchant.findFirst({ where: { id: dto.merchantId, tenantId: actor.tenantId }, select: { id: true } });
        if (!merchant) throw new BadRequestException('Lojista não encontrado neste tenant');
        data.merchant = { connect: { id: merchant.id } };
      }
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('Nada para atualizar');

    const revokeSessions = dto.status !== undefined && dto.status !== 'ACTIVE';
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: target.id }, data, select: USER_PUBLIC_SELECT });
      const revoked = revokeSessions
        ? (await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } })).count
        : 0;
      await this.audit(tx, actor, 'db-admin.user.updated', 'User', target.id, {
        userId: target.id,
        changes: Object.keys(dto).filter((k) => k !== 'panelToken'),
        email: updated.email,
        role: updated.role,
        status: updated.status,
        revokedSessions: revoked,
      });
      return { ...updated, revokedSessions: revoked };
    });
  }

  /**
   * Troca a senha. Por padrão derruba todas as sessões abertas: manter o token
   * antigo vivo depois da troca anularia a medida.
   */
  async changePassword(actor: PanelActor, userId: string, dto: Omit<ChangePasswordDto, 'panelToken'>) {
    const target = await this.findTenantUser(actor, userId);
    const passwordHash = await argon2.hash(dto.newPassword, PASSWORD_HASH_OPTIONS);
    const revokeSessions = dto.revokeSessions !== false;
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        // Zera tentativas e desbloqueia: a senha nova precisa funcionar já.
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      });
      const revoked = revokeSessions
        ? (await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } })).count
        : 0;
      await this.audit(tx, actor, 'db-admin.user.password-changed', 'User', target.id, {
        userId: target.id, email: target.email, revokedSessions: revoked,
      });
      return { id: target.id, email: target.email, revokedSessions: revoked, sessionsRevoked: revokeSessions };
    });
  }

  /** Desbloqueia: zera lockout e tentativas, sem mexer no status. */
  async unlockUser(actor: PanelActor, userId: string, dto: Partial<UnlockUserDto> = {}) {
    const target = await this.findTenantUser(actor, userId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastBlockedAt: null, lastBlockReason: null },
        select: USER_PUBLIC_SELECT,
      });
      await this.audit(tx, actor, 'db-admin.user.unlocked', 'User', target.id, { userId: target.id, email: target.email, reason: dto.reason ?? null });
      return updated;
    });
  }

  /** Remoção lógica: BLOCKED + revogação das sessões, preservando o histórico. */
  async blockUser(actor: PanelActor, userId: string, dto: Partial<BlockUserDto> = {}) {
    const target = await this.findTenantUser(actor, userId);
    if (target.id === actor.sub) throw new ForbiddenException('Você não pode remover o seu próprio acesso');
    if (target.status === 'BLOCKED') throw new BadRequestException('Este usuário já está removido');
    if (target.role === 'ADMIN') await this.assertNotLastActiveAdmin(actor.tenantId, target.id, 'remover');
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { status: 'BLOCKED', lastBlockedAt: now, lastBlockReason: dto.reason ?? null },
        select: USER_PUBLIC_SELECT,
      });
      const revoked = (await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: now } })).count;
      await this.audit(tx, actor, 'db-admin.user.blocked', 'User', target.id, { userId: target.id, email: target.email, reason: dto.reason ?? null, revokedSessions: revoked });
      return { ...updated, revokedSessions: revoked };
    });
  }

  /** Reverte a remoção lógica. */
  async restoreUser(actor: PanelActor, userId: string) {
    const target = await this.findTenantUser(actor, userId);
    if (target.status === 'ACTIVE') throw new BadRequestException('Este usuário já está ativo');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, lastBlockedAt: null, lastBlockReason: null },
        select: USER_PUBLIC_SELECT,
      });
      await this.audit(tx, actor, 'db-admin.user.restored', 'User', target.id, { userId: target.id, email: target.email });
      return updated;
    });
  }

  /**
   * Exclusão definitiva (DELETE físico). É irreversível, então:
   *  1. nunca apaga o próprio operador, o último ADMIN ativo ou um usuário com
   *     registros financeiros (pedidos/pagamentos/apólices/lançamentos) — nesse
   *     caso devolve 400 com o relatório de dependências;
   *  2. sem `force: true` apenas relata o que seria apagado em cascata;
   *  3. com `force: true` apaga em cascata o que pertence ao usuário (sessões,
   *     notificações, conta de crédito, rastreadores + pontos, idempotência) e
   *     anonimiza os vínculos históricos.
   */
  async deleteUser(actor: PanelActor, userId: string, dto: Omit<DeleteUserDto, 'panelToken'>) {
    const target = await this.findTenantUser(actor, userId);
    if (target.id === actor.sub) throw new ForbiddenException('Você não pode excluir a sua própria conta pelo painel');
    if (target.role === 'ADMIN') await this.assertNotLastActiveAdmin(actor.tenantId, target.id, 'excluir');

    const dependencies = await this.countDependencies(actor.tenantId, target.id);
    const financial = dependencies.orders + dependencies.payments + dependencies.policies + dependencies.ledgerEntries;
    if (financial > 0) {
      throw new BadRequestException(
        `Exclusão definitiva bloqueada: o usuário possui registros financeiros/históricos (${financial}). ` +
          'Use a remoção lógica (bloquear) para preservar a auditoria e o histórico fiscal.',
      );
    }
    const total = totalOf(dependencies);
    if (!dto.force) {
      // Primeiro passo: relatório, sem apagar nada.
      return { deleted: false, requiresConfirmation: true, user: target, dependencies, totalDependencies: total };
    }

    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.user.delete({ where: { id: target.id }, select: { id: true, email: true, name: true, role: true } });
      await this.audit(tx, actor, 'db-admin.user.deleted', 'User', target.id, {
        userId: target.id, email: target.email, role: target.role, name: target.name, reason: dto.reason ?? null, dependencies,
      });
      return { deleted: true, requiresConfirmation: false, user: deleted, dependencies, totalDependencies: total };
    });
  }

  // --- Regras e helpers ------------------------------------------------------

  /**
   * Tudo que aponta para o usuário, separando o que a FK apaga em cascata do
   * que precisa ser anonimizado para a exclusão passar.
   */
  async countDependencies(tenantId: string, userId: string) {
    const [sessions, notifications, creditAccount, trackers, trackingPoints, idempotencyRecords, creditRequests, orders, payments, policies, auditLogs] =
      await Promise.all([
        this.prisma.session.count({ where: { userId } }),
        this.prisma.notification.count({ where: { userId } }),
        this.prisma.creditAccount.count({ where: { userId } }),
        this.prisma.tracker.count({ where: { userId } }),
        this.prisma.trackingPoint.count({ where: { tracker: { userId } } }),
        this.prisma.idempotencyRecord.count({ where: { userId } }),
        this.prisma.creditRequest.count({ where: { userId } }),
        this.prisma.order.count({ where: { clientId: userId } }),
        this.prisma.payment.count({ where: { userId } }),
        this.prisma.insurancePolicy.count({ where: { userId } }),
        this.prisma.auditLog.count({ where: { actorUserId: userId } }),
      ]);

    // Lançamentos contábeis ligados aos pedidos do usuário: LedgerTransaction
    // referencia o pedido por string (`ORDER`/orderId), sem FK. Por isso a
    // contagem é derivada dos pedidos do usuário.
    const orderIds = await this.prisma.order.findMany({ where: { clientId: userId }, select: { id: true }, take: 500 });
    const ledgerEntries = orderIds.length
      ? await this.prisma.ledgerEntry.count({ where: { transaction: { referenceType: 'ORDER', referenceId: { in: orderIds.map((o) => o.id) } } } })
      : 0;

    return {
      // Apagados em cascata junto com o usuário.
      sessions,
      notifications,
      creditAccount,
      trackers,
      trackingPoints,
      idempotencyRecords,
      // Histórico: exige decisão do operador, não entra no cascade. Pedidos,
      // pagamentos, apólices e lançamentos bloqueiam a exclusão definitiva.
      creditRequests,
      orders,
      payments,
      policies,
      auditLogs,
      ledgerEntries,
      tenantId,
    };
  }

  private async findTenantUser(actor: PanelActor, userId: string) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: actor.tenantId },
      select: { ...USER_PUBLIC_SELECT, cpfHash: true },
    });
    if (!target) throw new NotFoundException('Usuário não encontrado neste tenant');
    return target;
  }

  private async assertEmailFree(tenantId: string, email: string) {
    const existing = await this.prisma.user.findUnique({ where: { tenantId_email: { tenantId, email } }, select: { id: true } });
    if (existing) throw new ConflictException('Já existe um usuário com esse e-mail neste tenant');
  }

  private async assertNotLastActiveAdmin(tenantId: string, userId: string, action: string) {
    const others = await this.prisma.user.count({ where: { tenantId, role: 'ADMIN', status: 'ACTIVE', id: { not: userId } } });
    if (others === 0) throw new BadRequestException(`Não é possível ${action} o último administrador ativo do tenant`);
  }

  /** Evento de domínio + trilha de auditoria do painel, na mesma transação. */
  private audit(
    tx: Prisma.TransactionClient,
    actor: PanelActor,
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Prisma.InputJsonValue,
  ) {
    return Promise.all([
      this.events.append(
        {
          tenantId: actor.tenantId,
          type,
          aggregateType,
          aggregateId,
          payload,
          audience: ['role:ADMIN', 'role:SUPPORT'],
        },
        tx,
      ),
      // actorUserId pode ficar nulo se o operador foi apagado; o e-mail dele vai
      // no metadata para a trilha continuar legível.
      tx.auditLog.create({
        data: {
          actorUserId: actor.sub,
          tenantId: actor.tenantId,
          action: type,
          resource: aggregateType,
          resourceId: aggregateId,
          requestId: 'db-admin-panel',
          metadata: { via: 'db-admin-panel', actorEmail: actor.email, ...(payload as Record<string, unknown>) },
        },
      }),
    ]);
  }
}

function totalOf(deps: Record<string, unknown>): number {
  return Object.entries(deps).reduce((acc, [key, value]) => (key === 'tenantId' ? acc : acc + Number(value ?? 0)), 0);
}
