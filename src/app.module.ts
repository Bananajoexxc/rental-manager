import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { HyggloModule } from './hygglo/hygglo.module';
import { RentalScannerModule } from './rental-scanner/rental-scanner.module';
import { ImageAnalysisModule } from './image-analysis/image-analysis.module';
import { LoggingModule } from './logging/logging.module';
import { TelegramModule } from './telegram/telegram.module';
import { AiModule } from './ai/ai.module';
import { RulesModule } from './rules/rules.module';
import { MemoryModule } from './memory/memory.module';
import { AutonomousModule } from './autonomous/autonomous.module';
import { CalendarModule } from './calendar/calendar.module';
import { BlacklistModule } from './blacklist/blacklist.module';
import { DemandModule } from './demand/demand.module';
import { RevenueModule } from './revenue/revenue.module';
import { RemindersModule } from './reminders/reminders.module';
import { DeliveryModule } from './delivery/delivery.module';
import { MarketModule } from './market/market.module';
import { ValidationModule } from './validation/validation.module';
import { QualityScorerModule } from './evaluation/quality-scorer.module';
import { PromptManagerModule } from './prompts/prompt-manager.module';
import { BundleIntelligenceModule } from './bundles/bundle-intelligence.module';
import { ConversationStageModule } from './conversation-tree/conversation-stage.module';
import { UpsellModule } from './upsell/upsell.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { VisionModule } from './vision/vision.module';
import { DspyModule } from './dspy/dspy.module';
import { PlaywrightModule } from './playwright/playwright.module';
import { RenterProfileModule } from './renter-profile/renter-profile.module';
import { FollowUpModule } from './follow-up/follow-up.module';
import { VerificationModule } from './verification/verification.module';
import { CompletedScanModule } from './completed-scan/completed-scan.module';
import { AutolearnModule } from './autolearn/autolearn.module';
import { LostRevenueModule } from './lost-revenue/lost-revenue.module';
import { CompetitorIntelModule } from './competitor-intel/competitor-intel.module';
import { CouponModule } from './coupon/coupon.module';
import { ItemMatcherAiModule } from './item-matcher-ai/item-matcher-ai.module';
import { SellRecommenderModule } from './sell-recommender/sell-recommender.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    MonitoringModule,
    VisionModule,
    PrismaModule,
    HyggloModule,
    RentalScannerModule,
    ImageAnalysisModule,
    LoggingModule,
    TelegramModule,
    AiModule,
    RulesModule,
    MemoryModule,
    AutonomousModule,
    CalendarModule,
    BlacklistModule,
    DemandModule,
    RevenueModule,
    RemindersModule,
    DeliveryModule,
    MarketModule,
    ValidationModule,
    QualityScorerModule,
    PromptManagerModule,
    BundleIntelligenceModule,
    ConversationStageModule,
    UpsellModule,
    DspyModule,
    PlaywrightModule,
    RenterProfileModule,
    FollowUpModule,
    VerificationModule,
    CompletedScanModule,
    AutolearnModule,
    LostRevenueModule,
    CompetitorIntelModule,
    CouponModule,
    ItemMatcherAiModule,
    SellRecommenderModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
