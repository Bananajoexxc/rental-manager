import { Module, forwardRef } from '@nestjs/common';
import { MarketService } from './market.service';
import { AiModule } from '../ai/ai.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [AiModule, forwardRef(() => TelegramModule)],
  providers: [MarketService],
  exports: [MarketService],
})
export class MarketModule {}
