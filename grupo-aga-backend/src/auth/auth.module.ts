import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { EventsModule } from '../events/events.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthEventsService } from './auth-events.service';
import { JwtStrategy } from './jwt.strategy';
@Module({ imports:[PassportModule,JwtModule.register({}),EventsModule], controllers:[AuthController], providers:[AuthService,AuthEventsService,JwtStrategy], exports:[JwtModule,AuthEventsService] })
export class AuthModule {}
