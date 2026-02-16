import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService, HyggloAccount } from '../hygglo/hygglo.service';
import { TelegramService } from '../telegram/telegram.service';
import { AiService } from '../ai/ai.service';
import { RulesService } from '../rules/rules.service';
import { MemoryService } from '../memory/memory.service';
import { RenterProfileService } from '../renter-profile/renter-profile.service';
import { CalendarService } from '../calendar/calendar.service';
import { TitleParserService } from '../revenue/title-parser.service';

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
    private calendarService: CalendarService,
    private titleParserService: TitleParserService,
  ) {}

  /**
   * Sweep completed and obsolete rentals for unanswered messages.
   * Runs 3x/day at 8am, 2pm, 8pm (was hourly — reduced to save API calls).
   */
  @Cron('0 8,14,20 * * *')
  async sweepCompletedRentals(): Promise<void> {

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

    // Auto-send review nudges for completed rentals with good returns
    await this.sendPendingReviewNudges();
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

      this.logger.log(`Processed completed rental message: ${rental.title}`);
    } catch (error) {
      this.logger.error(`Error processing completed rental ${rental.title}: ${error.message}`);
    }
  }

  /**
   * Monthly cron: Import ALL completed bookings from Hygglo into the rental table.
   * Runs on the 1st of each month at 4am. Also reconciles active bookings.
   * This ensures the rental table (used for all revenue calculations) stays complete.
   */
  @Cron('0 4 1 * *')
  async monthlyRevenueSync(): Promise<void> {
    this.logger.log('=== MONTHLY REVENUE SYNC: Starting ===');

    const accounts: HyggloAccount[] = ['dbcinema', 'leo'];
    let totalImported = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    const errors: string[] = [];

    for (const account of accounts) {
      try {
        const completedRentals = await this.hyggloService.scanCompletedRentalsPaginated(account);
        this.logger.log(`Hygglo ${account}: ${completedRentals.length} completed rentals fetched`);

        for (const rental of completedRentals) {
          try {
            if (!rental.startDate || !rental.endDate) {
              totalSkipped++;
              continue;
            }

            const existingRental = await this.prisma.rental.findFirst({
              where: { listing_id: rental.listingId },
            });

            const ownerEarnings = rental.rentalPrice || 0;

            if (existingRental) {
              // Parse items if not already parsed
              let parsedUpdate: any = {};
              if (!existingRental.parsed_items) {
                try {
                  parsedUpdate.parsed_items = await this.titleParserService.parseTitleWithAI(rental.title) as any;
                } catch { /* non-critical */ }
              }

              // Update revenue if changed
              if (ownerEarnings > 0 && (existingRental.rental_price !== ownerEarnings || existingRental.status !== 'completed')) {
                await this.prisma.rental.update({
                  where: { id: existingRental.id },
                  data: { rental_price: ownerEarnings, status: 'completed', ...parsedUpdate },
                });
                totalUpdated++;
              } else {
                totalSkipped++;
              }
            } else {
              // Parse items from title using AI
              let parsedItems: any = null;
              try {
                parsedItems = await this.titleParserService.parseTitleWithAI(rental.title);
              } catch { /* non-critical */ }

              // Create new rental + bookings
              const savedRental = await this.prisma.rental.create({
                data: {
                  listing_id: rental.listingId,
                  title: rental.title,
                  status: 'completed',
                  start_date: rental.startDate,
                  end_date: rental.endDate,
                  renter_info: rental.renterInfo || null,
                  listing_url: rental.listingUrl || '',
                  account: rental.account || account,
                  rental_price: ownerEarnings || null,
                  price_per_day: rental.pricePerDay || null,
                  ...(parsedItems ? { parsed_items: parsedItems } : {}),
                },
              });

              // Extract items and create bookings
              const itemNames: string[] = [];
              if ((rental as any)._detail?.items && Array.isArray((rental as any)._detail.items)) {
                for (const item of (rental as any)._detail.items) {
                  if (item.type === 'PRODUCT' && item.title) {
                    itemNames.push(item.title);
                  }
                }
              }

              await this.calendarService.createBookingsFromRental(
                { ...savedRental, rental_price: ownerEarnings || savedRental.rental_price },
                itemNames,
              );

              totalImported++;
            }
          } catch (err) {
            errors.push(`${rental.title}: ${err.message}`);
          }
        }
      } catch (err) {
        errors.push(`Account ${account}: ${err.message}`);
      }
    }

    // Backfill parsed_items for any rentals that still need them
    try {
      const backfillResult = await this.titleParserService.backfillParsedItems();
      if (backfillResult.titles > 0) {
        this.logger.log(`Title backfill: ${backfillResult.updated} updated, ${backfillResult.skipped} skipped, ${backfillResult.failed} failed out of ${backfillResult.titles} titles`);
      }
    } catch (err) {
      this.logger.error(`Title backfill failed: ${err.message}`);
    }

    // Reconcile: cancel DB entries whose end_date has passed but Hygglo doesn't list as completed
    const totalCancelled = await this.reconcilePastRentals();

    const summary = `Monthly revenue sync: imported=${totalImported}, updated=${totalUpdated}, skipped=${totalSkipped}, cancelled=${totalCancelled}, errors=${errors.length}`;
    this.logger.log(summary);

    if (totalImported > 0 || totalUpdated > 0 || totalCancelled > 0) {
      this.telegramService.sendRentalUpdate('system', {
        type: 'info',
        priority: 'normal',
        data: { message: summary },
      });
    }
  }

  /**
   * Daily cron (6am): Reconcile past rental entries against Hygglo completed orders.
   * Entries whose end_date is >7 days ago but are NOT in Hygglo's completed list
   * get marked as 'cancelled' so they don't count in revenue.
   *
   * Root cause: the rental-scanner creates entries for pending/upcoming/ongoing orders.
   * Many (especially on Leo's account) end up as 'obsolete' on Hygglo (cancelled/expired)
   * but the DB derives status from dates, so they appear as completed revenue.
   */
  @Cron('0 6 * * *')
  async dailyReconciliation(): Promise<void> {
    this.logger.log('=== DAILY RECONCILIATION: Starting ===');
    const cancelled = await this.reconcilePastRentals();
    if (cancelled > 0) {
      this.logger.log(`Daily reconciliation: cancelled ${cancelled} phantom revenue entries`);
    } else {
      this.logger.log('Daily reconciliation: no phantom entries found');
    }
  }

  /**
   * Auto-send thank you + review nudge for completed rentals with good returns.
   * Targets: outcome='good', not blacklisted/flagged, thank_you not yet sent,
   * processed 24h–7d ago. Capped at 3 per run to avoid spam bursts.
   */
  private async sendPendingReviewNudges(): Promise<void> {
    try {
      const now = Date.now();
      const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

      const pending = await this.prisma.return_processing.findMany({
        where: {
          outcome: 'good',
          thank_you_sent: false,
          blacklisted: false,
          flagged: false,
          processed_at: {
            gte: sevenDaysAgo,
            lte: oneDayAgo,
          },
        },
        take: 3, // Cap per run
      });

      if (pending.length === 0) return;

      this.logger.log(`Review nudge: ${pending.length} pending thank-you message(s) to send`);

      for (const rp of pending) {
        // Look up rental data separately (no Prisma relation on return_processing)
        const rental = await this.prisma.rental.findUnique({
          where: { id: rp.rental_id },
          select: { id: true, listing_id: true, title: true, account: true, renter_info: true },
        });
        if (!rental?.listing_id) continue;

        try {
          const account = (rental.account || 'dbcinema') as 'dbcinema' | 'leo';
          const reviewRequest = `\n\nIf you enjoyed the experience, we'd really appreciate a quick review on Hygglo — it helps us a lot!`;
          const message = account === 'leo'
            ? `Hey! Thanks so much for renting with me, really appreciate it! Hope the gear worked out great for your project. If you'd like to rent again, use code db15off for 15% off your next booking. Cheers!` + reviewRequest
            : `Thanks for choosing DB Cinema Rentals! We hope the equipment performed perfectly for your production. As a thank you, here's 15% off your next rental — just use code db15off when booking. Looking forward to working with you again!` + reviewRequest;

          const sent = await this.hyggloService.sendMessage(rental.listing_id, message, true);

          if (sent) {
            await this.prisma.return_processing.update({
              where: { id: rp.id },
              data: { thank_you_sent: true, thank_you_text: message },
            });

            this.logger.log(`Auto-sent review nudge for "${rental.title}"`);
            this.telegramService.sendRentalUpdate('system', {
              type: 'info',
              priority: 'normal',
              data: { message: `Auto-sent review nudge for "${rental.title}" (${account})` },
            });
          } else {
            this.logger.warn(`Review nudge send failed for "${rental.title}" — message not delivered`);
          }
        } catch (sendErr) {
          this.logger.warn(`Review nudge failed for rental ${rp.rental_id}: ${sendErr.message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`Review nudge sweep failed: ${err.message}`);
    }
  }

  /**
   * Reconcile past rentals: fetch Hygglo completed order IDs for each account,
   * then cancel any DB entries with end_date > 7 days ago that aren't in the completed set.
   */
  private async reconcilePastRentals(): Promise<number> {
    const accounts: HyggloAccount[] = ['dbcinema', 'leo'];
    let totalCancelled = 0;
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

    for (const account of accounts) {
      try {
        // Fetch all completed order IDs from Hygglo (listing_id = order.id)
        const completedRentals = await this.hyggloService.scanCompletedRentalsPaginated(account);
        const completedIds = new Set(completedRentals.map(r => r.listingId));
        this.logger.log(`Reconcile ${account}: ${completedIds.size} completed orders on Hygglo`);

        // Find past DB entries for this account that aren't in the completed set
        const pastEntries = await this.prisma.rental.findMany({
          where: {
            account,
            end_date: { lt: cutoffDate },
            status: { notIn: ['cancelled'] },
            listing_id: { notIn: [...completedIds] },
          },
          select: { id: true, listing_id: true, title: true, rental_price: true, renter_info: true, start_date: true },
        });

        if (pastEntries.length === 0) continue;

        this.logger.warn(`Reconcile ${account}: Found ${pastEntries.length} phantom entries (not in Hygglo completed)`);

        for (const entry of pastEntries) {
          // Mark rental as cancelled
          await this.prisma.rental.update({
            where: { id: entry.id },
            data: { status: 'cancelled' },
          });

          // Also cancel associated bookings
          await this.prisma.booking.updateMany({
            where: { rental_id: entry.id, status: { notIn: ['cancelled'] } },
            data: { status: 'cancelled' },
          });

          totalCancelled++;
        }

        if (pastEntries.length > 0) {
          const phantomRevenue = pastEntries.reduce((s, e) => s + Number(e.rental_price || 0), 0);
          this.logger.warn(`Reconcile ${account}: Cancelled ${pastEntries.length} phantom entries (£${phantomRevenue.toFixed(0)} removed from revenue)`);
        }
      } catch (err) {
        this.logger.error(`Reconcile ${account} failed: ${err.message}`);
      }
    }

    return totalCancelled;
  }
}
