import { BadRequestException, CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of, switchMap, tap, catchError, throwError } from 'rxjs';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../services/crypto.service';
import { AuthenticatedUser } from '../auth.types';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [context.getHandler(), context.getClass()]);
    if (!enabled) return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const user = req.user as AuthenticatedUser;
    const key = req.header('idempotency-key');
    if (!key || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw new BadRequestException('A valid Idempotency-Key header is required');
    const routeKey = `${req.method}:${req.baseUrl}${req.route?.path ?? req.path}`;
    const requestHash = this.crypto.bodyHash(req.body);
    return from(this.prisma.idempotencyRecord.findUnique({ where: { userId_routeKey_key: { userId: user.sub, routeKey, key } } })).pipe(
      switchMap(existing => {
        if (existing) {
          if (existing.requestHash !== requestHash) throw new ConflictException('Idempotency key reused with different payload');
          if (existing.status === 'COMPLETED') { res.status(existing.responseCode ?? 200); return of(existing.responseBody); }
          throw new ConflictException('Identical request is already being processed');
        }
        return from(this.prisma.idempotencyRecord.create({ data: {
          userId: user.sub, routeKey, key, requestHash, expiresAt: new Date(Date.now() + 24 * 3600_000),
        }})).pipe(switchMap(record => next.handle().pipe(
          tap(result => { void this.prisma.idempotencyRecord.update({ where: { id: record.id }, data: { status: 'COMPLETED', responseCode: res.statusCode, responseBody: JSON.parse(JSON.stringify(result, (_k, v) => typeof v === 'bigint' ? v.toString() : v)) } }); }),
          catchError(err => { void this.prisma.idempotencyRecord.delete({ where: { id: record.id } }).catch(() => undefined); return throwError(() => err); })
        )));
      })
    );
  }
}
