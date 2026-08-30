import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/auth.types';
import { TrackingIngestDto } from './dto';
import { TrackingService } from './tracking.service';
@ApiTags('tracking')
@Controller('tracking')
export class TrackingController{
  constructor(private readonly service:TrackingService){}
  @Public() @Post('provider/webhook') ingest(@Body()d:TrackingIngestDto,@Req()req:Request&{rawBody?:Buffer},@Headers('x-aga-timestamp')ts?:string,@Headers('x-aga-event-id')eventId?:string,@Headers('x-aga-signature')sig?:string){return this.service.ingest(d,req.rawBody,ts,eventId,sig)}
  @Roles('CLIENT') @Get('me') mine(@CurrentUser()u:AuthenticatedUser){return this.service.mine(u)}
  @Roles('CLIENT','ADMIN','TRACKING_OPERATOR','SUPPORT') @Get(':id/history') history(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Query('from')from?:string,@Query('to')to?:string){return this.service.history(u,id,from,to)}
  @Roles('ADMIN','TRACKING_OPERATOR','SUPPORT') @Get('admin/fleet/all') fleet(@CurrentUser()u:AuthenticatedUser,@Query('status')s?:string){return this.service.fleet(u,s)}
  @Roles('ADMIN','TRACKING_OPERATOR','SUPPORT') @Post('admin/alerts/:id/resolve') resolve(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.resolveAlert(u,id)}
}
