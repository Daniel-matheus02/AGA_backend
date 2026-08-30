import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { AuthenticatedUser } from '../common/auth.types';
import { AdminService } from './admin.service';
import { CreateClientDto, CreateMerchantDto } from './dto';
@ApiTags('admin')
@Roles('ADMIN','FINANCE','SUPPORT','TRACKING_OPERATOR')
@Controller('admin')
export class AdminController{
  constructor(private readonly service:AdminService){}
  @Get('dashboard') dashboard(@CurrentUser()u:AuthenticatedUser){return this.service.dashboard(u)}
  @Roles('ADMIN','FINANCE','SUPPORT') @Get('clients') clients(@CurrentUser()u:AuthenticatedUser){return this.service.listClients(u)}
  @Roles('ADMIN') @Idempotent() @Post('clients') createClient(@CurrentUser()u:AuthenticatedUser,@Body()d:CreateClientDto){return this.service.createClient(u,d)}
  @Roles('ADMIN','FINANCE','SUPPORT') @Get('merchants') merchants(@CurrentUser()u:AuthenticatedUser){return this.service.listMerchants(u)}
  @Roles('ADMIN') @Idempotent() @Post('merchants') createMerchant(@CurrentUser()u:AuthenticatedUser,@Body()d:CreateMerchantDto){return this.service.createMerchant(u,d)}
  @Roles('ADMIN','FINANCE') @Get('finance') finance(@CurrentUser()u:AuthenticatedUser){return this.service.finance(u)}
  @Roles('ADMIN') @Get('audit') audit(@CurrentUser()u:AuthenticatedUser){return this.service.audit(u)}
  @Roles('ADMIN') @Get('events') events(@CurrentUser()u:AuthenticatedUser){return this.service.outboxEvents(u)}
}
