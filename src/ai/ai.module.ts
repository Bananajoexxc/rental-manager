import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { GeminiService } from './gemini.service';
import { PromptManagerModule } from '../prompts/prompt-manager.module';

@Module({
  imports: [PromptManagerModule],
  providers: [AiService, GeminiService],
  exports: [AiService, GeminiService],
})
export class AiModule {}
