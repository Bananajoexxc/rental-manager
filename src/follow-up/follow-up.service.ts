import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PlaywrightService } from '../playwright/playwright.service';
import { TelegramService } from '../telegram/telegram.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { AiService } from '../ai/ai.service';
import { CalendarService } from '../calendar/calendar.service';
import { ConversationStageService } from '../conversation-tree/conversation-stage.service';
import { ContentionService } from '../contention/contention.service';
import { MemoryService } from '../memory/memory.service';
import { CouponService } from '../coupon/coupon.service';

type HyggloAccount = 'dbcinema' | 'leo';

/**
 * Extract clean item name from rental's parsed_items JSON.
 * Falls back to title if parsed_items unavailable.
 * "Sony FX3 + 24-70mm GM" instead of SEO-bloated listing titles.
 */
function getCleanItemName(rental: any): string {
  if (rental?.parsed_items && Array.isArray(rental.parsed_items)) {
    const items = (rental.parsed_items as any[])
      .filter((pi: any) => pi.item)
      .map((pi: any) => pi.qty > 1 ? `${pi.qty}x ${pi.item}` : pi.item);
    if (items.length > 0) return items.join(' + ');
  }
  return rental?.title || 'the rental';
}

export interface ConversationState {
  confirmedItems?: string[];        // Items renter confirmed interest in
  agreedPickupTime?: string;        // e.g. "Friday 2pm"
  agreedReturnTime?: string;
  renterShootType?: string;         // e.g. "wedding", "corporate"
  questionsAsked?: string[];        // Questions bot has already asked (avoid repeating)
  upsellAttempted?: boolean;        // Whether we've already tried upselling
  upsellItems?: string[];           // What was upsold
  priceQuoted?: number;             // Last price quoted
  deliveryDiscussed?: boolean;
  unavailabilityMentioned?: boolean; // Whether bot already told renter about item unavailability
  rentalNotes?: string[];           // Noteworthy details: extras requested, special conditions, delivery preferences, anything owner should know

  // Negotiation intelligence
  priceObjectionCount?: number;       // how many times renter pushed back on price
  lastPriceOffered?: number;          // last £ amount bot quoted
  negotiationStance?: 'firm' | 'flexible' | 'yield';
  competitorMentioned?: boolean;      // renter mentioned seeing it cheaper
}

@Injectable()
export class FollowUpService {
  private readonly logger = new Logger(FollowUpService.name);
  private isCheckingFollowUps = false;

  constructor(
    private prisma: PrismaService,
    private playwrightService: PlaywrightService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private hyggloService: HyggloService,
    private aiService: AiService,
    private calendarService: CalendarService,
    private conversationStageService: ConversationStageService,
    private contentionService: ContentionService,
    private memoryService: MemoryService,
    private couponService: CouponService,
  ) {}

  /**
   * Initialize follow-up state for a new rental.
   */
  async initializeFollowUpState(rentalId: string): Promise<void> {
    const existing = await this.prisma.follow_up_state.findUnique({
      where: { rental_id: rentalId },
    });

    if (existing) {
      this.logger.debug(`Follow-up state already exists for rental ${rentalId}`);
      return;
    }

    await this.prisma.follow_up_state.create({
      data: {
        rental_id: rentalId,
        status: 'active',
        conversation_stage: 'inquiry',
      },
    });

    this.logger.debug(`Initialized follow-up state for rental ${rentalId}`);
  }

  /**
   * Get the structured conversation state for a rental.
   */
  async getStructuredState(rentalId: string): Promise<ConversationState> {
    const state = await this.prisma.follow_up_state.findUnique({
      where: { rental_id: rentalId },
      select: { structured_state: true },
    });
    return (state?.structured_state as ConversationState) || {};
  }

  /**
   * Merge partial state changes into the existing structured state.
   * Array fields (confirmedItems, questionsAsked, upsellItems) are appended (deduplicated), not replaced.
   */
  async mergeStructuredState(rentalId: string, changes: Partial<ConversationState>): Promise<void> {
    const current = await this.getStructuredState(rentalId);
    const merged = { ...current, ...changes };
    // Array fields: merge (append unique), don't replace
    const arrayFields: (keyof ConversationState)[] = ['confirmedItems', 'questionsAsked', 'upsellItems', 'rentalNotes'];
    for (const field of arrayFields) {
      const currentArr = current[field] as string[] | undefined;
      const changesArr = changes[field] as string[] | undefined;
      if (changesArr && currentArr) {
        if (field === 'rentalNotes') {
          // Special handling: fuzzy dedup + cap at 8 notes
          const existing = [...currentArr];
          const newNotes: string[] = [];
          for (const note of changesArr) {
            const noteWords = new Set(note.toLowerCase().split(/\s+/));
            const dupIdx = existing.findIndex(e => {
              const eWords = new Set(e.toLowerCase().split(/\s+/));
              const intersection = [...noteWords].filter(w => eWords.has(w)).length;
              return intersection / Math.max(noteWords.size, eWords.size) > 0.7;
            });
            if (dupIdx >= 0) {
              existing[dupIdx] = note; // replace with newer wording
            } else {
              newNotes.push(note);
            }
          }
          const combined = [...existing, ...newNotes];
          (merged as any)[field] = combined.slice(-8); // keep last 8
        } else {
          (merged as any)[field] = [...new Set([...currentArr, ...changesArr])];
        }
      }
    }
    await this.prisma.follow_up_state.update({
      where: { rental_id: rentalId },
      data: { structured_state: merged },
    });
  }

  /**
   * Cron: Check all active follow-up states every hour.
   * Skip quiet hours (2am-7am).
   * Follow-up thresholds are 3h/10h/18h/26h — hourly granularity loses nothing.
   */
  @Cron('0 * * * *')
  async checkFollowUps(): Promise<void> {
    if (this.isCheckingFollowUps) {
      this.logger.debug('checkFollowUps: previous check still in progress, skipping');
      return;
    }
    this.isCheckingFollowUps = true;
    try {
    // Skip quiet hours
    const hour = new Date().getHours();
    if (hour >= 2 && hour < 7) {
      this.isCheckingFollowUps = false;
      return;
    }

    // Contention urgency + timeout checks (piggyback on follow-up cron)
    try {
      await this.contentionService.evaluateUrgency();
      await this.contentionService.checkTimeouts();
    } catch (err) {
      this.logger.error(`Contention check error: ${err.message}`);
    }

    try {
      const activeStates = await this.prisma.follow_up_state.findMany({
        where: {
          status: 'active',
          conversation_stage: { notIn: ['dead', 'completed'] },
        },
        include: {
          rental: {
            select: {
              id: true, title: true, status: true, order_step: true,
              listing_id: true, renter_info: true, account: true,
              start_date: true, end_date: true, listing_location: true,
            },
          },
        },
      });

      for (const state of activeStates) {
        try {
          // Skip returned/completed rentals — never follow up after return
          const rentalStatus = state.rental?.status;
          const orderStep = state.rental?.order_step;
          if (
            rentalStatus === 'completed' ||
            orderStep === 'RETURNED' ||
            orderStep === 'REVIEWED'
          ) {
            continue;
          }
          await this.evaluateFollowUpState(state);
        } catch (error) {
          this.logger.warn(`Error evaluating follow-up for rental ${state.rental_id}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`checkFollowUps cron error: ${error.message}`);
    }
    } finally {
      this.isCheckingFollowUps = false;
    }
  }

  /**
   * Evaluate a single follow-up state and take appropriate action.
   */
  private async evaluateFollowUpState(state: any): Promise<void> {
    const now = new Date();

    // 1. Custom reminder: if set and future -> skip
    if (state.custom_reminder_at) {
      const reminderTime = new Date(state.custom_reminder_at);
      if (reminderTime > now) {
        return; // Wait for custom reminder time
      }

      // Custom reminder time has passed -> send the check-in
      await this.sendFollowUp(state, state.rental, `custom_reminder: ${state.custom_reminder_reason || 'scheduled check-in'}`);

      // Clear the custom reminder, resume normal flow
      await this.prisma.follow_up_state.update({
        where: { id: state.id },
        data: {
          custom_reminder_at: null,
          custom_reminder_reason: null,
        },
      });
      return;
    }

    // 1b. Check if delivery T&Cs should be sent (one message per cycle)
    try {
      await this.checkDeliveryTCs(state, state.rental);
      // Guard: if T&Cs were just sent, limit to one outbound message per cycle
      const tcJustSent = await this.prisma.ai_decision.findFirst({
        where: {
          rental_id: state.rental_id,
          input_summary: { contains: 'delivery_tcs_sent' },
          created_at: { gte: new Date(Date.now() - 10_000) },
        },
      });
      if (tcJustSent) return;
    } catch (tcErr) {
      this.logger.debug(`Delivery T&Cs check failed: ${tcErr.message}`);
    }

    // 1c. Check if time-specific follow-up is needed (separate cadence from general follow-ups)
    try {
      const timeFollowUpSent = await this.evaluateTimeFollowUp(state, state.rental);
      if (timeFollowUpSent) return; // Time follow-up handled this cycle
    } catch (tfErr) {
      this.logger.debug(`Time follow-up check failed: ${tfErr.message}`);
    }

    // 1b. Contention hold: if rental is held, skip all follow-ups
    try {
      const holdCheck = await this.contentionService.isHeld(state.rental_id);
      if (holdCheck.held) return;
    } catch { /* non-critical */ }

    // 1c. Skip follow-up if item is unavailable and renter was already told
    try {
      const ss = state.structured_state as any;
      if (ss?.unavailabilityMentioned) {
        this.logger.debug(`Skipping follow-up for ${state.rental_id}: item unavailable, already told renter`);
        return;
      }
    } catch { /* non-critical */ }

    // 1d. Skip follow-up if bot's last message ends with a question (we're waiting, not them)
    try {
      if (state.last_bot_message_at && state.last_renter_message_at) {
        const botTime = new Date(state.last_bot_message_at).getTime();
        const renterTime = new Date(state.last_renter_message_at).getTime();
        if (botTime > renterTime) {
          const lastBotMsg = await this.prisma.conversation.findFirst({
            where: { chat_id: state.rental?.listing_id, role: 'assistant' },
            orderBy: { created_at: 'desc' },
            select: { content: true },
          });
          if (lastBotMsg?.content?.trim().endsWith('?')) {
            this.logger.debug(`Skipping follow-up for ${state.rental_id}: bot has a pending question`);
            return;
          }
        }
      }
    } catch { /* non-critical */ }

    // 1e. Skip follow-up if bot's last message mentions unavailability (catch cases where structured_state flag wasn't set)
    try {
      const lastBotMsg = await this.prisma.conversation.findFirst({
        where: { chat_id: state.rental?.listing_id, role: 'assistant' },
        orderBy: { created_at: 'desc' },
        select: { content: true },
      });
      if (lastBotMsg?.content) {
        const botText = lastBotMsg.content.toLowerCase();
        const unavailablePatterns = [
          /(not available|unavailable|out of stock|don'?t have|don'?t currently have|no longer available)/,
          /(fully booked|all rented out|already rented|booked out|currently on hire|currently rented)/,
          /(unfortunately.*(?:can'?t|cannot|unable).*(?:offer|provide|help with that))/,
        ];
        if (unavailablePatterns.some(p => p.test(botText))) {
          this.logger.debug(`Skipping follow-up for ${state.rental_id}: bot's last message indicates item unavailability`);
          return;
        }
      }
    } catch { /* non-critical */ }

    // 1f. Skip follow-up if renter's last message signals conversation is over (disinterest/closure)
    try {
      const lastRenterMsg = await this.prisma.conversation.findFirst({
        where: { chat_id: state.rental?.listing_id, role: 'user' },
        orderBy: { created_at: 'desc' },
        select: { content: true },
      });
      if (lastRenterMsg?.content) {
        const renterText = lastRenterMsg.content.toLowerCase().trim();
        const closurePatterns = [
          /(no\s*(thanks|thank you|worries|problem|it'?s? ?(ok|fine|alright|all good)))/,
          /(i'?ll (look|find|search|try|go) (elsewhere|somewhere else|another|other))/,
          /(that'?s? ?(ok|fine|alright)|never ?mind|not to worry)/,
          /(don'?t (need|want|worry|bother)|not interested|changed my mind)/,
          /(found (one|it|something|another)|got (one|it|sorted)|sorted (it|now|thanks))/,
          /(thanks anyway|thank you anyway|cheers anyway)/,
          /(all good|no need|won'?t be needing)/,
        ];
        if (closurePatterns.some(p => p.test(renterText))) {
          this.logger.debug(`Skipping follow-up for ${state.rental_id}: renter's last message indicates conversation is over`);
          return;
        }
      }
    } catch { /* non-critical */ }

    // 2. Paused until: if set and future -> skip
    if (state.paused_until) {
      const pauseEnd = new Date(state.paused_until);
      if (pauseEnd > now) {
        return;
      }

      // Pause expired, clear it
      await this.prisma.follow_up_state.update({
        where: { id: state.id },
        data: { paused_until: null },
      });
    }

    // 3. Calculate time since last renter message
    if (!state.last_renter_message_at) {
      return; // No renter message yet, nothing to follow up on
    }

    // Bot must have sent at least one message before we can follow up
    // (prevents following up on threads where the first response hasn't been sent yet)
    if (!state.last_bot_message_at) {
      return;
    }

    const lastRenterMsgTime = new Date(state.last_renter_message_at);
    const botMsgTime = new Date(state.last_bot_message_at);

    // Only follow up if the bot has already responded to the renter's last message
    if (botMsgTime < lastRenterMsgTime) {
      // Bot hasn't responded to the renter's last message yet — skip follow-up
      return;
    }

    const hoursSinceRenter = (now.getTime() - lastRenterMsgTime.getTime()) / (1000 * 60 * 60);

    // 3b. Skip generic inactivity follow-ups for CONFIRMED or BOOKED rentals.
    // Once booking is confirmed or funds are reserved, "still interested?" messages are wrong.
    // Time-specific follow-ups (evaluateTimeFollowUp) handle confirmed rentals separately above.
    const convStage = (state.conversation_stage || '').toLowerCase();
    const orderStep = (state.rental?.order_step || '').toUpperCase();
    const isConfirmedOrBooked =
      convStage === 'confirmed' ||
      convStage === 'booked' ||
      ['FUNDS_RESERVED', 'VERIFIED', 'BOOKED_AFTER_VERIFIED', 'DELIVERED'].includes(orderStep);
    if (isConfirmedOrBooked) {
      this.logger.verbose(`Skipping inactivity follow-up for ${state.rental_id}: stage is ${convStage} / order_step is ${orderStep} (only time follow-ups apply)`);
      return;
    }

    // 4. Less than 3 hours -> skip (first follow-up at 3h)
    if (hoursSinceRenter < 3) {
      return;
    }

    // 5. Check spacing: don't send follow-ups too close together
    if (state.last_bot_followup_at) {
      const lastFollowupTime = new Date(state.last_bot_followup_at);
      const hoursSinceFollowup = (now.getTime() - lastFollowupTime.getTime()) / (1000 * 60 * 60);

      // Second follow-up: 10 hours after the first
      if (state.followup_count === 1 && hoursSinceFollowup < 10) {
        return;
      }
      // Save attempt: wait for 18h since last renter message
      if (state.followup_count === 2) {
        return; // Handled by the 18h check below
      }
      // After save: wait for DEAD threshold
      if (state.followup_count >= 3) {
        return; // Handled by DEAD check below
      }
    }

    // 6. 3+ hours AND followup_count === 0 -> send first follow-up
    if (hoursSinceRenter >= 3 && state.followup_count === 0) {
      await this.sendFollowUp(state, state.rental, 'inactivity_1');
      return;
    }

    // 7. followup_count === 1 AND 10h+ since last follow-up -> attempt alt conversion or send second follow-up
    if (state.followup_count === 1) {
      const ss = state.structured_state as any;
      if (ss?.alternatives_offered && ss?.alternative_items?.length > 0) {
        const converted = await this.attemptAlternativeConversion(state, state.rental);
        if (converted) return;
      }
      await this.sendFollowUp(state, state.rental, 'inactivity_2');
      return;
    }

    // 8. 18+ hours AND followup_count === 2 -> SAVE ATTEMPT (scarcity + bundle)
    if (hoursSinceRenter >= 18 && state.followup_count === 2) {
      await this.sendSaveAttempt(state, state.rental);
      return;
    }

    // 9. followup_count >= 3 AND auto_accept_eligible -> trigger auto-accept (2h after save)
    if (hoursSinceRenter >= 26 && state.followup_count >= 3 && state.auto_accept_eligible) {
      await this.triggerAutoAccept(state, state.rental);
      return;
    }

    // 10. followup_count >= 3 AND 24h+ -> mark as exhausted + DEAD
    if (hoursSinceRenter >= 24 && state.followup_count >= 3) {
      if (!state.auto_accepted) {
        // Store current stage before marking DEAD (for smart revival)
        const currentStage = state.conversation_stage || 'inquiry';
        await this.prisma.follow_up_state.update({
          where: { id: state.id },
          data: { auto_accepted: true, stage_before_dead: currentStage },
        });
        // Mark conversation as DEAD — follow-ups + save attempt exhausted
        try {
          await this.conversationStageService.setStage(state.rental_id, 'dead' as any);
          this.logger.log(`Follow-ups exhausted for ${state.rental?.title} — marked DEAD after ${state.followup_count} attempts (save attempt sent)`);
        } catch {
          this.logger.log(`Follow-ups exhausted for ${state.rental?.title} — no response after ${state.followup_count} attempts`);
        }

        // Detect price-related conversation death — log as lost revenue signal
        try {
          const ss = state.structured_state as any;
          if (ss?.priceObjectionCount >= 1) {
            await this.prisma.ai_decision.create({
              data: {
                rental_id: state.rental_id,
                decision_type: 'price_objection_lost',
                input_summary: `Conversation DEAD after ${ss.priceObjectionCount} price objection(s). Stance: ${ss.negotiationStance || 'unknown'}. Competitor: ${ss.competitorMentioned || false}. Last price: £${ss.lastPriceOffered || '?'}`,
                output_summary: `Lost: ${state.rental?.title || 'Unknown item'}`,
                confidence: 0.9,
                action_taken: 'price_objection_lost',
              },
            });
            this.logger.log(`Price objection lost revenue logged for ${state.rental?.title} (${ss.priceObjectionCount} objections)`);
          }
        } catch { /* non-critical */ }
      }
    }
  }

  /**
   * Send a follow-up message with distinct wording.
   */
  async sendFollowUp(state: any, rental: any, reason: string): Promise<void> {
    // Deterministic templates — no AI call needed, saves tokens
    const itemName = getCleanItemName(rental);
    const followupNumber = state.followup_count + 1;

    let followUpMessage: string;

    if (followupNumber === 1) {
      // Check conversation history for pricing objections → offer price match instead of generic FU1
      let hasPricingObjection = false;
      try {
        const chatId = `rental:${rental.id}`;
        const recentMessages = await this.prisma.conversation.findMany({
          where: { chat_id: chatId },
          orderBy: { created_at: 'desc' },
          take: 10,
          select: { content: true, role: true },
        });
        hasPricingObjection = recentMessages.some(m =>
          m.role === 'user' &&
          /too expensive|too much|cheaper|out of.*budget|can.?t afford|price.*high|bit much|over.*budget|pricey|steep|lower.*price|better.*price/i.test(m.content),
        );
      } catch {
        // Non-critical — fall through to generic template
      }

      // Check if listing is non-central → offer travel discount as recovery incentive
      let isNonCentral = false;
      if (rental?.listing_location) {
        const centralLocations = ['trafalgar', 'whitehall', 'central london', 'charing cross', 'pall mall', 'national gallery', 'westminster', 'covent garden'];
        const loc = rental.listing_location.toLowerCase();
        isNonCentral = !centralLocations.some(c => loc.includes(c));
      }

      if (hasPricingObjection) {
        followUpMessage = `Hey, just wanted to let you know — if you've seen the ${itemName} listed for less anywhere in central London (Zone 1-2), I can actually beat that price by 5%. Just send me a screenshot of the listing showing the item, price, and location and I'll sort it out!`;
        this.logger.log(`Price match offer sent for ${rental?.title} (pricing objection detected in conversation)`);
      } else if (isNonCentral) {
        followUpMessage = `Just checking in about the ${itemName}! By the way, since you'd be coming from the ${rental.listing_location} area, you'd get a 10% discount on this rental. Let me know if you'd like to go ahead or if you have any questions.`;
        this.logger.log(`Travel discount recovery sent for ${rental?.title} (non-central listing: ${rental.listing_location})`);
      } else {
        const checkInTemplates = [
          `Just checking in - let me know if you had any other questions about the ${itemName}! By the way, if getting to the pickup spot is tricky, I can also arrange delivery.`,
          `Hey — any thoughts on the ${itemName}? Happy to answer any questions or sort out dates if you're still interested.`,
          `Wanted to follow up on the ${itemName}. If you need help deciding or have any questions about the setup, just let me know!`,
        ];
        followUpMessage = checkInTemplates[Math.floor(Math.random() * checkInTemplates.length)];
      }
    } else {
      const reEngageTemplates = [
        `Still interested in the ${itemName}? Happy to hold it for you if needed.`,
        `Hey — just checking the ${itemName} is still on your radar? No rush, just want to make sure it's available when you need it.`,
        `Quick check — still thinking about the ${itemName}? Let me know if anything changed or if you want to go ahead.`,
      ];
      followUpMessage = reEngageTemplates[Math.floor(Math.random() * reEngageTemplates.length)];
    }

    // Send via Hygglo (sendMessage handles READ_ONLY_MODE with per-rental exceptions)
    try {
      await this.hyggloService.sendMessage(rental.listing_id, followUpMessage);
      await this.memoryService.storeConversation(`rental:${rental.id}`, 'assistant', followUpMessage, { model: 'follow-up' });
    } catch (error) {
      this.logger.warn(`Failed to send follow-up for ${rental.title}: ${error.message}`);
    }

    // Update state
    await this.prisma.follow_up_state.update({
      where: { id: state.id },
      data: {
        followup_count: { increment: 1 },
        last_bot_followup_at: new Date(),
        last_bot_message_at: new Date(),
      },
    });

    this.logger.log(`Follow-up ${state.followup_count + 1} sent for ${rental?.title} (reason: ${reason})`);
  }

  /**
   * SAVE ATTEMPT: Last-ditch effort to retain a cold lead before marking DEAD.
   * Uses scarcity ("another inquiry on your dates") + bundle suggestion if applicable.
   * Fires as follow-up #3, replacing the old generic "no worries" message.
   */
  private async sendSaveAttempt(state: any, rental: any): Promise<void> {
    const itemName = getCleanItemName(rental);

    // Build bundle suggestion from extracted items
    let bundleSuggestion = '';
    try {
      const extractedItems = await this.prisma.extracteditem.findMany({
        where: { rental_id: rental.id },
        select: { item_name: true },
      });
      if (extractedItems.length > 0) {
        // Detect item category and suggest complementary gear
        const itemNames = extractedItems.map(e => e.item_name.toLowerCase());
        const hasCamera = itemNames.some(n => /fx3|a7|bmpcc|camera|pocket/i.test(n));
        const hasLens = itemNames.some(n => /lens|mm|gm|24-70|70-200|50mm/i.test(n));
        const hasAudio = itemNames.some(n => /mic|rode|sennheiser|audio|wireless/i.test(n));
        const hasGimbal = itemNames.some(n => /gimbal|rs3|rs2|ronin/i.test(n));
        const hasLight = itemNames.some(n => /light|aputure|led|panel/i.test(n));

        // Suggest what they DON'T have yet
        if (hasCamera && !hasAudio) {
          bundleSuggestion = `\n\nBy the way, if you need clean audio for the shoot I could bundle in a wireless mic set at a good rate — saves you sourcing it separately.`;
        } else if (hasCamera && !hasGimbal) {
          bundleSuggestion = `\n\nAlso, if you need smooth handheld shots, I could bundle a gimbal with the camera package — works out better value together.`;
        } else if (hasLens && !hasCamera) {
          bundleSuggestion = `\n\nIf you need a camera body to go with that lens, I could put together a bundle that works out better value than renting separately.`;
        } else if (hasLight && extractedItems.length === 1) {
          bundleSuggestion = `\n\nIf you're setting up a lighting rig, I've got stands and modifiers that pair well with it — happy to put a bundle together.`;
        }
      }
    } catch {
      // Non-critical — skip bundle if extraction fails
    }

    // Check if rejected_suggestions exist — don't re-suggest rejected items
    if (state.rejected_suggestions && bundleSuggestion) {
      const rejected = state.rejected_suggestions.toLowerCase();
      if (
        (rejected.includes('mic') && bundleSuggestion.includes('mic')) ||
        (rejected.includes('gimbal') && bundleSuggestion.includes('gimbal'))
      ) {
        bundleSuggestion = ''; // They already declined this category
      }
    }

    // Compose save message: scarcity + optional bundle
    const saveMessage = `Just a heads up — I've had another inquiry for the ${itemName} on your dates. ` +
      `Happy to hold it for you if you're still keen, just let me know!` +
      bundleSuggestion;

    // Send via Hygglo
    try {
      await this.hyggloService.sendMessage(rental.listing_id, saveMessage);
      await this.memoryService.storeConversation(`rental:${rental.id}`, 'assistant', saveMessage, { model: 'follow-up' });
    } catch (error) {
      this.logger.warn(`Failed to send save attempt for ${rental?.title}: ${error.message}`);
    }

    // Update state
    await this.prisma.follow_up_state.update({
      where: { id: state.id },
      data: {
        followup_count: { increment: 1 },
        last_bot_followup_at: new Date(),
        last_bot_message_at: new Date(),
      },
    });

    this.logger.log(`SAVE ATTEMPT sent for ${rental?.title} (scarcity${bundleSuggestion ? ' + bundle' : ''})`);
  }

  /**
   * Rule 3: Auto-accept after follow-ups exhausted.
   * Double-check availability, then Playwright accept.
   */
  async triggerAutoAccept(state: any, rental: any): Promise<void> {
    const account = (rental?.account || 'dbcinema') as HyggloAccount;

    this.logger.log(`Triggering auto-accept for rental ${rental?.title}`);

    // Pre-acceptance validation: same-day rental block
    if (rental?.start_date) {
      const startDate = new Date(rental.start_date);
      const today = new Date();
      if (
        startDate.getFullYear() === today.getFullYear() &&
        startDate.getMonth() === today.getMonth() &&
        startDate.getDate() === today.getDate()
      ) {
        this.logger.warn(`Auto-accept blocked: same-day rental ${rental.title} requires Daniel's manual approval`);
        await this.telegramService.sendRentalUpdate(rental.id, {
          type: 'same_day_block', priority: 'high', data: {},
        }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
        return;
      }
    }

    // Pre-acceptance validation: blacklist check
    try {
      const renterLink = await this.prisma.rental_renter_link.findFirst({
        where: { rental_id: rental.id },
        select: { renter_profile_id: true },
      });
      if (renterLink) {
        const profile = await this.prisma.renter_profile.findUnique({
          where: { id: renterLink.renter_profile_id },
          select: { verification_status: true, name: true },
        });

        // Block if verification is not complete
        if (profile && profile.verification_status !== 'verified' && profile.verification_status !== 'unknown') {
          this.logger.warn(`Auto-accept blocked: verification not complete for ${rental.title} (${profile.verification_status})`);
          await this.telegramService.sendRentalUpdate(rental.id, {
            type: 'verification_block', priority: 'high',
            data: { status: profile.verification_status },
          }, { rentalTitle: rental.title, renterName: profile.name || rental.renter_info, account: rental.account });
          return;
        }
      }
    } catch (preErr) {
      this.logger.debug(`Pre-acceptance validation failed: ${preErr.message}`);
    }

    // Pre-acceptance validation: reviews check
    try {
      const reviewDecisions = await this.prisma.ai_decision.findFirst({
        where: {
          rental_id: rental.id,
          input_summary: { contains: 'review' },
          decision_type: 'escalate',
        },
      });
      if (reviewDecisions) {
        this.logger.warn(`Auto-accept blocked: review escalation exists for ${rental.title}`);
        await this.telegramService.sendRentalUpdate(rental.id, {
          type: 'review_block', priority: 'high', data: {},
        }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
        return;
      }
    } catch (reviewErr) {
      this.logger.debug(`Review check in auto-accept failed: ${reviewErr.message}`);
    }

    // Double-check item availability
    try {
      if (rental.start_date && rental.end_date) {
        const items = await this.prisma.extracteditem.findMany({
          where: { rental_id: rental.id },
          select: { item_name: true },
        });

        for (const item of items) {
          const availability = await this.calendarService.checkAvailability(
            item.item_name,
            rental.start_date,
            rental.end_date,
          );
          if (!availability.available) {
            this.logger.warn(`Auto-accept blocked: ${item.item_name} not available for ${rental.title}`);
            await this.telegramService.sendRentalUpdate(rental.id, {
              type: 'availability_block', priority: 'high',
              data: { itemName: item.item_name },
            }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
            return;
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Availability check failed during auto-accept: ${error.message}`);
    }

    // Apply location-based discount before accepting (if eligible and not already applied)
    try {
      const discountCheck = await this.checkAndApplyDiscount(rental);
      if (discountCheck.applied && discountCheck.percentage) {
        const discountResult = await this.playwrightService.applyDiscount(
          rental.listing_id,
          account,
          discountCheck.percentage,
        );
        if (discountResult.success) {
          this.logger.log(`Pre-accept discount applied for ${rental.title}: £${discountResult.originalPrice} → £${discountResult.discountedPrice}`);
          // Mark discount as applied in follow-up state
          await this.prisma.follow_up_state.updateMany({
            where: { rental_id: rental.id },
            data: { discount_applied: true },
          });
        } else {
          this.logger.warn(`Discount application failed for ${rental.title}: ${discountResult.error} — proceeding with acceptance`);
        }
      }
    } catch (discountErr) {
      this.logger.warn(`Discount check/apply failed during auto-accept: ${discountErr.message}`);
    }

    // Attempt Playwright accept
    const result = await this.playwrightService.acceptRental(rental.listing_id, account);

    // Update state
    await this.prisma.follow_up_state.update({
      where: { id: state.id },
      data: {
        auto_accepted: true,
        status: 'auto_accepted',
      },
    });

    if (result.success) {
      // Send confirmation info message with address and logistics
      try {
        const startDate = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
        const endDate = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
        const dateRange = startDate && endDate ? `\nDates: ${startDate} – ${endDate}` : '';

        let pickupAddress: string;
        let mapsLink: string;
        if (account === 'leo') {
          pickupAddress = '5 Pall Mall East, London SW1Y 5BF — meet outside by the Pret';
          mapsLink = '';
        } else {
          pickupAddress = 'Statue of James II, 11 Trafalgar Square, London WC2N 5DN';
          mapsLink = '\nGoogle Maps: https://maps.app.goo.gl/ry8ea4tySBoah7d7A';
        }

        // Merge confirmation + time request into single message
        const infoMessage =
          `Your booking is confirmed! Here are the details:\n` +
          `\nItems: ${rental.title}${dateRange}` +
          `\nPickup address: ${pickupAddress}${mapsLink}` +
          `\nOpening times: 10am–12pm & 7–9pm` +
          `\nDelivery available (separate charge) — let us know if needed.` +
          `\n\nOne last thing — what are your exact pickup and return times? (Please include AM or PM)`;

        await this.hyggloService.sendMessage(rental.listing_id, infoMessage);
        await this.memoryService.storeConversation(`rental:${rental.id}`, 'assistant', infoMessage, { model: 'follow-up' });

        // Mark time request sent so scanner doesn't double-send
        await this.prisma.follow_up_state.update({
          where: { id: state.id },
          data: { time_request_sent: true, time_request_sent_at: new Date(), times_status: 'none' },
        });

        // If delivery was discussed, send the delivery info collection form
        await this.sendDeliveryFormIfNeeded(rental);
      } catch {
        // Silent failure - confirmation is best-effort
      }

      this.logger.log(`Auto-accepted: ${rental.title}`);
    } else {
      await this.telegramService.sendRentalUpdate(rental.id, {
        type: 'auto_accept_failed', priority: 'high',
        data: { error: result.error },
      }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
    }

    this.logger.log(`Auto-accept for ${rental.title}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  }

  /**
   * Alternative conversion: at followup_count===1, if alternatives were offered and renter
   * went silent, proactively build a minimal item set, verify availability, apply discount,
   * accept the rental, and send a "done deal" message.
   * Returns true if conversion was attempted (even if failed), false to fall through to normal follow-up.
   */
  async attemptAlternativeConversion(state: any, rental: any): Promise<boolean> {
    const account = (rental?.account || 'dbcinema') as HyggloAccount;
    this.logger.log(`Alternative conversion attempt for ${rental?.title}`);

    // --- Guard checks (same as triggerAutoAccept) ---

    // Same-day block
    if (rental?.start_date) {
      const startDate = new Date(rental.start_date);
      const today = new Date();
      if (
        startDate.getFullYear() === today.getFullYear() &&
        startDate.getMonth() === today.getMonth() &&
        startDate.getDate() === today.getDate()
      ) {
        this.logger.warn(`Alt conversion blocked: same-day rental ${rental.title}`);
        await this.telegramService.sendRentalUpdate(rental.id, {
          type: 'alt_conversion_blocked' as any, priority: 'high',
          data: { reason: 'Same-day rental', items: [] },
        }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
        return true;
      }
    }

    // Verification check
    try {
      const renterLink = await this.prisma.rental_renter_link.findFirst({
        where: { rental_id: rental.id },
        select: { renter_profile_id: true },
      });
      if (renterLink) {
        const profile = await this.prisma.renter_profile.findUnique({
          where: { id: renterLink.renter_profile_id },
          select: { verification_status: true, name: true },
        });
        if (profile && profile.verification_status !== 'verified' && profile.verification_status !== 'unknown') {
          this.logger.warn(`Alt conversion blocked: verification not complete for ${rental.title} (${profile.verification_status})`);
          await this.telegramService.sendRentalUpdate(rental.id, {
            type: 'alt_conversion_blocked' as any, priority: 'high',
            data: { reason: `Verification: ${profile.verification_status}`, items: [] },
          }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
          return true;
        }
      }
    } catch (err) {
      this.logger.debug(`Alt conversion verification check failed: ${err.message}`);
    }

    // Review escalation check
    try {
      const reviewDecisions = await this.prisma.ai_decision.findFirst({
        where: {
          rental_id: rental.id,
          input_summary: { contains: 'review' },
          decision_type: 'escalate',
        },
      });
      if (reviewDecisions) {
        this.logger.warn(`Alt conversion blocked: review escalation exists for ${rental.title}`);
        await this.telegramService.sendRentalUpdate(rental.id, {
          type: 'alt_conversion_blocked' as any, priority: 'high',
          data: { reason: 'Review escalation', items: [] },
        }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
        return true;
      }
    } catch (err) {
      this.logger.debug(`Alt conversion review check failed: ${err.message}`);
    }

    // --- Build available item set ---
    const ss = state.structured_state as any;
    const alternativeItems: { original: string; alternative: string; dailyPrice: number | null }[] = ss.alternative_items || [];
    const rejectedList = state.rejected_suggestions ? state.rejected_suggestions.split(',').map((s: string) => s.trim()) : [];

    // Filter out rejected items
    const candidates = alternativeItems.filter(
      (item: any) => !rejectedList.includes(item.alternative),
    );

    if (candidates.length === 0) {
      this.logger.log(`Alt conversion: no candidates after filtering rejected suggestions for ${rental.title}`);
      return false; // Fall through to normal follow-up
    }

    // Verify availability for each candidate
    const availableItems: typeof candidates = [];
    if (rental.start_date && rental.end_date) {
      for (const candidate of candidates) {
        try {
          const availability = await this.calendarService.checkAvailability(
            candidate.alternative,
            rental.start_date,
            rental.end_date,
          );
          if (availability.available) {
            availableItems.push(candidate);
          } else {
            this.logger.log(`Alt conversion: ${candidate.alternative} not available for ${rental.title}`);
          }
        } catch (err) {
          this.logger.warn(`Alt conversion availability check failed for ${candidate.alternative}: ${err.message}`);
        }
      }
    } else {
      this.logger.warn(`Alt conversion: missing dates for ${rental.title}`);
      return false;
    }

    if (availableItems.length === 0) {
      this.logger.log(`Alt conversion: no items available for ${rental.title}`);
      await this.telegramService.sendRentalUpdate(rental.id, {
        type: 'alt_conversion_failed' as any, priority: 'high',
        data: { reason: 'No alternative items available for dates', items: candidates.map((c: any) => c.alternative) },
      }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
      return false; // Fall through to normal follow-up
    }

    // --- Update rental records ---
    const newParsedItems = availableItems.map((item: any) => ({ item: item.alternative, qty: 1 }));
    try {
      await this.prisma.rental.update({
        where: { id: rental.id },
        data: { parsed_items: newParsedItems },
      });

      // Create extracteditem records for alternative items
      for (const item of availableItems) {
        try {
          const existing = await this.prisma.extracteditem.findFirst({
            where: { rental_id: rental.id, item_name: item.alternative, source: 'alt_conversion' },
          });
          if (!existing) {
            await this.prisma.extracteditem.create({
              data: {
                rental_id: rental.id,
                item_name: item.alternative,
                source: 'alt_conversion',
                confidence_score: 1.0,
              },
            });
          }
        } catch { /* non-critical */ }
      }

      // Delete existing bookings (they reference wrong items)
      await this.prisma.booking.deleteMany({
        where: { rental_id: rental.id },
      });
    } catch (err) {
      this.logger.error(`Alt conversion: failed to update rental records for ${rental.title}: ${err.message}`);
      await this.telegramService.sendRentalUpdate(rental.id, {
        type: 'alt_conversion_failed' as any, priority: 'high',
        data: { reason: `DB update failed: ${err.message}`, items: availableItems.map((i: any) => i.alternative) },
      }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
      return true;
    }

    // --- Apply discount if eligible ---
    let discountApplied = false;
    try {
      const discountCheck = await this.checkAndApplyDiscount(rental);
      if (discountCheck.applied && discountCheck.percentage) {
        const discountResult = await this.playwrightService.applyDiscount(
          rental.listing_id,
          account,
          discountCheck.percentage,
        );
        if (discountResult.success) {
          discountApplied = true;
          this.logger.log(`Alt conversion discount applied for ${rental.title}: ${discountCheck.percentage}%`);
          await this.prisma.follow_up_state.updateMany({
            where: { rental_id: rental.id },
            data: { discount_applied: true },
          });
        } else {
          this.logger.warn(`Alt conversion discount failed for ${rental.title}: ${discountResult.error} — proceeding`);
        }
      }
    } catch (discountErr) {
      this.logger.warn(`Alt conversion discount check failed: ${discountErr.message} — proceeding`);
    }

    // --- Accept rental ---
    const result = await this.playwrightService.acceptRental(rental.listing_id, account);

    // Update follow-up state
    await this.prisma.follow_up_state.update({
      where: { id: state.id },
      data: {
        auto_accepted: true,
        status: 'auto_accepted',
        followup_count: { increment: 1 },
        last_bot_followup_at: new Date(),
        last_bot_message_at: new Date(),
      },
    });

    if (result.success) {
      // Create bookings for the new alternative items
      try {
        const extractedItemNames = availableItems.map((i: any) => i.alternative);
        await this.calendarService.createBookingsFromRental(rental, extractedItemNames);
      } catch (err) {
        this.logger.warn(`Alt conversion: booking creation failed for ${rental.title}: ${err.message}`);
      }

      // Send confirmation messages (matching existing two-message pattern)
      try {
        const startDate = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
        const endDate = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
        const dateRange = startDate && endDate ? `${startDate} – ${endDate}` : '';
        const itemNames = availableItems.map((i: any) => i.alternative).join(', ');

        let pickupAddress: string;
        let mapsLink: string;
        if (account === 'leo') {
          pickupAddress = '5 Pall Mall East, London SW1Y 5BF — meet outside by the Pret';
          mapsLink = '';
        } else {
          pickupAddress = 'Statue of James II, 11 Trafalgar Square, London WC2N 5DN';
          mapsLink = '\nGoogle Maps: https://maps.app.goo.gl/ry8ea4tySBoah7d7A';
        }

        const discountMention = discountApplied ? '\nA welcome discount has been applied to your booking.' : '';
        const infoMessage =
          `Great news! I've put together ${itemNames} for your ${dateRange} booking.` +
          `\n\nPickup address: ${pickupAddress}${mapsLink}` +
          `\nOpening times: 10am–12pm & 7–9pm` +
          `\nDelivery available (separate charge) — let us know if needed.${discountMention}` +
          `\n\nWhat are your preferred pickup and return times? (Please include AM or PM)`;

        await this.hyggloService.sendMessage(rental.listing_id, infoMessage);
        await this.memoryService.storeConversation(`rental:${rental.id}`, 'assistant', infoMessage, { model: 'alt-conversion' });

        // Mark time request sent
        await this.prisma.follow_up_state.update({
          where: { id: state.id },
          data: { time_request_sent: true, time_request_sent_at: new Date(), times_status: 'none' },
        });

        // If delivery was discussed, send the delivery info collection form
        await this.sendDeliveryFormIfNeeded(rental);
      } catch (msgErr) {
        this.logger.warn(`Alt conversion: message send failed for ${rental.title}: ${msgErr.message}`);
      }

      // Log ai_decision
      const earnings = availableItems.reduce((sum: number, i: any) => sum + (i.dailyPrice || 0), 0);
      await this.prisma.ai_decision.create({
        data: {
          rental_id: rental.id,
          decision_type: 'alt_conversion',
          input_summary: `Alt conversion: ${availableItems.map((i: any) => `${i.original} → ${i.alternative}`).join(', ')}`,
          output_summary: `Accepted with alternative items${discountApplied ? ' + discount' : ''}`,
          confidence: 1.0,
          action_taken: `Auto-accepted with alternatives: ${availableItems.map((i: any) => i.alternative).join(', ')}`,
          notified: true,
        },
      });

      // Notify Daniel
      await this.telegramService.sendRentalUpdate(rental.id, {
        type: 'alt_conversion_success' as any, priority: 'normal',
        data: {
          items: availableItems.map((i: any) => `${i.original} → ${i.alternative}`),
          earnings: `~£${earnings}/day`,
          discountApplied,
        },
      }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });

      this.logger.log(`ALT CONVERSION SUCCESS: ${rental.title} → ${availableItems.map((i: any) => i.alternative).join(', ')}`);
    } else {
      // Acceptance failed
      await this.telegramService.sendRentalUpdate(rental.id, {
        type: 'alt_conversion_failed' as any, priority: 'high',
        data: { reason: `Accept failed: ${result.error}`, items: availableItems.map((i: any) => i.alternative) },
      }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });
      this.logger.warn(`ALT CONVERSION FAILED (accept): ${rental.title} — ${result.error}`);
    }

    return true;
  }

  /**
   * Accept a same-day rental on Hygglo after Daniel's explicit approval.
   * Bypasses the same-day block in triggerAutoAccept since Daniel has already approved.
   */
  async acceptSameDayRental(rentalId: string): Promise<{ success: boolean; error?: string }> {
    const rental = await this.prisma.rental.findUnique({ where: { id: rentalId } });
    if (!rental) return { success: false, error: 'Rental not found' };

    const account = (rental.account || 'dbcinema') as HyggloAccount;
    const result = await this.playwrightService.acceptRental(rental.listing_id, account);

    // Update follow-up state
    const state = await this.prisma.follow_up_state.findFirst({ where: { rental_id: rentalId } });
    if (state) {
      await this.prisma.follow_up_state.update({
        where: { id: state.id },
        data: { auto_accepted: true, status: 'auto_accepted' },
      });
    }

    if (result.success) {
      this.logger.log(`Same-day rental ACCEPTED (Daniel approved): ${rental.title}`);
    } else {
      this.logger.warn(`Same-day rental accept FAILED: ${rental.title} — ${result.error}`);
    }

    return result;
  }

  /**
   * Accept a low-value rental by first raising earnings to the account minimum,
   * then accepting on Hygglo. Used when the renter agrees to the adjusted booking total.
   */
  async acceptWithMinimumPrice(rentalId: string): Promise<{
    success: boolean;
    previousEarnings?: number;
    newEarnings?: number;
    error?: string;
  }> {
    const rental = await this.prisma.rental.findUnique({ where: { id: rentalId } });
    if (!rental) return { success: false, error: 'Rental not found' };

    const account = (rental.account || 'dbcinema') as HyggloAccount;
    const ACCOUNT_MIN_EARNINGS: Record<string, number> = { dbcinema: 20, leo: 25 };
    const targetEarnings = ACCOUNT_MIN_EARNINGS[account] || 20;

    // Step 1: Set earnings to minimum via Playwright
    const earningsResult = await this.playwrightService.setOrderEarnings(
      rental.listing_id,
      account,
      targetEarnings,
    );

    if (!earningsResult.success) {
      this.logger.warn(`acceptWithMinimumPrice: setOrderEarnings failed for ${rental.title}: ${earningsResult.error}`);
      await this.prisma.ai_decision.create({
        data: {
          rental_id: rental.id,
          decision_type: 'min_price_failed',
          input_summary: `Attempted to set earnings to £${targetEarnings} for low-value rental`,
          output_summary: `Failed: ${earningsResult.error}`,
          confidence: 1.0,
          action_taken: 'Price adjustment failed — manual intervention required',
          notified: true,
        },
      });
      return { success: false, error: earningsResult.error };
    }

    // Step 2: Update rental_price in DB to new earnings
    await this.prisma.rental.update({
      where: { id: rental.id },
      data: { rental_price: targetEarnings },
    });

    // Step 3: Accept the rental
    const acceptResult = await this.playwrightService.acceptRental(rental.listing_id, account);

    // Step 4: Update follow-up state
    const state = await this.prisma.follow_up_state.findFirst({ where: { rental_id: rentalId } });
    if (state) {
      await this.prisma.follow_up_state.update({
        where: { id: state.id },
        data: { auto_accepted: true, status: 'auto_accepted' },
      });
    }

    // Step 5: Log the decision
    await this.prisma.ai_decision.create({
      data: {
        rental_id: rental.id,
        decision_type: 'min_price_accepted',
        input_summary: `Low-value rental adjusted: £${earningsResult.previousEarnings || 0} → £${targetEarnings}`,
        output_summary: `Earnings set to £${targetEarnings}, rental ${acceptResult.success ? 'accepted' : 'accept failed'}`,
        confidence: 1.0,
        action_taken: `Price adjusted and ${acceptResult.success ? 'accepted' : 'accept attempted'}`,
        notified: true,
      },
    });

    if (acceptResult.success) {
      this.logger.log(`acceptWithMinimumPrice SUCCESS: ${rental.title} — £${earningsResult.previousEarnings} → £${targetEarnings}`);
    } else {
      this.logger.warn(`acceptWithMinimumPrice: earnings set OK but acceptRental FAILED for ${rental.title}: ${acceptResult.error}`);
    }

    return {
      success: acceptResult.success,
      previousEarnings: earningsResult.previousEarnings,
      newEarnings: targetEarnings,
      error: acceptResult.success ? undefined : acceptResult.error,
    };
  }

  /**
   * Decline a secondary rental listing on Hygglo via Playwright.
   * Called during multi-item consolidation to close duplicate pending requests.
   * Logs the result but does NOT throw — caller handles gracefully.
   */
  async declineSecondaryRental(listingId: string, account: string, rentalId: string): Promise<void> {
    const result = await this.playwrightService.declineRental(listingId, account as HyggloAccount);
    if (result.success) {
      this.logger.log(`Declined secondary listing ${listingId} on Hygglo for account ${account}`);
      await this.prisma.ai_decision.create({
        data: {
          rental_id: rentalId,
          decision_type: 'secondary_declined',
          input_summary: `Multi-item consolidation: declined secondary listing ${listingId}`,
          output_summary: 'Secondary Hygglo listing declined via Playwright',
          confidence: 1.0,
          action_taken: `Declined listing ${listingId} on Hygglo`,
          notified: false,
        },
      }).catch(() => {});
    } else {
      this.logger.warn(`Failed to decline secondary listing ${listingId}: ${result.error}`);
    }
  }

  /**
   * After booking confirmed, check if delivery was discussed and send the delivery info form.
   * Scans conversation history for delivery-related keywords.
   */
  private async sendDeliveryFormIfNeeded(rental: any): Promise<void> {
    try {
      // Check conversation for delivery discussion
      const messages = await this.prisma.conversation.findMany({
        where: { chat_id: { in: [rental.listing_id, `rental:${rental.id}`] } },
        orderBy: { created_at: 'desc' },
        take: 20,
        select: { content: true, role: true },
      });

      const fullText = messages.map(m => m.content).join(' ').toLowerCase();
      const deliveryKeywords = /\b(deliver|delivery|courier|addison\s*lee|send it|drop.?off.*address|postcode.*deliver)\b/i;

      if (!deliveryKeywords.test(fullText)) {
        return; // No delivery discussion — skip
      }

      // Check if form was already sent (idempotency)
      const alreadySent = messages.some(m =>
        m.role === 'assistant' && m.content.includes('courier pickup or drop off booked'),
      );
      if (alreadySent) return;

      const deliveryForm =
        `If you would like a courier pickup or drop off booked for your order, please provide the following info:\n\n` +
        `Service needed: Pickup / Drop-off / Both\n` +
        `Phone number:\n` +
        `Email address:\n` +
        `Full name:\n` +
        `Address for delivery/pickup:\n` +
        `Preferred time:\n` +
        `Notes for driver (if any):\n\n` +
        `We'll send you the quote once we have this info. Once paid, we book the courier close to dispatch and send you the tracking link.`;

      await this.hyggloService.sendMessage(rental.listing_id, deliveryForm);
      await this.memoryService.storeConversation(`rental:${rental.id}`, 'assistant', deliveryForm, { model: 'follow-up' });

      this.logger.log(`Delivery info form sent for ${rental.title} (delivery discussed in chat)`);
    } catch (err) {
      this.logger.warn(`sendDeliveryFormIfNeeded failed for ${rental.title}: ${err.message}`);
    }
  }

  /**
   * Called when a renter sends a message. Resets follow-up counters.
   * If conversation was DEAD, revives to previous stage (smart revival).
   */
  async onRenterMessage(rentalId: string): Promise<void> {
    try {
      // Check if this rental was DEAD — if so, revive it
      const state = await this.prisma.follow_up_state.findUnique({
        where: { rental_id: rentalId },
      });
      if (state?.conversation_stage === 'dead') {
        // Smart revival: restore to previous stage instead of always resetting to INTERESTED
        const reviveStage = state.stage_before_dead || 'interested';
        // Don't revive to inquiry — minimum is interested (they had a conversation)
        const safeStage = reviveStage === 'inquiry' ? 'interested' : reviveStage;
        this.logger.log(`Reviving DEAD conversation for rental ${rentalId} → ${safeStage} (was ${state.stage_before_dead || 'unknown'})`);
        await this.conversationStageService.setStage(rentalId, safeStage as any);
      }

      await this.prisma.follow_up_state.updateMany({
        where: { rental_id: rentalId, status: 'active' },
        data: {
          followup_count: 0,
          last_renter_message_at: new Date(),
          custom_reminder_at: null,
          custom_reminder_reason: null,
          auto_accepted: false, // Reset so follow-ups can run again if they go cold again
        },
      });
    } catch {
      // State might not exist yet - that's OK
    }
  }

  /**
   * Called after bot sends a message. Updates timestamp.
   */
  async onBotMessage(rentalId: string): Promise<void> {
    try {
      await this.prisma.follow_up_state.updateMany({
        where: { rental_id: rentalId, status: 'active' },
        data: {
          last_bot_message_at: new Date(),
        },
      });
    } catch {
      // State might not exist yet
    }
  }

  /**
   * Use AI to detect if a renter is indicating a delayed response.
   * E.g., "I'll get back tomorrow", "checking with client, will reply Monday"
   * Returns a Date for the custom reminder, or null if not detected.
   */
  async parseCustomTimeframe(message: string, rental: any): Promise<{
    reminderAt: Date;
    reason: string;
  } | null> {
    // Quick pre-filter: must mention future time concepts
    const timeIndicators = /\b(tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|later|tonight|morning|evening|get\s+back|reply|respond|let\s+you\s+know|check(ing)?(\s+with)?|ask(ing)?|confirm(ing)?)\b/i;

    if (!timeIndicators.test(message)) {
      return null;
    }

    try {
      const prompt =
        `Analyze this renter message. Is the renter indicating they'll respond LATER (not right now)?\n\n` +
        `Message: "${message}"\n\n` +
        `If YES, extract when they plan to respond. Calculate the EXACT datetime they'll likely respond.\n` +
        `Today is ${new Date().toISOString().split('T')[0]} (${new Date().toLocaleDateString('en-US', { weekday: 'long' })}).\n\n` +
        `Examples:\n` +
        `- "I'll get back to you tomorrow" -> tomorrow 10:00\n` +
        `- "Let me check and reply Monday" -> next Monday 10:00\n` +
        `- "Will confirm later today" -> today + 3 hours\n` +
        `- "Need to check with my team" -> today + 4 hours\n\n` +
        `Respond ONLY in this format:\n` +
        `DELAYED: yes or no\n` +
        `DATETIME: ISO datetime string (or blank)\n` +
        `REASON: brief description (or blank)`;

      const response = await this.aiService.processExtraction(prompt);

      const delayedMatch = response.content.match(/DELAYED:\s*(yes|no)/i);
      if (!delayedMatch || delayedMatch[1].toLowerCase() !== 'yes') {
        return null;
      }

      const datetimeMatch = response.content.match(/DATETIME:\s*(\d{4}-\d{2}-\d{2}T?\d{2}:\d{2})/);
      const reasonMatch = response.content.match(/REASON:\s*(.+?)(?:\n|$)/);

      if (!datetimeMatch) {
        return null;
      }

      const parsedDate = new Date(datetimeMatch[1]);
      if (isNaN(parsedDate.getTime())) {
        return null;
      }

      // Set reminder 1 hour before stated time (so we follow up proactively)
      const reminderAt = new Date(parsedDate.getTime() - 60 * 60 * 1000);
      const reason = reasonMatch ? reasonMatch[1].trim() : 'Renter indicated delayed response';

      this.logger.log(`Custom timeframe detected for ${rental?.title}: reminder at ${reminderAt.toISOString()} (${reason})`);
      return { reminderAt, reason };
    } catch (error) {
      this.logger.debug(`parseCustomTimeframe failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Set a custom reminder for a rental's follow-up state.
   * Pauses regular follow-ups until the reminder fires.
   */
  async setCustomReminder(rentalId: string, reminderAt: Date, reason: string): Promise<void> {
    await this.prisma.follow_up_state.updateMany({
      where: { rental_id: rentalId, status: 'active' },
      data: {
        custom_reminder_at: reminderAt,
        custom_reminder_reason: reason,
        followup_count: 0, // Reset counter since renter actively communicated
      },
    });

    this.logger.log(`Custom reminder set for rental ${rentalId}: ${reminderAt.toISOString()} (${reason})`);
  }

  /**
   * Check if a rental qualifies for an automatic discount.
   * Criteria: >350 profit / 7+ days / 20km+ distance.
   * Returns eligibility info (scaffolded for future use).
   */
  checkDiscountEligibility(rental: any): {
    eligible: boolean;
    reason?: string;
  } {
    if (!rental) return { eligible: false };

    // Use multi-item total if available, otherwise individual rental price
    const price = rental._multiItemContext?.totalValue || rental.rental_price || 0;
    const startDate = rental.start_date ? new Date(rental.start_date) : null;
    const endDate = rental.end_date ? new Date(rental.end_date) : null;

    // Non-central listing location → automatic 10% distance discount
    if (rental.listing_location) {
      const centralLocations = ['trafalgar', 'whitehall', 'central london', 'charing cross', 'pall mall', 'national gallery', 'westminster', 'covent garden'];
      const loc = rental.listing_location.toLowerCase();
      const isCentral = centralLocations.some(c => loc.includes(c));
      if (!isCentral) {
        return { eligible: true, reason: `Non-central location (${rental.listing_location})` };
      }
    }

    // >350 profit (uses combined value for multi-item requests)
    if (price > 350) {
      return { eligible: true, reason: `High value order (>£350${rental._multiItemContext ? ' combined' : ''})` };
    }

    // 7+ day rental
    if (startDate && endDate) {
      const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      if (days >= 7) {
        return { eligible: true, reason: 'Long rental (7+ days)' };
      }
    }

    return { eligible: false };
  }

  /**
   * Check discount eligibility, enforce one-discount-only rule, and apply if eligible.
   * Returns the discount info if applied, null otherwise.
   */
  async checkAndApplyDiscount(rental: any): Promise<{
    applied: boolean;
    reason?: string;
    percentage?: number;
  }> {
    if (!rental) return { applied: false };

    // Check if a discount was already applied (one-discount-only rule)
    const alreadyApplied = await this.prisma.ai_decision.findFirst({
      where: {
        rental_id: rental.id,
        input_summary: { contains: 'discount_applied' },
      },
    });
    if (alreadyApplied) {
      return { applied: false, reason: 'Discount already applied (one per booking)' };
    }

    // Check for AI-flagged first-time rental discount (takes priority over automatic eligibility)
    const firstTimeDiscount = await this.prisma.ai_decision.findFirst({
      where: {
        rental_id: rental.id,
        decision_type: 'first_time_discount',
      },
    });

    if (firstTimeDiscount) {
      const originalPrice = rental.rental_price || 0;
      const RENTER_DISCOUNT = 15;
      const PLATFORM_RETENTION = 0.64;
      const ownerReduction = RENTER_DISCOUNT * PLATFORM_RETENTION; // ~£9.60
      const ftPercentage = originalPrice > 0 ? Math.round((ownerReduction / originalPrice) * 10000) / 100 : 0;

      if (ftPercentage > 0 && ftPercentage < 50) { // safety cap
        const discountedPrice = Math.round(originalPrice - ownerReduction);

        await this.prisma.ai_decision.create({
          data: {
            rental_id: rental.id,
            decision_type: 'analyze',
            input_summary: `discount_applied: First-time rental discount (${ftPercentage}% off £${originalPrice} = £${discountedPrice}, renter saves ~£${RENTER_DISCOUNT})`,
            output_summary: `First-time discount applied. Original: £${originalPrice}, Discounted: £${discountedPrice}`,
            confidence: 1.0,
            action_taken: `First-time discount: £${ownerReduction} off earnings (${ftPercentage}%)`,
            notified: true,
          },
        });

        this.logger.log(`First-time discount for ${rental.title}: £${originalPrice} → £${discountedPrice} (renter saves ~£${RENTER_DISCOUNT})`);
        return { applied: true, reason: 'First-time rental discount', percentage: ftPercentage };
      }
    }

    // Check for loyalty voucher mentioned in conversation
    const loyaltyVoucherDecision = await this.prisma.ai_decision.findFirst({
      where: {
        rental_id: rental.id,
        decision_type: 'loyalty_voucher_mentioned',
      },
    });

    if (loyaltyVoucherDecision) {
      // Extract voucher code from the AI decision
      const codeMatch = loyaltyVoucherDecision.input_summary?.match(/THANKYOU-[A-F0-9]{6}/i);
      if (codeMatch) {
        const voucherCode = codeMatch[0];
        const validation = await this.couponService.validateLoyaltyVoucher(voucherCode);

        if (validation.valid && validation.discountPercent) {
          const originalPrice = rental.rental_price || 0;
          const PLATFORM_RETENTION = 0.64;
          const ownerReduction = validation.discountPercent * PLATFORM_RETENTION;
          const lvPercentage = originalPrice > 0 ? Math.round((ownerReduction / originalPrice) * 10000) / 100 : 0;

          if (lvPercentage > 0 && lvPercentage < 50) {
            const discountedPrice = Math.round(originalPrice - ownerReduction);

            await this.prisma.ai_decision.create({
              data: {
                rental_id: rental.id,
                decision_type: 'analyze',
                input_summary: `discount_applied: Loyalty voucher ${voucherCode} (${validation.discountPercent}% off, owner reduction ${lvPercentage}% of £${originalPrice} = £${discountedPrice})`,
                output_summary: `Loyalty voucher discount applied. Original: £${originalPrice}, Discounted: £${discountedPrice}`,
                confidence: 1.0,
                action_taken: `Loyalty voucher ${voucherCode}: ${lvPercentage}% off earnings`,
                notified: true,
              },
            });

            // Redeem the voucher
            await this.couponService.redeemVoucher(voucherCode, rental.id);

            this.logger.log(`Loyalty voucher ${voucherCode} for ${rental.title}: £${originalPrice} → £${discountedPrice} (${validation.discountPercent}% renter discount)`);
            return { applied: true, reason: `Loyalty voucher ${voucherCode}`, percentage: lvPercentage };
          }
        }
      }
    }

    // Check for AI-verified price match (takes priority over automatic eligibility)
    const priceMatchDecision = await this.prisma.ai_decision.findFirst({
      where: {
        rental_id: rental.id,
        decision_type: 'price_match',
      },
    });

    if (priceMatchDecision) {
      const originalPrice = rental.rental_price || 0;
      // Extract target owner earnings from the ai_decision record
      const earningsMatch = priceMatchDecision.input_summary?.match(/→ £(\d+(?:\.\d+)?)/);
      const pmPercentageMatch = priceMatchDecision.input_summary?.match(/\((\d+(?:\.\d+)?)% off\)/);

      const pmPercentage = pmPercentageMatch ? parseFloat(pmPercentageMatch[1]) : 0;

      if (pmPercentage > 0 && pmPercentage <= 40) { // safety cap
        const targetEarnings = earningsMatch ? parseFloat(earningsMatch[1]) : Math.round(originalPrice * (1 - pmPercentage / 100));

        await this.prisma.ai_decision.create({
          data: {
            rental_id: rental.id,
            decision_type: 'analyze',
            input_summary: `discount_applied: Price match (${pmPercentage}% off £${originalPrice} = £${targetEarnings})`,
            output_summary: `Price match discount applied. Original: £${originalPrice}, Discounted: £${targetEarnings}`,
            confidence: 1.0,
            action_taken: `Price match discount: ${pmPercentage}% off earnings`,
            notified: true,
          },
        });

        this.logger.log(`Price match discount for ${rental.title}: £${originalPrice} → £${targetEarnings} (${pmPercentage}% off)`);
        return { applied: true, reason: 'Price match (beat competitor by 5%)', percentage: pmPercentage };
      }
    }

    // Check automatic eligibility (distance, high-value, long rental)
    const eligibility = this.checkDiscountEligibility(rental);
    if (!eligibility.eligible) {
      return { applied: false };
    }

    const discountPercentage = 10;
    const originalPrice = rental.rental_price || 0;
    const discountedPrice = Math.round(originalPrice * (1 - discountPercentage / 100));

    // Store discount application record (idempotency + tracking)
    await this.prisma.ai_decision.create({
      data: {
        rental_id: rental.id,
        decision_type: 'analyze',
        input_summary: `discount_applied: ${eligibility.reason} (${discountPercentage}% off £${originalPrice} = £${discountedPrice})`,
        output_summary: `Discount applied: ${eligibility.reason}. Original: £${originalPrice}, Discounted: £${discountedPrice}`,
        confidence: 1.0,
        action_taken: `10% discount flagged for application. Reason: ${eligibility.reason}`,
        notified: true,
      },
    });

    // Update follow-up state discount flags
    await this.prisma.follow_up_state.updateMany({
      where: { rental_id: rental.id },
      data: {
        discount_eligible: true,
      },
    });

    // Notify Daniel with instructions to apply in Hygglo UI
    this.logger.log(`Discount triggered for ${rental.title}: ${eligibility.reason} (£${originalPrice} → £${discountedPrice})`);

    return {
      applied: true,
      reason: eligibility.reason,
      percentage: discountPercentage,
    };
  }

  /**
   * Build discount context string for AI prompt enrichment.
   * Tells the AI whether a discount is eligible/applied so it can inform the renter.
   */
  buildDiscountContext(rental: any, discountResult: { applied: boolean; reason?: string; percentage?: number }): string {
    if (!discountResult.applied) return '';

    const originalPrice = rental.rental_price || 0;
    const discountedPrice = Math.round(originalPrice * (1 - (discountResult.percentage || 10) / 100));

    return (
      `\n--- DISCOUNT APPLIED ---\n` +
      `Reason: ${discountResult.reason}\n` +
      `Discount: ${discountResult.percentage}% off\n` +
      `Original price: £${originalPrice}\n` +
      `Discounted price: £${discountedPrice}\n` +
      `IMPORTANT: Inform the renter they qualify for a ${discountResult.percentage}% discount (${discountResult.reason}). ` +
      `Only ONE discount per booking. Do not stack.\n`
    );
  }

  /**
   * Update follow-up state with items and availability confirmation.
   */
  async updateAcceptanceReadiness(
    rentalId: string,
    updates: {
      items_confirmed?: boolean;
      availability_verified?: boolean;
      auto_accept_eligible?: boolean;
      discount_eligible?: boolean;
    },
  ): Promise<void> {
    await this.prisma.follow_up_state.updateMany({
      where: { rental_id: rentalId },
      data: updates,
    });
  }

  /**
   * Check if delivery T&Cs should be sent for this rental.
   * Only sends if: this is a delivery order, T&Cs not already sent, renter not yet verified.
   */
  async checkDeliveryTCs(state: any, rental: any): Promise<void> {
    if (!rental) return;

    // Skip if rental is cancelled/declined — no point sending T&Cs
    const rentalStatus = (rental.status || '').toLowerCase();
    if (['cancelled', 'declined', 'rejected'].includes(rentalStatus)) {
      this.logger.debug(`Skipping delivery T&Cs for ${rental.id}: rental status is ${rentalStatus}`);
      return;
    }

    // Skip if conversation indicates disinterest or unavailability
    try {
      const ss = state.structured_state as any;
      if (ss?.unavailabilityMentioned) {
        this.logger.debug(`Skipping delivery T&Cs for ${rental.id}: item unavailability mentioned`);
        return;
      }
    } catch { /* non-critical */ }

    try {
      const lastRenterMsg = await this.prisma.conversation.findFirst({
        where: { chat_id: rental.listing_id, role: 'user' },
        orderBy: { created_at: 'desc' },
        select: { content: true },
      });
      if (lastRenterMsg?.content) {
        const renterText = lastRenterMsg.content.toLowerCase().trim();
        const closurePatterns = [
          /(no\s*(thanks|thank you|worries|problem|it'?s? ?(ok|fine|alright|all good)))/,
          /(i'?ll (look|find|search|try|go) (elsewhere|somewhere else|another|other))/,
          /(that'?s? ?(ok|fine|alright)|never ?mind|not to worry)/,
          /(don'?t (need|want|worry|bother)|not interested|changed my mind)/,
          /(found (one|it|something|another)|got (one|it|sorted)|sorted (it|now|thanks))/,
          /(thanks anyway|thank you anyway|cheers anyway)/,
          /(all good|no need|won'?t be needing)/,
        ];
        if (closurePatterns.some(p => p.test(renterText))) {
          this.logger.debug(`Skipping delivery T&Cs for ${rental.id}: renter's last message indicates disinterest`);
          return;
        }
      }
    } catch { /* non-critical */ }

    try {
      const lastBotMsg = await this.prisma.conversation.findFirst({
        where: { chat_id: rental.listing_id, role: 'assistant' },
        orderBy: { created_at: 'desc' },
        select: { content: true },
      });
      if (lastBotMsg?.content) {
        const botText = lastBotMsg.content.toLowerCase();
        const unavailablePatterns = [
          /(not available|unavailable|out of stock|don'?t have|don'?t currently have|no longer available)/,
          /(fully booked|all rented out|already rented|booked out|currently on hire|currently rented)/,
          /(unfortunately.*(?:can'?t|cannot|unable).*(?:offer|provide|help with that))/,
        ];
        if (unavailablePatterns.some(p => p.test(botText))) {
          this.logger.debug(`Skipping delivery T&Cs for ${rental.id}: bot's last message indicates unavailability`);
          return;
        }
      }
    } catch { /* non-critical */ }

    // Stage gate: only send delivery T&Cs when registry allows (QUALIFIED+)
    const followUpState = await this.prisma.follow_up_state.findUnique({
      where: { rental_id: rental.id },
      select: { conversation_stage: true },
    });
    if (!followUpState || !this.conversationStageService.isActionAllowed(followUpState.conversation_stage, 'delivery_tcs')) return;

    // Check if this is a delivery order (look for delivery-related ai_decision records)
    const deliveryDecisions = await this.prisma.ai_decision.findFirst({
      where: {
        rental_id: rental.id,
        OR: [
          { input_summary: { contains: 'delivery', mode: 'insensitive' } },
          { output_summary: { contains: 'delivery', mode: 'insensitive' } },
          { input_summary: { contains: 'courier', mode: 'insensitive' } },
        ],
      },
    });
    if (!deliveryDecisions) return; // Not a delivery order

    // Check if T&Cs already sent (idempotency)
    const alreadySent = await this.prisma.ai_decision.findFirst({
      where: {
        rental_id: rental.id,
        input_summary: { contains: 'delivery_tcs_sent' },
      },
    });
    if (alreadySent) return;

    // Check verification status — only send if not yet verified
    const renterLink = await this.prisma.rental_renter_link.findFirst({
      where: { rental_id: rental.id },
      select: { renter_profile_id: true },
    });
    if (renterLink) {
      const profile = await this.prisma.renter_profile.findUnique({
        where: { id: renterLink.renter_profile_id },
        select: { verification_status: true },
      });
      if (profile?.verification_status === 'verified') return; // Already verified, no need
    }

    // Send delivery T&Cs
    const tcsMessage =
      `Just a heads up on how delivery works:\n\n` +
      `- We use a courier service for deliveries\n` +
      `- An exact delivery time can't be guaranteed, but we'll give you a window\n` +
      `- Someone must be available to receive, check, and sign for the equipment\n` +
      `- Please inspect everything on arrival and let us know of any issues\n` +
      `- Return delivery is charged separately\n\n` +
      `Any questions, just ask!`;

    // sendMessage handles READ_ONLY_MODE with per-rental exceptions
    try {
      await this.hyggloService.sendMessage(rental.listing_id, tcsMessage);
      await this.memoryService.storeConversation(`rental:${rental.id}`, 'assistant', tcsMessage, { model: 'follow-up' });
    } catch (sendErr) {
      this.logger.warn(`Failed to send delivery T&Cs: ${sendErr.message}`);
    }

    // Store marker
    await this.prisma.ai_decision.create({
      data: {
        rental_id: rental.id,
        decision_type: 'message',
        input_summary: `delivery_tcs_sent for ${rental.title}`,
        output_summary: `Delivery T&Cs sent before verification`,
        confidence: 1.0,
        action_taken: 'Delivery T&Cs sent',
        notified: true,
      },
    });

    this.logger.log(`Delivery T&Cs sent for ${rental.title}`);
  }

  /**
   * Evaluate whether a time-specific follow-up should be sent.
   * Separate cadence from general follow-ups: 3h → 9h → 18h after time request.
   * Returns true if a follow-up was sent.
   */
  private async evaluateTimeFollowUp(state: any, rental: any): Promise<boolean> {
    // Gate: stage-gated via registry + time request sent, not auto-assigned
    if (
      !this.conversationStageService.isActionAllowed(state.conversation_stage || '', 'time_followup') ||
      !state.time_request_sent ||
      state.times_auto_assigned ||
      state.time_followup_count >= 3
    ) {
      return false;
    }

    // Check actual booking fields — both pickup AND return must be set
    try {
      const booking = await this.prisma.booking.findFirst({
        where: { rental_id: rental.id, status: 'confirmed' },
        select: { pickup_time: true, return_time: true },
      });
      if (booking?.pickup_time && booking?.return_time) {
        return false; // Both times confirmed — no follow-up needed
      }
    } catch { /* continue with follow-up */ }

    const now = new Date();

    // Calculate time since time request was sent
    const requestSentAt = state.time_request_sent_at ? new Date(state.time_request_sent_at) : null;
    if (!requestSentAt) return false;

    const hoursSinceRequest = (now.getTime() - requestSentAt.getTime()) / (1000 * 60 * 60);

    // Check spacing from last time follow-up
    const lastTimeFollowup = state.last_time_followup_at ? new Date(state.last_time_followup_at) : null;
    const hoursSinceLastFollowup = lastTimeFollowup
      ? (now.getTime() - lastTimeFollowup.getTime()) / (1000 * 60 * 60)
      : Infinity;

    // Follow-up schedule: 2h, 6h, 12h after request
    const followupCount = state.time_followup_count || 0;
    let shouldSend = false;

    if (followupCount === 0 && hoursSinceRequest >= 2) {
      shouldSend = true;
    } else if (followupCount === 1 && hoursSinceRequest >= 6 && hoursSinceLastFollowup >= 3) {
      shouldSend = true;
    } else if (followupCount === 2 && hoursSinceRequest >= 12 && hoursSinceLastFollowup >= 5) {
      shouldSend = true;
    }

    if (!shouldSend) return false;

    await this.sendTimeFollowUp(state, rental, followupCount);
    return true;
  }

  /**
   * Send a time-specific follow-up message. Static templates — no AI calls.
   */
  private async sendTimeFollowUp(state: any, rental: any, followupNumber: number): Promise<void> {
    const itemName = getCleanItemName(rental);

    // Check which time is actually missing
    let missingTime = 'pickup and return times';
    try {
      const booking = await this.prisma.booking.findFirst({
        where: { rental_id: rental.id, status: 'confirmed' },
        select: { pickup_time: true, return_time: true },
      });
      if (booking) {
        if (booking.pickup_time && !booking.return_time) missingTime = 'return time';
        else if (!booking.pickup_time && booking.return_time) missingTime = 'pickup time';
      }
    } catch { /* use default */ }

    const messages = [
      `Quick reminder — just need your exact ${missingTime} (with AM or PM) for the ${itemName}!`,
      `Still need your ${missingTime} for the ${itemName}. Just send a time like "6pm" and I'll lock it in.`,
      `Last check — if I don't hear back, I'll assign the latest available slot for the ${itemName}. Just let me know your preferred ${missingTime}!`,
    ];

    const message = messages[Math.min(followupNumber, messages.length - 1)];

    try {
      await this.hyggloService.sendMessage(rental.listing_id, message);
      await this.memoryService.storeConversation(`rental:${rental.id}`, 'assistant', message, { model: 'time-followup' });
    } catch (error) {
      this.logger.warn(`Failed to send time follow-up for ${rental?.title}: ${error.message}`);
    }

    await this.prisma.follow_up_state.update({
      where: { id: state.id },
      data: {
        time_followup_count: { increment: 1 },
        last_time_followup_at: new Date(),
        last_bot_message_at: new Date(),
      },
    });

    this.logger.log(`Time follow-up ${followupNumber + 1} sent for ${rental?.title}`);
  }

  /**
   * Mark a follow-up state as completed.
   */
  async markCompleted(rentalId: string): Promise<void> {
    await this.prisma.follow_up_state.updateMany({
      where: { rental_id: rentalId },
      data: { status: 'completed' },
    });
  }

  /**
   * Detect if a renter rejected an upsell suggestion and track it.
   * Call after each renter message to check if the previous bot message
   * suggested something the renter just declined.
   */
  async detectRejection(
    rentalId: string,
    renterMessage: string,
    previousBotMessage: string,
  ): Promise<void> {
    const rejectionPatterns = /\b(no thanks|not interested|too expensive|don't need|don't want|not for me|skip that|pass on|nah|just the|only need|only want)\b/i;
    if (!rejectionPatterns.test(renterMessage)) return;

    // Extract item names from the bot's previous suggestion
    const { getInventoryItemNames, findBestMatch } = await import('../utils/item-matcher.js');
    const botWords = previousBotMessage.split(/[\s,.\-!?;:()]+/).filter(w => w.length > 2);
    const suggestedItems = botWords
      .map(w => findBestMatch(w, getInventoryItemNames()))
      .filter(Boolean) as string[];

    if (suggestedItems.length === 0) return;

    // Get current rejected list
    const state = await this.prisma.follow_up_state.findUnique({
      where: { rental_id: rentalId },
      select: { rejected_suggestions: true },
    });
    if (!state) return;

    const existing = state.rejected_suggestions ? state.rejected_suggestions.split(',').map(s => s.trim()) : [];
    const newRejections = suggestedItems.filter(item => !existing.includes(item));

    if (newRejections.length > 0) {
      const updated = [...existing, ...newRejections].join(', ');
      await this.prisma.follow_up_state.update({
        where: { rental_id: rentalId },
        data: { rejected_suggestions: updated },
      });
      this.logger.log(`Tracked rejected suggestions for ${rentalId}: ${newRejections.join(', ')}`);
    }
  }
}
