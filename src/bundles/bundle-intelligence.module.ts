import { Module } from '@nestjs/common';
import { BundleIntelligenceService } from './bundle-intelligence.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [PrismaModule, CalendarModule],
  providers: [BundleIntelligenceService],
  exports: [BundleIntelligenceService],
})
export class BundleIntelligenceModule {}
