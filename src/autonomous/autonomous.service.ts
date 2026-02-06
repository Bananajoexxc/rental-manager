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
import { ValidationService } from '../validation/validation.service';
import { RepairService } from '../validation/repair.service';
import { QualityScorerService } from '../evaluation/quality-scorer.service';
import { ConversationStageService } from '../conversation-tree/conversation-stage.service';
import { RecommendationService } from '../recommendations/recommendation.service';
import { ErrorLogService } from '../monitoring/error-log.service';
import { VisionService } from '../vision/vision.service';
import { findBestMatch, getInventoryItemNames, validateListingAgainstInventory, extractListingQuantity, MASTER_INVENTORY } from '../utils/item-matcher';
import { PRICING_CATALOG, formatFilteredPricingForAI } from '../data/pricing-catalog';
import { RenterProfileService } from '../renter-profile/renter-profile.service';
import { FollowUpService } from '../follow-up/follow-up.service';
import { VerificationService } from '../verification/verification.service';
import { RevenueService } from '../revenue/revenue.service';
import { MarketService } from '../market/market.service';
import { DspyService } from '../dspy/dspy.service';

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
  private processingCount = 0;
  private readonly maxConcurrentProcessing = 3;
  private messageQueue: Array<{ resolve: () => void }> = [];
  private activeRentalProcessing = new Set<string>(); // Per-rental dedup guard
  private recentlyProcessedMessages = new Map<string, number>(); // content hash → timestamp for cross-scan dedup
  private readonly MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minute dedup window
  private recentlyNotifiedRentals = new Map<number, number>(); // rental DB id → timestamp for new-rental notification dedup
  private readonly RENTAL_NOTIFICATION_DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minute dedup window for rental notifications

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
    private validationService: ValidationService,
    private repairService: RepairService,
    private qualityScorerService: QualityScorerService,
    private conversationStageService: ConversationStageService,
    private recommendationService: RecommendationService,
    private errorLogService: ErrorLogService,
    private visionService: VisionService,
    private renterProfileService: RenterProfileService,
    private followUpService: FollowUpService,
    private verificationService: VerificationService,
    private revenueService: RevenueService,
    @Inject(forwardRef(() => MarketService)) private marketService: MarketService,
    private dspyService: DspyService,
  ) {}

  /**
   * Determine context complexity level for optimization
   * MINIMAL: Simple greetings, acknowledgments
   * STANDARD: Normal queries, general questions
   * COMPREHENSIVE: Pricing quotes, delivery calculations, complex requests
   */
  private determineContextLevel(message: string): 'minimal' | 'standard' | 'comprehensive' {
    const lowerMessage = message.toLowerCase();

    // Minimal context triggers (simple responses)
    const minimalTriggers = [
      /^(hi|hey|hello|thanks|thank you|ok|okay|sounds good|perfect|great|yes|no|sure)$/i,
      /^(thanks?|thx|cheers|cool)\s*!*$/i,
    ];

    for (const trigger of minimalTriggers) {
      if (trigger.test(message.trim())) {
        return 'minimal';
      }
    }

    // Comprehensive context triggers (need full pricing/delivery data)
    const comprehensiveTriggers = [
      /\b(price|cost|how much|pricing|quote|estimate)\b/i,
      /\b(deliver|delivery|courier|postcode|address)\b/i,
      /\b(bundle|package|together|combo)\b/i,
      /\b(available|availability|dates|booking)\b/i,
    ];

    for (const trigger of comprehensiveTriggers) {
      if (trigger.test(message)) {
        return 'comprehensive';
      }
    }

    // Default to standard
    return 'standard';
  }

  /**
   * Detect if a renter is accepting/confirming a bundle offer.
   * Returns the detected intent or null.
   */
  private detectBundleAcceptance(message: string, aiResponse: string): {
    accepted: boolean;
    bundleMentioned?: string;
  } | null {
    const lowerMsg = message.toLowerCase();
    const lowerResp = aiResponse.toLowerCase();

    // Check if AI response mentioned a bundle/kit/package
    const bundleInResponse = /\b(bundle|kit|package|set)\b/i.test(lowerResp);
    if (!bundleInResponse) return null;

    // Check if renter is confirming/accepting
    const acceptPatterns = /\b(yes|yeah|yep|sounds good|perfect|go for it|let'?s? do|i'?ll take|book it|go ahead|that works|deal|great|want the (bundle|kit|package|set))\b/i;
    if (acceptPatterns.test(lowerMsg)) {
      // Extract bundle name from AI response
      const bundleNameMatch = aiResponse.match(/(?:the\s+)?(\w[\w\s]+?(?:Kit|Bundle|Package|Set))/i);
      return {
        accepted: true,
        bundleMentioned: bundleNameMatch ? bundleNameMatch[1].trim() : 'unknown bundle',
      };
    }

    return null;
  }

  /**
   * Extract noteworthy renter info from a message (e.g., project type, special requests).
   * Returns a short note string or null if nothing noteworthy.
   */
  private async extractRenterNotes(message: string): Promise<string | null> {
    // Pre-filter: skip short messages or messages without note indicators
    if (message.length < 15) return null;

    const noteIndicators = /\b(need|extra|batteries|first\s+time|shooting|wedding|event|film|commercial|music\s+video|special|request|careful|fragile|heavy|tripod|case|bag|project|production|corporate|interview|documentary|short\s+film|feature|studio|location|outdoor|indoor|rain|weather|travel|abroad|overseas|flight)\b/i;
    if (!noteIndicators.test(message)) return null;

    try {
      const prompt =
        `Extract ONE short noteworthy sentence from this renter message that would be useful for the equipment owner to know ` +
        `(e.g., project type, special requirements, care concerns, accessory needs, timing preferences). ` +
        `If nothing noteworthy, respond with exactly "NONE".\n\n` +
        `Message: "${message}"\n\n` +
        `Respond with just the note (max 200 chars) or "NONE".`;

      const response = await this.aiService.processExtraction(prompt);
      const note = response.content.trim();

      if (note === 'NONE' || note.toLowerCase() === 'none' || note.length < 5) {
        return null;
      }

      return note.substring(0, 200);
    } catch {
      return null;
    }
  }

  /**
   * Build rental stage context string for AI prompt enrichment.
   * Summarises the current state of the rental pipeline.
   */
  private async buildRentalStageContext(rental: any): Promise<string> {
    const parts: string[] = ['--- RENTAL STAGE ---'];

    // 1. Hygglo status
    parts.push(`Hygglo status: ${rental.status || 'unknown'}`);

    // 2. Follow-up state flags
    try {
      const followUpState = await this.prisma.follow_up_state.findUnique({
        where: { rental_id: rental.id },
      });
      if (followUpState) {
        const flags: string[] = [];
        if (followUpState.items_confirmed) flags.push('items_confirmed');
        if (followUpState.availability_verified) flags.push('availability_verified');
        if (followUpState.discount_eligible) flags.push('discount_eligible');
        if ((followUpState as any).discount_applied) flags.push('discount_applied');
        if (followUpState.auto_accepted) flags.push('auto_accepted');
        parts.push(`Follow-up: status=${followUpState.status || 'unknown'}${flags.length > 0 ? ', ' + flags.join(', ') : ''}`);

        // Time tracking status for AI awareness
        const timesStatus = (followUpState as any).times_status || 'none';
        parts.push(`Times: status=${timesStatus}`);
        if (timesStatus === 'none' && followUpState.conversation_stage === 'confirmed') {
          parts.push(`ACTION NEEDED: Ask renter for exact pickup/return times (with AM/PM). Validate before confirming.`);
        } else if (timesStatus === 'tentative') {
          parts.push(`TENTATIVE times noted — remind renter these aren't locked in until booking is confirmed and paid.`);
        }
      }
    } catch {
      // Follow-up state may not exist
    }

    // 3. Verification status via rental_renter_link
    try {
      const renterLink = await this.prisma.rental_renter_link.findFirst({
        where: { rental_id: rental.id },
        select: { renter_profile_id: true },
      });
      if (renterLink) {
        const profile = await this.renterProfileService.getProfile(renterLink.renter_profile_id);
        if (profile) {
          parts.push(`Verification: ${profile.verification_status || 'unknown'}`);
        }
      }
    } catch {
      // Profile may not exist
    }

    // 4. Booking times
    try {
      const bookings = await this.prisma.booking.findMany({
        where: { rental_id: rental.id },
        select: { pickup_time: true, return_time: true },
        take: 1,
      });
      if (bookings.length > 0) {
        const b = bookings[0];
        parts.push(`Times: pickup=${b.pickup_time ? 'confirmed' : 'pending'}, return=${b.return_time ? 'confirmed' : 'pending'}`);
      }
    } catch {
      // Bookings may not exist
    }

    return parts.join('\n');
  }

  /**
   * Check if writes are blocked for a given rental.
   * Returns false (writes allowed) if the rental is in WRITE_ENABLED_RENTALS, even in READ_ONLY_MODE.
   */
  private isWriteBlocked(rentalId: string): boolean {
    const readOnly = process.env.READ_ONLY_MODE === 'true';
    if (!readOnly) return false;
    const allowed = process.env.WRITE_ENABLED_RENTALS || '';
    if (allowed && allowed.split(',').map(s => s.trim()).includes(rentalId)) return false;
    return true;
  }

  /**
   * Check if a rental is a same-day rental (start_date is today).
   */
  private isSameDayRental(rental: any): boolean {
    if (!rental.start_date) return false;
    const startDate = new Date(rental.start_date);
    const today = new Date();
    return (
      startDate.getFullYear() === today.getFullYear() &&
      startDate.getMonth() === today.getMonth() &&
      startDate.getDate() === today.getDate()
    );
  }

  /**
   * Detect cancel or reschedule intent in a renter message.
   * Returns 'cancel', 'reschedule', or null.
   */
  private detectCancelReschedule(message: string): 'cancel' | 'reschedule' | null {
    const text = message.toLowerCase();

    // Negative lookahead: skip false positives like "cancel my other plans"
    const cancelPatterns = [
      /\bcancel\s+(the\s+)?(rental|booking|order|reservation|request)\b/i,
      /\bcancel\s+it\b/i,
      /\bdon'?t\s+need\s+(it|the|this)\b/i,
      /\bno\s+longer\s+need\b/i,
      /\bchanged\s+my\s+mind\b/i,
      /\bcall\s+(it\s+)?off\b/i,
      /\bwant\s+to\s+cancel\b/i,
      /\bneed\s+to\s+cancel\b/i,
      /\bplease\s+cancel\b/i,
    ];

    const reschedulePatterns = [
      /\breschedule\b/i,
      /\bchange\s+the\s+dates?\b/i,
      /\bmove\s+the\s+booking\b/i,
      /\bpush\s+(it\s+)?back\b/i,
      /\bpostpone\b/i,
      /\bdifferent\s+day\b/i,
      /\bdifferent\s+dates?\b/i,
      /\bchange\s+the\s+time\b/i,
      /\bmove\s+(it\s+)?to\s+(a\s+)?(different|another|next|later)\b/i,
    ];

    // Check cancel patterns (but guard against "cancel my other plans to make this work" etc.)
    const cancelFalsePositives = /cancel\s+(my\s+)?(other|previous)\s+(plans?|booking|meeting)/i;
    if (!cancelFalsePositives.test(text)) {
      for (const pattern of cancelPatterns) {
        if (pattern.test(text)) return 'cancel';
      }
    }

    for (const pattern of reschedulePatterns) {
      if (pattern.test(text)) return 'reschedule';
    }

    return null;
  }

  /**
   * Detect time ranges (e.g., "9-10am", "between 9 and 10") that are not exact times.
   * Returns the matched range string if found, null otherwise.
   */
  private detectTimeRange(content: string): string | null {
    const rangePatterns = [
      // "9-10am", "9am-10am", "9-10 am"
      /\b(\d{1,2})\s*(?:am|pm)?\s*[-–]\s*(\d{1,2})\s*(?:am|pm)\b/i,
      // "between 9 and 10", "between 9am and 10am"
      /\bbetween\s+(\d{1,2})\s*(?:am|pm)?\s+and\s+(\d{1,2})\s*(?:am|pm)?\b/i,
      // "9 to 10am", "9am to 10am" (but not dates like "2025-01-15")
      /\b(\d{1,2})\s*(?:am|pm)?\s+to\s+(\d{1,2})\s*(?:am|pm)\b/i,
      // "around 9-10", "around 9-10am"
      /\baround\s+(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:am|pm)?\b/i,
    ];

    for (const pattern of rangePatterns) {
      const match = content.match(pattern);
      if (match) {
        // Exclude date-like patterns (e.g., "2025-01-15", "15 to 20 January")
        const fullMatch = match[0];
        if (/\d{4}-\d{2}-\d{2}/.test(content.substring(Math.max(0, content.indexOf(fullMatch) - 10), content.indexOf(fullMatch) + fullMatch.length + 10))) {
          continue;
        }
        // Exclude if both numbers are > 31 (unlikely to be times)
        const num1 = parseInt(match[1]);
        const num2 = parseInt(match[2]);
        if (num1 > 12 && num2 > 12) continue;
        return fullMatch;
      }
    }

    return null;
  }

  /**
   * Parse natural date references from renter messages (e.g., "tomorrow", "next weekend").
   * Ported from TelegramService.parseDateReferences for parity.
   */
  private parseDateReferences(textLower: string): { startDate: Date; endDate: Date } {
    const now = new Date();
    let startDate = new Date(now);
    let endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 1);

    if (textLower.includes('tomorrow')) {
      startDate.setDate(startDate.getDate() + 1);
      endDate.setDate(startDate.getDate() + 1);
    } else if (textLower.includes('next week')) {
      const dayOfWeek = now.getDay();
      const daysUntilNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      startDate.setDate(now.getDate() + daysUntilNextMonday);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 7);
    } else if (textLower.includes('this week')) {
      const dayOfWeek = now.getDay();
      const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
      endDate.setDate(now.getDate() + daysUntilSunday);
    } else if (textLower.includes('next weekend')) {
      const dayOfWeek = now.getDay();
      const daysUntilNextSaturday = (6 - dayOfWeek) + 7;
      startDate.setDate(now.getDate() + daysUntilNextSaturday);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 2);
    } else if (textLower.includes('weekend') || textLower.includes('this weekend')) {
      const dayOfWeek = now.getDay();
      const daysUntilSaturday = dayOfWeek <= 6 ? 6 - dayOfWeek : 0;
      startDate.setDate(now.getDate() + daysUntilSaturday);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 2);
    } else {
      // Try explicit dates (YYYY-MM-DD)
      const dateMatches = textLower.match(/(\d{4}-\d{2}-\d{2})/g);
      if (dateMatches && dateMatches.length >= 1) {
        startDate = new Date(dateMatches[0]);
        endDate = dateMatches.length >= 2 ? new Date(dateMatches[1]) : new Date(startDate);
        endDate.setDate(endDate.getDate() + 1);
      } else {
        // Try informal dates like "Feb 5" or "5th February"
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const informalMatch = textLower.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
        const informalMatch2 = textLower.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*(\d{1,2})/);

        if (informalMatch) {
          const day = parseInt(informalMatch[1]);
          const month = monthNames.indexOf(informalMatch[2]);
          startDate = new Date(now.getFullYear(), month, day);
          if (startDate < now) startDate.setFullYear(startDate.getFullYear() + 1);
          endDate = new Date(startDate);
          endDate.setDate(startDate.getDate() + 1);
        } else if (informalMatch2) {
          const day = parseInt(informalMatch2[2]);
          const month = monthNames.indexOf(informalMatch2[1]);
          startDate = new Date(now.getFullYear(), month, day);
          if (startDate < now) startDate.setFullYear(startDate.getFullYear() + 1);
          endDate = new Date(startDate);
          endDate.setDate(startDate.getDate() + 1);
        } else {
          endDate.setDate(now.getDate() + 3);
        }
      }
    }

    return { startDate, endDate };
  }

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

    // Reject time ranges — we need exact times
    if (this.detectTimeRange(content)) {
      return null;
    }

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

    // Dedup guard: skip if we already processed this rental recently
    const lastNotified = this.recentlyNotifiedRentals.get(rental.id);
    if (lastNotified && Date.now() - lastNotified < this.RENTAL_NOTIFICATION_DEDUP_TTL_MS) {
      this.logger.warn(`Skipping duplicate onNewRental for ${rental.title} (id=${rental.id}) — already processed ${Math.round((Date.now() - lastNotified) / 1000)}s ago`);
      return;
    }
    this.recentlyNotifiedRentals.set(rental.id, Date.now());

    // Periodic cleanup of stale dedup entries
    if (this.recentlyNotifiedRentals.size > 100) {
      const cutoff = Date.now() - this.RENTAL_NOTIFICATION_DEDUP_TTL_MS;
      for (const [key, ts] of this.recentlyNotifiedRentals) {
        if (ts < cutoff) this.recentlyNotifiedRentals.delete(key);
      }
    }

    try {
      // Check blacklist
      const renterName = rental.renter_info || '';
      const blacklistCheck = await this.blacklistService.isBlacklisted(renterName);

      if (blacklistCheck.blacklisted) {
        // Notify owner (only Daniel sees the blacklist reason)
        await this.telegramService.sendProactiveMessage(
          `🚫 *BLACKLIST MATCH*\n\n` +
          `├ 📦 Rental: ${rental.title}\n` +
          `├ 👤 Renter: ${renterName}\n` +
          `├ ⚠️ Matched: ${blacklistCheck.entry.name}\n` +
          `└ Reason: ${blacklistCheck.entry.reason}\n\n` +
          `_Polite decline sent. Renter was NOT informed about blacklisting._`,
          'Markdown', { force: true },
        );

        // Send polite decline to renter — never mention blacklisting
        const declineMessage = this.blacklistService.getPoliteDecline();
        if (!this.isWriteBlocked(rental.listing_id)) {
          try {
            await this.hyggloService.sendMessage(rental.listing_id, declineMessage);
          } catch (sendErr) {
            this.logger.warn(`Failed to send blacklist decline: ${sendErr.message}`);
          }
        }

        // Store decision and stop — no further processing for blacklisted renters
        const blacklistWriteBlocked = this.isWriteBlocked(rental.listing_id);
        await this.prisma.ai_decision.create({
          data: {
            rental_id: rental.id,
            decision_type: 'reject',
            input_summary: `Blacklisted renter: ${renterName} (matched: ${blacklistCheck.entry.name})`,
            output_summary: `Polite decline sent. Reason on file: ${blacklistCheck.entry.reason}`,
            confidence: 1.0,
            action_taken: blacklistWriteBlocked ? `BLOCKED (read-only). Decline: "${declineMessage}"` : `Sent polite decline: "${declineMessage}"`,
            notified: true,
            was_sent: !blacklistWriteBlocked,
          },
        });

        return; // Stop processing — do not engage further
      }

      // Scam detection on initial chat messages
      try {
        const initialMessages = await this.hyggloService.readMessages(rental.listing_id);
        for (const chatMsg of initialMessages) {
          // Only check renter messages (skip Owner messages)
          if (chatMsg.sender === 'Owner' || chatMsg.sender === 'owner') continue;
          const scamCheck = this.detectScamPattern(chatMsg.content);
          if (scamCheck.isScam) {
            this.logger.warn(`Scam pattern detected in initial chat from ${chatMsg.sender}: ${scamCheck.matchedPattern} (${scamCheck.severity})`);
            await this.handleScamDetected(rental, chatMsg.content, renterName || chatMsg.sender, scamCheck.matchedPattern!, scamCheck.severity, scamCheck.score);
            return;
          } else if (scamCheck.severity === 'suspicious') {
            // Log suspicious near-miss but don't block
            await this.handleScamDetected(rental, chatMsg.content, renterName || chatMsg.sender, scamCheck.matchedPattern!, 'suspicious', scamCheck.score);
          }
        }
      } catch (scamErr) {
        this.logger.debug(`Scam check on initial messages failed: ${scamErr.message}`);
      }

      // Record demand with enriched context
      const items = rental.title ? [rental.title] : [];
      await this.demandService.recordDemand({
        items,
        renter_name: renterName,
        dates_start: rental.start_date,
        dates_end: rental.end_date,
        outcome: 'pending',
        source: 'hygglo',
        account: rental.account || 'dbcinema',
        rental_value: rental.rental_price || undefined,
      });

      // Create/link renter profile (Rule 7 foundation)
      let isReturningRenter = false;
      let renterProfileId: string | undefined;
      try {
        if (renterName) {
          const profile = await this.renterProfileService.findOrCreateProfile(renterName);
          renterProfileId = profile.id;
          await this.renterProfileService.linkRentalToProfile(rental.id, profile.id);

          const returningCheck = await this.renterProfileService.isReturningRenter(renterName, rental.id);
          isReturningRenter = returningCheck.isReturning;

          if (isReturningRenter) {
            this.logger.log(`Returning renter detected: ${renterName} (${returningCheck.previousRentalCount} previous rentals)`);
          }
        }
      } catch (profileErr) {
        this.logger.warn(`Renter profile linking failed: ${profileErr.message}`);
      }

      // Initialize follow-up state
      try {
        await this.followUpService.initializeFollowUpState(rental.id);
      } catch (followUpErr) {
        this.logger.warn(`Follow-up initialization failed: ${followUpErr.message}`);
      }

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

      // Check if there's already a conversation with the renter
      let existingChatMessages: { sender: string; content: string; timestamp: string }[] = [];
      try {
        existingChatMessages = await this.hyggloService.readMessages(rental.listing_id);
      } catch (err) {
        this.logger.debug(`Could not read existing messages for ${rental.listing_id}: ${err.message}`);
      }

      const hasExistingChat = existingChatMessages.length > 0;
      let chatContext = '';
      if (hasExistingChat) {
        const recentMessages = existingChatMessages.slice(-10);
        chatContext = `\n\nEXISTING CHAT HISTORY (${existingChatMessages.length} messages):\n` +
          recentMessages.map(m => `[${m.timestamp}] ${m.sender}: ${m.content}`).join('\n');
      }

      // Build full renter context from profile, bookings, and history
      let renterProfileContext = '';
      if (renterProfileId) {
        try {
          renterProfileContext = await this.renterProfileService.buildRenterContext(renterProfileId, rental.id);
        } catch (ctxErr) {
          this.logger.debug(`Renter context build failed: ${ctxErr.message}`);
        }
      }

      // Multi-item context enrichment
      let multiItemContextStr = '';
      if (rental._multiItemContext) {
        const ctx = rental._multiItemContext;
        const itemList = ctx.allItems
          .map((item: { title: string; price: number }) => `  - ${item.title} (£${item.price})`)
          .join('\n');
        multiItemContextStr =
          `\n\nMULTI-ITEM REQUEST: This renter sent ${ctx.allItems.length} separate rental requests that have been consolidated here.\n` +
          `All items:\n${itemList}\n` +
          `Total value: £${ctx.totalValue}\n` +
          `The renter has been told all items will be handled in this chat. ` +
          `Respond acknowledging ALL items, not just the one in this rental's title. ` +
          `Consider bundle pricing if applicable.`;
      }

      // Build rental stage context for pipeline awareness
      let rentalStageCtx = '';
      try {
        rentalStageCtx = await this.buildRentalStageContext(rental);
      } catch (stageErr) {
        this.logger.debug(`Rental stage context build failed in onNewRental: ${stageErr.message}`);
      }

      // LISTING_INVENTORY_MISMATCH: Validate listing against actual inventory for onNewRental too
      let onNewRentalInventoryWarning = '';
      try {
        const listingCheck = validateListingAgainstInventory(rental.title);
        const listingQty = extractListingQuantity(rental.title);
        if (!listingCheck.matched) {
          const altMatch = findBestMatch(rental.title, getInventoryItemNames());
          onNewRentalInventoryWarning =
            `\n\nWARNING — LISTING_INVENTORY_MISMATCH: The listing "${rental.title}" does not match any item in our physical inventory. ` +
            `This is likely a ghost/SEO listing. Do NOT confirm this item as available. ` +
            `NEVER confirm availability of items not in the master inventory. ` +
            (altMatch ? `Closest real item: "${altMatch}" (${MASTER_INVENTORY[altMatch]} units). Offer this as an alternative.` : 'No close alternative found.');
        } else if (listingQty > listingCheck.maxQuantity) {
          onNewRentalInventoryWarning =
            `\n\nWARNING — LISTING_INVENTORY_MISMATCH: The listing title says "${listingQty}x" but we only have ${listingCheck.maxQuantity} unit(s) of "${listingCheck.inventoryItem}". ` +
            `State that we have ${listingCheck.maxQuantity} available. NEVER offer to source, procure, or find additional units — our inventory is fixed.`;
        }
      } catch {
        // Non-critical
      }

      const rentalContext =
        `New rental detected:\n` +
        `Title: ${rental.title}\n` +
        `Status: ${rental.status}\n` +
        `Renter: ${rental.renter_info || 'Unknown'}\n` +
        `URL: ${rental.listing_url}\n` +
        `Description: ${(rental.description || '').substring(0, 500)}\n` +
        `Photos: ${(rental.photos_urls || []).length} photos` +
        onNewRentalInventoryWarning +
        chatContext +
        (renterProfileContext ? `\n\n${renterProfileContext}` : '') +
        (rentalStageCtx ? `\n\n${rentalStageCtx}` : '') +
        multiItemContextStr;

      // 2. Ask Claude to analyze and decide
      let returningContext = '';
      if (isReturningRenter && renterProfileId) {
        const profile = await this.renterProfileService.getProfile(renterProfileId);
        const hasPreviousAgreements = profile?.previous_agreements;

        returningContext = hasPreviousAgreements
          ? `- RE-REQUEST FROM RETURNING RENTER: This renter has rented from us before AND has previous agreements on file. ` +
            `This is likely a re-request after a cancellation. Do NOT ask questions that were already answered. ` +
            `Instead: (1) warmly acknowledge them, (2) reconfirm all previously agreed items are still available, ` +
            `(3) if everything checks out, proactively accept — no need to re-negotiate what was already settled. ` +
            `Reference the RENTER PROFILE section above for their previous agreements and item history.\n`
          : `- RETURNING RENTER: This renter has rented from us before. Skip the generic welcome — ` +
            `they already know who we are and how it works. Instead, acknowledge them warmly ("Welcome back!") ` +
            `and get straight to confirming the items are available and dates work. ` +
            `Re-verify all item availability proactively and consider accepting immediately if everything checks out.\n`;
      }

      const analysisPrompt =
        `A new rental request has appeared. Analyze it and decide what action to take.\n\n` +
        `Consider:\n` +
        `- What items are being rented?\n` +
        `- Does the pricing seem right based on our inventory?\n` +
        returningContext +
        (hasExistingChat
          ? `- There is ALREADY an ongoing conversation with this renter (see chat history above). ` +
            `Do NOT send a generic welcome message — it would be out of context and awkward. ` +
            `Only send a message if it adds value to the existing conversation (e.g., confirming details, answering a pending question). ` +
            `If nothing useful to add, recommend "no message needed".\n`
          : !isReturningRenter ? `- Should we send a welcome message to the renter?\n` : '') +
        `- Any concerns or flags?\n` +
        `\nRespond with:\n` +
        `1. Your analysis (2-3 sentences)\n` +
        `2. Recommended action (e.g., "send welcome message", "approve", "flag for review", "no message needed")\n` +
        `3. If sending a message, include the exact message text after "MESSAGE:"`;

      const response = await this.aiService.processComplex(analysisPrompt, {
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
          was_sent: null, // internal analysis, not a customer-facing message
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

      // 8. Check item availability and update acceptance readiness
      try {
        let itemsConfirmed = false;
        let availabilityVerified = false;

        if (rental.start_date && rental.end_date) {
          const extractedItems = await this.prisma.extracteditem.findMany({
            where: { rental_id: rental.id },
            select: { item_name: true },
          });

          if (extractedItems.length > 0) {
            itemsConfirmed = true;
            let allAvailable = true;

            for (const item of extractedItems) {
              const avail = await this.calendarService.checkAvailability(
                item.item_name,
                rental.start_date,
                rental.end_date,
              );
              if (!avail.available) {
                allAvailable = false;
                break;
              }
            }

            availabilityVerified = allAvailable;
          }
        }

        // Same-day rental check
        const isSameDay = this.isSameDayRental(rental);
        const rentalValue = rental.rental_price || 0;
        const SAME_DAY_AUTO_THRESHOLD = 40; // £40 — same-day rentals above this always need Daniel's approval

        // Same-day rentals above £40 always need Daniel's manual approval
        // Same-day rentals under £40: bot should upsell, prepare for approval, then escalate
        const sameDayBlocksAutoAccept = isSameDay; // Always block auto-accept for same-day regardless of value

        // Determine auto-accept eligibility:
        // items confirmed + availability verified + NOT same-day
        const autoAcceptEligible = itemsConfirmed && availabilityVerified && !sameDayBlocksAutoAccept;

        // Check discount eligibility
        const discountEligible = this.followUpService.checkDiscountEligibility(rental).eligible;

        await this.followUpService.updateAcceptanceReadiness(rental.id, {
          items_confirmed: itemsConfirmed,
          availability_verified: availabilityVerified,
          auto_accept_eligible: autoAcceptEligible,
          discount_eligible: discountEligible,
        });

        // If same-day: escalate to Daniel with different handling based on value
        if (isSameDay) {
          const startDate = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Today';
          const endDate = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'TBC';
          const extractedItemNames = (await this.prisma.extracteditem.findMany({
            where: { rental_id: rental.id },
            select: { item_name: true },
          })).map(i => i.item_name);

          if (rentalValue > SAME_DAY_AUTO_THRESHOLD) {
            // High-value same-day: block auto-accept, escalate directly
            await this.telegramService.sendProactiveMessage(
              `⏰ *SAME-DAY RENTAL — Manual Approval Required*\n\n` +
              `├ 📦 ${rental.title}\n` +
              `├ 👤 ${rental.renter_info || 'Unknown'}\n` +
              `├ 📅 ${startDate} to ${endDate}\n` +
              `├ 🎯 Items: ${extractedItemNames.length > 0 ? extractedItemNames.join(', ') : 'Pending extraction'}\n` +
              `├ ✅ Available: ${availabilityVerified ? 'Yes' : 'Not yet verified'}\n` +
              `├ 💰 Price: £${rentalValue}\n` +
              `└ 🚫 Auto-accept BLOCKED — reply to approve or decline`,
            );

            await this.prisma.ai_decision.create({
              data: {
                rental_id: rental.id,
                decision_type: 'escalate',
                input_summary: `same_day_manual_approval: ${rental.title} by ${rental.renter_info || 'Unknown'}`,
                output_summary: `Same-day rental (£${rentalValue} > £${SAME_DAY_AUTO_THRESHOLD}). Auto-accept blocked. Awaiting Daniel's manual approval.`,
                confidence: 1.0,
                action_taken: 'Escalated to Daniel for same-day approval',
                notified: true,
                was_sent: null, // internal escalation, not a customer message
              },
            });

            this.logger.log(`Same-day rental (£${rentalValue}) for ${rental.title} — auto-accept blocked, escalated to Daniel`);
          } else {
            // Low-value same-day (<= £40): bot will handle upsell
            this.logger.log(`Same-day low-value rental (£${rentalValue}) for ${rental.title} — bot will upsell`);

            await this.prisma.ai_decision.create({
              data: {
                rental_id: rental.id,
                decision_type: 'escalate',
                input_summary: `same_day_low_value_upsell: ${rental.title} by ${rental.renter_info || 'Unknown'} (£${rentalValue})`,
                output_summary: `Same-day rental under £${SAME_DAY_AUTO_THRESHOLD}. Bot will upsell, then escalate for approval.`,
                confidence: 1.0,
                action_taken: 'Low-value same-day — upsell then escalate',
                notified: true,
                was_sent: null, // internal escalation, not a customer message
              },
            });

            this.logger.log(`Same-day rental (£${rentalValue} <= £${SAME_DAY_AUTO_THRESHOLD}) for ${rental.title} — upsell opportunity, then escalate`);
          }
        }

        this.logger.debug(`Acceptance readiness updated for ${rental.title}: items=${itemsConfirmed}, avail=${availabilityVerified}, autoAccept=${autoAcceptEligible}, sameDay=${isSameDay}, discount=${discountEligible}`);
      } catch (readinessErr) {
        this.logger.debug(`Acceptance readiness update failed: ${readinessErr.message}`);
      }

      // 9. Check and apply discount if eligible
      try {
        await this.followUpService.checkAndApplyDiscount(rental);
      } catch (discountErr) {
        this.logger.debug(`Discount check failed: ${discountErr.message}`);
      }

      this.logger.log(`Autonomous pipeline completed for: ${rental.title}`);
    } catch (error) {
      this.logger.error(`Autonomous pipeline error: ${error.message}`);

      // SENTRY: Capture error with context
      this.errorLogService.captureError(error, {
        operation: 'autonomous_pipeline',
        rental_id: rental.id,
        rental_title: rental.title,
        renter: rental.renter_info,
      });

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
   * Uses regex fast-path with optional AI fallback for ambiguous cases.
   */
  private async isPricingQuery(text: string, useAIFallback = false): Promise<boolean> {
    // Fast path: Clear pricing terms (95% of cases)
    const pricingTerms = /\b(price|pricing|cost|costs|how much|rate|rates|quote|charge|charges|fee|fees|per day|daily|weekly|monthly|budget|afford|expensive|cheap|discount|deal|£|pound|pounds|rental price|rental rate|what would|total|estimate)\b/i;
    const hasDeliveryTerms = /\b(deliver|delivery|courier|ship|shipping|transport)\b/i;

    if (pricingTerms.test(text) && !hasDeliveryTerms.test(text)) {
      return true; // Clearly about pricing
    }

    if (!pricingTerms.test(text)) {
      return false; // Clearly not about pricing
    }

    // Ambiguous case: Use AI fallback if enabled
    if (useAIFallback) {
      try {
        const classification = await this.aiService.processExtraction(
          `Classify this renter message intent. Is it primarily asking about PRICING (costs, rates, quotes)?\n\nMessage: "${text}"\n\nRespond with JSON only: {"intent":"pricing" or "other", "confidence":0-1}`,
        );

        const parsed = JSON.parse(classification.content);
        return parsed.intent === 'pricing' && parsed.confidence > 0.7;
      } catch (error) {
        this.logger.debug(`AI intent classification failed: ${error.message}`);
        return pricingTerms.test(text); // Fall back to regex
      }
    }

    return pricingTerms.test(text);
  }

  /**
   * Detect if a message is asking about delivery, courier, or shipping.
   * Uses regex fast-path with optional AI fallback for ambiguous cases.
   */
  private async isDeliveryQuery(text: string, useAIFallback = false): Promise<boolean> {
    // Fast path: Clear delivery terms (95% of cases)
    // NOTE: "too far" was removed — it indicates location rejection, not delivery intent
    const deliveryTerms = /\b(deliver|delivery|courier|ship|shipping|post|postcode|send it|drop off|dropoff|bring it|transport|how far|distance|collect from|can you bring|come to me)\b/i;
    const hasPricingTerms = /\b(price|pricing|cost|how much)\b/i;

    if (deliveryTerms.test(text) && !hasPricingTerms.test(text)) {
      return true; // Clearly about delivery
    }

    if (!deliveryTerms.test(text)) {
      return false; // Clearly not about delivery
    }

    // Ambiguous case: Use AI fallback if enabled
    if (useAIFallback) {
      try {
        const classification = await this.aiService.processExtraction(
          `Classify this renter message intent. Is it primarily asking about DELIVERY (shipping, courier, bringing items)?\n\nMessage: "${text}"\n\nRespond with JSON only: {"intent":"delivery" or "other", "confidence":0-1}`,
        );

        const parsed = JSON.parse(classification.content);
        return parsed.intent === 'delivery' && parsed.confidence > 0.7;
      } catch (error) {
        this.logger.debug(`AI intent classification failed: ${error.message}`);
        return deliveryTerms.test(text); // Fall back to regex
      }
    }

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
   * Estimate the current rental total for upselling logic
   * Uses rental.total_price if available, otherwise estimates from mentioned items
   */
  private async estimateRentalTotal(rental: any, mentionedItems: string[]): Promise<number> {
    // If rental has a total price, use that
    if (rental.total_price && rental.total_price > 0) {
      return rental.total_price;
    }

    // Try to extract price from rental title (e.g., "Sony FX3 - £60/day")
    const priceMatch = rental.title?.match(/£(\d+)/);
    if (priceMatch) {
      return parseInt(priceMatch[1], 10);
    }

    // Look up actual prices from PRICING_CATALOG for mentioned items
    if (mentionedItems.length > 0) {
      let total = 0;
      for (const item of mentionedItems) {
        const catalogEntry = PRICING_CATALOG.find(
          (p) => p.item_name.toLowerCase() === item.toLowerCase(),
        );
        if (catalogEntry) {
          // Use highest listed daily price (as per pricing rules)
          total += catalogEntry.daily_price_max;
        } else {
          // Fall back to £25 median for unmatched items
          total += 25;
        }
      }
      return total;
    }

    // Default: single unmatched item
    return 25;
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

  /**
   * Update acceptance readiness flags based on conversation state.
   * Detects item confirmation and availability from both the renter message and AI response.
   */
  private async updateAcceptanceReadinessFromConversation(
    rental: any,
    msg: HyggloMessage,
    mentionedItems: string[],
    aiResponse: string,
  ): Promise<void> {
    const updates: {
      items_confirmed?: boolean;
      availability_verified?: boolean;
      auto_accept_eligible?: boolean;
      discount_eligible?: boolean;
    } = {};

    // Detect item confirmation patterns in the conversation
    const confirmationPatterns = /\b(yes|yeah|yep|sounds good|perfect|that'?s? (right|correct|great)|confirmed?|let'?s? go|book it|proceed|go ahead|i'?ll take|want to book)\b/i;
    const renterConfirms = confirmationPatterns.test(msg.content);

    // Check if items are extracted for this rental
    const extractedItems = await this.prisma.extracteditem.findMany({
      where: { rental_id: rental.id },
      select: { item_name: true },
    });

    if (extractedItems.length > 0 || mentionedItems.length > 0) {
      updates.items_confirmed = true;
    }

    // Verify availability if we have dates and items
    if (updates.items_confirmed && rental.start_date && rental.end_date) {
      const itemsToCheck = extractedItems.length > 0
        ? extractedItems.map(i => i.item_name)
        : mentionedItems;

      let allAvailable = true;
      for (const itemName of itemsToCheck) {
        try {
          const avail = await this.calendarService.checkAvailability(
            itemName,
            rental.start_date,
            rental.end_date,
          );
          if (!avail.available) {
            allAvailable = false;
            break;
          }
        } catch {
          // If availability check fails, don't mark as verified
          allAvailable = false;
          break;
        }
      }
      updates.availability_verified = allAvailable;
    }

    // Auto-accept eligibility: items confirmed + availability verified + renter confirmation + NOT same-day
    if (updates.items_confirmed && updates.availability_verified && renterConfirms && !this.isSameDayRental(rental)) {
      updates.auto_accept_eligible = true;
    }

    // Discount eligibility
    const discountCheck = this.followUpService.checkDiscountEligibility(rental);
    if (discountCheck.eligible) {
      updates.discount_eligible = true;
    }

    // Only update if we have something to set
    if (Object.keys(updates).length > 0) {
      await this.followUpService.updateAcceptanceReadiness(rental.id, updates);
    }
  }

  private async acquireProcessingSlot(): Promise<void> {
    if (this.processingCount < this.maxConcurrentProcessing) {
      this.processingCount++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.messageQueue.push({ resolve });
    });
  }

  private releaseProcessingSlot(): void {
    const next = this.messageQueue.shift();
    if (next) {
      next.resolve();
    } else {
      this.processingCount--;
    }
  }

  async onNewMessages(messages: HyggloMessage[]) {
    const newMsgs = messages.filter(m => m.isNew);
    if (newMsgs.length === 0) return;

    // Group messages by rental — process only ONE consolidated message per rental
    const byRental = new Map<string, HyggloMessage[]>();
    for (const msg of newMsgs) {
      const existing = byRental.get(msg.rentalId) || [];
      existing.push(msg);
      byRental.set(msg.rentalId, existing);
    }

    const tasks: Promise<void>[] = [];
    for (const [rentalId, rentalMsgs] of byRental.entries()) {
      if (rentalMsgs.length === 1) {
        tasks.push(this.processMessage(rentalMsgs[0]));
      } else {
        // Multiple messages from the same rental — combine into one
        // Sort by timestamp ascending and concatenate
        rentalMsgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const combined: HyggloMessage = {
          rentalId,
          sender: rentalMsgs[rentalMsgs.length - 1].sender, // Use latest sender
          content: rentalMsgs.map(m => m.content).join('\n'),
          timestamp: rentalMsgs[rentalMsgs.length - 1].timestamp,
          isNew: true,
        };
        this.logger.log(`Batched ${rentalMsgs.length} messages for rental ${rentalId} into one conversation turn`);
        tasks.push(this.processMessage(combined));
      }
    }

    await Promise.all(tasks);
  }

  private async processMessage(msg: HyggloMessage) {
      // Per-rental deduplication: skip if this rental is already being processed
      if (this.activeRentalProcessing.has(msg.rentalId)) {
        this.logger.warn(`Skipping duplicate processing for rental ${msg.rentalId} — already in progress`);
        return;
      }

      // Content-based dedup: skip if we already processed this exact message recently
      // Sender-agnostic: same rental + same content = duplicate regardless of sender label
      // (prevents cross-account duplicate processing where sender names differ)
      const messageKey = `${msg.rentalId}:${msg.content}`;
      const lastProcessed = this.recentlyProcessedMessages.get(messageKey);
      if (lastProcessed && Date.now() - lastProcessed < this.MESSAGE_DEDUP_TTL_MS) {
        this.logger.debug(`Skipping duplicate message for rental ${msg.rentalId} — same content processed ${Math.round((Date.now() - lastProcessed) / 1000)}s ago`);
        return;
      }
      this.recentlyProcessedMessages.set(messageKey, Date.now());

      // Periodic cleanup: remove stale entries from dedup map
      if (this.recentlyProcessedMessages.size > 200) {
        const cutoff = Date.now() - this.MESSAGE_DEDUP_TTL_MS;
        for (const [key, ts] of this.recentlyProcessedMessages) {
          if (ts < cutoff) this.recentlyProcessedMessages.delete(key);
        }
      }

      this.activeRentalProcessing.add(msg.rentalId);

      this.logger.log(`New message from ${msg.sender} on rental ${msg.rentalId}`);

      await this.acquireProcessingSlot();
      let rental: any = null; // Declare outside try block for catch/finally access

      try {
        // Find the rental
        rental = await this.prisma.rental.findFirst({
          where: { listing_id: msg.rentalId },
        });

        if (!rental) {
          this.logger.warn(`Rental not found for message: ${msg.rentalId}`);
          return;
        }

        // Skip consolidated secondary rentals — redirect to primary chat
        if (rental.status === 'consolidated') {
          this.logger.debug(`Skipping message on consolidated rental ${rental.title} — redirected to primary`);
          // Find the primary rental redirect
          const redirectDecision = await this.prisma.ai_decision.findFirst({
            where: {
              rental_id: rental.id,
              input_summary: { contains: 'multi_item_secondary_closed' },
            },
          });
          if (redirectDecision) {
            if (!this.isWriteBlocked(msg.rentalId)) {
              try {
                await this.hyggloService.sendMessage(msg.rentalId,
                  `This request has been consolidated into another chat where we're handling all your items together. Please send your messages there instead!`);
              } catch {
                // Best-effort
              }
            }
          }
          return;
        }

        // Store incoming message in conversation history
        const chatId = `rental:${rental.id}`;
        await this.memoryService.storeConversation(chatId, 'user', msg.content, {
          sender: msg.sender,
          timestamp: msg.timestamp,
        });

        // Blacklist check on every message — polite decline without revealing blacklisting
        const blacklistCheck = await this.blacklistService.isBlacklistedByRental(rental.id);
        if (blacklistCheck.blacklisted) {
          const declineMessage = this.blacklistService.getPoliteDecline();

          if (!this.isWriteBlocked(msg.rentalId)) {
            try {
              await this.hyggloService.sendMessage(msg.rentalId, declineMessage);
            } catch {
              // Best-effort
            }
          }

          await this.telegramService.sendProactiveMessage(
            `🚫 *Blacklisted renter messaged*\n\n` +
            `├ 📦 ${rental.title}\n` +
            `├ 👤 ${msg.sender} (matched: ${blacklistCheck.entry.name})\n` +
            `├ 💬 "${msg.content.substring(0, 100)}"\n` +
            `└ Polite decline sent. Renter NOT informed of blacklisting.`,
          );

          return;
        }

        // Scam detection on incoming message (with scoring)
        const scamCheck = this.detectScamPattern(msg.content);
        if (scamCheck.isScam) {
          this.logger.warn(`Scam pattern detected in message from ${msg.sender}: ${scamCheck.matchedPattern} (${scamCheck.severity}, score ${scamCheck.score})`);
          await this.handleScamDetected(rental, msg.content, msg.sender, scamCheck.matchedPattern!, scamCheck.severity, scamCheck.score);
          return;
        } else if (scamCheck.severity === 'suspicious') {
          // Log suspicious near-miss but continue processing
          await this.handleScamDetected(rental, msg.content, msg.sender, scamCheck.matchedPattern!, 'suspicious', scamCheck.score);
          // Don't return — continue processing the message normally
        }

        // Cancel/Reschedule detection — escalate to Daniel, skip AI response
        const cancelReschedule = this.detectCancelReschedule(msg.content);
        if (cancelReschedule) {
          const label = cancelReschedule === 'cancel' ? 'CANCELLATION' : 'RESCHEDULE';
          this.logger.log(`${label} REQUEST detected from ${msg.sender} on ${rental.title}`);

          // Send holding response
          if (!this.isWriteBlocked(msg.rentalId)) {
            try {
              await this.hyggloService.sendMessage(msg.rentalId,
                `Let me check on that for you - I'll get back to you shortly.`);
            } catch {
              // Best-effort
            }
          }

          // Escalate to Daniel
          await this.telegramService.sendProactiveMessage(
            `🚨 *${label} REQUEST*\n\n` +
            `├ 📦 ${rental.title}\n` +
            `├ 👤 ${msg.sender}\n` +
            `├ 💬 "${msg.content.substring(0, 200)}"\n` +
            `└ ⚠️ Holding response sent - please handle manually`,
          );

          // Store decision
          await this.prisma.ai_decision.create({
            data: {
              rental_id: rental.id,
              decision_type: 'escalate',
              input_summary: `${label} request from ${msg.sender}: "${msg.content.substring(0, 200)}"`,
              output_summary: `Detected ${cancelReschedule} intent. Holding response sent, escalated to Daniel.`,
              confidence: 0.9,
              action_taken: `Holding response sent, escalated via Telegram`,
              notified: true,
              was_sent: true, // holding response was sent to the renter
            },
          });

          return;
        }

        // Follow-up tracking: reset counters on renter message
        await this.followUpService.onRenterMessage(rental.id);

        // Parse custom timeframe (e.g., "I'll get back tomorrow")
        try {
          const customTimeframe = await this.followUpService.parseCustomTimeframe(msg.content, rental);
          if (customTimeframe) {
            await this.followUpService.setCustomReminder(rental.id, customTimeframe.reminderAt, customTimeframe.reason);
          }
        } catch (tfErr) {
          this.logger.debug(`Custom timeframe parsing failed: ${tfErr.message}`);
        }

        // Rule 8: Detect "on my way" during verification
        if (this.verificationService.detectOnMyWayMessage(msg.content)) {
          try {
            // Find renter profile for this rental
            const renterLink = await this.prisma.rental_renter_link.findFirst({
              where: { rental_id: rental.id },
              select: { renter_profile_id: true },
            });

            if (renterLink) {
              const warningMessage = await this.verificationService.handleOnMyWayDuringVerification(
                rental,
                renterLink.renter_profile_id,
              );
              if (warningMessage) {
                // Send the warning and RETURN — do not continue to the main AI response
                if (!this.isWriteBlocked(msg.rentalId)) {
                  try {
                    await this.hyggloService.sendMessage(msg.rentalId, warningMessage);
                  } catch {
                    // Warning is best-effort
                  }
                }
                this.logger.log(`[ON-MY-WAY] Sent verification warning for rental ${msg.rentalId}, skipping AI response`);
                return;
              }
            }
          } catch (omwErr) {
            this.logger.debug(`On-my-way detection failed: ${omwErr.message}`);
          }
        }

        // Retrieve conversation history — 3 recent messages + facts summary from older ones
        const conversationHistory = await this.memoryService.getConversationHistory(chatId, 3);

        // CONTEXT OPTIMIZATION: Determine context level needed
        const contextLevel = this.determineContextLevel(msg.content);

        // Extract meaningful keywords from the message
        const keywords = this.extractSearchKeywords(msg.content, [msg.sender, rental.title]);

        // Detect items mentioned in the message for compatibility/bundle context
        const mentionedItems = this.extractMentionedItems(msg.content);

        // Always load business rules (no context-level gating)
        const rules = await this.rulesService.getFormattedRules();

        // Detect pricing and delivery intent
        const hasPricingIntent = await this.isPricingQuery(msg.content);
        const hasDeliveryIntent = await this.isDeliveryQuery(msg.content);

        // TOKEN-OPTIMIZED: Only load filtered pricing catalog on pricing intent (mentioned items + bundles + alternatives)
        const deliveryKeywords = hasDeliveryIntent ? ['Delivery Pricing Zones', 'Delivery Courier Framework', 'Delivery Rules', 'Delivery Mandatory', 'Fake Location Handling'] : [];
        const [pricingCatalog, pricingMem, keywordMem, deliveryMem] = await Promise.all([
          hasPricingIntent ? Promise.resolve(formatFilteredPricingForAI(mentionedItems)) : Promise.resolve(''),
          hasPricingIntent ? this.memoryService.getPricingMemories() : Promise.resolve(''),
          this.memoryService.getRelevantMemories(keywords, 5),
          hasDeliveryIntent ? this.memoryService.getMinimalMemories(deliveryKeywords, 3) : Promise.resolve(''),
        ]);
        let memories: string = [pricingCatalog, pricingMem, deliveryMem, keywordMem].filter(Boolean).join('\n');

        // Add compatibility + product specs context if items are mentioned
        if (mentionedItems.length > 0) {
          const compatContext = this.memoryService.getCompatibilityContext(mentionedItems);
          if (compatContext) {
            memories = [memories, compatContext].filter(Boolean).join('\n');
          }
          const specsContext = this.memoryService.getItemSpecsContext(mentionedItems);
          if (specsContext) {
            memories = [memories, specsContext].filter(Boolean).join('\n');
          }
        }

        // UNIFIED RECOMMENDATIONS: Bundle intelligence + upsell in a single pass
        const bundleStartDate = rental.start_date ? new Date(rental.start_date) : undefined;
        const bundleEndDate = rental.end_date ? new Date(rental.end_date) : undefined;
        const estimatedTotal = await this.estimateRentalTotal(rental, mentionedItems);
        const conversationText = conversationHistory
          .map(m => `${m.role}: ${m.content}`)
          .join('\n') + `\nuser: ${msg.content}`;

        const recommendations = await this.recommendationService.generateRecommendations({
          message: msg.content,
          mentionedItems,
          conversationText,
          estimatedTotal,
          hasPricingIntent,
          startDate: bundleStartDate,
          endDate: bundleEndDate,
        });

        if (recommendations.bundleContext) {
          memories = [memories, recommendations.bundleContext].filter(Boolean).join('\n');
        }

        // BUNDLE SUGGESTIONS: Keyword/use-case based suggestions (catches "interview", "wedding", etc.)
        const bundleSuggestionContext = this.memoryService.getBundleSuggestionContext(msg.content, mentionedItems);
        if (bundleSuggestionContext && !recommendations.bundleContext) {
          memories = [memories, bundleSuggestionContext].filter(Boolean).join('\n');
        }

        // COMPACT INVENTORY CONTEXT: AI-native — full inventory + bookings, AI reasons about availability
        const inventoryContext = await this.calendarService.getCompactInventoryContext();

        // DEMAND DATA: Fetch once, reuse for trends + upselling (saves duplicate DB query)
        let topDemandItems: [string, number][] = [];
        if (conversationHistory.length <= 4) {
          try {
            topDemandItems = await this.demandService.getTopRequestedItems(30);
          } catch (demandErr) {
            this.logger.debug(`Demand fetch failed: ${demandErr.message}`);
          }
        }

        // Demand trends — first message only (~50 tokens)
        if (conversationHistory.length === 0 && topDemandItems.length > 0) {
          const trendLines = topDemandItems.slice(0, 3).map(([item, count]) => `${item}: ${count}`).join(', ');
          memories = [memories, `\n--- TRENDING ---\n${trendLines}`].filter(Boolean).join('\n');
        }

        // Market data REMOVED from renter chats — internal owner insight only, not for renter conversations

        // Upsell context from unified recommendations
        let upsellContext = recommendations.upsellContext;

        // DEMAND-BASED UPSELLING: First 3 messages, reuse already-fetched demand data
        if ((upsellContext || hasPricingIntent) && topDemandItems.length > 0 && conversationHistory.length <= 4) {
          const popularNotMentioned = topDemandItems
            .filter(([item]) => !mentionedItems.some(m => m.toLowerCase() === item.toLowerCase()))
            .slice(0, 3);
          if (popularNotMentioned.length > 0) {
            const popularSuggestions = popularNotMentioned.map(([item, count]) => `${item} (${count})`).join(', ');
            upsellContext += `\nPopular: ${popularSuggestions}`;
          }
        }

        // Check if delivery needs recalculation (items being added after prior delivery discussion)
        const deliveryRecalc = await this.checkDeliveryRecalculation(rental, msg.content, mentionedItems);

        // PROACTIVE DELIVERY QUOTE: Extract postcode and calculate real quote with item dimensions
        let deliveryQuoteContext = '';
        if (hasDeliveryIntent) {
          try {
            // Extract UK postcode from message
            const postcodeMatch = msg.content.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
            // Also check conversation history for previously mentioned postcodes
            const historyText = conversationHistory.map(m => m.content).join(' ');
            const historyPostcodeMatch = !postcodeMatch ? historyText.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i) : null;
            const postcode = postcodeMatch?.[1] || historyPostcodeMatch?.[1];

            if (postcode) {
              // Determine items for delivery — use extracted items or mentioned items
              const deliveryItems = mentionedItems.length > 0
                ? mentionedItems
                : (await this.prisma.extracteditem.findMany({
                    where: { rental_id: rental.id },
                    select: { item_name: true },
                  })).map(i => i.item_name);

              if (deliveryItems.length > 0) {
                const quote = await this.deliveryService.calculateQuote(postcode, deliveryItems);
                if (quote) {
                  deliveryQuoteContext = `\n--- CALCULATED DELIVERY QUOTE ---\n`;
                  deliveryQuoteContext += `Postcode: ${postcode.toUpperCase()}\n`;
                  deliveryQuoteContext += `Distance: ${quote.distance_km}km from pickup point\n`;
                  deliveryQuoteContext += `Zone: ${quote.zone}\n`;
                  deliveryQuoteContext += `Courier type: ${quote.vehicle_display}\n`;
                  deliveryQuoteContext += `Reason: ${quote.courier_explanation}\n`;
                  if (quote.price_min > 0) {
                    deliveryQuoteContext += `One-way estimate: £${quote.price_min}-${quote.price_max}\n`;
                    deliveryQuoteContext += `Round-trip estimate: £${Math.round(quote.price_min * 1.8)}-${Math.round(quote.price_max * 1.8)}\n`;
                  }
                  // Include item dimension breakdown
                  if (quote.items.length > 0) {
                    deliveryQuoteContext += `Item specs:\n`;
                    for (const item of quote.items) {
                      deliveryQuoteContext += `  - ${item.name}: size ${item.size_score}/5, ${item.weight_kg}kg${item.is_heavy_large ? ' (heavy/large)' : ''}\n`;
                    }
                  }
                  if (quote.notes.length > 0) {
                    deliveryQuoteContext += `Notes: ${quote.notes.join('. ')}\n`;
                  }
                  deliveryQuoteContext += `Use this CALCULATED quote to give the renter an accurate delivery estimate. Do NOT guess or use generic numbers.\n`;
                }
              }
            } else {
              // No postcode found — check if we should determine vehicle type anyway
              const deliveryItems = mentionedItems.length > 0
                ? mentionedItems
                : (await this.prisma.extracteditem.findMany({
                    where: { rental_id: rental.id },
                    select: { item_name: true },
                  })).map(i => i.item_name);

              if (deliveryItems.length > 0) {
                const vehicleInfo = await this.deliveryService.determineVehicle(deliveryItems);
                deliveryQuoteContext = `\n--- DELIVERY VEHICLE DETERMINATION ---\n`;
                deliveryQuoteContext += `Courier type needed: ${vehicleInfo.vehicle_display}\n`;
                deliveryQuoteContext += `Reason: ${vehicleInfo.courier_explanation}\n`;
                if (vehicleInfo.items.length > 0) {
                  deliveryQuoteContext += `Item specs:\n`;
                  for (const item of vehicleInfo.items) {
                    deliveryQuoteContext += `  - ${item.name}: size ${item.size_score}/5, ${item.weight_kg}kg${item.is_heavy_large ? ' (heavy/large)' : ''}\n`;
                  }
                }
                deliveryQuoteContext += `Ask the renter for their postcode to calculate the exact delivery price.\n`;
              }
            }
          } catch (deliveryQuoteErr) {
            this.logger.debug(`Proactive delivery quote calculation failed: ${deliveryQuoteErr.message}`);
          }

          // DELIVERY T&Cs: Check if delivery terms need to be communicated
          try {
            const followUpState = await this.prisma.follow_up_state.findUnique({
              where: { rental_id: rental.id },
            });
            if (followUpState) {
              await this.followUpService.checkDeliveryTCs(followUpState, rental);
            }
          } catch (tcErr) {
            this.logger.debug(`Delivery T&Cs check failed: ${tcErr.message}`);
          }
        }

        // Load today's schedule for pickup/return slot awareness
        let scheduleContext = '';
        try {
          const schedule = await this.calendarService.getFormattedSchedule(new Date());
          if (schedule) {
            scheduleContext = `\n--- TODAY'S SCHEDULE ---\n${schedule}\nUse this to suggest available pickup/return slots accurately.`;
          }
        } catch (e) {
          this.logger.warn(`Schedule load failed: ${e.message}`);
        }

        // Load blacklist for AI awareness (matches Telegram handleConversation)
        let blacklistContext = '';
        try {
          const blacklist = await this.blacklistService.getFormattedBlacklist();
          if (blacklist) {
            blacklistContext = `\n${blacklist}`;
          }
        } catch (blErr) {
          this.logger.debug(`Blacklist context load failed: ${blErr.message}`);
        }

        const pricingInstruction = hasPricingIntent
          ? `The renter is asking about pricing. Reference the pricing catalog to give an accurate estimate. ` +
            `Say "approximately £X/day based on our current listings". ` +
            `When quoting daily prices, use the standard single-day rate (the higher rate). The lower rate only applies to multi-day discounted bookings. ` +
            `Always quote the ONE-DAY price (highest listed) and mention multi-day discounts are available for longer rentals. ` +
            `Mention that the platform adds a small service fee at checkout (do NOT name the platform). ` +
            `Present as ESTIMATES. ` +
            `If a relevant bundle exists, suggest it as better value. ` +
            `CRITICAL: Quote INDIVIDUAL item price for single items -- never confuse with bundle prices (e.g. a single Sony GM lens is £14-22/day, NOT the bundle price). ` +
            `NEVER reveal owner margins or commission rates. Do NOT require a rental request just for a quote.\n`
          : '';

        const deliveryInstruction = hasDeliveryIntent
          ? `The renter is asking about delivery. We only deliver within London (max 30km from our pickup point). ` +
            `Give a delivery price estimate DIRECTLY based on the delivery pricing zones. ` +
            `Tell them which courier type their items need (motorcycle, car, or van) and briefly explain why. ` +
            `Ask for their postcode if not provided. Do NOT require a booking request before giving a quote. ` +
            `Do NOT send the delivery booking form yet -- just the price estimate first. ` +
            `Only ask for full delivery details (exact address, time preferences) after they agree to the estimate.\n` +
            `LOCATION DURING DELIVERY DISCUSSION: Do NOT say "all our gear is in Central London" or "everything is at one location" or "items are stored centrally". ` +
            `Items are listed at DIFFERENT locations on the platform. If the renter asks why pickup is not at the advertised location, use an excuse naturally: ` +
            `"that one's currently out on a rental at that branch", "it's in for a service at the moment", "we're consolidating pickups at our Trafalgar Square spot today", ` +
            `or "stock at that location is all out, but we have it available in Central London". ` +
            `Be apologetic and natural about it — "Sorry about that" or "Apologies for the inconvenience" — then offer pickup at Trafalgar Square area or delivery as alternatives. ` +
            `NEVER reveal that all items are actually at the same place. Treat each listing location as if it were real.\n`
          : '';

        // CONVERSATION TREE: Get stage-specific guidance
        const stageGuidance = await this.conversationStageService.getStagePrompt(rental.id);

        // RENTER PROFILE CONTEXT: Always provide full renter history and progress
        let renterProfileContext = '';
        let currentProfileId: string | undefined;
        try {
          const renterProfile = await this.renterProfileService.getProfileForRental(rental.id);
          if (renterProfile) {
            currentProfileId = renterProfile.id;
            renterProfileContext = await this.renterProfileService.buildRenterContext(renterProfile.id, rental.id);
          }
        } catch (rpErr) {
          this.logger.debug(`Renter profile context fetch failed: ${rpErr.message}`);
        }

        // VERIFICATION GUIDANCE: Only guide after INTEREST stage (not on first inquiry)
        const convState = await this.conversationStageService.getConversationState(rental.id);
        const stageOrder = ['inquiry', 'interest', 'qualified', 'booking_ready', 'booking_sent', 'awaiting_verification', 'confirmed'];
        const currentStageIdx = convState ? stageOrder.indexOf(convState.currentStage) : -1;
        const pastInquiry = currentStageIdx >= 1; // at least INTEREST stage

        if (currentProfileId && pastInquiry) {
          try {
            const verificationGuidance = await this.verificationService.handleVerificationNeeded(rental, currentProfileId);
            if (verificationGuidance) {
              renterProfileContext = [renterProfileContext, `\n--- VERIFICATION GUIDANCE ---\n${verificationGuidance}\nProactively mention verification if relevant to the conversation.`].filter(Boolean).join('\n');
            }

            // Check for failed verification attempts — only if there is an actual verification failure
            // detected via chat activities or API status (NOT on every message)
            const renterProfile = await this.renterProfileService.getProfile(currentProfileId);
            const hasActualVerificationFailure = renterProfile?.verification_status === 'failed' ||
              (renterProfile?.verification_status === 'pending' && renterProfile?.verification_attempts > 0);
            if (hasActualVerificationFailure) {
              // Only show failure guidance if already tracked — do NOT increment counter here
              const alreadyGuided = await this.renterProfileService.hasBeenSentVerificationFailureGuidance(currentProfileId);
              if (!alreadyGuided && renterProfile && renterProfile.verification_attempts >= 3) {
                const failureGuidance = await this.verificationService.handleVerificationFailure(rental, currentProfileId);
                if (failureGuidance) {
                  renterProfileContext = [renterProfileContext, `\n--- VERIFICATION HELP ---\n${failureGuidance}`].filter(Boolean).join('\n');
                }
              }
            }
          } catch (verifyErr) {
            this.logger.debug(`Verification guidance check failed: ${verifyErr.message}`);
          }
        }

        // Build rental stage context for pipeline awareness
        let rentalStageContext = '';
        try {
          rentalStageContext = await this.buildRentalStageContext(rental);
        } catch (stageErr) {
          this.logger.debug(`Rental stage context build failed: ${stageErr.message}`);
        }

        // Check discount eligibility and build context for AI
        let discountContext = '';
        try {
          const discountResult = await this.followUpService.checkAndApplyDiscount(rental);
          discountContext = this.followUpService.buildDiscountContext(rental, discountResult);
        } catch (discErr) {
          this.logger.debug(`Discount check in processMessage failed: ${discErr.message}`);
        }

        // Same-day rental instruction for AI
        let sameDayInstruction = '';
        if (this.isSameDayRental(rental)) {
          const rentalValue = rental.rental_price || 0;
          const SAME_DAY_AUTO_THRESHOLD = 40;

          if (rentalValue <= SAME_DAY_AUTO_THRESHOLD) {
            // Low-value same-day: upsell first, then escalate for approval
            sameDayInstruction =
              `\n--- SAME-DAY RENTAL (LOW VALUE — UPSELL FIRST) ---\n` +
              `This is a SAME-DAY rental worth only £${rentalValue}. Before sending to Daniel for approval:\n` +
              `1. Try to upsell — suggest additional items, accessories, or longer rental period to increase the order value.\n` +
              `2. After upselling (or if the renter declines), let them know you're checking availability.\n` +
              `3. Do NOT confirm or accept the booking — Daniel must approve.\n` +
              `Keep it natural — don't be pushy, just suggest relevant add-ons.\n`;
          } else {
            sameDayInstruction =
              `\n--- SAME-DAY RENTAL ---\n` +
              `This is a SAME-DAY rental. Do NOT confirm or accept the booking. ` +
              `Gather all info (items, times, requirements) and let the renter know you are checking final availability. ` +
              `Say something like: "Let me just confirm availability for today and I'll get right back to you." ` +
              `Daniel must manually approve all same-day rentals before acceptance.\n`;
          }
        }

        // Account-based persona selection (matches Telegram sim mode)
        const accountName = rental.account || 'dbcinema';
        const persona = accountName === 'leo'
          ? 'You are Leo, the owner of Leo Adams gear rental. You speak as yourself — use "I" and "my" naturally (e.g., "I\'ve got the FX3 available", "my gear is all based in Central London"). Be warm, personable, and slightly chill. You\'re a real person chatting, not a business representative. Keep it friendly and genuine.'
          : 'You are Daniel from DB Cinema Rentals. Professional, concise, human tone.';
        const businessName = accountName === 'leo' ? 'Leo Adams' : 'DB Cinema Rentals';

        // ACCOUNT TEMPLATES: Inject account-specific template guidance
        try {
          const accountTemplates = await this.memoryService.getAccountTemplates(accountName as 'dbcinema' | 'leo');
          if (accountTemplates) {
            memories = [memories, `\n--- ACCOUNT TEMPLATES ---\n${accountTemplates}`].filter(Boolean).join('\n');
          }
        } catch (templateErr) {
          this.logger.debug(`Account templates fetch failed: ${templateErr.message}`);
        }

        // LISTING_INVENTORY_MISMATCH: Validate listing title against actual inventory
        let listingInventoryContext = '';
        try {
          const listingValidation = validateListingAgainstInventory(rental.title);
          const listingQty = extractListingQuantity(rental.title);

          if (!listingValidation.matched) {
            // Ghost / SEO listing — item does NOT exist in our physical inventory
            listingInventoryContext =
              `\n--- LISTING_INVENTORY_MISMATCH ---\n` +
              `WARNING: This listing item is NOT in our physical inventory. The listing title "${rental.title}" does not match any item we actually own.\n` +
              `You MUST NOT confirm this item as available. Instead, apologise that this specific item is not currently available ` +
              `and offer the closest alternative from our actual inventory if one exists.\n` +
              `NEVER confirm availability of items not in the master inventory.\n` +
              `When an item is unavailable, ALWAYS suggest at least one alternative from our actual inventory. For cameras, suggest other camera bodies we have. For audio, suggest other mic options. Never just say "unavailable" without an alternative.\n`;
            // Try to find the closest alternative
            const altMatch = findBestMatch(rental.title, getInventoryItemNames());
            if (altMatch) {
              listingInventoryContext += `Closest alternative we DO have: "${altMatch}" (${MASTER_INVENTORY[altMatch]} unit(s)).\n`;
            }
          } else if (listingQty > listingValidation.maxQuantity) {
            // Listing title claims more units than we have (e.g. "4x Anker F2000" but only 1 in stock)
            listingInventoryContext =
              `\n--- LISTING_INVENTORY_MISMATCH ---\n` +
              `WARNING: The listing title says "${listingQty}x" but we only have ${listingValidation.maxQuantity} unit(s) of "${listingValidation.inventoryItem}" in stock.\n` +
              `Tell the renter we have ${listingValidation.maxQuantity} unit(s) available. ` +
              `NEVER offer to source, procure, find, or negotiate additional units — our inventory is fixed.\n` +
              `Ask if ${listingValidation.maxQuantity} unit(s) would work for them.\n`;
          }
        } catch (invErr) {
          this.logger.debug(`Listing inventory validation failed: ${invErr.message}`);
        }

        const messagePrompt =
          `A renter sent a message on the ${businessName} account. Draft a reply.\n\n` +
          `${persona}\n\n` +
          `Renter: ${msg.sender}\n` +
          `Their message: "${msg.content}"\n` +
          `Rental: ${rental.title}\n\n` +
          `${listingInventoryContext}` +
          `${pricingInstruction}` +
          `${deliveryInstruction}` +
          `${deliveryRecalc}` +
          `${upsellContext}` +
          `${stageGuidance}` +
          (renterProfileContext ? `\n${renterProfileContext}\n` : '') +
          (rentalStageContext ? `\n${rentalStageContext}\n` : '') +
          `${discountContext}` +
          `${sameDayInstruction}` +
          `\nReply following our communication tone rules. Keep it concise, clear, and well-formatted.\n` +
          `NEVER invent or guess prices. Only quote the exact booking price shown below. If you don't know the price, say you'll confirm it.\n` +
          `NEVER mention internal business rules, platform fees, minimum thresholds, or commission structures to the renter.\n` +
          `NEVER mention the name of any rental platform (Hygglo, Fat Llama, etc.) to the renter. If you need to reference the platform, just say "the platform" or "the booking system".\n` +
          `CROSS-ITEM QUERIES: If the renter asks about items NOT in their current booking, answer the question fully and helpfully first. Do NOT lead with "this booking is for X" or "there might be a mix-up." Just answer their question about the item they asked about, then optionally mention they can add it to their booking or create a new request.\n` +
          `INCLUDED ACCESSORIES: When quoting any item, always mention what is included (batteries, cards, plates, adapters, cables). V-mount battery rentals ALWAYS include plates, adapters, and cables — state this explicitly. When quoting V-mount batteries, always mention BOTH the 95mAh and 150mAh options with their different price points.\n` +
          // --- CRITICAL BEHAVIORAL REINFORCEMENTS (matched from Telegram sim mode) ---
          `CRITICAL — NO FABRICATION: ONLY reference items that exist in the MASTER_INVENTORY. If an item name does not match anything in the inventory, say "we don't currently have that item" and suggest the closest alternative. NEVER invent item names, features, or availability. Everything you state must come from the data provided to you. ` +
          `CRITICAL — INVENTORY ONLY: You can ONLY confirm availability of items that are in the MASTER_INVENTORY list. If you cannot find an item in the inventory data provided, tell the renter we do not currently stock that item. Suggest the closest item we DO have. ` +
          `MASTER INVENTORY ITEMS: ${getInventoryItemNames().join(', ')}. ` +
          `IMPORTANT REMINDERS: ` +
          `1) When a renter enquires about items, pricing, or delivery, just give them the information directly. Do NOT tell them to send a rental request just to get information or a quote — a request is only needed when they want to actually book. ` +
          `2) When confirming pickup arrangements, mention the pickup is near Trafalgar Square. NEVER say "all our gear is in Central London", "everything is at one location", "all items are stored at the same place", or anything that reveals items are centralised. Each listing has its OWN advertised location — treat them as real. If the renter asks why pickup is not at the advertised location, be APOLOGETIC first ("Sorry about that", "Apologies for the hassle"), then use a natural excuse: "that one's out on a rental there right now", "it's in for maintenance at our central hub", "we're consolidating pickups today", or "stock at that branch is all out but we have it in Central London". Never be blunt or matter-of-fact about it — always show you understand the inconvenience. ` +
          `3) Only mention the 10% travel distance discount if the renter's location (from the rental request or conversation) is clearly 20km+ from Central London. Use the location shown in the rental metadata — NEVER ask the renter for their postcode just to check discount eligibility. ` +
          `CRITICAL — LOCATION: Do NOT share any specific street address, building name, or postcode. Before booking is confirmed, ONLY say "Central London (Trafalgar Square area)". If they ask for the exact address, say you will share the meetup point once the booking is confirmed. ` +
          `CRITICAL — AVAILABILITY: When live availability data is provided below, you MUST use it to answer accurately. Do NOT state static inventory counts — check the live data for actual bookings. If an item is booked for the requested dates, tell the renter it is unavailable. ` +
          `CRITICAL — DISCLOSURE: Never mention AI, bots, automated systems, Claude, or scanning. Never reveal margins, platform fees, or pricing formulas. Never reveal that DB Cinema and Leo Adams are the same business. ` +
          `CRITICAL — FORMATTING: Do NOT use markdown formatting (no bold, no bullet points, no headers, no dashes as list items). Write plain text only. Use commas or line breaks to separate options, not bullet-style lists. ` +
          `CRITICAL — LANGUAGE: ${accountName === 'leo' ? 'Use "I" and "my" naturally. Say "I\'ve got", "my gear", "my kit". Speak as an individual, not a business.' : 'Never say "my gear", "my items", "my equipment", or "my stuff". Say "our items", "the gear", "the equipment", or "items available". You represent the business, not personal ownership.'} ` +
          `CRITICAL — NO DOWNSELLING: NEVER tell a renter they have "enough", are "set", are "all good", or "don't need" something. NEVER say "pretty much set", "should be enough", "usually enough", or any similar phrase. If they ask what else they might need, suggest relevant accessories based on their project — do NOT dismiss the question. Facilitate and upsell, never downsell. ` +
          `CRITICAL — PICKUP PRIORITY: ALWAYS offer the 10am pickup slot FIRST. Day-before evening pickup: FREE for larger orders, small fee for smaller orders — just quote the adjusted total naturally, NEVER mention surcharge percentages. Never suggest day-before as default. Morning slots (10am-12pm) before evening slots (7pm-9pm). If the renter has told you their event/shoot times, acknowledge those times and work backwards to suggest a pickup that fits their schedule — do not ignore what they said and just quote generic slots. ` +
          `CRITICAL — RETURN PRIORITY: Always suggest the earliest possible return slot. Morning-after return: FREE for larger orders, small fee for smaller orders — just quote the adjusted total naturally. Evening next day = always a full extra day. Half-day grace ONLY for 1-day rentals. Both day-before pickup AND morning-after return = full extra day regardless of value. ` +
          `CRITICAL — BMPCC BATTERIES: BMPCC 6K Pro comes with 5x LP-E6NH batteries. BMPCC 6K Full Frame comes with 5x LP-E6NH batteries. NEVER say 2x or 3x. The number is FIVE (5). Always include the battery model name "LP-E6NH" — never just say "5 batteries" without the model. ` +
          `CRITICAL — LOCATION LOCK: The renter location established at the START of the conversation is authoritative. If they mention a different location later, do NOT update your assumption. ` +
          `CRITICAL — V-MOUNT: V-mount battery rentals include all necessary plates, adapters, and cables. Never say "via plate" or imply renters need separate accessories. ` +
          `CRITICAL — CONTEXTUAL RECOMMENDATIONS (HIGH PRIORITY): If the renter has NOT mentioned what they are shooting, you MUST ask what the project is for (e.g., "What's the shoot for?"). This is essential for recommending the right gear. Once you know the use case, actively suggest complementary items they might need (audio, lighting, stabilization, etc.). Do NOT just answer their question and stop — help them think about what else they might need. ` +
          `CRITICAL — DJ + SPEAKERS: Delivery is MANDATORY for DJ deck + speakers together. Never allow self-pickup for this combination. ` +
          `CRITICAL — SAME-DAY RENTALS: NEVER auto-approve same-day rentals. Ask for pickup time, then check with Daniel before confirming. ` +
          `CRITICAL — TIMING: When calendar data is available, suggest pickup/return times that align with other existing bookings to minimize Daniel's trips. ` +
          `CRITICAL — NO PRICE NEGOTIATION: NEVER offer custom discounts or negotiate prices. Only standard discount tiers apply. Escalate price requests to Daniel. ` +
          `CRITICAL — ADDRESS: NEVER share a specific street address before booking is confirmed. Only say "Central London (Trafalgar Square area)". ` +
          `CRITICAL — LOCATION EXCUSES: If the renter asks why an item is not at the advertised listing location, FIRST apologise ("Sorry about that", "Apologies for the inconvenience"), THEN use a natural excuse: "that one's currently out on a rental at that branch", "it's in for a service at the moment so we've moved it to our central hub", "we're consolidating pickups at our Trafalgar Square spot today", "stock at that location is all out right now, but we have it available in Central London". Be warm and understanding — acknowledge it is a hassle. NEVER say "the listing location is fake", "that item isn't actually there", "all our locations are the same", "all items are at one location", or "everything is stored centrally". Each listing location should be treated as genuinely real. ` +
          `CRITICAL — LOCATION_REJECTION: If the renter says the location is "too far", "not convenient", or similar, do NOT assume they want delivery. Instead: (1) apologise for the inconvenience, (2) acknowledge that the distance is a pain, (3) gently ask if delivery might be an option that could help — phrased as a suggestion, not an assumption. Example: "Sorry about that — I appreciate it's not the most convenient spot for you. We do offer delivery if that would make things easier? Happy to get you a quote if you'd like." ` +
          `CRITICAL — FORMATTING OPTIONS: When presenting multiple choices or bundles, lead with the recommendation then show 1-2 alternatives. Keep each option to 1-2 lines. Do NOT list options as numbered bullet points with full specs — keep it conversational and concise. ` +
          `CRITICAL — SUBSTITUTIONS: When an exact item is unavailable but a close alternative exists, explain the difference simply and naturally. Example: "That specific monitor's out, but I've got the Hollyland Pyro 7 inch — same size and quality, just doesn't record like the Atomos does. Still works great as a monitor though." ` +
          `CRITICAL — EARNINGS TERMINOLOGY: When discussing revenue or income with Daniel (not renters), always use "earnings" — this is the number shown at the top of the Hygglo listing with fees already deducted. No need to calculate or subtract fees. ` +
          `CRITICAL — PRICING DISCLAIMER: When quoting prices from the catalog (not from an existing booking), mention that exact pricing is confirmed once the booking request is submitted. Keep it natural. ` +
          `CRITICAL — TRAVEL DISCOUNT: Only mention the 10% travel distance discount if the renter's location (from the rental request or conversation) is clearly 20km+ from Central London. Use the location shown in the rental metadata — NEVER ask the renter for their postcode just to check discount eligibility. NEVER mention it speculatively or before location is known. ` +
          `CRITICAL — VACATION HANDLING: When Daniel is away or has scheduling constraints, proactively suggest the nearest available pickup/return time BEFORE the unavailability starts. If same-day return is impossible due to owner schedule, proactively offer a FREE next-morning return since it is our scheduling limitation, not the renter's fault. If the renter requests a next-EVENING return instead, that counts as an extra rental day. Always suggest workable alternatives rather than just declining. ` +
          `CRITICAL — DISCOUNT RULES: Discounts do NOT stack — only one discount tier applies. Discounts NEVER apply to delivery quotes — delivery pricing is always separate. Discounts are applied automatically at checkout. If asked about discounts, say "discounts for longer rentals are applied automatically when you send a request." NEVER reveal exact thresholds, percentages, or how to qualify. ` +
          `CRITICAL — V-MOUNT PRICING: V-mount 95mAh (~£11-15/day) and V-mount 150mAh (~£20-28/day) have DIFFERENT prices — never quote the same price for both. When a renter wants to add V-mounts to a bundle, FIRST check if a bundle variant already includes V-mounts so they can book at a better combined price. ` +
          `CRITICAL — BUNDLE UPGRADE: When a renter selects a bundle but wants to add items, always check if a larger bundle exists that includes those items. Suggest the bigger bundle if it offers better value. ` +
          `CRITICAL — WRITING STYLE: Keep messages concise and scannable. Use short paragraphs (2-3 sentences max). Lead with the answer, then add context. Make prices and key info easy to spot at a glance. ` +
          `CRITICAL — DELIVERY ACCURACY: Always include the disclaimer that delivery estimates are usually accurate within approximately 15 percent, and the actual price is confirmed by the courier. ` +
          `CRITICAL — MULTI-ITEM HANDLING: When a renter has multiple rental requests consolidated into one chat, acknowledge ALL items in your response. Reference the multi-item context if provided. Consider bundle pricing when multiple items are requested together. ` +
          `CRITICAL — VERIFICATION GUIDANCE: When the platform requires identity verification before confirming a booking, proactively guide the renter through the process. Mention they need to upload a photo of their ID (driving licence or passport) through the app. Be helpful and reassuring, not bureaucratic. If they have trouble, suggest trying a passport or contacting platform support. ` +
          `CRITICAL — FOLLOW-UP BEHAVIOR: If the renter has gone quiet after we quoted them, do NOT keep sending messages unprompted. The system handles follow-ups automatically. Focus on answering their actual messages helpfully and completely. ` +
          `CRITICAL — RETURNING RENTERS: If renter profile shows they have rented before, skip the generic welcome. Say "Welcome back!" and get straight to confirming items and dates. If they have previous agreements on file, do NOT re-ask questions already answered — reconfirm and progress to booking. ` +
          `Start your response with the exact reply text (no preamble).`;

        // Build rich rental context with actual pricing
        const startDateStr = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
        const endDateStr = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
        const days = rental.start_date && rental.end_date
          ? Math.max(1, Math.ceil((new Date(rental.end_date).getTime() - new Date(rental.start_date).getTime()) / (1000 * 60 * 60 * 24)))
          : null;
        // Fetch owner earnings from booking revenue (what Daniel actually receives after Hygglo fees)
        let ownerEarnings: number | null = null;
        try {
          const bookingRevenue = await this.prisma.booking.aggregate({
            where: { rental_id: rental.id, status: { in: ['confirmed', 'pending_review'] } },
            _sum: { revenue: true },
          });
          ownerEarnings = bookingRevenue._sum.revenue || null;
        } catch { /* optional */ }

        let rentalContextStr = `Current rental: ${rental.title}\n` +
          `Status: ${rental.status}\n` +
          `Renter: ${rental.renter_info || 'Unknown'}\n` +
          `Dates: ${startDateStr} to ${endDateStr}${days ? ` (${days} day${days > 1 ? 's' : ''})` : ''}\n`;
        if (rental.rental_price) {
          rentalContextStr += `Renter pays: £${rental.rental_price} total (this is what the renter sees)\n`;
        }
        if (ownerEarnings) {
          rentalContextStr += `Your earnings: £${ownerEarnings} (after platform fees)\n`;
        }
        if (rental.price_per_day && days && days > 1) {
          rentalContextStr += `Price per day: £${rental.price_per_day}/day\n`;
        }
        rentalContextStr += `IMPORTANT: These are the REAL prices from the booking. Quote ONLY these figures to the renter. Do NOT make up daily rates, weekly rates, or any other pricing. When speaking to the renter, use the "Renter pays" figure. When Daniel asks about earnings, use the "Your earnings" figure.`;

        // DSPy INTEGRATION: Try optimized response generation when DSPy is enabled
        let dspyResponse: any = null;
        if (this.dspyService.isEnabled()) {
          try {
            const moduleType = hasPricingIntent ? 'pricing' : hasDeliveryIntent ? 'delivery' : 'rental';
            const contextStr = [rentalContextStr, inventoryContext, scheduleContext, deliveryQuoteContext].filter(Boolean).join('\n');
            dspyResponse = await this.dspyService.generateResponse(moduleType, msg.content, contextStr, rules);
            if (dspyResponse?.response) {
              this.logger.log(`DSPy optimized response generated for ${rental.title} (module: ${moduleType})`);
            } else {
              dspyResponse = null; // Fall back to standard AI
            }
          } catch (dspyErr) {
            this.logger.debug(`DSPy response generation failed, falling back to standard AI: ${dspyErr.message}`);
            dspyResponse = null;
          }
        }

        // Inject conversation summary + rejection memory (cached, no AI call)
        const conversationSummary = await this.memoryService.getCachedSummary(rental.id);

        const response = dspyResponse?.response
          ? { content: dspyResponse.response, memories: [], model: 'dspy-optimized', inputTokens: 0, outputTokens: 0 }
          : await this.aiService.processRoutine(messagePrompt, {
          rules,
          memories,
          conversationHistory,
          rentalContext: rentalContextStr,
          additionalContext: [inventoryContext, scheduleContext, blacklistContext, deliveryQuoteContext, conversationSummary].filter(Boolean).join('\n'),
          rentalDates: { start: rental.start_date, end: rental.end_date },
        });

        // VALIDATION: Check response before sending
        const validationResult = await this.validationService.validateResponse(
          response.content,
          {
            responseType: 'customer_message',
            context: { rental, message: msg },
          },
        );

        // QUALITY SCORING: Compute quality metrics
        const qualityScore = await this.qualityScorerService.scoreResponse(
          response.content,
          {
            account: rental.account || 'dbcinema',
            messageType: hasPricingIntent ? 'pricing' : hasDeliveryIntent ? 'delivery' : 'message',
            hasPricing: hasPricingIntent,
            validationResult,
          },
          validationResult,
        );

        // Send the reply on Hygglo (gated by READ_ONLY_MODE and VALIDATION)
        const writeBlocked = this.isWriteBlocked(msg.rentalId);
        let actionTaken: string;

        if (validationResult.blocked && validationResult.severity === 'critical') {
          // Attempt deterministic repair before escalating
          const repairResult = this.repairService.attemptRepair(
            response.content, validationResult, { account: rental.account || 'dbcinema' },
          );
          if (repairResult.repaired) {
            // Re-validate the repaired response
            const revalidation = await this.validationService.validateResponse(
              repairResult.content, { responseType: 'customer_message', context: { rental, message: msg } },
            );
            if (!revalidation.blocked) {
              // Repair succeeded — use repaired content
              response.content = repairResult.content;
              validationResult.blocked = false;
              validationResult.violations = [];
              this.logger.log(`Self-repaired response: ${repairResult.repairs.join(', ')}`);
            }
          }
        }

        if (validationResult.blocked && validationResult.severity === 'critical') {
          // CRITICAL: Block sending, escalate to owner
          this.logger.error(`BLOCKED [VALIDATION] Critical violations: ${validationResult.violations.join(', ')}`);
          actionTaken = `BLOCKED - validation failed (${validationResult.severity}): ${validationResult.violations.join(', ')}`;
        } else if (/^(none|n\/a|no message|escalate|flag|skip|defer|internal|notify daniel)/i.test(response.content.trim())) {
          // Guard: AI returned internal decision text instead of a customer-facing reply
          this.logger.warn(`BLOCKED [INTERNAL_RESPONSE] Non-customer reply for rental ${msg.rentalId}: "${response.content.substring(0, 100)}"`);
          actionTaken = `BLOCKED - AI returned internal decision, not customer text: "${response.content.substring(0, 100)}"`;
        } else if (writeBlocked) {
          this.logger.warn(`BLOCKED [READ_ONLY_MODE] Draft reply for rental ${msg.rentalId}: "${response.content.substring(0, 100)}..."`);
          actionTaken = `BLOCKED - read-only mode. Draft: "${response.content.substring(0, 100)}..."`;
        } else {
          actionTaken = 'Sending reply...';
          try {
            const sent = await this.hyggloService.sendMessage(msg.rentalId, response.content);
            actionTaken = sent
              ? `Sent reply: "${response.content.substring(0, 100)}..."`
              : `Failed to send reply: "${response.content.substring(0, 100)}..."`;
          } catch (sendError) {
            this.logger.warn(`Could not send Hygglo message: ${sendError.message}`);
            actionTaken = `Failed to send: ${sendError.message}. Draft: "${response.content.substring(0, 100)}..."`;
          }
        }

        // Store outgoing message in conversation history (only if not blocked)
        if (!validationResult.blocked) {
          await this.memoryService.storeConversation(chatId, 'assistant', response.content, {
            model: response.model,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
          });

          // Follow-up tracking: mark bot message sent
          await this.followUpService.onBotMessage(rental.id);

          // Rejection detection: check if renter declined a bot suggestion
          this.followUpService.detectRejection(rental.id, msg.content, response.content).catch(() => {});

          // Background summary refresh (non-blocking, every few messages)
          if (conversationHistory.length >= 4 && conversationHistory.length % 3 === 0) {
            this.memoryService.buildConversationSummary(rental.id, chatId).catch(() => {});
          }
        }

        // Store decision with computed confidence
        const responseWasBlocked = actionTaken.startsWith('BLOCKED');
        const wasSent = actionTaken.startsWith('Sent reply') ? true : (responseWasBlocked ? false : null);
        const aiDecision = await this.prisma.ai_decision.create({
          data: {
            rental_id: rental.id,
            decision_type: 'message',
            input_summary: `Message from ${msg.sender}: "${msg.content.substring(0, 200)}"`,
            output_summary: response.content.substring(0, 500),
            confidence: qualityScore.computedConfidence, // Use computed confidence
            action_taken: actionTaken,
            notified: true,
            was_sent: wasSent,
          },
        });

        // Store quality score
        await this.qualityScorerService.storeQualityScore(aiDecision.id, qualityScore);

        // SENTRY: Monitor quality scores (alerts if < 0.7)
        this.errorLogService.monitorQualityScore(
          qualityScore.overallQuality,
          rental.id,
          {
            pricing_accuracy: qualityScore.pricingAccuracy,
            rule_compliance: qualityScore.ruleCompliance,
            conciseness: qualityScore.conciseness,
            tone_match: qualityScore.toneMatch,
            message_type: hasPricingIntent ? 'pricing' : hasDeliveryIntent ? 'delivery' : 'general',
          },
        );

        // SENTRY: Track validation failures
        if (validationResult.blocked) {
          this.errorLogService.monitorValidationFailure(
            'MessageValidation',
            validationResult.violations.join(', '),
            {
              rental_id: rental.id,
              severity: validationResult.severity,
              response_preview: response.content.substring(0, 200),
            },
          );
        }

        // CONSOLIDATED NOTIFICATION: Send exactly ONE Telegram message per processed rental message
        // Combines validation alerts, quality alerts, and message info into a single notification
        const notificationParts: string[] = [];
        notificationParts.push(`├ 📦 ${rental.title}`);
        notificationParts.push(`├ 👤 From: ${msg.sender}`);
        notificationParts.push(`├ 💬 ${msg.content.substring(0, 150)}`);

        let notificationIcon = '💬';
        let notificationTitle = 'New Hygglo Message';

        if (validationResult.blocked && validationResult.severity === 'critical') {
          notificationIcon = '🚫';
          notificationTitle = 'CRITICAL: AI Response Blocked';
          notificationParts.push(`├ ⛔ Violations: ${validationResult.violations.join(', ')}`);
          notificationParts.push(`├ 🤖 Blocked response: "${response.content.substring(0, 150)}..."`);
          notificationParts.push(`└ Action: Response NOT sent - please reply manually`);
        } else if (actionTaken.startsWith('BLOCKED - AI returned')) {
          notificationIcon = '⚠️';
          notificationTitle = 'AI Returned Non-Customer Response';
          notificationParts.push(`├ 🤖 AI said: "${response.content.substring(0, 150)}"`);
          notificationParts.push(`└ Action: Response NOT sent — please reply manually`);
        } else if (qualityScore.overallQuality < 0.7 && !responseWasBlocked) {
          notificationIcon = '⚠️';
          notificationTitle = 'Quality Alert';
          const lowScores: string[] = [];
          if (qualityScore.pricingAccuracy != null && qualityScore.pricingAccuracy < 0.7) lowScores.push(`pricing: ${qualityScore.pricingAccuracy.toFixed(2)}`);
          if (qualityScore.ruleCompliance != null && qualityScore.ruleCompliance < 0.7) lowScores.push(`rules: ${qualityScore.ruleCompliance.toFixed(2)}`);
          if (qualityScore.conciseness != null && qualityScore.conciseness < 0.7) lowScores.push(`conciseness: ${qualityScore.conciseness.toFixed(2)}`);
          if (qualityScore.toneMatch != null && qualityScore.toneMatch < 0.7) lowScores.push(`tone: ${qualityScore.toneMatch.toFixed(2)}`);
          notificationParts.push(`├ 📊 Quality: ${qualityScore.overallQuality.toFixed(2)} (${lowScores.join(', ') || 'composite'})`);
          notificationParts.push(`├ 🤖 Reply: ${response.content.substring(0, 100)}`);
          notificationParts.push(`└ Status: ${actionTaken}`);
        } else {
          notificationParts.push(`├ 🤖 Reply: ${response.content.substring(0, 150)}`);
          notificationParts.push(`└ Status: ${actionTaken}`);
        }

        await this.telegramService.sendProactiveMessage(
          `${notificationIcon} *${notificationTitle}*\n\n${notificationParts.join('\n')}`,
        );

        if (response.memories.length > 0) {
          await this.memoryService.processAiMemories(response.memories);
        }

        // Time extraction — stage-dependent behavior
        try {
          const timeStageState = await this.conversationStageService.getConversationState(rental.id);
          const timeStage = timeStageState?.currentStage || 'inquiry';

          if (timeStage === 'confirmed') {
            // CONFIRMED: Full extraction + proactive request + availability validation
            await this.ensureTimeRequestSent(rental);
            await this.extractPickupReturnTimes(msg, rental);
          } else if (['interest', 'qualified', 'booking_ready', 'booking_sent', 'awaiting_verification'].includes(timeStage)) {
            // PRE-CONFIRMATION: Regex-only tentative time tracking (no AI call)
            await this.noteTentativeTimes(msg, rental);
          }
        } catch (timeErr) {
          this.logger.debug(`Time extraction failed for message from ${msg.sender}: ${timeErr.message}`);
        }

        // Update acceptance readiness based on conversation state
        try {
          await this.updateAcceptanceReadinessFromConversation(rental, msg, mentionedItems, response.content);
        } catch (readinessErr) {
          this.logger.debug(`Acceptance readiness update failed: ${readinessErr.message}`);
        }

        // CONVERSATION STAGE TRANSITION: Check if renter message should advance the funnel
        try {
          const transition = await this.conversationStageService.checkStageTransition(rental.id, msg.content);
          if (transition.shouldTransition && transition.newStage) {
            this.logger.log(`Stage transition for ${rental.title}: → ${transition.newStage} (${transition.reason})`);
          }
        } catch (stageTransErr) {
          this.logger.debug(`Stage transition check failed: ${stageTransErr.message}`);
        }

        // Track bundle acceptance if renter confirms a bundle offer
        try {
          const bundleAcceptance = this.detectBundleAcceptance(msg.content, response.content);
          if (bundleAcceptance?.accepted) {
            await this.prisma.ai_decision.create({
              data: {
                rental_id: rental.id,
                decision_type: 'analyze',
                input_summary: `bundle_accepted: ${bundleAcceptance.bundleMentioned} by ${msg.sender}`,
                output_summary: `Renter confirmed bundle: ${bundleAcceptance.bundleMentioned}. Update rental listing items accordingly.`,
                confidence: 0.85,
                action_taken: `Bundle acceptance tracked: ${bundleAcceptance.bundleMentioned}`,
                notified: true,
                was_sent: null, // internal tracking, not a customer message
              },
            });

            this.logger.log(`Bundle accepted: ${bundleAcceptance.bundleMentioned} for ${rental.title} by ${msg.sender}`);
          }
        } catch (bundleErr) {
          this.logger.debug(`Bundle acceptance detection failed: ${bundleErr.message}`);
        }

        // Update renter profile progress so the bot always knows what this renter wants
        if (currentProfileId) {
          try {
            await this.renterProfileService.updateProgress(currentProfileId, {
              items_interested: mentionedItems.length > 0 ? mentionedItems : undefined,
              last_inquiry_summary: msg.content.substring(0, 300),
            });
          } catch (progressErr) {
            this.logger.debug(`Renter profile progress update failed: ${progressErr.message}`);
          }

          // Extract renter notes — INQUIRY/INTEREST stage only (project type is shared early)
          try {
            const noteState = await this.conversationStageService.getConversationState(rental.id);
            const noteStage = noteState?.currentStage || 'inquiry';
            if (noteStage === 'inquiry' || noteStage === 'interest') {
              const renterNote = await this.extractRenterNotes(msg.content);
              if (renterNote) {
                const profile = await this.renterProfileService.getProfile(currentProfileId);
                const existing = profile?.rental_progress || '';
                const combined = existing ? `${existing} | ${renterNote}` : renterNote;
                await this.renterProfileService.updateProgress(currentProfileId, {
                  rental_progress: combined.substring(0, 1000),
                });
              }
            }
          } catch (noteErr) {
            this.logger.debug(`Renter note extraction failed: ${noteErr.message}`);
          }
        }
      } catch (error) {
        this.logger.error(`Error processing message: ${error.message}`);

        // SENTRY: Capture message processing errors
        this.errorLogService.captureError(error, {
          operation: 'process_message',
          rental_id: rental?.id,
          sender: msg.sender,
          message_preview: msg.content.substring(0, 100),
        });
      } finally {
        this.activeRentalProcessing.delete(msg.rentalId);
        this.releaseProcessingSlot();
      }
  }

  // --- Proactive time request once rental hits CONFIRMED ---

  private async ensureTimeRequestSent(rental: any): Promise<void> {
    const followUpState = await this.prisma.follow_up_state.findUnique({
      where: { rental_id: rental.id },
    });
    if (!followUpState) return;

    // Already sent
    if ((followUpState as any).time_request_sent) return;

    // Check if bookings already have times (from chat history extraction)
    const bookings = await this.prisma.booking.findMany({
      where: { rental_id: rental.id, status: 'confirmed' },
      select: { pickup_time: true, return_time: true },
    });

    if (bookings.length > 0 && bookings[0].pickup_time && bookings[0].return_time) {
      // Times already exist — mark as confirmed
      await this.prisma.follow_up_state.update({
        where: { id: followUpState.id },
        data: {
          time_request_sent: true,
          time_request_sent_at: new Date(),
          times_status: 'confirmed',
        },
      });
      this.logger.log(`Times already confirmed for ${rental.title} — skipping proactive request`);
      return;
    }

    // Send proactive time request
    if (!this.isWriteBlocked(rental.listing_id)) {
      try {
        await this.hyggloService.sendMessage(
          rental.listing_id,
          `Booking's all confirmed! Just need your exact pickup and return times (with AM or PM please) so I can lock those in.`,
        );
      } catch (sendErr) {
        this.logger.warn(`Failed to send time request for ${rental.title}: ${sendErr.message}`);
      }
    }

    await this.prisma.follow_up_state.update({
      where: { id: followUpState.id },
      data: {
        time_request_sent: true,
        time_request_sent_at: new Date(),
      },
    });

    this.logger.log(`Proactive time request sent for ${rental.title}`);
  }

  // --- Tentative time tracking (pre-confirmation, regex-only, no AI call) ---

  private async noteTentativeTimes(msg: HyggloMessage, rental: any): Promise<void> {
    const regexResult = this.tryRegexTimeExtraction(msg.content);
    if (!regexResult || (!regexResult.pickupTime && !regexResult.returnTime)) return;

    // Store as tentative memory (lower importance than confirmed)
    const renterName = rental.renter_info || msg.sender;
    const memoryParts: string[] = [];
    if (regexResult.pickupTime) memoryParts.push(`pickup at ${regexResult.pickupTime}`);
    if (regexResult.returnTime) memoryParts.push(`return at ${regexResult.returnTime}`);

    const memoryContent = `TENTATIVE: ${renterName} mentioned ${memoryParts.join(' and ')} for ${rental.title} (not yet confirmed)`;
    await this.memoryService.storeMemory('fact', `Tentative times: ${rental.title}`, memoryContent, 5);

    // Update follow_up_state times_status to tentative (only if currently 'none')
    try {
      await this.prisma.follow_up_state.updateMany({
        where: { rental_id: rental.id, times_status: 'none' },
        data: { times_status: 'tentative' },
      });
    } catch {
      // State might not exist
    }

    this.logger.debug(`Tentative times noted for ${rental.title}: ${memoryParts.join(', ')}`);
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

    // Reject time ranges — ask renter for an exact time instead
    const detectedRange = this.detectTimeRange(content);
    if (detectedRange) {
      this.logger.log(`Time range detected ("${detectedRange}") from ${msg.sender}, asking for exact time`);
      if (!this.isWriteBlocked(msg.rentalId)) {
        try {
          await this.hyggloService.sendMessage(msg.rentalId,
            `I just need an exact time rather than a range - could you confirm a specific time? For example, 'pickup at 10am' works great.`);
        } catch {
          // Best-effort
        }
      }
      return;
    }

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

    // Availability validation: check for time conflicts before saving
    const bookings = await this.prisma.booking.findMany({
      where: { rental_id: rental.id, status: 'confirmed' },
    });

    for (const booking of bookings) {
      if (pickupTime && booking.start_date) {
        const pickupConflict = await this.calendarService.checkTimeConflict(
          booking.item_name, booking.start_date, pickupTime, 'pickup', rental.id,
        );
        if (pickupConflict.conflict) {
          this.logger.warn(`Time conflict for ${rental.title}: ${pickupConflict.reason}`);
          if (!this.isWriteBlocked(msg.rentalId)) {
            try {
              await this.hyggloService.sendMessage(msg.rentalId,
                `That pickup time won't quite work — I need a 1-hour buffer between rentals for that item. Could you try a slightly different time?`);
            } catch { /* best-effort */ }
          }
          return;
        }
      }
      if (returnTime && booking.end_date) {
        const returnConflict = await this.calendarService.checkTimeConflict(
          booking.item_name, booking.end_date, returnTime, 'return', rental.id,
        );
        if (returnConflict.conflict) {
          this.logger.warn(`Time conflict for ${rental.title}: ${returnConflict.reason}`);
          if (!this.isWriteBlocked(msg.rentalId)) {
            try {
              await this.hyggloService.sendMessage(msg.rentalId,
                `That return time won't quite work — I need a 1-hour buffer between rentals for that item. Could you try a slightly different time?`);
            } catch { /* best-effort */ }
          }
          return;
        }
      }
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

    // Update follow_up_state times_status to confirmed
    try {
      await this.prisma.follow_up_state.updateMany({
        where: { rental_id: rental.id },
        data: { times_status: 'confirmed' },
      });
    } catch { /* state might not exist */ }

    // Confirm back to renter
    if (!this.isWriteBlocked(msg.rentalId)) {
      const confirmParts: string[] = [];
      if (pickupTime) confirmParts.push(`pickup at ${pickupTime}`);
      if (returnTime) confirmParts.push(`return at ${returnTime}`);
      try {
        await this.hyggloService.sendMessage(msg.rentalId,
          `${confirmParts.join(' and ')} — locked in!`);
      } catch { /* best-effort */ }
    }

    this.logger.log(`Time confirmed for ${rental.title}: pickup=${pickupTime || 'N/A'}, return=${returnTime || 'N/A'} (confidence: ${confidence})`);
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

      // Guard: reject messages that are clearly internal AI decisions, not customer-facing text
      // Guard: reject messages that are clearly internal AI decisions, not customer-facing text
      // Broadened patterns to catch edge cases like "None - escalate to Daniel first."
      const internalPatterns = /^(none|n\/a|no message|escalate|flag|skip|defer|internal|notify|daniel|wait|hold|pending|approve|reject|block|analysis|recommend|action|review|check|confirm with daniel)/i;
      const looksInternal = internalPatterns.test(messageText.trim())
        || messageText.length < 10
        || /\b(escalate|notify daniel|flag for review|no action|no message needed)\b/i.test(messageText)
        || /^\*\*/.test(messageText.trim()); // AI analysis formatting (starts with **)
      if (looksInternal) {
        this.logger.log(`executeDecision: Skipped non-customer message: "${messageText.substring(0, 80)}"`);
        return `Analysis completed, AI recommended: "${messageText.substring(0, 100)}"`;
      }

      // READ_ONLY_MODE hard block (with per-rental exception)
      if (this.isWriteBlocked(rental.listing_id)) {
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

  /**
   * Process a message on a completed rental.
   * Used by CompletedScanService (Rule 6) for post-rental follow-up.
   */
  async processCompletedRentalMessage(rental: any, message: string, sender: string): Promise<string> {
    try {
      const rules = await this.rulesService.getFormattedRules();

      const prompt =
        `A renter sent a message on a COMPLETED rental. Draft a brief reply.\n\n` +
        `Rental: ${rental.title}\n` +
        `Renter: ${sender}\n` +
        `Their message: "${message}"\n\n` +
        `This rental is already completed. Be helpful, brief, and natural.`;

      const response = await this.aiService.processRoutine(prompt, { rules });
      return response.content;
    } catch (error) {
      this.logger.error(`processCompletedRentalMessage error: ${error.message}`);
      return '';
    }
  }

  // --- Scheduled tasks ---

  // Daily summary at 21:00
  // Daily/weekly AI summaries REMOVED — owner checks dashboard for stats

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

  // --- VISION API: Equipment Photo Analysis ---

  /**
   * Analyze equipment photos when renter uploads checkout/return photos
   * This provides automated damage detection and equipment verification
   *
   * Call this method when photos are uploaded to Hygglo
   */
  async analyzeEquipmentPhoto(
    rental: any,
    photoUrl: string,
    photoType: 'checkout' | 'return' | 'listing',
  ): Promise<void> {
    if (!this.visionService.isEnabled()) {
      this.logger.debug('Vision API not enabled, skipping photo analysis');
      return;
    }

    try {
      this.logger.log(`Analyzing ${photoType} photo for rental: ${rental.title}`);

      // Analyze the photo
      const analysis = await this.visionService.analyzeEquipmentPhoto(photoUrl, photoType);

      // Store the analysis result
      await this.prisma.ai_decision.create({
        data: {
          rental_id: rental.id,
          decision_type: 'analyze',
          input_summary: `${photoType} photo analysis for ${rental.title}`,
          output_summary: JSON.stringify({
            damage_score: analysis.damage_score,
            detected_issues: analysis.detected_issues,
            labels: analysis.labels.slice(0, 5),
            confidence: analysis.confidence,
          }),
          confidence: analysis.confidence,
          action_taken: `Photo analyzed - damage score: ${analysis.damage_score.toFixed(2)}`,
          was_sent: null, // internal analysis, not a customer message
        },
      });

      // If this is a checkout photo, store it for later comparison
      if (photoType === 'checkout') {
        await this.storeCheckoutPhotoAnalysis(rental.id, photoUrl, analysis);

        // Alert if equipment already shows damage
        if (analysis.damage_score > 0.3) {
          await this.telegramService.sendProactiveMessage(
            `⚠️ *Pre-existing Damage Detected*\n\n` +
            `├ 📦 ${rental.title}\n` +
            `├ 👤 ${rental.renter_info || 'Unknown renter'}\n` +
            `├ 🎯 Damage Score: ${(analysis.damage_score * 100).toFixed(0)}%\n` +
            `├ 🔍 Issues: ${analysis.detected_issues.join(', ') || 'General wear'}\n` +
            `└ 📸 Photo URL: ${photoUrl.substring(0, 50)}...\n\n` +
            `_Document this condition before rental starts_`,
          );
        }
      }

      // If this is a return photo, compare with checkout
      if (photoType === 'return') {
        await this.handleReturnPhotoAnalysis(rental, photoUrl, analysis);
      }

      this.logger.log(
        `Photo analysis complete: damage_score=${analysis.damage_score.toFixed(2)}, ` +
        `issues=${analysis.detected_issues.length}`,
      );
    } catch (error) {
      this.logger.error(`Vision API error: ${error.message}`);
      this.errorLogService.captureError(error, {
        operation: 'analyze_equipment_photo',
        rental_id: rental.id,
        photo_type: photoType,
        photo_url: photoUrl,
      });
    }
  }

  /**
   * Handle return photo analysis and compare with checkout
   */
  private async handleReturnPhotoAnalysis(
    rental: any,
    returnPhotoUrl: string,
    returnAnalysis: any,
  ): Promise<void> {
    try {
      // Get checkout photo analysis
      const checkoutData = await this.getCheckoutPhotoAnalysis(rental.id);

      if (!checkoutData) {
        this.logger.warn(`No checkout photo found for comparison - rental ${rental.id}`);
        return;
      }

      // Compare checkout vs return
      const comparison = await this.visionService.compareDamage(
        checkoutData.photo_url,
        returnPhotoUrl,
      );

      const damageIncrease = comparison.damage_increase;

      // Calculate damage charge based on damage increase
      let damageCharge = 0;
      let severity = 'none';

      if (damageIncrease > 0.5) {
        damageCharge = 500; // Major damage - consider replacement
        severity = 'major';
      } else if (damageIncrease > 0.25) {
        damageCharge = 150; // Significant damage - repair needed
        severity = 'significant';
      } else if (damageIncrease > 0.10) {
        damageCharge = 50; // Minor damage - cleaning/minor repair
        severity = 'minor';
      }

      // Send comprehensive damage report
      if (damageCharge > 0) {
        await this.telegramService.sendProactiveMessage(
          `🚨 *Equipment Damage Detected*\n\n` +
          `📦 *Rental*: ${rental.title}\n` +
          `👤 *Renter*: ${rental.renter_info || 'Unknown'}\n\n` +
          `📊 *Damage Analysis*:\n` +
          `├ Checkout condition: ${(comparison.checkout.damage_score * 100).toFixed(0)}%\n` +
          `├ Return condition: ${(comparison.return.damage_score * 100).toFixed(0)}%\n` +
          `├ Damage increase: ${(damageIncrease * 100).toFixed(0)}%\n` +
          `└ Severity: ${severity.toUpperCase()}\n\n` +
          `🔍 *Detected Issues*:\n` +
          `${comparison.return.detected_issues.map(issue => `├ ${issue}`).join('\n')}\n\n` +
          `💰 *Recommended Charge*: £${damageCharge}\n\n` +
          `📝 *AI Recommendation*:\n` +
          `${comparison.recommendation}`,
        );

        // Store damage record
        await this.storeDamageReport(rental.id, {
          checkout_photo: checkoutData.photo_url,
          return_photo: returnPhotoUrl,
          damage_increase: damageIncrease,
          damage_charge: damageCharge,
          severity,
          detected_issues: comparison.return.detected_issues,
          recommendation: comparison.recommendation,
        });
      } else {
        this.logger.log(`Equipment returned in good condition: ${rental.title} (damage increase: ${(damageIncrease * 100).toFixed(0)}%)`);
      }
    } catch (error) {
      this.logger.error(`Return photo comparison error: ${error.message}`);
      this.errorLogService.captureError(error, {
        operation: 'handle_return_photo',
        rental_id: rental.id,
      });
    }
  }

  /**
   * Store checkout photo analysis for later comparison
   */
  private async storeCheckoutPhotoAnalysis(
    rentalId: string,
    photoUrl: string,
    analysis: any,
  ): Promise<void> {
    await this.memoryService.storeMemory(
      'fact',
      `Checkout photo: ${rentalId}`,
      JSON.stringify({
        rental_id: rentalId,
        photo_url: photoUrl,
        damage_score: analysis.damage_score,
        detected_issues: analysis.detected_issues,
        timestamp: new Date().toISOString(),
      }),
      90, // Keep for 90 days
    );
  }

  /**
   * Retrieve checkout photo analysis
   */
  private async getCheckoutPhotoAnalysis(rentalId: string): Promise<any> {
    const memory = await this.prisma.memory.findFirst({
      where: {
        subject: `Checkout photo: ${rentalId}`,
        memory_type: 'fact',
      },
      orderBy: { created_at: 'desc' },
    });

    if (!memory) return null;

    try {
      return JSON.parse(memory.content);
    } catch {
      return null;
    }
  }

  /**
   * Store damage report in database
   */
  private async storeDamageReport(rentalId: string, damageData: any): Promise<void> {
    await this.memoryService.storeMemory(
      'fact',
      `Damage report: ${rentalId}`,
      JSON.stringify({
        rental_id: rentalId,
        ...damageData,
        timestamp: new Date().toISOString(),
      }),
      365, // Keep for 1 year for dispute resolution
    );
  }

  // --- Scam Detection ---

  /**
   * Detect scam patterns in a message with severity scoring.
   * Returns severity tier: 'confirmed_scam' (auto-block), 'likely_scam' (block + notify),
   * 'suspicious' (notify only), or null (clean).
   */
  detectScamPattern(message: string): {
    isScam: boolean;
    matchedPattern?: string;
    severity?: 'confirmed_scam' | 'likely_scam' | 'suspicious';
    score?: number;
  } {
    const text = message.toLowerCase();
    let totalScore = 0;
    const matchedPatterns: string[] = [];

    // TIER 1: Confirmed scam patterns (score 10 each — any single match = block)
    const confirmedScamPatterns: { pattern: RegExp; label: string }[] = [
      { pattern: /we\s+are\s+the\s+hygglo\s+security/i, label: 'hygglo security impersonation' },
      { pattern: /security\s+team\s+requires/i, label: 'security team impersonation' },
      { pattern: /verification\s+payment\s+required/i, label: 'verification payment scam' },
      { pattern: /platform\s+requires\s+you\s+to\s+pay/i, label: 'platform payment scam' },
      { pattern: /verify\s+identity\s+by\s+paying/i, label: 'identity verification scam' },
      { pattern: /crypto\s+payment/i, label: 'crypto payment' },
      { pattern: /gift\s+card/i, label: 'gift card scam' },
      { pattern: /wire\s+transfer/i, label: 'wire transfer' },
      { pattern: /click\s+this\s+link\s+to\s+(pay|verify)/i, label: 'suspicious payment/verification link' },
    ];

    for (const { pattern, label } of confirmedScamPatterns) {
      if (pattern.test(text)) {
        totalScore += 10;
        matchedPatterns.push(label);
      }
    }

    // TIER 2: Likely scam patterns (score 5 each — 2+ matches = block)
    const likelyScamPatterns: { pattern: RegExp; label: string }[] = [
      { pattern: /send\s+payment/i, label: 'send payment' },
      { pattern: /pay\s+via(?!\s+(hygglo|the\s+platform|the\s+app|fat\s+llama))/i, label: 'pay via (off-platform)' },
      { pattern: /transfer\s+money/i, label: 'transfer money' },
      { pattern: /bank\s+details\s+needed/i, label: 'bank details needed' },
      { pattern: /pay\s+in\s+advance/i, label: 'pay in advance' },
      { pattern: /pay\s+(me|us)\s+directly/i, label: 'pay directly' },
      { pattern: /https?:\/\/[^\s]*\b(pay|verify|secure|invoice)\b[^\s]*/i, label: 'suspicious URL' },
    ];

    for (const { pattern, label } of likelyScamPatterns) {
      if (pattern.test(text)) {
        totalScore += 5;
        matchedPatterns.push(label);
      }
    }

    // TIER 3: Suspicious behavioral patterns (score 3 each — context-dependent)
    const suspiciousPatterns: { pattern: RegExp; label: string }[] = [
      { pattern: /\b(urgent|immediately|right\s+now|act\s+fast|limited\s+time|hurry)\b/i, label: 'urgency pressure' },
      { pattern: /\b(whatsapp|telegram|signal|text\s+me|call\s+me\s+at|my\s+number)\b/i, label: 'off-platform contact' },
      { pattern: /\b(western\s+union|money\s*gram|paypal\.me|venmo|cash\s*app|zelle)\b/i, label: 'off-platform payment service' },
      { pattern: /\b(send\s+(to\s+)?my\s+(account|email|phone))\b/i, label: 'personal account request' },
      { pattern: /\b(i\s+am\s+(a\s+)?(hygglo|platform)\s+(admin|support|staff|team))\b/i, label: 'platform staff impersonation' },
    ];

    for (const { pattern, label } of suspiciousPatterns) {
      if (pattern.test(text)) {
        totalScore += 3;
        matchedPatterns.push(label);
      }
    }

    // No matches at all
    if (totalScore === 0) {
      return { isScam: false };
    }

    // Determine severity tier
    let severity: 'confirmed_scam' | 'likely_scam' | 'suspicious';
    if (totalScore >= 10) {
      severity = 'confirmed_scam';
    } else if (totalScore >= 5) {
      severity = 'likely_scam';
    } else {
      severity = 'suspicious';
    }

    // Log near-misses (suspicious but not blocked)
    if (severity === 'suspicious') {
      this.logger.log(`Scam near-miss (score ${totalScore}): patterns=[${matchedPatterns.join(', ')}], message="${message.substring(0, 100)}"`);
    }

    return {
      isScam: severity !== 'suspicious', // Only block confirmed + likely
      matchedPattern: matchedPatterns.join(', '),
      severity,
      score: totalScore,
    };
  }

  /**
   * Handle a detected scam with tiered escalation.
   * confirmed_scam: auto-block + blacklist + decline
   * likely_scam: auto-block + blacklist + decline (same as confirmed but logged differently)
   * suspicious: notify Daniel only, do NOT block (handled inline before this is called)
   */
  async handleScamDetected(
    rental: any,
    message: string,
    sender: string,
    pattern: string,
    severity: 'confirmed_scam' | 'likely_scam' | 'suspicious' = 'confirmed_scam',
    score?: number,
  ): Promise<void> {
    const writeBlocked = this.isWriteBlocked(rental.listing_id);

    // For suspicious tier: notify only, don't block or blacklist
    if (severity === 'suspicious') {
      await this.telegramService.sendProactiveMessage(
        `⚠️ *Suspicious Message (Score: ${score || '?'})*\n\n` +
        `├ 📦 Rental: ${rental.title}\n` +
        `├ 👤 Sender: ${sender}\n` +
        `├ 🔍 Patterns: ${pattern}\n` +
        `├ 💬 Message: "${message.substring(0, 200)}"\n` +
        `└ ℹ️ Not blocked - flagged for review`,
      );

      // Store for audit without blocking
      await this.prisma.ai_decision.create({
        data: {
          rental_id: rental.id,
          decision_type: 'analyze',
          input_summary: `Suspicious message (score ${score || '?'}) from ${sender}: patterns="${pattern}"`,
          output_summary: `Near-miss scam detection. Not blocked. Message: "${message.substring(0, 200)}"`,
          confidence: 0.5,
          action_taken: 'Flagged for review - not blocked',
          notified: true,
          was_sent: null, // internal flagging, not a customer message
        },
      });

      return; // Don't block or blacklist
    }

    const tierLabel = severity === 'confirmed_scam' ? 'CONFIRMED SCAM' : 'LIKELY SCAM';

    // Send terse decline
    if (!writeBlocked) {
      try {
        await this.hyggloService.sendMessage(rental.listing_id, 'This rental will not proceed.');
      } catch (sendErr) {
        this.logger.warn(`Failed to send scam decline: ${sendErr.message}`);
      }
    }

    // Notify owner via Telegram
    await this.telegramService.sendProactiveMessage(
      `🚨 *${tierLabel} (Score: ${score || '?'})*\n\n` +
      `├ 📦 Rental: ${rental.title}\n` +
      `├ 👤 Sender: ${sender}\n` +
      `├ 🔍 Patterns: ${pattern}\n` +
      `├ 💬 Message: "${message.substring(0, 200)}"\n` +
      `└ Action: Declined + auto-blacklisted`,
      'Markdown', { force: true },
    );

    // Auto-blacklist
    try {
      await this.blacklistService.addToBlacklist(
        sender,
        `${tierLabel}: ${pattern}`,
        'system:scam_detection',
      );
    } catch (blErr) {
      this.logger.warn(`Failed to auto-blacklist scammer ${sender}: ${blErr.message}`);
    }

    // Store ai_decision for audit trail
    await this.prisma.ai_decision.create({
      data: {
        rental_id: rental.id,
        decision_type: 'reject',
        input_summary: `${tierLabel} from ${sender} (score ${score || '?'}): patterns="${pattern}", message="${message.substring(0, 200)}"`,
        output_summary: `Auto-declined and blacklisted. Severity: ${severity}`,
        confidence: severity === 'confirmed_scam' ? 1.0 : 0.85,
        action_taken: writeBlocked
          ? `BLOCKED (read-only). ${tierLabel}: ${pattern}`
          : `Sent decline + auto-blacklisted. ${tierLabel}: ${pattern}`,
        notified: true,
        was_sent: !writeBlocked, // decline was sent unless in read-only mode
      },
    });

    // Track in Sentry
    this.errorLogService.captureError(new Error(`${tierLabel}: ${pattern}`), {
      operation: 'scam_detection',
      rental_id: rental.id,
      sender,
      pattern,
      severity,
      score: score?.toString(),
      message_preview: message.substring(0, 200),
    });
  }
}
