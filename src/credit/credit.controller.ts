import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../common/auth.types';
import { CreditService } from './credit.service';
import { CreateCreditRequestDto, AdminCreateCreditRequestDto, DecideCreditRequestDto, RejectCreditRequestDto } from './dto';

@ApiTags('credit')
@Controller('credit')
export class CreditController{
  constructor(private readonly service:CreditService){}
  @Roles('CLIENT') @Idempotent() @Post('requests') create(@CurrentUser()u:AuthenticatedUser,@Body()d:CreateCreditRequestDto){return this.service.create(u,d)}
  @Roles('ADMIN','FINANCE') @Idempotent() @Post('admin/requests') createAdmin(@CurrentUser()u:AuthenticatedUser,@Body()d:AdminCreateCreditRequestDto){return this.service.createAdmin(u,d)}
  @Roles('CLIENT') @Get('requests/me') mine(@CurrentUser()u:AuthenticatedUser){return this.service.listOwn(u)}
  @Roles('CLIENT') @Get('account') account(@CurrentUser()u:AuthenticatedUser){return this.service.account(u)}
  @Roles('ADMIN','FINANCE','SUPPORT') @Get('admin/requests') list(@CurrentUser()u:AuthenticatedUser,@Query('status')s?:string){return this.service.listAdmin(u,s)}
  @Roles('ADMIN','FINANCE') @Idempotent() @Post('admin/requests/:id/approve') approve(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Body()d:DecideCreditRequestDto){return this.service.approve(u,id,d)}
  @Roles('ADMIN','FINANCE') @Idempotent() @Post('admin/requests/:id/reject') reject(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Body()d:RejectCreditRequestDto){return this.service.reject(u,id,d)}
}
