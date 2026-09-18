import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/auth.types';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, LogoutDto, RefreshDto } from './dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth:AuthService) {}
  @Public() @Post('login') login(@Body() dto:LoginDto,@Req() req:Request){ return this.auth.login(dto,req.ip,req.header('user-agent')); }
  @Public() @Post('refresh') refresh(@Body() dto:RefreshDto,@Req() req:Request){ return this.auth.refresh(dto.refreshToken,req.ip,req.header('user-agent')); }
  @Public() @Post('logout') logout(@Body() dto:LogoutDto){ return this.auth.logout(dto.refreshToken); }

  /**
   * Troca a senha do usuário logado. Ao contrário das rotas acima, **não** é
   * `@Public()`: exige o JWT do próprio dono da conta, além da senha atual.
   */
  @Post('change-password') changePassword(@CurrentUser() user:AuthenticatedUser,@Body() dto:ChangePasswordDto){
    return this.auth.changePassword(user,dto);
  }

  /**
   * Perfil do usuário autenticado. Também autenticada: a identidade vem do JWT,
   * nunca de um parâmetro do cliente, e o conteúdo vem do banco.
   */
  @Get('me') me(@CurrentUser() user:AuthenticatedUser){ return this.auth.me(user); }
}
