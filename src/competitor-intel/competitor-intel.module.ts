import { Module } from '@nestjs/common';
import { CompetitorIntelService } from './competitor-intel.service';

@Module({
  providers: [CompetitorIntelService],
  exports: [CompetitorIntelService],
})
export class CompetitorIntelModule {}
