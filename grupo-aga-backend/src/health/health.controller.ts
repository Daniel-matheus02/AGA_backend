import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
@Controller('health')
export class HealthController{
  constructor(private readonly prisma:PrismaService,private readonly redis:RedisService){}
  @Public() @Get('live') live(){return {status:'ok',timestamp:new Date().toISOString()}}
  @Public() @Get('ready') async ready(){
    try{await this.prisma.$queryRaw`SELECT 1`;await this.redis.client.ping();return {status:'ready',timestamp:new Date().toISOString()}}
    catch{throw new ServiceUnavailableException('Dependencies unavailable')}
  }
}
