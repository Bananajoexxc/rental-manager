import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PlaywrightService } from '../playwright/playwright.service';
import { TelegramService } from '../telegram/telegram.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { AiService } from '../ai/ai.service';
import { CalendarService } from '../calendar/calendar.service';

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
        last_renter_message_at: new Date(),
        status: 'active',
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
        where: { status: 'active' },
        include: {
          rental: true,
        },
      });

      for (const state of activeStates) {
        try {
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

    const lastRenterMsgTime = new Date(state.last_renter_message_at);
    const hoursSinceRenter = (now.getTime() - lastRenterMsgTime.getTime()) / (1000 * 60 * 60);

    // 4. Less than 1 hour -> skip
    if (hoursSinceRenter < 1) {
      return;
    }

    // 5. Check spacing: don't send follow-ups too close together
    if (state.last_bot_followup_at) {
      const lastFollowupTime = new Date(state.last_bot_followup_at);
      const hoursSinceFollowup = (now.getTime() - lastFollowupTime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceFollowup < 1) {
        return; // Wait at least 1 hour between follow-ups
      }
    }

    // 6. 1+ hours AND followup_count < 2 -> send follow-up
    if (hoursSinceRenter >= 1 && state.followup_count < 2) {
      await this.sendFollowUp(state, state.rental, `inactivity_${state.followup_count + 1}`);
      return;
    }

    // 7. 2+ hours AND followup_count >= 2 AND auto_accept_eligible -> trigger auto-accept
    if (hoursSinceRenter >= 2 && state.followup_count >= 2 && state.auto_accept_eligible) {
      await this.triggerAutoAccept(state, state.rental);
      return;
    }

    // 8. 2+ hours AND followup_count >= 2 AND NOT eligible -> notify Daniel
    if (hoursSinceRenter >= 2 && state.followup_count >= 2 && !state.auto_accept_eligible) {
      // Only notify once
      if (!state.auto_accepted) {
        await this.telegramService.sendProactiveMessage(
          `⏰ *Follow-Up Exhausted*\n\n` +
          `├ 📦 ${state.rental?.title || 'Unknown'}\n` +
          `├ 👤 ${state.rental?.renter_info || 'Unknown'}\n` +
          `├ ⏱️ Inactive for ${hoursSinceRenter.toFixed(1)}h\n` +
          `├ 📨 ${state.followup_count} follow-ups sent\n` +
          `└ ❌ Not auto-accept eligible - needs manual action`,
        );

        // Mark so we don't keep notifying
        await this.prisma.follow_up_state.update({
          where: { id: state.id },
          data: { auto_accepted: true }, // Using as "notified" flag
        });
      }
    }
  }

  /**
   * Send a follow-up message with distinct wording.
   */
  async sendFollowUp(state: any, rental: any, reason: string): Promise<void> {
    const isFirst = state.followup_count === 0;
    const renterName = rental?.renter_info || 'there';

    // Generate follow-up message using AI for natural variety
    let followUpMessage: string;

    try {
      const prompt = isFirst
        ? `Generate a very brief, friendly follow-up message for a rental inquiry that went quiet for about an hour. ` +
          `Renter name: ${renterName}. Rental: ${rental?.title || 'equipment rental'}. ` +
          `Keep it casual, 1-2 sentences max. Don't be pushy. Example tone: "Hey, just checking if you still had any questions about the [item]?" ` +
          `Do NOT include any greeting like "Hi" at the start. Go straight into the check-in.`
        : `Generate a brief, gentle second follow-up for a rental inquiry. This is the SECOND follow-up - the renter hasn't responded for 2+ hours. ` +
          `Renter name: ${renterName}. Rental: ${rental?.title || 'equipment rental'}. ` +
          `Be slightly more direct but still friendly. Mention you can hold the item if they're interested. 1-2 sentences max. ` +
          `Do NOT repeat the first follow-up's wording.`;

      const response = await this.aiService.processExtraction(prompt);
      followUpMessage = response.content.trim().replace(/^["']|["']$/g, '');
    } catch {
      // Fallback messages
      followUpMessage = isFirst
        ? `Just checking in - let me know if you had any other questions about the ${rental?.title || 'rental'}!`
        : `Still interested in the ${rental?.title || 'rental'}? Happy to hold it for you if so.`;
    }

    // Send via Hygglo (gated by READ_ONLY_MODE within sendMessage)
    const readOnly = process.env.READ_ONLY_MODE === 'true';
    if (!readOnly) {
      try {
        await this.hyggloService.sendMessage(rental.listing_id, followUpMessage);
      } catch (error) {
        this.logger.warn(`Failed to send follow-up for ${rental.title}: ${error.message}`);
      }
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

    // Notify Daniel
    await this.telegramService.sendProactiveMessage(
      `📨 *Follow-Up Sent* (${state.followup_count + 1}/2)\n\n` +
      `├ 📦 ${rental?.title || 'Unknown'}\n` +
      `├ 👤 ${renterName}\n` +
      `├ 💬 "${followUpMessage.substring(0, 100)}"\n` +
      `├ 📝 Reason: ${reason}\n` +
      `└ Mode: ${readOnly ? 'READ-ONLY (not sent)' : 'SENT'}`,
    );

    this.logger.log(`Follow-up ${state.followup_count + 1} sent for ${rental?.title} (reason: ${reason})`);
  }

  /**
   * Rule 3: Auto-accept after follow-ups exhausted.
   * Double-check availability, then Playwright accept.
   */
  async triggerAutoAccept(state: any, rental: any): Promise<void> {
    const account = (rental?.account || 'dbcinema') as HyggloAccount;

    this.logger.log(`Triggering auto-accept for rental ${rental?.title}`);

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
            await this.telegramService.sendProactiveMessage(
              `⛔ *Auto-Accept Blocked*\n\n` +
              `├ 📦 ${rental.title}\n` +
              `├ ❌ ${item.item_name} is not available\n` +
              `└ Manual review required`,
            );
            return;
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Availability check failed during auto-accept: ${error.message}`);
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

      const readOnly = process.env.READ_ONLY_MODE === 'true';
      if (!readOnly) {
        try {
          await this.hyggloService.sendMessage(rental.listing_id, confirmMessage);
        } catch {
          // Silent failure - confirmation is best-effort
        }
      }

      await this.telegramService.sendProactiveMessage(
        `✅ *Auto-Accepted*\n\n` +
        `├ 📦 ${rental.title}\n` +
        `├ 👤 ${rental.renter_info || 'Unknown'}\n` +
        `├ 🤖 Accepted via Playwright\n` +
        `└ Confirmation ${readOnly ? 'BLOCKED (read-only)' : 'sent'}`,
      );
    } else {
      await this.telegramService.sendProactiveMessage(
        `⚠️ *Auto-Accept Failed*\n\n` +
        `├ 📦 ${rental.title}\n` +
        `├ ❌ Error: ${result.error}\n` +
        `└ Please accept manually`,
      );
    }

    this.logger.log(`Auto-accept for ${rental.title}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  }

  /**
   * Called when a renter sends a message. Resets follow-up counters.
   */
  async onRenterMessage(rentalId: string): Promise<void> {
    try {
      await this.prisma.follow_up_state.updateMany({
        where: { rental_id: rentalId, status: 'active' },
        data: {
          followup_count: 0,
          last_renter_message_at: new Date(),
          custom_reminder_at: null,
          custom_reminder_reason: null,
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

    const price = rental.rental_price || 0;
    const startDate = rental.start_date ? new Date(rental.start_date) : null;
    const endDate = rental.end_date ? new Date(rental.end_date) : null;

    // >350 profit
    if (price > 350) {
      return { eligible: true, reason: 'High value order (>£350)' };
    }

    // 7+ day rental
    if (startDate && endDate) {
      const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      if (days >= 7) {
        return { eligible: true, reason: 'Long rental (7+ days)' };
      }
    }

    return { eligible: false };
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
   * Mark a follow-up state as completed.
   */
  async markCompleted(rentalId: string): Promise<void> {
    await this.prisma.follow_up_state.updateMany({
      where: { rental_id: rentalId },
      data: { status: 'completed' },
    });
  }
}
