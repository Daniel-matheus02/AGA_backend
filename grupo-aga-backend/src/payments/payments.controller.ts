import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../common/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PaymentWebhookDto } from './dto';
import { PaymentsService } from './payments.service';
@ApiTags('payments')
@Controller('payments')
export class PaymentsController{
  constructor(private readonly service:PaymentsService){}
  @Roles('CLIENT') @Get('me') mine(@CurrentUser()u:AuthenticatedUser){return this.service.mine(u)}
  @Roles('CLIENT') @Idempotent() @Post(':id/intent') intent(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.createIntent(u,id)}
  @Roles('ADMIN','FINANCE','SUPPORT') @Get('admin/all') admin(@CurrentUser()u:AuthenticatedUser,@Query('status')s?:string){return this.service.admin(u,s)}
  @Public() @Post('provider/webhook') webhook(@Body()d:PaymentWebhookDto,@Req()req:Request&{rawBody?:Buffer},@Headers('x-aga-timestamp')ts?:string,@Headers('x-aga-event-id')eventId?:string,@Headers('x-aga-signature')sig?:string){return this.service.webhook(d,req.rawBody,ts,eventId,sig)}
}
