import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { GeminiService } from './gemini.service';
import { GeminiAiService } from './gemini-ai.service';
import { PromptManagerModule } from '../prompts/prompt-manager.module';

@Module({
  imports: [PromptManagerModule],
  providers: [AiService, GeminiService, GeminiAiService],
  exports: [AiService, GeminiService, GeminiAiService],
})
export class AiModule {}
