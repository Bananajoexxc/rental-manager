import { Module } from '@nestjs/common';
import { LostRevenueService } from './lost-revenue.service';
import { HyggloModule } from '../hygglo/hygglo.module';

@Module({
  imports: [HyggloModule],
  providers: [LostRevenueService],
  exports: [LostRevenueService],
})
export class LostRevenueModule {}
