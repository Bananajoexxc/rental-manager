import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { chromium, Browser, Page } from 'playwright';
import { LoggingService } from '../logging/logging.service';

export interface RentalListing {
  listingId: string;
  title: string;
  status: 'ongoing' | 'upcoming';
  startDate?: Date;
  endDate?: Date;
  renterInfo?: string;
  listingUrl: string;
  description?: string;
  photosUrls: string[];
}

@Injectable()
export class HyggloService implements OnModuleDestroy {
  private readonly logger = new Logger(HyggloService.name);
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isAuthenticated = false;

  constructor(private loggingService: LoggingService) {}

  async onModuleDestroy() {
    await this.cleanup();
  }

  private async cleanup() {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      this.isAuthenticated = false;
      this.logger.log('🧹 Playwright browser cleaned up');
    } catch (error) {
      this.logger.error('Error during cleanup', error);
    }
  }

  private async ensureBrowser() {
    if (!this.browser) {
      this.logger.log('🌐 Launching Playwright browser...');
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      this.logger.log('✅ Browser launched successfully');
    }
  }

  private async ensurePage() {
    await this.ensureBrowser();
    if (!this.page) {
      this.page = await this.browser!.newPage();
      this.logger.log('📄 New page created');
    }
  }

  async authenticate(): Promise<boolean> {
    try {
      const email = process.env.HYGGLO_EMAIL;
      const password = process.env.HYGGLO_PASSWORD;

      if (!email || !password) {
        throw new Error('HYGGLO_EMAIL and HYGGLO_PASSWORD must be set in environment variables');
      }

      await this.ensurePage();

      this.logger.log('🔐 Attempting to authenticate with Hygglo...');
      this.loggingService.info('Starting Hygglo authentication', { email });

      // Navigate to Hygglo login page
      await this.page!.goto('https://www.hygglo.se/login', { waitUntil: 'networkidle' });

      // Fill in login credentials
      await this.page!.fill('input[type="email"]', email);
      await this.page!.fill('input[type="password"]', password);

      // Click login button
      await this.page!.click('button[type="submit"]');

      // Wait for navigation after login
      await this.page!.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 });

      // Check if login was successful by checking for authenticated content
      const isLoggedIn = await this.page!.evaluate(() => {
        // Check if we're redirected to dashboard or if there's a logout button
        return !window.location.href.includes('/login');
      });

      if (isLoggedIn) {
        this.isAuthenticated = true;
        this.logger.log('✅ Successfully authenticated with Hygglo');
        this.loggingService.info('Hygglo authentication successful');
        return true;
      } else {
        throw new Error('Login failed - still on login page');
      }
    } catch (error) {
      this.logger.error('❌ Authentication failed', error);
      this.loggingService.error('Hygglo authentication failed', { error: error.message });
      this.isAuthenticated = false;
      return false;
    }
  }

  private async ensureAuthenticated(): Promise<boolean> {
    if (!this.isAuthenticated) {
      return await this.authenticate();
    }
    return true;
  }

  async scanRentals(status: 'ongoing' | 'upcoming'): Promise<RentalListing[]> {
    try {
      const authenticated = await this.ensureAuthenticated();
      if (!authenticated) {
        this.logger.warn('⚠️ Cannot scan rentals - not authenticated');
        return [];
      }

      this.logger.log(`🔍 Scanning ${status} rentals...`);
      this.loggingService.info(`Scanning ${status} rentals`);

      const url = status === 'ongoing' 
        ? 'https://www.hygglo.se/dashboard/rentals/ongoing'
        : 'https://www.hygglo.se/dashboard/rentals/upcoming';

      await this.page!.goto(url, { waitUntil: 'networkidle' });

      // Wait for rental listings to load
      await this.page!.waitForSelector('[data-testid="rental-card"], .rental-item, .booking-card', { timeout: 5000 }).catch(() => {
        this.logger.warn('No rental cards found on page');
      });

      // Extract rental data from the page
      const rentals = await this.page!.evaluate((statusParam) => {
        const rentalCards = document.querySelectorAll('[data-testid="rental-card"], .rental-item, .booking-card');
        const results: any[] = [];

        rentalCards.forEach((card) => {
          try {
            // Extract listing ID from URL or data attribute
            const linkElement = card.querySelector('a[href*="/listing/"], a[href*="/rental/"]') as HTMLAnchorElement;
            const listingUrl = linkElement?.href || '';
            const listingIdMatch = listingUrl.match(/\/(listing|rental)\/([^\/\?]+)/);
            const listingId = listingIdMatch ? listingIdMatch[2] : `temp_${Date.now()}_${Math.random()}`;

            // Extract title
            const titleElement = card.querySelector('h3, h2, .title, [data-testid="rental-title"]');
            const title = titleElement?.textContent?.trim() || 'Unknown Listing';

            // Extract dates
            const dateElement = card.querySelector('.dates, [data-testid="rental-dates"], time');
            const dateText = dateElement?.textContent?.trim() || '';

            // Extract renter info
            const renterElement = card.querySelector('.renter-name, [data-testid="renter-info"]');
            const renterInfo = renterElement?.textContent?.trim() || '';

            // Extract photos
            const imgElements = card.querySelectorAll('img');
            const photosUrls: string[] = [];
            imgElements.forEach((img) => {
              const src = img.getAttribute('src');
              if (src && !src.includes('avatar') && !src.includes('logo')) {
                photosUrls.push(src);
              }
            });

            results.push({
              listingId,
              title,
              status: statusParam,
              listingUrl,
              renterInfo,
              photosUrls,
              dateText,
            });
          } catch (err) {
            console.error('Error extracting rental card data:', err);
          }
        });

        return results;
      }, status);

      this.logger.log(`✅ Found ${rentals.length} ${status} rentals`);
      this.loggingService.info(`Found ${rentals.length} ${status} rentals`);

      // Transform to RentalListing format
      const rentalListings: RentalListing[] = rentals.map((rental) => ({
        listingId: rental.listingId,
        title: rental.title,
        status,
        listingUrl: rental.listingUrl,
        renterInfo: rental.renterInfo,
        photosUrls: rental.photosUrls,
        description: '', // Will be fetched separately if needed
      }));

      return rentalListings;
    } catch (error) {
      this.logger.error(`❌ Error scanning ${status} rentals`, error);
      this.loggingService.error(`Error scanning ${status} rentals`, { error: error.message });

      // If authentication error, reset and retry once
      if (error.message.includes('navigation') || error.message.includes('timeout')) {
        this.logger.warn('⚠️ Possible authentication issue, resetting session...');
        this.isAuthenticated = false;
        await this.cleanup();
      }

      return [];
    }
  }

  async fetchListingDetails(listingUrl: string): Promise<{ description: string; photosUrls: string[] }> {
    try {
      const authenticated = await this.ensureAuthenticated();
      if (!authenticated) {
        return { description: '', photosUrls: [] };
      }

      this.logger.log(`📖 Fetching listing details from ${listingUrl}`);

      await this.page!.goto(listingUrl, { waitUntil: 'networkidle' });

      // Extract description and all photos
      const details = await this.page!.evaluate(() => {
        const descriptionElement = document.querySelector('.description, [data-testid="listing-description"], .listing-content');
        const description = descriptionElement?.textContent?.trim() || '';

        const imgElements = document.querySelectorAll('img');
        const photosUrls: string[] = [];
        imgElements.forEach((img) => {
          const src = img.getAttribute('src');
          if (src && !src.includes('avatar') && !src.includes('logo') && !src.includes('icon')) {
            photosUrls.push(src);
          }
        });

        return { description, photosUrls };
      });

      this.logger.log('✅ Listing details fetched');
      return details;
    } catch (error) {
      this.logger.error('❌ Error fetching listing details', error);
      return { description: '', photosUrls: [] };
    }
  }

  getAuthenticationStatus(): boolean {
    return this.isAuthenticated;
  }
}
