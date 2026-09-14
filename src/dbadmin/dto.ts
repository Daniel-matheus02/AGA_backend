import { IsBoolean, IsEmail, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Role, UserStatus } from '../generated/prisma/client';

/**
 * Todo endpoint do painel exige a `setupKey` no corpo (nunca na query string,
 * que vaza em logs de proxy). A chave é comparada com DB_ADMIN_SETUP_KEY em
 * tempo constante antes de qualquer outra validação de negócio.
 */
export class PanelSetupKeyDto {
  @IsString() @MinLength(1) @MaxLength(512) setupKey: string;
}

export class PanelLoginDto extends PanelSetupKeyDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) @MaxLength(512) password: string;
}

/**
 * Token do painel.
 *
 * O `DbAdminGuard` o lê do corpo OU do cabeçalho `x-panel-token`, e o frontend
 * usa o cabeçalho. Por isso o campo é OPCIONAL aqui: exigi-lo no corpo fazia o
 * ValidationPipe global (`forbidNonWhitelisted: true`) responder 400 em toda
 * chamada autenticada por cabeçalho — o corpo `{}` do `auth/session`, por
 * exemplo, era recusado antes mesmo de o handler rodar.
 *
 * A checagem de presença continua acontecendo, no guard: sem token no corpo e
 * sem token no cabeçalho ele responde 401.
 */
export class PanelTokenDto {
  @IsOptional() @IsString() @MinLength(16) @MaxLength(4096) panelToken?: string;
}

// --- Usuários da aplicação (tabela User do Prisma) ---------------------------

export class ListAppUsersQueryDto extends PanelTokenDto {
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  /** Busca por nome ou e-mail (case-insensitive, contém). */
  @IsOptional() @IsString() @MaxLength(160) search?: string;
}

export class CreateAppUserDto extends PanelTokenDto {
  @IsString() @MinLength(3) @MaxLength(160) name: string;
  @IsEmail() @MaxLength(255) email: string;
  @IsString() @MinLength(8) @MaxLength(200) password: string;
  @IsEnum(Role) role: Role;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}

/**
 * Edição do cadastro. Campo ausente = não mexe; `null` explícito em
 * `merchantId` desvincula o usuário do lojista.
 */
export class UpdateAppUserDto extends PanelTokenDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(160) name?: string;
  @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsString() @MaxLength(64) merchantId?: string | null;
}

export class ChangePasswordDto extends PanelTokenDto {
  @IsString() @MinLength(8) @MaxLength(200) newPassword: string;
  /**
   * Opt-in: derruba todas as sessões abertas do usuário. Padrão `true`, porque
   * manter o invasor logado depois de trocar a senha anula a troca.
   */
  @IsOptional() @IsBoolean() revokeSessions?: boolean;
}

export class UnlockUserDto extends PanelTokenDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(280) reason?: string;
}

export class BlockUserDto extends PanelTokenDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(280) reason?: string;
}

/**
 * Exclusão definitiva. O endpoint primeiro devolve um relatório de dependências
 * (400) sem apagar nada; só com `force: true` a exclusão em cascata acontece.
 */
export class DeleteUserDto extends PanelTokenDto {
  @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(280) reason?: string;
}

export class UserIdDto extends PanelTokenDto {
  @IsString() @MinLength(1) @MaxLength(64) userId: string;
}

// --- Papéis do PostgreSQL ----------------------------------------------------

export class PgConnectionDto extends PanelTokenDto {
  /**
   * Connection string completa (`postgresql://usuario:senha@host:5432/banco`).
   * Fica somente em memória no servidor, com TTL curto — nunca é persistida nem
   * devolvida pela API.
   */
  @IsString() @MinLength(20) @MaxLength(2048) connectionString: string;
}

export class PgCreateRoleDto extends PgConnectionDto {
  @IsString() @Matches(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/, { message: 'roleName inválido: use letras, números e _ (até 63 caracteres)' }) roleName: string;
  @IsString() @MinLength(8) @MaxLength(200) password: string;
  /** LOGIN permite conectar; sem login o papel serve só como grupo de permissões. */
  @IsOptional() @IsBoolean() canLogin?: boolean;
  @IsOptional() @IsBoolean() superuser?: boolean;
  @IsOptional() @IsBoolean() createDb?: boolean;
  @IsOptional() @IsBoolean() createRole?: boolean;
  @IsOptional() @IsInt() @Min(-1) @Max(100_000) connectionLimit?: number;
  @IsOptional() @IsString() @MaxLength(100) validUntil?: string;
}

export class PgAlterRoleDto extends PgConnectionDto {
  @IsOptional() @IsBoolean() canLogin?: boolean;
  @IsOptional() @IsBoolean() superuser?: boolean;
  @IsOptional() @IsBoolean() createDb?: boolean;
  @IsOptional() @IsBoolean() createRole?: boolean;
  @IsOptional() @IsInt() @Min(-1) @Max(100_000) connectionLimit?: number;
}

export class PgRenameRoleDto extends PgConnectionDto {
  @IsString() @Matches(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/, { message: 'newRoleName inválido: use letras, números e _ (até 63 caracteres)' }) newRoleName: string;
}

export class SetPgPasswordDto extends PgConnectionDto {
  @IsString() @MinLength(8) @MaxLength(200) newPassword: string;
}

/** Sem `force`, a API só devolve o relatório de dependências do papel. */
export class DropPgRoleDto extends PgConnectionDto {
  @IsOptional() @IsBoolean() force?: boolean;
}
