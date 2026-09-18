import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AuthenticatedUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { PaymentWebhookDto } from './dto';
import { PaymentProvider } from './payment-provider';

@Injectable()
export class PaymentsService{
  constructor(private readonly prisma:PrismaService,private readonly events:EventsService,private readonly provider:PaymentProvider,private readonly config:ConfigService){}
  mine(user:AuthenticatedUser){return this.prisma.payment.findMany({where:{tenantId:user.tenantId,userId:user.sub},orderBy:{dueDate:'asc'},take:365})}
  admin(user:AuthenticatedUser,status?:string){return this.prisma.payment.findMany({where:{tenantId:user.tenantId,...(status?{status:status as any}:{})},include:{user:{select:{id:true,name:true,email:true}}},orderBy:{dueDate:'asc'},take:1000})}

  async createIntent(user:AuthenticatedUser,paymentId:string){
    const payment=await this.prisma.payment.findFirst({where:{id:paymentId,tenantId:user.tenantId,userId:user.sub}});
    if(!payment)throw new NotFoundException('Payment not found');
    if(payment.status!=='PENDING')throw new BadRequestException('Payment is not pending');
    const intent=await this.provider.createIntent(payment);
    const updated=await this.prisma.payment.update({where:{id:payment.id},data:{providerReference:intent.providerReference}});
    await this.events.append({tenantId:user.tenantId,type:'payment.intent.created',aggregateType:'Payment',aggregateId:payment.id,payload:{paymentId:payment.id,userId:user.sub,amountCents:payment.amountCents.toString(),providerReference:intent.providerReference,expiresAt:intent.expiresAt.toISOString()},audience:[`user:${user.sub}`,'role:FINANCE','role:ADMIN']});
    return {...updated,checkoutUrl:intent.checkoutUrl,expiresAt:intent.expiresAt,providerMode:intent.mode};
  }

  private verify(rawBody:Buffer|undefined,timestamp:string|undefined,signature:string|undefined){
    if(!rawBody||!timestamp||!signature)throw new UnauthorizedException('Missing webhook signature headers');
    const ts=Number(timestamp);if(!Number.isFinite(ts)||Math.abs(Date.now()-ts*1000)>5*60_000)throw new UnauthorizedException('Webhook timestamp outside allowed window');
    const expected=createHmac('sha256',this.config.getOrThrow<string>('PAYMENT_WEBHOOK_SECRET')).update(`${timestamp}.`).update(rawBody).digest('hex');
    const supplied=signature.replace(/^sha256=/,'');
    if(!/^[a-f0-9]{64}$/i.test(supplied)||!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(supplied,'hex')))throw new UnauthorizedException('Invalid webhook signature');
  }

  async webhook(dto:PaymentWebhookDto,rawBody:Buffer|undefined,timestamp?:string,eventId?:string,signature?:string){
    this.verify(rawBody,timestamp,signature);
    if(!eventId||!/^[A-Za-z0-9._:-]{8,128}$/.test(eventId))throw new BadRequestException('Invalid X-AGA-Event-Id');
    const payloadHash=createHash('sha256').update(rawBody!).digest('hex');
    const duplicate=await this.prisma.webhookReceipt.findUnique({where:{provider_eventId:{provider:'payment',eventId}}});
    if(duplicate)return {accepted:true,duplicate:true};
    const payment=await this.prisma.payment.findUnique({where:{providerReference:dto.providerReference}});
    if(!payment)throw new NotFoundException('Payment reference not found');
    return this.prisma.$transaction(async tx=>{
      await tx.webhookReceipt.create({data:{provider:'payment',eventId,payloadHash}});
      const status=dto.status;
      const updated=await tx.payment.update({where:{id:payment.id},data:{status,paidAt:status==='PAID'?new Date(dto.occurredAt):payment.paidAt}});
      await tx.notification.create({data:{userId:payment.userId,type:`PAYMENT_${status}`,title:status==='PAID'?'Diária confirmada':'Atualização do pagamento',body:status==='PAID'?'O pagamento da sua diária foi confirmado.':'Consulte o status do pagamento no aplicativo.',data:{paymentId:payment.id}}});
      await this.events.append({tenantId:payment.tenantId,type:`payment.daily.${status.toLowerCase()}`,aggregateType:'Payment',aggregateId:payment.id,payload:{paymentId:payment.id,userId:payment.userId,amountCents:payment.amountCents.toString(),status,occurredAt:dto.occurredAt},audience:[`user:${payment.userId}`,'role:FINANCE','role:ADMIN']},tx);
      return {accepted:true,duplicate:false,payment:updated};
    });
  }
}
