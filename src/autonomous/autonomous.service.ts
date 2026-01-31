import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { RulesService } from '../rules/rules.service';
import { MemoryService } from '../memory/memory.service';
import { TelegramService } from '../telegram/telegram.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { BlacklistService } from '../blacklist/blacklist.service';
import { DemandService } from '../demand/demand.service';
import { CalendarService } from '../calendar/calendar.service';
import { DeliveryService } from '../delivery/delivery.service';
import { findBestMatch, getInventoryItemNames } from '../utils/item-matcher';

export interface HyggloMessage {
  rentalId: string;
  sender: string;
  content: string;
  timestamp: string;
  isNew: boolean;
}

@Injectable()
export class AutonomousService {
  private readonly logger = new Logger(AutonomousService.name);
  private lastHealthPing: Date = new Date();

  constructor(
    private prisma: PrismaService,
    private aiService: AiService,
    private rulesService: RulesService,
    private memoryService: MemoryService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private hyggloService: HyggloService,
    private blacklistService: BlacklistService,
    private demandService: DemandService,
    private calendarService: CalendarService,
    private deliveryService: DeliveryService,
  ) {}

  /**
   * Try regex-based time extraction before falling back to AI.
   * Returns extracted times if confidence is high, null otherwise.
   */
  private tryRegexTimeExtraction(content: string): {
    pickupTime?: string; returnTime?: string;
    pickupDate?: string; returnDate?: string;
    confidence: 'high' | 'low';
  } | null {
    const result: { pickupTime?: string; returnTime?: string; pickupDate?: string; returnDate?: string; confidence: 'high' | 'low' } = { confidence: 'low' };

    // Match patterns like "pickup at 10am", "collect at 7pm", "pick up at 11:00"
    const pickupPattern = /(?:pickup|pick\s*up|collect)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
    const returnPattern = /(?:return|drop\s*off|dropoff|bring\s*back)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

    const pickupMatch = content.match(pickupPattern);
    if (pickupMatch) {
      let hours = parseInt(pickupMatch[1]);
      const minutes = pickupMatch[2] ? parseInt(pickupMatch[2]) : 0;
      const ampm = pickupMatch[3]?.toLowerCase();
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;
      result.pickupTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    const returnMatch = content.match(returnPattern);
    if (returnMatch) {
      let hours = parseInt(returnMatch[1]);
      const minutes = returnMatch[2] ? parseInt(returnMatch[2]) : 0;
      const ampm = returnMatch[3]?.toLowerCase();
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;
      result.returnTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    // Date patterns: "on the 5th", "on Monday", "on 2025-01-15"
    const datePattern = /on\s+(?:the\s+)?(\d{4}-\d{2}-\d{2})/gi;
    const dateMatches = [...content.matchAll(datePattern)];
    if (dateMatches.length >= 1) result.pickupDate = dateMatches[0][1];
    if (dateMatches.length >= 2) result.returnDate = dateMatches[1][1];

    if (!result.pickupTime && !result.returnTime) return null;

    // High confidence if we got clear am/pm indicators or :MM format
    const hasExplicitFormat = (pickupMatch && (pickupMatch[3] || pickupMatch[2])) ||
      (returnMatch && (returnMatch[3] || returnMatch[2]));
    result.confidence = hasExplicitFormat ? 'high' : 'low';

    return result;
  }

  // --- Triggered by scanner when new rental detected ---

  async onNewRental(rental: any) {
    this.logger.log(`Autonomous pipeline triggered for rental: ${rental.title}`);

    try {
      // Check blacklist
      const renterName = rental.renter_info || '';
      const blacklistCheck = await this.blacklistService.isBlacklisted(renterName);

      if (blacklistCheck.blacklisted) {
        await this.telegramService.sendProactiveMessage(
          `🚫 *BLACKLIST ALERT*\n\n` +
          `├ 📦 Rental: ${rental.title}\n` +
          `├ 👤 Renter: ${renterName}\n` +
          `├ ⚠️ Matched: ${blacklistCheck.entry.name}\n` +
          `└ Reason: ${blacklistCheck.entry.reason}\n\n` +
          `_Auto-flagged for review._`,
        );
      }

      // Record demand
      const items = rental.title ? [rental.title] : [];
      await this.demandService.recordDemand({
        items,
        renter_name: renterName,
        dates_start: rental.start_date,
        dates_end: rental.end_date,
        outcome: 'pending',
        source: 'hygglo',
      });

      // 1. Gather context (include pricing data for rental evaluation)
      const rules = await this.rulesService.getFormattedRules();
      const [generalMemories, pricingMemories] = await Promise.all([
        this.memoryService.getRelevantMemories([
          rental.title,
          rental.renter_info || '',
          'rental',
          'new',
        ]),
        this.memoryService.getPricingMemories(),
      ]);
      const memories = [generalMemories, pricingMemories].filter(Boolean).join('\n');

      const rentalContext =
        `New rental detected:\n` +
        `Title: ${rental.title}\n` +
        `Status: ${rental.status}\n` +
        `Renter: ${rental.renter_info || 'Unknown'}\n` +
        `URL: ${rental.listing_url}\n` +
        `Description: ${(rental.description || '').substring(0, 500)}\n` +
        `Photos: ${(rental.photos_urls || []).length} photos` +
        (blacklistCheck.blacklisted ? `\n\nWARNING: This renter is BLACKLISTED. Reason: ${blacklistCheck.entry.reason}` : '');

      // 2. Ask Claude to analyze and decide
      const analysisPrompt =
        `A new rental request has appeared. Analyze it and decide what action to take.\n\n` +
        `Consider:\n` +
        `- What items are being rented?\n` +
        `- Does the pricing seem right based on our inventory?\n` +
        `- Should we send a welcome message to the renter?\n` +
        `- Any concerns or flags?\n` +
        (blacklistCheck.blacklisted ? `- CRITICAL: This renter is BLACKLISTED. DO NOT approve.\n` : '') +
        `\nRespond with:\n` +
        `1. Your analysis (2-3 sentences)\n` +
        `2. Recommended action (e.g., "send welcome message", "approve", "flag for review")\n` +
        `3. If sending a message, include the exact message text after "MESSAGE:"`;

      const response = await this.aiService.processRoutine(analysisPrompt, {
        rules,
        memories,
        rentalContext,
      });

      // 3. Parse the AI response for action
      const actionTaken = await this.executeDecision(rental, response.content);

      // 4. Store the decision
      await this.prisma.ai_decision.create({
        data: {
          rental_id: rental.id,
          decision_type: 'analyze',
          input_summary: `New rental: ${rental.title} by ${rental.renter_info || 'Unknown'}`,
          output_summary: response.content.substring(0, 500),
          confidence: 0.8,
          action_taken: actionTaken,
          notified: true,
        },
      });

      // 5. Read chat history and extract agreed pickup/return times
      let extractedTimes: { pickupTime?: string; returnTime?: string; pickupDate?: string; returnDate?: string } | null = null;
      try {
        extractedTimes = await this.extractTimesFromChatHistory(rental);
      } catch (timeErr) {
        this.logger.warn(`Chat time extraction failed for ${rental.title}: ${timeErr.message}`);
      }

      // 6. Notify owner on Telegram
      await this.telegramService.sendRentalNotification(
        rental,
        response.content,
        actionTaken,
      );

      // 7. Store any memories
      if (response.memories.length > 0) {
        await this.memoryService.processAiMemories(response.memories);
      }

      this.logger.log(`Autonomous pipeline completed for: ${rental.title}`);
    } catch (error) {
      this.logger.error(`Autonomous pipeline error: ${error.message}`);
      await this.telegramService.sendProactiveMessage(
        `❌ *Autonomous Pipeline Error*\n\n` +
        `├ 📦 ${rental.title}\n` +
        `└ Error: ${error.message}`,
      );
    }
  }

  // --- Handle new messages from Hygglo ---

  /**
   * Detect if a message is asking about pricing, costs, or quotes.
   */
  private isPricingQuery(text: string): boolean {
    const pricingTerms = /\b(price|pricing|cost|costs|how much|rate|rates|quote|charge|charges|fee|fees|per day|daily|weekly|monthly|budget|afford|expensive|cheap|discount|deal|£|pound|pounds|rental price|rental rate|what would|total|estimate)\b/i;
    return pricingTerms.test(text);
  }

  /**
   * Detect if a message is asking about delivery, courier, or shipping.
   */
  private isDeliveryQuery(text: string): boolean {
    const deliveryTerms = /\b(deliver|delivery|courier|ship|shipping|post|postcode|send it|drop off|dropoff|bring it|transport|how far|distance|collect from|too far|can you bring|come to me)\b/i;
    return deliveryTerms.test(text);
  }

  /**
   * Extract meaningful keywords from a message for memory lookup.
   */
  private extractSearchKeywords(text: string, extras: string[] = []): string[] {
    // Remove common stop words and extract significant terms
    const stopWords = new Set(['i', 'me', 'my', 'the', 'a', 'an', 'is', 'are', 'was', 'be', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'it', 'do', 'does', 'did', 'will', 'can', 'could', 'would', 'have', 'has', 'had', 'this', 'that', 'with', 'from', 'not', 'but', 'so', 'if', 'just', 'about', 'what', 'how', 'when', 'where', 'who', 'which', 'there', 'here', 'very', 'also', 'please', 'thanks', 'thank', 'you', 'your', 'hi', 'hello', 'hey']);
    const words = text
      .split(/[\s,.\-!?;:()]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()));

    // Deduplicate and add extras
    const seen = new Set<string>();
    const result: string[] = [];
    for (const w of [...words, ...extras]) {
      const lower = w.toLowerCase();
      if (!seen.has(lower) && w.length > 1) {
        seen.add(lower);
        result.push(w);
      }
    }
    return result.slice(0, 15);
  }

  /**
   * Extract inventory items mentioned in a text message using fuzzy matching.
   */
  private extractMentionedItems(text: string): string[] {
    const inventoryNames = getInventoryItemNames();
    const mentioned: string[] = [];
    // Try matching each meaningful phrase segment against inventory
    const segments = text.split(/[,.\n;]+/).map((s) => s.trim()).filter(Boolean);
    for (const segment of segments) {
      const match = findBestMatch(segment, inventoryNames);
      if (match && !mentioned.includes(match)) {
        mentioned.push(match);
      }
    }
    // Also try individual significant words/phrases
    const words = text.split(/\s+/).filter((w) => w.length > 3);
    for (let i = 0; i < words.length; i++) {
      // Try 2-3 word combos
      for (const len of [3, 2, 1]) {
        if (i + len > words.length) continue;
        const phrase = words.slice(i, i + len).join(' ');
        const match = findBestMatch(phrase, inventoryNames);
        if (match && !mentioned.includes(match)) {
          mentioned.push(match);
        }
      }
    }
    return mentioned;
  }

  /**
   * Check if delivery was previously discussed and items are being added.
   * Returns AI context instruction for recalculation if needed.
   */
  private async checkDeliveryRecalculation(
    rental: any,
    currentMessage: string,
    mentionedItems: string[],
  ): Promise<string> {
    // Check for prior delivery discussions on this rental
    const previousDeliveryDecisions = await this.prisma.ai_decision.findMany({
      where: {
        rental_id: rental.id,
        OR: [
          { input_summary: { contains: 'delivery', mode: 'insensitive' } },
          { output_summary: { contains: 'delivery', mode: 'insensitive' } },
          { input_summary: { contains: 'courier', mode: 'insensitive' } },
          { output_summary: { contains: 'postcode', mode: 'insensitive' } },
        ],
      },
      orderBy: { created_at: 'desc' },
      take: 3,
    });

    if (previousDeliveryDecisions.length === 0) return '';

    // Check if this message is adding items
    const addItemPatterns = /\b(also|add|include|throw in|plus|and also|want to add|can i also|as well|extra|additional|another)\b/i;
    const isAddingItems = addItemPatterns.test(currentMessage) && mentionedItems.length > 0;

    if (!isAddingItems) return '';

    return (
      `\nDELIVERY RECALCULATION: Delivery was previously discussed for this rental. ` +
      `The renter is adding items (${mentionedItems.join(', ')}). ` +
      `You MUST inform them that the delivery quote may change. ` +
      `If new items change the courier type (e.g. motorcycle -> car), explain why. ` +
      `Give the updated delivery estimate.`
    );
  }

  async onNewMessages(messages: HyggloMessage[]) {
    for (const msg of messages) {
      if (!msg.isNew) continue;

      this.logger.log(`New message from ${msg.sender} on rental ${msg.rentalId}`);

      try {
        // Find the rental
        const rental = await this.prisma.rental.findFirst({
          where: { listing_id: msg.rentalId },
        });

        if (!rental) {
          this.logger.warn(`Rental not found for message: ${msg.rentalId}`);
          continue;
        }

        // Extract meaningful keywords from the message
        const keywords = this.extractSearchKeywords(msg.content, [msg.sender, rental.title]);

        // Detect items mentioned in the message for compatibility/bundle context
        const mentionedItems = this.extractMentionedItems(msg.content);

        // Detect pricing and delivery intent and fetch appropriate memories
        const hasPricingIntent = this.isPricingQuery(msg.content);
        const hasDeliveryIntent = this.isDeliveryQuery(msg.content);
        let memories: string;

        if (hasPricingIntent || hasDeliveryIntent) {
          // Fetch pricing catalog + delivery memories + general keyword memories
          const deliveryKeywords = hasDeliveryIntent ? ['Delivery Pricing Zones', 'Delivery Courier Framework', 'Delivery Rules', 'Delivery Mandatory'] : [];
          const [pricingCatalog, keywordMem, deliveryMem] = await Promise.all([
            hasPricingIntent ? Promise.resolve(this.memoryService.getPricingCatalogContext()) : Promise.resolve(''),
            this.memoryService.getMinimalMemories(keywords, 8),
            hasDeliveryIntent ? this.memoryService.getMinimalMemories(deliveryKeywords, 5) : Promise.resolve(''),
          ]);
          memories = [pricingCatalog, deliveryMem, keywordMem].filter(Boolean).join('\n');
        } else {
          memories = await this.memoryService.getMinimalMemories(keywords, 8);
        }

        // Add compatibility context if items are mentioned
        if (mentionedItems.length > 0) {
          const compatContext = this.memoryService.getCompatibilityContext(mentionedItems);
          if (compatContext) {
            memories = [memories, compatContext].filter(Boolean).join('\n');
          }
        }

        // Add bundle suggestion context
        const bundleContext = this.memoryService.getBundleSuggestionContext(msg.content, mentionedItems);
        if (bundleContext) {
          memories = [memories, bundleContext].filter(Boolean).join('\n');
        }

        // Check if delivery needs recalculation (items being added after prior delivery discussion)
        const deliveryRecalc = await this.checkDeliveryRecalculation(rental, msg.content, mentionedItems);

        const pricingInstruction = hasPricingIntent
          ? `The renter is asking about pricing. Reference the pricing catalog to give an accurate estimate. ` +
            `Always quote the ONE-DAY price (highest listed) and mention multi-day discounts are available. ` +
            `Present as ESTIMATES. Mention Hygglo service fee (~15%) applies on top. ` +
            `If a relevant bundle exists, suggest it as better value. ` +
            `CRITICAL: Quote INDIVIDUAL item price for single items -- never confuse with bundle prices. ` +
            `NEVER reveal owner margins. Do NOT require a rental request just for a quote.\n`
          : '';

        const deliveryInstruction = hasDeliveryIntent
          ? `The renter is asking about delivery. We only deliver within London (max 30km from Central London). ` +
            `Give a delivery price estimate DIRECTLY based on the delivery pricing zones. ` +
            `Tell them which courier type their items need (motorcycle, car, or van) and briefly explain why. ` +
            `Ask for their postcode if not provided. Do NOT require a booking request before giving a quote. ` +
            `Do NOT send the delivery booking form yet -- just the price estimate first.\n`
          : '';

        const messagePrompt =
          `A renter sent a message on Hygglo. Draft a reply.\n\n` +
          `Renter: ${msg.sender}\n` +
          `Their message: "${msg.content}"\n` +
          `Rental: ${rental.title}\n\n` +
          `${pricingInstruction}` +
          `${deliveryInstruction}` +
          `${deliveryRecalc}` +
          `Reply following our communication tone rules. Keep it concise, clear, and well-formatted.\n` +
          `Start your response with the exact reply text (no preamble).`;

        const response = await this.aiService.processRoutine(messagePrompt, {
          memories,
          rentalContext: `Current rental: ${rental.title}, status: ${rental.status}, renter: ${rental.renter_info}`,
        });

        // Send the reply on Hygglo (gated by READ_ONLY_MODE)
        const readOnly = process.env.READ_ONLY_MODE === 'true';
        let actionTaken: string;
        if (readOnly) {
          this.logger.warn(`BLOCKED [READ_ONLY_MODE] Draft reply for rental ${msg.rentalId}: "${response.content.substring(0, 100)}..."`);
          actionTaken = `BLOCKED - read-only mode. Draft: "${response.content.substring(0, 100)}..."`;
        } else {
          actionTaken = 'Drafted reply (not sent - messaging not yet enabled)';
          try {
            await this.hyggloService.sendMessage(msg.rentalId, response.content);
            actionTaken = `Sent reply: "${response.content.substring(0, 100)}..."`;
          } catch (sendError) {
            this.logger.warn(`Could not send Hygglo message: ${sendError.message}`);
            actionTaken = `Failed to send: ${sendError.message}. Draft: "${response.content.substring(0, 100)}..."`;
          }
        }

        // Store decision
        await this.prisma.ai_decision.create({
          data: {
            rental_id: rental.id,
            decision_type: 'message',
            input_summary: `Message from ${msg.sender}: "${msg.content.substring(0, 200)}"`,
            output_summary: response.content.substring(0, 500),
            confidence: 0.75,
            action_taken: actionTaken,
            notified: true,
          },
        });

        // Notify owner
        await this.telegramService.sendProactiveMessage(
          `💬 *New Hygglo Message*\n\n` +
          `├ 📦 ${rental.title}\n` +
          `├ 👤 From: ${msg.sender}\n` +
          `├ 💬 ${msg.content}\n` +
          `├ 🤖 Reply: ${response.content}\n` +
          `└ Status: ${actionTaken}`,
        );

        if (response.memories.length > 0) {
          await this.memoryService.processAiMemories(response.memories);
        }

        // Attempt to extract pickup/return times from the message
        try {
          await this.extractPickupReturnTimes(msg, rental);
        } catch (timeErr) {
          this.logger.debug(`Time extraction failed for message from ${msg.sender}: ${timeErr.message}`);
        }
      } catch (error) {
        this.logger.error(`Error processing message: ${error.message}`);
      }
    }
  }

  // --- Extract pickup/return times from chat messages ---

  async extractPickupReturnTimes(
    msg: HyggloMessage,
    rental: any,
  ): Promise<void> {
    const content = msg.content;

    // Quick pre-filter: skip if the message doesn't seem to mention times
    const timePatterns = /\b(\d{1,2}\s*(am|pm|:\d{2})|\bpickup\b|\breturn\b|\bcollect\b|\bdrop\s*off\b|\bmorning\b|\bevening\b|\bafternoon\b)/i;
    if (!timePatterns.test(content)) return;

    // Try regex extraction first to avoid AI call
    const regexResult = this.tryRegexTimeExtraction(content);
    let pickupTime: string | undefined;
    let returnTime: string | undefined;
    let pickupDateMatch: RegExpMatchArray | null = null;
    let returnDateMatch: RegExpMatchArray | null = null;
    let confidence: string;

    if (regexResult && regexResult.confidence === 'high' && (regexResult.pickupTime || regexResult.returnTime)) {
      pickupTime = regexResult.pickupTime;
      returnTime = regexResult.returnTime;
      confidence = 'high';
      this.logger.debug(`Regex extraction succeeded for ${msg.sender}: pickup=${pickupTime}, return=${returnTime}`);
    } else {
      // Fall back to AI extraction (lightweight)
      const extractionPrompt =
        `Extract pickup and return times from this renter message.\n\n` +
        `Renter message: "${content}"\n` +
        `Rental: ${rental.title}\n` +
        `Renter: ${rental.renter_info || msg.sender}\n\n` +
        `Common patterns:\n` +
        `- "I would love to pickup at 10am on the 5th And I will return at 7pm on the 8th"\n` +
        `- "pickup at 7pm"\n` +
        `- "return at 11am"\n` +
        `- "I'll collect at 10am on Monday"\n\n` +
        `Respond ONLY in this exact format (use 24h time HH:MM). Leave blank if not mentioned:\n` +
        `PICKUP_TIME: <HH:MM or blank>\n` +
        `PICKUP_DATE: <YYYY-MM-DD or blank>\n` +
        `RETURN_TIME: <HH:MM or blank>\n` +
        `RETURN_DATE: <YYYY-MM-DD or blank>\n` +
        `CONFIDENCE: <low|medium|high>`;

      const response = await this.aiService.processExtraction(extractionPrompt);

      const pickupTimeM = response.content.match(/PICKUP_TIME:\s*(\d{1,2}:\d{2})/);
      pickupDateMatch = response.content.match(/PICKUP_DATE:\s*(\d{4}-\d{2}-\d{2})/);
      const returnTimeM = response.content.match(/RETURN_TIME:\s*(\d{1,2}:\d{2})/);
      returnDateMatch = response.content.match(/RETURN_DATE:\s*(\d{4}-\d{2}-\d{2})/);
      const confidenceMatch = response.content.match(/CONFIDENCE:\s*(low|medium|high)/i);

      pickupTime = pickupTimeM ? pickupTimeM[1] : undefined;
      returnTime = returnTimeM ? returnTimeM[1] : undefined;
      confidence = confidenceMatch ? confidenceMatch[1].toLowerCase() : 'low';
    }

    // Only proceed if we found at least one time with medium+ confidence
    if (!pickupTime && !returnTime) return;
    if (confidence === 'low') {
      this.logger.debug(`Time extraction confidence too low for message from ${msg.sender}, skipping`);
      return;
    }

    // Update booking times
    const updated = await this.calendarService.updateBookingTimes(rental.id, pickupTime, returnTime);

    if (!updated || updated.count === 0) {
      this.logger.debug(`No bookings updated for rental ${rental.id} (may not have linked bookings yet)`);
    }

    // Store as memory
    const renterName = rental.renter_info || msg.sender;
    const memoryParts: string[] = [];
    if (pickupTime) {
      const dateStr = pickupDateMatch ? ` on ${pickupDateMatch[1]}` : '';
      memoryParts.push(`pickup at ${pickupTime}${dateStr}`);
    }
    if (returnTime) {
      const dateStr = returnDateMatch ? ` on ${returnDateMatch[1]}` : '';
      memoryParts.push(`return at ${returnTime}${dateStr}`);
    }

    const memoryContent = `${renterName} confirmed ${memoryParts.join(' and ')} for ${rental.title}`;
    await this.memoryService.storeMemory('fact', `Time confirmed: ${rental.title}`, memoryContent, 7);

    // Notify Daniel via Telegram
    const notificationParts: string[] = [];
    if (pickupTime) {
      notificationParts.push(`Pickup: ${pickupTime}${pickupDateMatch ? ` on ${pickupDateMatch[1]}` : ''}`);
    }
    if (returnTime) {
      notificationParts.push(`Return: ${returnTime}${returnDateMatch ? ` on ${returnDateMatch[1]}` : ''}`);
    }

    await this.telegramService.sendProactiveMessage(
      `⏰ *Time Confirmed*\n\n` +
      `├ 👤 ${renterName}\n` +
      `├ 📦 ${rental.title}\n` +
      `${notificationParts.map((p, i) => `${i < notificationParts.length - 1 ? '├' : '└'} ${p}`).join('\n')}\n\n` +
      `_Confidence: ${confidence}_`,
    );

    this.logger.log(`Extracted times for ${rental.title}: pickup=${pickupTime || 'N/A'}, return=${returnTime || 'N/A'} (confidence: ${confidence})`);
  }

  // --- Extract times from full chat history for a rental ---

  async extractTimesFromChatHistory(
    rental: any,
  ): Promise<{ pickupTime?: string; returnTime?: string; pickupDate?: string; returnDate?: string } | null> {
    const orderId = rental.listing_id;
    if (!orderId) {
      this.logger.debug(`extractTimesFromChatHistory: no listing_id on rental ${rental.id}`);
      return null;
    }

    // Read all messages from the rental chat
    const messages = await this.hyggloService.readMessages(orderId);
    if (!messages || messages.length === 0) {
      this.logger.debug(`extractTimesFromChatHistory: no chat messages for order ${orderId}`);
      return null;
    }

    // Build a chat transcript for AI analysis (last 15 messages max)
    const recentMessages = messages.slice(-15);
    const transcript = recentMessages
      .map(m => `[${m.timestamp}] ${m.sender}: ${m.content}`)
      .join('\n');

    // Quick pre-filter: does the chat mention any time-related words?
    const chatText = transcript.toLowerCase();
    const timeKeywords = ['pickup', 'pick up', 'collect', 'return', 'drop off', 'dropoff',
      'am', 'pm', 'morning', 'afternoon', 'evening', 'noon', 'o\'clock',
      ':', 'arrive', 'coming at', 'be there'];
    const hasTimeContext = timeKeywords.some(kw => chatText.includes(kw));

    if (!hasTimeContext) {
      this.logger.debug(`extractTimesFromChatHistory: no time-related keywords in chat for ${rental.title}`);
      return null;
    }

    // Use AI to extract the LAST AGREED pickup and return times
    const extractionPrompt =
      `Read this rental chat conversation and find the LAST AGREED pickup and return times.\n\n` +
      `Rental: ${rental.title}\n` +
      `Renter: ${rental.renter_info || 'Unknown'}\n` +
      `Rental dates: ${rental.start_date ? new Date(rental.start_date).toISOString().split('T')[0] : '?'} to ${rental.end_date ? new Date(rental.end_date).toISOString().split('T')[0] : '?'}\n\n` +
      `Chat transcript:\n${transcript}\n\n` +
      `IMPORTANT: Find the FINAL agreed times (the last mention that both parties seem to agree on). ` +
      `Earlier proposed times that were changed later should be ignored.\n\n` +
      `Common patterns:\n` +
      `- "I'll pick up at 10am" / "pickup at 7pm"\n` +
      `- "I'll return it at 11am" / "drop off at 5pm"\n` +
      `- "I'll collect at 10am on Monday and return 7pm Wednesday"\n` +
      `- "morning" usually means 9-10am, "afternoon" means 1-3pm, "evening" means 6-8pm\n\n` +
      `Respond ONLY in this exact format (use 24h time HH:MM). Leave blank if not mentioned or unclear:\n` +
      `PICKUP_TIME: <HH:MM or blank>\n` +
      `PICKUP_DATE: <YYYY-MM-DD or blank>\n` +
      `RETURN_TIME: <HH:MM or blank>\n` +
      `RETURN_DATE: <YYYY-MM-DD or blank>\n` +
      `CONFIDENCE: <low|medium|high>`;

    const response = await this.aiService.processExtraction(extractionPrompt);

    const pickupTimeMatch = response.content.match(/PICKUP_TIME:\s*(\d{1,2}:\d{2})/);
    const pickupDateMatch = response.content.match(/PICKUP_DATE:\s*(\d{4}-\d{2}-\d{2})/);
    const returnTimeMatch = response.content.match(/RETURN_TIME:\s*(\d{1,2}:\d{2})/);
    const returnDateMatch = response.content.match(/RETURN_DATE:\s*(\d{4}-\d{2}-\d{2})/);
    const confidenceMatch = response.content.match(/CONFIDENCE:\s*(low|medium|high)/i);

    const pickupTime = pickupTimeMatch ? pickupTimeMatch[1] : undefined;
    const returnTime = returnTimeMatch ? returnTimeMatch[1] : undefined;
    const pickupDate = pickupDateMatch ? pickupDateMatch[1] : undefined;
    const returnDate = returnDateMatch ? returnDateMatch[1] : undefined;
    const confidence = confidenceMatch ? confidenceMatch[1].toLowerCase() : 'low';

    if (!pickupTime && !returnTime) {
      this.logger.debug(`extractTimesFromChatHistory: no times found in chat for ${rental.title}`);
      return null;
    }

    if (confidence === 'low') {
      this.logger.debug(`extractTimesFromChatHistory: confidence too low for ${rental.title}, skipping`);
      return null;
    }

    // Update bookings linked to this rental
    const updated = await this.calendarService.updateBookingTimes(rental.id, pickupTime, returnTime);

    // Store as memory
    const renterName = rental.renter_info || 'Unknown';
    const memoryParts: string[] = [];
    if (pickupTime) {
      memoryParts.push(`pickup at ${pickupTime}${pickupDate ? ` on ${pickupDate}` : ''}`);
    }
    if (returnTime) {
      memoryParts.push(`return at ${returnTime}${returnDate ? ` on ${returnDate}` : ''}`);
    }

    const memoryContent = `${renterName} agreed ${memoryParts.join(' and ')} for ${rental.title} (extracted from chat history)`;
    await this.memoryService.storeMemory('fact', `Agreed times: ${rental.title}`, memoryContent, 8);

    // Notify via Telegram
    const timeParts: string[] = [];
    if (pickupTime) timeParts.push(`⏰ Pickup: ${pickupTime}${pickupDate ? ` on ${pickupDate}` : ''}`);
    if (returnTime) timeParts.push(`⏰ Return: ${returnTime}${returnDate ? ` on ${returnDate}` : ''}`);

    await this.telegramService.sendProactiveMessage(
      `⏰ *Timing Extracted from Chat*\n\n` +
      `├ 📦 ${rental.title}\n` +
      `├ 👤 ${renterName}\n` +
      `${timeParts.map((p, i) => `${i < timeParts.length - 1 ? '├' : '└'} ${p}`).join('\n')}\n` +
      `├ Confidence: ${confidence}\n` +
      (updated && updated.count > 0 ? `└ ✅ Updated ${updated.count} booking(s)` : `└ _No linked bookings to update yet_`) +
      `\n\n_From ${messages.length} message(s)_`,
    );

    this.logger.log(
      `extractTimesFromChatHistory for ${rental.title}: pickup=${pickupTime || 'N/A'}, return=${returnTime || 'N/A'} (confidence: ${confidence}, ${messages.length} messages read)`,
    );

    return { pickupTime, returnTime, pickupDate, returnDate };
  }

  // --- Execute AI decision ---

  private async executeDecision(rental: any, aiResponse: string): Promise<string> {
    // Check if AI response contains a message to send
    const messageMatch = aiResponse.match(/MESSAGE:\s*(.+?)(?:\n|$)/s);

    if (messageMatch) {
      const messageText = messageMatch[1].trim();

      // READ_ONLY_MODE hard block
      const readOnly = process.env.READ_ONLY_MODE === 'true';
      if (readOnly) {
        this.logger.warn(`BLOCKED [READ_ONLY_MODE] executeDecision message for rental ${rental.listing_id}: "${messageText.substring(0, 100)}..."`);
        return `BLOCKED - read-only mode. Draft was: "${messageText.substring(0, 100)}..."`;
      }

      try {
        await this.hyggloService.sendMessage(rental.listing_id, messageText);
        return `Sent message to renter: "${messageText.substring(0, 100)}..."`;
      } catch (error) {
        return `Failed to send message: ${error.message}. Draft was: "${messageText.substring(0, 100)}..."`;
      }
    }

    return 'Analysis completed, no automated action taken.';
  }

  // --- Scheduled tasks ---

  // Daily summary at 21:00
  @Cron('0 21 * * *')
  async dailySummary() {
    this.logger.log('Running daily summary...');

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [todayRentals, todayDecisions, totalRentals] = await Promise.all([
        this.prisma.rental.findMany({
          where: { created_at: { gte: today } },
          select: { title: true, status: true, renter_info: true },
        }),
        this.prisma.ai_decision.findMany({
          where: { created_at: { gte: today } },
        }),
        this.prisma.rental.count(),
      ]);

      const prompt =
        `Generate a daily summary report for Bananajoe Rentals.\n\n` +
        `Today's activity:\n` +
        `- New rentals: ${todayRentals.length}\n${todayRentals.map((r) => `  * ${r.title} (${r.status}) - ${r.renter_info || 'N/A'}`).join('\n')}\n` +
        `- AI decisions made: ${todayDecisions.length}\n${todayDecisions.map((d) => `  * ${d.decision_type}: ${d.output_summary.substring(0, 80)}`).join('\n')}\n` +
        `- Total rentals tracked: ${totalRentals}\n\n` +
        `Provide a brief summary, highlights, and any recommendations for tomorrow.`;

      const response = await this.aiService.processRoutine(prompt, {});

      await this.telegramService.sendProactiveMessage(
        `📋 *Daily Summary (${new Date().toLocaleDateString()})*\n\n${response.content}`,
      );

      if (response.memories.length > 0) {
        await this.memoryService.processAiMemories(response.memories);
      }
    } catch (error) {
      this.logger.error(`Daily summary error: ${error.message}`);
    }
  }

  // Weekly summary on Sundays at 20:00
  @Cron('0 20 * * 0')
  async weeklySummary() {
    this.logger.log('Running weekly summary...');

    try {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const [weekRentals, weekDecisions, totalMemories] = await Promise.all([
        this.prisma.rental.count({ where: { created_at: { gte: weekAgo } } }),
        this.prisma.ai_decision.count({ where: { created_at: { gte: weekAgo } } }),
        this.prisma.memory.count(),
      ]);

      const prompt =
        `Generate a weekly analysis for Bananajoe Rentals.\n\n` +
        `This week:\n` +
        `- New rentals: ${weekRentals}\n` +
        `- AI decisions: ${weekDecisions}\n` +
        `- Total memories learned: ${totalMemories}\n\n` +
        `Provide trends, insights, and strategic recommendations for next week.`;

      const response = await this.aiService.processRoutine(prompt, {});

      await this.telegramService.sendProactiveMessage(
        `📊 *Weekly Report (${new Date().toLocaleDateString()})*\n\n${response.content}`,
      );

      if (response.memories.length > 0) {
        await this.memoryService.processAiMemories(response.memories);
      }
    } catch (error) {
      this.logger.error(`Weekly summary error: ${error.message}`);
    }
  }

  // Health ping — if no activity for 24h, send still-alive message
  @Cron('0 12 * * *')
  async healthPing() {
    const hoursSinceLastPing = (Date.now() - this.lastHealthPing.getTime()) / (1000 * 60 * 60);

    if (hoursSinceLastPing >= 23) {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);

      await this.telegramService.sendProactiveMessage(
        `💚 *Health Ping*\n\n` +
        `├ Status: running\n` +
        `├ Uptime: ${hours}h ${minutes}m\n` +
        `└ Last ping: ${this.lastHealthPing.toLocaleString()}`,
      );

      this.lastHealthPing = new Date();
    }
  }
}
