import { Module } from '@nestjs/common';
import { RevenueService } from './revenue.service';
import { TitleParserService } from './title-parser.service';
import { TaxReportService } from './tax-report.service';
import { HyggloModule } from '../hygglo/hygglo.module';
import { LostRevenueModule } from '../lost-revenue/lost-revenue.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [HyggloModule, LostRevenueModule, AiModule],
  providers: [RevenueService, TitleParserService, TaxReportService],
  exports: [RevenueService, TitleParserService, TaxReportService],
})
export class RevenueModule {}
