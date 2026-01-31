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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
