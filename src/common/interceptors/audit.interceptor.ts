import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../services/crypto.service';
import { AuthenticatedUser } from '../auth.types';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next.handle();
    const user = req.user as AuthenticatedUser | undefined;
    const sanitized = { ...(req.body ?? {}) };
    for (const key of ['password','refreshToken','token','totpCode']) if (key in sanitized) sanitized[key] = '[REDACTED]';
    return next.handle().pipe(tap({ next: () => {
      void this.prisma.auditLog.create({ data: {
        actorUserId: user?.sub,
        tenantId: user?.tenantId,
        action: `${req.method} ${req.route?.path ?? req.path}`,
        resource: req.baseUrl || req.path,
        resourceId: req.params?.id,
        requestId: req.requestId ?? 'unknown',
        ipAddress: req.ip,
        userAgent: req.header('user-agent'),
        bodyHash: this.crypto.bodyHash(sanitized),
      }}).catch(() => undefined);
    }}));
  }
}
