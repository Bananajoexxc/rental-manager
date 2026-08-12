import { Module, Global } from '@nestjs/common';
import { ItemMatcherAiService } from './item-matcher-ai.service';
import { AiModule } from '../ai/ai.module';

@Global()
@Module({
  imports: [AiModule],
  providers: [ItemMatcherAiService],
  exports: [ItemMatcherAiService],
})
export class ItemMatcherAiModule {}
