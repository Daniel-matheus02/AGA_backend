/**
 * Cerca digital — lógica de transição e isolamento por tenant.
 *
 * O que estes testes protegem:
 *  1. O alerta dispara apenas na TRANSIÇÃO dentro↔fora. Se isto regredir, um
 *     veículo estacionado dentro da cerca gera um alerta por ping de GPS.
 *  2. Toda operação de cerca filtra por tenantId. Sem isto, um UUID adivinhado
 *     apaga a cerca de outro cliente.
 *  3. `evaluateGeofences` usa o client da TRANSAÇÃO (tx), nunca this.prisma.
 */
import { TrackingService } from '../src/tracking/tracking.service';
import { AuthenticatedUser } from '../src/common/auth.types';
import { BadRequestException } from '@nestjs/common';

// Quadrado em torno de Manaus.
const SQUARE = [
  { lat: -3.10, lng: -60.05 },
  { lat: -3.20, lng: -60.05 },
  { lat: -3.20, lng: -59.95 },
  { lat: -3.10, lng: -59.95 },
];
const INSIDE = { lat: -3.15, lng: -60.0 };
const OUTSIDE = { lat: -3.9, lng: -60.0 };

const TRACKER = { id: 'trk-1', tenantId: 'tenant-1', userId: 'user-1', plate: 'ABC1234' };

function admin(tenantId = 'tenant-1'): AuthenticatedUser {
  return { sub: 'user-1', tenantId, role: 'ADMIN', sessionId: 's1', email: 'a@a.com' } as AuthenticatedUser;
}

/**
 * Prisma falso. Registra quem foi chamado para que possamos provar que a
 * transação recebeu as consultas (e que this.prisma não foi tocado no caminho
 * da ingestão).
 */
function fakeTx(opts: {
  fences?: any[];
  states?: any[];
  geofence?: any;
  createdAlerts?: any[];
}) {
  const calls: string[] = [];
  const alertsCreated: any[] = [];
  const upserts: any[] = [];
  const tx = {
    geofence: {
      findMany: async (args: any) => {
        calls.push('geofence.findMany');
        expect(args.where.tenantId).toBe(TRACKER.tenantId);
        expect(args.where.active).toBe(true);
        return opts.fences ?? [];
      },
      findFirst: async (args: any) => {
        calls.push('geofence.findFirst');
        return opts.geofence ?? null;
      },
      create: async (args: any) => {
        calls.push('geofence.create');
        return { id: 'new-1', ...args.data };
      },
      delete: async (args: any) => {
        calls.push('geofence.delete');
        return { id: args.where.id };
      },
    },
    trackerGeofenceState: {
      findMany: async (args: any) => {
        calls.push('state.findMany');
        // Precisa ser UMA consulta em batch, não uma por cerca.
        expect(Array.isArray(args.where.geofenceId.in)).toBe(true);
        return opts.states ?? [];
      },
      updateMany: async (args: any) => {
        calls.push('state.updateMany');
        // Só casa se o estado anterior for o oposto do novo (conditional update).
        const prior = (opts.states ?? []).find((s: any) => s.geofenceId === args.where.geofenceId);
        const matches = prior && prior.isInside === args.where.isInside;
        if (matches) { upserts.push(args); return { count: 1 }; }
        return { count: 0 };
      },
      findUnique: async (args: any) => {
        calls.push('state.findUnique');
        const prior = (opts.states ?? []).find((s: any) => s.geofenceId === args.where.trackerId_geofenceId.geofenceId);
        return prior ? { trackerId: prior.geofenceId } : null;
      },
      createMany: async (args: any) => {
        calls.push('state.createMany');
        // ON CONFLICT DO NOTHING: só cria se a linha (trackerId, geofenceId) não
        // existir. Não aborta a transação numa corrida perdida.
        const data = args.data ?? [];
        const fresh = data.filter(
          (d: any) => !(opts.states ?? []).some((s: any) => s.geofenceId === d.geofenceId),
        );
        if (fresh.length) upserts.push({ create: fresh[0] });
        return { count: fresh.length };
      },
    },
    trackingAlert: {
      create: async (args: any) => {
        calls.push('alert.create');
        const row = { id: 'alert-' + (alertsCreated.length + 1), ...args.data };
        alertsCreated.push(row);
        return row;
      },
    },
  };
  return { tx, calls, alertsCreated, upserts };
}

function buildService(tx: any, prismaSpy?: any) {
  const events = { append: jest.fn(async () => ({})) };
  const prisma = prismaSpy ?? { $transaction: async (fn: any) => fn(tx) };
  const service = new TrackingService(prisma as any, events as any, { getOrThrow: () => 'secret' } as any);
  return { service, events };
}

describe('cerca digital — evaluateGeofences (via service)', () => {
  // evaluateGeofences é privado: é o contrato interno que a ingestão usa.
  const call = (service: TrackingService, tx: any, point: any = INSIDE) =>
    (service as any).evaluateGeofences(tx, TRACKER, point);

  it('primeiro ping dentro da cerca gera alerta de ENTRADA', async () => {
    const { tx, alertsCreated, upserts } = fakeTx({
      fences: [{ id: 'g1', name: 'Centro', vertices: SQUARE }],
      states: [], // nenhum estado anterior => era "fora"
    });
    const { service } = buildService(tx);

    const result = await call(service, tx);

    expect(alertsCreated).toHaveLength(1);
    expect(alertsCreated[0].type).toBe('GEOFENCE_ENTER');
    expect(alertsCreated[0].trackerId).toBe('trk-1');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].create.isInside).toBe(true);
    expect(result.transitions).toHaveLength(1);
  });

  it('NÃO repete o alerta enquanto o veículo continua dentro (sem regressão de spam)', async () => {
    const { tx, alertsCreated, upserts } = fakeTx({
      fences: [{ id: 'g1', name: 'Centro', vertices: SQUARE }],
      states: [{ geofenceId: 'g1', isInside: true }], // já estava dentro
    });
    const { service } = buildService(tx);

    const result = await call(service, tx);

    expect(alertsCreated).toHaveLength(0);
    expect(upserts).toHaveLength(0); // nenhuma escrita quando nada mudou
    expect(result.transitions).toHaveLength(0);
  });

  it('saída da cerca gera alerta de SAÍDA', async () => {
    const { tx, alertsCreated } = fakeTx({
      fences: [{ id: 'g1', name: 'Centro', vertices: SQUARE }],
      states: [{ geofenceId: 'g1', isInside: true }],
    });
    const { service } = buildService(tx);

    await call(service, tx, OUTSIDE);

    expect(alertsCreated).toHaveLength(1);
    expect(alertsCreated[0].type).toBe('GEOFENCE_EXIT');
    expect(alertsCreated[0].message).toContain('saiu');
  });

  it('veículo fora e que continua fora não gera alerta', async () => {
    const { tx, alertsCreated } = fakeTx({
      fences: [{ id: 'g1', name: 'Centro', vertices: SQUARE }],
      states: [{ geofenceId: 'g1', isInside: false }],
    });
    const { service } = buildService(tx);

    const result = await call(service, tx, OUTSIDE);

    expect(alertsCreated).toHaveLength(0);
    expect(result.transitions).toHaveLength(0);
  });

  it('usa consultas em lote: 1 findMany de cercas + 1 findMany de estados', async () => {
    const { tx, calls } = fakeTx({
      fences: [
        { id: 'g1', name: 'A', vertices: SQUARE },
        { id: 'g2', name: 'B', vertices: SQUARE },
        { id: 'g3', name: 'C', vertices: SQUARE },
      ],
      states: [],
    });
    const { service } = buildService(tx);

    await call(service, tx);

    // Independente de haver 3 cercas, cada findMany roda UMA vez: é isso que
    // evita o N+1 por ping.
    expect(calls.filter((c) => c === 'geofence.findMany')).toHaveLength(1);
    expect(calls.filter((c) => c === 'state.findMany')).toHaveLength(1);
  });

  it('não consulta estados quando o tenant não tem cerca ativa', async () => {
    const { tx, calls } = fakeTx({ fences: [] });
    const { service } = buildService(tx);

    const result = await call(service, tx);

    expect(result.transitions).toHaveLength(0);
    expect(calls).not.toContain('state.findMany');
  });

  it('ignora cerca com Json corrompido sem derrubar a ingestão', async () => {
    const { tx, alertsCreated } = fakeTx({
      fences: [
        { id: 'g1', name: 'Corrompida', vertices: 'nao-e-poligono' },
        { id: 'g2', name: 'Boa', vertices: SQUARE },
      ],
      states: [],
    });
    const { service } = buildService(tx);

    const result = await call(service, tx);

    // Só a cerca válida produz alerta.
    expect(alertsCreated).toHaveLength(1);
    expect(result.transitions).toHaveLength(1);
  });

  it('avalia várias cercas e só alerta as que mudaram', async () => {
    const { tx, alertsCreated, upserts } = fakeTx({
      fences: [
        { id: 'g1', name: 'Entrando', vertices: SQUARE },
        { id: 'g2', name: 'Já dentro', vertices: SQUARE },
      ],
      states: [{ geofenceId: 'g2', isInside: true }],
    });
    const { service } = buildService(tx);

    const result = await call(service, tx);

    expect(result.transitions).toHaveLength(1);
    expect(alertsCreated).toHaveLength(1);
    expect(upserts).toHaveLength(1);
    // g1 não tinha estado anterior: é criado (não atualizado).
    expect(upserts[0].create.geofenceId).toBe('g1');
    expect(upserts[0].create.isInside).toBe(true);
  });

  it('não alerta quando o update condicional não casa (corrida perdida)', async () => {
    // Simula o outro webhook já tendo gravado isInside=true: o updateMany
    // condicional em isInside=false devolve count 0 e o createMany com
    // skipDuplicates também não cria nada, então esta transação NÃO deve criar
    // alerta duplicado — e, crucialmente, não aborta a transação.
    const { tx, alertsCreated } = fakeTx({
      fences: [{ id: 'g1', name: 'Centro', vertices: SQUARE }],
      states: [{ geofenceId: 'g1', isInside: true }],
    });
    const { service } = buildService(tx);

    // wasInside=false (nenhum estado lido no findMany) mas a linha já existe.
    (tx.trackerGeofenceState.findMany as any) = async () => [];
    (tx.trackerGeofenceState.updateMany as any) = async () => ({ count: 0 });

    const result = await call(service, tx);

    expect(result.transitions).toHaveLength(0);
    expect(alertsCreated).toHaveLength(0);
  });

  it('devolve alerts com o alertId de cada transição', async () => {
    const { tx } = fakeTx({
      fences: [
        { id: 'g1', name: 'A', vertices: SQUARE },
        { id: 'g2', name: 'B', vertices: SQUARE },
      ],
      states: [],
    });
    const { service } = buildService(tx);

    const result = await call(service, tx);

    expect(result.alerts).toHaveLength(2);
    expect(result.alerts[0].alertId).not.toBe(result.alerts[1].alertId);
    expect(result.alerts[0].geofenceId).not.toBe(result.alerts[1].geofenceId);
  });
});

describe('cerca digital — isolamento por tenant', () => {
  it('listGeofences filtra pelo tenant do usuário', async () => {
    const calls: any[] = [];
    const prisma = {
      geofence: { findMany: async (args: any) => { calls.push(args); return []; } },
    };
    const { service } = buildService(null, prisma);

    await service.listGeofences(admin('tenant-9'));

    expect(calls[0].where).toEqual({ tenantId: 'tenant-9' });
  });

  it('createGeofence grava com o tenant do usuário, não com um valor do body', async () => {
    const calls: any[] = [];
    const prisma = {
      geofence: {
        count: async () => 0,
        create: async (args: any) => { calls.push(args); return args.data; },
      },
    };
    const { service } = buildService(null, prisma);

    await service.createGeofence(admin('tenant-9'), {
      name: 'Cerca',
      vertices: SQUARE,
    } as any);

    expect(calls[0].data.tenantId).toBe('tenant-9');
  });

  it('createGeofence recusa quando o tenant já atingiu o teto de cercas', async () => {
    const created: any[] = [];
    const prisma = {
      geofence: {
        count: async (args: any) => {
          expect(args.where).toEqual({ tenantId: 'tenant-1' });
          return 200; // teto atingido
        },
        create: async (args: any) => { created.push(args); return args.data; },
      },
    };
    const { service } = buildService(null, prisma);

    await expect(
      service.createGeofence(admin('tenant-1'), { name: 'Cerca', vertices: SQUARE } as any),
    ).rejects.toThrow(/Limite/);
    expect(created).toHaveLength(0);
  });

  it('createGeofence normaliza os vértices antes de gravar', async () => {
    const calls: any[] = [];
    const prisma = {
      geofence: {
        count: async () => 0,
        create: async (args: any) => { calls.push(args); return args.data; },
      },
    };
    const { service } = buildService(null, prisma);

    // Vem com o ponto de fecho duplicado: deve ser removido na gravação.
    await service.createGeofence(admin(), {
      name: 'Cerca',
      vertices: [...SQUARE, SQUARE[0]],
    } as any);

    expect(calls[0].data.vertices).toHaveLength(4);
  });

  it('createGeofence devolve 400 (não 500) para polígono degenerado', async () => {
    const prisma = {
      geofence: {
        count: async () => 0,
        create: async () => { throw new Error('não deveria gravar'); },
      },
    };
    const { service } = buildService(null, prisma);

    // [A,B,A]: passa no ArrayMinSize(3) do DTO mas sobra com 2 vértices distintos.
    await expect(
      service.createGeofence(admin(), {
        name: 'Cerca',
        vertices: [SQUARE[0], SQUARE[1], SQUARE[0]],
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('deleteGeofence recusa cerca de outro tenant (404, sem apagar)', async () => {
    const deleted: any[] = [];
    const prisma = {
      // findFirst com tenantId errado não encontra nada.
      geofence: {
        findFirst: async () => null,
        delete: async (args: any) => { deleted.push(args); return {}; },
      },
    };
    const { service } = buildService(null, prisma);

    await expect(service.deleteGeofence(admin('tenant-9'), 'fence-de-outro')).rejects.toThrow('Geofence not found');
    expect(deleted).toHaveLength(0);
  });

  it('deleteGeofence apaga depois de confirmar o tenant', async () => {
    const deleted: any[] = [];
    const prisma = {
      geofence: {
        findFirst: async (args: any) => {
          // A checagem de tenant precisa estar na consulta.
          expect(args.where).toEqual({ id: 'g1', tenantId: 'tenant-1' });
          return { id: 'g1' };
        },
        delete: async (args: any) => { deleted.push(args); return {}; },
      },
    };
    const { service } = buildService(null, prisma);

    const result = await service.deleteGeofence(admin('tenant-1'), 'g1');

    expect(deleted[0].where).toEqual({ id: 'g1' });
    expect(result.deleted).toBe(true);
  });
});
