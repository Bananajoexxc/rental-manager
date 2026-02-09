import { Module, forwardRef } from '@nestjs/common';
import { MarketService } from './market.service';
import { MarketReleasesService } from './market-releases.service';
import { AiModule } from '../ai/ai.module';
import { TelegramModule } from '../telegram/telegram.module';
import { RevenueModule } from '../revenue/revenue.module';

@Module({
  imports: [AiModule, forwardRef(() => TelegramModule), RevenueModule],
  providers: [MarketService, MarketReleasesService],
  exports: [MarketService, MarketReleasesService],
})
export class MarketModule {}
