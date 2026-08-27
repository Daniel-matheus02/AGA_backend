import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { AuthenticatedUser } from '../common/auth.types';
import { TrackingIngestDto } from './dto';

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
      await this.events.append({tenantId:tracker.tenantId,type:'tracker.location.updated',aggregateType:'Tracker',aggregateId:tracker.id,payload:{trackerId:tracker.id,userId:tracker.userId,plate:tracker.plate,latitude:dto.latitude,longitude:dto.longitude,speedKph:dto.speedKph,batteryPct:dto.batteryPct,recordedAt:dto.recordedAt,alertId},audience:[`user:${tracker.userId}`,'role:ADMIN','role:TRACKING_OPERATOR']},tx);
      if(alertId) await this.events.append({tenantId:tracker.tenantId,type:'tracker.alert.created',aggregateType:'TrackingAlert',aggregateId:alertId,payload:{alertId,trackerId:tracker.id,plate:tracker.plate,type:'EXCESSIVE_SPEED'},audience:[`user:${tracker.userId}`,'role:ADMIN','role:TRACKING_OPERATOR','role:SUPPORT']},tx);
      return {accepted:true,duplicate:false,pointId:point.id.toString(),alertId};
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
    return this.prisma.tracker.findMany({where:{tenantId:user.tenantId,...(status?{status:status as any}:{})},include:{user:{select:{id:true,name:true,email:true}},alerts:{where:{resolvedAt:null},orderBy:{createdAt:'desc'},take:5}},orderBy:[{status:'asc'},{lastSeenAt:'desc'}],take:1000});
  }
  async resolveAlert(user:AuthenticatedUser,alertId:string){
    const alert=await this.prisma.trackingAlert.findFirst({where:{id:alertId,tracker:{tenantId:user.tenantId}}});
    if(!alert) throw new NotFoundException('Alert not found');
    return this.prisma.trackingAlert.update({where:{id:alertId},data:{resolvedAt:new Date()}});
  }
}
