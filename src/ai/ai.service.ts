import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PromptManagerService } from '../prompts/prompt-manager.service';

export interface AiResponse {
  content: string;
  model: string;
  memories: string[];
  inputTokens: number;
  outputTokens: number;
}

export interface AiContext {
  rules?: string;
  memories?: string;
  conversationHistory?: { role: 'user' | 'assistant'; content: string; timestamp?: Date }[];
  rentalContext?: string;
  additionalContext?: string;
  /** Optional max_tokens override for response length control */
  maxTokens?: number;
  /** Structured rental dates for countdown enrichment */
  rentalDates?: { start?: Date; end?: Date };
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic;
  private modelRoutine: string;
  private modelComplex: string;

  constructor(
    private configService: ConfigService,
    private promptManager: PromptManagerService,
  ) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
      this.logger.warn('ANTHROPIC_API_KEY not configured — AI features disabled');
    }
    this.client = new Anthropic({ apiKey: apiKey || '' });
    this.modelRoutine = this.configService.get<string>('CLAUDE_MODEL') || 'claude-haiku-4-5-20250514';
    this.modelComplex = this.configService.get<string>('CLAUDE_MODEL_COMPLEX') || 'claude-sonnet-4-20250514';
  }

  private enrichContext(context: AiContext): { context: AiContext; temporalBlock: string } {
    const now = new Date();

    // 1. Temporal grounding
    const tomorrow = new Date(now.getTime() + 86400000);
    const temporalBlock =
      `--- CURRENT DATE & TIME ---\n` +
      `Today: ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} ` +
      `(${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })} GMT)\n` +
      `Tomorrow: ${tomorrow.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}\n` +
      `When a renter mentions a relative date, resolve it and state the actual date in your reply.`;

    // 2. Timestamp conversation messages
    const enrichedHistory = context.conversationHistory?.map(msg => {
      if (!msg.timestamp) return msg;
      const ts = new Date(msg.timestamp);
      const prefix = `[${ts.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}]`;
      return { ...msg, content: `${prefix} ${msg.content}` };
    });

    // 3. Rental countdown
    let enrichedRentalContext = context.rentalContext;
    if (context.rentalDates?.start && enrichedRentalContext) {
      const daysUntil = Math.ceil((new Date(context.rentalDates.start).getTime() - now.getTime()) / 86400000);
      const countdown = daysUntil === 0 ? '⚡ TODAY' : daysUntil === 1 ? '⚡ TOMORROW' :
        daysUntil > 0 ? `in ${daysUntil} days` : `${Math.abs(daysUntil)} days ago`;
      enrichedRentalContext = enrichedRentalContext.replace(
        /^(Dates: .+)$/m,
        `$1 (${countdown})`,
      );
    }

    return {
      context: {
        ...context,
        conversationHistory: enrichedHistory,
        rentalContext: enrichedRentalContext,
      },
      temporalBlock,
    };
  }

  private async buildSystemPrompt(context: AiContext, temporalBlock?: string): Promise<string> {
    const parts: string[] = [];

    // Get base system prompt from prompt manager (DB-backed modular components)
    const basePrompt = await this.promptManager.buildSystemPrompt('message');
    parts.push(basePrompt);

    if (temporalBlock) {
      parts.push(`\n${temporalBlock}`);
    }

    // Add context-specific sections
    if (context.rules) {
      parts.push(`\n--- BUSINESS RULES ---\n${context.rules}`);
    }

    if (context.memories) {
      parts.push(`\n--- RELEVANT MEMORIES ---\n${context.memories}`);
    }

    if (context.additionalContext) {
      parts.push(`\n--- ADDITIONAL CONTEXT ---\n${context.additionalContext}`);
    }

    // Slim FINAL ENFORCEMENT — only highest-risk rules that must never be violated
    parts.push(
      '\n--- FINAL ENFORCEMENT (HIGHEST PRIORITY) ---\n' +
      'OUTPUT: Plain text only. No markdown, no bold, no bullets, no headers. Write like a person texting.\n' +
      'PLATFORM FEES (ABSOLUTE BAN): The words "platform fee", "service fee", "checkout fee", "Hygglo fee", "platform charges" MUST NEVER appear in your response — not even to deny them. Instead say: "The price you see when you book is the total — no hidden charges." If asked about fees, deflect to the total price.\n' +
      'HALLUCINATION BAN: The INVENTORY section above lists EVERY item we stock. If the renter asks for something NOT on that list, it does NOT exist. Say "we don\'t currently stock [item]" and suggest the closest alternative FROM THE LIST. For lenses, note the mount system (Sony E-mount, Canon EF mount) — different mounts are NOT interchangeable. We do NOT have Canon RF lenses. NEVER confirm availability for unlisted items or fabricate prices.\n' +
      'ADDRESS: NEVER share a specific address before booking is confirmed. Only say "Central London (Trafalgar Square area)".\n' +
      'LOCATION: NEVER say "all our gear is in Central London" or reveal items are centralised. Treat each listing location as real. Use excuses if asked.\n' +
      'NEVER DOWNSELL: Do NOT say a renter has "enough" or "doesn\'t need" something. Facilitate and upsell.\n' +
      'DISCOUNT SECRECY: NEVER reveal discount thresholds, percentages, or tiers. Never say "above £X you get Y% off". Say "longer rentals and bigger orders can work out cheaper" if asked. Never use the word "threshold".',
    );

    // ACTIVE IDENTITY — placed last for maximum signal strength (recency bias)
    if (context.rentalContext) {
      parts.push(`\n--- ACTIVE IDENTITY (OVERRIDE ALL ABOVE) ---\n${context.rentalContext}`);
    }

    return parts.join('\n');
  }

  private extractMemories(content: string): string[] {
    const memories: string[] = [];
    const regex = /<memory>([\s\S]*?)<\/memory>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      memories.push(match[1].trim());
    }
    return memories;
  }

  private stripMemoryTags(content: string): string {
    return content.replace(/<memory>[\s\S]*?<\/memory>/g, '').trim();
  }

  async processRoutine(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callClaude(userMessage, context, this.modelRoutine);
  }

  async processComplex(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callClaude(userMessage, context, this.modelComplex);
  }

  /**
   * Adaptive routing: defaults to Haiku, auto-escalates to Sonnet for edge cases.
   */
  async processAdaptive(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    const model = this.shouldEscalateToComplex(userMessage, context)
      ? this.modelComplex
      : this.modelRoutine;
    this.logger.debug(`Adaptive routing: selected ${model} for message`);
    return this.callClaude(userMessage, context, model);
  }

  /**
   * Detect edge cases that warrant Sonnet-level reasoning.
   * Requires 2+ signals to escalate (prevents over-escalation on single keywords).
   */
  private shouldEscalateToComplex(message: string, context: AiContext): boolean {
    let signals = 0;

    // Complaint or frustration signals — strong signal, counts as 2
    if (/\b(complain|disappointed|frustrated|unacceptable|terrible|awful|refund|compensat|escalat)\b/i.test(message)) {
      signals += 2;
    }

    // Price negotiation attempts (not simple "do you do discounts?" which has a canned answer)
    if (/\b(too expensive|lower price|better deal|best price|negotiate|can you do .* for)\b/i.test(message)) {
      signals += 2;
    }

    // Simple discount question — only counts as 1 (canned response works fine on Haiku)
    if (/\b(discount|any deals)\b/i.test(message) && signals === 0) {
      signals += 1;
    }

    // Combined pricing + delivery (complex calculation)
    const hasPricing = /\b(price|cost|how much|quote|rate|£\d)\b/i.test(message);
    const hasDelivery = /\b(deliver|delivery|courier|postcode|address|collect)\b/i.test(message);
    if (hasPricing && hasDelivery) {
      signals += 2;
    }

    // Multiple items or bundles being discussed simultaneously
    const itemMentions = (message.match(/\b(fx3|a7|bmpcc|gimbal|lens|camera|drone|light|mic|monitor|slider|tripod|nanlite|atomos|rode|dji|sony|blackmagic)\b/gi) || []).length;
    const bundleMentions = (message.match(/\b(bundle|package|kit|combo|set)\b/gi) || []).length;
    if (itemMentions >= 3 || bundleMentions >= 2) {
      signals += 2;
    } else if (itemMentions >= 2) {
      signals += 1;
    }

    // Cancellation, rescheduling, or date change — strong signal
    if (/\b(cancel|reschedul|change date|move the date|postpone|different day)\b/i.test(message)) {
      signals += 2;
    }

    // Very long messages (likely complex multi-part questions)
    if (message.length > 800) {
      signals += 2;
    } else if (message.length > 500) {
      signals += 1;
    }

    // Conversation history is deep (complex ongoing negotiation)
    if (context.conversationHistory && context.conversationHistory.length > 16) {
      signals += 1;
    }

    return signals >= 2;
  }

  /**
   * Lightweight extraction method - uses Haiku with minimal system prompt.
   * For structured data extraction only (times, dates, item names, etc.)
   */
  async processExtraction(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    return this.callClaude(userMessage, { ...context, rules: undefined, memories: undefined }, this.modelRoutine);
  }

  /**
   * Account firewall: sanitize assembled prompt to prevent cross-account data leaks.
   * Runs once on the final prompt string — catches leaks from identity, memories, rules, context.
   */
  private sanitizePromptForAccount(prompt: string, context: AiContext): string {
    // Extract account from rental context (ACTIVE ACCOUNT line)
    const accountMatch = prompt.match(/ACTIVE ACCOUNT:\s*(Leo Adams|DB Cinema)/i);
    if (!accountMatch) return prompt; // No account context, skip

    const isLeo = /leo adams/i.test(accountMatch[1]);

    if (isLeo) {
      // Strip Daniel/DB Cinema references from Leo's prompt
      return prompt
        .replace(/\bDaniel(?:'s)?\b/gi, 'the owner')
        .replace(/\bDB Cinema(?:\s+Rentals?)?\b/gi, 'the other account')
        .replace(/\bEscalate to the owner\b/gi, 'Escalate to owner')
        .replace(/\bthe owner's business\b/gi, 'your rental business')
        .replace(/\bTrafalgar Square\b/gi, 'Central London')
        .replace(/\b5 Pall Mall East\b/gi, '[pickup address]')
        .replace(/\bWC2N\s*5DN\b/gi, '[postcode]')
        .replace(/\bSW1Y\s*5BF\b/gi, '[postcode]');
    } else {
      // Strip Leo-specific references from DB Cinema's prompt
      return prompt
        .replace(/\bLeo Adams\b/gi, 'the other account')
        .replace(/\b5 Pall Mall East\b/gi, '[other pickup address]')
        .replace(/\bSW1Y\s*5BF\b/gi, '[postcode]');
    }
  }

  private async callClaude(
    userMessage: string,
    context: AiContext,
    model: string,
  ): Promise<AiResponse> {
    try {
      const { context: enriched, temporalBlock } = this.enrichContext(context);
      let systemPrompt = await this.buildSystemPrompt(enriched, temporalBlock);

      // Account firewall: sanitize cross-account references
      systemPrompt = this.sanitizePromptForAccount(systemPrompt, enriched);

      const messages: Anthropic.MessageParam[] = [];

      // Add conversation history if provided
      if (enriched.conversationHistory && enriched.conversationHistory.length > 0) {
        for (const msg of enriched.conversationHistory) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      // Add current user message
      messages.push({ role: 'user', content: userMessage });

      this.logger.debug(`Calling Claude (${model}) with ${messages.length} messages`);

      // Dynamic max_tokens: use context override or lean defaults
      const maxTokens = context.maxTokens || (model === this.modelComplex ? 512 : 256);

      // Use prompt caching for the static system prompt portion
      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [
          {
            type: 'text' as const,
            text: systemPrompt,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        messages,
      });

      const rawContent = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as Anthropic.TextBlock).text)
        .join('\n');

      const memories = this.extractMemories(rawContent);
      const cleanContent = this.stripMemoryTags(rawContent);

      this.logger.log(
        `Claude response: ${model}, in=${response.usage.input_tokens}, out=${response.usage.output_tokens}, memories=${memories.length}`,
      );

      return {
        content: cleanContent,
        model,
        memories,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (error) {
      this.logger.error(`Claude API error: ${error.message}`);
      throw error;
    }
  }
}
