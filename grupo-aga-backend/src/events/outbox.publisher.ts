import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { randomUUID } from 'node:crypto';

@Injectable()
export class OutboxPublisher {
  private running = false;
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  @Interval(1000)
  async publishBatch() {
    if (this.running) return;
    this.running = true;
    const lockToken = randomUUID();
    const lock = await this.redis.client.set('aga:outbox:publisher-lock', lockToken, { NX: true, PX: 5000 });
    if (!lock) { this.running = false; return; }
    try {
      const events = await this.prisma.outboxEvent.findMany({
        where: { publishedAt: null, attempts: { lt: 12 } }, orderBy: { createdAt: 'asc' }, take: 50,
      });
      for (const event of events) {
        try {
          const envelope = JSON.stringify({
            id: event.id, tenantId: event.tenantId, type: event.type, aggregateType: event.aggregateType,
            aggregateId: event.aggregateId, payload: event.payload, audience: event.audience,
            occurredAt: event.createdAt.toISOString(),
          });
          await this.redis.client.xAdd('aga:events', '*', { event: envelope }, { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 100000 } });
          await this.redis.client.publish('aga:events:realtime', envelope);
          await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null } });
        } catch (error) {
          await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 }, lastError: String(error).slice(0, 1000) } });
        }
      }
    } finally {
      await this.redis.client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", { keys:['aga:outbox:publisher-lock'], arguments:[lockToken] }).catch(()=>undefined);
      this.running = false;
    }
  }
}
