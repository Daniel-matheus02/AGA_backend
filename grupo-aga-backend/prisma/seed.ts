import 'dotenv/config';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const must = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for seed`);
  return value;
};
const hash = (value: string) => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: must('DATABASE_URL') }) });

const DAY = 86400_000;
const MONTH = 30 * DAY;

// Conjuntos determinísticos de dados de demonstração (idempotentes via upsert).
const MERCHANTS = [
  { legalName: 'Rota Norte Serviços Automotivos LTDA', tradeName: 'Auto Center Rota Norte', cnpj: '12.345.678/0001-90', feeBps: 300, segment: 'Manutenção' },
  { legalName: 'Moto Peças Central EIRELI', tradeName: 'Moto Peças Central', cnpj: '23.456.789/0001-01', feeBps: 350, segment: 'Peças' },
  { legalName: 'Mercado Bom Preço LTDA', tradeName: 'Mercado Bom Preço', cnpj: '34.567.890/0001-12', feeBps: 250, segment: 'Alimentação' },
  { legalName: 'Oficina Turbo Express ME', tradeName: 'Oficina Turbo Express', cnpj: '45.678.901/0001-23', feeBps: 400, segment: 'Serviços' },
  { legalName: 'Posto Estrada Azul SA', tradeName: 'Posto Estrada Azul', cnpj: '56.789.112/0001-34', feeBps: 320, segment: 'Mobilidade' },
];

// Categorias e produtos por lojista.
const PRODUCTS: Array<[string, string, string, number]> = [
  // [name, category, merchantTradeName, priceCents]
  ['Troca de óleo premium', 'Manutenção', 'Auto Center Rota Norte', 7990],
  ['Revisão preventiva 10k km', 'Manutenção', 'Auto Center Rota Norte', 14990],
  ['Alinhamento e balanceamento', 'Manutenção', 'Auto Center Rota Norte', 5990],
  ['Kit relação completo', 'Peças', 'Moto Peças Central', 21990],
  ['Bateria 12V', 'Peças', 'Moto Peças Central', 18990],
  ['Retrovisor original', 'Peças', 'Moto Peças Central', 4900],
  ['Pneu traseiro 130/70', 'Peças', 'Moto Peças Central', 24990],
  ['Cesta básica família', 'Alimentação', 'Mercado Bom Preço', 12990],
  ['Cestão 32 itens', 'Alimentação', 'Mercado Bom Preço', 11990],
  ['Kit feijão + arroz 10kg', 'Alimentação', 'Mercado Bom Preço', 8990],
  ['Troca de pastilhas de freio', 'Serviços', 'Oficina Turbo Express', 6990],
  ['Serviço de eletricidade', 'Serviços', 'Oficina Turbo Express', 15990],
  ['Lavagem completa', 'Serviços', 'Oficina Turbo Express', 3900],
  ['Abastecimento R$ 50', 'Mobilidade', 'Posto Estrada Azul', 5000],
  ['Abastecimento R$ 100', 'Mobilidade', 'Posto Estrada Azul', 10000],
];

// Clientes de demonstração: [nome, email, cpf]
const CLIENTS: Array<[string, string, string]> = [
  ['Gabriel Silva', 'cliente@aga.local', '992.950.592-04'],
  ['Marcos Lima', 'marcos.lima@example.com', '841.220.318-30'],
  ['Renata Souza', 'renata.souza@example.com', '752.431.009-21'],
  ['Paulo Nunes', 'paulo.nunes@example.com', '663.542.100-12'],
  ['Juliana Castro', 'juliana.castro@example.com', '574.653.211-03'],
  ['Carlos Menezes', 'carlos.menezes@example.com', '987.654.321-09'],
];

// Modelos de moto por cliente (usados p/ vínculo de rastreador).
const VEHICLES: Array<[string, string]> = [
  ['Honda CG 160', 'QZA-4A21'],
  ['Yamaha Factor 150', 'QZB-9D28'],
  ['Honda Biz 125', 'QZA-6C14'],
  ['Honda Bros 160', 'QZB-7E31'],
  ['Yamaha Fazer 150', 'QZB-8G92'],
  ['Honda Pop 110', 'QZA-9H10'],
];

const MANAUS = [
  { lat: -3.119, lng: -60.021 }, // Centro
  { lat: -3.0742, lng: -60.0171 }, // S. Jorge
  { lat: -3.0333, lng: -60.0333 }, // Cidade Nova
  { lat: -3.0879, lng: -60.0262 }, // Adrianópolis
  { lat: -3.1051, lng: -60.0461 }, // Bairro da Paz
  { lat: -3.0556, lng: -59.9912 }, // Aleixo
];

function rnd(seed: number) {
  const x = Math.sin(seed * 999.7) * 10000;
  return x - Math.floor(x);
}

async function ensureUsersAndMerchants() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'grupo-aga' },
    update: { name: 'Grupo AGA', active: true },
    create: { name: 'Grupo AGA', slug: 'grupo-aga' },
  });

  // Lojistas + produtos.
  const merchantRows: Array<{ id: string; tradeName: string; feeBps: number }> = [];
  for (const m of MERCHANTS) {
    const row = await prisma.merchant.upsert({
      where: { tenantId_cnpjHash: { tenantId: tenant.id, cnpjHash: hash(m.cnpj) } },
      update: { active: true, tradeName: m.tradeName, feeBps: m.feeBps },
      create: { tenantId: tenant.id, legalName: m.legalName, tradeName: m.tradeName, cnpjHash: hash(m.cnpj), feeBps: m.feeBps },
    });
    merchantRows.push(row);
  }
  const merchantByTrade = Object.fromEntries(merchantRows.map((r) => [r.tradeName, r]));

  // Produtos.
  for (const [name, category, tradeName, priceCents] of PRODUCTS) {
    const m = merchantByTrade[tradeName];
    const found = await prisma.product.findFirst({ where: { tenantId: tenant.id, merchantId: m.id, name } });
    if (!found) {
      await prisma.product.create({
        data: { tenantId: tenant.id, merchantId: m.id, name, category, priceCents: BigInt(priceCents), description: `Oferta demonstrativa: ${name}` },
      });
    }
  }

  // Senhas.
  const [adminHash, merchantHash, clientHash] = await Promise.all([
    argon2.hash(must('SEED_ADMIN_PASSWORD'), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }),
    argon2.hash(must('SEED_MERCHANT_PASSWORD'), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }),
    argon2.hash(must('SEED_CLIENT_PASSWORD'), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }),
  ]);

  // Admin.
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: must('SEED_ADMIN_EMAIL').toLowerCase() } },
    update: { passwordHash: adminHash, status: 'ACTIVE' },
    create: { tenantId: tenant.id, role: 'ADMIN', status: 'ACTIVE', name: 'Administrador AGA', email: must('SEED_ADMIN_EMAIL').toLowerCase(), passwordHash: adminHash },
  });
  // Papel de apoio.
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'suporte@aga.local' } },
    update: { passwordHash: adminHash, status: 'ACTIVE' },
    create: { tenantId: tenant.id, role: 'SUPPORT', status: 'ACTIVE', name: 'Paula Suporte', email: 'suporte@aga.local', passwordHash: adminHash },
  });
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'financeiro@aga.local' } },
    update: { passwordHash: adminHash, status: 'ACTIVE' },
    create: { tenantId: tenant.id, role: 'FINANCE', status: 'ACTIVE', name: 'Fábio Financeiro', email: 'financeiro@aga.local', passwordHash: adminHash },
  });

  // Um usuário lojista por lojista.
  for (let i = 0; i < MERCHANTS.length; i++) {
    const email = `lojista${i + 1}@aga.local`;
    const m = merchantRows[i];
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email } },
      update: { passwordHash: merchantHash, status: 'ACTIVE', merchantId: m.id },
      create: { tenantId: tenant.id, merchantId: m.id, role: 'MERCHANT', status: 'ACTIVE', name: `Lojista ${m.tradeName}`, email, passwordHash: merchantHash },
    });
  }

  // Clientes + contas + rastreadores + políticas.
  const clientRows: Array<{ id: string; name: string; limitCents: number }> = [];
  for (let i = 0; i < CLIENTS.length; i++) {
    const [name, emailRaw, cpf] = CLIENTS[i];
    const email = emailRaw.toLowerCase();
    const isSeedClient = email === 'cliente@aga.local';
    const u = await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email } },
      update: { passwordHash: isSeedClient ? clientHash : adminHash, status: 'ACTIVE' },
      create: { tenantId: tenant.id, role: 'CLIENT', status: 'ACTIVE', name, email, cpfHash: hash(cpf), passwordHash: isSeedClient ? clientHash : adminHash },
    });
    const limitCents = 600000 - i * 70000;
    await prisma.creditAccount.upsert({
      where: { userId: u.id },
      update: { limitCents: BigInt(limitCents) },
      create: { userId: u.id, limitCents: BigInt(limitCents), usedCents: BigInt(Math.round(limitCents * (0.15 - 0.02 * i))) },
    });
    clientRows.push({ id: u.id, name, limitCents });
  }
  return { tenant, clientRows, merchantRows, merchantByTrade };
}

async function seedTrackers(tenantId: string, clients: Array<{ id: string; name: string }>) {
  for (let i = 0; i < clients.length; i++) {
    const [model, plate] = VEHICLES[i % VEHICLES.length];
    const pos = MANAUS[i % MANAUS.length];
    const battery = 78 + Math.round(rnd(i + 1) * 18);
    const status = i % 5 === 3 ? 'MAINTENANCE' : i % 6 === 5 ? 'OFFLINE' : 'ONLINE';
    const lastSeen = new Date(Date.now() - (i % 4) * DAY - Math.round(rnd(i + 2) * 3600_000));
    const externalId = `AGA-${7800 + i}`;
    const tracker = await prisma.tracker.upsert({
      where: { externalId },
      update: { userId: clients[i].id, status: status as any, lastSeenAt: lastSeen, lastLatitude: String(pos.lat), lastLongitude: String(pos.lng), lastSpeedKph: status === 'ONLINE' ? String(Math.round(rnd(i + 3) * 45)) : '0', batteryPct: battery },
      create: { tenantId, userId: clients[i].id, externalId, plate, vehicleModel: model, status: status as any, lastSeenAt: lastSeen, lastLatitude: String(pos.lat), lastLongitude: String(pos.lng), lastSpeedKph: status === 'ONLINE' ? String(Math.round(rnd(i + 3) * 45)) : '0', batteryPct: battery },
    });
    const pointCount = await prisma.trackingPoint.count({ where: { trackerId: tracker.id } });
    if (pointCount === 0) {
      await prisma.trackingPoint.create({
        data: { trackerId: tracker.id, latitude: String(pos.lat), longitude: String(pos.lng), speedKph: String(Math.round(rnd(i + 3) * 45)), batteryPct: battery, ignitionOn: true, recordedAt: lastSeen },
      });
    }
  }
}

async function seedFinancialHistory(tenantId: string, clients: Array<{ id: string; name: string; limitCents: number }>) {
  // Pedidos/marketplace ao longo dos últimos 6 meses para volume financeiro.
  const products = await prisma.product.findMany({ where: { tenantId } });
  const product = (cat: string) => products.filter((p) => p.category === cat)[0] || products[0];

  const now = Date.now();
  // Recebimentos diários (payments paid) nos últimos 7 dias por cliente.
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const paidCount = await prisma.payment.count({ where: { tenantId, userId: c.id, status: 'PAID' } });
    if (paidCount > 0) continue;
    const daily = 4930 + i * 700;
    const past30 = await prisma.payment.count({
      where: { tenantId, userId: c.id, paidAt: { gte: new Date(now - 30 * DAY) } },
    });
    if (past30 > 0) continue;
    const rows = Array.from({ length: 10 }, (_, j) => {
      const due = new Date(now + (j + 1) * DAY);
      const paid = rnd(i * 10 + j) < 0.7;
      return {
        tenantId,
        userId: c.id,
        amountCents: BigInt(daily),
        dueDate: new Date(due.getTime() - 5 * DAY),
        paidAt: paid ? new Date(Math.min(now, due.getTime() - 5 * DAY)) : null,
        status: (paid ? 'PAID' : 'PENDING') as any,
        createdAt: new Date(now - (j % 5) * DAY),
      };
    });
    await prisma.payment.createMany({ data: rows });
  }

  // Volume financeiro nos últimos 6 meses: pedidos autorizados/quitados.
  for (let m = 5; m >= 0; m--) {
    const monthStart = new Date(now - m * MONTH);
    const monthEnd = new Date(monthStart.getTime() + MONTH);
    const created = new Date(monthStart.getTime() + Math.round(rnd(m + 40) * 15 * DAY));
    // Já existe pedido criado nesse mês (idempotência)? Pula o mês.
    const monthHasOrders = await prisma.order.count({ where: { tenantId, createdAt: { gte: monthStart, lt: monthEnd } } });
    if (monthHasOrders > 0) continue;
    for (let i = 0; i < clients.length; i += (m % 2) + 1) {
      const merchant = products[Math.floor(rnd(m * 7 + i) * products.length)];
      if (!merchant) continue;
      const status = m > 1 ? 'SETTLED' : rnd(m + i) < 0.5 ? 'AUTHORIZED' : 'SETTLED';
      const fee = merchant.priceCents * BigInt(300) / 10000n;
      const net = merchant.priceCents - fee;
      const order = await prisma.order.create({
        data: {
          tenantId,
          clientId: clients[i].id,
          merchantId: merchant.merchantId,
          productId: merchant.id,
          amountCents: merchant.priceCents,
          feeCents: fee,
          netCents: net,
          status: status as any,
          authorizationExpiresAt: created,
          authorizedAt: created,
          createdAt: created,
        },
      });
      await prisma.settlement.create({
        data: { merchantId: merchant.merchantId, orderId: order.id, grossCents: merchant.priceCents, feeCents: fee, netCents: net, scheduledFor: new Date(created.getTime() + DAY), paidAt: status === 'SETTLED' ? new Date(created.getTime() + DAY) : null, status: (status === 'SETTLED' ? 'PAID' : 'PENDING') as any, createdAt: created },
      });
      const ledger = await prisma.ledgerTransaction.create({
        data: { referenceType: 'ORDER', referenceId: order.id, description: `Marketplace order ${order.id}` },
      });
      await prisma.ledgerEntry.createMany({
        data: [
          { transactionId: ledger.id, accountCode: `CLIENT_RECEIVABLE:${clients[i].id}`, amountCents: merchant.priceCents },
          { transactionId: ledger.id, accountCode: `MERCHANT_PAYABLE:${merchant.merchantId}`, amountCents: -net },
          { transactionId: ledger.id, accountCode: 'PLATFORM_FEE_REVENUE', amountCents: -fee },
        ],
      });
    }
  }

  // Fila de análise de crédito (algumas pendentes/em análise).
  const pendingCount = await prisma.creditRequest.count({ where: { tenantId, status: { in: ['PENDING', 'UNDER_REVIEW'] } } });
  if (pendingCount === 0) {
    const sources = [
      { user: clients[0], amount: 250000, inst: 30, status: 'UNDER_REVIEW' },
      { user: clients[1], amount: 180000, inst: 25, status: 'PENDING' },
      { user: clients[2], amount: 320000, inst: 40, status: 'PENDING' },
    ];
    for (const s of sources) {
      const daily = (s.amount * 11800 + 9999) / 10000;
      await prisma.creditRequest.create({
        data: {
          tenantId,
          userId: s.user.id,
          amountCents: BigInt(s.amount),
          dailyInstallments: s.inst,
          dailyAmountCents: BigInt(Math.round(daily / s.inst)),
          status: s.status as any,
          createdAt: new Date(now - Math.round(rnd(s.user.name.length) * 3 * DAY)),
        },
      });
    }
  }
}

async function seedAlerts(tenantId: string) {
  const trackers = await prisma.tracker.findMany({ where: { tenantId }, take: 10 });
  const alertCount = await prisma.trackingAlert.count({ where: { tracker: { tenantId } } });
  if (alertCount > 0) return;
  for (let i = 0; i < trackers.length; i++) {
    if (i % 2 !== 0) continue;
    const type = i % 3 === 0 ? 'EXCESSIVE_SPEED' : i % 3 === 1 ? 'DEVICE_OFFLINE' : 'GEOFENCE_EXIT';
    const sev = (i % 3 === 0 ? 'WARNING' : i % 3 === 1 ? 'CRITICAL' : 'INFO') as any;
    const msg = type === 'EXCESSIVE_SPEED' ? `Velocidade acima do limite operacional` : type === 'DEVICE_OFFLINE' ? 'Rastreador sem sinal há mais de 15 minutos' : 'Veículo saiu da área habitual';
    await prisma.trackingAlert.create({
      data: { trackerId: trackers[i].id, type, severity: sev, message: msg, createdAt: new Date(Date.now() - i * 3600_000) },
    });
  }
}

async function seedPolicies(tenantId: string) {
  const trackers = await prisma.tracker.findMany({ where: { tenantId, status: { not: 'OFFLINE' } } });
  let created = 0;
  for (let i = 0; i < trackers.length; i++) {
    const ref = `AGA-POL-${1000 + i}`;
    const exists = await prisma.insurancePolicy.findUnique({ where: { providerReference: ref } });
    if (exists) continue;
    await prisma.insurancePolicy.create({
      data: {
        tenantId,
        userId: trackers[i].userId,
        trackerId: trackers[i].id,
        provider: 'SEGURADORA_AGA',
        providerReference: ref,
        status: (i % 6 === 4 ? 'SUSPENDED' : 'ACTIVE') as any,
        coverage: { collision: true, theft: true, robbery: true, thirdParty: true, assistance24h: true },
        startsAt: new Date(Date.now() - 120 * DAY),
        endsAt: new Date(Date.now() + 245 * DAY),
        createdAt: new Date(Date.now() - 120 * DAY),
      },
    });
    created++;
  }
  console.log('  políticas criadas:', created);
}

async function main() {
  const { tenant, clientRows } = await ensureUsersAndMerchants();
  await seedTrackers(tenant.id, clientRows);
  await seedFinancialHistory(tenant.id, clientRows);
  await seedAlerts(tenant.id);
  await seedPolicies(tenant.id);

  const summary = {
    tenant: tenant.slug,
    clients: await prisma.user.count({ where: { tenantId: tenant.id, role: 'CLIENT' } }),
    merchants: await prisma.merchant.count({ where: { tenantId: tenant.id } }),
    products: await prisma.product.count({ where: { tenantId: tenant.id } }),
    orders: await prisma.order.count({ where: { tenantId: tenant.id } }),
    payments: await prisma.payment.count({ where: { tenantId: tenant.id } }),
    trackers: await prisma.tracker.count({ where: { tenantId: tenant.id } }),
    policies: await prisma.insurancePolicy.count({ where: { tenantId: tenant.id } }),
    alerts: await prisma.trackingAlert.count({ where: { tracker: { tenantId: tenant.id } } }),
  };
  console.log('Seed concluído:', summary);
}

main().finally(() => prisma.$disconnect());
