import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { AuthenticatedUser } from '../common/auth.types';
import { CreateClientDto, CreateMerchantDto } from './dto';

const DAY = 86_400_000;

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventsService) {}
  /** Visão geral do dashboard, com todos os dados vindo do banco (sem valores fixos). */
  async dashboard(user: AuthenticatedUser) {
    const now = Date.now();
    const tenantId = user.tenantId;

    // Contadores principais.
    const [clients, merchants, onlineTrackers, pendingCredit, openAlerts, ordersAgg, creditAgg, policiesAgg, defaulters] =
      await Promise.all([
        this.prisma.user.count({ where: { tenantId, role: 'CLIENT', status: 'ACTIVE' } }),
        this.prisma.merchant.count({ where: { tenantId, active: true } }),
        this.prisma.tracker.count({ where: { tenantId, status: 'ONLINE' } }),
        this.prisma.creditRequest.count({ where: { tenantId, status: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
        this.prisma.trackingAlert.count({ where: { tracker: { tenantId }, resolvedAt: null } }),
        this.prisma.order.aggregate({ where: { tenantId, status: { in: ['AUTHORIZED', 'SETTLED'] } }, _count: true, _sum: { amountCents: true } }),
        this.prisma.creditAccount.aggregate({ where: { user: { tenantId } }, _sum: { limitCents: true, usedCents: true, blockedCents: true } }),
        this.prisma.insurancePolicy.aggregate({ where: { tenantId }, _count: true }),
        this.prisma.creditRequest.count({ where: { tenantId, status: 'APPROVED', updatedAt: { gte: new Date(now - 30 * DAY) } } }),
      ]);

    // Volume financeiro por mês (últimos 6 meses) a partir de pedidos pagos (SETTLED) + recebimentos.
    const volume = await this.prisma.order.groupBy({
      by: ['createdAt'],
      where: { tenantId, status: { in: ['AUTHORIZED', 'SETTLED'] }, createdAt: { gte: new Date(now - 6 * 30 * DAY) } },
      _sum: { amountCents: true },
      orderBy: { createdAt: 'asc' },
    });
    const financialVolume = monthlySeries(now, 6).map((slot) => {
      const sum = volume
        .filter((r) => r.createdAt >= slot.start && r.createdAt < slot.end)
        .reduce((acc, r) => acc + (r._sum.amountCents ?? 0n), 0n);
      return { month: slot.label, cents: sum.toString() };
    });

    // Saúde da operação (% reais).
    const totalTrackers = await this.prisma.tracker.count({ where: { tenantId } });
    const totalPayments = await this.prisma.payment.count({ where: { tenantId } });
    const paidPayments = await this.prisma.payment.count({ where: { tenantId, status: 'PAID' } });
    const totalPolicies = await this.prisma.insurancePolicy.count({ where: { tenantId } });
    const activePolicies = await this.prisma.insurancePolicy.count({ where: { tenantId, status: 'ACTIVE' } });
    const operationHealth = {
      paymentsOnTimePct: pct(paidPayments, totalPayments),
      trackersOnlinePct: pct(onlineTrackers, totalTrackers),
      policiesActivePct: pct(activePolicies, totalPolicies),
      merchantsOperatingPct: pct(merchants, Math.max(1, merchants)),
    };

    // Recebimento diário / inadimplência.
    const paidToday = await this.prisma.payment.aggregate({
      where: { tenantId, status: 'PAID', paidAt: { gte: new Date(now - DAY) } },
      _sum: { amountCents: true },
    });
    const overdue = await this.prisma.payment.count({
      where: { tenantId, status: 'PENDING', dueDate: { lt: new Date(now) } },
    });

    // Solicitações recentes de crédito para a fila.
    const recentRequests = await this.prisma.creditRequest.findMany({
      where: { tenantId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });
    const recentRequestsView = recentRequests.map((r) => ({
      id: r.id,
      client: r.user.name,
      amountCents: r.amountCents.toString(),
      status: r.status,
      createdAt: r.createdAt,
    }));

    // Alertas de rastreamento recentes.
    const alerts = await this.prisma.trackingAlert.findMany({
      where: { tracker: { tenantId }, resolvedAt: null },
      include: { tracker: { select: { plate: true, user: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 6,
    });
    const alertsView = alerts.map((a) => ({
      id: a.id,
      plate: a.tracker.plate,
      client: a.tracker.user.name,
      type: a.type,
      severity: a.severity,
      message: a.message,
      createdAt: a.createdAt,
    }));

    return {
      clients,
      merchants,
      onlineTrackers,
      pendingCredit,
      openAlerts,
      orders: { count: ordersAgg._count, totalCents: (ordersAgg._sum.amountCents ?? 0n).toString() },
      credit: {
        limitCents: (creditAgg._sum.limitCents ?? 0n).toString(),
        usedCents: (creditAgg._sum.usedCents ?? 0n).toString(),
        blockedCents: (creditAgg._sum.blockedCents ?? 0n).toString(),
        availableCents: ((creditAgg._sum.limitCents ?? 0n) - (creditAgg._sum.usedCents ?? 0n) - (creditAgg._sum.blockedCents ?? 0n)).toString(),
      },
      policiesCount: policiesAgg._count,
      dailyReceivedCents: (paidToday._sum.amountCents ?? 0n).toString(),
      overduePayments: overdue,
      overdueCountIndicator: defaulters,
      financialVolume,
      operationHealth,
      recentRequests: recentRequestsView,
      trackingAlerts: alertsView,
    };
  }

  // --- Clientes -------------------------------------------------------------------
  async listClients(user: AuthenticatedUser) {
    return this.prisma.user.findMany({
      where: { tenantId: user.tenantId, role: 'CLIENT' },
      include: {
        creditAccount: true,
        trackers: { select: { plate: true, vehicleModel: true, status: true } },
        creditRequests: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createClient(user: AuthenticatedUser, dto: CreateClientDto) {
    const tenantId = user.tenantId;
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { tenantId_email: { tenantId, email } } });
    if (existing) throw new BadRequestException('Já existe um usuário com esse e-mail');
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    return this.prisma.$transaction(async (tx) => {
      const client = await tx.user.create({
        data: {
          tenantId,
          role: 'CLIENT',
          status: 'ACTIVE',
          name: dto.name,
          email,
          cpfHash: dto.cpf ? createHash('sha256').update(dto.cpf.trim()).digest('hex') : undefined,
          passwordHash,
        },
      });
      if (dto.limitCents) {
        await tx.creditAccount.upsert({
          where: { userId: client.id },
          create: { userId: client.id, limitCents: BigInt(dto.limitCents) },
          update: { limitCents: BigInt(dto.limitCents) },
        });
      }
      await this.events.append({ tenantId, type: 'admin.client.created', aggregateType: 'User', aggregateId: client.id, payload: { clientId: client.id, name: client.name, createdByUserId: user.sub }, audience: ['role:ADMIN', 'role:FINANCE', 'role:SUPPORT'] }, tx);
      return client;
    });
  }

  // --- Lojistas -------------------------------------------------------------------
  async listMerchants(user: AuthenticatedUser) {
    const merchants = await this.prisma.merchant.findMany({
      where: { tenantId: user.tenantId },
      include: {
        _count: { select: { products: true, orders: true } },
        products: { select: { category: true }, take: 200 },
      },
    });
    const settled = await this.prisma.order.groupBy({
      by: ['merchantId'],
      where: { tenantId: user.tenantId, status: 'SETTLED' },
      _sum: { amountCents: true },
      _count: { _all: true },
    });
    const map = new Map(settled.map((s) => [s.merchantId, s]));
    return merchants.map((m) => {
      const s = map.get(m.id);
      const freq = new Map<string, number>();
      for (const p of m.products) freq.set(p.category, (freq.get(p.category) ?? 0) + 1);
      let segment = '';
      let best = 0;
      for (const [cat, c] of freq) if (c > best) { best = c; segment = cat; }
      const { products: _products, ...rest } = m;
      return { ...rest, segment, settledCount: s?._count._all ?? 0, settledCents: (s?._sum.amountCents ?? 0n).toString() };
    });
  }

  async createMerchant(user: AuthenticatedUser, dto: CreateMerchantDto) {
    const tenantId = user.tenantId;
    const cnpjHash = createHash('sha256').update(dto.cnpj.trim()).digest('hex');
    const existing = await this.prisma.merchant.findUnique({ where: { tenantId_cnpjHash: { tenantId, cnpjHash } } });
    if (existing) throw new BadRequestException('Já existe um lojista com esse CNPJ');
    const email = dto.email.trim().toLowerCase();
    const emailExists = await this.prisma.user.findUnique({ where: { tenantId_email: { tenantId, email } } });
    if (emailExists) throw new BadRequestException('Já existe um usuário com esse e-mail');
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    return this.prisma.$transaction(async (tx) => {
      const merchant = await tx.merchant.create({
        data: { tenantId, legalName: dto.legalName, tradeName: dto.tradeName, cnpjHash, feeBps: dto.feeBps ?? 300 },
      });
      await tx.user.create({
        data: {
          tenantId,
          merchantId: merchant.id,
          role: 'MERCHANT',
          status: 'ACTIVE',
          name: dto.contactName || dto.tradeName,
          email,
          passwordHash,
        },
      });
      await this.events.append({ tenantId, type: 'admin.merchant.created', aggregateType: 'Merchant', aggregateId: merchant.id, payload: { merchantId: merchant.id, tradeName: merchant.tradeName, createdByUserId: user.sub }, audience: ['role:ADMIN', 'role:FINANCE', 'role:SUPPORT'] }, tx);
      return merchant;
    });
  }

  // --- Financeiro -------------------------------------------------------------------
  async finance(user: AuthenticatedUser) {
    const tenantId = user.tenantId;
    const now = Date.now();
    const [receivedToday, pendingSettlements, serviceRevenue, ordersToday, settlementsAgg] = await Promise.all([
      this.prisma.payment.aggregate({ where: { tenantId, status: 'PAID', paidAt: { gte: new Date(now - DAY) } }, _sum: { amountCents: true } }),
      this.prisma.settlement.aggregate({ where: { merchant: { tenantId }, status: { in: ['PENDING', 'SCHEDULED'] } }, _count: true, _sum: { netCents: true } }),
      this.prisma.ledgerEntry.aggregate({ where: { accountCode: 'PLATFORM_FEE_REVENUE' }, _sum: { amountCents: true } }),
      this.prisma.order.count({ where: { tenantId, createdAt: { gte: new Date(now - DAY) } } }),
      this.prisma.settlement.aggregate({ where: { merchant: { tenantId } }, _sum: { grossCents: true, netCents: true } }),
    ]);
    const dailyFlow = await this.prisma.payment.groupBy({
      by: ['paidAt'],
      where: { tenantId, status: 'PAID', paidAt: { gte: new Date(now - 7 * DAY) } },
      _sum: { amountCents: true },
      orderBy: { paidAt: 'asc' },
    });
    return {
      receivedTodayCents: (receivedToday._sum.amountCents ?? 0n).toString(),
      pendingSettlementsCents: (pendingSettlements._sum.netCents ?? 0n).toString(),
      pendingSettlementsCount: pendingSettlements._count,
      serviceRevenueCents: ((serviceRevenue._sum.amountCents ?? 0n) < 0n ? -(serviceRevenue._sum.amountCents ?? 0n) : (serviceRevenue._sum.amountCents ?? 0n)).toString(),
      ordersToday,
      totalGrossCents: (settlementsAgg._sum.grossCents ?? 0n).toString(),
      totalNetCents: (settlementsAgg._sum.netCents ?? 0n).toString(),
      dailyFlow: dailySeries(now, 7).map((slot) => ({
        day: slot.label,
        cents: dailyFlow.filter((r) => r.paidAt && r.paidAt >= slot.start && r.paidAt < slot.end).reduce((a, r) => a + (r._sum.amountCents ?? 0n), 0n).toString(),
      })),
    };
  }

  audit(user: AuthenticatedUser) {
    return this.prisma.auditLog.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 500, include: { actor: { select: { name: true, email: true, role: true } } } });
  }
  outboxEvents(user: AuthenticatedUser) {
    return this.prisma.outboxEvent.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 200 });
  }
}

// Helpers de série temporal (últimos N meses / N dias) com rótulo.
function monthlySeries(now: number, months: number) {
  const pts: Array<{ start: Date; end: Date; label: string }> = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now - i * 30 * DAY);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const label = start.toLocaleDateString('pt-BR', { month: 'short' });
    pts.push({ start, end, label });
  }
  return pts;
}
function dailySeries(now: number, days: number) {
  const pts: Array<{ start: Date; end: Date; label: string }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(start.getTime() + DAY);
    pts.push({ start, end, label: start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) });
  }
  return pts;
}
function pct(part: number, total: number) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}
