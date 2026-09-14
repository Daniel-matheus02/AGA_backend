import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { PanelLoginDto } from './dto';

/** Claims do token do painel. `scope` impede que ele valha como token de API. */
export interface PanelPrincipal {
  sub: string;
  email: string;
  tenantId: string;
  scope: 'db-admin-panel';
  jti: string;
}

export interface IssuedPanelToken {
  token: string;
  expiresIn: number;
  user: { id: string; name: string; email: string; role: string };
}

/**
 * Autenticação do painel de administração do banco de dados.
 *
 * Regras:
 *  - O painel inteiro fica desligado se DB_ADMIN_SETUP_KEY não estiver definida.
 *  - A chave de setup é comparada em tempo constante e vale para todos os
 *    endpoints, e não apenas para o login (defesa contra reuso indevido do
 *    token).
 *  - As credenciais são as de um usuário ADMIN/SUPPORT ativo do tenant, com o
 *    mesmo argon2 + lockout do `/auth/login`.
 *  - O token emitido é um JWT com audience própria: ele não é aceito como
 *    access token da API (e vice-versa), então o painel nunca ganha poder além
 *    do próprio painel.
 */
@Injectable()
export class PanelAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  /** Versão em HMAC-SHA256 da chave de setup, com um rótulo próprio. */
  private setupKeyDigest(key: string): Buffer {
    return createHmac('sha256', this.config.getOrThrow<string>('JWT_ACCESS_SECRET'))
      .update('aga.db-admin.setup-key:v1\u0000')
      .update(key)
      .digest();
  }

  /**
   * Compara a chave recebida com DB_ADMIN_SETUP_KEY sem short-circuit de bytes.
   * `false` (e não exceção) quando a chave não está configurada, para o
   * controller traduzir em 403 com mensagem de "não habilitado".
   */
  checkSetupKey(provided: unknown): boolean {
    const expected = this.config.get<string>('DB_ADMIN_SETUP_KEY');
    if (!expected) return false;
    if (typeof provided !== 'string' || provided.length === 0 || provided.length > 512) return false;
    return timingSafeEqual(this.setupKeyDigest(provided), this.setupKeyDigest(expected));
  }

  /** Você é o operador do painel e pode usá-lo? */
  isEnabled(): boolean {
    return Boolean(this.config.get<string>('DB_ADMIN_SETUP_KEY'));
  }

  requireEnabled() {
    if (!this.isEnabled()) {
      throw new ForbiddenException('O painel de administração do banco de dados está desabilitado. Defina DB_ADMIN_SETUP_KEY no ambiente do backend.');
    }
  }

  private get jwtOptions() {
    return {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      issuer: `${this.config.getOrThrow<string>('JWT_ISSUER')}:db-admin`,
      audience: 'aga-db-admin-panel',
      expiresIn: this.config.getOrThrow<number>('DB_ADMIN_TOKEN_TTL_MINUTES') * 60,
    };
  }

  get ttlSeconds(): number {
    return this.config.getOrThrow<number>('DB_ADMIN_TOKEN_TTL_MINUTES') * 60;
  }

  /**
   * Valida a chave de setup no lugar de uma senha de operador, para os
   * endpoints que só precisam saber "quem está chamando": nunca assinar uma
   * conexão privilegiada ao banco sem a chave.
   */
  async authenticateKeyOnly(setupKey: string): Promise<{ email: string; tenantId: string }> {
    this.requireEnabled();
    if (!this.checkSetupKey(setupKey)) throw new UnauthorizedException('Chave de setup inválida. Confira DB_ADMIN_SETUP_KEY.');
    return { email: '(chave de setup)', tenantId: '' };
  }

  /**
   * Login do operador: chave de setup + credenciais de ADMIN/SUPPORT ativo do
   * tenant, com bloqueio progressivo idêntico ao do login da API.
   */
  async login(dto: PanelLoginDto): Promise<IssuedPanelToken> {
    this.requireEnabled();
    // A chave já é entregue a cada chamada (defesa em profundidade).
    if (!this.checkSetupKey(dto.setupKey)) throw new UnauthorizedException('Chave de setup inválida. Confira DB_ADMIN_SETUP_KEY.');

    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email, tenant: { slug: this.config.getOrThrow<string>('TENANT_SLUG'), active: true } },
      include: { tenant: true },
    });
    // Mesma mensagem para "não existe" e "senha errada": nenhuma enumeração.
    if (!user) throw new UnauthorizedException('Credenciais inválidas');
    if (!['ADMIN', 'SUPPORT'].includes(user.role)) throw new ForbiddenException('Somente ADMIN ou SUPPORT podem administrar usuários do banco de dados');
    if (user.status !== 'ACTIVE') throw new ForbiddenException('Usuário não está ativo');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new UnauthorizedException('Conta temporariamente bloqueada');

    const ok = await argon2.verify(user.passwordHash, dto.password);
    if (!ok) {
      const failures = user.failedLoginCount + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: failures, lockedUntil: failures >= 5 ? new Date(Date.now() + 15 * 60_000) : null },
      });
      throw new UnauthorizedException('Credenciais inválidas');
    }

    // A senha é a única credencial além da chave de setup: não há segundo fator.
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });

    const jti = randomUUID();
    const token = await this.jwt.signAsync(
      { sub: user.id, email: user.email, tenantId: user.tenantId, scope: 'db-admin-panel', jti },
      this.jwtOptions,
    );
    return {
      token,
      expiresIn: this.ttlSeconds,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
  }

  /**
   * Valida o token e devolve o principal. Reconfere o banco a cada requisição
   * (o usuário pode ter sido removido/desativado depois do login) e recusa a
   * conexão privilegiada direta ao Postgres sem a chave de setup.
   */
  async verifyPanelToken(panelToken: string, requireSetupKey: boolean, setupKey?: string): Promise<PanelPrincipal> {
    this.requireEnabled();
    if (requireSetupKey && !this.checkSetupKey(setupKey)) {
      throw new UnauthorizedException('Chave de setup inválida para conexão ao PostgreSQL.');
    }
    let payload: PanelPrincipal;
    try {
      payload = await this.jwt.verifyAsync<PanelPrincipal>(panelToken, this.jwtOptions);
    } catch {
      throw new UnauthorizedException('Sessão do painel expirada ou inválida. Entre novamente.');
    }
    if (payload.scope !== 'db-admin-panel') throw new UnauthorizedException('Token inválido para o painel');
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, tenantId: true, email: true, role: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE' || !['ADMIN', 'SUPPORT'].includes(user.role)) {
      throw new UnauthorizedException('Sessão do painel não é mais válida');
    }
    return { ...payload, tenantId: user.tenantId, email: user.email };
  }

  /** JTI aleatório usado como chave do cache de conexões do operador. */
  operatorKey(principal: PanelPrincipal): string {
    return `${principal.sub}:${principal.jti}`;
  }
}
