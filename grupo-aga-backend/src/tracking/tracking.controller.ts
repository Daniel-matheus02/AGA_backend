import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/auth.types';
import { TrackingIngestDto, CreateGeofenceDto, UpdateGeofenceDto } from './dto';
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
  // Cerca digital. Declaradas ANTES de ':id/history' na ordem de rotas não
  // interfere aqui porque o prefixo literal 'admin/geofences' não colide com um
  // ':id' de segmento único — mas mantenha o padrão 'admin/...' para o caso de
  // surgir uma rota GET ':id' genérica no futuro.
  @Roles('ADMIN','TRACKING_OPERATOR') @Get('admin/geofences') listGeofences(@CurrentUser()u:AuthenticatedUser){return this.service.listGeofences(u)}
  @Roles('ADMIN','TRACKING_OPERATOR') @Post('admin/geofences') createGeofence(@CurrentUser()u:AuthenticatedUser,@Body()d:CreateGeofenceDto){return this.service.createGeofence(u,d)}
  // PATCH (não PUT): a edição é parcial por desenho — o frontend manda só o que
  // mudou, para renomear uma cerca sem reenviar (e arriscar sobrescrever) os
  // vértices que outro separador possa ter ajustado.
  @Roles('ADMIN','TRACKING_OPERATOR') @Patch('admin/geofences/:id') updateGeofence(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Body()d:UpdateGeofenceDto){return this.service.updateGeofence(u,id,d)}
  @Roles('ADMIN','TRACKING_OPERATOR') @Delete('admin/geofences/:id') deleteGeofence(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.deleteGeofence(u,id)}
}
