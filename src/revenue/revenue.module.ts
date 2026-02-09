import { Module } from '@nestjs/common';
import { RevenueService } from './revenue.service';
import { TitleParserService } from './title-parser.service';
import { HyggloModule } from '../hygglo/hygglo.module';

@Module({
  imports: [HyggloModule],
  providers: [RevenueService, TitleParserService],
  exports: [RevenueService, TitleParserService],
})
export class RevenueModule {}
