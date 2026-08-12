import { Injectable, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PromptManagerService } from '../prompts/prompt-manager.service';
import { OpenAiAiService } from './openai-ai.service';
import { GrokAiService } from './grok-ai.service';

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
  private readonly mainBrainProvider: 'claude' | 'grok';

  constructor(
    private configService: ConfigService,
    private promptManager: PromptManagerService,
    @Optional() @Inject(forwardRef(() => OpenAiAiService)) private openAiAiService?: OpenAiAiService,
    @Optional() @Inject(forwardRef(() => GrokAiService)) private grokAiService?: GrokAiService,
  ) {
    this.aiEnabled = this.configService.get<string>('AI_ENABLED') !== 'false';
    this.provider = (this.configService.get<string>('AI_PROVIDER') || 'claude') as 'claude' | 'openai';
    this.mainBrainProvider = (this.configService.get<string>('MAIN_BRAIN_PROVIDER') || 'claude') as 'claude' | 'grok';

    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!this.aiEnabled) {
      this.logger.warn('AI_ENABLED=false — all AI calls disabled (testing mode)');
    } else if (this.provider === 'openai') {
      this.logger.log('AI_PROVIDER=openai — routing all AI calls through OpenAI GPT-4.1 mini');
    } else if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
      this.logger.warn('ANTHROPIC_API_KEY not configured — AI features disabled');
    }
    if (this.mainBrainProvider === 'grok') {
      this.logger.log('MAIN_BRAIN_PROVIDER=grok — main-brain tiers route to Grok 4.1 Fast via OpenRouter (Sonnet tier stays on Anthropic)');
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

  /**
   * Compact older assistant turns in conversation history.
   * Rule: keep the last 5 turns verbatim; for older assistant turns (position
   * index <= length - 6), strip bot filler ("Hi there!", "Thanks for reaching out",
   * sign-offs) and keep only sentences that carry load-bearing info (prices,
   * dates, item names, availability verdicts, confirmations).
   * User turns are never compacted — their exact wording often matters for intent.
   * Empirical saving: ~40-60% token reduction on assistant turns beyond turn 5.
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

    // Keep sentences that are load-bearing.
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

    const cutoff = history.length - 5; // indices 0..cutoff-1 are "old"
    return history.map((msg, i) => {
      if (i >= cutoff) return msg;
      if (msg.role !== 'assistant') return msg;
      const compacted = compact(msg.content);
      if (compacted.length >= msg.content.length - 10) return msg; // barely-shorter isn't worth the semantic shift
      return { ...msg, content: compacted };
    });
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

    // 2. Conversation history — strip timestamps AND compact old assistant turns.
    //    Keeps the last 5 turns verbatim; older assistant turns lose filler and
    //    retain only load-bearing sentences (prices/dates/items/verdicts).
    const enrichedHistory = context.conversationHistory
      ? this.compactOldAssistantTurns(context.conversationHistory)
      : context.conversationHistory;

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

    // Active-account addresses injected per-call. The location_rules static
    // component deliberately omits specific addresses so both accounts share
    // one cached system prompt; the live address data belongs to the dynamic
    // block (changes based on which account owns the current rental).
    const accountLine = context.rentalContext && /ACTIVE ACCOUNT:\s*(Leo Adams|DB Cinema)/i.exec(context.rentalContext);
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

  /**
   * Route a main-brain call through Grok (OpenRouter) when configured, with
   * automatic fallback to the supplied Anthropic path on error. Keeps the bot
   * resilient to OpenRouter/xAI outages: one failed Grok call swaps to Haiku
   * and the conversation continues without user impact.
   */
  private async mainBrainOrFallback(
    grokFn: (svc: GrokAiService) => Promise<AiResponse>,
    anthropicFallback: () => Promise<AiResponse>,
    tier: string,
  ): Promise<AiResponse> {
    if (this.mainBrainProvider !== 'grok' || !this.grokAiService || !this.grokAiService.isReady()) {
      return anthropicFallback();
    }
    try {
      return await grokFn(this.grokAiService);
    } catch (err) {
      this.logger.warn(`[mainBrain] Grok ${tier} failed, falling back to Anthropic: ${(err as Error).message}`);
      return anthropicFallback();
    }
  }

  async processRoutine(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    if (this.provider === 'openai' && this.openAiAiService) {
      return this.openAiAiService.processRoutine(userMessage, context);
    }
    return this.mainBrainOrFallback(
      svc => svc.processRoutine(userMessage, context),
      () => this.callClaude(userMessage, context, this.modelRoutine),
      'routine',
    );
  }

  async processComplex(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    if (this.provider === 'openai' && this.openAiAiService) {
      return this.openAiAiService.processComplex(userMessage, context);
    }
    return this.mainBrainOrFallback(
      svc => svc.processComplex(userMessage, context),
      () => this.callClaude(userMessage, context, this.modelComplex),
      'complex',
    );
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
    return this.mainBrainOrFallback(
      svc => svc.processAdaptive(userMessage, context),
      () => this.callClaude(userMessage, { ...context, enableThinking: true }, this.modelComplex),
      'adaptive',
    );
  }

  /**
   * Haiku 4.5 + extended thinking — reasoning tier without Sonnet premium.
   * Used for sensitive intents (complaint/cancellation/negotiation/damage) where
   * reasoning matters but stakes don't justify Sonnet (~5x cheaper per call).
   * Thinking budget: 1024 tokens ≈ $0.005/call at Haiku output rate.
   */
  async processRoutineWithThinking(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
    if (this.provider === 'openai' && this.openAiAiService) {
      // OpenAI path has no thinking primitive — fall back to complex model
      return this.openAiAiService.processComplex(userMessage, context);
    }
    return this.mainBrainOrFallback(
      svc => svc.processRoutineWithThinking(userMessage, context),
      () => this.callClaude(userMessage, { ...context, enableThinking: true }, this.modelRoutine),
      'routineWithThinking',
    );
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
    return this.mainBrainOrFallback(
      svc => svc.processExtraction(userMessage, context),
      () => this.callClaude(userMessage, { ...context, rules: undefined, memories: undefined, lightweight: true }, this.modelLightweight),
      'extraction',
    );
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
    return this.mainBrainOrFallback(
      svc => svc.processLightweight(userMessage, context),
      () => this.callClaude(userMessage, context, this.modelLightweight),
      'lightweight',
    );
  }

  /**
   * Prompt cache prewarm — keeps the static system prompt block in Anthropic's
   * 5-minute ephemeral cache so real renter messages land on a warm cache even
   * during quiet periods. Fires every 4 minutes; first run per 5-min window
   * writes the cache, subsequent runs are cheap cache reads.
   * Net effect: cache hit rate on the ~7K-token system prompt rises dramatically
   * for low-concurrency traffic (evenings/early mornings).
   */
  @Cron('*/4 * * * *')
  async prewarmPromptCache(): Promise<void> {
    if (!this.aiEnabled) return;
    if (this.provider !== 'claude') return;
    // When main brain runs on Grok, the Anthropic system prompt only covers
    // the Sonnet escalation tier (low volume) — prewarming it isn't worth
    // the cost. Grok via OpenRouter auto-caches identical prefixes, so the
    // main-brain path stays warm on its own through real traffic.
    if (this.mainBrainProvider === 'grok') return;
    try {
      const before = Date.now();
      const result = await this.callClaude(
        'ok',
        { maxTokens: 1 },
        this.modelRoutine,
      );
      const ms = Date.now() - before;
      this.logger.debug(
        `[Prewarm] ok model=${result.model} in=${result.inputTokens} out=${result.outputTokens} ms=${ms}`,
      );
    } catch (err) {
      this.logger.debug(`[Prewarm] skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Account firewall: sanitize assembled prompt to prevent cross-account data leaks.
   * Runs once on the final prompt string — catches leaks from identity, memories, rules, context.
   */
  private sanitizePromptForAccount(prompt: string, context: AiContext): string {
    // Redact internal warehouse/phone first — runs on every path,
    // including when no ACTIVE ACCOUNT marker is present.
    prompt = AiService.stripInternalAddresses(prompt);
    // Extract account from rental context (ACTIVE ACCOUNT line)
    const accountMatch = prompt.match(/ACTIVE ACCOUNT:\s*(Leo Adams|DB Cinema)/i);
    if (!accountMatch) return prompt; // No account context, skip

    const isLeo = /leo adams/i.test(accountMatch[1]);

    if (isLeo) {
      // Leo is the active account. Strip ONLY DB Cinema's identifiers that may
      // leak in via memories/rental-context/additional-context. Keep Leo's own
      // address intact (it's injected for the live reply).
      const cleaned = prompt
        .replace(/\bDaniel(?:'s)?\b/gi, 'the owner')
        .replace(/\bDB Cinema(?:\s+Rentals?)?\b/gi, 'the other account')
        .replace(/\bStatue of James II[^\n.]*/gi, '[other pickup]')
        .replace(/\b11 Trafalgar Square\b/gi, '[other pickup]')
        .replace(/\bWC2N\s*5DN\b/gi, '[other postcode]');
      return AiService.stripInternalAddresses(cleaned);
    } else {
      // DB Cinema is the active account. Strip ONLY Leo's identifiers; keep
      // DB Cinema's own Trafalgar address intact.
      const cleaned = prompt
        .replace(/\bLeo Adams\b/gi, 'the other account')
        .replace(/\b5 Pall Mall East[^\n.]*/gi, '[other pickup]')
        .replace(/\bSW1Y\s*5BF\b/gi, '[other postcode]');
      return AiService.stripInternalAddresses(cleaned);
    }
  }

  /** Remove internal dispatch/warehouse addresses and phone — defense in depth
   *  even though the memory [fact] entries say "NEVER share". Model can't leak
   *  what it never sees. */
  private static stripInternalAddresses(text: string): string {
    return text
      .replace(/\b23\s*Whitcomb\s*Street,?\s*WC2H\s*7ER\b[^\n.]*/gi, '[internal address redacted]')
      .replace(/\bWC2H\s*7ER\b/gi, '[internal postcode redacted]')
      .replace(/\b020\s*7387\s*8888\b/g, '[internal phone redacted]');
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

        // Account firewall: dynamic block only. The static block is now
        // account-agnostic (DB components use "the owner" in place of literal
        // names) so both accounts share the cached system prefix, doubling
        // cache hit rate vs per-account cache entries.
        staticBlock = blocks.staticBlock;
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

      // Dynamic max_tokens: 650 for renter-facing calls, 350 for lightweight extraction.
      // Callers that need more (Sonnet complex/adaptive) pass explicit maxTokens: 1000.
      // 650 is plenty for Haiku — responses rarely exceed 500 tokens and this saves ~35% output budget.
      let baseMaxTokens = context.lightweight ? 350 : 650;
      if (!context.maxTokens && userMessage.length > 500) {
        baseMaxTokens = Math.min(baseMaxTokens + 150, 1150);
      }
      const maxTokens = context.maxTokens || baseMaxTokens;

      // PROMPT CACHING: System prompt is purely static — cache it on ALL renter-facing calls.
      // With multiple renters messaging within the 5-min TTL, cross-request cache hits
      // save 90% on the ~4K token system prompt. Cache write cost (1.25x) breaks even
      // after just 2 hits — easily achieved with normal message volume.
      const shouldCacheSystem = !context.lightweight;
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
        // Cache the tool schema on the LAST tool definition so the whole tools array
        // (400-1500 tokens depending on tool count) replays at 90% discount on subsequent calls.
        // Anthropic treats cache_control on a block as "cache everything up to and including this block".
        const toolsWithCache = this.TOOLS.map((t, i) =>
          i === this.TOOLS.length - 1
            ? ({ ...t, cache_control: { type: 'ephemeral' as const } } as any)
            : t,
        );
        createParams.tools = toolsWithCache;
      }

      // Conversation-turn caching: when the user sends a follow-up within the 5-min TTL
      // (common in dashboard Q&A and rapid renter back-and-forth), mark the most recent
      // user message as a cache breakpoint so the whole message history + tools prefix
      // is read from cache on the next turn. Anthropic permits up to 4 breakpoints total;
      // we use 1 on system + 1 on tools + 1 on last message = 3 (within limit).
      if (createParams.tools && messages.length > 0) {
        const lastIdx = messages.length - 1;
        const last = messages[lastIdx];
        if (typeof last.content === 'string') {
          messages[lastIdx] = {
            ...last,
            content: [
              {
                type: 'text',
                text: last.content,
                cache_control: { type: 'ephemeral' as const },
              } as any,
            ],
          };
        } else if (Array.isArray(last.content) && last.content.length > 0) {
          const blocks = [...last.content] as any[];
          blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' as const } };
          messages[lastIdx] = { ...last, content: blocks };
        }
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
