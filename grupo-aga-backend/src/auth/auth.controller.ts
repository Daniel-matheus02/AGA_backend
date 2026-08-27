import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/auth.types';
import { AuthService } from './auth.service';
import { LoginDto, LogoutDto, MfaConfirmDto, MfaDisableDto, MfaEnrollDto, RefreshDto } from './dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth:AuthService) {}
  @Public() @Post('login') login(@Body() dto:LoginDto,@Req() req:Request){ return this.auth.login(dto,req.ip,req.header('user-agent')); }
  @Public() @Post('refresh') refresh(@Body() dto:RefreshDto,@Req() req:Request){ return this.auth.refresh(dto.refreshToken,req.ip,req.header('user-agent')); }
  @Public() @Post('logout') logout(@Body() dto:LogoutDto){ return this.auth.logout(dto.refreshToken); }
  @Post('mfa/enroll') enroll(@CurrentUser()u:AuthenticatedUser,@Body()dto:MfaEnrollDto){return this.auth.beginMfa(u.sub,dto.password)}
  @Post('mfa/confirm') confirm(@CurrentUser()u:AuthenticatedUser,@Body()dto:MfaConfirmDto){return this.auth.confirmMfa(u.sub,dto.code)}
  @Post('mfa/disable') disable(@CurrentUser()u:AuthenticatedUser,@Body()dto:MfaDisableDto){return this.auth.disableMfa(u.sub,dto.password,dto.code)}
}
