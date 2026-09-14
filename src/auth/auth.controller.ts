import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto, LogoutDto, RefreshDto } from './dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth:AuthService) {}
  @Public() @Post('login') login(@Body() dto:LoginDto,@Req() req:Request){ return this.auth.login(dto,req.ip,req.header('user-agent')); }
  @Public() @Post('refresh') refresh(@Body() dto:RefreshDto,@Req() req:Request){ return this.auth.refresh(dto.refreshToken,req.ip,req.header('user-agent')); }
  @Public() @Post('logout') logout(@Body() dto:LogoutDto){ return this.auth.logout(dto.refreshToken); }
}
