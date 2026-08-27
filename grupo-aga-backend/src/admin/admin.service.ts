import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthenticatedUser } from '../common/auth.types';
@Injectable()
export class AdminService{
  constructor(private readonly prisma:PrismaService){}
  async dashboard(user:AuthenticatedUser){
    const [clients,merchants,onlineTrackers,pendingCredit,openAlerts,orders,creditAgg]=await Promise.all([
      this.prisma.user.count({where:{tenantId:user.tenantId,role:'CLIENT',status:'ACTIVE'}}),
      this.prisma.merchant.count({where:{tenantId:user.tenantId,active:true}}),
      this.prisma.tracker.count({where:{tenantId:user.tenantId,status:'ONLINE'}}),
      this.prisma.creditRequest.count({where:{tenantId:user.tenantId,status:{in:['PENDING','UNDER_REVIEW']}}}),
      this.prisma.trackingAlert.count({where:{tracker:{tenantId:user.tenantId},resolvedAt:null}}),
      this.prisma.order.aggregate({where:{tenantId:user.tenantId,status:{in:['AUTHORIZED','SETTLED']}},_count:true,_sum:{amountCents:true}}),
      this.prisma.creditAccount.aggregate({where:{user:{tenantId:user.tenantId}},_sum:{limitCents:true,usedCents:true,blockedCents:true}}),
    ]);
    return {clients,merchants,onlineTrackers,pendingCredit,openAlerts,orders:{count:orders._count,totalCents:orders._sum.amountCents??0n},credit:{limitCents:creditAgg._sum.limitCents??0n,usedCents:creditAgg._sum.usedCents??0n,blockedCents:creditAgg._sum.blockedCents??0n}};
  }
  audit(user:AuthenticatedUser){return this.prisma.auditLog.findMany({where:{tenantId:user.tenantId},orderBy:{createdAt:'desc'},take:500,include:{actor:{select:{name:true,email:true,role:true}}}})}
  events(user:AuthenticatedUser){return this.prisma.outboxEvent.findMany({where:{tenantId:user.tenantId},orderBy:{createdAt:'desc'},take:200})}
}
