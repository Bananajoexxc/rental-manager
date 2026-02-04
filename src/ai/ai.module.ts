import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { PromptManagerModule } from '../prompts/prompt-manager.module';

@Module({
  imports: [PromptManagerModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
