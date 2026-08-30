import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthenticatedUser } from '../common/auth.types';
@Injectable()
export class NotificationsService{
  constructor(private readonly prisma:PrismaService){}
  list(user:AuthenticatedUser){return this.prisma.notification.findMany({where:{userId:user.sub},orderBy:{createdAt:'desc'},take:100})}
  async read(user:AuthenticatedUser,id:string){
    const n=await this.prisma.notification.findFirst({where:{id,userId:user.sub}});if(!n)throw new NotFoundException();
    return this.prisma.notification.update({where:{id},data:{readAt:new Date()}})
  }
}
