/**
 * Gemini AI Service — Drop-in replacement for AiService using Google Gemini 2.5 Flash.
 *
 * Implements the same interface (processRoutine, processComplex, processAdaptive,
 * processExtraction, processExtractionComplex, processLightweight) so the pipeline
 * and all consumers work without changes.
 *
 * Key differences vs Claude:
 * - Single model (gemini-2.5-flash) handles routine + complex (no tier split needed)
 * - Tool calling: functionDeclarations + functionCall/functionResponse parts
 * - Messages: role 'model' instead of 'assistant'
 * - System prompt: config.systemInstruction instead of separate system parameter
 * - Token usage: usageMetadata.promptTokenCount / candidatesTokenCount
 * - 85% cheaper: $0.15/M input, $0.60/M output vs $0.80/$4.00 (Haiku)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptManagerService } from '../prompts/prompt-manager.service';
import { AiResponse, AiContext, ToolHandlers } from './ai.service';

// Dynamic import for ESM module — resolved in onModuleInit
let GoogleGenAI: any;
let Type: any;

@Injectable()
export class GeminiAiService implements OnModuleInit {
  private readonly logger = new Logger(GeminiAiService.name);
  private client: any; // GoogleGenAI instance (loaded dynamically)
  private modelName: string;
  private aiEnabled: boolean;
  private initialized = false;

  constructor(
    private configService: ConfigService,
    private promptManager: PromptManagerService,
  ) {
    this.aiEnabled = this.configService.get<string>('AI_ENABLED') !== 'false';
    this.modelName = this.configService.get<string>('GEMINI_MODEL_MAIN') || 'gemini-2.5-flash';
  }

  async onModuleInit(): Promise<void> {
    try {
      const genai = await import('@google/genai');
      GoogleGenAI = genai.GoogleGenAI;
      Type = genai.Type;

      const apiKey = this.configService.get<string>('GEMINI_API_KEY')
        || this.configService.get<string>('GOOGLE_AI_API_KEY');
      if (!this.aiEnabled) {
        this.logger.warn('AI_ENABLED=false — all Gemini API calls disabled (testing mode)');
      } else if (!apiKey) {
        this.logger.warn('GEMINI_API_KEY not configured — Gemini AI features disabled');
      }
      this.client = new GoogleGenAI({ apiKey: apiKey || '' });
      this.initialized = true;
      this.logger.log(`Gemini AI initialized: model=${this.modelName}`);
    } catch (err) {
      this.logger.error(`Failed to load @google/genai: ${err.message}`);
    }
  }

  /** Tool schemas in Gemini functionDeclarations format (lazy — Type loaded dynamically) */
  private get FUNCTION_DECLARATIONS() {
    return [
      {
        name: 'check_availability',
        description: 'Check if a specific item is available for given dates',
        parameters: {
          type: Type?.OBJECT || 'OBJECT',
          properties: {
            item_name: { type: Type?.STRING || 'STRING', description: 'Equipment name' },
            start_date: { type: Type?.STRING || 'STRING', description: 'Start date YYYY-MM-DD' },
            end_date: { type: Type?.STRING || 'STRING', description: 'End date YYYY-MM-DD' },
          },
          required: ['item_name', 'start_date', 'end_date'],
        },
      },
      {
        name: 'lookup_pricing',
        description: 'Get pricing for a specific item for a number of days',
        parameters: {
          type: Type?.OBJECT || 'OBJECT',
          properties: {
            item_name: { type: Type?.STRING || 'STRING', description: 'Equipment name' },
            days: { type: Type?.NUMBER || 'NUMBER', description: 'Number of rental days' },
          },
          required: ['item_name', 'days'],
        },
      },
      {
        name: 'check_compatibility',
        description: 'Check if items are compatible with each other (mount, batteries, cards)',
        parameters: {
          type: Type?.OBJECT || 'OBJECT',
          properties: {
            items: { type: Type?.ARRAY || 'ARRAY', items: { type: Type?.STRING || 'STRING' }, description: 'List of equipment names' },
          },
          required: ['items'],
        },
      },
      {
        name: 'get_rental_details',
        description: 'Get current rental booking details (status, dates, price)',
        parameters: {
          type: Type?.OBJECT || 'OBJECT',
          properties: {
            rental_id: { type: Type?.STRING || 'STRING', description: 'Rental ID' },
          },
          required: ['rental_id'],
        },
      },
    ];
  }

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
    return this.callGemini(userMessage, context, 500);
  }

  async processComplex(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callGemini(userMessage, context, 800);
  }

  /**
   * Adaptive routing: Gemini 2.5 Flash handles everything — no tier split.
   * The escalation signals are preserved for logging/diagnostic purposes only.
   */
  async processAdaptive(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    // Gemini 2.5 Flash handles both routine and complex — use higher token budget for complex
    const isComplex = this.shouldEscalateToComplex(userMessage, context);
    const maxTokens = isComplex ? 800 : 500;
    this.logger.debug(`Adaptive routing: gemini-2.5-flash (${isComplex ? 'complex' : 'routine'} mode, maxTokens=${maxTokens})`);
    return this.callGemini(userMessage, context, maxTokens);
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

  /**
   * Preflight reasoning: extract verified facts before the main AI call.
   */
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

  /**
   * Lightweight extraction/classification — uses same model but minimal system prompt.
   */
  async processExtraction(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    return this.callGemini(userMessage, { ...context, rules: undefined, memories: undefined, lightweight: true }, context.maxTokens || 150);
  }

  /**
   * Complex extraction — generous token budget for nuanced tasks.
   */
  async processExtractionComplex(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    return this.callGemini(userMessage, { ...context, rules: undefined, memories: undefined, lightweight: true, maxTokens: 1024 }, 1024);
  }

  /**
   * Lightweight internal analysis.
   */
  async processLightweight(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    return this.callGemini(userMessage, context, 200);
  }

  // ─── Core Gemini API call ───

  private async callGemini(
    userMessage: string,
    context: AiContext,
    defaultMaxTokens: number,
  ): Promise<AiResponse> {
    if (!this.aiEnabled) {
      this.logger.debug(`AI disabled — skipping Gemini call (${userMessage.substring(0, 80)}...)`);
      return {
        content: '[AI disabled — testing mode]',
        model: 'disabled',
        memories: [],
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    try {
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

      // Build Gemini contents array from conversation history
      const contents: Array<{ role: string; parts: Array<any> }> = [];

      if (enriched.conversationHistory && enriched.conversationHistory.length > 0) {
        for (const msg of enriched.conversationHistory) {
          contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
          });
        }
      }

      // Add current user message (multimodal if images present)
      if (context.imageUrls && context.imageUrls.length > 0) {
        let imageContextPrefix = '';
        if (enriched.rentalContext) {
          imageContextPrefix = `[RENTAL CONTEXT FOR PHOTO ANALYSIS: ${enriched.rentalContext}]\n\n`;
        }
        const parts: Array<any> = [{ text: imageContextPrefix + userMessage }];
        for (const imageUrl of context.imageUrls) {
          // Gemini supports URL-based images via fileData
          parts.push({ fileData: { fileUri: imageUrl, mimeType: 'image/jpeg' } });
        }
        contents.push({ role: 'user', parts });
        this.logger.log(`Multimodal message: ${context.imageUrls.length} image(s) attached`);
      } else {
        contents.push({ role: 'user', parts: [{ text: userMessage }] });
      }

      const maxTokens = context.maxTokens || defaultMaxTokens;

      this.logger.debug(`Calling Gemini (${this.modelName}) with ${contents.length} messages, maxTokens=${maxTokens}`);

      // Build config
      const config: any = {
        maxOutputTokens: maxTokens,
        systemInstruction: systemPrompt,
        thinkingConfig: { thinkingBudget: 0 }, // Disable thinking to save cost
      };

      // Add tools if handlers are provided
      if (context.toolHandlers) {
        config.tools = [{ functionDeclarations: this.FUNCTION_DECLARATIONS }];
      }

      let response = await this.client.models.generateContent({
        model: this.modelName,
        contents,
        config,
      });

      let totalInput = response.usageMetadata?.promptTokenCount || 0;
      let totalOutput = response.usageMetadata?.candidatesTokenCount || 0;

      // Tool-use loop: max 3 iterations
      let iterations = 0;
      while (response.functionCalls && response.functionCalls.length > 0 && context.toolHandlers && iterations < 3) {
        iterations++;

        const functionCalls = response.functionCalls;
        const functionResponseParts: Array<any> = [];

        for (const fc of functionCalls) {
          const result = await this.executeToolCall(fc.name!, fc.args || {}, context.toolHandlers);
          this.logger.debug(`Tool call: ${fc.name}(${JSON.stringify(fc.args)}) → ${result.substring(0, 100)}`);
          functionResponseParts.push({
            functionResponse: {
              name: fc.name,
              response: { output: result },
            },
          });
        }

        // Add the model's function call response + our function results to the conversation
        // First, add the model's response (which contains the function calls)
        const modelParts: Array<any> = [];
        if (response.candidates?.[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            modelParts.push(part);
          }
        }
        contents.push({ role: 'model', parts: modelParts });
        contents.push({ role: 'user', parts: functionResponseParts });

        // Continue generation with tool results
        response = await this.client.models.generateContent({
          model: this.modelName,
          contents,
          config,
        });

        totalInput += response.usageMetadata?.promptTokenCount || 0;
        totalOutput += response.usageMetadata?.candidatesTokenCount || 0;
      }

      // Extract text from response
      const rawContent = response.text || '';

      const memories = this.extractMemories(rawContent);
      const cleanContent = this.stripMemoryTags(rawContent);

      this.logger.log(
        `Gemini response: ${this.modelName}, in=${totalInput}, out=${totalOutput}${iterations > 0 ? `, tools=${iterations}` : ''}, memories=${memories.length}`,
      );

      return {
        content: cleanContent,
        model: this.modelName,
        memories,
        inputTokens: totalInput,
        outputTokens: totalOutput,
      };
    } catch (error) {
      this.logger.error(`Gemini API error: ${error.message}`);
      throw error;
    }
  }
}
