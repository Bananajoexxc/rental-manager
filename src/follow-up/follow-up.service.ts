import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PlaywrightService } from '../playwright/playwright.service';
import { TelegramService } from '../telegram/telegram.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { AiService } from '../ai/ai.service';
import { CalendarService } from '../calendar/calendar.service';
import { ConversationStageService } from '../conversation-tree/conversation-stage.service';

type HyggloAccount = 'dbcinema' | 'leo';

@Injectable()
export class FollowUpService {
  private readonly logger = new Logger(FollowUpService.name);

  constructor(
    private prisma: PrismaService,
    private playwrightService: PlaywrightService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private hyggloService: HyggloService,
    private aiService: AiService,
    private calendarService: CalendarService,
    private conversationStageService: ConversationStageService,
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
   * Cron: Check all active follow-up states every 2 minutes.
   * Skip quiet hours (2am-7am).
   */
  @Cron('*/2 * * * *')
  async checkFollowUps(): Promise<void> {
    // Skip quiet hours
    const hour = new Date().getHours();
    if (hour >= 2 && hour < 7) {
      return;
    }

    try {
      const activeStates = await this.prisma.follow_up_state.findMany({
        where: {
          status: 'active',
          conversation_stage: { notIn: ['dead', 'completed'] },
        },
        include: {
          rental: true,
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

    // 1b. Check if delivery T&Cs should be sent
    try {
      await this.checkDeliveryTCs(state, state.rental);
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

    // 7. followup_count === 1 AND 10h+ since last follow-up -> send second follow-up
    if (state.followup_count === 1) {
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
      }
    }
  }

  /**
   * Send a follow-up message with distinct wording.
   */
  async sendFollowUp(state: any, rental: any, reason: string): Promise<void> {
    // Deterministic templates — no AI call needed, saves tokens
    const itemName = rental?.title || 'the rental';
    const followupNumber = state.followup_count + 1;
    const followUpMessage = followupNumber === 1
      ? `Just checking in - let me know if you had any other questions about the ${itemName}!`
      : `Still interested in the ${itemName}? Happy to hold it for you if needed.`;

    // Send via Hygglo (sendMessage handles READ_ONLY_MODE with per-rental exceptions)
    try {
      await this.hyggloService.sendMessage(rental.listing_id, followUpMessage);
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
    const itemName = rental?.title || 'the rental';

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
      // Send confirmation message
      const confirmMessage = `Great news - your booking for the ${rental.title} has been confirmed! ` +
        `Looking forward to the rental. Let me know if you have any questions about pickup.`;

      try {
        await this.hyggloService.sendMessage(rental.listing_id, confirmMessage);
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

    // Check eligibility
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
    const itemName = rental?.title || 'the rental';

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
