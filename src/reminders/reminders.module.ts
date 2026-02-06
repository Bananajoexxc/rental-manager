import { Module, forwardRef } from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { TelegramModule } from '../telegram/telegram.module';
import { CalendarModule } from '../calendar/calendar.module';
import { MemoryModule } from '../memory/memory.module';
import { RevenueModule } from '../revenue/revenue.module';
import { HyggloModule } from '../hygglo/hygglo.module';

@Module({
  imports: [forwardRef(() => TelegramModule), CalendarModule, MemoryModule, RevenueModule, HyggloModule],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
