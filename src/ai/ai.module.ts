import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { PromptManagerModule } from '../prompts/prompt-manager.module';

// Conditionally load alt providers so their config/env isn't required unless used.
const conditionalProviders: any[] = [];

if (process.env.AI_PROVIDER === 'openai') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OpenAiAiService } = require('./openai-ai.service');
  conditionalProviders.push(OpenAiAiService);
}

// Grok main-brain provider (via OpenRouter). Sonnet tier stays on Anthropic.
if (process.env.MAIN_BRAIN_PROVIDER === 'grok') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GrokAiService } = require('./grok-ai.service');
  conditionalProviders.push(GrokAiService);
}

@Module({
  imports: [PromptManagerModule],
  providers: [AiService, ...conditionalProviders],
  exports: [AiService, ...conditionalProviders],
})
export class AiModule {}
