/**
 * Grok AI Service — main-brain provider using Grok 4.1 Fast via OpenRouter.
 *
 * Serves the bot's main-brain tiers only:
 *   - processRoutine           (substantive non-sensitive customer replies)
 *   - processLightweight       (greetings/goodbyes/acknowledgments)
 *   - processRoutineWithThinking (sensitive medium/high w/o high-stakes signal)
 *   - processExtraction        (internal classification/parse calls)
 *
 * The Sonnet tier (processComplex, processAdaptive) stays on Anthropic — no
 * point paying OpenRouter markup for Sonnet, and we want Anthropic-native
 * extended thinking for genuine high-stakes calls.
 *
 * Prompt engineering from ai.service.ts is preserved via parity functions:
 *   - Stage-gated component loading (promptManager.buildSystemPrompt with stage/intent)
 *   - Account-agnostic static block (uses "the owner", Daniel appears only as
 *     persona label in identity/critical_rules)
 *   - Active-account address injection (per-call, based on rental context)
 *   - Account firewall sanitize (strips OTHER account's identifiers from
 *     memories/rental-context)
 *   - Conversation history compaction on turns 6+ from end
 *
 * Notes on Grok via OpenRouter:
 *   - OpenAI-compatible chat-completions schema (tools, images, messages)
 *   - xAI auto-caches identical prefixes (no explicit cache_control needed)
 *   - Reasoning mode: reasoning: { enabled: true } passed at request level
 *   - Image input: OpenAI image_url format (not Anthropic image block)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PromptManagerService } from '../prompts/prompt-manager.service';
import { AiResponse, AiContext, ToolHandlers } from './ai.service';

@Injectable()
export class GrokAiService implements OnModuleInit {
  private readonly logger = new Logger(GrokAiService.name);
  private client!: OpenAI;
  private modelName: string;
  private aiEnabled: boolean;
  private configured = false;

  constructor(
    private configService: ConfigService,
    private promptManager: PromptManagerService,
  ) {
    this.aiEnabled = this.configService.get<string>('AI_ENABLED') !== 'false';
    this.modelName = this.configService.get<string>('GROK_MODEL') || 'x-ai/grok-4.1-fast';
  }

  async onModuleInit(): Promise<void> {
    const apiKey = this.configService.get<string>('OPENROUTER_API_KEY');
    const baseURL = this.configService.get<string>('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1';
    if (!this.aiEnabled) {
      this.logger.warn('AI_ENABLED=false — Grok calls disabled (testing mode)');
      return;
    }
    if (!apiKey) {
      this.logger.warn('OPENROUTER_API_KEY not configured — Grok main-brain disabled, will fall back to Anthropic');
      return;
    }
    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/rental-manager',
        'X-Title': 'Rental Manager Bot',
      },
    });
    this.configured = true;
    this.logger.log(`Grok AI initialized: model=${this.modelName} baseURL=${baseURL}`);
  }

  isReady(): boolean {
    return this.configured && this.aiEnabled;
  }

  /** Tool schemas in OpenAI function-calling format — mirrors ai.service.ts TOOLS. */
  private readonly TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'check_availability',
        description: 'Check if a specific item is available for given dates',
        parameters: {
          type: 'object',
          properties: {
            item_name: { type: 'string', description: 'Equipment name' },
            start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
            end_date: { type: 'string', description: 'End date YYYY-MM-DD' },
          },
          required: ['item_name', 'start_date', 'end_date'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'lookup_pricing',
        description: 'Get pricing for a specific item for a number of days',
        parameters: {
          type: 'object',
          properties: {
            item_name: { type: 'string', description: 'Equipment name' },
            days: { type: 'number', description: 'Number of rental days' },
          },
          required: ['item_name', 'days'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_compatibility',
        description: 'Check if items are compatible with each other (mount, batteries, cards)',
        parameters: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'string' }, description: 'List of equipment names' },
          },
          required: ['items'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_rental_details',
        description: 'Get current rental booking details (status, dates, price)',
        parameters: {
          type: 'object',
          properties: {
            rental_id: { type: 'string', description: 'Rental ID' },
          },
          required: ['rental_id'],
        },
      },
    },
  ];

  private async executeToolCall(
    name: string,
    args: Record<string, any>,
    handlers: ToolHandlers,
  ): Promise<string> {
    try {
      switch (name) {
        case 'check_availability':
          return handlers.checkAvailability?.(args.item_name, args.start_date, args.end_date)
            ?? 'Tool not available';
        case 'lookup_pricing':
          return handlers.lookupPricing?.(args.item_name, args.days) ?? 'Tool not available';
        case 'check_compatibility':
          return handlers.checkCompatibility?.(args.items) ?? 'Tool not available';
        case 'get_rental_details':
          return handlers.getRentalDetails?.(args.rental_id) ?? 'Tool not available';
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `Tool error: ${err.message}`;
    }
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

  /**
   * Account firewall — mirrors the fixed version in ai.service.ts.
   * Strips the OTHER account's identifiers only. Preserves the active account's
   * own address so the injected ACTIVE ACCOUNT ADDRESSES block survives intact.
   */
  private sanitizeDynamicForAccount(text: string): string {
    // Redact internal warehouse/phone first — must run on every path,
    // including dashboard chat where no ACTIVE ACCOUNT marker exists.
    text = GrokAiService.stripInternalAddresses(text);
    const accountMatch = text.match(/ACTIVE ACCOUNT:\s*(Leo Adams|DB Cinema)/i);
    if (!accountMatch) return text;
    const isLeo = /leo adams/i.test(accountMatch[1]);
    if (isLeo) {
      return text
        .replace(/\bDaniel(?:'s)?\b/gi, 'the owner')
        .replace(/\bDB Cinema(?:\s+Rentals?)?\b/gi, 'the other account')
        .replace(/\bStatue of James II[^\n.]*/gi, '[other pickup]')
        .replace(/\b11 Trafalgar Square\b/gi, '[other pickup]')
        .replace(/\bWC2N\s*5DN\b/gi, '[other postcode]');
    }
    let cleaned = text
      .replace(/\bLeo Adams\b/gi, 'the other account')
      .replace(/\b5 Pall Mall East[^\n.]*/gi, '[other pickup]')
      .replace(/\bSW1Y\s*5BF\b/gi, '[other postcode]');
    cleaned = GrokAiService.stripInternalAddresses(cleaned);
    return cleaned;
  }

  /** Remove the internal dispatch/warehouse address and phone from any
   *  sanitized output. These appear in memory [fact] entries marked
   *  "INTERNAL ONLY — NEVER share" but depend on the model respecting the
   *  negative rule; cheaper to never show them to the model at all. */
  private static stripInternalAddresses(text: string): string {
    return text
      .replace(/\b23\s*Whitcomb\s*Street,?\s*WC2H\s*7ER\b[^\n.]*/gi, '[internal address redacted]')
      .replace(/\bWC2H\s*7ER\b/gi, '[internal postcode redacted]')
      .replace(/\b020\s*7387\s*8888\b/g, '[internal phone redacted]');
  }

  /**
   * History compaction — identical semantics to ai.service.ts#compactOldAssistantTurns.
   * Keeps last 5 turns verbatim; older assistant turns lose filler and retain
   * only load-bearing sentences (prices/dates/items/verdicts).
   */
  private compactOldAssistantTurns(
    history: { role: 'user' | 'assistant'; content: string; timestamp?: Date }[],
  ): { role: 'user' | 'assistant'; content: string; timestamp?: Date }[] {
    if (!history || history.length <= 5) return history;

    const fillerPatterns: RegExp[] = [
      /^(hi+|hey+|hello|hiya|heya|howdy)[\s!,.]+/i,
      /^(thanks|thank you|cheers|appreciate (it|that))[\s!,.]+/i,
      /thanks? (so much |very much )?(for|so much)[^.!?]*[.!?]/i,
      /(hope|hoping) [^.!?]*(great|well|good|wonderful|amazing)[^.!?]*[.!?]/i,
      /(let me know|feel free) [^.!?]*[.!?]/i,
      /^(just )?(quick|a quick) (heads.up|note|ping)[\s:,-]*/i,
      /^(no problem|no worries|no bother|totally fine|absolutely)[\s!,.]+/i,
    ];
    const loadBearing = /£|\$|\bpounds?\b|\b(fx3|fx6|fx30|a7|bmpcc|pocket|gm|rs3|rs4|ronin|rode|dji|sony|canon|blackmagic|tripod|gimbal|lens|camera|drone|mic|monitor|card|battery|batteries|pickup|return|deliver|courier|postcode|available|not available|unavailable|confirm|booked|yes|no|morning|evening|10am|7pm|8pm|11am|2\.5x|5x)\b|\b\d{1,3}(?:[-/]\d{1,2}){1,2}\b|\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep)[a-z]*\b/i;

    const compact = (text: string): string => {
      let t = text;
      for (const re of fillerPatterns) t = t.replace(re, ' ');
      t = t.replace(/\s+/g, ' ').trim();
      const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
      if (sentences.length <= 1) return t.slice(0, 220);
      const keep: string[] = [];
      for (const sent of sentences) {
        if (loadBearing.test(sent)) keep.push(sent);
      }
      const joined = keep.join(' ').trim();
      const result = joined || sentences[0];
      return result.slice(0, 220);
    };

    const cutoff = history.length - 5;
    return history.map((msg, i) => {
      if (i >= cutoff) return msg;
      if (msg.role !== 'assistant') return msg;
      const compacted = compact(msg.content);
      if (compacted.length >= msg.content.length - 10) return msg;
      return { ...msg, content: compacted };
    });
  }

  private enrichContext(context: AiContext): { context: AiContext; temporalBlock: string } {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const temporalBlock =
      `--- CURRENT DATE & TIME ---\n` +
      `Today: ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} ` +
      `(${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })} GMT)\n` +
      `Tomorrow: ${tomorrow.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}\n` +
      `When a renter mentions a relative date, resolve it and state the actual date in your reply.`;

    const enrichedHistory = context.conversationHistory
      ? this.compactOldAssistantTurns(context.conversationHistory)
      : context.conversationHistory;

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
      context: { ...context, conversationHistory: enrichedHistory, rentalContext: enrichedRentalContext },
      temporalBlock,
    };
  }

  /**
   * System prompt assembly — matches the Anthropic path in ai.service.ts so
   * Grok sees the same stage-gated content, account-agnostic static block,
   * and per-account address injection. xAI auto-caches identical prefixes,
   * so keeping the static portion stable maximises cache hits.
   */
  private async buildSystemPrompt(context: AiContext, temporalBlock: string): Promise<string> {
    const parts: string[] = [];

    // Static portion (stable across calls for the same stage/intent)
    const basePrompt = await this.promptManager.buildSystemPrompt(
      'message',
      context.conversationStage,
      context.intent,
      context.intentFlags,
    );
    parts.push(basePrompt);

    if (context.rules) {
      parts.push(`\n--- BUSINESS RULES ---\n${context.rules}`);
    }

    // Dynamic portion — prefix sanitisation applied below.
    const dynamicParts: string[] = [];
    dynamicParts.push(temporalBlock);
    if (context.memories) {
      dynamicParts.push(`--- RELEVANT MEMORIES ---\n${context.memories}`);
    }
    if (context.additionalContext) {
      dynamicParts.push(`--- ADDITIONAL CONTEXT ---\n${context.additionalContext}`);
    }
    if (context.rentalContext) {
      dynamicParts.push(`--- CURRENT RENTAL CONTEXT ---\n${context.rentalContext}`);
    }

    // Active-account address injection (per-call, based on rental context).
    const accountLine = context.rentalContext
      && /ACTIVE ACCOUNT:\s*(Leo Adams|DB Cinema)/i.exec(context.rentalContext);
    if (accountLine) {
      const isLeo = /leo adams/i.test(accountLine[1]);
      const block = isLeo
        ? (
            '--- ACTIVE ACCOUNT ADDRESSES ---\n' +
            'Pre-booking (before confirmed): say only "near Charing Cross Road in Central London".\n' +
            'Post-booking confirmed (use VERBATIM): 5 Pall Mall East, London SW1Y 5BF — meet outside by the Pret.'
          )
        : (
            '--- ACTIVE ACCOUNT ADDRESSES ---\n' +
            'Pre-booking (before confirmed): say only "Trafalgar Square, Central London".\n' +
            'Post-booking confirmed (use VERBATIM): Statue of James II, 11 Trafalgar Square, London WC2N 5DN.'
          );
      dynamicParts.push(block);
    }

    const dynamicBlock = dynamicParts.join('\n\n');
    const sanitisedDynamic = this.sanitizeDynamicForAccount(dynamicBlock);
    parts.push(sanitisedDynamic);

    // Grok-specific end-of-prompt reinforcement — models trained on openai-style
    // chat completions follow instructions at the end of the system prompt more
    // reliably than buried mid-prompt rules.
    parts.push(GrokAiService.CRITICAL_RULES_SUFFIX);

    return parts.join('\n');
  }

  private static readonly CRITICAL_RULES_SUFFIX = `

=== CRITICAL RESPONSE RULES (MUST FOLLOW — reinforcement) ===

1. TIME SLOTS: ONLY 10am-12pm and 7pm-9pm. Reject all other times. Offer morning (10am-12pm) first when giving options.
2. ADDRESS THE QUESTION: Answer directly what the renter asked. Don't pivot to qualifying questions when they asked about price/availability/logistics.
3. DUAL ACCOUNTS: DB Cinema and Leo Adams are SEPARATE businesses with NO connection. If asked, deny firmly.
4. NEGOTIATION: Address directly — do not deflect. Stage 1: emphasise value + multi-day savings. Never reveal discount thresholds.
5. NEVER say "Hygglo" — say "the platform". Never reveal fees, margins, or pricing formulas.
6. NEVER offer delivery unless the renter specifically asks about it.
7. NEVER accept unattended returns. Items must be handed back in person.
8. Keep responses SHORT. Match the renter's tone. No corporate filler. No em dashes (character —). No three-adjective combos. No "Quick heads up", "I'd be happy to help", "Solid choice", "The go-to", "Perfect for", "Stunning/Exceptional", "Hope the project goes great".
9. NEVER refer to the owner in third person (never "Daniel will", "Leo will" — you ARE the persona). Use "let me check" / "I'll verify".
10. NEVER invent prices, specs, runtimes, distances, or item names. If unsure: "I'd need to double-check that".`;

  // ─── Public methods (main-brain tiers only) ─────────────────────────────

  async processRoutine(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callGrok(userMessage, context, 650, false);
  }

  async processLightweight(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callGrok(userMessage, context, 350, false);
  }

  async processRoutineWithThinking(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callGrok(userMessage, context, 800, true);
  }

  async processExtraction(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    return this.callGrok(
      userMessage,
      { ...context, rules: undefined, memories: undefined, lightweight: true },
      context.maxTokens || 150,
      false,
    );
  }

  /**
   * processComplex — previously Sonnet 4.6 on the Anthropic path. Used for
   * business-strategy owner chat and dashboard edit-flow tool use (large BI
   * context, many tools, 1500-4096 max tokens depending on caller). Grok
   * variant runs with reasoning ON — full reasoning trace available but
   * never emitted to renter (same privacy posture as Anthropic thinking).
   */
  async processComplex(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callGrok(userMessage, context, 1500, true);
  }

  /**
   * processAdaptive — previously Sonnet 4.6 + extended thinking on the Anthropic
   * path. Fires for genuine high-stakes renter incidents (refund demand, damage
   * on shipped rental, legal threat, sarcasm, big-value negotiation). Grok
   * variant enables reasoning for multi-step deliberation before the reply.
   */
  async processAdaptive(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callGrok(userMessage, context, 1000, true);
  }

  // ─── Core request ───────────────────────────────────────────────────────

  private async callGrok(
    userMessage: string,
    context: AiContext,
    defaultMaxTokens: number,
    enableReasoning: boolean,
  ): Promise<AiResponse> {
    if (!this.aiEnabled) {
      this.logger.debug(`Grok disabled — skipping call (${userMessage.substring(0, 80)}...)`);
      return { content: '[AI disabled — testing mode]', model: 'disabled', memories: [], inputTokens: 0, outputTokens: 0 };
    }
    if (!this.configured) {
      throw new Error('Grok not configured (missing OPENROUTER_API_KEY)');
    }

    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.callGrokOnce(userMessage, context, defaultMaxTokens, enableReasoning);
      } catch (err: any) {
        lastError = err;
        const isRetryable = err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503;
        if (!isRetryable || attempt === 3) {
          this.logger.error(`Grok API error (attempt ${attempt}/3, not retrying): ${err.message}`);
          throw err;
        }
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        this.logger.warn(`Grok API error (attempt ${attempt}/3, retrying in ${delayMs}ms): ${err.message}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastError!;
  }

  private async callGrokOnce(
    userMessage: string,
    context: AiContext,
    defaultMaxTokens: number,
    enableReasoning: boolean,
  ): Promise<AiResponse> {
    let systemPrompt: string;
    let enriched: AiContext;

    if (context.lightweight) {
      systemPrompt = 'You are a data extraction engine. Return only the requested format. No commentary.';
      enriched = context;
    } else {
      const enrichResult = this.enrichContext(context);
      enriched = enrichResult.context;
      systemPrompt = await this.buildSystemPrompt(enriched, enrichResult.temporalBlock);
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    if (enriched.conversationHistory && enriched.conversationHistory.length > 0) {
      for (const msg of enriched.conversationHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    if (context.imageUrls && context.imageUrls.length > 0) {
      const prefix = enriched.rentalContext
        ? `[RENTAL CONTEXT FOR PHOTO ANALYSIS: ${enriched.rentalContext}]\n\n`
        : '';
      const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        { type: 'text', text: prefix + userMessage },
      ];
      for (const imageUrl of context.imageUrls) {
        contentParts.push({ type: 'image_url', image_url: { url: imageUrl } });
      }
      messages.push({ role: 'user', content: contentParts });
      this.logger.log(`Multimodal message: ${context.imageUrls.length} image(s) attached`);
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    const maxTokens = context.maxTokens || defaultMaxTokens;

    // Build params. OpenRouter accepts `reasoning` via an extension field
    // when routing to Grok (xAI). Passed as any to avoid SDK type friction.
    // ALWAYS pass reasoning explicitly — Grok 4.1 Fast defaults reasoning ON on
    // OpenRouter when the field is omitted. Unwanted reasoning burns 100-200
    // output tokens per customer reply and adds latency. Only the "routine with
    // thinking" tier wants it.
    const params: any = {
      model: this.modelName,
      messages,
      max_tokens: maxTokens,
      reasoning: { enabled: enableReasoning },
    };
    if (context.toolHandlers) {
      params.tools = this.TOOLS;
    }

    this.logger.debug(
      `Calling Grok (${this.modelName}) with ${messages.length} messages, maxTokens=${maxTokens}, reasoning=${enableReasoning}`,
    );

    let response = await this.client.chat.completions.create(params);
    let totalInput = response.usage?.prompt_tokens || 0;
    let totalOutput = response.usage?.completion_tokens || 0;

    // Tool-use loop
    let iterations = 0;
    while (
      response.choices[0]?.finish_reason === 'tool_calls' &&
      response.choices[0]?.message?.tool_calls &&
      context.toolHandlers &&
      iterations < 3
    ) {
      iterations++;
      const toolCalls = response.choices[0].message.tool_calls;
      messages.push(response.choices[0].message);

      for (const tc of toolCalls) {
        if (tc.type !== 'function') continue;
        const fn = tc.function;
        let args: Record<string, any> = {};
        try { args = JSON.parse(fn.arguments); } catch { args = {}; }
        const result = await this.executeToolCall(fn.name, args, context.toolHandlers);
        this.logger.debug(`Tool call: ${fn.name}(${fn.arguments}) -> ${result.substring(0, 100)}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }

      response = await this.client.chat.completions.create({ ...params, messages });
      totalInput += response.usage?.prompt_tokens || 0;
      totalOutput += response.usage?.completion_tokens || 0;
    }

    const rawContent = response.choices[0]?.message?.content || '';
    const memories = this.extractMemories(rawContent);
    const cleanContent = this.stripMemoryTags(rawContent);

    this.logger.log(
      `Grok response: ${this.modelName}, in=${totalInput}, out=${totalOutput}${iterations > 0 ? `, tools=${iterations}` : ''}, memories=${memories.length}`,
    );

    return {
      content: cleanContent,
      model: this.modelName,
      memories,
      inputTokens: totalInput,
      outputTokens: totalOutput,
    };
  }
}
