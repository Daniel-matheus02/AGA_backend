import { Module } from '@nestjs/common';
import { CreditController } from './credit.controller';
import { CreditService } from './credit.service';
import { EventsModule } from '../events/events.module';
@Module({imports:[EventsModule],controllers:[CreditController],providers:[CreditService]})
export class CreditModule{}
