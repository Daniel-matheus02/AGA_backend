import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../common/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ChangePolicyStatusDto, CreatePolicyDto } from './dto';
import { ProtectionService } from './protection.service';
@ApiTags('protection')
@Controller('protection')
export class ProtectionController{
  constructor(private readonly service:ProtectionService){}
  @Roles('CLIENT') @Get('me') mine(@CurrentUser()u:AuthenticatedUser){return this.service.mine(u)}
  @Roles('ADMIN','SUPPORT') @Get('admin/policies') admin(@CurrentUser()u:AuthenticatedUser){return this.service.admin(u)}
  @Roles('ADMIN') @Idempotent() @Post('admin/policies') create(@CurrentUser()u:AuthenticatedUser,@Body()d:CreatePolicyDto){return this.service.create(u,d)}
  @Roles('ADMIN','SUPPORT') @Idempotent() @Post('admin/policies/:id/status') status(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Body()d:ChangePolicyStatusDto){return this.service.changeStatus(u,id,d)}
}
