import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { ProtectionController } from './protection.controller';
import { ProtectionService } from './protection.service';
@Module({imports:[EventsModule],controllers:[ProtectionController],providers:[ProtectionService]})
export class ProtectionModule{}
