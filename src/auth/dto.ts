import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(10) password: string;
}
export class RefreshDto { @IsString() @MinLength(40) refreshToken: string; }
export class LogoutDto { @IsString() @MinLength(40) refreshToken: string; }
