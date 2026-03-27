import { Module, forwardRef } from '@nestjs/common';
import { RentalScannerService } from './rental-scanner.service';
import { HyggloModule } from '../hygglo/hygglo.module';
import { ImageAnalysisModule } from '../image-analysis/image-analysis.module';
import { AutonomousModule } from '../autonomous/autonomous.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MemoryModule } from '../memory/memory.module';
import { CalendarModule } from '../calendar/calendar.module';
import { RenterProfileModule } from '../renter-profile/renter-profile.module';
import { FollowUpModule } from '../follow-up/follow-up.module';
import { VerificationModule } from '../verification/verification.module';
import { RevenueModule } from '../revenue/revenue.module';
import { ContentionModule } from '../contention/contention.module';
import { ItemResolverModule } from '../item-resolver/item-resolver.module';

@Module({
  imports: [
    HyggloModule,
    ImageAnalysisModule,
    forwardRef(() => AutonomousModule),
    forwardRef(() => TelegramModule),
    MemoryModule,
    CalendarModule,
    RenterProfileModule,
    FollowUpModule,
    VerificationModule,
    RevenueModule,
    ContentionModule,
    ItemResolverModule,
  ],
  providers: [RentalScannerService],
  exports: [RentalScannerService],
})
export class RentalScannerModule {}
