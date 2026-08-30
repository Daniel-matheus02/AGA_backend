import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../common/services/crypto.service';
import { LoginDto } from './dto';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, private readonly config: ConfigService, private readonly crypto: CryptoService) {}

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
    const adminMfaRequired = this.config.get<boolean>('ADMIN_MFA_REQUIRED');
    if ((user.mfaEnabled || (adminMfaRequired && user.role === 'ADMIN'))) {
      if (!user.mfaSecretEncrypted) throw new ForbiddenException('MFA enrollment is required');
      if (!dto.totpCode || !(await verifyOtp({ token:dto.totpCode, secret:this.crypto.decrypt(user.mfaSecretEncrypted) })).valid) throw new UnauthorizedException('Invalid MFA code');
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
    return { accessToken, refreshToken, expiresIn:this.config.getOrThrow<number>('ACCESS_TOKEN_TTL_SECONDS'), user:{ id:user.id, role:user.role, merchantId:user.merchantId }, sessionId };
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


  async beginMfa(userId:string,password:string){
    const user=await this.prisma.user.findUnique({where:{id:userId}});
    if(!user || !(await argon2.verify(user.passwordHash,password))) throw new UnauthorizedException('Invalid credentials');
    const secret=generateSecret();
    await this.prisma.user.update({where:{id:userId},data:{mfaSecretEncrypted:this.crypto.encrypt(secret),mfaEnabled:false}});
    return {secret,otpauthUrl:generateURI({ issuer:'Grupo AGA', label:user.email, secret })};
  }

  async confirmMfa(userId:string,code:string){
    const user=await this.prisma.user.findUnique({where:{id:userId}});
    if(!user?.mfaSecretEncrypted) throw new ForbiddenException('MFA enrollment has not started');
    const valid=(await verifyOtp({token:code,secret:this.crypto.decrypt(user.mfaSecretEncrypted)})).valid;
    if(!valid) throw new UnauthorizedException('Invalid MFA code');
    await this.prisma.user.update({where:{id:userId},data:{mfaEnabled:true}});
    return {enabled:true};
  }

  async disableMfa(userId:string,password:string,code:string){
    const user=await this.prisma.user.findUnique({where:{id:userId}});
    if(!user || !(await argon2.verify(user.passwordHash,password))) throw new UnauthorizedException('Invalid credentials');
    if(!user.mfaSecretEncrypted || !(await verifyOtp({token:code,secret:this.crypto.decrypt(user.mfaSecretEncrypted)})).valid) throw new UnauthorizedException('Invalid MFA code');
    await this.prisma.$transaction([
      this.prisma.user.update({where:{id:userId},data:{mfaEnabled:false,mfaSecretEncrypted:null}}),
      this.prisma.session.updateMany({where:{userId,revokedAt:null},data:{revokedAt:new Date()}}),
    ]);
    return {enabled:false,sessionsRevoked:true};
  }

  async logout(refreshToken: string) {
    try{
      const {sessionId,secret}=this.parseRefreshToken(refreshToken);
      const session=await this.prisma.session.findUnique({where:{id:sessionId}});
      if(session && await argon2.verify(session.refreshTokenHash,secret)) await this.prisma.session.update({where:{id:session.id},data:{revokedAt:new Date()}});
    }catch{/* Logout is intentionally idempotent. */}
    return {ok:true};
  }
}
