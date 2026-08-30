import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { ChangePolicyStatusDto, CreatePolicyDto } from './dto';
@Injectable()
export class ProtectionService{
  constructor(private readonly prisma:PrismaService,private readonly events:EventsService){}
  mine(user:AuthenticatedUser){return this.prisma.insurancePolicy.findMany({where:{tenantId:user.tenantId,userId:user.sub},include:{tracker:true},orderBy:{createdAt:'desc'}})}
  admin(user:AuthenticatedUser){return this.prisma.insurancePolicy.findMany({where:{tenantId:user.tenantId},include:{user:{select:{id:true,name:true,email:true}},tracker:true},orderBy:{createdAt:'desc'},take:1000})}
  async create(user:AuthenticatedUser,dto:CreatePolicyDto){
    const client=await this.prisma.user.findFirst({where:{id:dto.userId,tenantId:user.tenantId,role:'CLIENT'}});if(!client)throw new NotFoundException('Client not found');
    const tracker=await this.prisma.tracker.findFirst({where:{userId:client.id,tenantId:user.tenantId}});
    return this.prisma.$transaction(async tx=>{
      const policy=await tx.insurancePolicy.create({data:{tenantId:user.tenantId,userId:client.id,trackerId:tracker?.id,provider:dto.provider,providerReference:dto.providerReference,status:'ACTIVE',coverage:{collision:true,theft:true,robbery:true,thirdParty:true,assistance24h:true},startsAt:new Date(),endsAt:new Date(Date.now()+365*86400_000)}});
      await tx.notification.create({data:{userId:client.id,type:'POLICY_ACTIVE',title:'Seguro total ativo',body:'A proteção da sua moto está ativa.',data:{policyId:policy.id}}});
      await this.events.append({tenantId:user.tenantId,type:'protection.policy.activated',aggregateType:'InsurancePolicy',aggregateId:policy.id,payload:{policyId:policy.id,userId:client.id,trackerId:tracker?.id,status:'ACTIVE'},audience:[`user:${client.id}`,'role:ADMIN','role:SUPPORT']},tx);
      return policy;
    });
  }
  async changeStatus(user:AuthenticatedUser,id:string,dto:ChangePolicyStatusDto){
    const policy=await this.prisma.insurancePolicy.findFirst({where:{id,tenantId:user.tenantId}});if(!policy)throw new NotFoundException('Policy not found');
    const updated=await this.prisma.insurancePolicy.update({where:{id},data:{status:dto.status}});
    await this.events.append({tenantId:user.tenantId,type:'protection.policy.status_changed',aggregateType:'InsurancePolicy',aggregateId:id,payload:{policyId:id,userId:policy.userId,status:dto.status},audience:[`user:${policy.userId}`,'role:ADMIN','role:SUPPORT']});
    return updated;
  }
}
