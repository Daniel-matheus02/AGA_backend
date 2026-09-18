import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { AuthenticatedUser } from '../common/auth.types';
import { CreateCreditRequestDto, AdminCreateCreditRequestDto, DecideCreditRequestDto, RejectCreditRequestDto } from './dto';
import { randomUUID } from 'node:crypto';
import { calculateDailyAmount } from '../common/services/money';

@Injectable()
export class CreditService {
  constructor(private readonly prisma:PrismaService,private readonly events:EventsService){}

  async create(user:AuthenticatedUser,dto:CreateCreditRequestDto){
    if(user.role!=='CLIENT') throw new ForbiddenException();
    return this.issueRequest(user.tenantId,user.sub,dto.amountCents,dto.dailyInstallments);
  }

  /** Análise manual de crédito criada por ADMIN/FINANCE em nome de um CLIENT. */
  async createAdmin(admin:AuthenticatedUser,dto:AdminCreateCreditRequestDto){
    if(!['ADMIN','FINANCE'].includes(admin.role)) throw new ForbiddenException();
    const client=await this.prisma.user.findFirst({where:{id:dto.userId,tenantId:admin.tenantId,role:'CLIENT',status:'ACTIVE'}});
    if(!client) throw new NotFoundException('Cliente não encontrado');
    return this.issueRequest(admin.tenantId,client.id,dto.amountCents,dto.dailyInstallments);
  }

  private async issueRequest(tenantId:string,userId:string,amountCents:number,dailyInstallments:number){
    const pending=await this.prisma.creditRequest.findFirst({where:{userId,status:{in:['PENDING','UNDER_REVIEW']}}});
    if(pending) throw new BadRequestException('There is already a credit request under analysis');
    const amount=BigInt(amountCents);
    const daily=calculateDailyAmount(amount,dailyInstallments);
    return this.prisma.$transaction(async tx=>{
      const request=await tx.creditRequest.create({data:{tenantId,userId,amountCents:amount,dailyInstallments,dailyAmountCents:daily}});
      await this.events.append({tenantId,type:'credit.request.created',aggregateType:'CreditRequest',aggregateId:request.id,payload:{requestId:request.id,userId,amountCents:amount.toString(),dailyInstallments},audience:[`user:${userId}`,'role:ADMIN','role:FINANCE']},tx);
      return request;
    });
  }

  listOwn(user:AuthenticatedUser){ return this.prisma.creditRequest.findMany({where:{userId:user.sub},orderBy:{createdAt:'desc'}}); }
  listAdmin(user:AuthenticatedUser,status?:string){
    return this.prisma.creditRequest.findMany({where:{tenantId:user.tenantId,...(status?{status:status as any}:{})},include:{user:{select:{id:true,name:true,email:true}}},orderBy:{createdAt:'desc'},take:200});
  }

  async approve(admin:AuthenticatedUser,id:string,dto:DecideCreditRequestDto){
    return this.prisma.$transaction(async tx=>{
      const request=await tx.creditRequest.findFirst({where:{id,tenantId:admin.tenantId}});
      if(!request) throw new NotFoundException('Credit request not found');
      if(!['PENDING','UNDER_REVIEW'].includes(request.status)) throw new BadRequestException('Credit request already decided');
      const approved=BigInt(dto.approvedLimitCents);
      const currentAccount=await tx.creditAccount.findUnique({where:{userId:request.userId}});
      if(currentAccount && currentAccount.usedCents+currentAccount.blockedCents>approved) throw new BadRequestException('Approved limit cannot be below already committed balance');
      const updated=await tx.creditRequest.update({where:{id},data:{status:'APPROVED',decisionReason:dto.reason,decidedByUserId:admin.sub,decidedAt:new Date()}});
      await tx.creditAccount.upsert({where:{userId:request.userId},create:{userId:request.userId,limitCents:approved},update:{limitCents:approved,version:{increment:1}}});
      const schedule=Array.from({length:request.dailyInstallments},(_,index)=>({tenantId:request.tenantId,userId:request.userId,amountCents:request.dailyAmountCents,dueDate:new Date(Date.now()+(index+1)*86400_000)}));
      await tx.payment.createMany({data:schedule});
      const existingPolicy=await tx.insurancePolicy.findFirst({where:{tenantId:request.tenantId,userId:request.userId,status:{in:['PENDING','ACTIVE']}}});
      let policyId=existingPolicy?.id;
      if(!existingPolicy){
        const tracker=await tx.tracker.findFirst({where:{tenantId:request.tenantId,userId:request.userId}});
        const policy=await tx.insurancePolicy.create({data:{tenantId:request.tenantId,userId:request.userId,trackerId:tracker?.id,provider:'PENDING_PROVIDER_INTEGRATION',providerReference:`AGA-POL-${randomUUID()}`,status:'PENDING',coverage:{collision:true,theft:true,robbery:true,thirdParty:true,assistance24h:true},startsAt:new Date(),endsAt:new Date(Date.now()+365*86400_000)}});
        policyId=policy.id;
        await this.events.append({tenantId:request.tenantId,type:'protection.policy.requested',aggregateType:'InsurancePolicy',aggregateId:policy.id,payload:{policyId:policy.id,userId:request.userId,trackerId:tracker?.id},audience:[`user:${request.userId}`,'role:ADMIN','role:SUPPORT']},tx);
      }
      await tx.notification.create({data:{userId:request.userId,type:'CREDIT_APPROVED',title:'Crédito aprovado',body:`Seu limite de R$ ${(Number(approved)/100).toFixed(2)} foi aprovado.`,data:{requestId:id,policyId}}});
      await this.events.append({tenantId:request.tenantId,type:'payment.schedule.created',aggregateType:'CreditRequest',aggregateId:id,payload:{requestId:id,userId:request.userId,installments:request.dailyInstallments,dailyAmountCents:request.dailyAmountCents.toString()},audience:[`user:${request.userId}`,'role:ADMIN','role:FINANCE']},tx);
      await this.events.append({tenantId:request.tenantId,type:'credit.request.approved',aggregateType:'CreditRequest',aggregateId:id,payload:{requestId:id,userId:request.userId,approvedLimitCents:approved.toString(),policyId},audience:[`user:${request.userId}`,'role:ADMIN','role:FINANCE']},tx);
      return updated;
    });
  }

  async reject(admin:AuthenticatedUser,id:string,dto:RejectCreditRequestDto){
    return this.prisma.$transaction(async tx=>{
      const request=await tx.creditRequest.findFirst({where:{id,tenantId:admin.tenantId}});
      if(!request) throw new NotFoundException('Credit request not found');
      if(!['PENDING','UNDER_REVIEW'].includes(request.status)) throw new BadRequestException('Credit request already decided');
      const updated=await tx.creditRequest.update({where:{id},data:{status:'REJECTED',decisionReason:dto.reason,decidedByUserId:admin.sub,decidedAt:new Date()}});
      await tx.notification.create({data:{userId:request.userId,type:'CREDIT_REJECTED',title:'Análise concluída',body:'Sua solicitação de crédito foi analisada. Consulte os detalhes no aplicativo.',data:{requestId:id}}});
      await this.events.append({tenantId:request.tenantId,type:'credit.request.rejected',aggregateType:'CreditRequest',aggregateId:id,payload:{requestId:id,userId:request.userId},audience:[`user:${request.userId}`,'role:ADMIN']},tx);
      return updated;
    });
  }

  async account(user:AuthenticatedUser){
    const account=await this.prisma.creditAccount.findUnique({where:{userId:user.sub}});
    if(!account) return {limitCents:'0',usedCents:'0',blockedCents:'0',availableCents:'0'};
    return {...account,availableCents:(account.limitCents-account.usedCents-account.blockedCents)};
  }
}
