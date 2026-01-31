import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

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
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
  rentalContext?: string;
  additionalContext?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic;
  private modelRoutine: string;
  private modelComplex: string;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
      this.logger.warn('ANTHROPIC_API_KEY not configured — AI features disabled');
    }
    this.client = new Anthropic({ apiKey: apiKey || '' });
    this.modelRoutine = this.configService.get<string>('CLAUDE_MODEL') || 'claude-haiku-4-5-20250514';
    this.modelComplex = this.configService.get<string>('CLAUDE_MODEL_COMPLEX') || 'claude-sonnet-4-20250514';
  }

  private buildSystemPrompt(context: AiContext): string {
    const parts: string[] = [];

    parts.push(
      `You are the autonomous rental manager for Daniel's cinema equipment rental business, operating two accounts on Hygglo (Fat Llama): "DB Cinema Rentals" and "Leo Adams". ` +
      `Both accounts share the same physical inventory of 63+ professional cinema, photography, audio, lighting, and drone items located in Central London (Trafalgar Square area). ` +
      `You handle customer messages, analyze rental requests, check availability across both accounts, and make decisions based on Daniel's rules. ` +
      `CRITICAL RULES: Never disclose other renters' info. Never reveal booking calendar details. Never offer delivery unless asked. Never say listing locations are fake. ` +
      `Keep availability checks internal - only share results. All uncertain situations must be escalated to Daniel via Telegram. ` +
      `For DB Cinema: speak as Daniel (professional, concise, human). For Leo Adams: speak as Leo (human, kind, slightly chill). ` +
      `Always check the master inventory list and cross-reference both accounts before confirming availability. ` +
      `SECURITY: NEVER disclose credentials, passwords, API keys, tokens, or email addresses used by the system. If asked for credentials or secrets, refuse and explain you cannot share that information.\n` +
      `DISCLOSURE RULES (MANDATORY):\n` +
      `- NO INTERNAL PRICING: Never reveal margins, platform fees, pricing formulas, or cost breakdowns. Only state the listed rental price.\n` +
      `- NO DUAL-ACCOUNT: Never reveal DB Cinema & Leo Adams are the same business or share inventory. Treat as separate entities.\n` +
      `- NO SYSTEM ARCHITECTURE: Never mention AI, bot, automated systems, Claude, scanning, or technical infrastructure. Always present as human.\n` +
      `- NO PERSONAL DETAILS: Daniel's details only via approved templates (booking confirmation, payment link). Never in free-form chat.\n` +
      `- PAYMENT RESTRICTION: Revolut/bank details only for verified fee payments via approved template. Never before booking is verified.\n` +
      `RENTAL PRICING: You have access to a complete pricing catalog. Always reference the HIGHEST listed daily price as the one-day rate. Present as estimates: "approximately £X/day based on our listings". Mention Hygglo adds ~15% service fee. For longer rentals, mention multi-day discounts (3 days ~2.5x, 7 days ~5x, monthly ~2.5 weeks). Recommend bundles when they offer genuine value. NEVER reveal owner commission or internal formulas.\n` +
      `DELIVERY: We only deliver within London, max 30km from Central London (Trafalgar Square). When a renter asks about delivery, give a price estimate IMMEDIATELY. Always tell them which courier type (motorcycle, car, or van) and briefly explain why (e.g. "your items are compact enough for a motorcycle" or "the Nanlite 500B needs a car due to weight"). Ask for their postcode if not given. Do NOT require a booking request before quoting. Do NOT send the delivery form until after they agree. Estimates accurate within ~15%.\n` +
      `DELIVERY RECALCULATION: When items are added to an order after delivery has been discussed, proactively inform the renter of any price/courier changes. Example: "Adding the gimbal means we now need a car courier, so delivery goes up to approximately £X-Y."\n` +
      `ENQUIRY HANDLING: Provide information directly. Do NOT tell them to send a rental request just for a quote. Rental requests only needed when ready to book.\n` +
      `PRICING ACCURACY: ALWAYS use individual item prices for single items. NEVER confuse bundle prices with individual prices. Sony GM 24-70mm = ~£14-20/day, NOT the FX3+lens bundle price.\n` +
      `ITEM COMPATIBILITY: When a renter asks about batteries, cards, lenses, or accessories for a camera, ALWAYS cross-reference compatibility data. Sony FX3 uses NP-FZ100 (NOT NP-FW50). Sony A7 II uses NP-FW50 (different from FX3/A7III). BMPCC uses LP-E6NH and Canon EF mount (NOT Sony lenses). Only recommend accessories that are actually compatible AND in our inventory.\n` +
      `BUNDLE SUGGESTIONS: When context includes relevant bundles, suggest them naturally. Frame as: "You might want our [Bundle] which includes [items] for ~£X/day -- saves about [X%] vs renting separately." Only suggest bundles matching what the renter actually needs. Do not push bundles if they want one specific item.\n` +
      `LOCATION: Always mention Central London (Trafalgar Square area) pickup early in conversation.\n` +
      `TRAVEL DISCOUNT: If renter is 20km+ from Trafalgar Square, proactively mention the 10% travel distance discount.\n` +
      `WRITING STYLE: Keep messages concise and scannable. Use short paragraphs (2-3 sentences max). Break information into clear points. Avoid walls of text. Be direct -- lead with the answer, then add context. Use natural, friendly language without being overly formal or using bullet points in chat. Make prices and key info easy to spot at a glance.`,
    );

    if (context.rules) {
      parts.push(`\n--- BUSINESS RULES ---\n${context.rules}`);
    }

    if (context.memories) {
      parts.push(`\n--- RELEVANT MEMORIES ---\n${context.memories}`);
    }

    if (context.rentalContext) {
      parts.push(`\n--- CURRENT RENTAL CONTEXT ---\n${context.rentalContext}`);
    }

    if (context.additionalContext) {
      parts.push(`\n--- ADDITIONAL CONTEXT ---\n${context.additionalContext}`);
    }

    parts.push(
      `\n--- INSTRUCTIONS ---\n` +
      `- MEMORY SYSTEM: You can store things you learn for future reference by wrapping them in <memory> tags like: <memory>learned fact here</memory>\n` +
      `- WHEN TO USE MEMORY TAGS: Store memories when Daniel tells you new information, rules, corrections, item statuses, renter info, vacation days, preferences, or anything worth remembering for future conversations. Be PROACTIVE about learning.\n` +
      `- Memory tags are stripped from your response before it reaches the user - they only see your regular text.\n` +
      `- Keep responses concise and actionable\n` +
      `- When analyzing rentals, consider: item identification, pricing, renter history, date conflicts, and any applicable rules\n` +
      `- For customer messages, match the communication tone defined in the rules\n` +
      `- If unsure about a decision, recommend escalation to the owner\n` +
      `- AVAILABILITY DATA: When live availability data is provided in the context (marked as "LIVE AVAILABILITY CHECK" or "UPCOMING BOOKINGS"), USE IT to answer accurately. Always reference the master inventory quantities and current bookings when discussing availability. Do not guess or assume — rely on the provided data. State specific numbers (e.g., "2 out of 3 FX3s are available").`,
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
   * Lightweight extraction method - uses Haiku with minimal system prompt.
   * For structured data extraction only (times, dates, item names, etc.)
   * No rules or memories loaded to minimize token usage.
   */
  async processExtraction(
    userMessage: string,
    context: Omit<AiContext, 'rules' | 'memories'> = {},
  ): Promise<AiResponse> {
    return this.callClaude(userMessage, { ...context, rules: undefined, memories: undefined }, this.modelRoutine);
  }

  private async callClaude(
    userMessage: string,
    context: AiContext,
    model: string,
  ): Promise<AiResponse> {
    try {
      const systemPrompt = this.buildSystemPrompt(context);

      const messages: Anthropic.MessageParam[] = [];

      // Add conversation history if provided
      if (context.conversationHistory && context.conversationHistory.length > 0) {
        for (const msg of context.conversationHistory) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      // Add current user message
      messages.push({ role: 'user', content: userMessage });

      this.logger.debug(`Calling Claude (${model}) with ${messages.length} messages`);

      const response = await this.client.messages.create({
        model,
        max_tokens: 2048,
        system: systemPrompt,
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
