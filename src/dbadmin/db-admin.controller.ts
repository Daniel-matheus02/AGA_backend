import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { DbAdminGuard, PanelRequest } from './db-admin.guard';
import { PanelAuthService, PanelPrincipal } from './panel-auth.service';
import { DbAdminUsersService } from './db-admin-users.service';
import { PgAdminRolesService } from './pg-admin-roles.service';
import {
  BlockUserDto,
  ChangePasswordDto,
  CreateAppUserDto,
  DeleteUserDto,
  DropPgRoleDto,
  PanelLoginDto,
  PanelTokenDto,
  PgAlterRoleDto,
  PgConnectionDto,
  PgCreateRoleDto,
  PgRenameRoleDto,
  SetPgPasswordDto,
  UpdateAppUserDto,
} from './dto';

/**
 * API de administração do banco de dados — **somente JSON**.
 *
 * A interface é um projeto separado (`frontend_user_manager`), que fala com
 * esta API. Por isso aqui não há HTML: só endpoints, e o frontend precisa da
 * origem dele liberada em CORS (`CORS_ORIGINS`).
 *
 * Todas as rotas são @Public() para os guards globais da API (JwtAuthGuard e
 * RolesGuard) não exigirem o JWT da aplicação: quem autentica aqui é o
 * DbAdminGuard, com a chave de setup (DB_ADMIN_SETUP_KEY) + o token do painel.
 *
 * Consequência importante: o AuditInterceptor global não registra estas
 * requisições, porque não há `req.user`. A trilha de auditoria do painel é
 * escrita pelos próprios serviços (AuditLog + OutboxEvent).
 */
@ApiTags('db-admin')
@Public()
@Controller('db-admin')
export class DbAdminController {
  constructor(
    private readonly panelAuth: PanelAuthService,
    private readonly users: DbAdminUsersService,
    private readonly pgRoles: PgAdminRolesService,
  ) {}

  /** Metadados públicos: a interface usa para saber se o painel está ligado. */
  @Get('meta')
  meta() {
    return { enabled: this.panelAuth.isEnabled(), ttlSeconds: this.panelAuth.ttlSeconds };
  }

  @Post('auth/login')
  async login(@Body() dto: PanelLoginDto) {
    const issued = await this.panelAuth.login(dto);
    return { ...issued, ttlSeconds: issued.expiresIn };
  }

  /** Quem está logado, para a interface restaurar a sessão ao recarregar. */
  @UseGuards(DbAdminGuard)
  @Post('auth/session')
  session(@Req() req: PanelRequest, @Body() _dto: PanelTokenDto) {
    return { user: this.publicSession(req.panel!), ttlSeconds: this.panelAuth.ttlSeconds };
  }

  @UseGuards(DbAdminGuard)
  @Post('auth/logout')
  logout(@Body() _dto: PanelTokenDto) {
    // O token é stateless e morre no TTL: a interface simplesmente o descarta.
    // Ainda assim exigimos o guard, para que a rota não vire um oráculo.
    return { ok: true };
  }

  // --- Usuários da aplicação -------------------------------------------------

  @UseGuards(DbAdminGuard)
  @Get('users')
  listUsers(
    @Req() req: PanelRequest,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    // A query string não carrega segredo nenhum: só filtros. A identidade vem
    // do guard (chave de setup + token do painel no corpo/cabeçalho).
    return this.users.listUsers(this.actor(req), { role: role as never, status: status as never, search });
  }

  @UseGuards(DbAdminGuard)
  @Get('merchants')
  listMerchants(@Req() req: PanelRequest) {
    return this.users.listMerchants(this.actor(req));
  }

  @UseGuards(DbAdminGuard)
  @Get('users/:id')
  getUser(@Req() req: PanelRequest, @Param('id') id: string) {
    return this.users.getUser(this.actor(req), id);
  }

  @UseGuards(DbAdminGuard)
  @Post('users')
  createUser(@Req() req: PanelRequest, @Body() dto: CreateAppUserDto) {
    return this.users.createUser(this.actor(req), dto);
  }

  @UseGuards(DbAdminGuard)
  @Patch('users/:id')
  updateUser(@Req() req: PanelRequest, @Param('id') id: string, @Body() dto: UpdateAppUserDto) {
    return this.users.updateUser(this.actor(req), id, dto);
  }

  @UseGuards(DbAdminGuard)
  @Post('users/:id/password')
  changePassword(@Req() req: PanelRequest, @Param('id') id: string, @Body() dto: ChangePasswordDto) {
    return this.users.changePassword(this.actor(req), id, dto);
  }

  @UseGuards(DbAdminGuard)
  @Post('users/:id/unlock')
  unlockUser(@Req() req: PanelRequest, @Param('id') id: string, @Body() dto: PanelTokenDto) {
    return this.users.unlockUser(this.actor(req), id);
  }

  /** Remoção lógica (BLOCKED + sessões revogadas). */
  @UseGuards(DbAdminGuard)
  @Delete('users/:id')
  blockUser(@Req() req: PanelRequest, @Param('id') id: string, @Body() dto: BlockUserDto) {
    return this.users.blockUser(this.actor(req), id, { reason: dto.reason });
  }

  @UseGuards(DbAdminGuard)
  @Post('users/:id/restore')
  restoreUser(@Req() req: PanelRequest, @Param('id') id: string, @Body() _dto: PanelTokenDto) {
    return this.users.restoreUser(this.actor(req), id);
  }

  /**
   * Exclusão definitiva. Sem `force` devolve o relatório de dependências; com
   * `force: true` apaga em cascata (e recusa se houver histórico financeiro).
   */
  @UseGuards(DbAdminGuard)
  @Post('users/:id/delete')
  deleteUser(@Req() req: PanelRequest, @Param('id') id: string, @Body() dto: DeleteUserDto) {
    return this.users.deleteUser(this.actor(req), id, dto);
  }

  // --- Papéis do PostgreSQL --------------------------------------------------

  @UseGuards(DbAdminGuard)
  @Post('pg/connect')
  async pgConnect(@Req() req: PanelRequest, @Body() dto: PgConnectionDto) {
    return this.pgRoles.connect(this.connectionKey(req), dto.connectionString);
  }

  @UseGuards(DbAdminGuard)
  @Post('pg/disconnect')
  pgDisconnect(@Req() req: PanelRequest, @Body() _dto: PanelTokenDto) {
    return this.pgRoles.disconnect(this.connectionKey(req));
  }

  @UseGuards(DbAdminGuard)
  @Post('pg/roles')
  async pgListRoles(@Req() req: PanelRequest, @Body() _dto: PanelTokenDto) {
    const key = this.connectionKey(req);
    return this.pgRoles.listRoles(key);
  }

  @UseGuards(DbAdminGuard)
  @Post('pg/roles/:name/inspect')
  pgInspectRole(@Req() req: PanelRequest, @Param('name') name: string) {
    return this.pgRoles.describeRole(this.connectionKey(req), name);
  }

  @UseGuards(DbAdminGuard)
  @Post('pg/roles/create')
  pgCreateRole(@Req() req: PanelRequest, @Body() dto: PgCreateRoleDto) {
    return this.pgRoles.createRole(this.connectionKey(req), this.actor(req), dto);
  }

  @UseGuards(DbAdminGuard)
  @Patch('pg/roles/:name')
  pgAlterRole(@Req() req: PanelRequest, @Param('name') name: string, @Body() dto: PgAlterRoleDto) {
    return this.pgRoles.alterRole(this.connectionKey(req), this.actor(req), name, dto);
  }

  @UseGuards(DbAdminGuard)
  @Post('pg/roles/:name/rename')
  pgRenameRole(@Req() req: PanelRequest, @Param('name') name: string, @Body() dto: PgRenameRoleDto) {
    return this.pgRoles.renameRole(this.connectionKey(req), this.actor(req), name, dto);
  }

  @UseGuards(DbAdminGuard)
  @Post('pg/roles/:name/password')
  pgSetPassword(@Req() req: PanelRequest, @Param('name') name: string, @Body() dto: SetPgPasswordDto) {
    return this.pgRoles.setPassword(this.connectionKey(req), this.actor(req), name, dto.newPassword);
  }

  /** Sem `force` devolve o relatório; com `force: true` executa o DROP. */
  @UseGuards(DbAdminGuard)
  @Post('pg/roles/:name/drop')
  pgDropRole(@Req() req: PanelRequest, @Param('name') name: string, @Body() dto: DropPgRoleDto) {
    return this.pgRoles.dropRole(this.connectionKey(req), this.actor(req), name, dto.force === true);
  }

  // --- Internos --------------------------------------------------------------

  private actor(req: PanelRequest) {
    const panel = req.panel!;
    return { sub: panel.sub, email: panel.email, tenantId: panel.tenantId };
  }

  /** Conexões do Postgres são isoladas por sessão do painel (jti do token). */
  private connectionKey(req: PanelRequest): string {
    return this.panelAuth.operatorKey(req.panel!);
  }

  private publicSession(panel: PanelPrincipal) {
    return { id: panel.sub, email: panel.email, tenantId: panel.tenantId, scope: panel.scope };
  }
}
