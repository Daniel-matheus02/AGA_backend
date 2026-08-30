import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
@Module({imports:[EventsModule],controllers:[TrackingController],providers:[TrackingService]})
export class TrackingModule{}
