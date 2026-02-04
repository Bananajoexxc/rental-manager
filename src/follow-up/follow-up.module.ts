import { Module, forwardRef } from '@nestjs/common';
import { FollowUpService } from './follow-up.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RenterProfileModule } from '../renter-profile/renter-profile.module';
import { PlaywrightModule } from '../playwright/playwright.module';
import { TelegramModule } from '../telegram/telegram.module';
import { HyggloModule } from '../hygglo/hygglo.module';
import { AiModule } from '../ai/ai.module';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [
    PrismaModule,
    RenterProfileModule,
    PlaywrightModule,
    forwardRef(() => TelegramModule),
    HyggloModule,
    AiModule,
    CalendarModule,
  ],
  providers: [FollowUpService],
  exports: [FollowUpService],
})
export class FollowUpModule {}
