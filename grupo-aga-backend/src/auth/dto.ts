import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(10) password: string;
}
export class RefreshDto { @IsString() @MinLength(40) refreshToken: string; }
export class LogoutDto { @IsString() @MinLength(40) refreshToken: string; }

/**
 * Troca de senha pelo próprio usuário autenticado (`POST /auth/change-password`).
 *
 * Diferente do painel `db-admin` (que troca a senha de terceiros e por isso não
 * exige a senha atual), aqui quem pede é o dono da conta: a senha atual é a
 * prova de posse e é obrigatória, senão um access token roubado bastaria para
 * tomar a conta.
 *
 * Mesmo mínimo de 10 caracteres do login, para que a troca nunca gere uma senha
 * que o próprio login recuse por validação.
 */
export class ChangePasswordDto {
  @IsString() @MinLength(10) @MaxLength(200) currentPassword: string;
  @IsString() @MinLength(10) @MaxLength(200) newPassword: string;
  /**
   * Derruba as *outras* sessões abertas. Padrão `true`: manter viva uma sessão
   * antiga depois da troca anularia a medida, que é justamente o que se faz
   * quando se suspeita de invasão.
   */
  @IsOptional() @IsBoolean() revokeOtherSessions?: boolean;
}
