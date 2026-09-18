import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AuthenticatedUser } from '../common/auth.types';
import { AuthEventsService } from './auth-events.service';
import { ChangePasswordDto, LoginDto } from './dto';

// Mesmos parâmetros do seed e do login: a senha trocada aqui tem exatamente o
// mesmo custo de argon2id das demais.
const PASSWORD_HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, private readonly config: ConfigService, private readonly authEvents: AuthEventsService) {}

  async login(dto: LoginDto, ip?: string, userAgent?: string) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({ where: { email, tenant:{slug:this.config.getOrThrow<string>('TENANT_SLUG'),active:true} }, include: { tenant:true } });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (user.status !== 'ACTIVE') throw new ForbiddenException('User is not active');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new UnauthorizedException('Account temporarily locked');
    const ok = await argon2.verify(user.passwordHash, dto.password);
    if (!ok) {
      const failures = user.failedLoginCount + 1;
      await this.prisma.user.update({ where:{id:user.id}, data:{ failedLoginCount:failures, lockedUntil: failures >= 5 ? new Date(Date.now()+15*60_000) : null } });
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.prisma.user.update({ where:{id:user.id}, data:{ failedLoginCount:0, lockedUntil:null } });
    const issued = await this.issueSession(user, ip, userAgent);
    const { sessionId: _sessionId, ...response } = issued;
    return response;
  }

  private async issueSession(user: {id:string;tenantId:string;role:any;merchantId:string|null;email:string}, ip?:string, userAgent?:string) {
    const sessionId = randomUUID();
    const refreshSecret = randomBytes(48).toString('base64url');
    const refreshToken = `${sessionId}.${refreshSecret}`;
    const refreshTokenHash = await argon2.hash(refreshSecret, { type:argon2.argon2id, memoryCost:65536, timeCost:3, parallelism:1 });
    const expiresAt = new Date(Date.now()+this.config.getOrThrow<number>('REFRESH_TOKEN_TTL_DAYS')*86400_000);
    await this.prisma.session.create({ data:{ id:sessionId, userId:user.id, refreshTokenHash, expiresAt, ipAddress:ip, userAgent } });
    const accessToken = await this.jwt.signAsync({
      sub:user.id, tenantId:user.tenantId, role:user.role, merchantId:user.merchantId, sessionId, email:user.email,
    }, { secret:this.config.getOrThrow('JWT_ACCESS_SECRET'), issuer:this.config.getOrThrow('JWT_ISSUER'), audience:this.config.getOrThrow('JWT_AUDIENCE'), expiresIn:this.config.getOrThrow<number>('ACCESS_TOKEN_TTL_SECONDS') });
    // O `user` da resposta é intencionalmente mínimo (sem hash, sem status, sem
    // tenant). Incluímos `email` porque o app precisa exibir quem está logado, e
    // a fonte da verdade é o registro em `User` — nunca o que o cliente enviou.
    return { accessToken, refreshToken, expiresIn:this.config.getOrThrow<number>('ACCESS_TOKEN_TTL_SECONDS'), user:{ id:user.id, role:user.role, merchantId:user.merchantId, email:user.email }, sessionId };
  }

  private parseRefreshToken(refreshToken:string){
    const [sessionId, secret, extra] = refreshToken.split('.');
    if(!sessionId || !secret || extra || !/^[0-9a-f-]{36}$/i.test(sessionId) || secret.length < 40) throw new UnauthorizedException('Invalid refresh token');
    return {sessionId,secret};
  }

  async refresh(refreshToken: string, ip?:string, userAgent?:string) {
    const {sessionId,secret}=this.parseRefreshToken(refreshToken);
    const session=await this.prisma.session.findUnique({where:{id:sessionId},include:{user:true}});
    if(!session || !(await argon2.verify(session.refreshTokenHash,secret))) throw new UnauthorizedException('Invalid refresh token');
    if(session.revokedAt){
      await this.prisma.session.updateMany({where:{userId:session.userId,revokedAt:null},data:{revokedAt:new Date()}});
      throw new UnauthorizedException('Refresh token reuse detected; all sessions revoked');
    }
    if(session.expiresAt<=new Date() || session.user.status!=='ACTIVE') throw new UnauthorizedException('Refresh token expired');
    const replacement=await this.issueSession(session.user,ip,userAgent);
    await this.prisma.session.update({where:{id:session.id},data:{revokedAt:new Date(),replacedById:replacement.sessionId,lastUsedAt:new Date()}});
    const {sessionId:_replacementSessionId,...response}=replacement;
    return response;
  }


  async logout(refreshToken: string) {
    try{
      const {sessionId,secret}=this.parseRefreshToken(refreshToken);
      const session=await this.prisma.session.findUnique({where:{id:sessionId}});
      if(session && await argon2.verify(session.refreshTokenHash,secret)) await this.prisma.session.update({where:{id:session.id},data:{revokedAt:new Date()}});
    }catch{/* Logout is intentionally idempotent. */}
    return {ok:true};
  }

  /**
   * Perfil do usuário autenticado, lido do banco.
   *
   * O app não deve deduzir identidade a partir do que ele mesmo enviou no login
   * (ou de um payload de token): quem responde por email, nome e papel é o
   * registro em `User`. Usamos um `select` explícito para que o `passwordHash`
   * jamais entre na resposta, mesmo que alguém adicione campos ao modelo.
   */
  async me(user: AuthenticatedUser) {
    const found = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { id: true, name: true, email: true, role: true, merchantId: true, status: true },
    });
    // Sem registro (ou de outro tenant que o token não alcança): não vaza existência.
    if (!found || found.status !== 'ACTIVE') throw new UnauthorizedException('Session is no longer valid');
    return found;
  }

  /**
   * Troca a senha do próprio usuário autenticado.
   *
   * A senha atual é exigida como prova de posse: sem ela, um access token
   * roubado (ou um celular desbloqueado) bastaria para tomar a conta. A sessão
   * de quem pediu **sobrevive** — derrubá-la expulsaria o usuário do app logo
   * depois de uma ação legítima —, mas as outras caem, que é o ponto de trocar
   * a senha quando se suspeita de invasão.
   */
  async changePassword(user: AuthenticatedUser, dto: ChangePasswordDto) {
    const target = await this.prisma.user.findUnique({ where: { id: user.sub } });
    if (!target) throw new UnauthorizedException('Invalid credentials');
    // Mesma mensagem do login: não damos um oráculo de senha por um endpoint
    // que o atacante só alcança já autenticado.
    if (!(await argon2.verify(target.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordHash = await argon2.hash(dto.newPassword, PASSWORD_HASH_OPTIONS);
    const revokeOthers = dto.revokeOtherSessions !== false;

    const result = await this.prisma.$transaction(async (tx) => {
      // `updateMany` não aceita `select`: lemos os ids antes para poder avisar
      // cada sessionId no outbox, e só então revogamos.
      const otherSessions = revokeOthers
        ? await tx.session.findMany({
            where: { userId: target.id, revokedAt: null, id: { not: user.sessionId } },
            select: { id: true },
          })
        : [];
      if (otherSessions.length > 0) {
        await tx.session.updateMany({
          where: { id: { in: otherSessions.map((s) => s.id) } },
          data: { revokedAt: new Date() },
        });
      }
      await tx.user.update({
        where: { id: target.id },
        // Zera tentativas e desbloqueia: a senha nova precisa funcionar já.
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      });
      return otherSessions.map((s) => s.id);
    });

    if (result.length > 0) {
      await this.authEvents.publishSessionRevoked({
        tenantId: user.tenantId,
        userId: target.id,
        reason: 'password-changed',
        sessionIds: result,
      });
    }

    return { ok: true, revokedSessions: result.length, sessionsRevoked: revokeOthers };
  }
}
