import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService, HyggloAccount } from '../hygglo/hygglo.service';
import { TelegramService } from '../telegram/telegram.service';
import { AiService } from '../ai/ai.service';
import { RulesService } from '../rules/rules.service';
import { MemoryService } from '../memory/memory.service';
import { RenterProfileService } from '../renter-profile/renter-profile.service';

@Injectable()
export class CompletedScanService {
  private readonly logger = new Logger(CompletedScanService.name);

  constructor(
    private prisma: PrismaService,
    private hyggloService: HyggloService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private aiService: AiService,
    private rulesService: RulesService,
    private memoryService: MemoryService,
    private renterProfileService: RenterProfileService,
  ) {}

  /**
   * Hourly cron: Sweep completed and obsolete rentals for unanswered messages.
   * Skip quiet hours (2am-7am).
   */
  @Cron('0 * * * *')
  async sweepCompletedRentals(): Promise<void> {
    // Skip quiet hours
    const hour = new Date().getHours();
    if (hour >= 2 && hour < 7) {
      return;
    }

    this.logger.log('Starting completed rental sweep...');

    const accounts: HyggloAccount[] = ['dbcinema', 'leo'];
    let totalActioned = 0;

    for (const account of accounts) {
      try {
        const actioned = await this.scanAccountCompletedRentals(account);
        totalActioned += actioned;
      } catch (error) {
        this.logger.warn(`Completed scan failed for ${account}: ${error.message}`);
      }
    }

    if (totalActioned > 0) {
      this.logger.log(`Completed rental sweep: ${totalActioned} action(s) taken`);
    }
  }

  /**
   * Scan completed/obsolete rentals for a specific account.
   * Returns number of actions taken.
   */
  private async scanAccountCompletedRentals(account: HyggloAccount): Promise<number> {
    const rentals = await this.hyggloService.scanCompletedRentals(account, 5);
    let actioned = 0;

    for (const rental of rentals) {
      try {
        // Snapshot agreements for the renter profile when rental reaches terminal state
        await this.snapshotRenterAgreements(rental);

        const shouldProcess = await this.shouldProcessCompletedRental(rental);
        if (shouldProcess) {
          await this.processCompletedRentalMessage(rental, account);
          actioned++;
        }
      } catch (error) {
        this.logger.debug(`Error processing completed rental ${rental.listingId}: ${error.message}`);
      }
    }

    return actioned;
  }

  /**
   * Snapshot renter agreements when a rental reaches completed/obsolete state.
   * This preserves what was agreed so that re-requests skip re-negotiation.
   */
  private async snapshotRenterAgreements(rental: any): Promise<void> {
    try {
      const dbRental = await this.prisma.rental.findUnique({
        where: { listing_id: rental.listingId },
        select: { id: true },
      });
      if (!dbRental) return;

      // Check if we already snapshotted (avoid duplicating on every hourly sweep)
      const link = await this.prisma.rental_renter_link.findFirst({
        where: { rental_id: dbRental.id },
        include: { renter_profile: { select: { id: true, previous_agreements: true } } },
      });
      if (!link) return;

      // Only snapshot once — if previous_agreements already mentions this rental, skip
      const existingAgreements = link.renter_profile.previous_agreements || '';
      if (existingAgreements.includes(dbRental.id)) return;

      await this.renterProfileService.snapshotAgreements(link.renter_profile.id, dbRental.id);
      this.logger.debug(`Snapshotted agreements for completed rental ${rental.listingId}`);
    } catch (error) {
      this.logger.debug(`Agreement snapshot failed for ${rental.listingId}: ${error.message}`);
    }
  }

  /**
   * Determine if a completed rental needs processing.
   * Criteria: last message is from renter (not owner), within 48 hours.
   */
  private async shouldProcessCompletedRental(rental: any): Promise<boolean> {
    try {
      const messages = await this.hyggloService.readMessages(rental.listingId);
      if (messages.length === 0) return false;

      // Get last 3 messages
      const recentMessages = messages.slice(-3);
      const lastMessage = recentMessages[recentMessages.length - 1];

      // Only process if last message is from renter
      if (lastMessage.sender === 'Owner') return false;

      // Check if within 48 hours
      const msgTime = new Date(lastMessage.timestamp);
      const hoursSinceMessage = (Date.now() - msgTime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceMessage > 48) return false;

      // Check if we already responded (check our AI decisions)
      const existingDecision = await this.prisma.ai_decision.findFirst({
        where: {
          input_summary: { contains: `completed-scan:${rental.listingId}` },
          created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });

      if (existingDecision) return false;

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Process an unanswered message on a completed rental.
   * Generates an appropriate response using AI.
   */
  async processCompletedRentalMessage(rental: any, account: HyggloAccount): Promise<void> {
    const messages = await this.hyggloService.readMessages(rental.listingId);
    if (messages.length === 0) return;

    const recentMessages = messages.slice(-3);
    const lastMessage = recentMessages[recentMessages.length - 1];

    // Build context
    const rules = await this.rulesService.getFormattedRules();
    const chatContext = recentMessages
      .map((m) => `[${m.timestamp}] ${m.sender}: ${m.content}`)
      .join('\n');

    const prompt =
      `A renter has sent a message on a COMPLETED rental. Draft a reply.\n\n` +
      `Rental: ${rental.title}\n` +
      `Renter: ${rental.renterInfo || 'Unknown'}\n` +
      `Status: Completed\n\n` +
      `Recent messages:\n${chatContext}\n\n` +
      `Their latest message: "${lastMessage.content}"\n\n` +
      `Context: This rental is already completed. Common post-rental messages include:\n` +
      `- Thank you messages (reply warmly)\n` +
      `- Questions about future bookings (be helpful, encourage rebooking)\n` +
      `- Issues/complaints about gear (escalate to Daniel)\n` +
      `- Requests for receipts or invoices (direct to platform)\n` +
      `- Left something behind (coordinate return)\n\n` +
      `Keep the reply concise and natural. If it's a serious issue, recommend escalating.`;

    try {
      const response = await this.aiService.processRoutine(prompt, { rules });

      // Send the reply (gated by READ_ONLY_MODE)
      const readOnly = process.env.READ_ONLY_MODE === 'true';
      let actionTaken: string;

      if (readOnly) {
        actionTaken = `BLOCKED (read-only). Draft: "${response.content.substring(0, 100)}..."`;
      } else {
        try {
          await this.hyggloService.sendMessage(rental.listingId, response.content);
          actionTaken = `Sent: "${response.content.substring(0, 100)}..."`;
        } catch (sendError) {
          actionTaken = `Failed to send: ${sendError.message}`;
        }
      }

      // Store decision
      await this.prisma.ai_decision.create({
        data: {
          decision_type: 'message',
          input_summary: `completed-scan:${rental.listingId} - ${lastMessage.sender}: "${lastMessage.content.substring(0, 200)}"`,
          output_summary: response.content.substring(0, 500),
          confidence: 0.7,
          action_taken: actionTaken,
          notified: true,
        },
      });

      // Notify Daniel
      await this.telegramService.sendProactiveMessage(
        `🔄 *Completed Rental Reply*\n\n` +
        `├ 📦 ${rental.title}\n` +
        `├ 👤 ${rental.renterInfo || 'Unknown'}\n` +
        `├ 💬 Their msg: "${lastMessage.content.substring(0, 100)}"\n` +
        `├ 🤖 Reply: "${response.content.substring(0, 100)}"\n` +
        `└ ${actionTaken.substring(0, 100)}`,
      );

      this.logger.log(`Processed completed rental message: ${rental.title}`);
    } catch (error) {
      this.logger.error(`Error processing completed rental ${rental.title}: ${error.message}`);
    }
  }
}
