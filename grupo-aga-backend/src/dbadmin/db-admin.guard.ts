import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { PanelAuthService, PanelPrincipal } from './panel-auth.service';

/** Pedido autenticado pelo painel: o principal fica disponível nos handlers. */
export interface PanelRequest extends Request {
  panel?: PanelPrincipal;
  panelSetupKey?: string;
}

/** Extrai a chave de setup do corpo, do header `x-aga-setup-key` ou da query. */
export function readSetupKey(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body?.setupKey;
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
  const header = req.header('x-aga-setup-key');
  if (header && header.length > 0) return header;
  const query = req.query?.setupKey;
  return typeof query === 'string' && query.length > 0 ? query : undefined;
}

/** Extrai o token do painel do corpo ou do header `x-panel-token`. */
export function readPanelToken(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body?.panelToken;
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
  const header = req.header('x-panel-token');
  return header && header.length > 0 ? header : undefined;
}

/**
 * Guard do painel. Diferente do JwtAuthGuard da API: aqui a autenticação é a
 * chave de setup (DB_ADMIN_SETUP_KEY) somada ao token do painel, e não ao JWT
 * de sessão da aplicação. As rotas já são declaradas @Public() para que os
 * guards globais da API (JwtAuthGuard/RolesGuard) não intervenham.
 */
@Injectable()
export class DbAdminGuard implements CanActivate {
  constructor(private readonly panelAuth: PanelAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PanelRequest>();
    // Painel desabilitado: 403 antes de olhar qualquer credencial.
    this.panelAuth.requireEnabled();

    const setupKey = readSetupKey(req);
    if (!this.panelAuth.checkSetupKey(setupKey)) {
      throw new ForbiddenException('Chave de setup inválida ou ausente. Informe DB_ADMIN_SETUP_KEY para usar o painel.');
    }

    const token = readPanelToken(req);
    if (!token) throw new UnauthorizedException('Token do painel ausente. Entre novamente.');

    // requireSetupKey: o guard já validou a chave acima; repetimos a checagem no
    // serviço antes de qualquer operação no PostgreSQL.
    req.panel = await this.panelAuth.verifyPanelToken(token, true, setupKey);
    req.panelSetupKey = setupKey;
    return true;
  }
}
