import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AiService, ToolHandlers } from '../ai/ai.service';
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
import { findBestMatch, getInventoryItemNames, validateListingAgainstInventory, validateListingItems, extractListingQuantity, normalizeItemName, MASTER_INVENTORY } from '../utils/item-matcher';
import { PRICING_CATALOG, formatFilteredPricingForAI, getItemPrice } from '../data/pricing-catalog';
import { checkAcquisitionOpportunity, findAcquisitionMatch } from '../data/acquisition-costs';
import { checkCompatibilityConflicts, detectMissingEssentials, formatCompatibilityForAI } from '../data/item-compatibility';
import { RenterProfileService } from '../renter-profile/renter-profile.service';
import { FollowUpService } from '../follow-up/follow-up.service';
import { VerificationService } from '../verification/verification.service';
import { RevenueService } from '../revenue/revenue.service';
import { MarketService } from '../market/market.service';
import { DspyService } from '../dspy/dspy.service';
import { CouponService } from '../coupon/coupon.service';
import { PlaywrightService } from '../playwright/playwright.service';
import { ContentionService } from '../contention/contention.service';
import { getVerifiedItems } from '../data/listing-photo-reference';

export interface HyggloMessage {
  rentalId: string;
  sender: string;
  content: string;
  timestamp: string;
  isNew: boolean;
  imageUrls?: string[];
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
  private listingIdentityBackfillDone = false;
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
    private contentionService: ContentionService,
  ) {}

  /**
   * One-time backfill: create listing_title extracteditem records for active rentals
   * that don't have them yet. Runs once on first processMessage call.
   */
  private async backfillListingIdentity(): Promise<void> {
    if (this.listingIdentityBackfillDone) return;
    this.listingIdentityBackfillDone = true;
    try {
      const rentals = await this.prisma.rental.findMany({
        where: { status: { in: ['pending_review', 'upcoming', 'ongoing'] } },
        select: { id: true, title: true },
      });
      let backfilled = 0;
      for (const r of rentals) {
        const existing = await this.prisma.extracteditem.findFirst({
          where: { rental_id: r.id },
        });
        if (!existing) {
          const match = validateListingItems(r.title);
          if (match.someMatched || match.allMatched) {
            for (const item of match.items.filter(i => i.matched && i.inventoryItem)) {
              try {
                await this.prisma.extracteditem.create({
                  data: { rental_id: r.id, item_name: item.inventoryItem!, source: 'listing_title', confidence_score: 1.0 },
                });
                backfilled++;
              } catch { /* duplicate or non-critical */ }
            }
          }
        }
      }
      if (backfilled > 0) this.logger.log(`Backfilled ${backfilled} listing_title extracteditem records`);
    } catch (err) {
      this.logger.debug(`Listing identity backfill failed: ${err.message}`);
    }
  }

  /**
   * Determine context complexity level for optimization
   * MINIMAL: Simple greetings, acknowledgments
   * STANDARD: Normal queries, general questions
   * COMPREHENSIVE: Pricing quotes, delivery calculations, complex requests
   */
  private determineContextLevel(message: string): 'minimal' | 'standard' | 'comprehensive' {
    const lowerMessage = message.toLowerCase();
    const trimmed = message.trim();

    // Social message detection (greetings, thanks, small talk — no business pivot needed)
    const socialTriggers = [
      /^(happy new year|happy christmas|merry christmas|happy birthday|happy easter|seasons greetings)[\s!.]*$/i,
      /^(haha|lol|lmao|😂|🤣|😅)+[\s!]*$/i,
      /^(you'?re the best|legend|amazing service|so helpful|really appreciate it|thanks so much you'?re)[\s!.]*$/i,
      /^(have a good|have a great|enjoy your|good luck|take care|all the best)[\s\w!.]*$/i,
    ];
    for (const trigger of socialTriggers) {
      if (trigger.test(trimmed)) {
        return 'minimal'; // Social messages get minimal + prompt rule handles warm response
      }
    }

    // Minimal context triggers (simple responses)
    const minimalTriggers = [
      /^(hi|hey|hello|thanks|thank you|ok|okay|sounds good|perfect|great|yes|no|sure)$/i,
      /^(thanks?|thx|cheers|cool)\s*!*$/i,
    ];

    for (const trigger of minimalTriggers) {
      if (trigger.test(trimmed)) {
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
   * Detect if renter is requesting extra small items to be included with the rental.
   * Uses inclusion-language patterns with false-positive guards.
   */
  private detectExtraItemsRequest(message: string): boolean {
    const text = message.toLowerCase();

    const inclusionPatterns = [
      /\b(can|could)\s+you\s+(include|bring|add|throw\s+in)\b/i,
      /\b(is\s+it\s+possible\s+to\s+(include|add|bring))\b/i,
      /\bdo\s+you\s+have\s+(a\s+)?(spare|extra)\b/i,
      /\b(any\s+chance|would\s+it\s+be\s+possible)\s+(to\s+)?(include|add|bring|throw\s+in)\b/i,
      /\bthrow\s+in\s+(a|an|some|a\s+couple)\b/i,
      /\binclude\s+(a|an|some|a\s+couple|a\s+few)\b/i,
      /\b(also|additionally)\s+(bring|include|add)\b/i,
      /\bspare\s+(sd|memory|cf)\s*card/i,
      /\bextra\s+(battery|batteries|card|cable|charger|cover|strap|filter|adapter|mount|holder|sleeve)/i,
    ];

    const falsePositivePatterns = [
      /\b(invoice|receipt|contract|document|proof|confirmation)\b/i,
      /\binclude\s+(the\s+)?(price|cost|fee|total|amount|vat|tax)\b/i,
    ];

    if (falsePositivePatterns.some(p => p.test(text))) return false;
    return inclusionPatterns.some(p => p.test(message));
  }

  /**
   * Extract specific extra item names from renter's message using Haiku.
   * Returns an array of item descriptions (e.g. ["SD cards x2", "rain cover"]).
   */
  private async extractExtraItemsViaAI(message: string, rentalTitle: string): Promise<string[]> {
    try {
      const response = await this.aiService.processExtraction(
        `Extract the extra items the renter is asking to include with their "${rentalTitle}" rental.\n\nMessage: "${message}"\n\nReturn ONLY a JSON array of item descriptions. Include quantities if mentioned. Example: ["SD cards x2", "rain cover"]\nIf no items found, return []`,
        { maxTokens: 80 },
      );
      const match = response.content.match(/\[.*\]/s);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((item: any) => String(item).trim()).filter(Boolean);
        }
      }
      return [];
    } catch (err) {
      this.logger.debug(`Extra items AI extraction failed: ${err.message}`);
      return [];
    }
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
   * Check if a time falls within allowed pickup/return slots.
   * Slots: 10:00-12:00 (morning) and 19:00-21:00 (evening).
   * Returns the slot name if valid, null if outside slots.
   */
  private isWithinSlot(time: string): 'morning' | 'evening' | null {
    const match = time.match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;
    const mins = parseInt(match[1]) * 60 + parseInt(match[2]);
    // Morning: 10:00-12:00 (600-720 mins) — allow 9:45 tolerance
    if (mins >= 585 && mins <= 720) return 'morning';
    // Evening: 19:00-21:00 (1140-1260 mins) — allow 21:30 tolerance
    if (mins >= 1140 && mins <= 1290) return 'evening';
    return null;
  }

  /**
   * Detect if a renter is deferring time confirmation ("I'll let you know later", etc.)
   */
  private detectTimeDeferral(content: string): boolean {
    const deferralPatterns = [
      /i'?ll\s+(?:let\s+you\s+know|tell\s+you|confirm|get\s+back|decide)\s*(?:later|tomorrow|soon|next|the\s+day|in\s+a\s+bit)?/i,
      /not\s+sure\s+(?:yet|about\s+times?)/i,
      /(?:don'?t|do\s*n'?t)\s+know\s+(?:yet|the\s+times?|when|my\s+times?)/i,
      /(?:will|can)\s+(?:confirm|decide|tell|let)\s+(?:you\s+)?(?:know\s+)?(?:later|tomorrow|soon|closer)/i,
      /(?:times?|schedule)\s+(?:tbd|tba|to\s+be\s+(?:confirmed|decided))/i,
      /(?:figure|work)\s+(?:it\s+)?out\s+(?:later|tomorrow|soon|closer)/i,
    ];
    return deferralPatterns.some(p => p.test(content));
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
    // IMPORTANT: Use matchAll + take LAST match — renters often correct themselves in the same message
    const pickupPattern = /(?:pickup|pick\s*up|collect|picking\s*up|collection|come\s*(?:at|by|around))\s*(?:(?:will\s*be|at|by|around|is)\s*)*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
    const returnPattern = /(?:return|drop\s*off|dropoff|bring\s*(?:it\s*)?back|returning|give\s*(?:it\s*)?back|back\s*(?:to\s*you\s*)?(?:at|by)|drop\s*(?:it\s*)?(?:back|off))\s*(?:(?:will\s*be|at|by|around|is)\s*)*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;

    const pickupMatches = [...content.matchAll(pickupPattern)];
    const pickupMatch = pickupMatches.length > 0 ? pickupMatches[pickupMatches.length - 1] : null;
    if (pickupMatch) result.pickupTime = parseTime(pickupMatch) || undefined;

    const returnMatches = [...content.matchAll(returnPattern)];
    const returnMatch = returnMatches.length > 0 ? returnMatches[returnMatches.length - 1] : null;
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

    // Date patterns — multiple formats renters actually use
    // 1. ISO format: "on 2025-01-15"
    const isoDatePattern = /(?:on\s+(?:the\s+)?)?(\d{4}-\d{2}-\d{2})/gi;
    const isoMatches = [...content.matchAll(isoDatePattern)];
    if (isoMatches.length >= 1) result.pickupDate = isoMatches[0][1];
    if (isoMatches.length >= 2) result.returnDate = isoMatches[1][1];

    // 2. DD/MM or DD/MM/YYYY format: "22/02", "22/02/2026", "22/2"
    if (!result.pickupDate) {
      const ddmmPattern = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
      const ddmmMatches = [...content.matchAll(ddmmPattern)];
      // Filter out likely non-date matches (addresses etc) — day must be 1-31, month 1-12
      const validDates: string[] = [];
      const currentYear = new Date().getFullYear();
      for (const m of ddmmMatches) {
        const day = parseInt(m[1], 10);
        const month = parseInt(m[2], 10);
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
          let year = currentYear;
          if (m[3]) {
            year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
          }
          validDates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        }
      }
      if (validDates.length >= 1) result.pickupDate = validDates[0];
      if (validDates.length >= 2) result.returnDate = validDates[1];
    }

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

    // Guard: skip already-consolidated rentals
    if ((rental.status || '').toLowerCase() === 'consolidated') {
      this.logger.log(`Skipping consolidated rental: ${rental.title} (id=${rental.id})`);
      return;
    }

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

          // OVERRIDE: If renter explicitly says this is their first time, suppress returning renter context
          // regardless of what profile matching says. Also suppress if conversation is empty (brand new rental).
          if (isReturningRenter) {
            const renterMsgText = initialMessages
              .filter(m => m.sender !== 'Owner' && m.sender !== 'owner')
              .map(m => m.content)
              .join(' ')
              .toLowerCase();
            const firstTimeSignals = /\b(first\s*time|new\s*here|first\s*booking|never\s*(used|rented|booked)|new\s*to\s*(this|the\s*platform))\b/i;
            if (firstTimeSignals.test(renterMsgText)) {
              this.logger.log(`Suppressing returning renter for ${renterName} — renter says it's their first time`);
              isReturningRenter = false;
            } else {
              this.logger.log(`Returning renter detected: ${renterName} (${returningCheck.previousRentalCount} previous rentals)`);
            }
          }
        }
      } catch (profileErr) {
        this.logger.warn(`Renter profile linking failed: ${profileErr.message}`);
      }

      // Active rental detection for returning renters — detect additions/extensions
      let activeRentalContext = '';
      if (isReturningRenter && renterProfileId) {
        try {
          const activeRentals = await this.renterProfileService.getActiveRentalsForProfile(renterProfileId, rental.id);
          if (activeRentals.length > 0) {
            const newStart = rental.start_date ? new Date(rental.start_date).getTime() : null;
            const newEnd = rental.end_date ? new Date(rental.end_date).getTime() : null;

            for (const active of activeRentals) {
              const activeStart = active.start_date ? new Date(active.start_date).getTime() : null;
              const activeEnd = active.end_date ? new Date(active.end_date).getTime() : null;

              if (!newStart || !activeStart || !activeEnd) continue;

              // Overlap = addition (requesting more gear for the same period)
              // New start after old end = extension (extending their rental period)
              const hasOverlap = newEnd && activeEnd && newStart <= activeEnd && newEnd >= activeStart;
              const isExtension = newStart > activeEnd;

              if (hasOverlap) {
                activeRentalContext = `\n--- ADDITION TO EXISTING RENTAL ---\n` +
                  `This renter already has an active booking: "${active.title}" (${active.status}, ` +
                  `${active.start_date ? new Date(active.start_date).toLocaleDateString('en-GB') : '?'} - ` +
                  `${active.end_date ? new Date(active.end_date).toLocaleDateString('en-GB') : '?'}). ` +
                  `This new request has OVERLAPPING dates — likely adding extra gear to their existing rental. ` +
                  `Acknowledge their existing booking warmly and confirm availability for the new items.\n`;
                this.logger.log(`ADDITION detected: "${rental.title}" overlaps with active "${active.title}" for ${renterName}`);
                break;
              } else if (isExtension) {
                activeRentalContext = `\n--- EXTENSION OF EXISTING RENTAL ---\n` +
                  `This renter has a recent booking: "${active.title}" (${active.status}, ` +
                  `${active.start_date ? new Date(active.start_date).toLocaleDateString('en-GB') : '?'} - ` +
                  `${active.end_date ? new Date(active.end_date).toLocaleDateString('en-GB') : '?'}). ` +
                  `This new request starts AFTER their existing rental ends — likely extending their rental period or booking a follow-up. ` +
                  `Acknowledge their previous booking and handle this smoothly.\n`;
                this.logger.log(`EXTENSION detected: "${rental.title}" follows active "${active.title}" for ${renterName}`);
                break;
              }
            }
          }
        } catch (activeErr) {
          this.logger.debug(`Active rental detection failed: ${activeErr.message}`);
        }
      }

      // Conversation carryover: fetch summaries from recent rentals by this renter
      let previousConversationContext = '';
      if (renterProfileId) {
        try {
          const summaries = await this.getConversationSummariesForRenter(renterProfileId, rental.id);
          if (summaries.length > 0) {
            previousConversationContext = summaries.map(s =>
              `--- PREVIOUS CONVERSATION (from "${s.rentalTitle}", ${s.status}, ${s.dates}) ---\n` +
              `${s.summary}\n` +
              `---`,
            ).join('\n');
            previousConversationContext =
              `\n\n${previousConversationContext}\n` +
              `This is likely a continuation or re-request. Reference what was discussed if relevant. ` +
              `Do NOT repeat questions that were already answered in previous conversations.\n`;
            this.logger.log(`Conversation carryover: ${summaries.length} previous conversation(s) for ${renterName}`);
          }
        } catch (carryoverErr) {
          this.logger.debug(`Conversation carryover failed: ${(carryoverErr as Error).message}`);
        }
      }

      // Cross-scan multi-pending consolidation
      if (renterProfileId) {
        try {
          const wasConsolidated = await this.handleCrossScanConsolidation(rental, renterProfileId, renterName);
          if (wasConsolidated) {
            // Current rental was redirected to a higher-value primary — skip normal pipeline
            return;
          }
        } catch (consolidationErr) {
          this.logger.warn(`Cross-scan consolidation failed: ${(consolidationErr as Error).message}`);
        }
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
          recentMessages.map(m => `${m.sender}: ${m.content}`).join('\n');
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
          // PHOTO REFERENCE OVERRIDE: Check listing-photo-reference before title matching
          // This prevents SEO noise like "(like BMPCC 6K Full Frame)" from causing false inventory matches
          const photoRef = rental.listing_id ? getVerifiedItems(rental.listing_id) : null;
          let photoRefHandled = false;

          if (photoRef) {
            if (photoRef.items.length === 0) {
              // Photo reference exists but has NO items → confirmed non-inventory listing (e.g. Pyxis 6K, FX30)
              // VISIBILITY_REDIRECTS in calendar.service.ts handles the AI recommendation
              onNewRentalInventoryWarning =
                `\n\nWARNING — VISIBILITY LISTING: "${rental.title}" is a visibility/SEO listing for an item we do NOT carry. ` +
                `This item is "currently unavailable". Check if we have a similar alternative and recommend it naturally. ` +
                `If the listing title mentions a KIT or SET with multiple components (camera + lenses + accessories), suggest alternatives for ALL components — not just the camera body. ` +
                `NEVER say "we don't stock this" or "visibility listing". Frame as temporary unavailability.`;
              photoRefHandled = true;
            } else {
              // Photo reference has verified items → use those instead of title parsing for inventory check
              const verifiedNames = photoRef.items.map(i => i.item);
              const allInInventory = verifiedNames.every(name => !!MASTER_INVENTORY[name]);
              if (allInInventory) {
                // All verified items are in our inventory — no warning needed
                photoRefHandled = true;
              }
              // If not all in inventory, fall through to normal validation
            }
          }

          // Strip SEO noise from title before validation (same regex as title-parser)
          const cleanTitle = rental.title?.replace(/\(\s*(?:like|similar to|comparable to|replaces|vs|or)\s[^)]+\)/gi, '').trim() || rental.title;
          const multiCheck = photoRefHandled ? null : validateListingItems(cleanTitle);
          const listingQty = photoRefHandled ? 0 : extractListingQuantity(cleanTitle);

          if (multiCheck && multiCheck.noneMatched) {
            // No items matched — ghost/SEO listing or completely unknown item
            const altMatch = findBestMatch(cleanTitle, getInventoryItemNames());
            if (altMatch) {
              onNewRentalInventoryWarning =
                `\n\nWARNING — LISTING_INVENTORY_MISMATCH: The listing "${rental.title}" does not match any item in our physical inventory. ` +
                `Do NOT confirm this item as available. ` +
                `Closest real item: "${altMatch}" (${MASTER_INVENTORY[altMatch]} units). Offer this as an alternative. ` +
                `If the listing title mentions a KIT or SET with multiple components (camera + lenses + accessories), suggest alternatives for ALL components — not just the main item. Check the pricing catalog for compatible lenses/accessories to recommend alongside the camera alternative. ` +
                `SUBSTITUTION PRICING: Quote the MIDPOINT price between the requested item and the alternative (only for this substituted item, not other items in the order). ` +
                `IMPORTANT FRAMING: Say this specific item is "currently unavailable" and suggest the alternative. ` +
                `NEVER say "we don't stock this" or "not in our lineup". NEVER invent reasons for unavailability.`;
            } else {
              onNewRentalInventoryWarning =
                `\n\nWARNING — NO INVENTORY MATCH: The listing "${rental.title}" is not currently available and we have no similar alternative. ` +
                `Apologise and say this item is "currently unavailable". ` +
                `NEVER reveal we don't own or carry an item — frame as temporary. ` +
                `Do NOT suggest unrelated equipment.`;
            }
          } else if (multiCheck && multiCheck.someMatched && multiCheck.isComboListing) {
            // COMBO LISTING: Some items matched, some didn't — DON'T say "out of stock"
            const matched = multiCheck.items.filter(i => i.matched).map(i => `"${i.inventoryItem}" (${i.maxQuantity} unit(s))`).join(', ');
            const unmatched = multiCheck.items.filter(i => !i.matched).map(i => `"${i.name}"`).join(', ');
            onNewRentalInventoryWarning =
              `\n\nINFO — COMBO LISTING: This listing "${rental.title}" contains multiple items. ` +
              `Items we HAVE in stock: ${matched}. ` +
              `Items NOT in our current inventory: ${unmatched}. ` +
              `Offer the available items. For unavailable items, suggest alternatives if any exist. ` +
              `Do NOT say the whole listing is "out of stock" — individual items ARE available.`;
          } else if (multiCheck && multiCheck.allMatched && !multiCheck.isComboListing) {
            // Single matched item — check quantity
            const singleItem = multiCheck.items[0];
            if (listingQty > singleItem.maxQuantity) {
              onNewRentalInventoryWarning =
                `\n\nWARNING — LISTING_INVENTORY_MISMATCH: The listing title says "${listingQty}x" but we only have ${singleItem.maxQuantity} unit(s) of "${singleItem.inventoryItem}". ` +
                `State that we have ${singleItem.maxQuantity} available. NEVER offer to source or find additional units.`;
            }
          }

          // FEATURE: Pre-Extracted Listing Identity
          // Store matched inventory items with source='listing_title' OR photo_reference
          // so processMessage can inject verified identity instead of relying on raw SEO-laden title
          if (photoRef && photoRef.items.length > 0) {
            // Store photo-reference items as authoritative extracted items
            for (const refItem of photoRef.items) {
              try {
                const existing = await this.prisma.extracteditem.findFirst({
                  where: { rental_id: rental.id, item_name: refItem.item, source: 'photo_reference' },
                });
                if (!existing) {
                  await this.prisma.extracteditem.create({
                    data: {
                      rental_id: rental.id,
                      item_name: refItem.item,
                      source: 'photo_reference',
                      confidence_score: 1.0,
                    },
                  });
                }
              } catch { /* non-critical */ }
            }
          } else if (multiCheck && (multiCheck.someMatched || multiCheck.allMatched)) {
            for (const item of multiCheck.items.filter(i => i.matched && i.inventoryItem)) {
              try {
                const existing = await this.prisma.extracteditem.findFirst({
                  where: { rental_id: rental.id, item_name: item.inventoryItem!, source: 'listing_title' },
                });
                if (!existing) {
                  await this.prisma.extracteditem.create({
                    data: {
                      rental_id: rental.id,
                      item_name: item.inventoryItem!,
                      source: 'listing_title',
                      confidence_score: 1.0,
                    },
                  });
                }
              } catch { /* non-critical */ }
            }
          }
        } catch {
          // Non-critical
        }
      }

      // Evaluate inventory contention for this new rental
      try {
        await this.contentionService.evaluateContention(rental.id);
      } catch { /* non-critical */ }

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

      // Low-value detection for new rental analysis
      let onNewRentalLowValueCtx = '';
      try {
        const analyzeAccountName = rental.account || 'dbcinema';
        const ANALYZE_MIN: Record<string, number> = { dbcinema: 20, leo: 25 };
        const analyzeMinimum = ANALYZE_MIN[analyzeAccountName] || 20;
        let analyzeProfit = rental.rental_price || null;
        if (!analyzeProfit) {
          const extractedItems = await this.prisma.extracteditem.findMany({
            where: { rental_id: rental.id }, select: { item_name: true },
          });
          if (extractedItems.length > 0) {
            let itemTotal = 0;
            for (const ei of extractedItems) {
              const entry = PRICING_CATALOG.find(p => p.item_name.toLowerCase() === ei.item_name.toLowerCase());
              itemTotal += entry ? entry.daily_price_max : 25;
            }
            analyzeProfit = Math.round(itemTotal * 0.64);
          }
        }
        if (analyzeProfit && analyzeProfit < analyzeMinimum) {
          const renterFacingMin = Math.ceil(analyzeMinimum / 0.64);
          onNewRentalLowValueCtx =
            `\n\n--- LOW VALUE RENTAL (CRITICAL) ---\n` +
            `Estimated profit: ~£${analyzeProfit}. Minimum for ${analyzeAccountName === 'leo' ? 'Leo Adams' : 'DB Cinema'}: £${analyzeMinimum}.\n` +
            `This rental is BELOW the minimum. In your welcome message:\n` +
            `1. First try to upsell add-ons (ask what they're shooting, suggest accessories)\n` +
            `2. If renter only wants the single item, the booking total needs to come to at least £${renterFacingMin}\n` +
            `3. Frame as standard pricing, NEVER say "minimum". You CANNOT modify bookings — the renter must adjust through the platform.\n`;
        }
      } catch { /* non-critical */ }

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
        onNewRentalFirstTimeCtx +
        onNewRentalLowValueCtx +
        previousConversationContext;

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
        activeRentalContext +
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
        `3. If sending a message, include the exact message text after "MESSAGE:" on the same line (plain text, no markdown). If no message needed, do NOT include a MESSAGE: line.`;

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

        // 7c. Check for price match verification flag
        const priceMatchMemory = response.memories.find(m => m.toUpperCase().includes('PRICE_MATCH_VERIFIED'));
        if (priceMatchMemory) {
          try {
            // Parse competitor price from memory tag: PRICE_MATCH_VERIFIED:competitor_price=NUMBER,our_new_renter_price=NUMBER
            const competitorMatch = priceMatchMemory.match(/competitor_price\s*=\s*(\d+(?:\.\d+)?)/i);
            const newPriceMatch = priceMatchMemory.match(/our_new_renter_price\s*=\s*(\d+(?:\.\d+)?)/i);

            if (competitorMatch) {
              const competitorPrice = parseFloat(competitorMatch[1]);
              const targetRenterPrice = newPriceMatch ? parseFloat(newPriceMatch[1]) : Math.round(competitorPrice * 0.95);
              const PLATFORM_RETENTION = 0.64;
              const targetOwnerEarnings = Math.round(targetRenterPrice * PLATFORM_RETENTION);
              const currentOwnerEarnings = rental.rental_price || 0;

              if (currentOwnerEarnings > 0 && targetOwnerEarnings < currentOwnerEarnings) {
                const discountPercentage = Math.round(((currentOwnerEarnings - targetOwnerEarnings) / currentOwnerEarnings) * 10000) / 100;

                // Safety: don't allow more than 40% off
                if (discountPercentage > 0 && discountPercentage <= 40) {
                  const alreadyFlagged = await this.prisma.ai_decision.findFirst({
                    where: { rental_id: rental.id, decision_type: 'price_match' },
                  });

                  if (!alreadyFlagged) {
                    await this.prisma.ai_decision.create({
                      data: {
                        rental_id: rental.id,
                        decision_type: 'price_match',
                        input_summary: `price_match_flagged: competitor £${competitorPrice}, our new renter price £${targetRenterPrice}, owner earnings £${currentOwnerEarnings} → £${targetOwnerEarnings} (${discountPercentage}% off)`,
                        output_summary: `Price match verified. Beat competitor by 5%. Renter price: £${targetRenterPrice}`,
                        confidence: 1.0,
                        action_taken: `Price match flagged. Competitor: £${competitorPrice}, Target: £${targetRenterPrice}, Discount: ${discountPercentage}%`,
                        notified: true,
                      },
                    });

                    await this.followUpService.updateAcceptanceReadiness(rental.id, {
                      discount_eligible: true,
                    });

                    this.logger.log(`PRICE MATCH flagged for ${rental.title}: competitor £${competitorPrice}, our target £${targetRenterPrice} (${discountPercentage}% off earnings)`);
                  }
                } else {
                  this.logger.warn(`Price match discount too large for ${rental.title}: ${discountPercentage}% — skipped (safety cap 40%)`);
                }
              }
            }
          } catch (pmErr) {
            this.logger.debug(`Price match parsing failed: ${pmErr.message}`);
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

        // Same-day rentals: bot handles the conversation first (confirms items, agrees times),
        // then system escalates to Daniel for final approval before accepting on Hygglo.
        if (isSameDay) {
          this.logger.log(`Same-day rental detected for ${rental.title} (£${rentalValue}) — bot will confirm details with renter, then escalate to Daniel`);
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

  // --- Conversation carryover helpers ---

  /**
   * Fetch conversation summaries from recent rentals by the same renter profile.
   * Used to carry over context when a renter sends a new/re-request.
   */
  private async getConversationSummariesForRenter(
    profileId: string,
    excludeRentalId: string,
    maxAgeDays: number = 90,
  ): Promise<{ rentalTitle: string; status: string; summary: string; dates: string }[]> {
    const results: { rentalTitle: string; status: string; summary: string; dates: string }[] = [];
    try {
      const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

      const links = await this.prisma.rental_renter_link.findMany({
        where: { renter_profile_id: profileId },
        include: {
          rental: {
            select: {
              id: true, title: true, status: true, listing_id: true,
              start_date: true, end_date: true, created_at: true,
            },
          },
        },
      });

      for (const link of links) {
        if (!link.rental || link.rental.id === excludeRentalId) continue;
        // Only include recent rentals (any status including dead/cancelled)
        if (link.rental.created_at && link.rental.created_at < cutoff) continue;

        // Try cached summary first
        let summary = await this.memoryService.getCachedSummary(link.rental.id);

        // If no cached summary, try to build one
        if (!summary) {
          try {
            const built = await this.memoryService.buildConversationSummary(
              link.rental.id,
              link.rental.listing_id,
            );
            if (built) summary = built;
          } catch {
            // Non-critical — skip this rental
          }
        }

        if (summary) {
          const startStr = link.rental.start_date ? new Date(link.rental.start_date).toLocaleDateString('en-GB') : '?';
          const endStr = link.rental.end_date ? new Date(link.rental.end_date).toLocaleDateString('en-GB') : '?';
          results.push({
            rentalTitle: link.rental.title || 'Unknown',
            status: link.rental.status || 'unknown',
            summary,
            dates: `${startStr} - ${endStr}`,
          });
        }
      }
    } catch (err) {
      this.logger.debug(`getConversationSummariesForRenter failed: ${(err as Error).message}`);
    }
    return results;
  }

  /**
   * Handle cross-scan multi-pending consolidation.
   * When a new rental arrives and the same renter already has other pending/upcoming rentals,
   * consolidate into the highest-earning primary chat.
   * Returns true if the current rental was consolidated (caller should return early).
   */
  private async handleCrossScanConsolidation(
    rental: any,
    renterProfileId: string,
    renterName: string,
  ): Promise<boolean> {
    try {
      const otherPending = await this.renterProfileService.getPendingRentalsForProfile(renterProfileId, rental.id);
      if (otherPending.length === 0) return false;

      // Only consolidate within the same account
      const sameAccountPending = otherPending.filter(r => r.account === (rental.account || null));
      if (sameAccountPending.length === 0) return false;

      // Combine current + other pending, sort by rental_price DESC
      const currentEntry = {
        id: rental.id,
        title: rental.title,
        status: rental.status,
        listing_id: rental.listing_id,
        start_date: rental.start_date,
        end_date: rental.end_date,
        rental_price: rental.rental_price || 0,
        account: rental.account || null,
      };
      const allPending = [currentEntry, ...sameAccountPending].sort(
        (a, b) => (b.rental_price || 0) - (a.rental_price || 0),
      );

      const primary = allPending[0];
      const firstName = (renterName || 'there').split(' ')[0];

      this.logger.log(
        `Multi-pending consolidation: ${allPending.length} rentals from ${renterName} → primary: ${primary.title}`,
      );

      if (primary.id === rental.id) {
        // Current rental IS the primary (highest earner)
        // Redirect all other pending to this chat
        for (const secondary of sameAccountPending) {
          const redirectMessage =
            `Hey! I've got this request — I'll handle everything together in your ${primary.title} chat to keep things simple. ` +
            `Head over there and we'll get it sorted!`;

          try {
            if (!this.isWriteBlocked(secondary.listing_id)) {
              await this.hyggloService.sendMessage(secondary.listing_id, redirectMessage);
            }
          } catch (err) {
            this.logger.warn(`Failed to send cross-scan redirect for ${secondary.title}: ${(err as Error).message}`);
          }

          // Mark secondary as consolidated
          try {
            await this.prisma.rental.update({
              where: { id: secondary.id },
              data: { status: 'consolidated' },
            });
            await this.prisma.follow_up_state.updateMany({
              where: { rental_id: secondary.id },
              data: { status: 'completed' },
            });
          } catch { /* non-critical */ }

          // Audit trail
          try {
            await this.prisma.ai_decision.create({
              data: {
                rental_id: secondary.id,
                decision_type: 'analyze',
                input_summary: `cross_scan_consolidated: redirected to primary chat (${primary.title})`,
                output_summary: `Renter has ${allPending.length} pending requests. Consolidated into primary rental (highest earner).`,
                confidence: 1.0,
                action_taken: `Sent redirect to primary chat: ${primary.title}`,
                notified: true,
              },
            });
          } catch { /* non-critical */ }
        }

        // Send consolidation message in primary (current) chat
        const itemList = allPending.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
        const consolidationMessage =
          `Hey ${firstName}! I can see you've sent ${allPending.length} rental requests:\n` +
          `${itemList}\n\n` +
          `It's easier to coordinate everything in one chat — can you send me a full list of what you need and the dates? ` +
          `I'll sort it all out here.`;

        // Attach multi-item context so the AI knows about all items
        (rental as any)._multiItemContext = {
          allItems: allPending.map(r => ({
            title: r.title,
            price: r.rental_price || 0,
            rentalId: r.id,
          })),
          totalValue: allPending.reduce((sum, r) => sum + (r.rental_price || 0), 0),
          secondaryRentalIds: sameAccountPending.map(r => r.id),
        };

        // Send the consolidation message directly (don't wait for AI)
        try {
          if (!this.isWriteBlocked(rental.listing_id)) {
            await this.hyggloService.sendMessage(rental.listing_id, consolidationMessage);
          }
        } catch (err) {
          this.logger.warn(`Failed to send consolidation message: ${(err as Error).message}`);
        }

        // Don't return early — let onNewRental continue with the primary + multi-item context
        return false;

      } else {
        // Current rental is NOT the primary — an existing rental earns more
        // Redirect current to primary chat
        const redirectMessage =
          `Hey! I've got this request — I'll handle everything together in your ${primary.title} chat to keep things simple. ` +
          `Head over there and we'll get it sorted!`;

        try {
          if (!this.isWriteBlocked(rental.listing_id)) {
            await this.hyggloService.sendMessage(rental.listing_id, redirectMessage);
          }
        } catch (err) {
          this.logger.warn(`Failed to send cross-scan redirect for current ${rental.title}: ${(err as Error).message}`);
        }

        // Mark current as consolidated
        try {
          await this.prisma.rental.update({
            where: { id: rental.id },
            data: { status: 'consolidated' },
          });
          await this.prisma.follow_up_state.updateMany({
            where: { rental_id: rental.id },
            data: { status: 'completed' },
          });
        } catch { /* non-critical */ }

        // Notify primary chat about new request
        try {
          if (!this.isWriteBlocked(primary.listing_id)) {
            const notifyMessage =
              `I noticed you also have a new request for ${rental.title} — shall I add that to what we're handling here? ` +
              `Let me know everything you need and I'll sort it all out.`;
            await this.hyggloService.sendMessage(primary.listing_id, notifyMessage);
          }
        } catch (err) {
          this.logger.warn(`Failed to notify primary chat: ${(err as Error).message}`);
        }

        // Audit trail
        try {
          await this.prisma.ai_decision.create({
            data: {
              rental_id: rental.id,
              decision_type: 'analyze',
              input_summary: `cross_scan_consolidated: redirected to higher-value primary (${primary.title}, £${primary.rental_price})`,
              output_summary: `Current rental £${rental.rental_price || 0} < primary £${primary.rental_price}. Consolidated to primary.`,
              confidence: 1.0,
              action_taken: `Redirected to primary: ${primary.title}. Notified primary chat.`,
              notified: true,
            },
          });
        } catch { /* non-critical */ }

        this.logger.log(`Cross-scan consolidation: ${rental.title} (£${rental.rental_price || 0}) → primary: ${primary.title} (£${primary.rental_price})`);
        return true; // Caller should return early — current rental is consolidated
      }
    } catch (err) {
      this.logger.warn(`Cross-scan consolidation check failed: ${(err as Error).message}`);
      return false;
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
        const allImageUrls = rentalMsgs.flatMap(m => m.imageUrls || []);
        const combined: HyggloMessage = {
          rentalId,
          sender: rentalMsgs[rentalMsgs.length - 1].sender, // Use latest sender
          content: rentalMsgs.map(m => m.content).join('\n'),
          timestamp: rentalMsgs[rentalMsgs.length - 1].timestamp,
          isNew: true,
          ...(allImageUrls.length > 0 ? { imageUrls: allImageUrls } : {}),
        };
        this.logger.log(`Batched ${rentalMsgs.length} messages for rental ${rentalId} into one conversation turn`);
        tasks.push(this.processMessage(combined));
      }
    }

    await Promise.all(tasks);
  }

  private async processMessage(msg: HyggloMessage) {
      // One-time backfill for listing identity records
      this.backfillListingIdentity().catch(() => {});

      // Per-rental deduplication: skip if this rental is already being processed
      if (this.activeRentalProcessing.has(msg.rentalId)) {
        this.logger.warn(`Skipping duplicate processing for rental ${msg.rentalId} — already in progress`);
        return;
      }

      // Content-based dedup (in-memory fast path): skip if we already processed this exact message recently
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

      // DATABASE-LEVEL DEDUP: Check if an ai_decision was already created for this exact message
      // within the last 60 seconds. This catches race conditions where concurrent scan cycles
      // both pass the in-memory check before either creates a decision record.
      const msgContentHash = msg.content.substring(0, 200);
      try {
        const recentDecision = await this.prisma.ai_decision.findFirst({
          where: {
            input_summary: { contains: msgContentHash.substring(0, 100) },
            decision_type: 'message',
            created_at: { gte: new Date(Date.now() - 60_000) },
          },
          select: { id: true },
        });
        if (recentDecision) {
          this.logger.debug(`DB dedup: skipping message for rental ${msg.rentalId} — decision ${recentDecision.id} already exists`);
          return;
        }
      } catch (dedupErr) {
        // Non-critical — continue processing if dedup check fails
        this.logger.debug(`DB dedup check failed: ${(dedupErr as Error).message}`);
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

        // Contention hold gate — check if this rental is being held for a higher-value competitor
        const contentionHold = await this.contentionService.isHeld(rental.id);
        if (contentionHold.held) {
          // Send one-time hold message, then absorb silently
          await this.contentionService.sendHoldMessageIfNeeded(rental.id, contentionHold.contentionId!);
          // Store message in conversation history (so context is preserved on release)
          await this.prisma.conversation.create({
            data: { chat_id: rental.listing_id, role: 'user', content: msg.content },
          });
          await this.prisma.ai_decision.create({
            data: {
              rental_id: rental.id,
              decision_type: 'message',
              input_summary: `[CONTENTION HOLD] ${msg.content.substring(0, 200)}`,
              output_summary: 'Message absorbed — rental held for higher-value contention',
              confidence: 1.0,
              action_taken: 'contention_hold_absorb',
              was_sent: false,
            },
          });
          this.logger.log(`Contention hold: absorbed message from ${msg.sender} on rental ${rental.listing_id}`);
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

        // Always refresh conversation summary on new messages — stale summaries cause context amnesia
        try {
          await this.memoryService.buildConversationSummary(rental.id, chatId, true);
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
        let contextLevel = this.determineContextLevel(msg.content);

        // MINIMAL CONTEXT: For simple acks ("hi", "thanks", "ok"), skip heavy context loading
        // BUT: if the bot's last message was a question, upgrade to standard — the renter is likely answering it
        if (contextLevel === 'minimal' && conversationHistory.length >= 2) {
          const lastAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant');
          if (lastAssistant && lastAssistant.content.trim().endsWith('?')) {
            contextLevel = 'standard';
            this.logger.debug(`Upgraded minimal→standard: bot's last message was a question`);
          } else {
            this.logger.debug(`Minimal context for simple message: "${msg.content.substring(0, 50)}"`);
          }
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

        // EXTRA ITEMS REQUEST: Renter asks for small extras not in inventory → escalate to owner
        try {
          if (this.detectExtraItemsRequest(msg.content)) {
            const extraItems = await this.extractExtraItemsViaAI(msg.content, rental.title || '');
            if (extraItems.length > 0) {
              const extraLabel = extraItems.join(', ');

              // Send hold message to renter
              try {
                if (!this.isWriteBlocked(rental.id)) {
                  const holdMsg = `Let me check on that — I'll get back to you shortly!`;
                  await this.hyggloService.sendMessage(msg.rentalId, holdMsg);
                  await this.memoryService.storeConversation(chatId, 'assistant', holdMsg, { model: 'system' });
                }
              } catch (holdErr) {
                this.logger.debug(`Extra items hold message failed: ${holdErr.message}`);
              }

              // Generate recommended approval reply
              const extraRecommendedReply = await this.generateRecommendedReply(
                rental, rental.renter_info || msg.sender || 'Unknown', msg.content,
                `The renter asked about including ${extraLabel} with their rental. Draft a friendly confirmation that you'll include these items.`,
              );

              await this.telegramService.sendDecisionPrompt({
                type: 'extra_items',
                rentalId: String(rental.id),
                listingId: msg.rentalId,
                account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
                renterName: rental.renter_info || msg.sender || 'Unknown',
                renterLastMessage: msg.content,
                contextSummary: `Extra items request: ${extraLabel}. Renter: ${msg.sender}. Rental: ${rental.title}`,
                displayText:
                  `📦 *EXTRA ITEMS REQUEST*\n\n` +
                  `├ 🛒 Items: *${extraLabel}*\n` +
                  `├ 👤 ${rental.renter_info || msg.sender || 'Unknown'}\n` +
                  `├ 📋 ${rental.title || 'Unknown listing'}\n` +
                  `└ 💬 Renter told: "Let me check on that"`,
                options: [
                  { label: 'Include them', emoji: '✅', intent: 'approve', aiInstruction: `Daniel confirms the extra items (${extraLabel}) can be included with this rental. Draft a warm message telling the renter great news — you'll include the requested items. Keep it brief.` },
                  { label: "Don't have them", emoji: '❌', intent: 'decline', aiInstruction: `Daniel doesn't have the requested items (${extraLabel}). Draft a polite, apologetic message explaining that unfortunately you don't have these available at the moment. Suggest they're welcome to bring their own if needed.` },
                ],
                holdMessageSent: true,
                recommendedReply: extraRecommendedReply || undefined,
                requestedItems: extraItems,
              });

              this.logger.log(`EXTRA ITEMS REQUEST: ${extraLabel} — escalated to owner for rental ${rental.id}`);
              return; // Skip normal AI response — owner will decide
            }
          }
        } catch (extraErr) {
          this.logger.debug(`Extra items request check failed: ${extraErr.message}`);
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

          // COMPATIBILITY GUARDRAILS: Warn about incompatible item combos
          const { conflicts } = checkCompatibilityConflicts(mentionedItems);
          if (conflicts.length > 0) {
            const warningLines = conflicts.map(
              (c) => `WARNING: ${c.camera} is NOT compatible with ${c.item} — ${c.reason}. Alert the renter.`,
            );
            memories = [memories, `\n--- COMPATIBILITY WARNING ---\n${warningLines.join('\n')}`].filter(Boolean).join('\n');
            this.logger.log(`COMPATIBILITY WARNING: ${conflicts.length} conflict(s) detected for ${mentionedItems.join(', ')}`);
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

        // UPSELL THROTTLE: Detect messages where upselling is inappropriate
        // Logistics: renter is arriving, confirming times, en route
        const isLogisticsMessage = /\b(i'?m here|on my way|waiting|arrived|outside|coming|here now|at the|be there|minutes away|just (got|arrived|walking)|heading over|pickup|drop.?off|return|collecting)\b/i.test(msg.content);
        // Payment/verification: renter struggling with platform
        const isPaymentMessage = /\b(payment|pay|paying|book(ed|ing)?|verif|document|id.?check|not accepted|trying|submit)\b/i.test(msg.content);
        // Goodbye/decline: renter is wrapping up or declining
        const isGoodbyeMessage = /^(thanks?|cheers|ok|okay|no worries|perfect|great|cool|lovely|brilliant|sorted|bye|see you|ta|noted|got it|will do|understood|sounds good|amazing)\b/i.test(msg.content.trim()) && msg.content.trim().length < 80;
        // Simple acknowledgment: one-word or very short response
        const isSimpleAck = msg.content.trim().split(/\s+/).length <= 5 && /^(yes|yeah|yep|ok|okay|sure|no|nah|confirmed?|done|sent|here|ready)\b/i.test(msg.content.trim());
        // Conversation already deep: upselling gets repetitive after 3rd exchange
        const isDeepConversation = conversationHistory.length > 4;

        const suppressUpsell = isLogisticsMessage || isPaymentMessage || isGoodbyeMessage || isSimpleAck || isDeepConversation;
        if (suppressUpsell) {
          upsellContext = ''; // Kill all upsell context for this response
        }

        // DEMAND-BASED UPSELLING: First 3 messages only, reuse already-fetched demand data
        // Stage gating applied later in commercialBlock (isEarlyStage ? upsellContext : '')
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
          : (mentionedItems.length > 0 ? `If you mention any prices, use ONLY the pricing catalog data in your context — do NOT guess prices from memory. If no pricing data is provided for an item, say "around £X/day" only if you're confident, otherwise say "let me confirm the rate".\n` : '');

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

        // MISSING ESSENTIALS: Flag when camera has no lens mentioned (early stages only)
        if (mentionedItems.length > 0 && ['inquiry', 'interest', 'qualified'].includes(currentStage)) {
          const { missing } = detectMissingEssentials(mentionedItems);
          if (missing.length > 0) {
            const missingLines = missing.map((m) => {
              if (m.category === 'lens') {
                return `${m.camera} needs a lens to work. Compatible options we rent: ${m.suggestions.join(', ')}. Only mention if the renter hasn't already said they have their own lens.`;
              }
              return `${m.camera} works well with ${m.suggestions.join(', ')}. Only mention if the renter asks about accessories.`;
            });
            memories = [memories, `\n--- MISSING ESSENTIALS (only mention if renter asks or context is natural) ---\n${missingLines.join('\n')}`].filter(Boolean).join('\n');
            this.logger.log(`MISSING ESSENTIALS: ${missing.length} gap(s) for ${mentionedItems.join(', ')}`);
          }
        }

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

        // MULTI-RENTAL COORDINATION: Detect when renter has other active rentals with overlapping dates
        let multiRentalContext = '';
        if (currentProfileId) {
          try {
            const otherRentals = await this.renterProfileService.getActiveRentalsForProfile(currentProfileId, rental.id);
            if (otherRentals.length > 0) {
              const currentStart = rental.start_date ? new Date(rental.start_date).getTime() : null;
              const currentEnd = rental.end_date ? new Date(rental.end_date).getTime() : null;
              const DAY_MS = 24 * 60 * 60 * 1000;

              const overlapping = otherRentals.filter((r) => {
                if (!currentStart || !r.start_date || !r.end_date) return false;
                const rStart = new Date(r.start_date).getTime();
                const rEnd = new Date(r.end_date).getTime();
                // Overlapping or adjacent (within 1 day)
                return currentEnd
                  ? (currentStart <= rEnd + DAY_MS && currentEnd >= rStart - DAY_MS)
                  : (currentStart <= rEnd + DAY_MS && currentStart >= rStart - DAY_MS);
              });

              if (overlapping.length > 0) {
                const rentalList = overlapping.map((r) =>
                  `"${r.title}" (${r.status}, ${r.start_date ? new Date(r.start_date).toLocaleDateString('en-GB') : '?'} - ${r.end_date ? new Date(r.end_date).toLocaleDateString('en-GB') : '?'})`,
                ).join('; ');
                multiRentalContext = `\n--- MULTI-RENTAL COORDINATION ---\n` +
                  `This renter also has active bookings: ${rentalList}.\n` +
                  `Coordinate pickup/return times across all bookings. If you confirm a time here, mention it applies to their other items too.\n` +
                  `Don't repeat information already discussed in other rental chats.`;
                this.logger.log(`MULTI-RENTAL COORDINATION: ${overlapping.length} overlapping rental(s) for profile ${currentProfileId}`);
              }
            }
          } catch (mrErr) {
            this.logger.debug(`Multi-rental coordination check failed: ${mrErr.message}`);
          }
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
          const now = new Date();
          const currentHour = now.getHours();
          // Recommend a late pickup time: push as late as reasonable for the day
          let recommendedTime: string;
          if (currentHour < 11) recommendedTime = '12pm-1pm';
          else if (currentHour < 14) recommendedTime = '5pm-6pm';
          else if (currentHour < 17) recommendedTime = '8pm-9pm';
          else recommendedTime = '9pm';

          sameDayInstruction =
            `\n--- SAME-DAY RENTAL ---\n` +
            `This is a SAME-DAY rental. Your job: confirm items, agree on a pickup time, and get everything confirmed IN WRITING with the renter.\n` +
            `1. Check the item is available (use inventory context above) and tell the renter it's available.\n` +
            `2. Suggest a LATE pickup time: "${recommendedTime}" — push as late in the day as reasonable.\n` +
            `3. If the renter insists on a specific time within opening hours, that's fine as long as it's at least 1 hour from now.\n` +
            `4. Answer any questions they have (cables, accessories, etc.) and confirm all details.\n` +
            `5. Once everything is agreed (items + time + any questions answered), say something like "Perfect, just confirming the final details and I'll get back to you shortly."\n` +
            `6. If the renter asks for an update after that, tell them you're just sorting the last bits and will confirm very soon.\n` +
            `IMPORTANT: Do NOT say the booking is confirmed/accepted. You are AGREEING to everything but the actual acceptance happens after final internal checks.\n`;
        }

        // Account-based persona selection (matches Telegram sim mode)
        const accountName = rental.account || 'dbcinema';
        const persona = accountName === 'leo'
          ? `You are replying AS Leo from Leo Adams gear rental.
VOICE: Use "I" and "my" — you're an individual, not a company. Casual, warm, slightly chill.
STYLE: "mate", "cheers", "sorted", "no worries". Short sentences. No corporate speak.
EXAMPLES:
- "Yeah mate, I've got the FX3 available for those dates — sorted!"
- "Cheers for confirming, I'll get everything prepped for you."
- "No worries at all, let me check what I've got free that weekend."
AUTHORITY: You ARE Leo, the owner. For business decisions (pricing, discounts, freebies) you can't resolve from your rules, just say "let me check on that" and hold — NEVER say "let me check with the owner" or reference anyone else. You are the owner.`
          : `You are replying AS Daniel from DB Cinema Rentals.
VOICE: Use "our" and "the gear" — you represent a professional rental business.
STYLE: Professional, concise, human. Efficient but not cold. No slang.
EXAMPLES:
- "Hi there — the FX3 is available for those dates. Shall I go ahead and confirm?"
- "Thanks for getting back to us. Everything's prepped and ready for collection."
- "Absolutely, let me check our availability and get back to you shortly."
AUTHORITY: You represent Daniel — you cannot make business decisions (pricing, discounts, freebies) on his behalf. NEVER invent or assume policies, requirements, or procedures not explicitly in your rules — if unsure or the situation is an edge case, escalate to Daniel rather than guessing. When in doubt, escalate.`;
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
        // Uses multi-item validation to handle combo listings (e.g. "FX3 + 28-70mm lens")
        // SKIP for accepted/ongoing/completed rentals — the renter's booked items ARE their items
        const rentalStatusLower = (rental.status || '').toLowerCase();
        const isAcceptedRental = ['upcoming', 'ongoing', 'completed'].some(s => rentalStatusLower.includes(s));
        let listingInventoryContext = '';
        try {
          if (isAcceptedRental) {
            this.logger.debug(`Skipping LISTING_INVENTORY_MISMATCH for accepted rental ${rental.id} (status: ${rental.status})`);
          } else {
            const multiValidation = validateListingItems(rental.title);
            const listingQty = extractListingQuantity(rental.title);

            if (multiValidation.noneMatched) {
              // No items matched — ghost/SEO listing
              const altMatch = findBestMatch(rental.title, getInventoryItemNames());
              if (altMatch) {
                listingInventoryContext =
                  `\n--- LISTING_INVENTORY_MISMATCH ---\n` +
                  `This listing item "${rental.title}" is not currently available.\n` +
                  `Closest alternative in stock: "${altMatch}" (${MASTER_INVENTORY[altMatch]} unit(s)). Offer this instead.\n` +
                  `If the listing title mentions a KIT or SET with multiple components (camera + lenses + accessories), suggest alternatives for ALL components — not just the main item. Check the pricing catalog for compatible lenses/accessories to recommend alongside the camera alternative.\n` +
                  `SUBSTITUTION PRICING: Quote the MIDPOINT price between the requested item and the alternative (only for this substituted item, not other items in the order).\n` +
                  `Say this specific item is "currently unavailable" and suggest the alternative.\n` +
                  `NEVER say "we don't stock this" or "not in our lineup". Frame as temporary.\n`;
              } else {
                listingInventoryContext =
                  `\n--- LISTING_INVENTORY_MISMATCH ---\n` +
                  `This listing item "${rental.title}" is currently unavailable and we have no similar alternative.\n` +
                  `Apologise and say it's "currently unavailable". Frame as temporary.\n` +
                  `Do NOT suggest unrelated equipment as substitutes.\n`;
              }
            } else if (multiValidation.someMatched && multiValidation.isComboListing) {
              // COMBO LISTING FIX: Some items in the combo ARE available individually
              const matched = multiValidation.items.filter(i => i.matched).map(i => `"${i.inventoryItem}" (${i.maxQuantity} unit(s))`).join(', ');
              const unmatched = multiValidation.items.filter(i => !i.matched).map(i => `"${i.name}"`).join(', ');
              listingInventoryContext =
                `\n--- COMBO LISTING ---\n` +
                `This listing "${rental.title}" contains multiple items.\n` +
                `Items WE HAVE in stock: ${matched}.\n` +
                `Items not in current inventory: ${unmatched}.\n` +
                `DO NOT say the listing is "out of stock" — the available items ARE in stock.\n` +
                `Offer the available items normally. For unavailable parts, suggest alternatives if any.\n`;
            } else if (multiValidation.allMatched && !multiValidation.isComboListing) {
              // Single matched item — check quantity
              const singleItem = multiValidation.items[0];
              if (listingQty > singleItem.maxQuantity) {
                listingInventoryContext =
                  `\n--- LISTING_INVENTORY_MISMATCH ---\n` +
                  `The listing says "${listingQty}x" but we only have ${singleItem.maxQuantity} unit(s) of "${singleItem.inventoryItem}".\n` +
                  `State we have ${singleItem.maxQuantity} available. NEVER offer to source additional units.\n`;
              }
            }
            // allMatched combo listings = all items available, no warning needed
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

        // CONSOLIDATED CONTEXT BLOCKS: Merge related blocks to reduce prompt section count
        // Block 1: ITEM AVAILABILITY (listing validation + message-level item mismatches)
        const itemAvailabilityBlock = [listingInventoryContext, messageMismatchContext].filter(Boolean).join('\n');

        // Block 2: COMMERCIAL (pricing + delivery + upsell + discount + same-day)
        const isEarlyStage = ['inquiry', 'interest', 'qualified'].includes(currentStage);
        const isLateStage = ['booking_sent', 'awaiting_verification', 'confirmed', 'dead'].includes(currentStage);
        // Anti-upsell instruction when context is inappropriate
        const antiUpsell = (suppressUpsell || isLateStage)
          ? 'Do NOT suggest additional items, accessories, or upgrades in this response. Just answer what the renter asked — keep it focused and concise.'
          : '';
        const commercialBlock = [
          pricingInstruction,
          deliveryInstruction,
          deliveryRecalc,
          // Upselling only during early stages AND only when not suppressed by context
          (isEarlyStage && !suppressUpsell) ? upsellContext : '',
          antiUpsell,
          discountContext,
          sameDayInstruction,
        ].filter(Boolean).join('\n');

        // Block 3: STAGE & RENTER (stage guidance + rental stage + renter profile)
        const stageRenterBlock = [
          stageGuidance,
          rentalStageContext,
          renterProfileContext,
        ].filter(Boolean).join('\n');

        // FEATURE 1: Pre-Extracted Listing Identity — inject verified item identity so AI doesn't misidentify from SEO titles
        let verifiedListingItem = '';
        let extractedItemNames: string[] = [];
        try {
          const extractedIdentity = await this.prisma.extracteditem.findMany({
            where: { rental_id: rental.id },
          });
          if (extractedIdentity.length > 0) {
            // Deduplicate: photo_reference is authoritative over listing_title
            const seen = new Map<string, string>();
            for (const e of extractedIdentity) {
              const existing = seen.get(e.item_name);
              if (!existing || e.source === 'photo_reference') {
                seen.set(e.item_name, e.source);
              }
            }
            extractedItemNames = [...seen.keys()];
            const itemNamesStr = extractedItemNames.join(', ');
            verifiedListingItem = `\n--- VERIFIED LISTING ITEM ---\n` +
              `This listing's actual inventory item(s): ${itemNamesStr}\n` +
              `The listing title "${rental.title}" may contain SEO keywords — IGNORE any other product names in the title.\n` +
              `When the renter asks about this rental, they are asking about: ${itemNamesStr}.\n`;
          }
        } catch { /* non-critical */ }

        // FEATURE 3: Conversation State Machine — inject accumulated state so AI doesn't repeat questions or re-introduce items
        let conversationStateCtx = '';
        try {
          const convState = await this.followUpService.getStructuredState(rental.id);
          const parts: string[] = [];
          if (convState.confirmedItems?.length) parts.push(`Confirmed items: ${convState.confirmedItems.join(', ')}`);
          if (convState.agreedPickupTime) parts.push(`Agreed pickup: ${convState.agreedPickupTime}`);
          if (convState.agreedReturnTime) parts.push(`Agreed return: ${convState.agreedReturnTime}`);
          if (convState.renterShootType) parts.push(`Shoot type: ${convState.renterShootType}`);
          if (convState.questionsAsked?.length) parts.push(`Already asked: ${convState.questionsAsked.join(', ')}`);
          if (convState.upsellAttempted) parts.push('Upselling already attempted — do NOT upsell again');
          if (convState.priceQuoted) parts.push(`Last price quoted: £${convState.priceQuoted}`);
          if (convState.deliveryDiscussed) parts.push('Delivery already discussed');
          if (parts.length > 0) {
            conversationStateCtx = `\n--- CONVERSATION STATE ---\n${parts.join('\n')}\nDo NOT re-ask questions listed above. Do NOT repeat information already established.\n`;
          }
        } catch { /* non-critical */ }

        // FEATURE 2: Preflight Reasoning — extract verified facts before the main AI call
        let preflightContext = '';
        try {
          const preflight = await this.aiService.preflightReasoning(
            msg.content,
            rental.title,
            rental.status || '',
            extractedItemNames,
            { start: rental.start_date, end: rental.end_date },
          );
          preflightContext = `\n--- VERIFIED FACTS (from preflight check) ---\n` +
            `Actual item: ${preflight.listingItem}\n` +
            `Renter wants: ${preflight.renterIntent}\n` +
            `Rental status: ${preflight.status}\n` +
            (preflight.warnings.length > 0 ? `Warnings: ${preflight.warnings.join('; ')}\n` : '');
        } catch (preflightErr) {
          this.logger.debug(`Preflight reasoning failed: ${preflightErr.message}`);
        }

        const messagePrompt =
          `A renter sent a message on the ${businessName} account. Draft a reply.\n\n` +
          `${persona}\n\n` +
          `Renter: ${msg.sender}\n` +
          `Their message: "${msg.content}"\n` +
          `Rental: ${rental.title}\n\n` +
          (itemAvailabilityBlock ? `${itemAvailabilityBlock}\n` : '') +
          (verifiedListingItem ? `${verifiedListingItem}\n` : '') +
          (commercialBlock ? `${commercialBlock}\n` : '') +
          (stageRenterBlock ? `${stageRenterBlock}\n` : '') +
          `\nVOICE: ${accountName === 'leo' ? 'Use "I" and "my" — you\'re Leo, an individual.' : 'Use "our" and "the gear" — you represent the business.'} NEVER mention "Hygglo" by name — say "the platform" or "the booking system". Never prefix your response with timestamps or date markers.\n` +
          `${itemAvailabilityBlock || hasPricingIntent || isEarlyStage ? `INVENTORY: ${getInventoryItemNames().join(', ')}.\n` : ''}` +
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
          const renterFacingMinimum = Math.ceil(accountMinimum / 0.64);
          lowValueInstruction =
            `\n--- LOW VALUE RENTAL (CRITICAL) ---\n` +
            `Estimated profit: ~£${estimatedProfit}. Minimum profitable threshold for ${accountName === 'leo' ? 'Leo Adams' : 'DB Cinema'} account: £${accountMinimum}.\n` +
            `This rental is BELOW the minimum. Follow these phases IN ORDER:\n\n` +
            `PHASE 1 — Upsell first (always try this first):\n` +
            `1. Ask what they're shooting — use this to suggest relevant add-ons (lenses, audio, lighting, filters, batteries)\n` +
            `2. Mention complementary items naturally: "Most people shooting with this also grab a..." \n` +
            `3. If they only want the single item, still quote it but mention bundle value: "Happy to help! The [item] is ~£X/day. Just so you know, we often bundle it with [accessory] which works out better value"\n\n` +
            `PHASE 2 — Minimum price option (only if renter clearly declines all add-ons):\n` +
            `4. Offer: "For this rental the booking total would come to £${renterFacingMinimum} — would that work?"\n` +
            `   Frame as standard platform processing, NOT as a "minimum". Never say "minimum" to the renter.\n` +
            `5. If they agree, include <memory>MINIMUM_PRICE_ACCEPTED</memory> in your response\n` +
            `6. Do NOT accept or confirm until either upsell succeeds, renter agrees to adjusted price, or Daniel approves\n`;
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

        // FEATURE 4: Tool Use — construct handlers so AI can request real-time data
        const toolHandlers: ToolHandlers = {
          checkAvailability: async (itemName, startDate, endDate) => {
            const result = await this.calendarService.checkAvailability(
              itemName, new Date(startDate), new Date(endDate),
            );
            return result.available
              ? `${result.matchedItem || itemName} is available (${result.booked}/${result.maxQuantity} booked)`
              : `${result.matchedItem || itemName} is NOT available for those dates (${result.booked}/${result.maxQuantity} booked)`;
          },
          lookupPricing: async (itemName, days) => {
            const entry = getItemPrice(itemName);
            if (!entry) return `Pricing not found for ${itemName}`;
            const dailyRate = entry.daily_price_max;
            // Multi-day discount approximation: 3 days ~2.5x, 7 days ~5x
            let total = dailyRate * days;
            if (days >= 7) total = dailyRate * 5;
            else if (days >= 3) total = dailyRate * 2.5;
            const ownerEarnings = Math.round(total * 0.64);
            return `${itemName} for ${days} day(s): ~£${Math.round(total)} (renter pays), ~£${ownerEarnings} (owner earnings)`;
          },
          checkCompatibility: async (items) => {
            const conflicts = checkCompatibilityConflicts(items);
            const missing = detectMissingEssentials(items);
            const parts: string[] = [];
            if (conflicts.conflicts.length > 0) {
              parts.push('CONFLICTS: ' + conflicts.conflicts.map(c => c.reason).join('; '));
            }
            if (missing.missing.length > 0) {
              parts.push('MISSING: ' + missing.missing.map(m => `${m.camera} needs ${m.category}: ${m.suggestions.join(', ')}`).join('; '));
            }
            const compatInfo = formatCompatibilityForAI(items);
            if (compatInfo) parts.push(compatInfo);
            return parts.length > 0 ? parts.join('\n') : 'All items are compatible. No issues detected.';
          },
          getRentalDetails: async (rentalId) => {
            const r = await this.prisma.rental.findUnique({ where: { id: rentalId } });
            if (!r) return 'Rental not found';
            const startStr = r.start_date ? new Date(r.start_date).toLocaleDateString('en-GB') : 'TBC';
            const endStr = r.end_date ? new Date(r.end_date).toLocaleDateString('en-GB') : 'TBC';
            return `Title: ${r.title}, Status: ${r.status}, Dates: ${startStr} to ${endStr}, Renter: ${r.renter_info || 'Unknown'}`;
          },
        };

        // TIME REFERENCE CONTEXT: When renter mentions relative times, inject rental dates for accurate resolution
        let timeReferenceContext = '';
        const timeWords = /\b(tomorrow|today|tonight|this weekend|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|later|soon|asap)\b/i;
        if (timeWords.test(msg.content)) {
          const now = new Date();
          const startStr = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'TBC';
          const endStr = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'TBC';
          const todayStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
          timeReferenceContext = `TIME REFERENCE CONTEXT: Today is ${todayStr}. This rental runs from ${startStr} to ${endStr}. When the renter says a relative time (e.g. "tomorrow", "Friday", "this weekend"), resolve it to the actual date and CONFIRM it back to them (e.g. "So that's Friday 21st Feb — works for me!").`;
        }

        const response = dspyResponse?.response
          ? { content: dspyResponse.response, memories: [], model: 'dspy-optimized', inputTokens: 0, outputTokens: 0 }
          : await this.aiService.processAdaptive(messagePrompt, {
          rules,
          memories,
          conversationHistory,
          rentalContext: rentalContextStr,
          additionalContext: [
            // PREFLIGHT: verified facts extracted before main call
            ...[preflightContext].filter(Boolean),
            // CONVERSATION STATE: accumulated facts from prior exchanges
            ...[conversationStateCtx].filter(Boolean),
            // OPERATIONAL: inventory specs, schedule, vacation, blacklist
            ...[inventoryContext, scheduleContext, vacationContext, blacklistContext].filter(Boolean),
            // COMMERCIAL (supplementary): coupons, delivery quotes, low-value guidance
            // Low-value instruction is a business rule (minimum order), NOT optional upselling — always inject
            ...[couponContext, deliveryQuoteContext, lowValueInstruction].filter(Boolean),
            // CONVERSATION: summary, urgency, welcome-back, multi-rental coordination
            ...[conversationSummary, urgencyContext, welcomeBackContext, multiRentalContext].filter(Boolean),
            // TIME REFERENCES: help AI resolve relative times against rental dates
            ...[timeReferenceContext].filter(Boolean),
          ].join('\n'),
          rentalDates: { start: rental.start_date, end: rental.end_date },
          // Context-aware token budget: simple acks get less, complex queries get more
          maxTokens: contextLevel === 'minimal' ? 250 : (contextLevel === 'comprehensive' || (msg.imageUrls && msg.imageUrls.length > 0)) ? 800 : undefined,
          // Stage-gate: prompt-manager skips irrelevant DB components for later funnel stages
          conversationStage: currentStage,
          // Pass image URLs for multimodal analysis (price match screenshots, etc.)
          imageUrls: msg.imageUrls,
          // Tool handlers for function calling
          toolHandlers,
        });

        // POST-PROCESSING: Clean formatting artifacts before validation
        response.content = response.content
          .replace(/\]\]+/g, '')                 // Strip orphaned ]] brackets
          .replace(/\n{3,}/g, '\n\n')            // Collapse 3+ newlines to 2
          .replace(/(\*{2,}|_{2,}|#{1,})/g, '')  // Strip markdown bold/italic/headers
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Strip markdown links, keep text
          .replace(/^\s+|\s+$/g, '')             // Trim leading/trailing whitespace
          .replace(/  +/g, ' ');                 // Collapse double spaces

        // FEATURE 3: Extract conversation state changes from this exchange (best-effort, non-blocking)
        try {
          const stateExtraction = await this.aiService.processExtraction(
            `Extract conversation state from this exchange. Reply in JSON only, no markdown fences.
Bot response: "${response.content.substring(0, 500)}"
Renter message: "${msg.content.substring(0, 300)}"

Return ONLY a JSON object with changed fields (omit unchanged):
{"confirmedItems":["item1"],"agreedPickupTime":"Fri 2pm","agreedReturnTime":null,"renterShootType":"wedding","questionsAsked":["what's the shoot for?"],"upsellAttempted":false,"priceQuoted":150,"deliveryDiscussed":false}`,
            { maxTokens: 150 },
          );
          // Strip markdown fences if present, then parse
          const jsonStr = stateExtraction.content.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(jsonStr);
          await this.followUpService.mergeStructuredState(rental.id, parsed);
        } catch { /* non-critical — state extraction is best-effort */ }

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

        // Send the reply on Hygglo (gated by READ_ONLY_MODE and VALIDATION and CONFIDENCE)
        const writeBlocked = this.isWriteBlocked(msg.rentalId);
        let actionTaken: string;

        // LOW CONFIDENCE GATE: Block responses with < 40% confidence and escalate
        // Exception: simple logistics messages ("I'm here", "on my way") naturally score low
        const isLowConfidence = qualityScore.computedConfidence != null && qualityScore.computedConfidence < 0.4;
        const isLogisticsMsg = /\b(i'?m here|on my way|waiting|arrived|outside|coming|here now|at the)\b/i.test(msg.content);
        const logisticsBypass = isLogisticsMsg && ['confirmed', 'ongoing'].some(s => (rental.status || '').toLowerCase().includes(s));
        const confidenceBlocked = isLowConfidence && !logisticsBypass;

        if (confidenceBlocked && !validationResult.blocked) {
          this.logger.warn(`BLOCKED [LOW_CONFIDENCE] Confidence ${(qualityScore.computedConfidence! * 100).toFixed(0)}% < 40% for rental ${msg.rentalId}`);
          actionTaken = `BLOCKED - low confidence (${(qualityScore.computedConfidence! * 100).toFixed(0)}%). Draft: "${response.content.substring(0, 100)}..."`;

          this.telegramService.sendDecisionPrompt({
            type: 'escalation',
            rentalId: String(rental.id),
            listingId: msg.rentalId,
            account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
            renterName: msg.sender || rental.renter_info || 'Unknown',
            renterLastMessage: msg.content,
            contextSummary: `Low confidence (${(qualityScore.computedConfidence! * 100).toFixed(0)}%). Draft: "${response.content.substring(0, 150)}"`,
            displayText:
              `\u26a0\ufe0f *LOW CONFIDENCE (${(qualityScore.computedConfidence! * 100).toFixed(0)}%)*\n\n` +
              `\u251c \ud83d\udce6 ${rental.title}\n` +
              `\u251c \ud83d\udc64 ${msg.sender || rental.renter_info || 'Unknown'}\n` +
              `\u251c \ud83d\udcac "${msg.content.substring(0, 200)}"\n` +
              `\u2514 \ud83e\udd16 Draft: "${response.content.substring(0, 150)}"`,
            options: [
              { label: 'Send', emoji: '\u2705', intent: 'respond', aiInstruction: '' },
              { label: 'Ignore', emoji: '\u23ed\ufe0f', intent: 'ignore', aiInstruction: '' },
            ],
            holdMessageSent: false,
            recommendedReply: response.content,
          }).catch(err => this.logger.warn(`Failed to send low-confidence escalation: ${err.message}`));
        } else

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

        // ADD_ITEM_REQUESTED detection — send listing link if available
        try {
          const addItemMatch = response.content.match(/<memory>ADD_ITEM_REQUESTED:item=([^<]+)<\/memory>/i);
          if (addItemMatch) {
            const requestedItem = addItemMatch[1].trim();
            this.logger.log(`ADD_ITEM_REQUESTED detected: "${requestedItem}" for rental ${rental.title}`);

            // Look up listing URL from recent rentals on the same account
            const recentRentals = await this.prisma.rental.findMany({
              where: {
                account: rental.account || undefined,
                listing_url: { not: '' },
              },
              select: { title: true, listing_url: true, updated_at: true },
              orderBy: { updated_at: 'desc' },
              take: 100,
            });

            const normalizedRequested = normalizeItemName(requestedItem);
            let listingUrl: string | null = null;

            // First pass: normalized contains-check on rental titles
            for (const r of recentRentals) {
              const normalizedTitle = normalizeItemName(r.title);
              if (normalizedTitle.includes(normalizedRequested) || normalizedRequested.includes(normalizedTitle)) {
                listingUrl = r.listing_url;
                break;
              }
            }

            // Fallback: fuzzy match via findBestMatch against rental titles
            if (!listingUrl) {
              const titleList = recentRentals.map(r => r.title);
              const bestMatch = findBestMatch(requestedItem, titleList);
              if (bestMatch) {
                const matched = recentRentals.find(r => r.title === bestMatch);
                if (matched) listingUrl = matched.listing_url;
              }
            }

            if (listingUrl) {
              const followUpMsg = `here's the link to request it: ${listingUrl}`;
              if (!this.isWriteBlocked(msg.rentalId)) {
                try {
                  await this.hyggloService.sendMessage(msg.rentalId, followUpMsg);
                  this.logger.log(`Sent add-item listing link for "${requestedItem}": ${listingUrl}`);
                } catch (sendErr) {
                  this.logger.warn(`Failed to send add-item link: ${sendErr.message}`);
                }
              } else {
                this.logger.warn(`BLOCKED [READ_ONLY_MODE] Add-item link draft: "${followUpMsg}"`);
              }
            } else {
              this.logger.debug(`No listing URL found for add-item request: "${requestedItem}"`);
            }
          }
        } catch (addItemErr) {
          this.logger.debug(`ADD_ITEM_REQUESTED detection failed: ${addItemErr.message}`);
        }

        // MINIMUM_PRICE_ACCEPTED detection — renter agreed to adjusted booking total for low-value rental
        try {
          const hasMinPriceTag = response.memories?.some(m => m.toUpperCase().includes('MINIMUM_PRICE_ACCEPTED'))
            || response.content?.includes('<memory>MINIMUM_PRICE_ACCEPTED</memory>');

          if (hasMinPriceTag) {
            this.logger.log(`MINIMUM_PRICE_ACCEPTED detected for rental ${rental.title}`);

            // Idempotency: check if already processed (covers both success and failure)
            const alreadyProcessed = await this.prisma.ai_decision.findFirst({
              where: {
                rental_id: rental.id,
                decision_type: { in: ['min_price_accepted', 'min_price_failed', 'min_price_pending'] },
              },
            });

            if (!alreadyProcessed) {
              const accountName = rental.account || 'dbcinema';
              const ACCOUNT_MIN_EARNINGS: Record<string, number> = { dbcinema: 20, leo: 25 };
              const targetEarnings = ACCOUNT_MIN_EARNINGS[accountName] || 20;
              const renterFacingPrice = Math.ceil(targetEarnings / 0.64);

              // Write idempotency record SYNCHRONOUSLY before fire-and-forget (prevents race condition)
              await this.prisma.ai_decision.create({
                data: {
                  rental_id: rental.id,
                  decision_type: 'min_price_pending',
                  input_summary: `Renter agreed to adjusted price £${renterFacingPrice} (target earnings £${targetEarnings})`,
                  output_summary: 'Processing — setOrderEarnings + acceptRental in progress',
                  confidence: 1.0,
                  action_taken: 'min_price_pending',
                  notified: true,
                },
              });

              // Informational Telegram notification (no approval needed — thresholds pre-approved)
              const rentalMeta = { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account };
              await this.telegramService.sendRentalUpdate(rental.id, {
                type: 'message_processed',
                priority: 'normal',
                data: {
                  renterMsg: '',
                  botReply: '',
                  status: `💰 Min price accepted: renter agreed to £${renterFacingPrice} (earnings → £${targetEarnings}). Auto-accepting...`,
                },
              }, rentalMeta);

              // Fire-and-forget: set earnings + accept
              this.followUpService.acceptWithMinimumPrice(rental.id)
                .then(result => {
                  if (result.success) {
                    this.logger.log(`acceptWithMinimumPrice SUCCESS for ${rental.title}: £${result.previousEarnings} → £${result.newEarnings}`);
                  } else {
                    this.logger.error(`acceptWithMinimumPrice FAILED for ${rental.title}: ${result.error}`);
                    // High-priority Telegram alert for manual intervention
                    this.telegramService.sendRentalUpdate(rental.id, {
                      type: 'auto_accept_failed',
                      priority: 'high',
                      data: { error: `Min price accept failed: ${result.error}` },
                    }, rentalMeta).catch(() => {});
                  }
                })
                .catch(err => {
                  this.logger.error(`acceptWithMinimumPrice threw for ${rental.title}: ${err.message}`);
                  this.telegramService.sendRentalUpdate(rental.id, {
                    type: 'auto_accept_failed',
                    priority: 'high',
                    data: { error: `Min price accept error: ${err.message}` },
                  }, rentalMeta).catch(() => {});
                });
            } else {
              this.logger.debug(`MINIMUM_PRICE_ACCEPTED already processed for ${rental.title} — skipping`);
            }
          }
        } catch (minPriceErr) {
          this.logger.debug(`MINIMUM_PRICE_ACCEPTED detection failed: ${minPriceErr.message}`);
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

        // SAME-DAY ESCALATION: Once bot has agreed on everything, escalate to Daniel for final approval
        try {
          if (this.isSameDayRental(rental)) {
            // Check if a pickup time has been set (meaning bot has agreed on a time with the renter)
            const confirmedBooking = await this.prisma.booking.findFirst({
              where: { rental_id: rental.id, status: 'confirmed' },
              select: { pickup_time: true },
            });
            if (confirmedBooking?.pickup_time) {
              // Check we haven't already escalated this same-day rental
              const alreadyEscalated = await this.prisma.ai_decision.findFirst({
                where: { rental_id: rental.id, action_taken: 'same_day_escalated_to_daniel' },
              });
              if (!alreadyEscalated) {
                const rentalValue = rental.rental_price || 0;
                const extractedItemNames = (await this.prisma.extracteditem.findMany({
                  where: { rental_id: rental.id },
                  select: { item_name: true },
                })).map(i => i.item_name);
                const startDate = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Today';
                const endDate = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'TBC';

                this.telegramService.sendDecisionPrompt({
                  type: 'same_day',
                  rentalId: String(rental.id),
                  listingId: rental.listing_id,
                  account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
                  renterName: rental.renter_info || msg.sender || 'Unknown',
                  renterLastMessage: msg.content,
                  contextSummary: `Same-day rental £${rentalValue} for ${rental.title}. Items: ${extractedItemNames.join(', ') || rental.title}. Pickup: ${confirmedBooking.pickup_time}. Bot has confirmed everything with the renter — awaiting your approval to accept on Hygglo.`,
                  displayText:
                    `\u26a1 *SAME-DAY RENTAL — Ready for Approval*\n\n` +
                    `\u251c \ud83d\udce6 ${rental.title}\n` +
                    `\u251c \ud83d\udc64 ${rental.renter_info || msg.sender || 'Unknown'}\n` +
                    `\u251c \ud83d\udcc5 ${startDate} to ${endDate}\n` +
                    `\u251c \ud83c\udfaf Items: ${extractedItemNames.join(', ') || 'See listing'}\n` +
                    `\u251c \u23f0 Pickup: ${confirmedBooking.pickup_time}\n` +
                    `\u2514 \ud83d\udcb0 Price: \u00a3${rentalValue}\n\n` +
                    `Bot has confirmed items, time, and details with the renter. Waiting for your go-ahead to accept.`,
                  holdMessageSent: true,
                  options: [
                    { label: 'Accept rental', emoji: '\u2705', intent: 'approve', aiInstruction: `Daniel approves this same-day rental. The booking will now be accepted on Hygglo. Draft a brief confirmation to the renter: "All confirmed — see you at ${confirmedBooking.pickup_time} today!"` },
                    { label: 'Decline', emoji: '\u274c', intent: 'decline', aiInstruction: 'Daniel declines this same-day rental. Draft a polite message explaining that unfortunately this pickup slot is no longer available today. Apologise and wish them well.' },
                    { label: 'Respond manually', emoji: '\ud83d\udc41', intent: 'custom', aiInstruction: '' },
                  ],
                });

                await this.prisma.ai_decision.create({
                  data: {
                    rental_id: rental.id,
                    decision_type: 'escalate',
                    input_summary: `same_day_ready: ${rental.title} pickup ${confirmedBooking.pickup_time}`,
                    output_summary: `Same-day rental ready for Daniel's approval. Bot confirmed items+time with renter.`,
                    confidence: 1.0,
                    action_taken: 'same_day_escalated_to_daniel',
                    notified: true,
                    was_sent: null,
                  },
                });

                this.logger.log(`SAME-DAY ESCALATION: ${rental.title} — pickup ${confirmedBooking.pickup_time}, £${rentalValue} — sent to Daniel for approval`);
              }
            }
          }
        } catch (sameDayErr) {
          this.logger.debug(`Same-day escalation check failed: ${sameDayErr.message}`);
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
    const timePatterns = /\b(\d{1,2}\s*(am|pm|:\d{2})|\bpickup\b|\breturn\b|\bcollect\b|\bdrop\s*off\b|\bbring\s*back\b|\breturning\b|\bmorning\b|\bevening\b|\bafternoon\b|\bnoon\b|\bmidday\b|\blater\b|\btbd\b|\bconfirm\b|\bdecide\b|\bnot\s+sure\b)/i;
    if (!timePatterns.test(content)) return;

    // TIMES LOCKED GATE: Once both pickup AND return are confirmed, time changes
    // must be escalated to Daniel — never auto-accepted by the system.
    const existingBooking = await this.prisma.booking.findFirst({
      where: { rental_id: rental.id, status: 'confirmed' },
      select: { pickup_time: true, return_time: true, item_name: true, start_date: true, end_date: true },
    });
    const timesAlreadyConfirmed = !!(existingBooking?.pickup_time && existingBooking?.return_time);

    // Deferral detection: if renter defers while we still need times, push back firmly
    if (!timesAlreadyConfirmed && this.detectTimeDeferral(content)) {
      const missingBoth = !existingBooking?.pickup_time && !existingBooking?.return_time;
      const missing = missingBoth ? 'pickup and return times'
        : !existingBooking?.pickup_time ? 'pickup time' : 'return time';
      this.logger.log(`Time deferral detected from ${msg.sender} for ${rental.title}, still need ${missing}`);
      if (!this.isWriteBlocked(msg.rentalId)) {
        try {
          await this.hyggloService.sendMessage(msg.rentalId,
            `I do need your exact ${missing} to lock in the booking — we have morning slots (10am-12pm) and evening slots (7pm-9pm). Which works best for you?`);
        } catch { /* best-effort */ }
      }
      return;
    }

    if (timesAlreadyConfirmed) {
      // Check if the message actually proposes a NEW time (not just discussing existing ones)
      const regexCheck = this.tryRegexTimeExtraction(content);
      if (regexCheck) {
        const proposedPickup = regexCheck.pickupTime;
        const proposedReturn = regexCheck.returnTime;
        const isNewPickup = proposedPickup && proposedPickup !== existingBooking.pickup_time;
        const isNewReturn = proposedReturn && proposedReturn !== existingBooking.return_time;

        if (isNewPickup || isNewReturn) {
          // Check if proposed time has a hard conflict (items needed on another rental, <1h buffer, no stock)
          const conflictItems: string[] = [];
          const bookings = await this.prisma.booking.findMany({
            where: { rental_id: rental.id, status: 'confirmed' },
          });
          for (const bk of bookings) {
            if (isNewReturn && proposedReturn && bk.end_date) {
              const conflict = await this.calendarService.checkTimeConflict(
                bk.item_name, bk.end_date, proposedReturn, 'return', rental.id,
              );
              if (conflict.conflict) conflictItems.push(bk.item_name);
            }
            if (isNewPickup && proposedPickup && bk.start_date) {
              const conflict = await this.calendarService.checkTimeConflict(
                bk.item_name, bk.start_date, proposedPickup, 'pickup', rental.id,
              );
              if (conflict.conflict) conflictItems.push(bk.item_name);
            }
          }

          if (conflictItems.length > 0) {
            // Auto-deny: items needed on another rental with <1h buffer
            this.logger.warn(`TIME CHANGE AUTO-DENIED for ${rental.title}: conflict on ${conflictItems.join(', ')}`);
            if (!this.isWriteBlocked(msg.rentalId)) {
              try {
                await this.hyggloService.sendMessage(msg.rentalId,
                  `Sorry, that time change won't work — those items are needed for another rental and there isn't enough buffer time. The confirmed times are pickup at ${existingBooking.pickup_time} and return at ${existingBooking.return_time}.`);
              } catch { /* best-effort */ }
            }
            return;
          }

          // No hard conflict, but still escalate to Daniel — never auto-accept time changes
          const changeDesc = [
            isNewPickup ? `pickup ${existingBooking.pickup_time} → ${proposedPickup}` : '',
            isNewReturn ? `return ${existingBooking.return_time} → ${proposedReturn}` : '',
          ].filter(Boolean).join(', ');

          this.logger.log(`TIME CHANGE ESCALATED for ${rental.title}: ${changeDesc}`);
          this.telegramService.sendDecisionPrompt({
            type: 'escalation',
            rentalId: String(rental.id),
            listingId: msg.rentalId,
            account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
            renterName: msg.sender || rental.renter_info || 'Unknown',
            renterLastMessage: content,
            contextSummary: `Time change request: ${changeDesc}. Current confirmed: pickup ${existingBooking.pickup_time}, return ${existingBooking.return_time}`,
            displayText:
              `\u23f0 *TIME CHANGE REQUEST*\n\n` +
              `\u251c \ud83d\udce6 ${rental.title}\n` +
              `\u251c \ud83d\udc64 ${msg.sender || rental.renter_info || 'Unknown'}\n` +
              `\u251c \ud83d\udcc5 Current: pickup ${existingBooking.pickup_time}, return ${existingBooking.return_time}\n` +
              `\u2514 \u27a1\ufe0f Requested: ${changeDesc}\n\n` +
              `\ud83d\udcac "${content.substring(0, 200)}"`,
            holdMessageSent: true,
            options: [
              { label: 'Approve change', emoji: '\u2705', intent: 'approve', aiInstruction: `Update the booking times as requested: ${changeDesc}` },
              { label: 'Keep current times', emoji: '\u274c', intent: 'decline', aiInstruction: `Inform the renter the time change was not approved. Current times remain: pickup ${existingBooking.pickup_time}, return ${existingBooking.return_time}` },
              { label: 'Respond manually', emoji: '\ud83d\udc41', intent: 'custom', aiInstruction: '' },
            ],
          });

          // Tell renter we're checking
          if (!this.isWriteBlocked(msg.rentalId)) {
            try {
              await this.hyggloService.sendMessage(msg.rentalId,
                `Let me check on that time change and get back to you.`);
            } catch { /* best-effort */ }
          }

          // Store the requested change in memory for chat reference
          await this.memoryService.storeMemory('fact',
            `Time change requested: ${rental.title}`,
            `${msg.sender} requested time change: ${changeDesc}. Awaiting Daniel's approval. Original times: pickup ${existingBooking.pickup_time}, return ${existingBooking.return_time}.`,
            8,
          );
          return; // Don't overwrite confirmed times
        }
      }
      // If no new time detected, just return — existing times stay locked
      return;
    }

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

    // Check if message has date-like content that regex should have captured
    const hasDateContent = /\b\d{1,2}\/\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\s*(?:of\s*)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(content)
      || /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|day\s*before)\b/i.test(content);

    if (regexResult && regexResult.confidence === 'high' && (regexResult.pickupTime || regexResult.returnTime)) {
      pickupTime = regexResult.pickupTime;
      returnTime = regexResult.returnTime;
      confidence = 'high';
      // If regex found times but missed dates and message has date content,
      // fall through to AI for date-only extraction
      if (hasDateContent && !regexResult.pickupDate && !regexResult.returnDate) {
        this.logger.debug(`Regex found times but missed dates for ${msg.sender}, using AI for date extraction`);
        try {
          const datePrompt =
            `Extract ONLY the pickup and return DATES from this renter message.\n\n` +
            `Renter message: "${content}"\n` +
            `Rental: ${rental.title}\n` +
            `Rental period: ${rental.start_date ? new Date(rental.start_date).toISOString().split('T')[0] : '?'} to ${rental.end_date ? new Date(rental.end_date).toISOString().split('T')[0] : '?'}\n\n` +
            `CRITICAL:\n` +
            `- Pickup can be the EVENING BEFORE the rental starts (common for evening pickups)\n` +
            `- DD/MM means day/month (European format), NOT month/day\n` +
            `- "22/02" means 22 February, "the 22nd" means the 22nd of the rental month\n` +
            `- If the renter mentions a date before the rental start, it's likely an evening-before pickup\n\n` +
            `Respond ONLY:\n` +
            `PICKUP_DATE: YYYY-MM-DD or NONE\n` +
            `RETURN_DATE: YYYY-MM-DD or NONE`;
          const dateResponse = await this.aiService.processExtraction(datePrompt);
          pickupDateMatch = dateResponse.content.match(/PICKUP_DATE:\s*(\d{4}-\d{2}-\d{2})/);
          returnDateMatch = dateResponse.content.match(/RETURN_DATE:\s*(\d{4}-\d{2}-\d{2})/);
        } catch { /* best-effort — dates are supplementary */ }
      } else {
        // Wire regex dates through as synthetic matches for downstream code
        if (regexResult.pickupDate) pickupDateMatch = [regexResult.pickupDate, regexResult.pickupDate] as unknown as RegExpMatchArray;
        if (regexResult.returnDate) returnDateMatch = [regexResult.returnDate, regexResult.returnDate] as unknown as RegExpMatchArray;
      }
      this.logger.debug(`Regex extraction succeeded for ${msg.sender}: pickup=${pickupTime}, return=${returnTime}, pDate=${pickupDateMatch?.[1]}, rDate=${returnDateMatch?.[1]}`);
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
        `IGNORE these — they are NOT pickup/return times:\n` +
        `- Arrival ETAs: "on my way, be there at 11:32", "5 mins away", "arriving at 3"\n` +
        `- Addresses: "11 trafalgar square", "at number 7"\n` +
        `- If the message is about arriving/being on the way, return ALL BLANK\n\n` +
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

    // Slot enforcement: times must be within morning (10-12) or evening (7-9) windows
    const pickupOutsideSlot = pickupTime && !this.isWithinSlot(pickupTime);
    const returnOutsideSlot = returnTime && !this.isWithinSlot(returnTime);
    if (pickupOutsideSlot || returnOutsideSlot) {
      const parts: string[] = [];
      if (pickupOutsideSlot) parts.push(`pickup at ${pickupTime}`);
      if (returnOutsideSlot) parts.push(`return at ${returnTime}`);
      this.logger.log(`Time(s) outside slots for ${rental.title}: ${parts.join(', ')}, redirecting renter`);
      if (!this.isWriteBlocked(msg.rentalId)) {
        try {
          await this.hyggloService.sendMessage(msg.rentalId,
            `I can only do morning (10am-12pm) or evening (7pm-9pm) for pickups and returns. Could you pick a time in one of those windows?`);
        } catch { /* best-effort */ }
      }
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

    // Update booking times + dates
    const pickupDateStr = pickupDateMatch ? pickupDateMatch[1] : undefined;
    const returnDateStr = returnDateMatch ? returnDateMatch[1] : undefined;
    const updated = await this.calendarService.updateBookingTimes(rental.id, pickupTime, returnTime, pickupDateStr, returnDateStr);

    if (!updated || updated.count === 0) {
      this.logger.debug(`No bookings updated for rental ${rental.id} (may not have linked bookings yet)`);
    }

    // Extension detection: if pickup/return dates fall outside rental period, alert Daniel
    const rentalStartDate = rental.start_date ? new Date(rental.start_date) : null;
    const rentalEndDate = rental.end_date ? new Date(rental.end_date) : null;

    if (rentalStartDate && pickupDateStr) {
      const pDate = new Date(pickupDateStr);
      const daysBefore = (rentalStartDate.getTime() - pDate.getTime()) / 86400000;
      // Evening-before pickup (≤1 day early) is normal. More than that needs extension.
      if (daysBefore > 1.5) {
        this.logger.warn(`Extension needed: ${rental.title} pickup ${pickupDateStr} is ${daysBefore.toFixed(1)}d before start`);
        this.telegramService.sendDecisionPrompt({
          type: 'escalation',
          rentalId: String(rental.id),
          listingId: msg.rentalId,
          account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
          renterName: msg.sender || rental.renter_info || 'Unknown',
          renterLastMessage: content,
          contextSummary: `Pickup ${pickupDateStr} is ${daysBefore.toFixed(0)}d before rental start ${rentalStartDate.toISOString().slice(0, 10)}. Extension needed?`,
          displayText:
            `\ud83d\udcc5 *EXTENSION MAY BE NEEDED*\n\n` +
            `\u251c \ud83d\udce6 ${rental.title}\n` +
            `\u251c \ud83d\udc64 ${msg.sender || rental.renter_info}\n` +
            `\u251c \ud83d\udcc5 Rental: ${rentalStartDate.toISOString().slice(0, 10)} to ${rentalEndDate?.toISOString().slice(0, 10) || '?'}\n` +
            `\u2514 \u26a0\ufe0f Pickup: ${pickupDateStr} (${daysBefore.toFixed(0)} days early)`,
          holdMessageSent: false,
          options: [
            { label: 'Book extension', emoji: '\ud83d\udcc5', intent: 'approve', aiInstruction: `Book extension to cover pickup date ${pickupDateStr}` },
            { label: 'Accept as-is', emoji: '\u2705', intent: 'approve', aiInstruction: `Accept early pickup without extension` },
            { label: 'Ask renter to adjust', emoji: '\ud83d\udcac', intent: 'custom', aiInstruction: '' },
          ],
        });
      }
    }
    if (rentalEndDate && returnDateStr) {
      const rDate = new Date(returnDateStr);
      const daysAfter = (rDate.getTime() - rentalEndDate.getTime()) / 86400000;
      if (daysAfter > 0.5) {
        this.logger.warn(`Extension needed: ${rental.title} return ${returnDateStr} is ${daysAfter.toFixed(1)}d after end`);
        this.telegramService.sendDecisionPrompt({
          type: 'escalation',
          rentalId: String(rental.id),
          listingId: msg.rentalId,
          account: (rental.account as 'dbcinema' | 'leo') || 'dbcinema',
          renterName: msg.sender || rental.renter_info || 'Unknown',
          renterLastMessage: content,
          contextSummary: `Return ${returnDateStr} is ${daysAfter.toFixed(0)}d after rental end ${rentalEndDate.toISOString().slice(0, 10)}. Extension needed?`,
          displayText:
            `\ud83d\udcc5 *EXTENSION MAY BE NEEDED*\n\n` +
            `\u251c \ud83d\udce6 ${rental.title}\n` +
            `\u251c \ud83d\udc64 ${msg.sender || rental.renter_info}\n` +
            `\u251c \ud83d\udcc5 Rental: ${rentalStartDate?.toISOString().slice(0, 10) || '?'} to ${rentalEndDate.toISOString().slice(0, 10)}\n` +
            `\u2514 \u26a0\ufe0f Return: ${returnDateStr} (${daysAfter.toFixed(0)} days late)`,
          holdMessageSent: false,
          options: [
            { label: 'Book extension', emoji: '\ud83d\udcc5', intent: 'approve', aiInstruction: `Book extension to cover return date ${returnDateStr}` },
            { label: 'Accept as-is', emoji: '\u2705', intent: 'approve', aiInstruction: `Accept late return without extension` },
            { label: 'Ask renter to adjust', emoji: '\ud83d\udcac', intent: 'custom', aiInstruction: '' },
          ],
        });
      }
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
        replyMsg += ` I still need your ${missing} time — morning (10am-12pm) or evening (7pm-9pm) slots available. Which works?`;
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
      `- If no times were discussed at all, output NONE for both.\n` +
      `- IMPORTANT: Do NOT confuse arrival ETAs ("I'll be there at 20:32", "on my way, 10 mins") with the AGREED pickup/return time slot. ETAs are ad-hoc and should be IGNORED.\n` +
      `- If the renter corrected themselves (e.g., first said 11am then 8pm), use the LAST corrected time.\n\n` +
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

    // 3. GUARD: Don't overwrite already-confirmed times with potentially wrong AI extraction.
    //    If both times are already set, only update dates (which are supplementary).
    //    Existing times come from real-time regex extraction on the actual message — more reliable.
    const existingBooking = await this.prisma.booking.findFirst({
      where: { rental_id: rental.id, status: { in: ['confirmed', 'pending_review'] } },
      select: { pickup_time: true, return_time: true, pickup_date: true, return_date: true },
    });
    if (existingBooking?.pickup_time && existingBooking?.return_time) {
      // Both times already set — only update dates if they're missing
      const needPickupDate = !existingBooking.pickup_date && pickupDate;
      const needReturnDate = !existingBooking.return_date && returnDate;
      if (needPickupDate || needReturnDate) {
        await this.calendarService.updateBookingTimes(
          rental.id,
          undefined, // don't touch pickup_time
          undefined, // don't touch return_time
          needPickupDate ? pickupDate : undefined,
          needReturnDate ? returnDate : undefined,
        );
        this.logger.log(`extractTimesFromChatHistory: times already set for ${rental.title}, only updated dates: pDate=${pickupDate}, rDate=${returnDate}`);
      } else {
        this.logger.debug(`extractTimesFromChatHistory: skipping ${rental.title} — times already confirmed (pickup=${existingBooking.pickup_time}, return=${existingBooking.return_time})`);
      }
      return { pickupTime: existingBooking.pickup_time, returnTime: existingBooking.return_time, pickupDate, returnDate };
    }

    // Only update times that are currently missing
    const finalPickup = existingBooking?.pickup_time ? undefined : pickupTime;
    const finalReturn = existingBooking?.return_time ? undefined : returnTime;
    if (finalPickup || finalReturn || pickupDate || returnDate) {
      await this.calendarService.updateBookingTimes(rental.id, finalPickup, finalReturn, pickupDate, returnDate);
    }

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
    // Capture everything after MESSAGE: to end of response (message may be on the next line)
    const messageMatch = aiResponse.match(/MESSAGE:\s*\n?([\s\S]+)/i);

    if (messageMatch) {
      let messageText = messageMatch[1].trim();

      // Strip any markdown bold wrappers the AI might add (authority says plain text only)
      messageText = messageText.replace(/^\*\*(.+?)\*\*$/s, '$1').trim();

      // Guard: reject messages that are clearly internal AI decisions, not customer-facing text
      // Broadened patterns to catch edge cases like "None - escalate to Daniel first."
      const internalPatterns = /^(none|n\/a|no message|escalate|flag|skip|defer|internal|notify|wait|hold|pending|approve|reject|block|analysis|recommend|action|review|check)/i;
      const looksInternal = internalPatterns.test(messageText.trim())
        || messageText.length < 10
        || /\b(escalate|flag for review|no action|no message needed)\b/i.test(messageText);
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

  // Every 30 min: scan confirmed/upcoming rentals and extract missing times from chat history
  @Cron('5,35 * * * *')
  async autoExtractAndFixTimes() {
    try {
      const now = new Date();
      const next7d = new Date(now.getTime() + 7 * 86400000);

      // Find confirmed bookings with missing times starting within 7 days or ongoing
      const bookingsNeedingTimes = await this.prisma.booking.findMany({
        where: {
          status: 'confirmed',
          OR: [
            { start_date: { gte: now, lte: next7d } },
            { start_date: { lte: now }, end_date: { gte: now } },
          ],
          AND: [{ OR: [{ pickup_time: null }, { return_time: null }] }],
        },
        include: { rental: true },
      });

      if (bookingsNeedingTimes.length === 0) return;

      // Group by rental to avoid duplicate extraction
      const rentalIds = [...new Set(bookingsNeedingTimes.map(b => b.rental_id).filter(Boolean))] as string[];
      let extracted = 0;
      let failed = 0;

      for (const rentalId of rentalIds) {
        const rental = bookingsNeedingTimes.find(b => b.rental_id === rentalId)?.rental;
        if (!rental) continue;

        try {
          const result = await this.extractTimesFromChatHistory(rental);
          if (result && (result.pickupTime || result.returnTime)) {
            extracted++;
            this.logger.log(
              `autoExtract: found times for ${rental.title}: pickup=${result.pickupTime || 'N/A'}, return=${result.returnTime || 'N/A'}`,
            );
          }
        } catch (err) {
          failed++;
          this.logger.warn(`autoExtract failed for ${rental.title}: ${err.message}`);
        }

        // Rate limit: small delay between rentals to avoid API hammering
        await new Promise(r => setTimeout(r, 1000));
      }

      if (extracted > 0 || failed > 0) {
        this.logger.log(`autoExtract cron: ${extracted} extracted, ${failed} failed out of ${rentalIds.length} rentals`);
      }
    } catch (error) {
      this.logger.error(`autoExtractAndFixTimes cron error: ${error.message}`);
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
