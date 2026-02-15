import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { RulesService } from '../rules/rules.service';
import { MemoryService } from '../memory/memory.service';
import { TelegramService, DecisionPromptConfig } from '../telegram/telegram.service';
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
import { checkAcquisitionOpportunity, findAcquisitionMatch } from '../data/acquisition-costs';
import { RenterProfileService } from '../renter-profile/renter-profile.service';
import { FollowUpService } from '../follow-up/follow-up.service';
import { VerificationService } from '../verification/verification.service';
import { RevenueService } from '../revenue/revenue.service';
import { MarketService } from '../market/market.service';
import { DspyService } from '../dspy/dspy.service';
import { CouponService } from '../coupon/coupon.service';
import { PlaywrightService } from '../playwright/playwright.service';

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
    private couponService: CouponService,
    private playwrightService: PlaywrightService,
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
  /**
   * Detect if renter is confirming arrival for pickup or return.
   * Sets pickup_arrival_confirmed or return_arrival_confirmed to permanently stop reminders.
   */
  private async detectArrivalConfirmation(message: string, rental: any): Promise<void> {
    const lower = message.toLowerCase().trim();

    // Match arrival-related phrases
    const arrivalPatterns = /\b(arrived|i'?m here|im here|i am here|here now|outside|at the door|downstairs|at the spot|at the location|at the pickup|at the meeting|i'?ve arrived|just arrived|just got here|waiting outside|i'?m at|we'?re here|at trafalgar|by the statue)\b/i;

    if (!arrivalPatterns.test(lower)) return;

    // Find confirmed bookings for this rental
    const bookings = await this.prisma.booking.findMany({
      where: { rental_id: rental.id, status: 'confirmed' },
    });

    if (bookings.length === 0) return;

    for (const booking of bookings) {
      // Return phase: pickup already confirmed, return not yet confirmed
      if (booking.pickup_arrival_confirmed && !booking.return_arrival_confirmed) {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { return_arrival_confirmed: true },
        });
        this.logger.log(`Return arrival confirmed via chat for ${booking.renter_name} (booking ${booking.id})`);

        await this.telegramService.sendRentalUpdate(rental.id, {
          type: 'info', priority: 'normal',
          data: { message: `✅ ${booking.renter_name} confirmed return arrival` },
        }, { rentalTitle: rental.title, renterName: booking.renter_name, account: rental.account });
      }
      // Pickup phase: not yet confirmed
      else if (!booking.pickup_arrival_confirmed) {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { pickup_arrival_confirmed: true },
        });
        this.logger.log(`Pickup arrival confirmed via chat for ${booking.renter_name} (booking ${booking.id})`);

        await this.telegramService.sendRentalUpdate(rental.id, {
          type: 'info', priority: 'critical',
          data: { message: `📍 ${booking.renter_name} has arrived for pickup — head to the meeting point!` },
        }, { rentalTitle: rental.title, renterName: booking.renter_name, account: rental.account });
      }
    }
  }

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

        // Time tracking status for AI awareness — check actual booking fields too
        const timesStatus = (followUpState as any).times_status || 'none';
        parts.push(`Times: status=${timesStatus}`);
      }
    } catch {
      // Follow-up state may not exist
    }

    // 3. Listing location (for location-aware responses + distance discount)
    if (rental.listing_location) {
      const centralLocations = ['trafalgar', 'whitehall', 'central london', 'charing cross', 'pall mall', 'national gallery', 'westminster', 'covent garden'];
      const loc = rental.listing_location.toLowerCase();
      const isCentral = centralLocations.some(c => loc.includes(c));
      if (isCentral) {
        parts.push(`LISTING_LOCATION: ${rental.listing_location} (central)`);
      } else {
        parts.push(`LISTING_LOCATION: ${rental.listing_location} (non-central — renter eligible for 10% distance discount)`);
      }
    } else {
      // FALLBACK: No listing_location extracted — the renter likely found this listing at a
      // specific location on the platform that we couldn't identify. The AI MUST still follow
      // location rules and NEVER reveal the real pickup location or say the listing location is wrong/fake.
      parts.push(`LISTING_LOCATION: Not identified (CRITICAL: The renter may have found this listing at a non-central location on the platform. If they mention ANY location name, treat it as a real branch location and follow the NON-CENTRAL location rules from your instructions — acknowledge their location by name, apologise that the item is unavailable there using a natural excuse, offer pickup from Central London near Trafalgar Square with 10% distance discount. NEVER say the location is fake, wrong, non-existent, or that you are not based there. NEVER reveal the real pickup address.)`);
    }

    // 4. Verification status + renter rating via rental_renter_link
    try {
      const renterLink = await this.prisma.rental_renter_link.findFirst({
        where: { rental_id: rental.id },
        select: { renter_profile_id: true },
      });
      if (renterLink) {
        const profile = await this.renterProfileService.getProfile(renterLink.renter_profile_id);
        if (profile) {
          parts.push(`Verification: ${profile.verification_status || 'unknown'}`);

          // Renter rating context
          const rating = (profile as any).hygglo_rating;
          const reviewCount = (profile as any).hygglo_review_count;
          if (rating !== null && rating !== undefined) {
            // Check if renter has any reviews ≤ 3 stars stored on profile
          const storedBadReviews = (profile as any).hygglo_bad_reviews;
          const hasBadReviews = storedBadReviews && JSON.parse(storedBadReviews).some((r: any) => r.stars <= 3);
          if (hasBadReviews) {
              parts.push(`\u26a0\ufe0f RENTER RATING: ${rating}/5 (${reviewCount || '?'} reviews) \u2014 This renter has review(s) of 3 stars or below. Be professional and courteous, but note that Daniel has been notified and auto-accept is blocked. Do NOT mention the rating to the renter.`);
            } else {
              parts.push(`RENTER RATING: ${rating}/5 \u2b50 (${reviewCount || '?'} reviews) \u2014 Good renter.`);
            }
          }
        }
      }
    } catch {
      // Profile may not exist
    }

    // 4. Booking times — CRITICAL enforcement
    try {
      const bookings = await this.prisma.booking.findMany({
        where: { rental_id: rental.id, status: 'confirmed' },
        select: { pickup_time: true, return_time: true, pickup_date: true, return_date: true, start_date: true, end_date: true },
        take: 1,
      });
      if (bookings.length > 0) {
        const b = bookings[0];
        const hasPickup = !!b.pickup_time;
        const hasReturn = !!b.return_time;
        // Use actual dates when available (return_date may differ from end_date)
        const pickupDate = b.pickup_date || b.start_date;
        const returnDate = b.return_date || b.end_date;
        const pickupDateStr = pickupDate ? pickupDate.toISOString().split('T')[0] : '';
        const returnDateStr = returnDate ? returnDate.toISOString().split('T')[0] : '';
        parts.push(`Pickup: ${hasPickup ? `${b.pickup_time} on ${pickupDateStr} (confirmed)` : 'NOT SET'}`);
        parts.push(`Return: ${hasReturn ? `${b.return_time} on ${returnDateStr} (confirmed)` : 'NOT SET'}`);
        if (!hasPickup || !hasReturn) {
          const missing = !hasPickup && !hasReturn ? 'pickup AND return times' : (!hasPickup ? 'pickup time' : 'return time');
          parts.push(`MANDATORY: Renter MUST provide exact ${missing} (with AM/PM) before any handover. No rental leaves without BOTH times confirmed.`);
        }
      } else {
        parts.push(`Pickup: NOT SET`);
        parts.push(`Return: NOT SET`);
        parts.push(`MANDATORY: Renter MUST provide exact pickup AND return times (with AM/PM) before any handover.`);
      }
    } catch {
      // Bookings may not exist
    }

    // 5. Booked items for THIS rental — prevents AI from treating renter's own booking as "out of stock"
    if (['upcoming', 'ongoing', 'completed'].includes(rental.status)) {
      try {
        const bookedItems = await this.prisma.booking.findMany({
          where: { rental_id: rental.id, status: { in: ['confirmed', 'pending_review'] } },
          select: { item_name: true, quantity: true, start_date: true, end_date: true, status: true },
        });
        if (bookedItems.length > 0) {
          parts.push(`\nBOOKED ITEMS FOR THIS RENTAL:`);
          for (const bi of bookedItems) {
            const startStr = bi.start_date ? bi.start_date.toISOString().split('T')[0] : '?';
            const endStr = bi.end_date ? bi.end_date.toISOString().split('T')[0] : '?';
            parts.push(`- ${bi.item_name} ×${bi.quantity || 1} (${bi.status}, ${startStr} to ${endStr})`);
          }
          parts.push(`IMPORTANT: These items are ALREADY SECURED for this renter. Do NOT tell the renter these items are "booked", "out of stock", or "unavailable" — they belong to THIS booking.`);
        }
      } catch {
        // Non-critical
      }
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
   * Check if the renter has a low Hygglo rating (< 5 stars).
   * Returns true if auto-accept should be blocked due to low rating.
   */
  private async checkRenterRatingBlock(rental: any): Promise<boolean> {
    try {
      const link = await this.prisma.rental_renter_link.findFirst({
        where: { rental_id: rental.id },
        select: { renter_profile: { select: { hygglo_rating: true } } },
      });
      if (link?.renter_profile?.hygglo_rating !== null &&
          link?.renter_profile?.hygglo_rating !== undefined &&
          link.renter_profile.hygglo_rating < 5) {
        this.logger.debug(`Auto-accept blocked: renter has ${link.renter_profile.hygglo_rating}/5 rating for ${rental.title}`);
        return true;
      }
    } catch { /* non-critical */ }
    return false;
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

    // Helper: parse hours/minutes/ampm into HH:MM
    const parseTime = (match: RegExpMatchArray): string | null => {
      let hours = parseInt(match[1]);
      const minutes = match[2] ? parseInt(match[2]) : 0;
      const ampm = match[3]?.toLowerCase();
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;
      if (hours > 23 || minutes > 59) return null;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    };

    // Match patterns like "pickup at 10am", "collect at 7pm", "pick up at 11:00"
    const pickupPattern = /(?:pickup|pick\s*up|collect|picking\s*up|collection|come\s*(?:at|by|around))\s*(?:at\s*|by\s*|around\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
    const returnPattern = /(?:return|drop\s*off|dropoff|bring\s*(?:it\s*)?back|returning|give\s*(?:it\s*)?back|back\s*(?:to\s*you\s*)?(?:at|by)|drop\s*(?:it\s*)?(?:back|off))\s*(?:at\s*|by\s*|around\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

    const pickupMatch = content.match(pickupPattern);
    if (pickupMatch) result.pickupTime = parseTime(pickupMatch) || undefined;

    const returnMatch = content.match(returnPattern);
    if (returnMatch) result.returnTime = parseTime(returnMatch) || undefined;

    // Reverse patterns: time-first, e.g. "11am pickup", "7pm return", "10:30am collection"
    if (!result.pickupTime) {
      const pickupReversePattern = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:pickup|pick\s*up|collect|collection)/i;
      const pickupRevMatch = content.match(pickupReversePattern);
      if (pickupRevMatch) result.pickupTime = parseTime(pickupRevMatch) || undefined;
    }
    if (!result.returnTime) {
      const returnReversePattern = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:return|drop\s*off|dropoff|bring\s*back)/i;
      const returnRevMatch = content.match(returnReversePattern);
      if (returnRevMatch) result.returnTime = parseTime(returnRevMatch) || undefined;
    }

    // Fallback: "I'll be there at 10am" / "see you at 7pm" — treat as pickup if no pickup yet
    if (!result.pickupTime && !result.returnTime) {
      const genericTimePattern = /(?:i'?ll\s*(?:be\s*)?(?:there|over|around)|see\s*you|coming|arrive|come\s*(?:over|by|around)?)\s*(?:at\s*|by\s*|around\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
      const genericMatch = content.match(genericTimePattern);
      if (genericMatch) result.pickupTime = parseTime(genericMatch) || undefined;
    }

    // Fallback: "morning"/"afternoon"/"evening"/"noon" with pickup/return context
    if (!result.pickupTime) {
      const pickupVague = content.match(/(?:pickup|pick\s*up|collect)\s*(?:in\s*the\s*)?(?:the\s*)?(morning|afternoon|evening|noon|midday)/i);
      if (pickupVague) {
        const word = pickupVague[1].toLowerCase();
        const timeMap: Record<string, string> = { morning: '10:00', afternoon: '14:00', evening: '19:00', noon: '12:00', midday: '12:00' };
        result.pickupTime = timeMap[word];
      }
    }
    if (!result.returnTime) {
      const returnVague = content.match(/(?:return|drop\s*off|bring\s*back)\s*(?:in\s*the\s*)?(?:the\s*)?(morning|afternoon|evening|noon|midday)/i);
      if (returnVague) {
        const word = returnVague[1].toLowerCase();
        const timeMap: Record<string, string> = { morning: '10:00', afternoon: '14:00', evening: '19:00', noon: '12:00', midday: '12:00' };
        result.returnTime = timeMap[word];
      }
    }

    // Dual time pattern: "10am and return 7pm" or "pickup 10am, drop off 7pm"
    if (!result.pickupTime && !result.returnTime) {
      const dualPattern = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:and|,|\.)\s*(?:return|drop\s*off|bring\s*(?:it\s*)?back)\s*(?:at\s*|by\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
      const dualMatch = content.match(dualPattern);
      if (dualMatch) {
        result.pickupTime = parseTime({ ...dualMatch, 1: dualMatch[1], 2: dualMatch[2], 3: dualMatch[3] } as any) || undefined;
        const returnArr = [dualMatch[0], dualMatch[4], dualMatch[5], dualMatch[6]] as unknown as RegExpMatchArray;
        result.returnTime = parseTime(returnArr) || undefined;
      }
    }

    // Date patterns: "on the 5th", "on Monday", "on 2025-01-15"
    const datePattern = /on\s+(?:the\s+)?(\d{4}-\d{2}-\d{2})/gi;
    const dateMatches = [...content.matchAll(datePattern)];
    if (dateMatches.length >= 1) result.pickupDate = dateMatches[0][1];
    if (dateMatches.length >= 2) result.returnDate = dateMatches[1][1];

    if (!result.pickupTime && !result.returnTime) return null;

    // Evaluate confidence per-time: keep any time that has explicit AM/PM, :MM, or is from vague-word mapping
    const pickupExplicit = pickupMatch && (pickupMatch[3] || pickupMatch[2]);
    const returnExplicit = returnMatch && (returnMatch[3] || returnMatch[2]);
    // Vague time words (morning/afternoon/evening) are treated as medium confidence — keep them
    const pickupFromVague = result.pickupTime && !pickupMatch;
    const returnFromVague = result.returnTime && !returnMatch;
    // Drop ONLY times that came from keyword match WITHOUT am/pm or :MM and NOT from vague mapping
    if (result.pickupTime && !pickupExplicit && !pickupFromVague) result.pickupTime = undefined;
    if (result.returnTime && !returnExplicit && !returnFromVague) result.returnTime = undefined;

    if (!result.pickupTime && !result.returnTime) return null;
    result.confidence = 'high';

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

    // Cross-path dedup: block processMessage() from running on this rental
    // while onNewRental is handling it (prevents duplicate replies in same scan cycle)
    this.activeRentalProcessing.add(rental.listing_id);

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
        await this.telegramService.sendRentalUpdate(rental.id, {
          type: 'blacklist', priority: 'critical',
          data: { matchedEntry: blacklistCheck.entry.name, reason: blacklistCheck.entry.reason },
        }, { rentalTitle: rental.title, renterName, account: rental.account });

        // Silent block — do NOT send any message to the renter. Complete radio silence.
        await this.prisma.ai_decision.create({
          data: {
            rental_id: rental.id,
            decision_type: 'reject',
            input_summary: `Blacklisted renter: ${renterName} (matched: ${blacklistCheck.entry.name})`,
            output_summary: `Silent block — no message sent. Reason on file: ${blacklistCheck.entry.reason}`,
            confidence: 1.0,
            action_taken: 'silent_block',
            notified: true,
            was_sent: false,
          },
        });

        return; // Stop processing — do not engage further
      }

      // Read chat messages ONCE — reused for scam detection, chat context, and time extraction
      let initialMessages: { sender: string; content: string; timestamp: string }[] = [];
      try {
        initialMessages = await this.hyggloService.readMessages(rental.listing_id);
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
          const renterUserId = (rental as any)._renterUserId as string | undefined;
          const profile = await this.renterProfileService.findOrCreateProfile(renterName, renterUserId);
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

      // Check renter rating — flag low-rated renters and block auto-accept
      const renterRating = (rental as any)._renterRating as number | undefined;
      const renterReviewCount = (rental as any)._renterReviewCount as number | undefined;
      const renterUserIdForReview = (rental as any)._renterUserId as string | undefined;
      let hasLowRating = false;

      if (renterRating !== undefined && renterRating !== null && renterRating < 5) {
        this.logger.log(`Renter ${renterName} has ${renterRating}/5 stars (${renterReviewCount} reviews) — checking individual reviews for ${rental.title}`);

        // Scrape individual reviews via Playwright for details
        let badReviews: { stars: number; text: string; date?: string }[] = [];
        try {
          if (renterUserIdForReview) {
            const reviewData = await this.playwrightService.scrapeRenterReviews(
              renterUserIdForReview,
              (rental.account || 'dbcinema') as 'dbcinema' | 'leo',
            );
            // Only flag reviews that are 3 stars or below — 4-star reviews are acceptable
            badReviews = (reviewData?.reviews || []).filter(r => r.stars <= 3);

            // Store bad reviews on profile
            if (renterProfileId && badReviews.length > 0) {
              await this.prisma.renter_profile.update({
                where: { id: renterProfileId },
                data: { hygglo_bad_reviews: JSON.stringify(badReviews) },
              });
            }
          }
        } catch (scrapeErr) {
          this.logger.debug(`Review scraping failed: ${scrapeErr.message}`);
        }

        // Only escalate if there are individual reviews ≤ 3 stars
        if (badReviews.length > 0) {
          hasLowRating = true;
          this.logger.warn(`BAD REVIEW RENTER DETECTED: ${renterName} has ${badReviews.length} review(s) ≤ 3 stars for ${rental.title}`);

          // Store escalation decision (blocks auto-accept via existing review_block check in follow-up.service)
          try {
            await this.prisma.ai_decision.create({
              data: {
                rental_id: rental.id,
                decision_type: 'escalate',
                input_summary: `Renter has ${badReviews.length} review(s) ≤ 3 stars (overall: ${renterRating}/5, ${renterReviewCount || 0} reviews)`,
                output_summary: `Bad reviews: ${badReviews.map(r => `${r.stars}\u2605: "${(r.text || '').substring(0, 100)}"`).join('; ')}`,
                confidence: 1.0,
                action_taken: 'review_escalation',
                notified: true,
              },
            });
          } catch (decisionErr) {
            this.logger.debug(`Failed to store review escalation decision: ${decisionErr.message}`);
          }

          // Notify Daniel via interactive decision prompt
          const badReviewText = badReviews.map(r => `  ${r.stars}\u2605: "${r.text}"`).join('\n');

          try {
            await this.telegramService.sendDecisionPrompt({
              type: 'review_flag',
              rentalId: String(rental.id),
              listingId: rental.listing_id,
              account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
              renterName: renterName || 'Unknown',
              renterLastMessage: '',
              contextSummary: `Renter ${renterName} has ${badReviews.length} review(s) ≤ 3 stars (overall: ${renterRating}/5). Rental: ${rental.title}.`,
              displayText:
                `\u26a0\ufe0f *BAD REVIEW RENTER \u2014 Authorization Required*\n\n` +
                `\u251c \ud83d\udce6 ${rental.title}\n` +
                `\u251c \ud83d\udc64 ${renterName}\n` +
                `\u251c \u2b50 ${renterRating}/5 (${renterReviewCount || '?'} reviews)\n` +
                `\u251c \ud83d\udcb0 \u00a3${rental.rental_price || '?'}\n\n` +
                `*Reviews \u2264 3 stars:*\n${badReviewText}\n\n` +
                `Auto-accept is BLOCKED for this rental.`,
              options: [
                { emoji: '\u2705', label: 'Accept anyway', intent: 'accept_low_rating', aiInstruction: 'Send a warm confirmation message to the renter. Confirm the booking and ask about their preferred pickup time.' },
                { emoji: '\u274c', label: 'Decline', intent: 'decline', aiInstruction: 'Politely decline the rental request. Apologise that the equipment is not available for the requested dates.' },
                { emoji: '\u23f8\ufe0f', label: 'Wait & monitor', intent: 'ignore', aiInstruction: '' },
              ],
              holdMessageSent: false,
            } as DecisionPromptConfig);
          } catch (notifyErr) {
            this.logger.warn(`Failed to send review flag notification: ${notifyErr.message}`);
          }
        } else {
          this.logger.log(`Renter ${renterName} has ${renterRating}/5 overall but no reviews ≤ 3 stars — no escalation needed`);
        }
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

      // Reuse already-fetched messages for chat context (no redundant API call)
      const existingChatMessages = initialMessages;
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
      // SKIP for accepted/ongoing/completed rentals — items are already booked for this renter
      const onNewRentalStatus = (rental.status || '').toLowerCase();
      const isOnNewRentalAccepted = ['upcoming', 'ongoing', 'completed'].some(s => onNewRentalStatus.includes(s));
      let onNewRentalInventoryWarning = '';
      if (!isOnNewRentalAccepted) {
        try {
          const listingCheck = validateListingAgainstInventory(rental.title);
          const listingQty = extractListingQuantity(rental.title);
          if (!listingCheck.matched) {
            const altMatch = findBestMatch(rental.title, getInventoryItemNames());
            if (altMatch) {
              onNewRentalInventoryWarning =
                `\n\nWARNING — LISTING_INVENTORY_MISMATCH: The listing "${rental.title}" does not match any item in our physical inventory. ` +
                `This is a ghost/SEO listing. Do NOT confirm this item as available. ` +
                `NEVER confirm availability of items not in the master inventory. ` +
                `Closest real item: "${altMatch}" (${MASTER_INVENTORY[altMatch]} units). Offer this as an alternative. ` +
                `IMPORTANT FRAMING: NEVER say "we don't stock this", "not in our lineup", "we don't carry this". ` +
                `Instead say this specific item is "currently unavailable" and suggest the alternative. ` +
                `NEVER invent specific reasons for unavailability (e.g., "out for another rental", "being serviced"). Just say "currently unavailable".`;
            } else {
              onNewRentalInventoryWarning =
                `\n\nCRITICAL — NO INVENTORY MATCH: The listing "${rental.title}" does not match ANY item in our inventory and we have NO alternative. ` +
                `Politely decline — say this item is "currently out of stock" or "unavailable at the moment". Apologise for the inconvenience. ` +
                `NEVER reveal we don't own, don't stock, or don't carry an item. NEVER say "not in our lineup", "we don't have this type", or similar. ` +
                `To the renter it must ALWAYS sound like a temporary stock issue, not a permanent gap in our inventory. ` +
                `NEVER invent specific reasons for unavailability (e.g., "out for another rental", "being serviced"). Just say "currently unavailable". ` +
                `Do NOT suggest unrelated equipment. Do NOT reference previous rentals as alternatives.`;
            }
          } else if (listingQty > listingCheck.maxQuantity) {
            onNewRentalInventoryWarning =
              `\n\nWARNING — LISTING_INVENTORY_MISMATCH: The listing title says "${listingQty}x" but we only have ${listingCheck.maxQuantity} unit(s) of "${listingCheck.inventoryItem}". ` +
              `State that we have ${listingCheck.maxQuantity} available. NEVER offer to source, procure, or find additional units — our inventory is fixed.`;
          }
        } catch {
          // Non-critical
        }
      }

      // First-time renter check for onNewRental (proactive discount on high-value)
      let onNewRentalFirstTimeCtx = '';
      try {
        if (renterUserIdForReview && (renterReviewCount === undefined || renterReviewCount === null || renterReviewCount === 0)) {
          const ftCheck = await this.playwrightService.checkFirstTimeRenter(
            renterUserIdForReview,
            (rental.account || 'dbcinema') as 'dbcinema' | 'leo',
          );

          if (ftCheck.isFirstTime) {
            // Cache the result
            await this.prisma.ai_decision.create({
              data: {
                rental_id: rental.id,
                decision_type: 'first_time_renter_verified',
                input_summary: `First-time renter check for ${rental.renter_info || 'Unknown'} (userId: ${renterUserIdForReview})`,
                output_summary: `isFirstTime: true, reviewCount: ${ftCheck.reviewCount}`,
                confidence: 1.0,
                action_taken: 'Verified first-time renter on Hygglo',
                notified: false,
              },
            });

            const earningsEstimate = rental.rental_price || 0;
            if (earningsEstimate >= 200) {
              onNewRentalFirstTimeCtx =
                `\n\n--- FIRST-TIME RENTER (PROACTIVE DISCOUNT) ---\n` +
                `This renter has NEVER rented on the platform before (0 reviews, profile confirmed). ` +
                `Owner earnings: £${Math.round(earningsEstimate)} (above £200). ` +
                `PROACTIVELY offer them a £15 first-time discount in your welcome message. ` +
                `Work it in naturally. Add <memory>FIRST_TIME_DISCOUNT_ACCEPTED</memory> in your response.\n`;
            } else if (earningsEstimate >= 120) {
              onNewRentalFirstTimeCtx =
                `\n\n--- FIRST-TIME RENTER ---\n` +
                `This renter is new to the platform (0 reviews, profile confirmed). ` +
                `If they ask about first-time discounts or vouchers, offer to manually apply £15 off.\n`;
            }

            this.logger.log(`FIRST-TIME RENTER confirmed in onNewRental: ${rental.renter_info} for ${rental.title} (earnings: £${earningsEstimate})`);
          }
        }
      } catch (ftErr) {
        this.logger.debug(`First-time renter check failed in onNewRental: ${ftErr.message}`);
      }

      const rentalContext =
        `New rental detected:\n` +
        `Title: ${rental.title}\n` +
        `Status: ${rental.status}\n` +
        `Renter: ${rental.renter_info || 'Unknown'}\n` +
        (renterRating !== undefined ? `Renter Rating: ${renterRating}/5 (${renterReviewCount || '?'} reviews)${hasLowRating ? ' \u26a0\ufe0f LOW' : ''}\n` : '') +
        `URL: ${rental.listing_url}\n` +
        `Description: ${(rental.description || '').substring(0, 500)}\n` +
        `Photos: ${(rental.photos_urls || []).length} photos` +
        onNewRentalInventoryWarning +
        chatContext +
        (renterProfileContext ? `\n\n${renterProfileContext}` : '') +
        (rentalStageCtx ? `\n\n${rentalStageCtx}` : '') +
        multiItemContextStr +
        onNewRentalFirstTimeCtx;

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

      // 5. Extract agreed pickup/return times — ONLY for confirmed/accepted rentals
      //    Pending rentals don't need times yet; times are requested via follow-up after confirmation
      let extractedTimes: { pickupTime?: string; returnTime?: string; pickupDate?: string; returnDate?: string } | null = null;
      const rentalStatus = (rental.status || '').toLowerCase();
      const isConfirmedRental = ['upcoming', 'ongoing', 'completed', 'confirmed'].some(s => rentalStatus.includes(s));
      if (isConfirmedRental) {
        try {
          extractedTimes = await this.extractTimesFromChatHistory(rental, initialMessages);
        } catch (timeErr) {
          this.logger.warn(`Chat time extraction failed for ${rental.title}: ${timeErr.message}`);
        }
      } else {
        this.logger.debug(`Skipping time extraction for ${rental.title} — rental status: ${rental.status} (not yet confirmed)`);
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

        // 7b. Check for first-time discount acceptance flag
        if (response.memories.some(m => m.toUpperCase().includes('FIRST_TIME_DISCOUNT_ACCEPTED'))) {
          const rentalPrice = rental.rental_price || 0;
          if (rentalPrice >= 120) {
            const RENTER_DISCOUNT = 15; // £15 off renter price
            const PLATFORM_RETENTION = 0.64; // owner keeps ~64% of renter price
            const ownerReduction = Math.round(RENTER_DISCOUNT * PLATFORM_RETENTION * 100) / 100;
            const discountPercentage = Math.round((ownerReduction / rentalPrice) * 10000) / 100;

            // Check not already flagged
            const alreadyFlagged = await this.prisma.ai_decision.findFirst({
              where: { rental_id: rental.id, decision_type: 'first_time_discount' },
            });

            if (!alreadyFlagged) {
              await this.prisma.ai_decision.create({
                data: {
                  rental_id: rental.id,
                  decision_type: 'first_time_discount',
                  input_summary: `first_time_discount_flagged: £${RENTER_DISCOUNT} off renter price (£${ownerReduction} off earnings, ${discountPercentage}% of £${rentalPrice})`,
                  output_summary: `First-time rental discount accepted by renter. Flagged for application at auto-accept.`,
                  confidence: 1.0,
                  action_taken: `First-time discount flagged. Renter saves £${RENTER_DISCOUNT}. Owner earnings reduce by £${ownerReduction}.`,
                  notified: true,
                },
              });

              await this.followUpService.updateAcceptanceReadiness(rental.id, {
                discount_eligible: true,
              });

              this.logger.log(`First-time discount flagged for ${rental.title}: £${ownerReduction} off earnings (${discountPercentage}% of £${rentalPrice})`);
            }
          }
        }
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

        // Check renter rating block for auto-accept
        const renterHasLowRating = await this.checkRenterRatingBlock(rental);

        // Determine auto-accept eligibility:
        // items confirmed + availability verified + NOT same-day + NOT low-rated renter
        const autoAcceptEligible = itemsConfirmed && availabilityVerified && !sameDayBlocksAutoAccept && !renterHasLowRating;

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
            // High-value same-day: block auto-accept, interactive decision
            const recommendedReply = await this.generateRecommendedReply(
              rental, rental.renter_info || 'Unknown', '',
              `A new same-day rental has been received for ${extractedItemNames.length > 0 ? extractedItemNames.join(', ') : rental.title}. Draft a warm booking confirmation message. Confirm the booking, mention the items, and ask for their preferred pickup time today.`,
            );
            await this.telegramService.sendDecisionPrompt({
              type: 'same_day',
              rentalId: String(rental.id),
              listingId: rental.listing_id,
              account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
              renterName: rental.renter_info || 'Unknown',
              renterLastMessage: '',
              contextSummary: `Same-day rental £${rentalValue} for ${rental.title} by ${rental.renter_info || 'Unknown'}. ${extractedItemNames.length > 0 ? 'Items: ' + extractedItemNames.join(', ') : ''}. Available: ${availabilityVerified ? 'Yes' : 'Not verified'}.`,
              displayText:
                `\u23f0 *SAME-DAY RENTAL — Approval Required*\n\n` +
                `\u251c \ud83d\udce6 ${rental.title}\n` +
                `\u251c \ud83d\udc64 ${rental.renter_info || 'Unknown'}\n` +
                `\u251c \ud83d\udcc5 ${startDate} to ${endDate}\n` +
                `\u251c \ud83c\udfaf Items: ${extractedItemNames.length > 0 ? extractedItemNames.join(', ') : 'Pending extraction'}\n` +
                `\u251c \u2705 Available: ${availabilityVerified ? 'Yes' : 'Not yet verified'}\n` +
                `\u2514 \ud83d\udcb0 Price: \u00a3${rentalValue}`,
              options: [
                { label: 'Approve', emoji: '\u2705', intent: 'approve', aiInstruction: 'Daniel approves this same-day rental. Draft a warm confirmation message to the renter letting them know the booking is confirmed and asking for their preferred pickup time.' },
                { label: 'Decline', emoji: '\u274c', intent: 'decline', aiInstruction: 'Daniel declines this same-day rental. Draft a polite, apologetic message explaining that unfortunately this item is not available for same-day pickup today. Wish them well.' },
              ],
              holdMessageSent: false,
              recommendedReply: recommendedReply || undefined,
            });

            this.logger.log(`Same-day rental (£${rentalValue}) for ${rental.title} — auto-accept blocked, decision prompt sent`);
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

      await this.telegramService.sendRentalUpdate(rental.id, {
        type: 'pipeline_error', priority: 'high',
        data: { error: error.message },
      }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
    } finally {
      // Release cross-path dedup lock so subsequent messages can be processed
      this.activeRentalProcessing.delete(rental.listing_id);
    }
  }

  // --- Handle new messages from Hygglo ---

  /**
   * Generate a pre-drafted recommended reply for decision prompts.
   * Allows Daniel to send with one click instead of waiting for AI polishing.
   */
  private async generateRecommendedReply(
    rental: any,
    renterName: string,
    renterMessage: string,
    instruction: string,
  ): Promise<string> {
    try {
      const account = rental.account || 'dbcinema';
      const persona = account === 'leo' ? 'Leo Adams' : 'DB Cinema Rentals';
      const response = await this.aiService.processRoutine(
        `You represent ${persona}. ${instruction}\n\nRenter: ${renterName}\n${renterMessage ? `Renter's message: "${renterMessage.substring(0, 200)}"` : ''}\nRental: ${rental.title}\n\nWrite ONLY the message to send. No preamble. 2-3 sentences max.`,
        { maxTokens: 200 },
      );
      let text = response.content.trim();
      text = text.replace(/^(here'?s?\s+(the|a|my)\s+(message|response|reply)[:\s]*)/i, '').trim();
      return text;
    } catch (err) {
      this.logger.warn(`Failed to generate recommended reply: ${err.message}`);
      return '';
    }
  }

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
   * Extract item-like phrases from a message that DON'T match any inventory item.
   * Used for acquisition opportunity detection.
   */
  private extractNonInventoryItems(text: string): string[] {
    const inventoryNames = getInventoryItemNames();
    const nonInventory: string[] = [];

    // Look for equipment-like patterns: brand + model, or known equipment categories
    const equipmentPatterns = [
      /\b(sony|canon|nikon|fuji(?:film)?|panasonic|blackmagic|red|dji|aputure|nanlite|godox|rode|sennheiser|zoom|sigma|tamron|arri|smallhd|atomos|hollyland|tilta|easyrig|laowa|zeiss|cooke|manfrotto|sachtler)\s+[\w\d\s\-\.]+/gi,
      /\b[A-Z][A-Za-z]*\s+(?:[\w\d]+[-/][\w\d]+|[A-Z]\d{1,4}[A-Za-z]*|(?:Mark|MK)\s*\w+)\b/g,
      /\b(?:fx\d+|a7[rs]?\s*(?:iii|iv|v|[2-9])|r[356]\s*(?:ii)?|c\d{2,3}|gh\d|z\d|x-?[ht]\d|bmpcc\s*\d+k)\b/gi,
    ];

    const candidates = new Set<string>();
    for (const pattern of equipmentPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        for (const m of matches) {
          const cleaned = m.trim().replace(/[.,!?]+$/, '');
          if (cleaned.length >= 4) candidates.add(cleaned);
        }
      }
    }

    for (const candidate of candidates) {
      // Check if it matches something in inventory
      const match = findBestMatch(candidate, inventoryNames);
      if (!match) {
        // Doesn't match inventory — potential acquisition opportunity
        nonInventory.push(candidate);
      }
    }

    return nonInventory;
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

        // Blacklist check on every message — silent block, no reply to renter
        const blacklistCheck = await this.blacklistService.isBlacklistedByRental(rental.id);
        if (blacklistCheck.blacklisted) {
          // Do NOT send any message to the renter. Complete radio silence.
          await this.telegramService.sendRentalUpdate(rental.id, {
            type: 'blacklist', priority: 'critical',
            data: { matchedEntry: blacklistCheck.entry.name, message: msg.content },
          }, { rentalTitle: rental.title, renterName: msg.sender, account: rental.account });

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

        // Cancel/Reschedule detection — interactive decision to Daniel, skip AI response
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

          // Interactive decision prompt
          const isCancel = cancelReschedule === 'cancel';
          const recommendedReply = await this.generateRecommendedReply(
            rental, msg.sender || rental.renter_info || 'Unknown', msg.content,
            isCancel
              ? 'The renter wants to cancel their booking. Draft a friendly message allowing the cancellation, being understanding, and wishing them well. Mention they can book again anytime.'
              : 'The renter wants to reschedule their booking. Draft a friendly message allowing the reschedule and asking for their preferred new dates.',
          );
          await this.telegramService.sendDecisionPrompt({
            type: 'cancel_reschedule',
            rentalId: String(rental.id),
            listingId: msg.rentalId,
            account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
            renterName: msg.sender || rental.renter_info || 'Unknown',
            renterLastMessage: msg.content,
            contextSummary: `${label} request from ${msg.sender} on ${rental.title}: "${msg.content.substring(0, 200)}"`,
            displayText:
              `\ud83d\udea8 *${label} REQUEST*\n\n` +
              `\u251c \ud83d\udce6 ${rental.title}\n` +
              `\u251c \ud83d\udc64 ${msg.sender}\n` +
              `\u2514 \ud83d\udcac "${msg.content.substring(0, 200)}"`,
            options: isCancel
              ? [
                  { label: 'Allow cancellation', emoji: '\u2705', intent: 'approve', aiInstruction: 'Daniel allows the cancellation. Draft a friendly message acknowledging their cancellation request. Be understanding and wish them well. Mention they are welcome to book again anytime.' },
                  { label: 'Decline', emoji: '\u274c', intent: 'decline', aiInstruction: 'Daniel declines the cancellation. Draft a polite but firm message explaining the booking cannot be cancelled at this stage. Reference the platform terms if relevant. Offer to help with any concerns.' },
                ]
              : [
                  { label: 'Allow reschedule', emoji: '\u2705', intent: 'approve', aiInstruction: 'Daniel allows the reschedule. Draft a friendly message confirming they can change their dates. Ask what new dates work for them.' },
                  { label: 'Decline', emoji: '\u274c', intent: 'decline', aiInstruction: 'Daniel declines the reschedule. Draft a polite message explaining the dates cannot be changed. Offer to help with the current booking.' },
                ],
            holdMessageSent: true,
            recommendedReply: recommendedReply || undefined,
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

        // Retrieve conversation history — 8 recent messages + facts summary from older ones
        const conversationHistory = await this.memoryService.getConversationHistory(chatId, 8);

        // Build conversation summary if missing (use cache if available — avoids redundant Haiku call per message)
        try {
          await this.memoryService.buildConversationSummary(rental.id, chatId, false);
        } catch {
          // Non-critical — cached summary will be used as fallback
        }

        // Refresh renter rating if stale (> 24h old)
        try {
          const renterLink = await this.prisma.rental_renter_link.findFirst({
            where: { rental_id: rental.id },
            select: {
              renter_profile: {
                select: { id: true, hygglo_rating: true, rating_checked_at: true, hygglo_user_id: true },
              },
            },
          });
          if (renterLink?.renter_profile) {
            const rp = renterLink.renter_profile;
            const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours
            const isStale = !rp.rating_checked_at || (Date.now() - new Date(rp.rating_checked_at).getTime() > staleThreshold);
            if (isStale && rp.hygglo_user_id) {
              // Re-fetch rating from current rental's _detail (refreshed each scan cycle)
              // The scanner already updates rating on new rentals — this handles ongoing conversations
              const freshRental = await this.prisma.rental.findFirst({
                where: { id: rental.id },
                select: { listing_id: true, account: true },
              });
              if (freshRental) {
                try {
                  const detail = await this.hyggloService.getOrderDetailPublic(freshRental.listing_id, (freshRental.account || 'dbcinema') as any);
                  const freshRating = detail?.users?.otherPart?.rating?.value;
                  const freshReviewCount = detail?.users?.otherPart?.rating?.count
                    ?? detail?.users?.otherPart?.customerCompletedOrders;
                  if (freshRating !== undefined && freshRating !== null) {
                    await this.prisma.renter_profile.update({
                      where: { id: rp.id },
                      data: {
                        hygglo_rating: freshRating,
                        hygglo_review_count: freshReviewCount || 0,
                        rating_checked_at: new Date(),
                      },
                    });
                  }
                } catch {
                  // Non-critical — keep existing rating
                }
              }
            }
          }
        } catch {
          // Non-critical — rating refresh failed
        }

        // CONTEXT OPTIMIZATION: Determine context level needed
        const contextLevel = this.determineContextLevel(msg.content);

        // MINIMAL CONTEXT: For simple acks ("hi", "thanks", "ok"), skip heavy context loading
        if (contextLevel === 'minimal' && conversationHistory.length >= 2) {
          this.logger.debug(`Minimal context for simple message: "${msg.content.substring(0, 50)}"`);
        }

        // Extract meaningful keywords from the message
        const keywords = this.extractSearchKeywords(msg.content, [msg.sender, rental.title]);

        // Detect items mentioned in the message for compatibility/bundle context
        const mentionedItems = this.extractMentionedItems(msg.content);

        // Extract non-inventory items from message (used for acquisition + message-level mismatch)
        let nonInventoryItems: string[] = [];
        try {
          nonInventoryItems = this.extractNonInventoryItems(msg.content);
        } catch (extractErr) {
          this.logger.debug(`Non-inventory extraction failed: ${extractErr.message}`);
        }

        // ACQUISITION OPPORTUNITY: Check if renter asks for items NOT in inventory but worth buying
        try {
          if (nonInventoryItems.length > 0) {
            // Hygglo dates are INCLUSIVE: days = diff + 1
            const rentalDays = (rental.start_date && rental.end_date)
              ? Math.max(1, Math.round((new Date(rental.end_date).getTime() - new Date(rental.start_date).getTime()) / (1000 * 60 * 60 * 24)) + 1)
              : 1;

            for (const rawItem of nonInventoryItems) {
              const opportunity = checkAcquisitionOpportunity(rawItem, rentalDays);
              if (opportunity) {
                // Send "let me check" to renter
                const holdMessage = `Let me just check on the ${opportunity.item.name} for you — give me a moment and I'll get back to you shortly!`;
                try {
                  if (!this.isWriteBlocked(rental.id)) {
                    await this.hyggloService.sendMessage(msg.rentalId, holdMessage);
                    await this.memoryService.storeConversation(chatId, 'assistant', holdMessage, { model: 'system' });
                  }
                } catch (holdErr) {
                  this.logger.debug(`Hold message send failed: ${holdErr.message}`);
                }

                // Generate recommended reply for acquisition approval
                const acqRecommendedReply = await this.generateRecommendedReply(
                  rental, rental.renter_info || msg.sender || 'Unknown', msg.content,
                  `The renter asked about ${opportunity.item.name}. Great news — the item is available for their dates! Draft an enthusiastic message confirming the ${opportunity.item.name} is available and the booking is confirmed. Ask for their preferred pickup time.`,
                );

                // Interactive decision prompt for Daniel
                await this.telegramService.sendDecisionPrompt({
                  type: 'acquisition',
                  rentalId: String(rental.id),
                  listingId: msg.rentalId,
                  account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
                  renterName: rental.renter_info || msg.sender || 'Unknown',
                  renterLastMessage: msg.content,
                  contextSummary: `Acquisition opportunity: ${opportunity.item.name}. Renter: ${msg.sender}. ${rentalDays} days. Est. value \u00a3${opportunity.estimatedRentalValue}, cost ~\u00a3${opportunity.acquisitionCost} (${opportunity.roiPercent}% ROI).`,
                  displayText:
                    `\ud83d\udea8 *ACQUISITION OPPORTUNITY*\n\n` +
                    `\u251c \ud83d\udce6 Renter wants: *${opportunity.item.name}*\n` +
                    `\u251c \ud83d\udc64 ${rental.renter_info || msg.sender || 'Unknown'}\n` +
                    `\u251c \ud83d\udcc5 ${rentalDays} day${rentalDays > 1 ? 's' : ''}\n` +
                    `\u251c \ud83d\udcb0 Est. rental value: *\u00a3${opportunity.estimatedRentalValue}*\n` +
                    `\u251c \ud83c\udff7\ufe0f Acquisition cost: ~\u00a3${opportunity.acquisitionCost}\n` +
                    `\u251c \ud83d\udcca ROI this rental: *${opportunity.roiPercent}%* of purchase price\n` +
                    `\u2514 \ud83d\udcac Renter told: "Let me check on that"`,
                  options: [
                    { label: 'Buy & confirm', emoji: '\u2705', intent: 'approve', aiInstruction: `Daniel wants to buy the ${opportunity.item.name} and confirm the rental. Draft an enthusiastic message telling the renter great news — the item is available and the booking is confirmed. Ask for their preferred pickup time.` },
                    { label: 'Decline politely', emoji: '\u274c', intent: 'decline', aiInstruction: `Daniel declines to acquire the ${opportunity.item.name}. Draft a polite, apologetic message explaining that unfortunately this particular item isn't available at the moment. Suggest similar alternatives from the inventory if relevant.` },
                  ],
                  holdMessageSent: true,
                  recommendedReply: acqRecommendedReply || undefined,
                });

                this.logger.log(`ACQUISITION OPPORTUNITY: ${opportunity.item.name} — ${opportunity.roiPercent}% ROI (\u00a3${opportunity.estimatedRentalValue} of \u00a3${opportunity.acquisitionCost})`);

                return; // Skip normal AI response — Daniel will decide
              }
            }
          }
        } catch (acqErr) {
          this.logger.debug(`Acquisition opportunity check failed: ${acqErr.message}`);
        }

        // Always load business rules (no context-level gating)
        const rules = await this.rulesService.getFormattedRules();

        // Detect pricing and delivery intent
        const hasPricingIntent = await this.isPricingQuery(msg.content);
        const hasDeliveryIntent = await this.isDeliveryQuery(msg.content);

        // TOKEN-OPTIMIZED: Only load filtered pricing catalog on pricing intent (mentioned items + bundles + alternatives)
        const deliveryKeywords = hasDeliveryIntent ? ['Delivery Pricing Zones', 'Delivery Courier Framework', 'Delivery Rules', 'Delivery Mandatory', 'Fake Location Handling'] : [];
        const [pricingCatalog, pricingMem, keywordMem, deliveryMem] = await Promise.all([
          (hasPricingIntent || mentionedItems.length > 0) ? Promise.resolve(formatFilteredPricingForAI(mentionedItems)) : Promise.resolve(''),
          this.memoryService.getPricingMemories(),
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
          const todaySchedule = await this.calendarService.getFormattedSchedule(new Date());
          if (todaySchedule) {
            scheduleContext = `\n--- TODAY'S SCHEDULE ---\n${todaySchedule}`;
          }
          // Also load schedule for rental start date (if different from today)
          if (rental.start_date) {
            const startDate = new Date(rental.start_date);
            const today = new Date();
            if (startDate.toDateString() !== today.toDateString() && startDate > today) {
              const startSchedule = await this.calendarService.getFormattedSchedule(startDate);
              if (startSchedule) {
                const dateStr = startDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
                scheduleContext += `\n--- SCHEDULE FOR ${dateStr.toUpperCase()} (RENTAL START) ---\n${startSchedule}`;
              }
            }
          }
          if (scheduleContext) {
            scheduleContext += `\nUse this to suggest available pickup/return slots accurately.`;
          }
        } catch (e) {
          this.logger.warn(`Schedule load failed: ${e.message}`);
        }

        // Load owner unavailability / vacation context for the rental's date range
        let vacationContext = '';
        try {
          if (rental.start_date && rental.end_date) {
            const vacCheck = await this.calendarService.isOwnerUnavailable(
              new Date(rental.start_date),
              new Date(rental.end_date),
            );
            if (vacCheck.unavailable && vacCheck.blocks.length > 0) {
              const blockLines = vacCheck.blocks.map((b: any) => {
                const dayStr = b.start_time.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
                if (b.all_day) return `${dayStr}: ALL DAY${b.reason ? ` (${b.reason})` : ''}`;
                const startStr = `${String(b.start_time.getHours()).padStart(2, '0')}:${String(b.start_time.getMinutes()).padStart(2, '0')}`;
                const endStr = b.end_time
                  ? `${String(b.end_time.getHours()).padStart(2, '0')}:${String(b.end_time.getMinutes()).padStart(2, '0')}`
                  : 'onwards';
                return `${dayStr} from ${startStr} ${endStr === 'onwards' ? 'onwards' : `to ${endStr}`}${b.reason ? ` (${b.reason})` : ''}`;
              });
              vacationContext = `\n--- OWNER UNAVAILABILITY (affects pickup/return scheduling) ---\nOwner CANNOT do pickups/returns during:\n${blockLines.join('\n')}\nPROACTIVELY suggest times OUTSIDE these blocks.`;
            }
          }
        } catch (vacErr) {
          this.logger.debug(`Vacation context load failed: ${vacErr.message}`);
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

        let couponContext = '';
        try {
          couponContext = await this.couponService.buildAICouponContext();
        } catch (cpErr) {
          this.logger.debug(`Coupon context load failed: ${cpErr.message}`);
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
            `Items are listed at DIFFERENT locations. If the renter asks why pickup is not at the advertised location, reference their SPECIFIC location by name (from LISTING_LOCATION) and use a varied excuse naturally: ` +
            `"out of stock at that branch", "out on a rental there", "pulled in for a service", "in for maintenance at our central hub", "consolidating pickups at Trafalgar Square today", "stock all rented out there". ` +
            `Be apologetic and offer central branch + 10% distance discount + delivery as alternatives. NEVER reveal all items are at the same place.\n`
          : '';

        // CONVERSATION TREE: Get stage-specific guidance (single DB call, reuse state)
        const convState = await this.conversationStageService.getConversationState(rental.id);
        const currentStage = convState?.currentStage || 'inquiry';
        const stageGuidance = convState
          ? this.conversationStageService.getStagePromptFromState(convState)
          : '';

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

        // WELCOME-BACK CONTEXT: Detect recently-revived DEAD conversations
        let welcomeBackContext = '';
        try {
          const fState = await this.prisma.follow_up_state.findUnique({
            where: { rental_id: rental.id },
            select: { stage_before_dead: true, stage_changed_at: true },
          });
          if (fState?.stage_before_dead && fState.stage_changed_at) {
            const hoursSinceRevival = (Date.now() - new Date(fState.stage_changed_at).getTime()) / (1000 * 60 * 60);
            // Only show welcome-back context within first 2 hours of revival
            if (hoursSinceRevival < 2) {
              welcomeBackContext = `\n--- RETURNING RENTER ---\nThis renter previously went quiet but has come back. Welcome them warmly — don't reference the gap or sound disappointed. Pick up where you left off. They already know the item and pricing, so skip re-introductions and get straight to helping them.`;
            }
          }
        } catch {
          // Non-critical
        }

        if (currentProfileId && this.conversationStageService.isActionAllowed(currentStage, 'verification_guidance')) {
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
          ? 'You are replying AS Leo from Leo Adams gear rental. Use "I" and "my" naturally (e.g., "I\'ve got the FX3 available"). Be warm, personable, slightly chill. But remember: you represent Leo — you cannot make business decisions (pricing, discounts, freebies) without checking with the actual owner first.'
          : 'You are replying AS Daniel from DB Cinema Rentals. Professional, concise, human tone. But remember: you represent Daniel — you cannot make business decisions (pricing, discounts, freebies) on his behalf. When in doubt, escalate.';
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
        // SKIP for accepted/ongoing/completed rentals — the renter's booked items ARE their items
        const rentalStatusLower = (rental.status || '').toLowerCase();
        const isAcceptedRental = ['upcoming', 'ongoing', 'completed'].some(s => rentalStatusLower.includes(s));
        let listingInventoryContext = '';
        try {
          if (isAcceptedRental) {
            // Don't warn about listing mismatch — booked items context (buildRentalStageContext) handles this
            this.logger.debug(`Skipping LISTING_INVENTORY_MISMATCH for accepted rental ${rental.id} (status: ${rental.status})`);
          }
          const listingValidation = !isAcceptedRental ? validateListingAgainstInventory(rental.title) : { matched: true, inventoryItem: '', maxQuantity: 0 };
          const listingQty = !isAcceptedRental ? extractListingQuantity(rental.title) : 0;

          if (!listingValidation.matched) {
            // Ghost / SEO listing — item does NOT exist in our physical inventory
            const altMatch = findBestMatch(rental.title, getInventoryItemNames());
            if (altMatch) {
              listingInventoryContext =
                `\n--- LISTING_INVENTORY_MISMATCH ---\n` +
                `WARNING: This listing item is NOT in our physical inventory. The listing title "${rental.title}" does not match any item we actually own.\n` +
                `You MUST NOT confirm this item as available.\n` +
                `NEVER confirm availability of items not in the master inventory.\n` +
                `Closest alternative we DO have in stock: "${altMatch}" (${MASTER_INVENTORY[altMatch]} unit(s)). Offer this instead.\n` +
                `Do NOT suggest items from the renter's previous rental history unless they are in our MASTER INVENTORY.\n` +
                `IMPORTANT FRAMING: NEVER tell the renter "we don't stock this", "not in our lineup", "we don't carry this". ` +
                `Say this specific item is "currently unavailable" and suggest the alternative.\n` +
                `NEVER invent specific reasons for unavailability (e.g., "out for another rental", "being serviced", "hasn't come back yet"). Just say "currently unavailable".\n`;
            } else {
              // No alternative at all
              listingInventoryContext =
                `\n--- LISTING_INVENTORY_MISMATCH (NO ALTERNATIVE) ---\n` +
                `CRITICAL: This listing item "${rental.title}" is currently unavailable and we have NO similar alternative.\n` +
                `You MUST politely decline: apologise, say this item is "currently out of stock" or "unavailable at the moment".\n` +
                `NEVER reveal we don't own, don't stock, or don't carry an item. NEVER say "not in our lineup", "we don't have this type", etc.\n` +
                `To the renter it must ALWAYS sound like a TEMPORARY stock issue, not a permanent gap.\n` +
                `Do NOT suggest cameras, lights, mics, or any unrelated equipment as a "substitute".\n` +
                `Do NOT reference previous rentals or suggest items the renter has rented before — those may also be ghost listings.\n` +
                `NEVER fabricate availability for items not in inventory.\n` +
                `NEVER invent specific reasons for unavailability (e.g., "out for another rental", "being serviced", "hasn't come back yet"). Just say "currently unavailable".\n`;
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

        // MESSAGE-LEVEL MISMATCH: Warn AI about specific items mentioned in message that aren't in inventory
        let messageMismatchContext = '';
        if (nonInventoryItems.length > 0) {
          const mismatchLines: string[] = [];
          const inventoryNames = getInventoryItemNames();
          for (const item of nonInventoryItems) {
            const closest = findBestMatch(item, inventoryNames);
            if (closest) {
              mismatchLines.push(`- "${item}" is NOT in our inventory. Closest alternative: "${closest}"`);
            } else {
              mismatchLines.push(`- "${item}" is NOT in our inventory. No close alternative available.`);
            }
          }
          if (mismatchLines.length > 0) {
            messageMismatchContext =
              `\n--- MESSAGE ITEM MISMATCH ---\n` +
              `The renter mentioned items NOT in our physical inventory:\n` +
              mismatchLines.join('\n') + '\n' +
              `Do NOT confirm availability of these specific items. Suggest the alternative if one exists, or say it is "currently unavailable". Frame as a temporary stock issue, NEVER as a permanent gap in our lineup.\n` +
              `NEVER invent specific reasons for unavailability (e.g., "out for another rental", "being serviced", "hasn't come back yet"). Just say "currently unavailable".\n`;
          }
        }

        const messagePrompt =
          `A renter sent a message on the ${businessName} account. Draft a reply.\n\n` +
          `${persona}\n\n` +
          `Renter: ${msg.sender}\n` +
          `Their message: "${msg.content}"\n` +
          `Rental: ${rental.title}\n\n` +
          `${listingInventoryContext}` +
          `${messageMismatchContext}` +
          `${pricingInstruction}` +
          `${deliveryInstruction}` +
          `${deliveryRecalc}` +
          `${['booking_sent', 'awaiting_verification', 'confirmed', 'dead'].includes(currentStage) ? '' : upsellContext}` +
          `${stageGuidance}` +
          (renterProfileContext ? `\n${renterProfileContext}\n` : '') +
          (rentalStageContext ? `\n${rentalStageContext}\n` : '') +
          `${discountContext}` +
          `${sameDayInstruction}` +
          // --- OPERATIONAL CONTEXT (minimal, message-specific) ---
          `\nVOICE: ${accountName === 'leo' ? 'Use "I" and "my" — you\'re Leo, an individual.' : 'Use "our" and "the gear" — you represent the business.'}\n` +
          // Only include inventory list when renter is asking about items or in early stages
          `${listingInventoryContext || messageMismatchContext || hasPricingIntent || ['inquiry', 'interest', 'qualified'].includes(currentStage) ? `INVENTORY: ${getInventoryItemNames().join(', ')}.\n` : ''}` +
          `${['inquiry', 'interest'].includes(currentStage) ? 'If renter hasn\'t said what the shoot is for, ask casually.\n' : ''}` +
          `RETURN CLOSURE RULE: If the renter asks you to mark the rental as returned or close/end it, explain that the equipment is still being inspected and you usually aim to close open rentals within 24–72 hours after return, though in edge cases it might take a bit longer. Do NOT mark anything as returned yourself.\n` +
          `Lead with the answer. Short paragraphs. Plain text, no markdown. No preamble.`;

        // URGENCY CONTEXT: How soon does the rental start?
        let urgencyContext = '';
        if (rental.start_date) {
          const hoursUntilStart = (new Date(rental.start_date).getTime() - Date.now()) / (1000 * 60 * 60);
          if (hoursUntilStart > 0 && hoursUntilStart <= 24) {
            urgencyContext = `\n--- URGENT ---\nRental starts in ${Math.round(hoursUntilStart)} hours. Be direct about confirming times and ensuring everything is locked in.`;
          } else if (hoursUntilStart > 0 && hoursUntilStart <= 48) {
            urgencyContext = `\n--- HEADS UP ---\nRental starts tomorrow. Prioritize confirming pickup/return times if not yet confirmed.`;
          }
        }

        // Build rich rental context with actual pricing
        const startDateStr = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
        const endDateStr = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
        // Hygglo dates are INCLUSIVE (both start and end are rental days): days = diff + 1
        const days = rental.start_date && rental.end_date
          ? Math.max(1, Math.round((new Date(rental.end_date).getTime() - new Date(rental.start_date).getTime()) / (1000 * 60 * 60 * 24)) + 1)
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
          `Dates: ${startDateStr} to ${endDateStr}${days ? ` (${days} day${days > 1 ? 's' : ''})` : ' (dates not yet set — renter has not submitted a request)'}\n` +
          `NOTE: Both start and end dates are rental days (inclusive). Minimum rental is always 1 day.\n`;
        // Revenue context: rental_price = owner earnings (after platform fees ~36%)
        //                  renter_price = what the borrower pays (including fees)
        // Tier 1: Actual booking revenue from DB (most accurate)
        // Tier 2: rental_price from Hygglo API (already after fees — use directly as profit)
        // Tier 3: Catalog estimate × 0.64 (catalog prices are renter-facing)
        const profitAmount = ownerEarnings || rental.rental_price || null;
        const renterAmount = rental.renter_price || (profitAmount ? Math.round(profitAmount / 0.64) : null);

        if (renterAmount) {
          rentalContextStr += `Renter pays: £${renterAmount} total (this is what the renter sees on checkout)\n`;
        }
        if (profitAmount) {
          rentalContextStr += `Your profit: £${Math.round(profitAmount)} (after platform fees)\n`;
        } else {
          // No price data yet — estimate from extracted items (catalog price × 0.64)
          try {
            const extractedItems = await this.prisma.extracteditem.findMany({
              where: { rental_id: rental.id }, select: { item_name: true },
            });
            if (extractedItems.length > 0) {
              let itemTotal = 0;
              for (const ei of extractedItems) {
                const entry = PRICING_CATALOG.find(p => p.item_name.toLowerCase() === ei.item_name.toLowerCase());
                itemTotal += entry ? entry.daily_price_max : 25;
              }
              const estProfit = Math.round(itemTotal * 0.64);
              rentalContextStr += `Your profit: ~£${estProfit} (estimated 1-day, after platform fees)\n`;
              rentalContextStr += `Renter pays: ~£${itemTotal} (estimated 1-day listing price)\n`;
            }
          } catch { /* optional */ }
        }
        if (rental.price_per_day && days && days > 1) {
          rentalContextStr += `Price per day: £${rental.price_per_day}/day (your earnings)\n`;
        }
        rentalContextStr += `IMPORTANT: These are the REAL prices from the booking. Quote ONLY these figures to the renter. Do NOT make up daily rates, weekly rates, or any other pricing. When speaking to the renter, use the "Renter pays" figure. When Daniel asks about profit/earnings/revenue, use the "Your profit" figure — revenue, earnings, and profit all mean the same thing (what Daniel takes home after fees).`;

        // FIRST-TIME RENTER CHECK: Verify via Hygglo profile and inject context for discount handling
        try {
          const msgRenterUserId = (rental as any)._renterUserId as string | undefined;
          const msgRenterReviewCount = (rental as any)._renterReviewCount as number | undefined;

          // Only check if review count is 0/null/undefined (potential first-timer) and we have a user ID
          if (msgRenterUserId && (msgRenterReviewCount === undefined || msgRenterReviewCount === null || msgRenterReviewCount === 0)) {
            // Check if we already verified this renter for this rental (cache via ai_decision)
            const existingCheck = await this.prisma.ai_decision.findFirst({
              where: { rental_id: rental.id, decision_type: 'first_time_renter_verified' },
            });

            let isFirstTime = false;
            if (existingCheck) {
              isFirstTime = existingCheck.output_summary?.includes('isFirstTime: true') || false;
            } else {
              // Scrape profile page to verify
              const ftCheck = await this.playwrightService.checkFirstTimeRenter(
                msgRenterUserId,
                (rental.account || 'dbcinema') as 'dbcinema' | 'leo',
              );
              isFirstTime = ftCheck.isFirstTime;

              // Cache the result
              await this.prisma.ai_decision.create({
                data: {
                  rental_id: rental.id,
                  decision_type: 'first_time_renter_verified',
                  input_summary: `First-time renter check for ${rental.renter_info || 'Unknown'} (userId: ${msgRenterUserId})`,
                  output_summary: `isFirstTime: ${isFirstTime}, reviewCount: ${ftCheck.reviewCount}`,
                  confidence: 1.0,
                  action_taken: isFirstTime ? 'Verified first-time renter on Hygglo' : 'Not a first-time renter',
                  notified: false,
                },
              });

              if (isFirstTime) {
                this.logger.log(`FIRST-TIME RENTER confirmed: ${rental.renter_info} for ${rental.title}`);
              }
            }

            if (isFirstTime) {
              const currentProfit = profitAmount || 0;
              if (currentProfit >= 200) {
                rentalContextStr += `\n\n--- FIRST-TIME RENTER (PROACTIVE DISCOUNT) ---\n` +
                  `This renter has NEVER rented on the platform before (0 reviews, profile confirmed). ` +
                  `Owner earnings are £${Math.round(currentProfit)} (above £200 threshold). ` +
                  `PROACTIVELY offer them a £15 first-time discount as a welcome gesture. ` +
                  `Work it in naturally — e.g. "by the way, since it's your first rental I've knocked £15 off for you". ` +
                  `Add <memory>FIRST_TIME_DISCOUNT_ACCEPTED</memory> in your response when you offer it.\n`;
              } else if (currentProfit >= 120) {
                rentalContextStr += `\n\n--- FIRST-TIME RENTER ---\n` +
                  `This renter has NEVER rented on the platform before (0 reviews, profile confirmed). ` +
                  `Owner earnings are £${Math.round(currentProfit)} (above £120). ` +
                  `If they ask about first-time discounts or vouchers, offer to manually apply £15 off. ` +
                  `Do NOT proactively offer it — only if they bring it up.\n`;
              } else {
                rentalContextStr += `\n\n--- FIRST-TIME RENTER ---\n` +
                  `This renter is new to the platform (0 reviews). ` +
                  `If they ask about first-time discounts or vouchers, say it's not available at the moment.\n`;
              }
            }
          }
        } catch (ftErr) {
          this.logger.debug(`First-time renter check failed: ${ftErr.message}`);
        }

        // ACCOUNT-SPECIFIC LOW-VALUE DETECTION: Check estimated profit against minimum thresholds
        const ACCOUNT_MIN_EARNINGS: Record<string, number> = { dbcinema: 20, leo: 25 };
        const accountMinimum = ACCOUNT_MIN_EARNINGS[accountName] || 20;
        // rental_price IS owner earnings (already after fees) — use directly, no * 0.64
        let estimatedProfit = ownerEarnings || rental.rental_price || null;
        if (!estimatedProfit) {
          // No Hygglo price data — estimate from catalog prices × 0.64
          try {
            const extractedItems = await this.prisma.extracteditem.findMany({
              where: { rental_id: rental.id }, select: { item_name: true },
            });
            if (extractedItems.length > 0) {
              let itemTotal = 0;
              for (const ei of extractedItems) {
                const entry = PRICING_CATALOG.find(p => p.item_name.toLowerCase() === ei.item_name.toLowerCase());
                itemTotal += entry ? entry.daily_price_max : 25;
              }
              estimatedProfit = Math.round(itemTotal * 0.64);
            } else {
              estimatedProfit = Math.round(estimatedTotal * 0.64);
            }
          } catch { /* non-critical */ }
        }
        let lowValueInstruction = '';
        if (estimatedProfit && estimatedProfit < accountMinimum) {
          lowValueInstruction =
            `\n--- LOW VALUE RENTAL (CRITICAL) ---\n` +
            `Estimated profit: ~£${estimatedProfit}. Minimum profitable threshold for ${accountName === 'leo' ? 'Leo Adams' : 'DB Cinema'} account: £${accountMinimum}.\n` +
            `This rental is BELOW the minimum. You MUST actively upsell before quoting or confirming:\n` +
            `1. Ask what they're shooting — use this to suggest relevant add-ons (lenses, audio, lighting, filters, batteries)\n` +
            `2. Mention complementary items naturally: "Most people shooting with this also grab a..." \n` +
            `3. If they only want the single item, still quote it but mention bundle value: "Happy to help! The [item] is ~£X/day. Just so you know, we often bundle it with [accessory] which works out better value"\n` +
            `4. Do NOT refuse the rental or tell them about the minimum threshold — just upsell naturally\n` +
            `5. Do NOT accept or confirm until the order value is improved or Daniel approves\n`;
        }

        // DSPy INTEGRATION: Only use when trained (0 examples = untrained = skip)
        let dspyResponse: any = null;
        if (this.dspyService.isEnabled() && (this.dspyService as any).isTrained?.()) {
          try {
            const moduleType = hasPricingIntent ? 'pricing' : hasDeliveryIntent ? 'delivery' : 'rental';
            const contextStr = [rentalContextStr, inventoryContext, scheduleContext, deliveryQuoteContext, memories, rules].filter(Boolean).join('\n');
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

        // Inject conversation summary + rejection memory — ensure it exists (build if missing)
        let conversationSummary = await this.memoryService.getCachedSummary(rental.id);
        if (!conversationSummary && conversationHistory.length > 0) {
          // Summary wasn't built yet — force-build it now so AI never replies without context
          try {
            await this.memoryService.buildConversationSummary(rental.id, chatId, true);
            conversationSummary = await this.memoryService.getCachedSummary(rental.id);
          } catch {
            // Non-critical — AI will still have conversation history
          }
        }

        const response = dspyResponse?.response
          ? { content: dspyResponse.response, memories: [], model: 'dspy-optimized', inputTokens: 0, outputTokens: 0 }
          : await this.aiService.processAdaptive(messagePrompt, {
          rules,
          memories,
          conversationHistory,
          rentalContext: rentalContextStr,
          additionalContext: [inventoryContext, scheduleContext, vacationContext, blacklistContext, couponContext, deliveryQuoteContext, conversationSummary, urgencyContext, welcomeBackContext, ['booking_sent', 'awaiting_verification', 'confirmed', 'dead'].includes(currentStage) ? '' : lowValueInstruction].filter(Boolean).join('\n'),
          rentalDates: { start: rental.start_date, end: rental.end_date },
          // Context-aware token budget: simple acks get less, complex queries get more
          maxTokens: contextLevel === 'minimal' ? 250 : contextLevel === 'comprehensive' ? 800 : undefined,
          // Stage-gate: prompt-manager skips irrelevant DB components for later funnel stages
          conversationStage: currentStage,
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
          // Guard: AI returned internal decision text instead of a customer-facing reply — interactive escalation
          this.logger.warn(`BLOCKED [INTERNAL_RESPONSE] Non-customer reply for rental ${msg.rentalId}: "${response.content.substring(0, 100)}"`);
          actionTaken = `BLOCKED - AI escalated to owner for decision: "${response.content.substring(0, 100)}"`;

          // Generate recommended reply for escalation
          const escalationRecommended = await this.generateRecommendedReply(
            rental, msg.sender || rental.renter_info || 'Unknown', msg.content,
            `The renter sent a message that requires manual handling. Draft a helpful, professional reply addressing their message. Be concise and friendly.`,
          );

          // Send interactive decision to Daniel instead of just logging
          this.telegramService.sendDecisionPrompt({
            type: 'escalation',
            rentalId: String(rental.id),
            listingId: msg.rentalId,
            account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
            renterName: msg.sender || rental.renter_info || 'Unknown',
            renterLastMessage: msg.content,
            contextSummary: `AI escalated: "${response.content.substring(0, 200)}". Renter message: "${msg.content.substring(0, 150)}"`,
            displayText:
              `\ud83d\udce8 *AI ESCALATION*\n\n` +
              `\u251c \ud83d\udce6 ${rental.title}\n` +
              `\u251c \ud83d\udc64 ${msg.sender || rental.renter_info || 'Unknown'}\n` +
              `\u251c \ud83d\udcac "${msg.content.substring(0, 200)}"\n` +
              `\u2514 \ud83e\udd16 AI says: "${response.content.substring(0, 150)}"`,
            options: [
              { label: 'Approve', emoji: '\u2705', intent: 'respond', aiInstruction: `Daniel wants to respond to the renter. The AI flagged this for manual handling. Draft a helpful, professional reply addressing the renter's message: "${msg.content.substring(0, 200)}". Be concise and friendly.` },
              { label: 'Ignore', emoji: '\u23ed\ufe0f', intent: 'ignore', aiInstruction: '' },
            ],
            holdMessageSent: false,
            recommendedReply: escalationRecommended || undefined,
          }).catch(err => this.logger.warn(`Failed to send escalation decision: ${err.message}`));
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

          // Post-reply summary refresh: update summary with bot's reply included (non-blocking)
          this.memoryService.buildConversationSummary(rental.id, chatId).catch(() => {});
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

        // CONSOLIDATED NOTIFICATION: Route through rental update buffer
        const rentalMeta = { rentalTitle: rental.title, renterName: msg.sender, account: rental.account };

        if (validationResult.blocked) {
          await this.telegramService.sendRentalUpdate(rental.id, {
            type: 'message_blocked', priority: 'high',
            data: {
              renterMsg: msg.content,
              botReply: response.content,
              violations: validationResult.violations.join(', '),
            },
          }, rentalMeta);
        } else if (actionTaken.startsWith('BLOCKED - AI returned')) {
          await this.telegramService.sendRentalUpdate(rental.id, {
            type: 'message_blocked', priority: 'high',
            data: {
              renterMsg: msg.content,
              botReply: response.content,
              violations: 'AI returned non-customer response',
            },
          }, rentalMeta);
        } else if (qualityScore.overallQuality < 0.7 && !responseWasBlocked) {
          const lowScores: string[] = [];
          if (qualityScore.pricingAccuracy != null && qualityScore.pricingAccuracy < 0.7) lowScores.push(`pricing: ${qualityScore.pricingAccuracy.toFixed(2)}`);
          if (qualityScore.ruleCompliance != null && qualityScore.ruleCompliance < 0.7) lowScores.push(`rules: ${qualityScore.ruleCompliance.toFixed(2)}`);
          if (qualityScore.conciseness != null && qualityScore.conciseness < 0.7) lowScores.push(`conciseness: ${qualityScore.conciseness.toFixed(2)}`);
          if (qualityScore.toneMatch != null && qualityScore.toneMatch < 0.7) lowScores.push(`tone: ${qualityScore.toneMatch.toFixed(2)}`);
          await this.telegramService.sendRentalUpdate(rental.id, {
            type: 'quality_alert', priority: 'normal',
            data: {
              renterMsg: msg.content,
              botReply: response.content,
              qualityScore,
              qualityDetails: lowScores.join(', ') || 'composite',
              status: actionTaken,
            },
          }, rentalMeta);
        } else {
          const modelTag = response.model?.includes('sonnet') ? '🧠 Sonnet' : response.model?.includes('dspy') ? '⚡ DSPy' : '💨 Haiku';
          const qualityPct = Math.round(qualityScore.overallQuality * 100);
          const stageLabel = currentStage.toUpperCase();
          const intentLabel = hasPricingIntent ? '💰 pricing' : hasDeliveryIntent ? '🚚 delivery' : '💬 general';
          const tokenInfo = response.inputTokens ? `${response.inputTokens}→${response.outputTokens}t` : '';
          const confidencePct = qualityScore.computedConfidence != null ? Math.round(qualityScore.computedConfidence * 100) : null;

          const statusParts = [modelTag, stageLabel, intentLabel];
          if (qualityPct < 100) statusParts.push(`Q:${qualityPct}%`);
          if (confidencePct != null && confidencePct < 95) statusParts.push(`C:${confidencePct}%`);
          if (tokenInfo) statusParts.push(tokenInfo);

          await this.telegramService.sendRentalUpdate(rental.id, {
            type: 'message_processed', priority: 'normal',
            data: { renterMsg: msg.content, botReply: response.content, status: statusParts.join(' · ') },
          }, rentalMeta);
        }

        if (response.memories.length > 0) {
          await this.memoryService.processAiMemories(response.memories);
        }

        // Time extraction — stage-gated via registry
        try {
          const timeStageState = await this.conversationStageService.getConversationState(rental.id);
          const timeStage = timeStageState?.currentStage || 'inquiry';

          if (this.conversationStageService.isActionAllowed(timeStage, 'time_extraction_full')) {
            await this.ensureTimeRequestSent(rental);
            await this.extractPickupReturnTimes(msg, rental);
          } else if (this.conversationStageService.isActionAllowed(timeStage, 'time_extraction_tentative')) {
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

        // ARRIVAL CONFIRMATION: Detect if renter says they've arrived
        try {
          await this.detectArrivalConfirmation(msg.content, rental);
        } catch (arrivalErr) {
          this.logger.debug(`Arrival detection failed: ${arrivalErr.message}`);
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

          // Extract renter notes — stage-gated via registry (early stages only)
          try {
            const noteState = await this.conversationStageService.getConversationState(rental.id);
            const noteStage = noteState?.currentStage || 'inquiry';
            if (this.conversationStageService.isActionAllowed(noteStage, 'renter_notes')) {
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
    const timePatterns = /\b(\d{1,2}\s*(am|pm|:\d{2})|\bpickup\b|\breturn\b|\bcollect\b|\bdrop\s*off\b|\bbring\s*back\b|\breturning\b|\bmorning\b|\bevening\b|\bafternoon\b|\bnoon\b|\bmidday\b)/i;
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
        `Common patterns (pickup):\n` +
        `- "pickup at 10am", "collect at 7pm", "I'll come at 11:00", "picking up at 2pm"\n` +
        `Common patterns (return):\n` +
        `- "return at 7pm", "bring it back at 6pm", "I'll drop it off at 5pm", "back to you by 8pm"\n` +
        `- "returning at 11am", "drop off at 3pm", "give it back at noon"\n` +
        `- When two times mentioned: first is usually pickup, second is return\n\n` +
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
      // Low confidence from AI — try to salvage individual times that look valid (HH:MM format)
      if (pickupTime && /^\d{2}:\d{2}$/.test(pickupTime)) { /* keep pickup */ } else pickupTime = undefined;
      if (returnTime && /^\d{2}:\d{2}$/.test(returnTime)) { /* keep return */ } else returnTime = undefined;
      if (!pickupTime && !returnTime) {
        this.logger.debug(`Time extraction confidence too low for message from ${msg.sender}, skipping`);
        return;
      }
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

    // Update booking times + dates
    const pickupDateStr = pickupDateMatch ? pickupDateMatch[1] : undefined;
    const returnDateStr = returnDateMatch ? returnDateMatch[1] : undefined;
    const updated = await this.calendarService.updateBookingTimes(rental.id, pickupTime, returnTime, pickupDateStr, returnDateStr);

    if (!updated || updated.count === 0) {
      this.logger.debug(`No bookings updated for rental ${rental.id} (may not have linked bookings yet)`);
    }

    // Check what we now have in the booking after this update
    const currentBooking = await this.prisma.booking.findFirst({
      where: { rental_id: rental.id, status: 'confirmed' },
      select: { pickup_time: true, return_time: true },
    });
    const hasBothTimes = !!(currentBooking?.pickup_time && currentBooking?.return_time);

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

    // ONLY set times_status=confirmed when BOTH pickup AND return are set
    try {
      await this.prisma.follow_up_state.updateMany({
        where: { rental_id: rental.id },
        data: { times_status: hasBothTimes ? 'confirmed' : 'tentative' },
      });
    } catch { /* state might not exist */ }

    // Confirm back to renter — and ask for the missing time if only one was provided
    if (!this.isWriteBlocked(msg.rentalId)) {
      const confirmParts: string[] = [];
      if (pickupTime) confirmParts.push(`pickup at ${pickupTime}`);
      if (returnTime) confirmParts.push(`return at ${returnTime}`);

      let replyMsg = `${confirmParts.join(' and ')} — locked in!`;
      if (!hasBothTimes) {
        const missing = !currentBooking?.pickup_time ? 'pickup' : 'return';
        replyMsg += ` Just need your exact ${missing} time (with AM or PM) to complete the booking.`;
      }
      try {
        await this.hyggloService.sendMessage(msg.rentalId, replyMsg);
      } catch { /* best-effort */ }
    }

    this.logger.log(`Time ${hasBothTimes ? 'CONFIRMED' : 'partial'} for ${rental.title}: pickup=${currentBooking?.pickup_time || 'N/A'}, return=${currentBooking?.return_time || 'N/A'} (confidence: ${confidence})`);
  }

  // --- Extract times from chat history — DB-first, regex-only, fast & fail-safe ---

  async extractTimesFromChatHistory(
    rental: any,
    prefetchedMessages?: { sender: string; content: string; timestamp: string }[],
  ): Promise<{ pickupTime?: string; returnTime?: string; pickupDate?: string; returnDate?: string } | null> {
    // 1. Get messages — try DB first, then Hygglo API as fallback, then prefetched
    const chatId = `rental:${rental.id}`;
    let messages: { sender?: string; role?: string; content: string; timestamp?: string }[] = [];

    // Try Hygglo API FIRST — it has the COMPLETE chat (including Daniel's direct messages)
    // DB conversation table only stores bot-processed messages and misses direct exchanges
    if (rental.listing_id) {
      try {
        const hyggloMessages = await Promise.race([
          this.hyggloService.readMessages(rental.listing_id),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000)),
        ]);
        if (hyggloMessages.length > 0) {
          messages = hyggloMessages.slice(-20);
          // Cache in DB for future reads
          this.cacheMessagesInDb(chatId, hyggloMessages).catch(() => {});
        }
      } catch (err) {
        this.logger.debug(`extractTimesFromChatHistory: Hygglo API failed for ${rental.title}: ${err.message}`);
      }
    }

    // Fallback 1: use prefetched messages if Hygglo failed
    if (messages.length === 0 && prefetchedMessages && prefetchedMessages.length > 0) {
      messages = prefetchedMessages.slice(-20);
      this.cacheMessagesInDb(chatId, prefetchedMessages).catch(() => {});
    }

    // Fallback 2: DB-stored conversation history (incomplete but better than nothing)
    if (messages.length === 0) {
      try {
        const dbMessages = await this.prisma.conversation.findMany({
          where: { chat_id: chatId },
          orderBy: { created_at: 'desc' },
          take: 20,
          select: { role: true, content: true, created_at: true },
        });
        if (dbMessages.length > 0) {
          messages = dbMessages.reverse().map(m => ({
            role: m.role,
            content: m.content,
            timestamp: m.created_at.toISOString(),
          }));
        }
      } catch {
        // DB read failed
      }
    }

    if (messages.length === 0) {
      this.logger.debug(`extractTimesFromChatHistory: no messages for ${rental.title}`);
      return null;
    }

    // 2. Use AI to find the LAST AGREED AND CONFIRMED pickup & return times
    //    Renters change times, leave out AM/PM, negotiate — only AI can read context.
    const transcript = messages
      .map(m => `${m.role === 'assistant' ? 'Bot' : 'Renter'}: ${m.content}`)
      .join('\n');

    // Quick pre-filter: skip if no time-like content at all
    if (!/\d{1,2}\s*(am|pm|:\d{2})|\bmorning\b|\bevening\b|\bafternoon\b|\bnoon\b/i.test(transcript)) {
      this.logger.debug(`extractTimesFromChatHistory: no time content in ${messages.length} msgs for ${rental.title}`);
      return null;
    }

    const startDateStr = rental.start_date ? new Date(rental.start_date).toISOString().split('T')[0] : '?';
    const endDateStr = rental.end_date ? new Date(rental.end_date).toISOString().split('T')[0] : '?';

    const extractionPrompt =
      `You are extracting the FINAL AGREED pickup and return times from a rental equipment chat.\n\n` +
      `Equipment: ${rental.title}\n` +
      `Rental period: ${startDateStr} to ${endDateStr}\n\n` +
      `=== CONVERSATION ===\n${transcript}\n=== END ===\n\n` +
      `INSTRUCTIONS:\n` +
      `- Find the LAST pickup and return times that were AGREED or CONFIRMED by both parties.\n` +
      `- Renters often change their mind, negotiate, or give vague times — only use the FINAL agreed version.\n` +
      `- If the renter said a time and the bot confirmed/acknowledged it, that counts as agreed.\n` +
      `- Pickup and return are SEPARATE events — extract each independently from the conversation.\n` +
      `- If only one time was mentioned for "collection" or "pickup and return", use it for both.\n` +
      `- The same HH:MM can appear for BOTH pickup and return (e.g., "11am pickup" AND "11am return" on different days).\n` +
      `- Convert vague times: "morning" = 10:00, "afternoon" = 14:00, "evening" = 19:00, "noon" = 12:00.\n` +
      `- If AM/PM is missing, infer from context (rental pickups are usually daytime: 8-11 = AM, 12-21 = as-is).\n` +
      `- Times like "7pm" = 19:00, "10am" = 10:00, "6.30" with PM context = 18:30.\n` +
      `- If no times were discussed at all, output NONE for both.\n\n` +
      `CRITICAL — DATES:\n` +
      `- The rental period is ${startDateStr} to ${endDateStr}, but pickup/return dates may DIFFER.\n` +
      `- Pickup can be the EVENING BEFORE the rental starts (e.g., evening of ${startDateStr} minus 1 day).\n` +
      `- Return can be the MORNING AFTER the rental ends (e.g., morning of ${endDateStr} plus 1 day).\n` +
      `- Determine the actual date for pickup and return from context (day mentioned, "tomorrow", "next day", etc).\n` +
      `- If no specific date context, default pickup to ${startDateStr} and return to ${endDateStr}.\n\n` +
      `Respond ONLY with these four lines:\n` +
      `PICKUP_TIME: HH:MM or NONE\n` +
      `PICKUP_DATE: YYYY-MM-DD or NONE\n` +
      `RETURN_TIME: HH:MM or NONE\n` +
      `RETURN_DATE: YYYY-MM-DD or NONE`;

    let pickupTime: string | undefined;
    let returnTime: string | undefined;
    let pickupDate: string | undefined;
    let returnDate: string | undefined;

    try {
      const response = await this.aiService.processExtractionComplex(extractionPrompt);
      const pMatch = response.content.match(/PICKUP_TIME:\s*(\d{1,2}:\d{2})/);
      const rMatch = response.content.match(/RETURN_TIME:\s*(\d{1,2}:\d{2})/);
      const pdMatch = response.content.match(/PICKUP_DATE:\s*(\d{4}-\d{2}-\d{2})/);
      const rdMatch = response.content.match(/RETURN_DATE:\s*(\d{4}-\d{2}-\d{2})/);
      pickupTime = pMatch ? pMatch[1].padStart(5, '0') : undefined;
      returnTime = rMatch ? rMatch[1].padStart(5, '0') : undefined;
      pickupDate = pdMatch ? pdMatch[1] : undefined;
      returnDate = rdMatch ? rdMatch[1] : undefined;
    } catch (aiErr) {
      this.logger.debug(`extractTimesFromChatHistory AI failed for ${rental.title}: ${aiErr.message}`);
      return null;
    }

    if (!pickupTime && !returnTime) {
      this.logger.debug(`extractTimesFromChatHistory: AI found no confirmed times in ${messages.length} msgs for ${rental.title}`);
      return null;
    }

    // 3. Update bookings (times + dates)
    await this.calendarService.updateBookingTimes(rental.id, pickupTime, returnTime, pickupDate, returnDate);

    // 4. Update follow_up_state
    const currentBooking = await this.prisma.booking.findFirst({
      where: { rental_id: rental.id, status: { in: ['confirmed', 'pending_review'] } },
      select: { pickup_time: true, return_time: true },
    });
    const hasBothTimes = !!(currentBooking?.pickup_time && currentBooking?.return_time);
    try {
      await this.prisma.follow_up_state.updateMany({
        where: { rental_id: rental.id },
        data: { times_status: hasBothTimes ? 'confirmed' : 'tentative' },
      });
    } catch { /* state might not exist */ }

    // 5. Store as memory
    const renterName = rental.renter_info || 'Unknown';
    const memoryParts: string[] = [];
    if (pickupTime) memoryParts.push(`pickup at ${pickupTime}`);
    if (returnTime) memoryParts.push(`return at ${returnTime}`);
    const memoryContent = `${renterName} agreed ${memoryParts.join(' and ')} for ${rental.title} (from chat)`;
    await this.memoryService.storeMemory('fact', `Agreed times: ${rental.title}`, memoryContent, 8);

    this.logger.log(
      `extractTimesFromChatHistory for ${rental.title}: pickup=${pickupTime || 'N/A'}, return=${returnTime || 'N/A'} (${messages.length} msgs scanned, DB-first)`,
    );

    return { pickupTime, returnTime, pickupDate, returnDate };
  }

  // Cache Hygglo messages in the conversation table for future fast reads
  private async cacheMessagesInDb(
    chatId: string,
    messages: { sender: string; content: string; timestamp: string }[],
  ): Promise<void> {
    // Only cache the last 10 messages — older ones are rarely needed
    const recent = messages.slice(-10);
    for (const msg of recent) {
      const role = msg.sender === 'Owner' ? 'assistant' : 'user';
      try {
        // Dedup: skip if this exact message already exists
        const existing = await this.prisma.conversation.findFirst({
          where: { chat_id: chatId, content: msg.content, role },
        });
        if (!existing) {
          await this.prisma.conversation.create({
            data: {
              chat_id: chatId,
              role,
              content: msg.content,
              created_at: new Date(msg.timestamp),
            },
          });
        }
      } catch {
        // Skip duplicates or DB errors silently
      }
    }
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
          await this.telegramService.sendRentalUpdate(rental.id, {
            type: 'damage', priority: 'high',
            data: {
              damageScore: analysis.damage_score,
              issues: analysis.detected_issues.join(', ') || 'General wear',
            },
          }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
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
        await this.telegramService.sendRentalUpdate(rental.id, {
          type: 'damage', priority: 'high',
          data: {
            damageScore: damageIncrease,
            checkoutScore: comparison.checkout.damage_score,
            returnScore: comparison.return.damage_score,
            severity,
            detected_issues: comparison.return.detected_issues,
            damageCharge,
            recommendation: comparison.recommendation,
          },
        }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });

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
    // NOTE: Urgency words (urgent, immediately, right now, hurry) are intentionally EXCLUDED.
    // Same-day renters legitimately use these words. Urgency alone is never a scam signal —
    // real scams combine urgency with payment/contact requests, which are already caught by Tiers 1-2.
    const suspiciousPatterns: { pattern: RegExp; label: string }[] = [
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
      await this.telegramService.sendRentalUpdate(rental.id, {
        type: 'scam', priority: 'normal',
        data: { severity: 'suspicious', score, pattern, message, action: 'Flagged for review — not blocked' },
      }, { rentalTitle: rental.title, renterName: sender, account: rental.account });

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

    // Silent block — do NOT send any message to the renter

    // Notify owner via Telegram
    await this.telegramService.sendRentalUpdate(rental.id, {
      type: 'scam', priority: (score ?? 0) >= 0.7 ? 'critical' : 'high',
      data: { severity, score, pattern, message, action: 'Declined + auto-blacklisted' },
    }, { rentalTitle: rental.title, renterName: sender, account: rental.account });

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
        action_taken: `Silent block + auto-blacklisted. ${tierLabel}: ${pattern}`,
        notified: true,
        was_sent: false, // no message sent to renter — complete silence
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
