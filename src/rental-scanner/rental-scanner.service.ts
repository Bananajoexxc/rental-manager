import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { ImageAnalysisService } from '../image-analysis/image-analysis.service';
import { LoggingService } from '../logging/logging.service';

@Injectable()
export class RentalScannerService implements OnModuleInit {
  private readonly logger = new Logger(RentalScannerService.name);
  private isScanning = false;
  private lastActivityTime: number = Date.now();
  private currentScanInterval: number;
  private scannerTimeout: NodeJS.Timeout | null = null;

  private readonly INITIAL_SCAN_INTERVAL: number;
  private readonly REDUCED_SCAN_INTERVAL: number;
  private readonly INACTIVITY_THRESHOLD: number;

  constructor(
    private prisma: PrismaService,
    private hyggloService: HyggloService,
    private imageAnalysisService: ImageAnalysisService,
    private loggingService: LoggingService,
  ) {
    // Load configuration from environment variables
    this.INITIAL_SCAN_INTERVAL = parseInt(process.env.INITIAL_SCAN_INTERVAL_MS || '60000', 10);
    this.REDUCED_SCAN_INTERVAL = parseInt(process.env.REDUCED_SCAN_INTERVAL_MS || '300000', 10);
    this.INACTIVITY_THRESHOLD = parseInt(process.env.INACTIVITY_THRESHOLD_MS || '1800000', 10);
    this.currentScanInterval = this.INITIAL_SCAN_INTERVAL;
  }

  async onModuleInit() {
    // Wait a bit before starting the scanner to allow other services to initialize
    setTimeout(() => {
      this.startScanner();
    }, 5000);
  }

  private startScanner() {
    this.logger.log('🚀 Starting rental scanner service...');
    this.loggingService.info('Rental scanner service started', {
      initialInterval: this.INITIAL_SCAN_INTERVAL,
      reducedInterval: this.REDUCED_SCAN_INTERVAL,
      inactivityThreshold: this.INACTIVITY_THRESHOLD,
    });

    this.scheduleNextScan();
  }

  private scheduleNextScan() {
    if (this.scannerTimeout) {
      clearTimeout(this.scannerTimeout);
    }

    this.scannerTimeout = setTimeout(() => {
      this.performScan();
    }, this.currentScanInterval);

    this.logger.log(`⏰ Next scan scheduled in ${this.currentScanInterval / 1000} seconds`);
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

      // Scan both ongoing and upcoming rentals
      const ongoingRentals = await this.hyggloService.scanRentals('ongoing');
      const upcomingRentals = await this.hyggloService.scanRentals('upcoming');

      const allRentals = [...ongoingRentals, ...upcomingRentals];
      let newRentalsCount = 0;

      this.logger.log(`📊 Total rentals found: ${allRentals.length}`);

      // Process each rental
      for (const rental of allRentals) {
        const isNew = await this.processRental(rental);
        if (isNew) {
          newRentalsCount++;
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

      const scanDuration = Date.now() - scanStartTime;
      this.logger.log(`✅ Scan completed in ${scanDuration}ms`);
      this.loggingService.info('Scan completed', { duration: scanDuration, newRentals: newRentalsCount });
    } catch (error) {
      this.logger.error('❌ Error during scan', error);
      this.loggingService.error('Scan failed', { error: error.message, stack: error.stack });
    } finally {
      this.isScanning = false;
      this.scheduleNextScan();
    }
  }

  private async processRental(rental: any): Promise<boolean> {
    try {
      // Check if rental already exists
      const existingRental = await this.prisma.rental.findUnique({
        where: { listing_id: rental.listingId },
      });

      if (existingRental) {
        // Update existing rental
        await this.prisma.rental.update({
          where: { listing_id: rental.listingId },
          data: {
            title: rental.title,
            status: rental.status,
            renter_info: rental.renterInfo,
            photos_urls: rental.photosUrls,
            updated_at: new Date(),
          },
        });

        this.logger.log(`🔄 Updated rental: ${rental.title}`);
        return false; // Not a new rental
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

      // Save new rental to database
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
        },
      });

      this.loggingService.info('New rental saved', {
        rentalId: savedRental.id,
        listingId: savedRental.listing_id,
        title: savedRental.title,
      });

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
      if (description) {
        this.logger.log('📝 Parsing description for items...');
        const catalogItems = this.imageAnalysisService.parseDescriptionForItems(description);

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

      return true; // This is a new rental
    } catch (error) {
      this.logger.error(`❌ Error processing rental: ${rental.title}`, error);
      this.loggingService.error('Error processing rental', {
        listingId: rental.listingId,
        error: error.message,
      });
      return false;
    }
  }

  getStatus() {
    return {
      isScanning: this.isScanning,
      currentScanInterval: this.currentScanInterval,
      lastActivityTime: new Date(this.lastActivityTime).toISOString(),
      authenticated: this.hyggloService.getAuthenticationStatus(),
    };
  }
}
