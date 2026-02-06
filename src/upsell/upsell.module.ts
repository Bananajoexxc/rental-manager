import { Module } from '@nestjs/common';
import { UpsellService } from './upsell.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [PrismaModule, CalendarModule],
  providers: [UpsellService],
  exports: [UpsellService],
})
export class UpsellModule {}
