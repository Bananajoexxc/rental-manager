import { Module, forwardRef } from '@nestjs/common';
import { RentalScannerService } from './rental-scanner.service';
import { HyggloModule } from '../hygglo/hygglo.module';
import { ImageAnalysisModule } from '../image-analysis/image-analysis.module';
import { AutonomousModule } from '../autonomous/autonomous.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MemoryModule } from '../memory/memory.module';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [HyggloModule, ImageAnalysisModule, forwardRef(() => AutonomousModule), forwardRef(() => TelegramModule), MemoryModule, CalendarModule],
  providers: [RentalScannerService],
  exports: [RentalScannerService],
})
export class RentalScannerModule {}
