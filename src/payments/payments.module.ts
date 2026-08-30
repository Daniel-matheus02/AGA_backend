import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { PaymentProvider } from './payment-provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
@Module({imports:[EventsModule],controllers:[PaymentsController],providers:[PaymentsService,PaymentProvider]})
export class PaymentsModule{}
