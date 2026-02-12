import { Module, forwardRef } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RentalScannerModule } from '../rental-scanner/rental-scanner.module';
import { AiModule } from '../ai/ai.module';
import { RulesModule } from '../rules/rules.module';
import { MemoryModule } from '../memory/memory.module';
import { CalendarModule } from '../calendar/calendar.module';
import { BlacklistModule } from '../blacklist/blacklist.module';
import { DemandModule } from '../demand/demand.module';
import { RevenueModule } from '../revenue/revenue.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { MarketModule } from '../market/market.module';
import { RemindersModule } from '../reminders/reminders.module';
import { HyggloModule } from '../hygglo/hygglo.module';
import { ValidationModule } from '../validation/validation.module';
import { QualityScorerModule } from '../evaluation/quality-scorer.module';
import { ConversationStageModule } from '../conversation-tree/conversation-stage.module';
import { RecommendationModule } from '../recommendations/recommendation.module';
import { AutolearnModule } from '../autolearn/autolearn.module';
import { LostRevenueModule } from '../lost-revenue/lost-revenue.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => RentalScannerModule),
    AiModule,
    RulesModule,
    MemoryModule,
    CalendarModule,
    BlacklistModule,
    DemandModule,
    RevenueModule,
    DeliveryModule,
    forwardRef(() => MarketModule),
    forwardRef(() => RemindersModule),
    HyggloModule,
    ValidationModule,
    QualityScorerModule,
    ConversationStageModule,
    RecommendationModule,
    forwardRef(() => AutolearnModule),
    LostRevenueModule,
  ],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
