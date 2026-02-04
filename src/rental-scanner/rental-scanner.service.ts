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

@Injectable()
export class RentalScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RentalScannerService.name);
  private isScanning = false;
  private lastActivityTime: number = Date.now();
  private currentScanInterval: number;
  private scannerTimeout: NodeJS.Timeout | null = null;
  private scanCount = 0;
  private shuttingDown = false;

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

    // Send startup notification
    const accounts = this.hyggloService.getAccounts();
    const readOnly = process.env.READ_ONLY_MODE === 'true';
    if (this.telegramService) {
      this.telegramService.sendProactiveMessage(
        `🚀 *Rental Manager Started*\n\n` +
        `├ 👤 Accounts: ${accounts.map(a => a.label).join(', ') || 'None configured'}\n` +
        `├ 🔒 Read-only: ${readOnly ? 'ON' : 'OFF'}\n` +
        `├ ⏰ Interval: ${this.INITIAL_SCAN_INTERVAL / 1000}s\n` +
        `└ 📡 First scan in 5s...`,
      ).catch(() => { /* ignore startup notification errors */ });
    }

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
      this.logger.log('🔍 ========== Starting Rental Scan ==========');
      this.loggingService.info('Scan started');

      // Scan all configured accounts (ongoing + upcoming for each)
      const allRentals = await this.hyggloService.scanAllAccounts('both');
      let newRentalsCount = 0;

      this.logger.log(`📊 Total rentals found: ${allRentals.length}`);

      // Process each rental and collect new ones for grouping
      const newRentalResults: Array<{ savedRental: any; rawRental: any }> = [];
      for (const rental of allRentals) {
        const result = await this.processRental(rental);
        if (result.isNew) {
          newRentalResults.push({ savedRental: result.savedRental, rawRental: result.rawRental });
          newRentalsCount++;
        }
      }

      // Group new rentals by renter, then dispatch
      if (this.autonomousService && newRentalResults.length > 0) {
        const renterGroups = this.groupNewRentalsByRenter(newRentalResults);
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
      if (this.autonomousService) {
        try {
          const messages = await this.hyggloService.checkNewMessages();
          const newMessages = messages.filter((m) => m.isNew);
          if (newMessages.length > 0) {
            this.logger.log(`New messages found: ${newMessages.length}`);
            await this.autonomousService.onNewMessages(newMessages);
          }
        } catch (msgError) {
          this.logger.warn(`Message check failed: ${msgError.message}`);
        }
      }

      const scanDuration = Date.now() - scanStartTime;
      this.scanCount++;
      this.logger.log(`Scan #${this.scanCount} completed in ${scanDuration}ms`);
      this.loggingService.info('Scan completed', { duration: scanDuration, newRentals: newRentalsCount });

    } catch (error) {
      this.logger.error('Error during scan: ' + error.message);
      this.loggingService.error('Scan failed', { error: error.message, stack: error.stack });

    } finally {
      this.isScanning = false;
      this.scheduleNextScan();
    }
  }

  private async processRental(rental: any): Promise<{ isNew: boolean; savedRental?: any; rawRental?: any }> {
    try {
      // Check if rental already exists
      const existingRental = await this.prisma.rental.findUnique({
        where: { listing_id: rental.listingId },
      });

      if (existingRental) {
        // Update existing rental (including dates and price if newly available)
        const updatedRental = await this.prisma.rental.update({
          where: { listing_id: rental.listingId },
          data: {
            title: rental.title,
            status: rental.status,
            renter_info: rental.renterInfo,
            photos_urls: rental.photosUrls,
            account: rental.account || existingRental.account,
            start_date: rental.startDate ?? existingRental.start_date,
            end_date: rental.endDate ?? existingRental.end_date,
            rental_price: rental.rentalPrice ?? existingRental.rental_price,
            price_per_day: rental.pricePerDay ?? existingRental.price_per_day,
            currency: rental.currency ?? existingRental.currency,
            updated_at: new Date(),
          },
        });

        // Backfill: create bookings if this rental has dates/price but no bookings yet
        const hasBookings = await this.prisma.booking.count({
          where: { rental_id: existingRental.id, status: 'confirmed' },
        });

        if (hasBookings === 0 && updatedRental.start_date && updatedRental.end_date) {
          try {
            // Get item names from _detail or use title
            const itemNames = this.extractItemNamesFromDetail(rental._detail, rental.title);
            const ownerEarnings = rental._detail?.price?.ownerEarnings;
            // Use owner earnings as the revenue (what the owner actually receives)
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
              if (this.telegramService) {
                const bookingLines = createdBookings.map(b => {
                  const status = b.wasOverbooked ? '⚠️ OVERBOOKED' : '✅';
                  const rev = b.revenue ? ` £${b.revenue}` : '';
                  return `│  ${status} ${b.item_name} x${b.quantity}${rev}`;
                });
                this.telegramService.sendProactiveMessage(
                  `📅 *Bookings Backfilled*\n\n` +
                  `├ 📦 ${updatedRental.title}\n` +
                  `├ 👤 ${updatedRental.renter_info || 'Unknown'}\n` +
                  `├ 📅 ${updatedRental.start_date.toISOString().split('T')[0]} → ${updatedRental.end_date.toISOString().split('T')[0]}\n` +
                  `├ 💰 £${rentalForBooking.rental_price || 0}\n` +
                  `${bookingLines.join('\n')}`,
                ).catch(() => {});
              }
            }
          } catch (err) {
            this.logger.warn(`Backfill booking failed for ${rental.title}: ${err.message}`);
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

      // Save new rental to database (including price data)
      const savedRental = await this.prisma.rental.create({
        data: {
          listing_id: rental.listingId,
          title: rental.title,
          status: rental.status,
          start_date: rental.startDate,
          end_date: rental.endDate,
          renter_info: rental.renterInfo,
          listing_url: rental.listingUrl,
          description,
          photos_urls: photosUrls,
          account: rental.account || null,
          rental_price: rental.rentalPrice ?? null,
          price_per_day: rental.pricePerDay ?? null,
          currency: rental.currency ?? null,
        },
      });

      this.loggingService.info('New rental saved', {
        rentalId: savedRental.id,
        listingId: savedRental.listing_id,
        title: savedRental.title,
      });

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

      // Process photos for item extraction
      if (photosUrls.length > 0) {
        this.logger.log(`🖼️ Analyzing ${photosUrls.length} photos...`);
        const extractedItems = await this.imageAnalysisService.analyzeImages(photosUrls);

        // Save extracted items from photos
        for (const item of extractedItems) {
          await this.prisma.extracteditem.create({
            data: {
              rental_id: savedRental.id,
              item_name: item.itemName,
              source: 'photo',
              confidence_score: item.confidenceScore,
            },
          });
        }

        this.logger.log(`✅ Saved ${extractedItems.length} items from photos`);
        this.loggingService.info('Items extracted from photos', {
          rentalId: savedRental.id,
          itemCount: extractedItems.length,
        });
      }

      // Process description for catalog items (one-time)
      let catalogItems: string[] = [];
      if (description) {
        this.logger.log('📝 Parsing description for items...');
        catalogItems = this.imageAnalysisService.parseDescriptionForItems(description);

        // Save catalog items
        for (const itemName of catalogItems) {
          try {
            await this.prisma.itemcatalog.create({
              data: {
                listing_id: rental.listingId,
                item_name: itemName,
                description: description.substring(0, 500), // Store excerpt
              },
            });
          } catch (error) {
            // Ignore duplicate errors (unique constraint)
            if (!error.message.includes('Unique constraint')) {
              this.logger.error('Error saving catalog item', error);
            }
          }
        }

        this.logger.log(`✅ Saved ${catalogItems.length} catalog items from description`);
        this.loggingService.info('Catalog items saved', {
          listingId: rental.listingId,
          itemCount: catalogItems.length,
        });
      }

      // Auto-create calendar bookings from extracted items
      try {
        // Combine items from detail, photo analysis, and description parsing
        const allItemNames: string[] = this.extractItemNamesFromDetail(rental._detail, rental.title);
        if (photosUrls.length > 0) {
          const photoItems = await this.prisma.extracteditem.findMany({
            where: { rental_id: savedRental.id },
            select: { item_name: true },
          });
          allItemNames.push(...photoItems.map(i => i.item_name));
        }
        allItemNames.push(...catalogItems);

        // Use owner earnings as revenue (what the owner actually receives)
        const ownerEarnings = rental._detail?.price?.ownerEarnings;
        const rentalForBooking = {
          ...savedRental,
          rental_price: ownerEarnings ?? savedRental.rental_price,
        };

        const createdBookings = await this.calendarService.createBookingsFromRental(
          rentalForBooking,
          allItemNames,
        );

        if (createdBookings.length > 0) {
          const overbookedItems = createdBookings.filter(b => b.wasOverbooked);
          this.logger.log(`📅 Auto-created ${createdBookings.length} booking(s) for rental ${savedRental.title}`);

          // Send booking summary to Telegram
          if (this.telegramService) {
            const bookingLines = createdBookings.map(b => {
              const status = b.wasOverbooked ? '⚠️ OVERBOOKED' : '✅';
              const rev = b.revenue ? ` £${b.revenue}` : '';
              return `│  ${status} ${b.item_name} x${b.quantity}${rev}`;
            });

            let bookingMsg = `📅 *Auto-Booked*\n\n` +
              `├ 📦 ${savedRental.title}\n` +
              `├ 👤 ${savedRental.renter_info || 'Unknown'}\n` +
              `├ 📅 ${savedRental.start_date ? savedRental.start_date.toISOString().split('T')[0] : '?'} → ${savedRental.end_date ? savedRental.end_date.toISOString().split('T')[0] : '?'}\n` +
              `├ 💰 £${savedRental.rental_price || 0}\n` +
              `${bookingLines.join('\n')}`;

            if (overbookedItems.length > 0) {
              bookingMsg += `\n\n🚨 *AVAILABILITY CONFLICT*\n` +
                overbookedItems.map(b => `  ⚠️ ${b.item_name}: ${b.maxQuantity - b.availableSlots}/${b.maxQuantity} already booked`).join('\n');
            }

            this.telegramService.sendProactiveMessage(bookingMsg).catch(err => {
              this.logger.warn(`Failed to send booking notification: ${err.message}`);
            });
          }
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
        }

        // Initialize follow-up state for timer tracking
        await this.followUpService.initializeFollowUpState(savedRental.id);
      } catch (profileErr) {
        this.logger.warn(`Renter profile/follow-up init failed for ${savedRental.title}: ${profileErr.message}`);
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
   * Extract item names from the order detail's items array.
   * Each item in the detail has a name field (the product title on Hygglo).
   */
  private extractItemNamesFromDetail(detail: any, fallbackTitle: string): string[] {
    if (!detail?.items || !Array.isArray(detail.items) || detail.items.length === 0) {
      return [fallbackTitle];
    }
    return detail.items
      .filter((item: any) => item.name && item.type === 'PRODUCT')
      .map((item: any) => item.name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  }

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

    // Build item list
    const allItems = sorted.map((entry, i) => `${i + 1}. ${entry.savedRental.title}`);

    // Send consolidation message in primary chat
    const primaryMessage =
      `Hi ${firstName}! I can see you've sent ${sorted.length} separate rental requests:\n` +
      allItems.join('\n') + '\n\n' +
      `We can handle all of these right here — easier to coordinate and we might be able to offer a bundle deal. ` +
      `Shall I put everything together in this chat?`;

    const readOnly = process.env.READ_ONLY_MODE === 'true';
    if (!readOnly) {
      try {
        await this.hyggloService.sendMessage(primary.savedRental.listing_id, primaryMessage);
      } catch (err) {
        this.logger.warn(`Failed to send consolidation message for ${primary.savedRental.title}: ${err.message}`);
      }
    }

    // Send redirect message in each secondary chat
    for (const secondary of secondaries) {
      const redirectMessage =
        `Hi! I've got this request. Since you also have a request for ${primary.savedRental.title}, ` +
        `I'll handle everything together in that chat to keep things simple. ` +
        `Head over there and we'll sort out all the items at once!`;

      if (!readOnly) {
        try {
          await this.hyggloService.sendMessage(secondary.savedRental.listing_id, redirectMessage);
        } catch (err) {
          this.logger.warn(`Failed to send redirect message for ${secondary.savedRental.title}: ${err.message}`);
        }
      }

      // Store ai_decision for audit trail on each secondary
      try {
        await this.prisma.ai_decision.create({
          data: {
            rental_id: secondary.savedRental.id,
            decision_type: 'analyze',
            input_summary: `Multi-item request: redirected to primary chat (${primary.savedRental.title})`,
            output_summary: `Renter sent ${sorted.length} separate requests. Consolidated into primary rental.`,
            confidence: 1.0,
            action_taken: readOnly
              ? `BLOCKED (read-only). Would redirect to ${primary.savedRental.title}`
              : `Sent redirect to primary chat: ${primary.savedRental.title}`,
            notified: true,
          },
        });
      } catch (dbErr) {
        this.logger.warn(`Failed to store multi-item decision: ${dbErr.message}`);
      }
    }

    // Notify owner via Telegram
    if (this.telegramService) {
      const totalValue = sorted.reduce((sum, e) => sum + (e.savedRental.rental_price || 0), 0);
      this.telegramService.sendProactiveMessage(
        `📦 *Multi-Item Request Detected*\n\n` +
        `├ 👤 ${renterName}\n` +
        `├ 📋 ${sorted.length} separate requests:\n` +
        sorted.map((e, i) => `│  ${i + 1}. ${e.savedRental.title} (£${e.savedRental.rental_price || 0})`).join('\n') + '\n' +
        `├ 💰 Total value: £${totalValue}\n` +
        `└ Consolidated into: ${primary.savedRental.title}`,
      ).catch(() => {});
    }

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
