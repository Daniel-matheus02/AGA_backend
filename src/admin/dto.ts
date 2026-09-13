import { IsEmail, IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Role, UserStatus } from '../generated/prisma/client';

export class CreateClientDto {
  @IsString() @MinLength(3) name: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) password: string;
  @IsOptional() @IsString() @MinLength(11) cpf?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) limitCents?: number;
}

export class CreateMerchantDto {
  @IsString() @MinLength(3) legalName: string;
  @IsString() @MinLength(3) tradeName: string;
  @IsString() @MinLength(11) cnpj: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) password: string;
  @IsOptional() @IsInt() @Min(0) @Max(10000) feeBps?: number;
  @IsOptional() @IsString() @MinLength(2) contactName?: string;
}

/**
 * Criação de usuário pela central administrativa. Cobre os perfis de equipe
 * (ADMIN, SUPPORT, FINANCE, TRACKING_OPERATOR) e CLIENT. MERCHANT exige dados da
 * empresa (razão social/CNPJ) e continua sendo criado por `POST /admin/merchants`.
 */
export class CreateUserDto {
  @IsString() @MinLength(3) name: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) password: string;
  @IsEnum(Role) role: Role;
  @IsOptional() @IsString() @MinLength(11) cpf?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) limitCents?: number;
}

export class ListUsersQueryDto {
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}

/**
 * Motivo da remoção (soft delete). Opcional: fica registrado no payload do
 * evento de domínio e no log de auditoria da requisição.
 */
export class BlockUserDto {
  @IsOptional() @IsString() @MinLength(3) reason?: string;
}
