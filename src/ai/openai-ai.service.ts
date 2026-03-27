/**
 * OpenAI AI Service — Drop-in replacement using GPT-4.1 mini.
 *
 * Implements the same interface (processRoutine, processComplex, processAdaptive,
 * processExtraction, processExtractionComplex, processLightweight) so the pipeline
 * and all consumers work without changes.
 *
 * Key advantages vs Gemini:
 * - Best-in-class instruction following (IFEval 84.1%)
 * - Superior tool/function calling (30% more efficient)
 * - Retry with exponential backoff (no more silent drops)
 * - 1M token context window
 * - $0.40/$1.60 per MTok (output cheaper than Gemini 2.5 Flash's $2.50)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PromptManagerService } from '../prompts/prompt-manager.service';
import { AiResponse, AiContext, ToolHandlers } from './ai.service';

@Injectable()
export class OpenAiAiService implements OnModuleInit {
  private readonly logger = new Logger(OpenAiAiService.name);
  private client: OpenAI;
  private modelName: string;
  private aiEnabled: boolean;

  constructor(
    private configService: ConfigService,
    private promptManager: PromptManagerService,
  ) {
    this.aiEnabled = this.configService.get<string>('AI_ENABLED') !== 'false';
    this.modelName = this.configService.get<string>('OPENAI_MODEL') || 'gpt-4.1-mini';
  }

  async onModuleInit(): Promise<void> {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!this.aiEnabled) {
      this.logger.warn('AI_ENABLED=false — all OpenAI API calls disabled (testing mode)');
    } else if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY not configured — OpenAI features disabled');
    }
    this.client = new OpenAI({ apiKey: apiKey || '' });
    this.logger.log(`OpenAI AI initialized: model=${this.modelName}`);
  }

  /** Tool schemas in OpenAI function calling format */
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

  /** Execute a single tool call and return the result string */
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
    } catch (err) {
      return `Tool error: ${err.message}`;
    }
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

    const enrichedHistory = context.conversationHistory;
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
    const basePrompt = await this.promptManager.buildSystemPrompt('message', context.conversationStage);
    parts.push(basePrompt);

    if (temporalBlock) {
      parts.push(`\n${temporalBlock}`);
    }
    if (context.rules) {
      parts.push(`\n--- BUSINESS RULES ---\n${context.rules}`);
    }
    if (context.memories) {
      parts.push(`\n--- RELEVANT MEMORIES ---\n${context.memories}`);
    }
    if (context.additionalContext) {
      parts.push(`\n--- ADDITIONAL CONTEXT ---\n${context.additionalContext}`);
    }
    if (context.rentalContext) {
      parts.push(`\n--- CURRENT RENTAL CONTEXT ---\n${context.rentalContext}`);
    }

    // GPT-specific: Critical rules reinforcement at END of prompt.
    // GPT-4.1 follows end-of-prompt instructions more reliably than buried mid-prompt rules.
    parts.push(OpenAiAiService.CRITICAL_RULES_SUFFIX);

    return parts.join('\n');
  }

  /** Hard rules reinforced at the very end of the system prompt for GPT compliance */
  private static readonly CRITICAL_RULES_SUFFIX = `

=== CRITICAL RESPONSE RULES (MUST FOLLOW) ===

1. TIME SLOTS: ONLY 10am-12pm and 7pm-9pm. REJECT all other times. If renter asks for 1pm, 2pm, 3pm, 4pm, 5pm, 6pm — say NO and offer valid slots. Always offer MORNING (10am-12pm) first.

2. NO "WHAT ARE YOU SHOOTING?": Do NOT ask about the renter's project/shoot type UNLESS this is their very first message AND they haven't asked a specific question. If they asked about price, availability, logistics, delivery, times — answer THAT. Do not pivot to qualifying questions.

3. ADDRESS THE QUESTION: Always directly answer what the renter asked. If they ask about price, give a price. If they negotiate, address the negotiation (don't deflect to "what's your project?"). If they ask about dual accounts, deny any connection.

4. DUAL ACCOUNTS: DB Cinema and Leo Adams are SEPARATE businesses with NO connection. If asked, deny firmly: "No, we're a separate business." Never dodge this question.

5. NEGOTIATION: When a renter says something is too expensive or mentions a competitor price, address it directly. Stage 1: emphasize value + multi-day savings. Do NOT change the subject.

6. NEVER say "Hygglo" — say "the platform". NEVER reveal platform fees, margins, or pricing formulas.

7. NEVER offer delivery unless the renter specifically asks about it.

8. NEVER accept unattended returns. Items must be returned in person.

9. Keep responses SHORT. Match the renter's tone. No corporate filler. No bullet points.

10. NEVER claim to be physically present, arriving, or handling gear. You arrange via chat — Daniel/Leo do physical handoffs.`;

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

  /** Account firewall: sanitize cross-account data leaks */
  private sanitizePromptForAccount(prompt: string, context: AiContext): string {
    const accountMatch = prompt.match(/ACTIVE ACCOUNT:\s*(Leo Adams|DB Cinema)/i);
    if (!accountMatch) return prompt;
    const isLeo = /leo adams/i.test(accountMatch[1]);
    if (isLeo) {
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
      return prompt
        .replace(/\bLeo Adams\b/gi, 'the other account')
        .replace(/\b5 Pall Mall East\b/gi, '[other pickup address]')
        .replace(/\bSW1Y\s*5BF\b/gi, '[postcode]');
    }
  }

  // ─── Public methods (same signatures as AiService) ───

  async processRoutine(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callOpenAI(userMessage, context, 500);
  }

  async processComplex(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callOpenAI(userMessage, context, 800);
  }

  /**
   * Adaptive routing: GPT-4.1 mini handles everything — no tier split needed.
   * The escalation signals are preserved for logging/token-budget purposes.
   */
  async processAdaptive(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    const isComplex = this.shouldEscalateToComplex(userMessage, context);
    const maxTokens = isComplex ? 800 : 500;
    this.logger.debug(`Adaptive routing: ${this.modelName} (${isComplex ? 'complex' : 'routine'} mode, maxTokens=${maxTokens})`);
    return this.callOpenAI(userMessage, context, maxTokens);
  }

  /** Keep escalation detection for token budget decisions */
  private shouldEscalateToComplex(message: string, context: AiContext): boolean {
    let signals = 0;
    if (/\b(complain|disappointed|frustrated|unacceptable|terrible|awful|refund|compensat|escalat|annoying|ridiculous|rip.?off)\b/i.test(message)) signals += 2;
    if (/\b(too expensive|lower price|better deal|best price|negotiate|can you do .* for|feels? steep|saw.*cheaper|over.?priced)\b/i.test(message)) signals += 2;
    if (/\b(discount|any deals)\b/i.test(message) && signals === 0) signals += 1;
    const hasPricing = /\b(price|cost|how much|quote|rate|£\d)\b/i.test(message);
    const hasDelivery = /\b(deliver|delivery|courier|postcode|address|collect)\b/i.test(message);
    if (hasPricing && hasDelivery) signals += 2;
    const itemMentions = (message.match(/\b(fx3|fx6|a7|bmpcc|pocket|gimbal|lens|camera|drone|light|mic|monitor|slider|tripod|nanlite|atomos|rode|dji|sony|blackmagic|wireless|v.?mount|battery|batteries)\b/gi) || []).length;
    const bundleMentions = (message.match(/\b(bundle|package|kit|combo|set)\b/gi) || []).length;
    if (itemMentions >= 3 || bundleMentions >= 2) signals += 2;
    else if (itemMentions >= 2) signals += 1;
    const questionMarks = (message.match(/\?/g) || []).length;
    const alsoActually = /\b(also|actually|and also|plus|as well|another thing)\b/i.test(message);
    if (questionMarks >= 2 || (questionMarks >= 1 && alsoActually)) signals += 1;
    if (/\b(add|adding|throw in|include|can you also|want to get)\b/i.test(message) && itemMentions >= 1) signals += 1;
    if (hasDelivery && /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(message)) signals += 1;
    if (/\b(cancel|reschedul|change date|move the date|postpone|different day)\b/i.test(message)) signals += 2;
    if (/\b(too far|not convenient|wrong location|different location|why.*not at)\b/i.test(message)) signals += 2;
    if (message.length > 600) signals += 2;
    else if (message.length > 350) signals += 1;
    return signals >= 2;
  }

  async preflightReasoning(
    renterMessage: string,
    rentalTitle: string,
    rentalStatus: string,
    extractedItems: string[],
    rentalDates: { start?: Date; end?: Date },
  ): Promise<{ listingItem: string; renterIntent: string; status: string; warnings: string[] }> {
    if (!this.aiEnabled) {
      return {
        listingItem: extractedItems[0] || rentalTitle,
        renterIntent: 'unknown (AI disabled)',
        status: rentalStatus,
        warnings: [],
      };
    }
    const startStr = rentalDates.start ? new Date(rentalDates.start).toLocaleDateString('en-GB') : 'TBC';
    const endStr = rentalDates.end ? new Date(rentalDates.end).toLocaleDateString('en-GB') : 'TBC';

    const prompt = `Given this rental context, extract verified facts. Be precise — do NOT guess.

Listing title: "${rentalTitle}"
Verified inventory item(s): ${extractedItems.length > 0 ? extractedItems.join(', ') : 'unknown — use listing title carefully'}
Rental status: ${rentalStatus}
Dates: ${startStr} to ${endStr}

Renter message: "${renterMessage}"

Reply in this exact format:
ITEM: [the actual equipment this rental is about — NOT SEO keywords]
INTENT: [what the renter is asking/requesting in 1 sentence]
STATUS: [current rental status in plain English]
WARNINGS: [any issues — e.g. "renter may be confused about which item" or "none"]`;

    const result = await this.processExtraction(prompt, { maxTokens: 150 });
    const lines = result.content.split('\n');
    const get = (prefix: string) => lines.find(l => l.startsWith(prefix))?.replace(prefix, '').trim() || '';

    return {
      listingItem: get('ITEM:') || extractedItems[0] || rentalTitle,
      renterIntent: get('INTENT:'),
      status: get('STATUS:') || rentalStatus,
      warnings: get('WARNINGS:') === 'none' ? [] : [get('WARNINGS:')].filter(Boolean),
    };
  }

  async processExtraction(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    return this.callOpenAI(userMessage, { ...context, rules: undefined, memories: undefined, lightweight: true }, context.maxTokens || 150);
  }

  async processExtractionComplex(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    return this.callOpenAI(userMessage, { ...context, rules: undefined, memories: undefined, lightweight: true, maxTokens: 1024 }, 1024);
  }

  async processLightweight(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callOpenAI(userMessage, context, 200);
  }

  // ─── Core OpenAI API call with retry ───

  private async callOpenAI(
    userMessage: string,
    context: AiContext,
    defaultMaxTokens: number,
  ): Promise<AiResponse> {
    if (!this.aiEnabled) {
      this.logger.debug(`AI disabled — skipping OpenAI call (${userMessage.substring(0, 80)}...)`);
      return {
        content: '[AI disabled — testing mode]',
        model: 'disabled',
        memories: [],
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    // Retry with exponential backoff (max 3 attempts)
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this._callOpenAIOnce(userMessage, context, defaultMaxTokens);
      } catch (error) {
        lastError = error;
        const isRetryable = error.status === 429 || error.status === 500 || error.status === 503;
        if (!isRetryable || attempt === 3) {
          this.logger.error(`OpenAI API error (attempt ${attempt}/3, not retrying): ${error.message}`);
          throw error;
        }
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000); // 1s, 2s, 4s
        this.logger.warn(`OpenAI API error (attempt ${attempt}/3, retrying in ${delayMs}ms): ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw lastError!;
  }

  private async _callOpenAIOnce(
    userMessage: string,
    context: AiContext,
    defaultMaxTokens: number,
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
      systemPrompt = this.sanitizePromptForAccount(systemPrompt, enriched);
    }

    // Build OpenAI messages array
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add conversation history
    if (enriched.conversationHistory && enriched.conversationHistory.length > 0) {
      for (const msg of enriched.conversationHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Add current user message (multimodal if images present)
    if (context.imageUrls && context.imageUrls.length > 0) {
      let imageContextPrefix = '';
      if (enriched.rentalContext) {
        imageContextPrefix = `[RENTAL CONTEXT FOR PHOTO ANALYSIS: ${enriched.rentalContext}]\n\n`;
      }
      const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        { type: 'text', text: imageContextPrefix + userMessage },
      ];
      for (const imageUrl of context.imageUrls) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }
      messages.push({ role: 'user', content: contentParts });
      this.logger.log(`Multimodal message: ${context.imageUrls.length} image(s) attached`);
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    const maxTokens = context.maxTokens || defaultMaxTokens;

    this.logger.debug(`Calling OpenAI (${this.modelName}) with ${messages.length} messages, maxTokens=${maxTokens}`);

    // Build request params
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.modelName,
      messages,
      max_tokens: maxTokens,
    };

    // Add tools if handlers are provided
    if (context.toolHandlers) {
      params.tools = this.TOOLS;
    }

    let response = await this.client.chat.completions.create(params);
    let totalInput = response.usage?.prompt_tokens || 0;
    let totalOutput = response.usage?.completion_tokens || 0;

    // Tool-use loop: max 3 iterations
    let iterations = 0;
    while (
      response.choices[0]?.finish_reason === 'tool_calls' &&
      response.choices[0]?.message?.tool_calls &&
      context.toolHandlers &&
      iterations < 3
    ) {
      iterations++;

      const toolCalls = response.choices[0].message.tool_calls;

      // Add the assistant's response (with tool calls) to messages
      messages.push(response.choices[0].message);

      // Execute each tool and add results
      for (const tc of toolCalls) {
        if (tc.type !== 'function') continue;
        const fn = tc.function;
        const args = JSON.parse(fn.arguments);
        const result = await this.executeToolCall(fn.name, args, context.toolHandlers);
        this.logger.debug(`Tool call: ${fn.name}(${fn.arguments}) → ${result.substring(0, 100)}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
      }

      // Continue generation with tool results
      response = await this.client.chat.completions.create({ ...params, messages });
      totalInput += response.usage?.prompt_tokens || 0;
      totalOutput += response.usage?.completion_tokens || 0;
    }

    // Extract text from response
    const rawContent = response.choices[0]?.message?.content || '';

    const memories = this.extractMemories(rawContent);
    const cleanContent = this.stripMemoryTags(rawContent);

    this.logger.log(
      `OpenAI response: ${this.modelName}, in=${totalInput}, out=${totalOutput}${iterations > 0 ? `, tools=${iterations}` : ''}, memories=${memories.length}`,
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
