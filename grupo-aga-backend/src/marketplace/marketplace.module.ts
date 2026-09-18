import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
@Module({imports:[EventsModule],controllers:[MarketplaceController],providers:[MarketplaceService]})
export class MarketplaceModule{}
