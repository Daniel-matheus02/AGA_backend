import { IsEmail, IsOptional, IsString, Length, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(10) password: string;
  @IsOptional() @IsString() @Length(6, 8) totpCode?: string;
}
export class RefreshDto { @IsString() @MinLength(40) refreshToken: string; }
export class LogoutDto { @IsString() @MinLength(40) refreshToken: string; }
export class MfaEnrollDto { @IsString() @MinLength(10) password:string; }
export class MfaConfirmDto { @IsString() @Length(6,8) code:string; }
export class MfaDisableDto { @IsString() @MinLength(10) password:string; @IsString() @Length(6,8) code:string; }
