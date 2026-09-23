import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { AuthenticatedUser } from '../common/auth.types';
import { TrackingIngestDto, CreateGeofenceDto, UpdateGeofenceDto } from './dto';
import { isPointInPolygon, normalizePolygon, readPolygonFromJson, GeoVertex } from './geo';

// Teto de cercas por tenant. Cada cerca ativa é reavaliada a cada ping de GPS de
// cada veículo do tenant, por isso o limite protege o custo da ingestão.
const MAX_GEOFENCES_PER_TENANT = 200;

/**
 * Converte um valor `Decimal` do Prisma em número, ou `null` se não for finito.
 *
 * Por que isto existe: `Tracker.lastLatitude/lastLongitude/lastSpeedKph` são
 * colunas `Decimal` e o `fleet()` devolve a linha crua do Prisma. O `Decimal` do
 * Prisma é uma instância de classe e o `JSON.stringify` chama o `toJSON()` dela,
 * produzindo uma STRING (`"3.0742"`). Converter aqui mantém o contrato do
 * endpoint explícito: `latitude`/`longitude`/`speedKph` saem como NÚMERO.
 *
 * ATENÇÃO — não troque isto por spread (`{...t}`): o spread copia apenas as
 * propriedades PRÓPRIAS do `Decimal` (`s`, `e`, `d`) e descarta o protótipo onde
 * vivem `toString`/`toNumber`/`toJSON`. O resultado é um object literal
 * `{"s":-1,"e":0,"d":[3,742000]}` que o `Number()` do frontend converte em `NaN`
 * — e o mapa do rastreamento fica vazio com a base cheia de posições válidas.
 * Sempre chamar um MÉTODO do Decimal, nunca copiar as suas propriedades.
 */
function decimalToNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    const parsed = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  // Já vem número/string (ex.: campo não-Decimal): aceita e valida.
  const parsed = Number(value as number | string);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class TrackingService{
  constructor(private readonly prisma:PrismaService,private readonly events:EventsService,private readonly config:ConfigService){}

  private verify(rawBody:Buffer|undefined,timestamp:string|undefined,signature:string|undefined){
    if(!rawBody||!timestamp||!signature) throw new UnauthorizedException('Missing webhook signature headers');
    const ts=Number(timestamp);
    if(!Number.isFinite(ts)||Math.abs(Date.now()-ts*1000)>5*60_000) throw new UnauthorizedException('Webhook timestamp outside allowed window');
    const expected=createHmac('sha256',this.config.getOrThrow<string>('TRACKING_WEBHOOK_SECRET')).update(`${timestamp}.`).update(rawBody).digest('hex');
    const supplied=signature.replace(/^sha256=/,'');
    if(!/^[a-f0-9]{64}$/i.test(supplied)||!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(supplied,'hex'))) throw new UnauthorizedException('Invalid webhook signature');
  }

  /**
   * Avalia todas as cercas ativas do tenant para o ponto recebido e registra
   * apenas as TRANSIÇÕES dentro↔fora.
   *
   * Roda dentro da transação do webhook, por isso recebe `tx` e nunca
   * `this.prisma` — usar o client global aqui abriria uma conexão fora da
   * transação, perdendo o rollback em caso de falha.
   *
   * Evita N+1 com duas consultas em lote (cercas do tenant + estados deste
   * rastreador) em vez de um par find/upsert por cerca. O caso comum — o veículo
   * não cruzou nenhuma borda — não escreve nada no banco.
   */
  private async evaluateGeofences(
    tx: Prisma.TransactionClient,
    tracker: { id: string; tenantId: string; userId: string; plate: string },
    point: { lat: number; lng: number },
  ): Promise<{ alertId?: string; transitions: { geofenceId: string; type: string }[]; alerts: { alertId: string; geofenceId: string; type: string }[] }> {
    const fences = await tx.geofence.findMany({
      where: { tenantId: tracker.tenantId, active: true },
      select: { id: true, name: true, vertices: true },
    });
    if (!fences.length) return { transitions: [], alerts: [] };

    const states = await tx.trackerGeofenceState.findMany({
      where: { trackerId: tracker.id, geofenceId: { in: fences.map((f) => f.id) } },
      select: { geofenceId: true, isInside: true },
    });
    const previous = new Map(states.map((s) => [s.geofenceId, s.isInside]));

    // Primeiro passo: decide em memória quais cercas mudaram de estado.
    const changed: { geofenceId: string; name: string; isInside: boolean }[] = [];
    for (const fence of fences) {
      const vertices = readPolygonFromJson(fence.vertices);
      if (!vertices) {
        // Json corrompido: ignora esta cerca em vez de derrubar a ingestão.
        continue;
      }
      const isInside = isPointInPolygon(point, vertices);
      const wasInside = previous.get(fence.id) ?? false;
      if (isInside !== wasInside) changed.push({ geofenceId: fence.id, name: fence.name, isInside });
    }
    if (!changed.length) return { transitions: [], alerts: [] };

    // Segundo passo: grava o novo estado e os alertas só das cercas alteradas.
    //
    // O upsert é a autoridade sobre "houve transição": dois webhooks do mesmo
    // veículo podem correr em paralelo (isolamento Read Committed), ambos lerem
    // o mesmo estado anterior e ambos acharem que houve transição. `updateMany`
    // condicional no valor antigo devolve count 0 quando o outro já gravou, e só
    // quem de fato mudou a linha é que alerta — evitando alerta duplicado.
    const confirmed: typeof changed = [];
    for (const c of changed) {
      const updated = await tx.trackerGeofenceState.updateMany({
        where: { trackerId: tracker.id, geofenceId: c.geofenceId, isInside: !c.isInside },
        data: { isInside: c.isInside },
      });
      if (updated.count > 0) {
        confirmed.push(c);
        continue;
      }
      // Sem linha anterior para atualizar: cria. `createMany` com
      // skipDuplicates vira `ON CONFLICT DO NOTHING`, que NÃO aborta a
      // transação — um `create` normal numa corrida perdida levantaria erro de
      // constraint e envenenaria a transação inteira, desfazendo até o
      // TrackingPoint gravado acima. O count diz se fomos nós que criámos.
      const created = await tx.trackerGeofenceState.createMany({
        data: [{ trackerId: tracker.id, geofenceId: c.geofenceId, isInside: c.isInside }],
        skipDuplicates: true,
      });
      if (created.count > 0) confirmed.push(c);
    }
    if (!confirmed.length) return { transitions: [], alerts: [] };

    const transitions: { geofenceId: string; type: string }[] = [];
    const alerts: { alertId: string; geofenceId: string; type: string }[] = [];
    for (const c of confirmed) {
      const type = c.isInside ? 'GEOFENCE_ENTER' : 'GEOFENCE_EXIT';
      const message = c.isInside
        ? `Veículo entrou na cerca: ${c.name}`
        : `Veículo saiu da cerca: ${c.name}`;
      const alert = await tx.trackingAlert.create({
        data: { trackerId: tracker.id, type, severity: 'WARNING', message },
      });
      transitions.push({ geofenceId: c.geofenceId, type });
      alerts.push({ alertId: alert.id, geofenceId: c.geofenceId, type });
    }
    return { alertId: alerts[0]?.alertId, transitions, alerts };
  }

  async ingest(dto:TrackingIngestDto,rawBody:Buffer|undefined,timestamp?:string,eventId?:string,signature?:string){
    this.verify(rawBody,timestamp,signature);
    if(!eventId||!/^[A-Za-z0-9._:-]{8,128}$/.test(eventId)) throw new BadRequestException('Invalid X-AGA-Event-Id');
    const payloadHash=createHash('sha256').update(rawBody!).digest('hex');
    const duplicate=await this.prisma.webhookReceipt.findUnique({where:{provider_eventId:{provider:'tracker',eventId}}});
    if(duplicate) return {accepted:true,duplicate:true};
    const tracker=await this.prisma.tracker.findUnique({where:{externalId:dto.trackerExternalId},include:{user:true}});
    if(!tracker) throw new NotFoundException('Unknown tracker');
    const recordedAt=new Date(dto.recordedAt);
    if(Math.abs(Date.now()-recordedAt.getTime())>24*3600_000) throw new BadRequestException('recordedAt outside accepted window');
    return this.prisma.$transaction(async tx=>{
      await tx.webhookReceipt.create({data:{provider:'tracker',eventId,payloadHash}});
      const point=await tx.trackingPoint.create({data:{trackerId:tracker.id,latitude:dto.latitude.toFixed(6),longitude:dto.longitude.toFixed(6),speedKph:dto.speedKph.toFixed(2),heading:dto.heading,ignitionOn:dto.ignitionOn,batteryPct:dto.batteryPct,recordedAt}});
      await tx.tracker.update({where:{id:tracker.id},data:{status:'ONLINE',lastSeenAt:recordedAt,lastLatitude:dto.latitude.toFixed(6),lastLongitude:dto.longitude.toFixed(6),lastSpeedKph:dto.speedKph.toFixed(2),batteryPct:dto.batteryPct}});
      let alertId:string|undefined;
      if(dto.speedKph>120){
        const alert=await tx.trackingAlert.create({data:{trackerId:tracker.id,type:'EXCESSIVE_SPEED',severity:'WARNING',message:`Velocidade acima do limite operacional: ${dto.speedKph.toFixed(0)} km/h`}}); alertId=alert.id;
      }
      // Cerca digital: avalia transições de entrada/saída para este ponto.
      const geofence = await this.evaluateGeofences(tx, tracker, { lat: dto.latitude, lng: dto.longitude });
      // Um evento por alerta criado, cada um apontando para o SEU alertId — antes
      // todos reutilizavam o id do primeiro alerta, deixando o segundo evento
      // a referenciar o alerta errado.
      for (const a of geofence.alerts) {
        await this.events.append({tenantId:tracker.tenantId,type:'tracker.alert.created',aggregateType:'TrackingAlert',aggregateId:a.alertId,payload:{alertId:a.alertId,trackerId:tracker.id,plate:tracker.plate,type:a.type,geofenceId:a.geofenceId},audience:[`user:${tracker.userId}`,'role:ADMIN','role:TRACKING_OPERATOR','role:SUPPORT']},tx);
      }
      await this.events.append({tenantId:tracker.tenantId,type:'tracker.location.updated',aggregateType:'Tracker',aggregateId:tracker.id,payload:{trackerId:tracker.id,userId:tracker.userId,plate:tracker.plate,latitude:dto.latitude,longitude:dto.longitude,speedKph:dto.speedKph,batteryPct:dto.batteryPct,recordedAt:dto.recordedAt,alertId,geofenceTransitions:geofence.transitions.map((t)=>t.type)},audience:[`user:${tracker.userId}`,'role:ADMIN','role:TRACKING_OPERATOR']},tx);
      if(alertId) await this.events.append({tenantId:tracker.tenantId,type:'tracker.alert.created',aggregateType:'TrackingAlert',aggregateId:alertId,payload:{alertId,trackerId:tracker.id,plate:tracker.plate,type:'EXCESSIVE_SPEED'},audience:[`user:${tracker.userId}`,'role:ADMIN','role:TRACKING_OPERATOR','role:SUPPORT']},tx);
      return {accepted:true,duplicate:false,pointId:point.id.toString(),alertId,geofenceAlerts:geofence.transitions.length};
    });
  }

  async mine(user:AuthenticatedUser){
    const trackers=await this.prisma.tracker.findMany({where:{tenantId:user.tenantId,userId:user.sub},include:{alerts:{where:{resolvedAt:null},orderBy:{createdAt:'desc'},take:10}},orderBy:{createdAt:'desc'}});
    return trackers;
  }
  async history(user:AuthenticatedUser,trackerId:string,from?:string,to?:string){
    const tracker=await this.prisma.tracker.findFirst({where:{id:trackerId,tenantId:user.tenantId,...(user.role==='CLIENT'?{userId:user.sub}:{})}});
    if(!tracker) throw new NotFoundException('Tracker not found');
    if(user.role==='MERCHANT') throw new ForbiddenException();
    return this.prisma.trackingPoint.findMany({where:{trackerId,recordedAt:{gte:from?new Date(from):new Date(Date.now()-24*3600_000),lte:to?new Date(to):new Date()}},orderBy:{recordedAt:'asc'},take:5000});
  }
  async fleet(user:AuthenticatedUser,status?:string){
    const trackers=await this.prisma.tracker.findMany({where:{tenantId:user.tenantId,...(status?{status:status as any}:{})},include:{user:{select:{id:true,name:true,email:true}},alerts:{where:{resolvedAt:null},orderBy:{createdAt:'desc'},take:5}},orderBy:[{status:'asc'},{lastSeenAt:'desc'}],take:1000});
    // Normaliza os Decimal em NÚMERO antes de sair do servidor. A atribuição é
    // feita campo a campo de propósito: `{...t}` copiaria só as propriedades
    // próprias do Decimal (`s`,`e`,`d`) e perderia o protótipo, transformando a
    // coordenada num object literal que o frontend não consegue ler (ver
    // `decimalToNumber`).
    return trackers.map((t)=>{
      t.lastLatitude=decimalToNumber(t.lastLatitude) as typeof t.lastLatitude;
      t.lastLongitude=decimalToNumber(t.lastLongitude) as typeof t.lastLongitude;
      t.lastSpeedKph=decimalToNumber(t.lastSpeedKph) as typeof t.lastSpeedKph;
      return t;
    });
  }
  async resolveAlert(user:AuthenticatedUser,alertId:string){
    const alert=await this.prisma.trackingAlert.findFirst({where:{id:alertId,tracker:{tenantId:user.tenantId}}});
    if(!alert) throw new NotFoundException('Alert not found');
    return this.prisma.trackingAlert.update({where:{id:alertId},data:{resolvedAt:new Date()}});
  }

  // --- Cerca digital (geofences) ------------------------------------------
  // Todas as operações filtram por `tenantId` do usuário autenticado. Nenhuma
  // usa where:{id} sozinho: sem essa checagem, um UUID adivinhado permitiria
  // ler ou apagar a cerca de outro cliente.

  async listGeofences(user:AuthenticatedUser){
    return this.prisma.geofence.findMany({
      where:{tenantId:user.tenantId},
      orderBy:{createdAt:'desc'},
      select:{id:true,name:true,kind:true,vertices:true,active:true,color:true,createdAt:true,updatedAt:true},
    });
  }

  async createGeofence(user:AuthenticatedUser,dto:CreateGeofenceDto){
    // Teto por tenant: cada cerca ativa é reavaliada a cada ping de GPS de cada
    // veículo, então um número ilimitado de cercas encarece a ingestão de forma
    // permanente. O limite é alto o bastante para não atrapalhar o uso real.
    const existing=await this.prisma.geofence.count({where:{tenantId:user.tenantId}});
    if(existing>=MAX_GEOFENCES_PER_TENANT) throw new BadRequestException(`Limite de ${MAX_GEOFENCES_PER_TENANT} cercas por cliente atingido.`);
    // normalizePolygon valida e remove o ponto de fecho duplicado (o DTO já
    // garante ≥3 vértices, mas o arredondamento, o fecho e o caso [A,B,A] — que
    // passa no ArrayMinSize(3) mas sobra com 2 vértices distintos — são
    // responsabilidade do serviço). Erro de entrada vira 400, não 500.
    let vertices: GeoVertex[];
    try {
      vertices = normalizePolygon(dto.vertices);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Polígono inválido.');
    }
    return this.prisma.geofence.create({
      data:{
        tenantId:user.tenantId,
        name:dto.name,
        kind:dto.kind ?? 'POLYGON',
        // O cast é exigido pelo InputJsonValue do Prisma, que espera um objeto
        // com index signature; a forma real do array já foi validada e
        // normalizada por normalizePolygon logo acima.
        vertices:vertices as unknown as Prisma.InputJsonValue,
        active:dto.active ?? true,
        // Sem `color` no body, deixa o default do schema (`#0967d8`) decidir —
        // assim o azul existe num sítio só (o banco) e não duplicado aqui.
        ...(dto.color ? { color:dto.color } : {}),
      },
      select:{id:true,name:true,kind:true,vertices:true,active:true,color:true,createdAt:true,updatedAt:true},
    });
  }

  /**
   * Edita uma cerca existente. Campos ausentes no body ficam como estão.
   *
   * Todas as alterações passam por um `findFirst` com `tenantId` antes do update:
   * um UUID adivinhado não pode renomear nem mover a cerca de outro cliente.
   */
  async updateGeofence(user:AuthenticatedUser,id:string,dto:UpdateGeofenceDto){
    // O filtro por tenant vive no `where` do updateMany (abaixo), mas este
    // findFirst existe para distinguir "não existe / não é meu" (404) de
    // "existe mas nada mudou" — sem ele, um id de outro tenant e um id inexistente
    // seriam indistinguíveis de um update sem efeito.
    const fence=await this.prisma.geofence.findFirst({where:{id,tenantId:user.tenantId},select:{id:true}});
    if(!fence) throw new NotFoundException('Geofence not found');

    const data:Prisma.GeofenceUpdateInput={};
    if(dto.name!==undefined) data.name=dto.name;
    if(dto.color!==undefined) data.color=dto.color;
    if(dto.active!==undefined) data.active=dto.active;
    if(dto.vertices!==undefined){
      // Mesma normalização da criação: o DTO garante ≥3 vértices enviados, mas
      // o arredondamento e o ponto de fecho duplicado são responsabilidade do
      // serviço. Erro de entrada vira 400, não 500.
      try{
        data.vertices=normalizePolygon(dto.vertices) as unknown as Prisma.InputJsonValue;
      }catch(err){
        throw new BadRequestException(err instanceof Error ? err.message : 'Polígono inválido.');
      }
    }

    return this.prisma.geofence.update({
      where:{id:fence.id},
      data,
      select:{id:true,name:true,kind:true,vertices:true,active:true,color:true,createdAt:true,updatedAt:true},
    });
  }

  async deleteGeofence(user:AuthenticatedUser,id:string){
    // findFirst antes do delete: garante que a cerca pertence ao tenant do
    // usuário. O TrackerGeofenceState correspondente cai por ON DELETE CASCADE.
    const fence=await this.prisma.geofence.findFirst({where:{id,tenantId:user.tenantId},select:{id:true}});
    if(!fence) throw new NotFoundException('Geofence not found');
    await this.prisma.geofence.delete({where:{id:fence.id}});
    return {deleted:true,id:fence.id};
  }
}
