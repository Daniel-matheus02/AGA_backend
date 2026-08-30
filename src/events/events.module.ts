import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { OutboxPublisher } from './outbox.publisher';
@Module({ providers:[EventsService,OutboxPublisher], exports:[EventsService] })
export class EventsModule {}
