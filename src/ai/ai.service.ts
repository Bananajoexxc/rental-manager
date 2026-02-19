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

export interface ToolHandlers {
  checkAvailability?: (itemName: string, startDate: string, endDate: string) => Promise<string>;
  lookupPricing?: (itemName: string, days: number) => Promise<string>;
  checkCompatibility?: (items: string[]) => Promise<string>;
  getRentalDetails?: (rentalId: string) => Promise<string>;
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
  /** Image URLs attached to the current renter message (for multimodal analysis) */
  imageUrls?: string[];
  /** Tool handlers for function calling — AI can request real-time data */
  toolHandlers?: ToolHandlers;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic;
  private modelRoutine: string;
  private modelComplex: string;
  private modelLightweight: string;

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
    this.modelLightweight = this.configService.get<string>('CLAUDE_MODEL_LIGHTWEIGHT') || 'claude-3-haiku-20240307';
  }

  /** Tool schemas for Claude function calling */
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
  ];

  /** Execute a single tool call and return the result string */
  private async executeToolCall(
    name: string,
    input: any,
    handlers: ToolHandlers,
  ): Promise<string> {
    try {
      switch (name) {
        case 'check_availability':
          return handlers.checkAvailability?.(input.item_name, input.start_date, input.end_date)
            ?? 'Tool not available';
        case 'lookup_pricing':
          return handlers.lookupPricing?.(input.item_name, input.days) ?? 'Tool not available';
        case 'check_compatibility':
          return handlers.checkCompatibility?.(input.items) ?? 'Tool not available';
        case 'get_rental_details':
          return handlers.getRentalDetails?.(input.rental_id) ?? 'Tool not available';
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Tool error: ${err.message}`;
    }
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

  private async buildSystemPrompt(context: AiContext, temporalBlock?: string): Promise<string> {
    const parts: string[] = [];

    // Get base system prompt from prompt manager (DB-backed modular components)
    // Pass conversation stage to gate irrelevant components (saves ~800-2000 input tokens in later stages)
    const basePrompt = await this.promptManager.buildSystemPrompt('message', context.conversationStage);
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

    // ACTIVE IDENTITY — placed BEFORE enforcement as context framing (not override)
    if (context.rentalContext) {
      parts.push(`\n--- CURRENT RENTAL CONTEXT ---\n${context.rentalContext}`);
    }

    // AUTHORITY & ENFORCEMENT — placed LAST for maximum signal strength (recency bias)
    // This is the AI's "constitution" — it defines what the AI CAN and CANNOT do.
    // Everything above is context. This section is LAW.
    parts.push(
      '\n--- YOUR AUTHORITY (READ THIS LAST — THIS OVERRIDES EVERYTHING ABOVE) ---\n' +
      'You REPRESENT Daniel\'s rental business. You are NOT Daniel. You do NOT have Daniel\'s authority to make business decisions.\n\n' +

      'THINGS YOU CAN DO (autonomously):\n' +
      '- Answer questions about items in MASTER_INVENTORY using ONLY facts provided to you\n' +
      '- Quote prices that appear in the booking/rental context above\n' +
      '- Suggest complementary gear based on the renter\'s stated project\n' +
      '- Confirm pickup at "Central London (Trafalgar Square area)" — no specific address until booking confirmed\n' +
      '- Offer 10am-12pm pickup FIRST, then 7pm-9pm as alternative\n' +
      '- Guide renters through identity verification when needed\n' +
      '- Mention that longer rentals work out cheaper (without revealing thresholds)\n' +
      '- Say "we don\'t currently stock that" for items not in MASTER_INVENTORY\n' +
      '- Handle first-time rental discounts — but ONLY if the context above contains a "--- FIRST-TIME RENTER" section. The system verifies first-time status from their Hygglo profile before adding this section. If this section is ABSENT from the context, you MUST NOT offer any first-time discount regardless of profit amount:\n' +
      '  → PROACTIVE (context says "PROACTIVE DISCOUNT"): Offer the £15 discount naturally in your response without them asking. Work it in casually. Add <memory>FIRST_TIME_DISCOUNT_ACCEPTED</memory> in your response.\n' +
      '  → REACTIVE (context says "FIRST-TIME RENTER" without "PROACTIVE"): Only offer if they ask about first-time discounts/vouchers. Say the voucher feature isn\'t working but you can manually knock £15 off. If they accept, confirm and add <memory>FIRST_TIME_DISCOUNT_ACCEPTED</memory>.\n' +
      '  → NO "FIRST-TIME RENTER" SECTION IN CONTEXT: If they ask about first-time discounts but there is NO "--- FIRST-TIME RENTER" section anywhere in the context above, you CANNOT offer any discount. Just say "the first-time discount isn\'t available at the moment unfortunately". Do NOT offer £15 off. Do NOT mention any amount. Keep it brief.\n' +
      '- PRICE MATCH: If a renter sends a screenshot or link showing the same item cheaper elsewhere, verify ALL of these:\n' +
      '  1. SAME ITEM: The competitor listing must be for the SAME item(s) or equivalent bundle. Different models/brands don\'t count.\n' +
      '  2. LOCATION: The competitor\'s rental location must be in London Zone 1 or Zone 2 (central London, inner boroughs like Camden, Islington, Hackney, Brixton, Peckham, Shoreditch, etc.). If the location is Zone 3+ or outside London, the price match does NOT apply.\n' +
      '  3. PRICE: The competitor\'s price must be clearly visible in the screenshot/listing.\n' +
      '  If ALL three criteria are met: Confirm the price match and tell them you\'ll beat the competitor by 5%. Say something like "nice find — I can beat that by 5%, so your price would be £X". Calculate: new_price = competitor_price × 0.95. Add <memory>PRICE_MATCH_VERIFIED:competitor_price=NUMBER,our_new_renter_price=NUMBER,item=ITEM_NAME</memory>.\n' +
      '  If ANY criterion fails, decline naturally:\n' +
      '  - Wrong item: "that\'s a different model so the price match wouldn\'t apply here"\n' +
      '  - Outside Zone 1-2: "our price match only covers central London (Zone 1-2) rentals"\n' +
      '  - Price not visible: "I can\'t quite make out the price — could you send a clearer screenshot?"\n' +
      '  - No screenshot/proof: "if you send me a screenshot of the listing I can check if we can match it"\n' +
      '- ADD ITEM TO EXISTING BOOKING: If a renter with a CONFIRMED booking asks to add an item (e.g. "can I also get a tripod?", "I\'d like to add a lens"), ' +
      'tell them they\'ll need to send a new separate rental request on the platform for the additional item. ' +
      'Keep it casual: "for adding extra items I\'d need you to send a new request on the platform for [item] — that way I can confirm availability and get it sorted for you". ' +
      'Add <memory>ADD_ITEM_REQUESTED:item=ITEM_NAME</memory> with the specific item they asked about. ' +
      'This ONLY applies when they already have a confirmed/accepted booking — during inquiry stage, just handle it as part of the normal conversation.\n\n' +

      'THINGS YOU MUST ESCALATE (say "let me check and get back to you"):\n' +
      '- ANY price negotiation or "too expensive" complaint (EXCEPT first-time discount and price match handled above)\n' +
      '- ANY request for free items, compensation, or fee waiver\n' +
      '- Same-day rental approval\n' +
      '- Anything outside normal booking flow (refunds, complaints about service, policy exceptions)\n' +
      '- Technical specs you don\'t have data for\n\n' +

      'THINGS YOU CANNOT DO (hard constraints — violation = system block):\n' +
      '- Offer first-time discounts or £15 off UNLESS the context above contains "--- FIRST-TIME RENTER". If that section is missing, the renter is NOT verified as first-time. Say "not available at the moment" and move on. NEVER offer money off based on your own judgement.\n' +
      '- Fabricate facts: NO made-up specs, runtimes, distances, prices, or item names\n' +
      '- Break lens mount physics: Sony cameras = Sony E-mount ONLY. Blackmagic = Canon EF ONLY. These are physically incompatible.\n' +
      '- Mention platform fees, service fees, Hygglo, or any platform name — not even to deny them\n' +
      '- Share specific address/postcode before booking confirmed\n' +
      '- Reveal items are centralised or that listing locations are approximate\n' +
      '- Reveal discount thresholds, percentages, or qualification criteria\n' +
      '- Reveal that DB Cinema and Leo Adams are the same business\n' +
      '- Use markdown formatting (bold, bullets, headers) — plain text only, like texting\n' +
      '- Add signatures, sign-offs, or "Cheers, Daniel" — just end naturally\n' +
      '- Downsell: never say renter has "enough" or "doesn\'t need" something\n' +
      '- Offer distance discount when the renter is NOT being redirected from a non-central listing. The discount is an apology for redirecting from a distant listing location (Hackney, Shoreditch, Croydon, etc.) to central. It does NOT apply for central-zone listings (SE1, SW1, WC2, EC1, W1, E1 areas) where Trafalgar Square is already nearby. NEVER ask "where are you based?" to determine discount eligibility — use LISTING_LOCATION from rental context only. Delivery postcodes do NOT affect discounts.\n' +
      '- Promise actions you cannot perform: you CANNOT "add items to a booking", "update pickup times in the system", "send payment links", or "check and get back later". You can only draft messages. Say "I\'ll pass that on" or "Daniel will sort that" instead of "I\'ll do X".\n' +
      '- Guess technical specs (battery life, exact weight, firmware versions, flare colors) unless the data is in your context. Say "I\'d need to double-check that" rather than guessing.\n',
    );

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
    if (/\b(complain|disappointed|frustrated|unacceptable|terrible|awful|refund|compensat|escalat|annoying|ridiculous|rip.?off)\b/i.test(message)) {
      signals += 2;
    }

    // Price negotiation attempts (not simple "do you do discounts?" which has a canned answer)
    if (/\b(too expensive|lower price|better deal|best price|negotiate|can you do .* for|feels? steep|saw.*cheaper|over.?priced)\b/i.test(message)) {
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
    const itemMentions = (message.match(/\b(fx3|fx6|a7|bmpcc|pocket|gimbal|lens|camera|drone|light|mic|monitor|slider|tripod|nanlite|atomos|rode|dji|sony|blackmagic|wireless|v.?mount|battery|batteries)\b/gi) || []).length;
    const bundleMentions = (message.match(/\b(bundle|package|kit|combo|set)\b/gi) || []).length;
    if (itemMentions >= 3 || bundleMentions >= 2) {
      signals += 2;
    } else if (itemMentions >= 2) {
      signals += 1;
    }

    // Multi-part questions — renter asking about 2+ different topics
    const questionMarks = (message.match(/\?/g) || []).length;
    const alsoActually = /\b(also|actually|and also|plus|as well|another thing)\b/i.test(message);
    if (questionMarks >= 2 || (questionMarks >= 1 && alsoActually)) {
      signals += 1;
    }

    // Adding items to existing booking (logistics reasoning needed)
    if (/\b(add|adding|throw in|include|can you also|want to get)\b/i.test(message) && itemMentions >= 1) {
      signals += 1;
    }

    // Delivery with postcode (requires distance calculation reasoning)
    if (hasDelivery && /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(message)) {
      signals += 1;
    }

    // Cancellation, rescheduling, or date change — strong signal
    if (/\b(cancel|reschedul|change date|move the date|postpone|different day)\b/i.test(message)) {
      signals += 2;
    }

    // Location complaints or pickup issues
    if (/\b(too far|not convenient|wrong location|different location|why.*not at)\b/i.test(message)) {
      signals += 2;
    }

    // Very long messages (likely complex multi-part questions)
    if (message.length > 600) {
      signals += 2;
    } else if (message.length > 350) {
      signals += 1;
    }

    // Conversation history is deep (complex ongoing negotiation)
    if (context.conversationHistory && context.conversationHistory.length > 6) {
      signals += 1;
    }

    return signals >= 2;
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
   * For structured data extraction, intent classification, summaries — NOT renter-facing.
   */
  async processExtraction(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    return this.callClaude(userMessage, { ...context, rules: undefined, memories: undefined }, this.modelLightweight);
  }

  /**
   * Sonnet-grade extraction — for tasks where Haiku lacks nuance (e.g. time negotiation context).
   * Strips rules/memories like processExtraction, but uses Sonnet with generous token budget.
   */
  async processExtractionComplex(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    return this.callClaude(userMessage, { ...context, rules: undefined, memories: undefined, maxTokens: 1024 }, this.modelComplex);
  }

  /**
   * Lightweight internal analysis — uses Claude 3 Haiku for non-renter-facing tasks.
   * Market reports, memory classification, internal summaries.
   */
  async processLightweight(
    userMessage: string,
    context: AiContext = {},
  ): Promise<AiResponse> {
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

      // Add current user message (multimodal if images present)
      if (context.imageUrls && context.imageUrls.length > 0) {
        const contentBlocks: Anthropic.ContentBlockParam[] = [
          { type: 'text', text: userMessage },
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
        messages.push({ role: 'user', content: userMessage });
      }

      this.logger.debug(`Calling Claude (${model}) with ${messages.length} messages`);

      // Dynamic max_tokens: use context override or lean defaults
      const maxTokens = context.maxTokens || (model === this.modelComplex ? 800 : 500);

      // Use prompt caching for the static system prompt portion
      const createParams: any = {
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
      };

      // Add tools if handlers are provided
      if (context.toolHandlers) {
        createParams.tools = this.TOOLS;
      }

      let response = await this.client.messages.create(createParams);
      let totalInput = response.usage.input_tokens;
      let totalOutput = response.usage.output_tokens;

      // Tool-use loop: max 3 iterations to prevent infinite loops
      let iterations = 0;
      while (response.stop_reason === 'tool_use' && context.toolHandlers && iterations < 3) {
        iterations++;
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const toolResultContent: any[] = [];

        for (const block of toolUseBlocks) {
          const toolBlock = block as Anthropic.ToolUseBlock;
          const result = await this.executeToolCall(toolBlock.name, toolBlock.input, context.toolHandlers);
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
      }

      const rawContent = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as Anthropic.TextBlock).text)
        .join('\n');

      const memories = this.extractMemories(rawContent);
      const cleanContent = this.stripMemoryTags(rawContent);

      this.logger.log(
        `Claude response: ${model}, in=${totalInput}, out=${totalOutput}${iterations > 0 ? `, tools=${iterations}` : ''}, memories=${memories.length}`,
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
