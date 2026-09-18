import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { DbAdminController } from './db-admin.controller';
import { DbAdminGuard } from './db-admin.guard';
import { DbAdminUsersService } from './db-admin-users.service';
import { PanelAuthService } from './panel-auth.service';
import { PgAdminConnectionRegistry } from './pg-connection.registry';
import { PgAdminRolesService } from './pg-admin-roles.service';

/**
 * API de administração do banco de dados (`/v1/db-admin`). Somente JSON: a
 * interface é o projeto separado `frontend_user_manager`, que consome estes
 * endpoints (e por isso precisa da origem liberada em `CORS_ORIGINS`).
 *
 * Autenticação própria: `PanelAuthService` assina um JWT com issuer/audience
 * exclusivos do painel, então o token daqui não vale como access token da API
 * (nem o contrário). O `JwtModule` sem segredo na importação é intencional: o
 * segredo é resolvido por chamada, a partir do config.
 */
@Module({
  imports: [JwtModule.register({}), DatabaseModule, EventsModule],
  controllers: [DbAdminController],
  providers: [PanelAuthService, DbAdminGuard, DbAdminUsersService, PgAdminConnectionRegistry, PgAdminRolesService],
  exports: [PanelAuthService],
})
export class DbAdminModule {}
