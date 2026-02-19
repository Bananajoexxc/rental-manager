import { Module } from '@nestjs/common';
import { CompetitorIntelService } from './competitor-intel.service';
import { RevenueModule } from '../revenue/revenue.module';

@Module({
  imports: [RevenueModule],
  providers: [CompetitorIntelService],
  exports: [CompetitorIntelService],
})
export class CompetitorIntelModule {}
