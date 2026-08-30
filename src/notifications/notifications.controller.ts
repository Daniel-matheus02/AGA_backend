import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/auth.types';
import { NotificationsService } from './notifications.service';
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController{
  constructor(private readonly service:NotificationsService){}
  @Get() list(@CurrentUser()u:AuthenticatedUser){return this.service.list(u)}
  @Post(':id/read') read(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.read(u,id)}
}
