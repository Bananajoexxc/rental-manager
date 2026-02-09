import { Module, Global } from '@nestjs/common';
import { ItemMatcherAiService } from './item-matcher-ai.service';

@Global()
@Module({
  providers: [ItemMatcherAiService],
  exports: [ItemMatcherAiService],
})
export class ItemMatcherAiModule {}
