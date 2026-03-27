import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { ImageAnalysisService } from '../image-analysis/image-analysis.service';
import { LoggingService } from '../logging/logging.service';
import { AutonomousService } from '../autonomous/autonomous.service';
import { TelegramService } from '../telegram/telegram.service';
import { MemoryService } from '../memory/memory.service';
import { CalendarService } from '../calendar/calendar.service';
import { RenterProfileService } from '../renter-profile/renter-profile.service';
import { FollowUpService } from '../follow-up/follow-up.service';
import { VerificationService } from '../verification/verification.service';
import { TitleParserService } from '../revenue/title-parser.service';
import { ContentionService } from '../contention/contention.service';
import { ItemResolverService } from '../item-resolver/item-resolver.service';
import { DiagnosticService } from '../monitoring/diagnostic.service';
import { detectBrandMismatch } from '../utils/item-matcher';

@Injectable()
export class RentalScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RentalScannerService.name);
  private isScanning = false;
  private lastActivityTime: number = Date.now();
  private currentScanInterval: number;
  private scannerTimeout: NodeJS.Timeout | null = null;
  private scanCount = 0;
  private shuttingDown = false;
  private failedBackfillRentals = new Set<string>(); // rental IDs where backfill returned 0 (unmatchable items) — also persisted via ai_decision

  // Scan data cache — shared with other services to eliminate redundant API calls
  private messageCache = new Map<string, { messages: { sender: string; content: string; timestamp: string; imageUrls?: string[] }[]; fetchedAt: number; messageCount: number }>();
  private lastScanRentals: any[] = [];
  private recentlyCompletedRentals: any[] = [];
  private static readonly MESSAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  private readonly INITIAL_SCAN_INTERVAL: number;
  private readonly REDUCED_SCAN_INTERVAL: number;
  private readonly INACTIVITY_THRESHOLD: number;

  constructor(
    private prisma: PrismaService,
    private hyggloService: HyggloService,
    private imageAnalysisService: ImageAnalysisService,
    private loggingService: LoggingService,
    @Optional() @Inject(forwardRef(() => AutonomousService)) private autonomousService: AutonomousService,
    @Optional() @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private memoryService: MemoryService,
    private calendarService: CalendarService,
    private renterProfileService: RenterProfileService,
    private followUpService: FollowUpService,
    private verificationService: VerificationService,
    @Optional() @Inject(forwardRef(() => TitleParserService)) private titleParserService: TitleParserService,
    private contentionService: ContentionService,
    private itemResolverService: ItemResolverService,
    @Optional() private diagnosticService?: DiagnosticService,
  ) {
    // Load configuration from environment variables
    this.INITIAL_SCAN_INTERVAL = this.parseIntOrDefault(process.env.INITIAL_SCAN_INTERVAL_MS, 60000);
    this.REDUCED_SCAN_INTERVAL = this.parseIntOrDefault(process.env.REDUCED_SCAN_INTERVAL_MS, 300000);
    this.INACTIVITY_THRESHOLD = this.parseIntOrDefault(process.env.INACTIVITY_THRESHOLD_MS, 1800000);
    this.currentScanInterval = this.INITIAL_SCAN_INTERVAL;
  }

  private parseIntOrDefault(val: string | undefined, defaultValue: number): number {
    const parsed = parseInt(val || '', 10);
    return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
  }

  async onModuleInit() {
    // Restore persisted backfill failures from DB (survives restarts)
    try {
      const persistedFailures = await this.prisma.ai_decision.findMany({
        where: { decision_type: 'backfill_unmatchable' },
        select: { rental_id: true },
      });
      for (const f of persistedFailures) {
        if (f.rental_id) this.failedBackfillRentals.add(f.rental_id);
      }
      if (persistedFailures.length > 0) {
        this.logger.log(`Restored ${persistedFailures.length} unmatchable backfill entries from DB`);
      }
    } catch (e) {
      this.logger.debug(`Failed to restore backfill failures: ${e.message}`);
    }

    // POST-RESTART DEDUP SEED: Restore lastMessageCheckTime from DB so the first scan
    // after a restart doesn't re-process messages that were already handled.
    // Prevents duplicate AI decisions when a service restart happens within the startup window.
    try {
      const recentDecisions = await this.prisma.ai_decision.findMany({
        where: {
          decision_type: 'message',
          created_at: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // last 2 hours
        },
        include: { rental: { select: { listing_id: true } } },
        orderBy: { created_at: 'desc' },
      });
      let seeded = 0;
      for (const decision of recentDecisions) {
        if (decision.rental?.listing_id) {
          this.hyggloService.seedLastCheckTime(decision.rental.listing_id, decision.created_at.getTime());
          seeded++;
        }
      }
      if (seeded > 0) {
        this.logger.log(`Seeded lastMessageCheckTime for ${seeded} rental(s) from DB — prevents post-restart duplicate processing`);
      }
    } catch (e) {
      this.logger.debug(`Failed to seed lastMessageCheckTime from DB: ${e.message}`);
    }

    // Wait a bit before starting the scanner to allow other services to initialize
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.startScanner();
      }
    }, 5000);
  }

  onModuleDestroy() {
    this.shuttingDown = true;
    if (this.scannerTimeout) {
      clearTimeout(this.scannerTimeout);
      this.scannerTimeout = null;
    }
    this.logger.log('Scanner shutdown: cleared timeout and prevented further scheduling');
  }

  private startScanner() {
    this.logger.log('Starting rental scanner service...');
    this.loggingService.info('Rental scanner service started', {
      initialInterval: this.INITIAL_SCAN_INTERVAL,
      reducedInterval: this.REDUCED_SCAN_INTERVAL,
      inactivityThreshold: this.INACTIVITY_THRESHOLD,
    });

    this.logger.log(`Rental Manager started — accounts: ${this.hyggloService.getAccounts().map(a => a.label).join(', ')}, read-only: ${process.env.READ_ONLY_MODE === 'true'}`);

    this.scheduleNextScan();
  }

  private scheduleNextScan() {
    if (this.shuttingDown) {
      this.logger.log('Shutdown in progress, not scheduling next scan');
      return;
    }

    if (this.scannerTimeout) {
      clearTimeout(this.scannerTimeout);
    }

    let delay = this.currentScanInterval;

    // Quiet hours: 2am-7am — scanner pauses and resumes at 7am
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 2 && hour < 7) {
      // Currently in quiet hours — schedule for 7am today
      const sevenAm = new Date(now);
      sevenAm.setHours(7, 0, 0, 0);
      delay = sevenAm.getTime() - now.getTime();
      this.logger.log('🌙 Quiet hours (2am-7am) — scanner paused until 7:00 AM');
    } else {
      // Check if the next scan would land in quiet hours
      const nextScanTime = new Date(now.getTime() + delay);
      const nextHour = nextScanTime.getHours();
      if (nextHour >= 2 && nextHour < 7) {
        const sevenAm = new Date(nextScanTime);
        sevenAm.setHours(7, 0, 0, 0);
        delay = sevenAm.getTime() - now.getTime();
        this.logger.log('🌙 Next scan would fall in quiet hours — scheduling for 7:00 AM');
      }
    }

    this.scannerTimeout = setTimeout(() => {
      this.performScan();
    }, delay);

    this.logger.log(`⏰ Next scan scheduled in ${Math.round(delay / 1000)} seconds`);
  }

  private async performScan() {
    if (this.isScanning) {
      this.logger.warn('⚠️ Scan already in progress, skipping...');
      this.scheduleNextScan();
      return;
    }

    this.isScanning = true;
    const scanStartTime = Date.now();

    try {
      // 90s timeout prevents scanner from hanging indefinitely on Hygglo API or processing
      await Promise.race([
        this.executeScanBody(scanStartTime),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Scan timeout (150s)')), 150_000)),
      ]);
    } catch (error) {
      this.logger.error('Error during scan: ' + error.message);
      this.loggingService.error('Scan failed', { error: error.message, stack: error?.stack });

    } finally {
      this.isScanning = false;
      this.scheduleNextScan();
    }
  }

  private async executeScanBody(scanStartTime: number) {
      this.logger.log('🔍 ========== Starting Rental Scan ==========');
      this.loggingService.info('Scan started');

      // Scan all configured accounts (ongoing + upcoming for each)
      const allRentals = await this.hyggloService.scanAllAccounts('both');
      let newRentalsCount = 0;

      // Deduplicate: a rental can appear in multiple API endpoints (e.g., both 'pending' and 'upcoming').
      // Without dedup, the last occurrence overwrites the status — a confirmed rental in both
      // 'upcoming' and 'pending' endpoints would end up as 'pending' because pending is scanned last.
      // Keep the highest-priority status: ongoing > upcoming > pending.
      const STATUS_PRIORITY: Record<string, number> = { ongoing: 3, upcoming: 2, pending: 1 };
      const rentalMap = new Map<string, any>();
      for (const rental of allRentals) {
        const existing = rentalMap.get(rental.listingId);
        if (!existing || (STATUS_PRIORITY[rental.status] || 0) > (STATUS_PRIORITY[existing.status] || 0)) {
          rentalMap.set(rental.listingId, rental);
        }
      }
      const dedupedRentals = Array.from(rentalMap.values());
      if (dedupedRentals.length < allRentals.length) {
        this.logger.log(`🔄 Deduplicated ${allRentals.length} → ${dedupedRentals.length} rentals (${allRentals.length - dedupedRentals.length} duplicates across endpoints)`);
      }

      this.logger.log(`📊 Total rentals found: ${dedupedRentals.length}`);

      // Cache scan results + messages from _detail for other services to consume
      this.lastScanRentals = dedupedRentals;
      const now = Date.now();
      for (const rental of dedupedRentals) {
        if (rental._detail?.activities) {
          try {
            const messages = this.hyggloService.extractChatMessages(rental._detail, rental.account || 'dbcinema', true, 'scanner-cache');
            this.messageCache.set(rental.listingId, { messages, fetchedAt: now, messageCount: messages.length });
          } catch { /* non-critical — message extraction from cache */ }
        }
      }

      // Process each rental and collect new ones for grouping
      const newRentalResults: Array<{ savedRental: any; rawRental: any }> = [];
      for (const rental of dedupedRentals) {
        const result = await this.processRental(rental);
        if (result.isNew) {
          newRentalResults.push({ savedRental: result.savedRental, rawRental: result.rawRental });
          newRentalsCount++;
        }
      }

      // Group new rentals by renter, then dispatch
      // Track listing IDs of new rentals so we don't also process their messages below
      const newRentalListingIds = new Set<string>();
      if (this.autonomousService && newRentalResults.length > 0) {
        for (const result of newRentalResults) {
          newRentalListingIds.add(result.savedRental.listing_id);
        }

        // Cross-account duplicate check: same renter on both accounts → keep DB Cinema, discard Leo
        const filteredResults: Array<{ savedRental: any; rawRental: any }> = [];
        for (const result of newRentalResults) {
          const discarded = await this.discardCrossAccountDuplicate(result.savedRental, newRentalResults);
          if (!discarded) {
            filteredResults.push(result);
          }
        }

        const renterGroups = this.groupNewRentalsByRenter(filteredResults);
        for (const [, group] of renterGroups.entries()) {
          if (group.length === 1) {
            // Single rental → normal pipeline
            this.autonomousService.onNewRental(group[0].savedRental).catch((err) => {
              this.logger.error(`Autonomous pipeline error for ${group[0].savedRental.title}: ${err.message}`);
            });
          } else {
            // Multi-item → consolidate
            this.handleMultiItemRequest(group).catch((err) => {
              this.logger.error(`Multi-item consolidation error: ${err.message}`);
            });
          }
        }
      }

      // Update activity tracking and scan interval
      if (newRentalsCount > 0) {
        this.logger.log(`✨ New activity detected: ${newRentalsCount} new rentals`);
        this.loggingService.info('New activity detected', { newRentals: newRentalsCount });
        this.lastActivityTime = Date.now();

        // Switch to frequent scanning
        if (this.currentScanInterval !== this.INITIAL_SCAN_INTERVAL) {
          this.currentScanInterval = this.INITIAL_SCAN_INTERVAL;
          this.logger.log(`🔄 Switching to frequent scanning (${this.currentScanInterval / 1000}s interval)`);
          this.loggingService.info('Switched to frequent scanning', { interval: this.currentScanInterval });
        }
      } else {
        // Check if we should reduce scan frequency
        const timeSinceLastActivity = Date.now() - this.lastActivityTime;
        if (
          timeSinceLastActivity > this.INACTIVITY_THRESHOLD &&
          this.currentScanInterval !== this.REDUCED_SCAN_INTERVAL
        ) {
          this.currentScanInterval = this.REDUCED_SCAN_INTERVAL;
          this.logger.log(`🐌 Switching to reduced scanning (${this.currentScanInterval / 1000}s interval due to inactivity)`);
          this.loggingService.info('Switched to reduced scanning', { interval: this.currentScanInterval });
        }
      }

      // Check for new messages and route through autonomous pipeline
      // IMPORTANT: Exclude messages from rentals that were just processed as new (prevents duplicate replies)
      if (this.autonomousService) {
        try {
          const messages = await this.hyggloService.checkNewMessages(dedupedRentals);
          let newMessages = messages.filter((m) => m.isNew);
          if (newRentalListingIds.size > 0 && newMessages.length > 0) {
            const before = newMessages.length;
            newMessages = newMessages.filter((m) => !newRentalListingIds.has(m.rentalId));
            if (before !== newMessages.length) {
              this.logger.log(`Filtered ${before - newMessages.length} messages from newly-created rentals (already handled by onNewRental)`);
            }
          }
          if (newMessages.length > 0) {
            this.logger.log(`New messages found: ${newMessages.length}`);
            await this.autonomousService.onNewMessages(newMessages);

            // Event-driven time extraction: if any new renter message looks like it contains times,
            // trigger extraction immediately (vs waiting for the 30-min cron)
            const TIME_REGEX = /\d{1,2}\s*(am|pm|:\d{2})|\bmorning\b|\bevening\b|\bafternoon\b/i;
            for (const msg of newMessages) {
              if (TIME_REGEX.test(msg.content)) {
                try {
                  const rental = await this.prisma.rental.findUnique({ where: { listing_id: msg.rentalId } });
                  if (rental && ['upcoming', 'ongoing'].includes(rental.status)) {
                    this.autonomousService.extractAndUpdateTimes(rental, msg as any).catch(err => {
                      this.logger.debug(`Event-driven time extraction failed for ${msg.rentalId}: ${err.message}`);
                    });
                  }
                } catch { /* non-critical */ }
              }
            }
          }
        } catch (msgError) {
          this.logger.warn(`Message check failed: ${msgError.message}`);
        }
      }

      // Auto-detect rentals completed on Hygglo (returned by owner outside our app)
      // If a rental is 'ongoing' in our DB but missing from the Hygglo active scan AND overdue,
      // it was returned on Hygglo directly. Mark as completed so it drops from the return hub.
        // ── Rental lifecycle reconciliation ──
        // Completes/cancels rentals that Hygglo no longer returns in scan results.
        // IMPORTANT: Only the Hygglo scan promotes rentals (pending→upcoming→ongoing).
        // This reconciliation only handles the END of lifecycle:
        //   ongoing + RETURNED → completed (items returned, rental done)
        //   ongoing + end_date passed + not in scan → completed
        //   upcoming + end_date passed + not in scan → completed
        //   pending + end_date passed → completed/cancelled based on order_step
        const lifecycleNow = new Date();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const scannedListingIds = new Set(allRentals.map(r => r.listingId));

        // 1. Complete all RETURNED rentals (items returned = rental done, period)
        const returnedRentals = await this.prisma.rental.findMany({
          where: {
            status: { in: ['ongoing', 'upcoming'] },
            order_step: 'RETURNED',
          },
          select: { id: true, renter_info: true, title: true, status: true, listing_id: true },
        });
        let completed = 0, cancelled = 0;
        for (const rental of returnedRentals) {
          await this.prisma.rental.update({
            where: { id: rental.id },
            data: { status: 'completed', updated_at: new Date() },
          });
          try { await this.calendarService.cascadeRentalStatusToBookings(rental.id, 'completed', rental.status); } catch {}
          try { await this.contentionService.onRentalStatusChange(rental.id, 'completed'); } catch {}
          completed++;
          this.logger.log(`Lifecycle: ${rental.renter_info || rental.title} ${rental.status}+RETURNED → completed`);
        }

        // 2. Complete ongoing/upcoming rentals NOT in Hygglo scan with past end_date
        const staleActive = await this.prisma.rental.findMany({
          where: {
            status: { in: ['ongoing', 'upcoming'] },
            end_date: { lt: todayStart },
          },
          select: { id: true, renter_info: true, title: true, status: true, listing_id: true },
        });
        for (const rental of staleActive) {
          if (scannedListingIds.has(rental.listing_id)) continue; // still on Hygglo, skip
          await this.prisma.rental.update({
            where: { id: rental.id },
            data: { status: 'completed', updated_at: new Date() },
          });
          try { await this.calendarService.cascadeRentalStatusToBookings(rental.id, 'completed', rental.status); } catch {}
          try { await this.contentionService.onRentalStatusChange(rental.id, 'completed'); } catch {}
          completed++;
          this.logger.log(`Lifecycle: ${rental.renter_info || rental.title} ${rental.status} (past end_date, not in scan) → completed`);
        }

        // 3. Clean up pending rentals with past end_date
        const stalePending = await this.prisma.rental.findMany({
          where: {
            status: 'pending',
            end_date: { lt: todayStart },
          },
          select: { id: true, renter_info: true, title: true, order_step: true },
        });
        for (const rental of stalePending) {
          // APPROVED = renter never paid — mark cancelled so confirmed bookings get cleaned up.
          // Do NOT mark as 'completed' for APPROVED: that leaves confirmed bookings in calendar as phantoms.
          const newStatus = 'cancelled';
          await this.prisma.rental.update({
            where: { id: rental.id },
            data: { status: newStatus, updated_at: new Date() },
          });
          try { await this.calendarService.cascadeRentalStatusToBookings(rental.id, newStatus, 'pending'); } catch {}
          cancelled++;
        }

        // 4. Cancel pending rentals that disappeared from Hygglo scan
        // When a renter cancels their request, Hygglo stops returning it.
        // Without this, stale pending rentals show on dashboard indefinitely.
        const stalePendingNotInScan = await this.prisma.rental.findMany({
          where: {
            status: 'pending',
            order_step: { in: ['REQUEST', 'FUNDS_RESERVED', 'VERIFIED'] },
            start_date: { gte: todayStart }, // future only (past handled above)
          },
          select: { id: true, listing_id: true, renter_info: true, title: true, order_step: true },
        });
        for (const rental of stalePendingNotInScan) {
          if (scannedListingIds.has(rental.listing_id)) continue; // still on Hygglo, keep
          await this.prisma.rental.update({
            where: { id: rental.id },
            data: { status: 'cancelled', updated_at: new Date() },
          });
          try { await this.calendarService.cascadeRentalStatusToBookings(rental.id, 'cancelled', 'pending'); } catch {}
          cancelled++;
          this.logger.log(`Lifecycle: ${rental.renter_info || rental.title} pending+${rental.order_step} (not in scan) → cancelled`);
        }

        if (completed + cancelled > 0) {
          this.logger.log(`Lifecycle: ${completed} completed, ${cancelled} cancelled`);
        }

      // Declarative consistency enforcer — runs every scan, self-heals the entire system
      await this.enforceConsistency();

      const scanDuration = Date.now() - scanStartTime;
      this.scanCount++;
      this.logger.log(`Scan #${this.scanCount} completed in ${scanDuration}ms`);
      this.loggingService.info('Scan completed', { duration: scanDuration, newRentals: newRentalsCount });
      this.diagnosticService?.log('scan_cycle', 'scan_complete', `Scan completed in ${scanDuration}ms`, { duration: scanDuration, total: allRentals?.length || 0 });

  }

  private async processRental(rental: any): Promise<{ isNew: boolean; savedRental?: any; rawRental?: any }> {
    // Order steps where the renter has actually paid/committed (not just owner-approved)
    const PAID_ORDER_STEPS = ['FUNDS_RESERVED', 'VERIFIED', 'BOOKED_AFTER_VERIFIED', 'DELIVERED', 'RETURNED'];

    try {
      // Check if rental already exists
      const existingRental = await this.prisma.rental.findUnique({
        where: { listing_id: rental.listingId },
      });

      if (existingRental) {
        // Parse items if title changed or never parsed
        const titleChanged = rental.title !== existingRental.title;
        let parsedItems = existingRental.parsed_items;
        if (titleChanged || !parsedItems) {
          try {
            const resolved = await this.itemResolverService.resolveItems(rental.listingId, rental.title, rental._detail);
            parsedItems = resolved.map(r => ({ item: r.item, qty: r.qty })) as any;
          } catch { /* non-critical */ }
        }

        // Update existing rental (including dates and price if newly available)
        const orderStep = this.extractActiveOrderStep(rental._detail);

        // Reconcile status with order_step: if DELIVERED and rental period has started,
        // force 'ongoing' regardless of which API endpoint returned it
        let reconciledStatus = rental.status;

        // Never downgrade a completed/cancelled rental back to active
        if (['completed', 'cancelled', 'consolidated', 'obsolete'].includes(existingRental.status)) {
          reconciledStatus = existingRental.status;
        }
        // If order_step is RETURNED, rental is done regardless of Hygglo status
        else if (orderStep === 'RETURNED') {
          reconciledStatus = 'completed';
        }
        else if (orderStep === 'DELIVERED' && rental.startDate && rental.startDate <= new Date()) {
          if (reconciledStatus !== 'ongoing') {
            this.logger.log(`🔄 Status reconciled: ${reconciledStatus} → ongoing (order_step=${orderStep}, rental period started)`);
            reconciledStatus = 'ongoing';
          }
        }

        // Only treat as 'upcoming' when renter has paid (FUNDS_RESERVED+) or items are handed over.
        // APPROVED = owner said yes, but renter hasn't paid yet → keep as pending.
        if (reconciledStatus === 'upcoming' && orderStep && !PAID_ORDER_STEPS.includes(orderStep)) {
          reconciledStatus = 'pending';
        }

        const updatedRental = await this.prisma.rental.update({
          where: { listing_id: rental.listingId },
          data: {
            title: rental.title,
            status: reconciledStatus,
            renter_info: rental.renterInfo,
            photos_urls: rental.photosUrls,
            account: rental.account || existingRental.account,
            start_date: rental.startDate ?? existingRental.start_date,
            end_date: rental.endDate ?? existingRental.end_date,
            rental_price: rental.rentalPrice ?? existingRental.rental_price,
            renter_price: rental.renterPrice ?? existingRental.renter_price,
            price_per_day: rental.pricePerDay ?? existingRental.price_per_day,
            currency: rental.currency ?? existingRental.currency,
            listing_location: rental.listingLocation ?? existingRental.listing_location,
            ...(parsedItems !== undefined ? { parsed_items: parsedItems as any } : {}),
            ...(orderStep ? { order_step: orderStep } : {}),
            updated_at: new Date(),
          },
        });

        // Cascade rental_price changes to booking revenue — ownerEarnings may arrive or change
        // after bookings were already created, leaving booking revenue stale
        const newPrice = updatedRental.rental_price;
        const oldPrice = existingRental.rental_price;
        if (newPrice && newPrice > 0 && oldPrice !== newPrice) {
          try {
            const recomputed = await this.calendarService.recomputeRentalRevenue(existingRental.id, newPrice);
            if (recomputed > 0) {
              this.logger.log(`💰 Revenue recomputed for ${updatedRental.title}: £${oldPrice || 0} → £${newPrice} (${recomputed} booking(s))`);
            }
          } catch (err) {
            this.logger.warn(`Revenue recompute failed for ${existingRental.id}: ${err.message}`);
          }
        }

        // Cascade rental date changes to bookings — Hygglo extensions/modifications must propagate
        // This ensures calendar shows actual rental period, not stale initial dates
        const oldStart = existingRental.start_date?.toISOString();
        const newStart = updatedRental.start_date?.toISOString();
        const oldEnd = existingRental.end_date?.toISOString();
        const newEnd = updatedRental.end_date?.toISOString();
        if ((newStart && oldStart !== newStart) || (newEnd && oldEnd !== newEnd)) {
          try {
            const dateUpdate: any = {};
            if (newStart && oldStart !== newStart) dateUpdate.start_date = updatedRental.start_date;
            if (newEnd && oldEnd !== newEnd) {
              dateUpdate.end_date = updatedRental.end_date;
              // Also update return_date if it was still matching old end_date
              // (return_date may have been manually set to a different day — don't overwrite those)
              dateUpdate.return_date = updatedRental.end_date;
            }
            const cascaded = await this.prisma.booking.updateMany({
              where: {
                rental_id: existingRental.id,
                status: { in: ['confirmed', 'pending_review'] },
                // Only cascade if return_date is on the same DAY as old end_date (wasn't manually adjusted to a different day)
                ...(dateUpdate.return_date && existingRental.end_date ? (() => {
                  const dayStart = new Date(existingRental.end_date); dayStart.setHours(0, 0, 0, 0);
                  const dayEnd = new Date(existingRental.end_date); dayEnd.setHours(23, 59, 59, 999);
                  return { OR: [
                    { return_date: { gte: dayStart, lte: dayEnd } },
                    { return_date: null },
                  ] };
                })() : {}),
              },
              data: dateUpdate,
            });
            if (cascaded.count > 0) {
              this.logger.log(`📅 Cascaded date change to ${cascaded.count} booking(s) for ${updatedRental.title}: end ${oldEnd?.slice(0, 10)} → ${newEnd?.slice(0, 10)}`);
            }
          } catch (err) {
            this.logger.warn(`Date cascade failed for ${existingRental.id}: ${err.message}`);
          }
        }

        // Cascade renter name updates to bookings and profile (Hygglo verification may change name)
        if (rental.renterInfo && rental.renterInfo !== existingRental.renter_info) {
          const oldName = existingRental.renter_info;
          const newName = rental.renterInfo;
          this.logger.log(`Renter name changed on rental ${existingRental.listing_id}: "${oldName}" → "${newName}"`);

          try {
            await this.prisma.booking.updateMany({
              where: { rental_id: existingRental.id, status: { in: ['confirmed', 'pending_review'] } },
              data: { renter_name: newName },
            });
          } catch { /* non-critical */ }

          // Update renter profile: pair old+new name to same profile
          try {
            const renterUserId = rental.renterUserId;
            // First check if this rental is already linked to a profile
            const existingProfile = await this.renterProfileService.getProfileForRental(existingRental.id);
            if (existingProfile) {
              // Profile exists — update name via findOrCreateProfile (handles variant logic)
              await this.renterProfileService.findOrCreateProfile(newName, renterUserId || existingProfile.hygglo_user_id);
            } else {
              // No profile linked yet — create/find one and link
              const profile = await this.renterProfileService.findOrCreateProfile(newName, renterUserId);
              await this.renterProfileService.linkRentalToProfile(existingRental.id, profile.id);
            }
          } catch (profileErr) {
            this.logger.warn(`Renter profile update on name change failed: ${profileErr.message}`);
          }
        }

        // Cascade rental status changes to bookings (e.g., pending → upcoming promotes bookings)
        if (reconciledStatus !== existingRental.status) {
          try {
            await this.calendarService.cascadeRentalStatusToBookings(
              existingRental.id, reconciledStatus, existingRental.status,
            );
          } catch (err) {
            this.logger.warn(`Cascade status failed for rental ${existingRental.id}: ${err.message}`);
          }

          // Contention: check if status change resolves or triggers contention
          try {
            await this.contentionService.onRentalStatusChange(existingRental.id, reconciledStatus, rental.orderStep);
          } catch { /* non-critical */ }

          // Rental just became confirmed (pending → upcoming/ongoing)
          const wasUnconfirmed = ['pending', 'requested'].includes(existingRental.status);
          const isNowConfirmed = ['upcoming', 'ongoing'].includes(reconciledStatus);
          // Only treat as truly booked when renter has actually paid (FUNDS_RESERVED+)
          const isPaidConfirmed = !orderStep || PAID_ORDER_STEPS.includes(orderStep);
          if (wasUnconfirmed && isNowConfirmed && isPaidConfirmed) {
            // Send happy Telegram notification
            const earnings = rental.rentalPrice || updatedRental.rental_price || 0;
            const renter = rental.renterInfo || updatedRental.renter_info || 'Someone';
            const rawTitle = updatedRental.title || rental.title || 'gear';
            // Strip SEO noise: take only part before | or – separators, then strip (like X) suffixes
            const cleanItem = rawTitle
              .split(/\s*[|–—]\s*/)[0]
              .replace(/\s*\((?:like|similar to|comparable to|replaces|vs|or)\s[^)]+\)/gi, '')
              .trim();
            const accountRaw = updatedRental.account || existingRental.account || '';
            const accountLabel = accountRaw === 'leo' ? 'Leo' : accountRaw === 'dbcinema' ? 'DB Cinema' : accountRaw;
            try {
              await this.telegramService.sendProactiveMessage(
                `🎉 Woohoo! You just booked £${Math.round(earnings)} on ${accountLabel}!\n` +
                `${renter} — ${cleanItem}`,
                'Markdown',
                { force: true },
              );
            } catch (err) {
              this.logger.warn(`Failed to send booking confirmation notification: ${err.message}`);
            }

            // Push to dashboard activity feed so pending->confirmed is visible
            try {
              this.telegramService.sendRentalUpdate(existingRental.id, {
                type: 'info',
                priority: 'normal',
                data: { text: `Booking confirmed — £${Math.round(earnings)} revenue locked in` },
              }, {
                rentalTitle: rawTitle,
                renterName: typeof renter === 'string' ? renter : undefined,
                account: updatedRental.account || existingRental.account || undefined,
              });
            } catch { /* non-critical */ }

            // Auto-send confirmation info + time request to renter
            try {
              const followUpState = await this.prisma.follow_up_state.findUnique({
                where: { rental_id: existingRental.id },
              });
              if (followUpState && !(followUpState as any).time_request_sent) {
                // Build confirmation info message with address and logistics
                const account = updatedRental.account || rental.account || 'dbcinema';
                const startDate = updatedRental.start_date ? new Date(updatedRental.start_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
                const endDate = updatedRental.end_date ? new Date(updatedRental.end_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
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

                // Check if times already exist
                const bookings = await this.prisma.booking.findMany({
                  where: { rental_id: existingRental.id, status: 'confirmed' },
                  select: { pickup_time: true, return_time: true },
                });
                const hasAllTimes = bookings.length > 0 && bookings[0].pickup_time && bookings[0].return_time;

                // Merge confirmation + time request into single message
                let infoMessage =
                  `Your booking is confirmed! Here are the details:\n` +
                  `\nItems: ${cleanItem}${dateRange}` +
                  `\nPickup address: ${pickupAddress}${mapsLink}` +
                  `\nOpening times: 10am–12pm & 7–9pm` +
                  `\nDelivery available (separate charge) — let us know if needed.`;

                if (!hasAllTimes) {
                  infoMessage += `\n\nOne last thing — what are your exact pickup and return times? (Please include AM or PM)`;
                }

                await this.hyggloService.sendMessage(rental.listingId, infoMessage);
                await this.memoryService.storeConversation(`rental:${existingRental.id}`, 'assistant', infoMessage, { model: 'system' });

                await this.prisma.follow_up_state.update({
                  where: { id: followUpState.id },
                  data: {
                    time_request_sent: true,
                    time_request_sent_at: new Date(),
                    times_status: hasAllTimes ? 'confirmed' : 'none',
                  },
                });
                if (!hasAllTimes) {
                  this.logger.log(`Auto-sent confirmation info + time request for ${updatedRental.title}`);
                }
              }
            } catch (err) {
              this.logger.warn(`Failed to auto-send confirmation info on confirmation: ${err.message}`);
            }

            // DELIVERY ESCALATION: If delivery was discussed, notify Daniel with cost estimate + postcode
            try {
              const deliveryDecisions = await this.prisma.ai_decision.findMany({
                where: {
                  rental_id: existingRental.id,
                  OR: [
                    { input_summary: { contains: 'delivery', mode: 'insensitive' } },
                    { output_summary: { contains: 'delivery', mode: 'insensitive' } },
                    { input_summary: { contains: 'courier', mode: 'insensitive' } },
                    { output_summary: { contains: 'postcode', mode: 'insensitive' } },
                  ],
                },
                orderBy: { created_at: 'desc' },
                take: 5,
                select: { input_summary: true, output_summary: true, action_taken: true },
              });

              if (deliveryDecisions.length > 0) {
                // Extract postcode and cost estimate from decision records
                const allText = deliveryDecisions.map(d =>
                  [d.input_summary, d.output_summary, d.action_taken].filter(Boolean).join(' ')
                ).join(' ');

                const postcodeMatch = allText.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
                const costMatch = allText.match(/£(\d+)\s*[-–]\s*£?(\d+)/);
                const oneWayMatch = allText.match(/one[- ]?way[:\s]*£(\d+)/i);

                const postcode = postcodeMatch ? postcodeMatch[0].toUpperCase() : 'not found';
                let costEstimate = 'not calculated';
                if (costMatch) {
                  costEstimate = `£${costMatch[1]}-${costMatch[2]}`;
                } else if (oneWayMatch) {
                  costEstimate = `~£${oneWayMatch[1]} one-way`;
                }

                const renter = rental.renterInfo || updatedRental.renter_info || 'Renter';
                const items = updatedRental.title || rental.title || 'gear';

                // Idempotent delivery escalation — transaction prevents race condition duplicates
                await this.prisma.$transaction(async (tx) => {
                  const alreadyEscalated = await tx.ai_decision.findFirst({
                    where: {
                      rental_id: existingRental.id,
                      decision_type: 'delivery_escalation_sent',
                    },
                  });

                  if (!alreadyEscalated) {
                    await this.telegramService.sendProactiveMessage(
                      `📦 Delivery booking needed!\n` +
                      `${renter} — ${items}\n` +
                      `Postcode: ${postcode}\n` +
                      `Estimated cost: ${costEstimate}\n` +
                      `Please verify and confirm actual delivery cost with the renter.`,
                      'Markdown',
                      { force: true },
                    );

                    await tx.ai_decision.create({
                      data: {
                        rental_id: existingRental.id,
                        decision_type: 'delivery_escalation_sent',
                        input_summary: `Delivery escalation: ${postcode}, est ${costEstimate}`,
                        output_summary: `Telegram notification sent for delivery verification`,
                        confidence: 1.0,
                        action_taken: 'delivery_escalation_sent',
                        notified: true,
                      },
                    });

                    this.logger.log(`Delivery escalation sent for ${items} (${postcode}, ${costEstimate})`);
                  }
                });
              }
            } catch (delErr) {
              this.logger.warn(`Delivery escalation check failed: ${delErr.message}`);
            }

            // NOTES FLUSH: Write accumulated conversation notes to booking records
            try {
              const convState = await this.followUpService.getStructuredState(existingRental.id);
              if (convState.rentalNotes?.length) {
                for (const note of convState.rentalNotes) {
                  await this.calendarService.addDecisionNotesToBookings(existingRental.id, note);
                }
                this.logger.log(`Flushed ${convState.rentalNotes.length} conversation note(s) to bookings for ${updatedRental.title}`);
              }
            } catch (notesErr) {
              this.logger.warn(`Notes flush on confirmation failed: ${notesErr.message}`);
            }
          }
        }

        // Backfill: create bookings if this rental has dates/price but no bookings yet
        // Check ALL statuses (confirmed + pending_review) to prevent re-creating overbooked items every scan
        const hasBookings = await this.prisma.booking.count({
          where: { rental_id: existingRental.id, status: { in: ['confirmed', 'pending_review', 'completed'] } },
        });

        // Check if this rental was previously unmatchable but now has valid parsed_items
        const wasUnmatchable = this.failedBackfillRentals.has(existingRental.id);

        if (hasBookings === 0 && updatedRental.start_date && updatedRental.end_date
            && !wasUnmatchable) {
          try {
            // Use item resolver cascade (catalog -> photo ref -> pattern -> detail -> AI)
            const resolved = await this.itemResolverService.resolveItems(
              rental.listingId, rental.title, rental._detail,
            );
            const itemNames = this.itemResolverService.toItemNames(resolved);

            const ownerEarnings = rental._detail?.price?.ownerEarnings;
            const rentalForBooking = {
              ...updatedRental,
              rental_price: ownerEarnings ?? updatedRental.rental_price,
            };

            const createdBookings = await this.calendarService.createBookingsFromRental(
              rentalForBooking,
              itemNames,
            );

            if (createdBookings.length > 0) {
              this.logger.log(`📅 Backfilled ${createdBookings.length} booking(s) for existing rental: ${rental.title}`);
            } else {
              // No bookings created — items don't match inventory. Stop retrying.
              this.failedBackfillRentals.add(existingRental.id);
              // Only persist if not already persisted (avoid duplicate records)
              if (true) {
                await this.prisma.ai_decision.create({
                  data: {
                    rental_id: existingRental.id,
                    decision_type: 'backfill_unmatchable',
                    input_summary: `Backfill failed: "${rental.title}"`,
                    output_summary: 'Items do not match inventory — permanently skipped',
                    confidence: 1,
                    action_taken: 'marked_unmatchable',
                    notified: false,
                  },
                }).catch(() => {}); // non-critical
              }
              this.logger.warn(`Backfill produced 0 bookings for "${rental.title}" — marked as unmatchable, won't retry`);
            }
          } catch (err) {
            this.logger.warn(`Backfill booking failed for ${rental.title}: ${err.message}`);
          }
        }

        // Auto-promote: if rental is accepted on Hygglo but bookings are still pending_review
        // (from auto-accepted detection on first scan), promote after 2 hours.
        // Uses booking.updated_at (not rental.created_at) so manually-demoted bookings get a fresh window.
        // Only promote bookings when renter has paid (FUNDS_RESERVED+) — not just owner-approved
        const isAccepted = ['upcoming', 'ongoing', 'completed'].includes(reconciledStatus) && (!orderStep || PAID_ORDER_STEPS.includes(orderStep));
        if (isAccepted && hasBookings > 0) {
          const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
          try {
            const pendingBookings = await this.prisma.booking.findMany({
              where: { rental_id: existingRental.id, status: 'pending_review' },
              select: { id: true, item_name: true, updated_at: true },
            });
            if (pendingBookings.length > 0) {
              let promoted = 0;
              for (const pb of pendingBookings) {
                // Only promote if this booking has been pending_review for 2+ hours
                const bookingAge = Date.now() - new Date(pb.updated_at).getTime();
                if (bookingAge < TWO_HOURS_MS) continue;

                const avail = await this.calendarService.checkAvailability(
                  pb.item_name,
                  updatedRental.start_date!,
                  updatedRental.end_date!,
                );
                if (avail.available) {
                  await this.prisma.booking.update({
                    where: { id: pb.id },
                    data: { status: 'confirmed' },
                  });
                  promoted++;
                }
              }
              // Force-promote: pending bookings >24h on accepted rental (even if some already confirmed)
              if (pendingBookings.length > 0) {
                const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
                const oldPending = pendingBookings.filter(
                  pb => (Date.now() - new Date(pb.updated_at).getTime()) >= TWENTY_FOUR_HOURS_MS,
                );

                if (oldPending.length > 0) {
                  await this.prisma.booking.updateMany({
                    where: { id: { in: oldPending.map(pb => pb.id) } },
                    data: { status: 'confirmed' },
                  });
                  promoted += oldPending.length;
                  this.logger.warn(`⚠️ Force-promoted ${oldPending.length} pending bookings (>24h) for: ${rental.title}`);
                  this.diagnosticService?.log('scan_cycle', 'force_promote', `Force-promoted ${oldPending.length} bookings for ${rental.title}`, { rental: rental.title, count: oldPending.length, items: oldPending.map(pb => pb.item_name) }, rental.id);

                  try {
                    await this.telegramService?.sendProactiveMessage?.(
                      `⚠️ *Force-promoted* — ${rental.title}\n` +
                      `${oldPending.length} booking(s) pending >24h.\n` +
                      `Items: ${oldPending.map(pb => pb.item_name).join(', ')}\n` +
                      `Check for overbooking.`,
                    );
                  } catch { /* best-effort */ }
                }
              }

              if (promoted > 0) {
                this.logger.log(`📅 Auto-promoted ${promoted} pending bookings for accepted rental: ${rental.title}`);
              }
            }
          } catch (err) {
            this.logger.warn(`Auto-promote failed for ${rental.title}: ${err.message}`);
          }
        }

        // Update renter rating on existing rentals (catches rating changes over time)
        if (rental.renterRating !== undefined && rental.renterRating !== null) {
          try {
            const renterLink = await this.prisma.rental_renter_link.findFirst({
              where: { rental_id: existingRental.id },
              select: { renter_profile_id: true },
            });
            if (renterLink) {
              await this.prisma.renter_profile.update({
                where: { id: renterLink.renter_profile_id },
                data: {
                  hygglo_rating: rental.renterRating,
                  hygglo_review_count: rental.renterReviewCount || 0,
                  rating_checked_at: new Date(),
                },
              });
            }
          } catch {
            // Non-critical — rating update for existing rental
          }
        }

        this.logger.log(`🔄 Updated rental: ${rental.title}`);
        return { isNew: false }; // Not a new rental
      }

      // Fetch detailed information for new rental
      this.logger.log(`✨ New rental found: ${rental.title}`);
      let description = rental.description || '';
      let photosUrls = rental.photosUrls || [];

      // Try to fetch more details from listing page
      if (rental.listingUrl) {
        const details = await this.hyggloService.fetchListingDetails(rental.listingUrl);
        if (details.description) description = details.description;
        if (details.photosUrls.length > 0) photosUrls = details.photosUrls;
      }

      // Parse items from title using AI, then enhance with photo vision if needed
      let parsedItems: any = null;
      try {
        const resolved = await this.itemResolverService.resolveItems(rental.listingId, rental.title, rental._detail);
        parsedItems = resolved.map(r => ({ item: r.item, qty: r.qty }));
      } catch { /* non-critical */ }

      // Save new rental to database (including price data)
      const orderStep = this.extractActiveOrderStep(rental._detail);

      // Reconcile status with order_step for new rentals too
      let newRentalStatus = rental.status;
// If order_step is RETURNED, rental is done — mark completed regardless of Hygglo status        if (orderStep === "RETURNED") {          reconciledStatus = "completed";        }
      if (orderStep === 'DELIVERED' && rental.startDate && rental.startDate <= new Date()) {
        if (newRentalStatus !== 'ongoing') {
          this.logger.log(`🔄 New rental status reconciled: ${newRentalStatus} → ongoing (order_step=${orderStep}, rental period started)`);
          newRentalStatus = 'ongoing';
        }
      }

      // Only treat as upcoming when renter has paid (FUNDS_RESERVED+). APPROVED = pending.
      if (newRentalStatus === 'upcoming' && orderStep && !PAID_ORDER_STEPS.includes(orderStep)) {
        newRentalStatus = 'pending';
      }

      const savedRental = await this.prisma.rental.create({
        data: {
          listing_id: rental.listingId,
          title: rental.title,
          status: newRentalStatus,
          start_date: rental.startDate,
          end_date: rental.endDate,
          renter_info: rental.renterInfo,
          listing_url: rental.listingUrl,
          description,
          photos_urls: photosUrls,
          account: rental.account || null,
          rental_price: rental.rentalPrice ?? null,
          renter_price: rental.renterPrice ?? null,
          price_per_day: rental.pricePerDay ?? null,
          currency: rental.currency ?? null,
          listing_location: rental.listingLocation ?? null,
          ...(parsedItems ? { parsed_items: parsedItems } : {}),
          ...(orderStep ? { order_step: orderStep } : {}),
        },
      });

      this.loggingService.info('New rental saved', {
        rentalId: savedRental.id,
        listingId: savedRental.listing_id,
        title: savedRental.title,
      });

      // Enhance parsed items with photo vision (Claude Haiku) and populate extracteditem table
      if (this.titleParserService && photosUrls.length > 0) {
        try {
          const enhanced = await this.titleParserService.enhanceWithPhotos(
            savedRental.id, rental.title, parsedItems || [], photosUrls, savedRental.listing_id,
          );
          // Photo reference override or vision enhancement: always take the result
          if (enhanced.length > 0) {
            parsedItems = enhanced;
          }
          // Also store in extracteditem table for use by autonomous/telegram/follow-up
          // Brand integrity gate: downgrade confidence for cross-brand photo matches
          for (const item of (parsedItems || [])) {
            try {
              const brandCheck = detectBrandMismatch(rental.title, item.item);
              await this.prisma.extracteditem.create({
                data: {
                  rental_id: savedRental.id,
                  item_name: item.item,
                  source: brandCheck.isMismatch ? 'photo_cross_brand' : 'photo',
                  confidence_score: brandCheck.isMismatch ? 0.3 : 0.9,
                },
              });
              if (brandCheck.isMismatch) {
                this.logger.warn(`Brand mismatch: "${rental.title}" photo matched to "${item.item}" (${brandCheck.listingBrand} ≠ ${brandCheck.itemBrand})`);
              }
            } catch { /* ignore dups */ }
          }
        } catch { /* non-critical */ }
      }

      // Auto-store price memory if price data available
      if (savedRental.rental_price) {
        const curr = savedRental.currency || 'GBP';
        const symbol = curr === 'GBP' ? '£' : curr === 'SEK' ? 'kr' : curr;
        const dateRange = savedRental.start_date && savedRental.end_date
          ? `${savedRental.start_date.toISOString().split('T')[0]} to ${savedRental.end_date.toISOString().split('T')[0]}`
          : 'dates unknown';
        const priceMemory = `${savedRental.renter_info || 'Unknown renter'} booked ${savedRental.title} for ${symbol}${savedRental.rental_price}${savedRental.price_per_day ? ` (${symbol}${savedRental.price_per_day}/day)` : ''} (${dateRange})`;
        await this.memoryService.storeMemory('fact', `Rental price: ${savedRental.title}`, priceMemory, 6);
        this.logger.log(`Stored price memory: ${priceMemory}`);
      }

      // Note: Photo-based item extraction is handled above by enhanceWithPhotos (Claude Haiku vision)
      // Results are stored in both rental.parsed_items AND extracteditem table

      // Auto-create calendar bookings from resolved items
      try {
        // Use item resolver (already ran above for parsed_items, reuse those results)
        const resolvedForBooking = await this.itemResolverService.resolveItems(
          rental.listingId, rental.title, rental._detail,
        );
        const allItemNames = this.itemResolverService.toItemNames(resolvedForBooking);

        // Use owner earnings as revenue (what the owner actually receives)
        const ownerEarnings = rental._detail?.price?.ownerEarnings;
        const rentalForBooking = {
          ...savedRental,
          rental_price: ownerEarnings ?? savedRental.rental_price,
        };

        // Auto-accepted detection: if this NEW rental arrives already as upcoming/ongoing,
        // it was auto-accepted on Hygglo (instant booking) before the scanner could track it.
        // Create bookings as pending_review so they don't appear in the calendar until the
        // owner is notified. They auto-promote to confirmed after 2 hours via the scan cycle.
        const isAutoAccepted = ['upcoming', 'ongoing'].includes(savedRental.status || '');
        const bookingOptions = isAutoAccepted ? { forceStatus: 'pending_review' as const } : undefined;

        const createdBookings = await this.calendarService.createBookingsFromRental(
          rentalForBooking,
          allItemNames,
          bookingOptions,
        );

        // Sync bookings with extracted items — clean up stale item names
        try {
          await this.calendarService.syncBookingsWithExtractedItems(savedRental.id);
        } catch { /* non-critical */ }

        if (createdBookings.length > 0) {
          const overbookedItems = createdBookings.filter(b => b.wasOverbooked && b.maxQuantity > 0);
          this.logger.log(`📅 Auto-created ${createdBookings.length} booking(s) for rental ${savedRental.title}${isAutoAccepted ? ' [AUTO-ACCEPTED → pending_review]' : ''}`);

          // Persist matched inventory items back to parsed_items (detail.items are transient)
          // This ensures reconciliation/backfill can see all items, not just title-parsed ones
          try {
            const currentParsed: Array<{ item: string; qty: number }> = Array.isArray(parsedItems) ? parsedItems : [];
            const existingItems = new Set(currentParsed.map(p => p.item));
            let updated = false;
            for (const booking of createdBookings) {
              if (booking.item_name && !existingItems.has(booking.item_name)) {
                currentParsed.push({ item: booking.item_name, qty: booking.quantity || 1 });
                existingItems.add(booking.item_name);
                updated = true;
              }
            }
            if (updated) {
              await this.prisma.rental.update({
                where: { id: savedRental.id },
                data: { parsed_items: currentParsed as any },
              });
              this.logger.log(`📝 Updated parsed_items with ${createdBookings.length} matched inventory item(s) from detail.items`);
            }
          } catch (err) {
            this.logger.warn(`Failed to persist detail.items to parsed_items: ${err.message}`);
          }

          // Notifications
          if (this.telegramService) {
            // Auto-accepted rental: send FORCED notification so Daniel knows about this booking
            if (isAutoAccepted) {
              const earnings = ownerEarnings ?? savedRental.rental_price ?? 0;
              const items = createdBookings.map(b => b.item_name).join(', ');
              const startStr = savedRental.start_date ? new Date(savedRental.start_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '?';
              const endStr = savedRental.end_date ? new Date(savedRental.end_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '?';
              try {
                await this.telegramService.sendProactiveMessage(
                  `⚠️ AUTO-ACCEPTED rental detected!\n` +
                  `👤 ${savedRental.renter_info || 'Unknown'} · 💰 £${Math.round(earnings)}\n` +
                  `📅 ${startStr}–${endStr} · ${savedRental.account || 'dbcinema'}\n` +
                  `📦 ${items}\n\n` +
                  `Calendar entry is PENDING — will auto-confirm in ~2h.\n` +
                  `Check Hygglo if you didn't expect this booking.`,
                  'Markdown',
                  { force: true },
                );
              } catch (err) {
                this.logger.warn(`Failed to send auto-accepted notification: ${err.message}`);
              }
            }

            // Availability conflict notification
            if (overbookedItems.length > 0) {
              this.telegramService.sendRentalUpdate(savedRental.id, {
                type: 'availability_conflict', priority: 'high',
                data: { overbookedItems },
              }, { rentalTitle: savedRental.title, renterName: savedRental.renter_info || undefined, account: savedRental.account || undefined }).catch(err => {
                this.logger.warn(`Failed to send conflict notification: ${err.message}`);
              });
            }
          }
        } else {
          this.logger.warn(`No valid inventory items matched for rental ${savedRental.title} — no bookings created`);
        }
      } catch (bookingErr) {
        this.logger.warn(`Auto-booking failed for rental ${savedRental.title}: ${bookingErr.message}`);
      }

      // Link renter profile and initialize follow-up state
      try {
        const renterName = savedRental.renter_info || '';
        const renterUserId = rental.renterUserId;
        if (renterName) {
          const profile = await this.renterProfileService.findOrCreateProfile(renterName, renterUserId);
          await this.renterProfileService.linkRentalToProfile(savedRental.id, profile.id);

          // Check verification status from order detail
          if (rental._detail) {
            await this.verificationService.onOrderDetailReceived(
              rental.listingId,
              rental._detail,
              (rental.account || 'dbcinema') as 'dbcinema' | 'leo',
              profile.id,
            );
          }

          // Store renter rating from Hygglo API data
          if (rental.renterRating !== undefined && rental.renterRating !== null) {
            try {
              await this.prisma.renter_profile.update({
                where: { id: profile.id },
                data: {
                  hygglo_rating: rental.renterRating,
                  hygglo_review_count: rental.renterReviewCount || 0,
                  rating_checked_at: new Date(),
                },
              });
              if (rental.renterRating < 5) {
                this.logger.warn(`LOW RATING RENTER: ${renterName} has ${rental.renterRating}/5 stars (${rental.renterReviewCount} reviews) for ${rental.title}`);
              }
            } catch (ratingErr) {
              this.logger.debug(`Failed to store renter rating: ${ratingErr.message}`);
            }
          }
        }

        // Initialize follow-up state for timer tracking
        await this.followUpService.initializeFollowUpState(savedRental.id);
      } catch (profileErr) {
        this.logger.warn(`Renter profile/follow-up init failed for ${savedRental.title}: ${profileErr.message}`);
      }

      // Attach renter rating to savedRental for downstream use (onNewRental)
      if (rental.renterRating !== undefined) {
        (savedRental as any)._renterRating = rental.renterRating;
        (savedRental as any)._renterReviewCount = rental.renterReviewCount;
        (savedRental as any)._renterUserId = rental.renterUserId;
      }

      return { isNew: true, savedRental, rawRental: rental };
    } catch (error) {
      this.logger.error(`❌ Error processing rental: ${rental.title}`, error);
      this.loggingService.error('Error processing rental', {
        listingId: rental.listingId,
        error: error.message,
      });
      return { isNew: false };
    }
  }

  /**
   * Extract the active Hygglo order step from the detail's steps array.
   * Steps: REQUEST → APPROVED → FUNDS_RESERVED → VERIFIED → BOOKED_AFTER_VERIFIED → DELIVERED → RETURNED → REVIEWED
   * Returns the key of the step where active=true, or null if not available.
   */
  private extractActiveOrderStep(detail: any): string | null {
    if (!detail?.steps || !Array.isArray(detail.steps)) return null;
    const active = detail.steps.find((s: any) => s.active === true);
    return active?.key || null;
  }

  /**
   * Extract item names from the order detail's items array.
   * Each item in the detail has a name field (the product title on Hygglo).
   */

  /**
   * Group new rentals by renter to detect multi-item requests.
   * Uses renterUserId (Hygglo user ID) as primary key, falls back to renter_info.
   */
  private groupNewRentalsByRenter(
    results: Array<{ savedRental: any; rawRental: any }>,
  ): Map<string, Array<{ savedRental: any; rawRental: any }>> {
    const groups = new Map<string, Array<{ savedRental: any; rawRental: any }>>();

    for (const entry of results) {
      // Prefer Hygglo user ID for grouping
      let key = entry.rawRental.renterUserId;

      if (!key) {
        // Fallback to renter_info lowercased
        const renterInfo = (entry.savedRental.renter_info || '').trim().toLowerCase();
        key = renterInfo || `__rental_${entry.savedRental.id}`;
      }

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(entry);
    }

    return groups;
  }

  /**
   * Handle multi-item rental requests from the same renter.
   * Consolidates into the primary (highest-priced) chat and redirects secondaries.
   */
  private async handleMultiItemRequest(
    group: Array<{ savedRental: any; rawRental: any }>,
  ): Promise<void> {
    // Sort by rental_price descending — first is primary
    const sorted = [...group].sort((a, b) => {
      const priceA = a.savedRental.rental_price || 0;
      const priceB = b.savedRental.rental_price || 0;
      return priceB - priceA;
    });

    const primary = sorted[0];
    const secondaries = sorted.slice(1);
    const renterName = primary.savedRental.renter_info || 'there';
    const firstName = renterName.split(' ')[0];

    // Build item list with prices
    const allItems = sorted.map((entry, i) => {
      const price = entry.savedRental.rental_price ? ` (£${entry.savedRental.rental_price})` : '';
      return `${i + 1}. ${entry.savedRental.title}${price}`;
    });
    const totalValue = sorted.reduce((sum, e) => sum + (e.savedRental.rental_price || 0), 0);
    const totalLine = totalValue > 0 ? `\n\nTotal: £${totalValue.toFixed(2)}` : '';

    // Send assertive consolidation message in primary chat — present the bundle, don't ask permission
    const primaryMessage =
      `Hi ${firstName}! I can see you've sent ${sorted.length} separate requests — I've pulled them all together here:\n\n` +
      allItems.join('\n') +
      totalLine + '\n\n' +
      `Everything looks good on my end. Just confirm you're happy with all of these and I'll get it all sorted at once.`;

    // sendMessage handles READ_ONLY_MODE gating internally (with per-rental exceptions)
    try {
      await this.hyggloService.sendMessage(primary.savedRental.listing_id, primaryMessage);
    } catch (err) {
      this.logger.warn(`Failed to send consolidation message for ${primary.savedRental.title}: ${err.message}`);
    }

    // Close secondary chats: send a brief note then decline the Hygglo listing via Playwright
    for (const secondary of secondaries) {
      const redirectMessage =
        `Hi! I've combined your request with your other enquiries — handling everything together in the ${primary.savedRental.title} chat. ` +
        `I'll close this one and get it all sorted from there.`;

      try {
        await this.hyggloService.sendMessage(secondary.savedRental.listing_id, redirectMessage);
      } catch (err) {
        this.logger.warn(`Failed to send redirect message for ${secondary.savedRental.title}: ${err.message}`);
      }

      // Decline the secondary listing on Hygglo so the renter doesn't see it as open
      try {
        const account = secondary.savedRental.account || 'dbcinema';
        await this.followUpService.declineSecondaryRental(secondary.savedRental.listing_id, account, secondary.savedRental.id);
      } catch (err) {
        this.logger.warn(`Failed to decline secondary listing on Hygglo for ${secondary.savedRental.title}: ${(err as Error).message}`);
      }

      // Store ai_decision for audit trail on each secondary
      try {
        await this.prisma.ai_decision.create({
          data: {
            rental_id: secondary.savedRental.id,
            decision_type: 'analyze',
            input_summary: `multi_item_secondary_closed: redirected to primary chat (${primary.savedRental.title})`,
            output_summary: `Renter sent ${sorted.length} separate requests. Consolidated into primary rental. Secondary closed.`,
            confidence: 1.0,
            action_taken: `Sent redirect to primary chat: ${primary.savedRental.title}`,
            notified: true,
          },
        });
      } catch (dbErr) {
        this.logger.warn(`Failed to store multi-item decision: ${dbErr.message}`);
      }

      // Mark secondary rental as consolidated (prevents further processing)
      try {
        await this.prisma.rental.update({
          where: { id: secondary.savedRental.id },
          data: { status: 'consolidated' },
        });
      } catch (statusErr) {
        this.logger.debug(`Failed to mark secondary as consolidated: ${statusErr.message}`);
      }

      // Cascade: cancel bookings on the consolidated rental
      try {
        await this.calendarService.cascadeRentalStatusToBookings(secondary.savedRental.id, 'consolidated');
      } catch (cascErr) {
        this.logger.debug(`Failed to cascade consolidated bookings: ${cascErr.message}`);
      }

      // Mark any follow-up state as completed for secondary
      try {
        await this.prisma.follow_up_state.updateMany({
          where: { rental_id: secondary.savedRental.id },
          data: { status: 'completed' },
        });
      } catch {
        // Follow-up state may not exist
      }
    }

    this.logger.log(`Multi-item request from ${renterName}: ${sorted.length} items consolidated into ${primary.savedRental.title}`);

    // Attach multi-item context to primary and trigger autonomous pipeline
    const multiItemContext = {
      allItems: sorted.map(e => ({
        title: e.savedRental.title,
        price: e.savedRental.rental_price || 0,
        rentalId: e.savedRental.id,
      })),
      totalValue: sorted.reduce((sum, e) => sum + (e.savedRental.rental_price || 0), 0),
      secondaryRentalIds: secondaries.map(e => e.savedRental.id),
    };

    primary.savedRental._multiItemContext = multiItemContext;

    if (this.autonomousService) {
      this.autonomousService.onNewRental(primary.savedRental).catch((err) => {
        this.logger.error(`Autonomous pipeline error for multi-item primary ${primary.savedRental.title}: ${err.message}`);
      });
    }

    this.logger.log(
      `Multi-item request consolidated: ${sorted.length} rentals from ${renterName} → primary: ${primary.savedRental.title}`,
    );
  }

  /**
   * Cross-account duplicate rule: If the same renter requests on both accounts,
   * always discard Leo's rental and keep DB Cinema (higher-priced).
   * Checks both: (1) same-batch duplicates, (2) existing DB rentals.
   * Returns true if this rental was discarded.
   */
  private async discardCrossAccountDuplicate(
    rental: any,
    batchResults: Array<{ savedRental: any; rawRental: any }>,
  ): Promise<boolean> {
    if (!rental.account || !rental.renter_info) return false;

    const renterNorm = rental.renter_info.trim().toLowerCase();
    const rentalAccount = rental.account as string;

    // (1) Check same-batch: both accounts in this scan batch
    const otherAccountInBatch = batchResults.find(r => {
      if (r.savedRental.id === rental.id) return false;
      const otherRenter = (r.savedRental.renter_info || '').trim().toLowerCase();
      const otherAccount = r.savedRental.account as string;
      return this.rentersMatch(otherRenter, renterNorm) && otherAccount !== rentalAccount;
    });

    // Helper: compare prices to determine which rental should win.
    // Winner = higher rental_price; DB Cinema wins ties.
    const myPrice = Number(rental.rental_price) || 0;
    const iAmLoser = (otherPrice: number, otherAccount: string) =>
      otherPrice > myPrice || (otherPrice === myPrice && rentalAccount !== 'dbcinema' && otherAccount === 'dbcinema');

    if (otherAccountInBatch) {
      // Both accounts in same batch — discard the less profitable one
      const otherPrice = Number(otherAccountInBatch.savedRental.rental_price) || 0;
      const otherAccount = otherAccountInBatch.savedRental.account as string;
      if (iAmLoser(otherPrice, otherAccount)) {
        await this.closeAsAccountDuplicate(rental, otherAccount);
        return true;
      }
      // I am the winner — the other account's iteration will discard itself
      return false;
    }

    // (2) Check existing rentals: same renter, other account, overlapping dates, active status
    if (rentalAccount === 'leo') {
      // Check all DB Cinema rentals for same renter + date overlap
      const dbCinemaRentals = await this.prisma.rental.findMany({
        where: {
          account: 'dbcinema',
          status: { in: ['pending', 'upcoming', 'ongoing'] },
          renter_info: { not: null },
        },
        select: { id: true, renter_info: true, start_date: true, end_date: true, listing_id: true, title: true, rental_price: true },
      });

      for (const dbRental of dbCinemaRentals) {
        const dbRenter = (dbRental.renter_info || '').trim().toLowerCase();
        if (!this.rentersMatch(dbRenter, renterNorm) || !this.datesOverlap(rental, dbRental)) continue;
        const dbPrice = Number(dbRental.rental_price) || 0;
        if (iAmLoser(dbPrice, 'dbcinema')) {
          await this.closeAsAccountDuplicate(rental, 'dbcinema', dbRental);
          return true;
        }
        // Leo earns more — close the DB Cinema rental instead and keep Leo
        await this.closeAsAccountDuplicate(dbRental, 'leo', rental);
        return false; // Leo survives
      }
    }

    // If this is DB Cinema and same renter already exists on Leo → close the less profitable
    if (rentalAccount === 'dbcinema') {
      const leoRentals = await this.prisma.rental.findMany({
        where: {
          account: 'leo',
          status: { in: ['pending', 'upcoming', 'ongoing'] },
          renter_info: { not: null },
        },
        select: { id: true, renter_info: true, start_date: true, end_date: true, listing_id: true, title: true, rental_price: true },
      });

      for (const leoRental of leoRentals) {
        const leoRenter = (leoRental.renter_info || '').trim().toLowerCase();
        if (!this.rentersMatch(leoRenter, renterNorm) || !this.datesOverlap(rental, leoRental)) continue;
        const leoPrice = Number(leoRental.rental_price) || 0;
        if (leoPrice > myPrice) {
          // Leo earns more — close DB Cinema (me), keep Leo
          await this.closeAsAccountDuplicate(rental, 'leo', leoRental);
          return true;
        }
        // DB Cinema earns equal or more — close Leo
        await this.closeExistingLeoRental(leoRental, rental);
      }
    }

    return false;
  }

  /**
   * Check if two rentals have overlapping date ranges.
   * Generous overlap: treats missing dates as matching.
   */
  private datesOverlap(a: any, b: any): boolean {
    const aStart = a.start_date ? new Date(a.start_date).getTime() : null;
    const aEnd = a.end_date ? new Date(a.end_date).getTime() : null;
    const bStart = b.start_date ? new Date(b.start_date).getTime() : null;
    const bEnd = b.end_date ? new Date(b.end_date).getTime() : null;

    // If either rental is missing dates, assume overlap (same renter = likely same request)
    if (!aStart || !aEnd || !bStart || !bEnd) return true;

    // Standard overlap check: A starts before B ends AND A ends after B starts
    // Use <= and >= so same-day rentals (start===end) correctly match each other
    return aStart <= bEnd && aEnd >= bStart;
  }

  /**
   * Close a losing rental as a cross-account duplicate — redirect renter to the winning account.
   * Can close either Leo or DB Cinema depending on which earns more.
   */
  private async closeAsAccountDuplicate(loserRental: any, preferredAccount: string, winnerRental?: any) {
    const renterName = loserRental.renter_info || 'there';
    const firstName = renterName.split(' ')[0];
    const loserAccount = loserRental.account as string;

    this.logger.log(
      `🔄 Cross-account duplicate: ${renterName} requested on both accounts. Closing ${loserAccount} rental "${loserRental.title}", keeping ${preferredAccount}.`,
    );

    // Redirect message — generic wording that works for either account being closed
    const winnerLabel = preferredAccount === 'dbcinema' ? 'our main account' : 'our other listing';
    const message =
      `Hi ${firstName}! I can see you've also sent a request on ${winnerLabel}. ` +
      `I'll handle everything through that chat — makes it easier to coordinate. ` +
      `Please continue the conversation there!`;

    try {
      await this.hyggloService.sendMessage(loserRental.listing_id, message);
    } catch (err) {
      this.logger.warn(`Failed to send cross-account redirect for ${loserRental.listing_id}: ${err.message}`);
    }

    // Mark as consolidated
    try {
      await this.prisma.rental.update({
        where: { id: loserRental.id },
        data: { status: 'consolidated' },
      });
    } catch (err) {
      this.logger.warn(`Failed to mark ${loserAccount} rental as consolidated: ${err.message}`);
    }

      // Cascade: cancel bookings on the consolidated rental
      try {
        await this.calendarService.cascadeRentalStatusToBookings(loserRental.id, 'consolidated');
      } catch (cascErr) {
        this.logger.debug(`Failed to cascade consolidated bookings: ${cascErr.message}`);
      }

    // Close follow-up state
    try {
      await this.prisma.follow_up_state.updateMany({
        where: { rental_id: loserRental.id },
        data: { status: 'completed' },
      });
    } catch { /* may not exist yet */ }

    // Audit trail
    try {
      await this.prisma.ai_decision.create({
        data: {
          rental_id: loserRental.id,
          decision_type: 'cross_account_duplicate',
          input_summary: `Same renter "${renterName}" requested on both Leo and DB Cinema accounts`,
          output_summary: `Discarded ${loserAccount} rental — redirected to ${preferredAccount} (higher earnings)`,
          confidence: 1.0,
          action_taken: `consolidated_to_${preferredAccount}`,
          notified: true,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to store cross-account decision: ${err.message}`);
    }

    // Log decision for the WINNER rental so it's flagged in audit trail
    if (winnerRental) {
      try {
        await this.prisma.ai_decision.create({
          data: {
            rental_id: winnerRental.id,
            decision_type: 'cross_account_duplicate',
            input_summary: `Cross-account winner: same renter "${renterName}" also requested on ${loserAccount}`,
            output_summary: `Retained as primary — ${loserAccount} rental (£${loserRental.rental_price || 0}) closed. Renter redirected here.`,
            confidence: 1.0,
            action_taken: `winner_retained_over_${loserAccount}`,
            notified: true,
          },
        });
      } catch (err) {
        this.logger.warn(`Failed to log cross-account winner decision: ${err.message}`);
      }
    }

    // Notify Daniel
    try {
      await this.telegramService.sendProactiveMessage(
        `🔄 Cross-account duplicate detected:\n` +
        `Renter: ${renterName}\n` +
        `${loserAccount} rental "${loserRental.title}" closed → continuing on ${preferredAccount}`,
      );
    } catch { /* non-critical */ }
  }

  /**
   * Close an existing Leo rental when a new DB Cinema request arrives from the same renter.
   */
  private async closeExistingLeoRental(leoRental: any, dbCinemaRental: any) {
    this.logger.log(
      `🔄 New DB Cinema request from same renter — closing existing Leo rental "${leoRental.title}"`,
    );

    const renterName = dbCinemaRental.renter_info || leoRental.renter_info || 'there';
    const firstName = renterName.split(' ')[0];

    // Send redirect message on Leo's chat
    const message =
      `Hi ${firstName}! I see you've also reached out on our main account. ` +
      `I'll handle everything through that chat instead — easier to coordinate. ` +
      `You can continue the conversation there!`;

    try {
      await this.hyggloService.sendMessage(leoRental.listing_id, message);
    } catch (err) {
      this.logger.warn(`Failed to send redirect on existing Leo rental: ${err.message}`);
    }

    // Mark as consolidated
    try {
      await this.prisma.rental.update({
        where: { id: leoRental.id },
        data: { status: 'consolidated' },
      });
    } catch (err) {
      this.logger.warn(`Failed to consolidate existing Leo rental: ${err.message}`);
    }

      // Cascade: cancel bookings on the consolidated rental
      try {
        await this.calendarService.cascadeRentalStatusToBookings(leoRental.id, 'consolidated');
      } catch (cascErr) {
        this.logger.debug(`Failed to cascade consolidated bookings: ${cascErr.message}`);
      }

    // Close follow-up
    try {
      await this.prisma.follow_up_state.updateMany({
        where: { rental_id: leoRental.id },
        data: { status: 'completed' },
      });
    } catch { /* may not exist */ }

    // Audit trail
    try {
      await this.prisma.ai_decision.create({
        data: {
          rental_id: leoRental.id,
          decision_type: 'cross_account_duplicate',
          input_summary: `Same renter "${renterName}" now on DB Cinema — closing Leo rental`,
          output_summary: `Existing Leo rental closed. DB Cinema rental "${dbCinemaRental.title}" is primary.`,
          confidence: 1.0,
          action_taken: 'consolidated_to_dbcinema',
          notified: true,
        },
      });
    } catch { /* non-critical */ }

    // Notify Daniel
    try {
      await this.telegramService.sendProactiveMessage(
        `🔄 Cross-account duplicate:\n` +
        `${renterName} has requests on both accounts.\n` +
        `Closed Leo "${leoRental.title}" → keeping DB Cinema "${dbCinemaRental.title}"`,
      );
    } catch { /* non-critical */ }
  }

  // --- Public scan data accessors (for other services to consume cached scan data) ---

  /**
   * Get cached messages for a listing from the last scan.
   * Returns null if no cache or cache is stale (> 10 min).
   */
  getCachedMessages(listingId: string): { sender: string; content: string; timestamp: string; imageUrls?: string[] }[] | null {
    const cached = this.messageCache.get(listingId);
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt > RentalScannerService.MESSAGE_CACHE_TTL_MS) {
      this.messageCache.delete(listingId);
      return null;
    }
    return cached.messages;
  }

  /** Get the last successful scan's rental list (for other services to check status). */
  getLastScanResults(): any[] {
    return this.lastScanRentals;
  }

  /**
   * Get rentals that were auto-completed since last check.
   * Drains the list (returns and clears).
   */
  getRecentlyCompleted(): any[] {
    const completed = [...this.recentlyCompletedRentals];
    this.recentlyCompletedRentals = [];
    return completed;
  }

  /**
   * Declarative consistency enforcer — runs every scan.
   * Defines 5 rules that detect and fix data inconsistencies.
   * If nothing is wrong, queries return empty and this exits in milliseconds.
   */
  private async enforceConsistency(): Promise<void> {
    const fixes: string[] = [];

    try {
      // Rule 1 — Terminal rentals → terminal bookings
      // cancelled/obsolete/consolidated rental → cancel all active bookings
      const toCancel: { id: string }[] = await this.prisma.$queryRaw`
        SELECT b.id FROM booking b
        JOIN rental r ON b.rental_id = r.id
        WHERE b.status IN ('pending_review', 'confirmed')
          AND r.status IN ('cancelled', 'obsolete', 'consolidated')
      `;
      if (toCancel.length > 0) {
        await this.prisma.booking.updateMany({
          where: { id: { in: toCancel.map(b => b.id) } },
          data: { status: 'cancelled' },
        });
        fixes.push(`R1: cancelled ${toCancel.length} bookings on dead rentals`);
      }

      // Note: completed rentals intentionally keep bookings as confirmed/pending_review
      // to avoid triggering backfill (hasBookings guard counts these statuses).
      // Booking status is only changed to 'completed' via explicit return processing.

      // Rule 2 — Pending rental → no confirmed bookings
      // Any confirmed booking on a pending rental → demote to pending_review
      const toDemote: { id: string }[] = await this.prisma.$queryRaw`
        SELECT b.id FROM booking b
        JOIN rental r ON b.rental_id = r.id
        WHERE b.status = 'confirmed'
          AND r.status = 'pending'
      `;
      if (toDemote.length > 0) {
        await this.prisma.booking.updateMany({
          where: { id: { in: toDemote.map(b => b.id) } },
          data: { status: 'pending_review' },
        });
        fixes.push(`R2: demoted ${toDemote.length} confirmed bookings on pending rentals`);
      }

      // Rule 3 — Revenue must match rental_price
      // For rentals with rental_price > 0 and active bookings where revenue is NULL or sum deviates > £0.50
      const revenueMismatches: { rental_id: string; rental_price: number; rev_sum: number | null; has_null: boolean }[] = await this.prisma.$queryRaw`
        SELECT
          r.id as rental_id,
          r.rental_price,
          SUM(b.revenue) as rev_sum,
          BOOL_OR(b.revenue IS NULL) as has_null
        FROM rental r
        JOIN booking b ON b.rental_id = r.id AND b.status IN ('confirmed', 'pending_review')
        WHERE r.rental_price > 0
          AND r.status IN ('upcoming', 'ongoing')
        GROUP BY r.id, r.rental_price
        HAVING BOOL_OR(b.revenue IS NULL) = true
           OR ABS(SUM(b.revenue) - r.rental_price) > 0.50
      `;
      if (revenueMismatches.length > 0) {
        for (const m of revenueMismatches) {
          try {
            await this.calendarService.recomputeRentalRevenue(m.rental_id, Number(m.rental_price));
            fixes.push(`R3: recomputed revenue for ${m.rental_id.slice(0, 8)} (sum=£${m.rev_sum ?? 'NULL'} vs price=£${m.rental_price})`);
          } catch (err) {
            this.logger.warn(`R3: revenue recompute failed for ${m.rental_id}: ${err.message}`);
          }
        }
      }

      // Rule 4 — Stale pending_review cleanup
      // pending_review bookings on rentals with end_date < 7 days ago → cancelled
      const stalePending: { id: string }[] = await this.prisma.$queryRaw`
        SELECT b.id FROM booking b
        JOIN rental r ON b.rental_id = r.id
        WHERE b.status = 'pending_review'
          AND r.end_date < NOW() - INTERVAL '7 days'
      `;
      if (stalePending.length > 0) {
        await this.prisma.booking.updateMany({
          where: { id: { in: stalePending.map(b => b.id) }, status: 'pending_review' },
          data: { status: 'cancelled' },
        });
        fixes.push(`R4: cancelled ${stalePending.length} stale pending_review bookings`);
      }

      // Rule 5 — Stuck pending_review on accepted rentals
      // pending_review bookings on upcoming/ongoing rentals with accepted order_step, older than 24h → confirmed
      const stuckPending: { id: string; item_name: string }[] = await this.prisma.$queryRaw`
        SELECT b.id, b.item_name FROM booking b
        JOIN rental r ON b.rental_id = r.id
        WHERE b.status = 'pending_review'
          AND r.status IN ('upcoming', 'ongoing')
          AND r.order_step IN ('DELIVERED', 'BOOKED_AFTER_VERIFIED', 'RETURNED')
          AND b.created_at < NOW() - INTERVAL '24 hours'
      `;
      if (stuckPending.length > 0) {
        await this.prisma.booking.updateMany({
          where: { id: { in: stuckPending.map(b => b.id) } },
          data: { status: 'confirmed' },
        });
        fixes.push(`R5: promoted ${stuckPending.length} stuck pending_review bookings (${stuckPending.map(b => b.item_name).join(', ')})`);
      }

      if (fixes.length > 0) {
        this.logger.log(`Consistency enforcer: ${fixes.join(' | ')}`);
      }
    } catch (err) {
      this.logger.warn(`Consistency enforcer failed: ${err.message}`);
    }
  }

  /**
   * Fuzzy renter name matching for cross-account deduplication.
   * Returns true if names likely refer to the same person:
   * - Exact match (case-insensitive)
   * - One name is a prefix of the other ("Sam K" matches "Sam Karam")
   * - Same first name + one last name is a prefix of the other ("Yosune A" matches "Yosune Aston")
   */
  private rentersMatch(a: string, b: string): boolean {
    const aNorm = a.trim().toLowerCase();
    const bNorm = b.trim().toLowerCase();

    // Exact match
    if (aNorm === bNorm) return true;

    // One is a prefix of the other
    if (aNorm.startsWith(bNorm) || bNorm.startsWith(aNorm)) return true;

    // Same first name + last name prefix
    const aParts = aNorm.split(/\s+/);
    const bParts = bNorm.split(/\s+/);
    if (aParts.length >= 2 && bParts.length >= 2 && aParts[0] === bParts[0]) {
      const aLast = aParts.slice(1).join(' ');
      const bLast = bParts.slice(1).join(' ');
      if (aLast.startsWith(bLast) || bLast.startsWith(aLast)) return true;
    }

    return false;
  }

  getStatus() {
    return {
      isScanning: this.isScanning,
      currentScanInterval: this.currentScanInterval,
      lastActivityTime: new Date(this.lastActivityTime).toISOString(),
      authenticated: this.hyggloService.getAuthenticationStatus(),
      currentAccount: this.hyggloService.getCurrentAccount(),
      configuredAccounts: this.hyggloService.getAccounts().map(a => a.name),
    };
  }
}
