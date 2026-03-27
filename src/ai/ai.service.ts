import { Injectable, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PromptManagerService } from '../prompts/prompt-manager.service';
import { OpenAiAiService } from './openai-ai.service';

export interface AiResponse {
  content: string;
  model: string;
  memories: string[];
  inputTokens: number;
  outputTokens: number;
}

export interface ToolHandlers {
  checkAvailability?: (itemName: string, startDate: string, endDate: string) => Promise<string>;
  lookupPricing?: (itemName: string, days: number) => Promise<string>;
  checkCompatibility?: (items: string[]) => Promise<string>;
  getRentalDetails?: (rentalId: string) => Promise<string>;
  // Dashboard chat tools
  readConversation?: (rentalIdOrSearch: string) => Promise<string>;
  sendCorrectionMessage?: (rentalId: string, message: string) => Promise<string>;
  updateRule?: (ruleId: string, field: string, value: string) => Promise<string>;
  updateMemory?: (memoryId: string, newContent: string) => Promise<string>;
  searchRules?: (query: string) => Promise<string>;
  searchMemories?: (query: string) => Promise<string>;
  getDashboardStats?: () => Promise<string>;
  getBusinessIntelligence?: () => Promise<string>;
  getDailyBriefing?: () => Promise<string>;
  getPendingRentals?: () => Promise<string>;
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
  /** Current funnel stage — used to gate prompt components (saves input tokens) */
  conversationStage?: string;
  /** Detected intent — used for intent-based component gating (saves 2-4K tokens) */
  intent?: string;
  /** Intent flags for fine-grained component gating */
  intentFlags?: { hasPricingIntent?: boolean; hasDeliveryIntent?: boolean; hasMultipleItems?: boolean };
  /** Image URLs attached to the current renter message (for multimodal analysis) */
  imageUrls?: string[];
  /** Tool handlers for function calling — AI can request real-time data */
  toolHandlers?: ToolHandlers;
  /** Lightweight mode — skips full system prompt for internal extraction/classification calls */
  lightweight?: boolean;
  /** Enable THINK tool for structured reasoning (only for complex/adaptive calls) */
  enableThinking?: boolean;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic;
  private modelRoutine: string;
  private modelComplex: string;
  private modelLightweight: string;

  private aiEnabled: boolean;
  private readonly provider: 'claude' | 'openai';

  constructor(
    private configService: ConfigService,
    private promptManager: PromptManagerService,
    @Optional() @Inject(forwardRef(() => OpenAiAiService)) private openAiAiService?: OpenAiAiService,
  ) {
    this.aiEnabled = this.configService.get<string>('AI_ENABLED') !== 'false';
    this.provider = (this.configService.get<string>('AI_PROVIDER') || 'claude') as 'claude' | 'openai';

    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!this.aiEnabled) {
      this.logger.warn('AI_ENABLED=false — all AI calls disabled (testing mode)');
    } else if (this.provider === 'openai') {
      this.logger.log('🟢 AI_PROVIDER=openai — routing all AI calls through OpenAI GPT-4.1 mini');
    } else if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
      this.logger.warn('ANTHROPIC_API_KEY not configured — AI features disabled');
    }
    this.client = new Anthropic({ apiKey: apiKey || '' });
    this.modelRoutine = this.configService.get<string>('CLAUDE_MODEL') || 'claude-haiku-4-5-20251001';
    this.modelComplex = this.configService.get<string>('CLAUDE_MODEL_COMPLEX') || 'claude-sonnet-4-20250514';
    this.modelLightweight = this.configService.get<string>('CLAUDE_MODEL_LIGHTWEIGHT') || 'claude-haiku-4-5-20251001';
  }

  /** Data tools for Claude function calling (only available when toolHandlers are provided) */
  private readonly TOOLS: Anthropic.Tool[] = [
    {
      name: 'check_availability',
      description: 'Check if a specific item is available for given dates',
      input_schema: {
        type: 'object' as const,
        properties: {
          item_name: { type: 'string', description: 'Equipment name' },
          start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
          end_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        },
        required: ['item_name', 'start_date', 'end_date'],
      },
    },
    {
      name: 'lookup_pricing',
      description: 'Get pricing for a specific item for a number of days',
      input_schema: {
        type: 'object' as const,
        properties: {
          item_name: { type: 'string', description: 'Equipment name' },
          days: { type: 'number', description: 'Number of rental days' },
        },
        required: ['item_name', 'days'],
      },
    },
    {
      name: 'check_compatibility',
      description: 'Check if items are compatible with each other (mount, batteries, cards)',
      input_schema: {
        type: 'object' as const,
        properties: {
          items: { type: 'array', items: { type: 'string' }, description: 'List of equipment names' },
        },
        required: ['items'],
      },
    },
    {
      name: 'get_rental_details',
      description: 'Get current rental booking details (status, dates, price)',
      input_schema: {
        type: 'object' as const,
        properties: {
          rental_id: { type: 'string', description: 'Rental ID' },
        },
        required: ['rental_id'],
      },
    },
    {
      name: 'read_conversation',
      description: 'Read the full chat transcript of a rental conversation. Search by rental ID, renter name, or item name.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Rental ID, renter name, or item/listing name to find the conversation' },
        },
        required: ['search'],
      },
    },
    {
      name: 'send_correction',
      description: 'Send a corrective follow-up message to a renter through Hygglo. Use when the bot said something wrong and you need to fix it.',
      input_schema: {
        type: 'object' as const,
        properties: {
          rental_id: { type: 'string', description: 'Rental ID to send the message to' },
          message: { type: 'string', description: 'The corrective message to send to the renter' },
        },
        required: ['rental_id', 'message'],
      },
    },
    {
      name: 'search_rules',
      description: 'Search business rules by keyword. Returns matching rules with their IDs, priority, and content.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Keyword to search for in rules' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_memories',
      description: 'Search business memories by keyword. Returns matching memories with their IDs and content.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Keyword to search for in memories' },
        },
        required: ['query'],
      },
    },
    {
      name: 'update_rule',
      description: 'Update a business rule field (content, priority, active status). Requires confirmation from the user first.',
      input_schema: {
        type: 'object' as const,
        properties: {
          rule_id: { type: 'string', description: 'Rule UUID' },
          field: { type: 'string', description: 'Field to update: content, priority, or active' },
          value: { type: 'string', description: 'New value for the field' },
        },
        required: ['rule_id', 'field', 'value'],
      },
    },
    {
      name: 'update_memory',
      description: 'Update the content of a business memory entry. Requires confirmation from the user first.',
      input_schema: {
        type: 'object' as const,
        properties: {
          memory_id: { type: 'string', description: 'Memory UUID' },
          new_content: { type: 'string', description: 'New content for the memory' },
        },
        required: ['memory_id', 'new_content'],
      },
    },
    {
      name: 'get_dashboard_stats',
      description: 'Get live dashboard statistics: today earnings, active rentals, pending decisions, month revenue, scanner status.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_daily_briefing',
      description: 'Get a comprehensive daily briefing: pickups, returns, pending decisions, alerts, revenue, conversations needing attention.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_business_intelligence',
      description: 'Get advanced business intelligence: purchase recommendations, denied rentals analysis, time gap revenue (outside opening hours), substitution patterns, marketing-only item demand. Use this when the user asks about what to buy, investment decisions, demand patterns, or business optimization.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_pending_rentals',
      description: 'Get all pending rental requests that need accept/decline decisions, with availability and renter details.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
  ];

  /** Execute a single tool call and return the result string */
  private async executeToolCall(
    name: string,
    input: any,
    handlers?: ToolHandlers,
  ): Promise<string> {
    try {
      switch (name) {
        case 'check_availability':
          return handlers?.checkAvailability?.(input.item_name, input.start_date, input.end_date)
            ?? 'Tool not available';
        case 'lookup_pricing':
          return handlers?.lookupPricing?.(input.item_name, input.days) ?? 'Tool not available';
        case 'check_compatibility':
          return handlers?.checkCompatibility?.(input.items) ?? 'Tool not available';
        case 'get_rental_details':
          return handlers?.getRentalDetails?.(input.rental_id) ?? 'Tool not available';
        case 'read_conversation':
          return handlers?.readConversation?.(input.search) ?? 'Tool not available';
        case 'send_correction':
          return handlers?.sendCorrectionMessage?.(input.rental_id, input.message) ?? 'Tool not available';
        case 'search_rules':
          return handlers?.searchRules?.(input.query) ?? 'Tool not available';
        case 'search_memories':
          return handlers?.searchMemories?.(input.query) ?? 'Tool not available';
        case 'update_rule':
          return handlers?.updateRule?.(input.rule_id, input.field, input.value) ?? 'Tool not available';
        case 'update_memory':
          return handlers?.updateMemory?.(input.memory_id, input.new_content) ?? 'Tool not available';
        case 'get_dashboard_stats':
          return handlers?.getDashboardStats?.() ?? 'Tool not available';
        case 'get_daily_briefing':
          return handlers?.getDailyBriefing?.() ?? 'Tool not available';
        case 'get_business_intelligence':
          return handlers?.getBusinessIntelligence?.() ?? 'Tool not available';
        case 'get_pending_rentals':
          return handlers?.getPendingRentals?.() ?? 'Tool not available';
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Tool error: ${err.message}`;
    }
  }

  // buildAuthorityBlock() REMOVED — content migrated to DB prompt components:
  // - Escalation list → decision_guidelines
  // - First-time discount → decision_guidelines
  // - Price match → pricing_domain
  // - Add-item flow → scheduling_rules
  // - Hard constraints → decision_guidelines + security_rules + location_rules + communication_style
  // This saves ~800-1,000 tokens/message by eliminating duplication.

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

    // 2. Conversation history — strip timestamps to prevent AI from mimicking [timestamp] prefix format
    const enrichedHistory = context.conversationHistory;

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

  /**
   * Build system prompt (static) and dynamic context (injected into user message).
   * Static block: DB prompt components + business rules (~22K tokens) → system prompt (cached)
   * Dynamic block: temporal, memories, rental context (~3-5K tokens) → user message prefix (not cached)
   * Keeping the system prompt purely static enables multi-turn conversation caching:
   * the conversation history prefix matches across calls, so Anthropic caches it at 90% discount.
   */
  private async buildSystemPromptBlocks(
    context: AiContext,
    temporalBlock?: string,
  ): Promise<{ staticBlock: string; dynamicBlock: string }> {
    const staticParts: string[] = [];
    const dynamicParts: string[] = [];

    // STATIC: DB prompt components + rules (stable for 5+ min — perfect for prompt caching)
    const basePrompt = await this.promptManager.buildSystemPrompt('message', context.conversationStage, context.intent, context.intentFlags);
    staticParts.push(basePrompt);

    if (context.rules) {
      staticParts.push(`\n--- BUSINESS RULES ---\n${context.rules}`);
    }

    // DYNAMIC: temporal, memories, additional context, rental context (changes per message)
    if (temporalBlock) {
      dynamicParts.push(temporalBlock);
    }

    if (context.memories) {
      dynamicParts.push(`--- RELEVANT MEMORIES ---\n${context.memories}`);
    }

    if (context.additionalContext) {
      dynamicParts.push(`--- ADDITIONAL CONTEXT ---\n${context.additionalContext}`);
    }

    if (context.rentalContext) {
      dynamicParts.push(`--- CURRENT RENTAL CONTEXT ---\n${context.rentalContext}`);
    }

    return {
      staticBlock: staticParts.join('\n'),
      dynamicBlock: dynamicParts.join('\n\n'),
    };
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
    if (this.provider === 'openai' && this.openAiAiService) {
      return this.openAiAiService.processRoutine(userMessage, context);
    }
    return this.callClaude(userMessage, context, this.modelRoutine);
  }

  async processComplex(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    if (this.provider === 'openai' && this.openAiAiService) {
      return this.openAiAiService.processComplex(userMessage, context);
    }
    return this.callClaude(userMessage, context, this.modelComplex);
  }

  /**
   * Adaptive entry point for complex customer-facing messages.
   * Routes to modelComplex (currently Sonnet 4.6) with think tool.
   * Called when pipeline classifies message as high-complexity.
   */
  async processAdaptive(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    if (this.provider === 'openai' && this.openAiAiService) {
      return this.openAiAiService.processAdaptive(userMessage, context);
    }
    return this.callClaude(userMessage, { ...context, enableThinking: true }, this.modelComplex);
  }


  /**
   * Preflight reasoning: extract verified facts before the main AI call.
   * Forces the model to "think before speaking" — prevents hallucinated items/prices/status.
   * Uses Haiku (~150 input + ~100 output tokens). Cost: ~$0.00005/message.
   */
  async preflightReasoning(
    renterMessage: string,
    rentalTitle: string,
    rentalStatus: string,
    extractedItems: string[],
    rentalDates: { start?: Date; end?: Date },
  ): Promise<{ listingItem: string; renterIntent: string; status: string; warnings: string[] }> {
    if (this.provider === 'openai' && this.openAiAiService) {
      return this.openAiAiService.preflightReasoning(renterMessage, rentalTitle, rentalStatus, extractedItems, rentalDates);
    }
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
   * Lightweight extraction/classification — uses Claude 3 Haiku (4x cheaper).
   */
  async processExtraction(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    if (this.provider === 'openai' && this.openAiAiService) {
      return this.openAiAiService.processExtraction(userMessage, context);
    }
    return this.callClaude(userMessage, { ...context, rules: undefined, memories: undefined, lightweight: true }, this.modelLightweight);
  }

  /**
   * Sonnet-grade extraction — for tasks where Haiku lacks nuance.
   */
  async processExtractionComplex(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    if (this.provider === 'openai' && this.openAiAiService) {
      return this.openAiAiService.processExtractionComplex(userMessage, context);
    }
    return this.callClaude(userMessage, { ...context, rules: undefined, memories: undefined, lightweight: true, maxTokens: 1024 }, this.modelComplex);
  }

  /**
   * Lightweight internal analysis.
   */
  async processLightweight(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    if (this.provider === 'openai' && this.openAiAiService) {
      return this.openAiAiService.processLightweight(userMessage, context);
    }
    return this.callClaude(userMessage, context, this.modelLightweight);
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
    // Testing mode: skip all API calls when AI is disabled
    if (!this.aiEnabled) {
      this.logger.debug(`AI disabled — skipping ${model} call (${userMessage.substring(0, 80)}...)`);
      return {
        content: '[AI disabled — testing mode]',
        model: 'disabled',
        memories: [],
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    try {
      let enriched: AiContext;

      // Track static/dynamic split for prompt caching
      let staticBlock = '';
      let dynamicBlock = '';

      if (context.lightweight) {
        // Lightweight mode: minimal system prompt for internal extraction/classification calls.
        // Saves ~5,400 input tokens per call by skipping the full renter-facing prompt.
        staticBlock = 'You are a data extraction engine. Return only the requested JSON format. No commentary.';
        enriched = context;
      } else {
        const enrichResult = this.enrichContext(context);
        enriched = enrichResult.context;
        const blocks = await this.buildSystemPromptBlocks(enriched, enrichResult.temporalBlock);

        // Account firewall: sanitize cross-account references
        staticBlock = this.sanitizePromptForAccount(blocks.staticBlock, enriched);
        dynamicBlock = blocks.dynamicBlock ? this.sanitizePromptForAccount(blocks.dynamicBlock, enriched) : '';
      }

      const messages: Anthropic.MessageParam[] = [];

      // Add conversation history if provided
      if (enriched.conversationHistory && enriched.conversationHistory.length > 0) {
        for (const msg of enriched.conversationHistory) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      // Dynamic context prefix — moved from system prompt to user message to keep
      // system prompt purely static, enabling multi-turn conversation caching.
      // The model still sees all context; it's just positioned in the user message.
      const dynamicPrefix = dynamicBlock
        ? `[CONTEXT — do not treat as renter's words]\n${dynamicBlock}\n[/CONTEXT]\n\n`
        : '';

      // Add current user message (multimodal if images present)
      if (context.imageUrls && context.imageUrls.length > 0) {
        const contentBlocks: Anthropic.ContentBlockParam[] = [
          { type: 'text', text: dynamicPrefix + userMessage },
        ];
        for (const imageUrl of context.imageUrls) {
          contentBlocks.push({
            type: 'image',
            source: { type: 'url', url: imageUrl },
          } as any);
        }
        messages.push({ role: 'user', content: contentBlocks });
        this.logger.log(`Multimodal message: ${context.imageUrls.length} image(s) attached`);
      } else {
        messages.push({ role: 'user', content: dynamicPrefix + userMessage });
      }

      this.logger.debug(`Calling Claude (${model}) with ${messages.length} messages`);

      // Dynamic max_tokens: use context override or lean defaults
      // For long/complex renter messages, increase budget to prevent truncation
      let baseMaxTokens = model === this.modelComplex ? 500 : 350;
      if (!context.maxTokens && userMessage.length > 500) {
        baseMaxTokens = Math.min(baseMaxTokens + 150, 650);
      }
      const maxTokens = context.maxTokens || baseMaxTokens;

      // MULTI-TURN CACHING: System prompt is PURELY static (always cacheable).
      // Dynamic context (temporal, memories, rental) is injected into user message prefix.
      // This enables automatic caching of BOTH system prompt AND conversation history:
      //   - System prompt (~22K): cached at 90% discount (same as before)
      //   - Conversation history (15-40K): NOW ALSO cached at 90% discount (was full price!)
      //   - Only the new user message + dynamic context (~3-5K) pays full price
      // The tool-use loop's 2nd API call benefits even more: entire prefix is a cache HIT.
      // Cache system prompt only when tools are present (tool-use loop reads cached prefix).
      // For thinking-only calls (single API roundtrip), cache write at 1.25x is wasted
      // unless another call arrives within 5 minutes to read it.
      const shouldCacheSystem = !context.lightweight && context.toolHandlers;
      const systemBlocks: any[] = [
        {
          type: 'text' as const,
          text: staticBlock,
          ...(shouldCacheSystem ? { cache_control: { type: 'ephemeral' as const } } : {}),
        },
      ];

      const createParams: any = {
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        messages,
      };

      // Extended thinking for complex/adaptive calls: native reasoning in a single API call.
      // Replaces think tool (which caused an expensive 2nd API call with cache write).
      // Thinking tokens: ~1K at output rate ($15/MTok) = $0.015 vs old $0.15-0.30 per adaptive call.
      if (!context.lightweight && context.enableThinking) {
        createParams.thinking = { type: 'enabled', budget_tokens: 1024 };
        createParams.max_tokens = Math.max(maxTokens, 500) + 1024;
      } else if (context.toolHandlers) {
        createParams.tools = this.TOOLS;
      }

      // Only cache conversation when tools are present (tool-use loop reads cached prefix on 2nd call).
      // Without tools, conversation cache is written at 1.25x cost but never read (5-min TTL expires).
      // System prompt is always cached via its explicit breakpoint regardless.
      if (createParams.tools) {
        createParams.cache_control = { type: 'ephemeral' as const };
      }

      let response = await this.client.messages.create(createParams);
      let totalInput = response.usage.input_tokens;
      let totalOutput = response.usage.output_tokens;
      let totalCacheRead = (response.usage as any).cache_read_input_tokens || 0;
      let totalCacheCreate = (response.usage as any).cache_creation_input_tokens || 0;

      // Tool-use loop: max 3 iterations to prevent infinite loops
      // Also handle max_tokens when tool_use blocks are present (think tool exceeded budget)
      let iterations = 0;
      while (iterations < 2 && (
        response.stop_reason === 'tool_use' ||
        (response.stop_reason === 'max_tokens' && response.content.some(b => b.type === 'tool_use'))
      )) {
        iterations++;
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const toolResultContent: any[] = [];

        for (const block of toolUseBlocks) {
          const toolBlock = block as Anthropic.ToolUseBlock;
          const result = await this.executeToolCall(toolBlock.name, toolBlock.input, context.toolHandlers || undefined);
          this.logger.debug(`Tool call: ${toolBlock.name}(${JSON.stringify(toolBlock.input)}) → ${result.substring(0, 100)}`);
          toolResultContent.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: result,
          });
        }


        // Continue conversation with tool results
        messages.push({ role: 'assistant', content: response.content as any });
        messages.push({ role: 'user', content: toolResultContent });

        response = await this.client.messages.create({ ...createParams, messages });
        totalInput += response.usage.input_tokens;
        totalOutput += response.usage.output_tokens;
        totalCacheRead += (response.usage as any).cache_read_input_tokens || 0;
        totalCacheCreate += (response.usage as any).cache_creation_input_tokens || 0;
      }

      const rawContent = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as Anthropic.TextBlock).text)
        .join('\n');

      const memories = this.extractMemories(rawContent);
      const cleanContent = this.stripMemoryTags(rawContent);

      // Log extended thinking content (for debugging, not shown to user)
      const thinkingBlocks = response.content.filter(b => b.type === 'thinking');
      if (thinkingBlocks.length > 0) {
        const thinkText = (thinkingBlocks[0] as any).thinking || '';
        this.logger.debug(`Extended thinking (${thinkText.length} chars): ${thinkText.substring(0, 300)}...`);
      }

      const cacheInfo = totalCacheRead > 0 || totalCacheCreate > 0
        ? `, cache_read=${totalCacheRead}, cache_create=${totalCacheCreate}`
        : '';
      const thinkInfo = thinkingBlocks.length > 0 ? ', thinking=yes' : '';
      this.logger.log(
        `Claude response: ${model}, in=${totalInput}, out=${totalOutput}${iterations > 0 ? `, tools=${iterations}` : ''}${thinkInfo}${cacheInfo}, memories=${memories.length}`,
      );

      return {
        content: cleanContent,
        model,
        memories,
        inputTokens: totalInput,
        outputTokens: totalOutput,
      };
    } catch (error) {
      this.logger.error(`Claude API error: ${error.message}`);
      throw error;
    }
  }
}
