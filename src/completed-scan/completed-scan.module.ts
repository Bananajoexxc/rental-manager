import { Module, forwardRef } from '@nestjs/common';
import { CompletedScanService } from './completed-scan.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HyggloModule } from '../hygglo/hygglo.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AiModule } from '../ai/ai.module';
import { RulesModule } from '../rules/rules.module';
import { MemoryModule } from '../memory/memory.module';
import { RenterProfileModule } from '../renter-profile/renter-profile.module';
import { CalendarModule } from '../calendar/calendar.module';
import { RevenueModule } from '../revenue/revenue.module';
import { ItemResolverModule } from '../item-resolver/item-resolver.module';

@Module({
  imports: [
    PrismaModule,
    HyggloModule,
    forwardRef(() => TelegramModule),
    AiModule,
    RulesModule,
    MemoryModule,
    RenterProfileModule,
    CalendarModule,
    RevenueModule,
    ItemResolverModule,
  ],
  providers: [CompletedScanService],
  exports: [CompletedScanService],
})
export class CompletedScanModule {}
