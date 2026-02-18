import { Module, forwardRef } from '@nestjs/common';
import { AutonomousService } from './autonomous.service';
import { AiModule } from '../ai/ai.module';
import { RulesModule } from '../rules/rules.module';
import { MemoryModule } from '../memory/memory.module';
import { TelegramModule } from '../telegram/telegram.module';
import { HyggloModule } from '../hygglo/hygglo.module';
import { BlacklistModule } from '../blacklist/blacklist.module';
import { DemandModule } from '../demand/demand.module';
import { CalendarModule } from '../calendar/calendar.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { ValidationModule } from '../validation/validation.module';
import { QualityScorerModule } from '../evaluation/quality-scorer.module';
import { ConversationStageModule } from '../conversation-tree/conversation-stage.module';
import { RecommendationModule } from '../recommendations/recommendation.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { VisionModule } from '../vision/vision.module';
import { RenterProfileModule } from '../renter-profile/renter-profile.module';
import { FollowUpModule } from '../follow-up/follow-up.module';
import { VerificationModule } from '../verification/verification.module';
import { RevenueModule } from '../revenue/revenue.module';
import { MarketModule } from '../market/market.module';
import { CouponModule } from '../coupon/coupon.module';
import { PlaywrightModule } from '../playwright/playwright.module';
import { ContentionModule } from '../contention/contention.module';

@Module({
  imports: [
    AiModule,
    RulesModule,
    MemoryModule,
    forwardRef(() => TelegramModule),
    HyggloModule,
    BlacklistModule,
    DemandModule,
    CalendarModule,
    DeliveryModule,
    ValidationModule,
    QualityScorerModule,
    ConversationStageModule,
    RecommendationModule,
    MonitoringModule,
    VisionModule,
    RenterProfileModule,
    FollowUpModule,
    VerificationModule,
    RevenueModule,
    MarketModule,
    CouponModule,
    PlaywrightModule,
    ContentionModule,
  ],
  providers: [AutonomousService],
  exports: [AutonomousService],
})
export class AutonomousModule {}
