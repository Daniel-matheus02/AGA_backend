import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: RedisClientType;
  readonly subscriber: RedisClientType;
  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>('REDIS_URL');
    this.client = createClient({ url });
    this.subscriber = this.client.duplicate();
    this.client.on('error', err => console.error('Redis error', err));
    this.subscriber.on('error', err => console.error('Redis subscriber error', err));
  }
  async onModuleInit() { await Promise.all([this.client.connect(), this.subscriber.connect()]); }
  async onModuleDestroy() { await Promise.allSettled([this.client.quit(), this.subscriber.quit()]); }
}
