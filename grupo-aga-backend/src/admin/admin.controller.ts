import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/auth.types';
import { AdminService } from './admin.service';
@ApiTags('admin')
@Roles('ADMIN','FINANCE','SUPPORT','TRACKING_OPERATOR')
@Controller('admin')
export class AdminController{
  constructor(private readonly service:AdminService){}
  @Get('dashboard') dashboard(@CurrentUser()u:AuthenticatedUser){return this.service.dashboard(u)}
  @Roles('ADMIN') @Get('audit') audit(@CurrentUser()u:AuthenticatedUser){return this.service.audit(u)}
  @Roles('ADMIN') @Get('events') events(@CurrentUser()u:AuthenticatedUser){return this.service.events(u)}
}
