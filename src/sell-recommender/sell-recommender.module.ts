import { Module } from '@nestjs/common';
import { SellRecommenderService } from './sell-recommender.service';
import { RevenueModule } from '../revenue/revenue.module';
import { LostRevenueModule } from '../lost-revenue/lost-revenue.module';

@Module({
  imports: [RevenueModule, LostRevenueModule],
  providers: [SellRecommenderService],
  exports: [SellRecommenderService],
})
export class SellRecommenderModule {}
