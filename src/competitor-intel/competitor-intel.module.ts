import { Module } from '@nestjs/common';
import { CompetitorIntelService } from './competitor-intel.service';
import { RevenueModule } from '../revenue/revenue.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [RevenueModule, AiModule],
  providers: [CompetitorIntelService],
  exports: [CompetitorIntelService],
})
export class CompetitorIntelModule {}
