import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
@Module({ imports:[PassportModule,JwtModule.register({})], controllers:[AuthController], providers:[AuthService,JwtStrategy], exports:[JwtModule] })
export class AuthModule {}
