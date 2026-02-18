import { Module, forwardRef } from '@nestjs/common';
import { ContentionService } from './contention.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CalendarModule } from '../calendar/calendar.module';
import { TelegramModule } from '../telegram/telegram.module';
import { HyggloModule } from '../hygglo/hygglo.module';

@Module({
  imports: [
    PrismaModule,
    CalendarModule,
    forwardRef(() => TelegramModule),
    HyggloModule,
  ],
  providers: [ContentionService],
  exports: [ContentionService],
})
export class ContentionModule {}
