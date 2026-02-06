import { Module } from '@nestjs/common';
import { RecommendationService } from './recommendation.service';
import { BundleIntelligenceModule } from '../bundles/bundle-intelligence.module';
import { UpsellModule } from '../upsell/upsell.module';

@Module({
  imports: [BundleIntelligenceModule, UpsellModule],
  providers: [RecommendationService],
  exports: [RecommendationService],
})
export class RecommendationModule {}
