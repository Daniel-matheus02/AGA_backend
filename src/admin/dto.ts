import { IsEmail, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

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
