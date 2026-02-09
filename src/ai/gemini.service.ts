import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface GeminiResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Autolearn AI service — routes through Cerebras (OpenAI-compatible API).
 * Free tier: Qwen 3 235B @ 30 RPM, 14,400 RPD, 1M TPD.
 * Falls back to Gemini if CEREBRAS_API_KEY is not set.
 * Class kept as "GeminiService" to avoid touching all autolearn consumers.
 */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger('AutolearnAiService');
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly provider: 'cerebras' | 'gemini';

  // --- Quota tracking (resets midnight UTC) ---
  private callsToday = 0;
  private lastResetDate = '';
  private readonly MAX_RPD: number;
  private readonly MAX_RPM: number;

  // RPM tracking (sliding window)
  private callTimestamps: number[] = [];

  constructor(private configService: ConfigService) {
    const cerebrasKey = this.configService.get<string>('CEREBRAS_API_KEY');
    const geminiKey = this.configService.get<string>('GEMINI_API_KEY');

    if (cerebrasKey) {
      this.provider = 'cerebras';
      this.apiKey = cerebrasKey;
      this.baseUrl = 'https://api.cerebras.ai/v1/chat/completions';
      this.modelName = this.configService.get<string>('CEREBRAS_MODEL') || 'qwen-3-235b';
      this.MAX_RPD = 14400;
      this.MAX_RPM = 30;
      this.logger.log(`Cerebras ${this.modelName} initialized (free tier: ${this.MAX_RPM} RPM, ${this.MAX_RPD} RPD)`);
    } else if (geminiKey) {
      this.provider = 'gemini';
      this.apiKey = geminiKey;
      this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
      this.modelName = this.configService.get<string>('GEMINI_MODEL') || 'gemini-2.5-flash';
      this.MAX_RPD = 250;
      this.MAX_RPM = 10;
      this.logger.log(`Gemini ${this.modelName} fallback initialized (${this.MAX_RPM} RPM, ${this.MAX_RPD} RPD)`);
    } else {
      this.provider = 'cerebras';
      this.apiKey = null;
      this.baseUrl = '';
      this.modelName = '';
      this.MAX_RPD = 0;
      this.MAX_RPM = 0;
      this.logger.warn('No CEREBRAS_API_KEY or GEMINI_API_KEY — autolearn AI disabled');
    }
  }

  get isAvailable(): boolean {
    return this.apiKey !== null;
  }

  /**
   * Analytical tasks: proposal generation, rework analysis, correction detection.
   */
  async processAnalysis(
    prompt: string,
    systemInstruction?: string,
    maxTokens = 1024,
  ): Promise<GeminiResponse | null> {
    return this.callApi(prompt, systemInstruction, maxTokens);
  }

  /**
   * Bulk tasks: shadow test re-runs.
   */
  async processBulk(
    prompt: string,
    systemInstruction?: string,
    maxTokens = 512,
  ): Promise<GeminiResponse | null> {
    return this.callApi(prompt, systemInstruction, maxTokens);
  }

  private async callApi(
    prompt: string,
    systemInstruction: string | undefined,
    maxTokens: number,
  ): Promise<GeminiResponse | null> {
    if (!this.apiKey) {
      this.logger.warn('Autolearn AI not configured, skipping call');
      return null;
    }

    this.checkDailyReset();

    if (this.callsToday >= this.MAX_RPD) {
      this.logger.warn(`Daily quota exhausted (${this.callsToday}/${this.MAX_RPD})`);
      return null;
    }

    const canProceed = await this.waitForRpmSlot();
    if (!canProceed) {
      this.logger.warn('RPM limit reached, skipping');
      return null;
    }

    try {
      if (this.provider === 'cerebras') {
        return await this.callCerebras(prompt, systemInstruction, maxTokens);
      } else {
        return await this.callGemini(prompt, systemInstruction, maxTokens);
      }
    } catch (error: any) {
      // Handle rate limit with retry
      if (error.status === 429 || error.message?.includes('429') || error.message?.includes('rate')) {
        this.logger.warn(`${this.provider} rate limited (429). Waiting 10s and retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        try {
          if (this.provider === 'cerebras') {
            return await this.callCerebras(prompt, systemInstruction, maxTokens);
          } else {
            return await this.callGemini(prompt, systemInstruction, maxTokens);
          }
        } catch (retryErr: any) {
          this.logger.warn(`Retry failed: ${retryErr.message?.substring(0, 100)}`);
          return null;
        }
      }
      this.logger.error(`${this.provider} API error: ${error.message}`);
      return null;
    }
  }

  private async callCerebras(
    prompt: string,
    systemInstruction: string | undefined,
    maxTokens: number,
  ): Promise<GeminiResponse> {
    const messages: { role: string; content: string }[] = [];
    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelName,
        messages,
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Cerebras ${res.status}: ${body.substring(0, 200)}`);
      (err as any).status = res.status;
      throw err;
    }

    const data = await res.json();
    this.callsToday++;

    const content = data.choices?.[0]?.message?.content || '';
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;

    this.logger.debug(
      `Cerebras ${this.modelName}: in=${inputTokens}, out=${outputTokens}, quota=${this.callsToday}/${this.MAX_RPD}`,
    );

    return { content, model: this.modelName, inputTokens, outputTokens };
  }

  private async callGemini(
    prompt: string,
    systemInstruction: string | undefined,
    maxTokens: number,
  ): Promise<GeminiResponse> {
    const url = `${this.baseUrl}/${this.modelName}:generateContent?key=${this.apiKey}`;

    const contents: any[] = [{ parts: [{ text: prompt }] }];
    const body: any = {
      contents,
      generationConfig: { maxOutputTokens: maxTokens },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      const err = new Error(`Gemini ${res.status}: ${errBody.substring(0, 200)}`);
      (err as any).status = res.status;
      throw err;
    }

    const data = await res.json();
    this.callsToday++;

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;

    this.logger.debug(
      `Gemini ${this.modelName}: in=${inputTokens}, out=${outputTokens}, quota=${this.callsToday}/${this.MAX_RPD}`,
    );

    return { content, model: this.modelName, inputTokens, outputTokens };
  }

  private async waitForRpmSlot(): Promise<boolean> {
    const now = Date.now();
    const cutoff = now - 60_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0] < cutoff) {
      this.callTimestamps.shift();
    }

    if (this.callTimestamps.length < this.MAX_RPM) {
      this.callTimestamps.push(now);
      return true;
    }

    const waitMs = this.callTimestamps[0] + 60_000 - now;
    if (waitMs > 30_000) return false;

    await new Promise((resolve) => setTimeout(resolve, waitMs + 100));
    this.callTimestamps.shift();
    this.callTimestamps.push(Date.now());
    return true;
  }

  private checkDailyReset(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      if (this.lastResetDate) {
        this.logger.log(`Daily quota reset. Yesterday used: ${this.callsToday}/${this.MAX_RPD}`);
      }
      this.callsToday = 0;
      this.lastResetDate = today;
    }
  }

  getQuotaStatus(): { used: number; limit: number; remaining: number; provider: string } {
    this.checkDailyReset();
    return {
      used: this.callsToday,
      limit: this.MAX_RPD,
      remaining: Math.max(0, this.MAX_RPD - this.callsToday),
      provider: this.provider,
    };
  }
}
