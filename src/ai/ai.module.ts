import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { GeminiService } from './gemini.service';
import { PromptManagerModule } from '../prompts/prompt-manager.module';

// Conditionally load OpenAI service only when AI_PROVIDER=openai
const conditionalProviders = [];
if (process.env.AI_PROVIDER === 'openai') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OpenAiAiService } = require('./openai-ai.service');
  conditionalProviders.push(OpenAiAiService);
}

@Module({
  imports: [PromptManagerModule],
  providers: [AiService, GeminiService, ...conditionalProviders],
  exports: [AiService, GeminiService, ...conditionalProviders],
})
export class AiModule {}
