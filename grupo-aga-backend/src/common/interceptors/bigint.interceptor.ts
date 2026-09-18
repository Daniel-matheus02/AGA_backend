import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
function normalize(value: any): any {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)]));
  }
  return value;
}
@Injectable()
export class BigIntInterceptor implements NestInterceptor {
  intercept(_context:ExecutionContext,next:CallHandler):Observable<unknown>{ return next.handle().pipe(map(normalize)); }
}
