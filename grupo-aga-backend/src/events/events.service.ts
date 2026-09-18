import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

type Tx = Prisma.TransactionClient;
export interface DomainEventInput {
  tenantId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.InputJsonValue;
  audience: string[];
}

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}
  append(input: DomainEventInput, tx?: Tx) {
    const db = tx ?? this.prisma;
    return db.outboxEvent.create({ data: { ...input, audience: input.audience } });
  }
}
