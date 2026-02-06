import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { LoggingService } from '../logging/logging.service';

// --- Types ---

export type HyggloAccount = 'dbcinema' | 'leo';

export interface HyggloAccountConfig {
  name: HyggloAccount;
  email: string;
  password: string;
  label: string; // Human-readable: "DB Cinema" or "Leo Adams"
}

export interface RentalListing {
  listingId: string;
  title: string;
  status: 'ongoing' | 'upcoming' | 'pending';
  startDate?: Date;
  endDate?: Date;
  renterInfo?: string;
  renterUserId?: string;
  listingUrl: string;
  description?: string;
  photosUrls: string[];
  account?: HyggloAccount;
  rentalPrice?: number;
  pricePerDay?: number;
  currency?: string;
  _detail?: any; // Full order detail from /v4/my/orders/:id
}

export interface RentalDetails {
  description: string;
  photosUrls: string[];
  pricing?: string;
  pricingNumeric?: number;
  dates?: string;
  itemList?: string[];
}

export interface OwnListing {
  title: string;
  url: string;
  status: string;
  account: HyggloAccount;
}

export interface RentalRequest {
  id: string;
  renterName: string;
  itemTitle: string;
  dates: string;
  status: string;
  account: HyggloAccount;
}

// --- Token State ---

interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in ms
}

// --- Service ---

const API_BASE = 'https://api.hygglo.com/api';
const CLIENT_ID = 'ngHyggloApp';
const CLIENT_SECRET = 'lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=';
const COUNTRY = 'GB';

@Injectable()
export class HyggloService implements OnModuleInit {
  private readonly logger = new Logger(HyggloService.name);
  private accounts: HyggloAccountConfig[] = [];
  private tokens = new Map<HyggloAccount, TokenState>();
  private client: AxiosInstance;
  private hasLoggedOrderSample = false;
  private lastMessageCheckTime = new Map<string, number>();
  private recentlySentMessages = new Map<string, number>(); // content hash → timestamp, to avoid re-processing our own sent messages
  private readonly SENT_MESSAGE_TTL_MS = 10 * 60 * 1000; // 10 minute window
  private authInFlight = new Map<HyggloAccount, Promise<boolean>>();

  constructor(private loggingService: LoggingService) {
    this.client = axios.create({
      baseURL: API_BASE,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'en',
        'User-Client': 'Hygglo-web',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Origin': 'https://www.hygglo.com',
        'Referer': 'https://www.hygglo.com/',
        'Country': COUNTRY,
      },
    });

    // 429 rate-limit interceptor with exponential backoff
    this.client.interceptors.response.use(undefined, async (error: AxiosError) => {
      const config = error.config;
      if (!config || !error.response) return Promise.reject(error);

      if (error.response.status === 429) {
        const retryCount = (config as any).__retryCount || 0;
        if (retryCount >= 3) return Promise.reject(error);

        (config as any).__retryCount = retryCount + 1;
        const delayMs = Math.min(1000 * Math.pow(2, retryCount), 8000);
        this.logger.warn(`Rate limited (429). Retrying in ${delayMs}ms (attempt ${retryCount + 1}/3)`);
        await this.delay(delayMs);
        return this.client.request(config);
      }

      // 401 unauthorized -- re-authenticate and retry once
      if (error.response.status === 401) {
        const account = (config as any).__account as HyggloAccount | undefined;
        const alreadyRetried = (config as any).__authRetried;
        if (account && !alreadyRetried) {
          this.logger.warn(`Got 401 for ${account}, re-authenticating...`);
          this.tokens.delete(account);
          const accountConfig = this.accounts.find(a => a.name === account);
          if (accountConfig) {
            const success = await this.authenticate(accountConfig);
            if (success) {
              const token = this.tokens.get(account);
              if (token && config.headers) {
                config.headers['Authorization'] = `Bearer ${token.accessToken}`;
              }
              (config as any).__authRetried = true;
              return this.client.request(config);
            }
          }
        }
      }

      return Promise.reject(error);
    });
  }

  async onModuleInit() {
    this.loadAccounts();
    const readOnly = process.env.READ_ONLY_MODE === 'true';
    this.logger.log(`READ_ONLY_MODE is ${readOnly ? 'ACTIVE' : 'INACTIVE'}`);
    this.logger.log(`Loaded ${this.accounts.length} Hygglo account(s): ${this.accounts.map(a => a.label).join(', ') || 'none'}`);
  }

  // --- Account Management ---

  private loadAccounts() {
    this.accounts = [];

    const dbEmail = process.env.HYGGLO_DBCINEMA_EMAIL;
    const dbPassword = process.env.HYGGLO_DBCINEMA_PASSWORD;
    if (dbEmail && dbPassword && dbEmail !== 'your_dbcinema_email@example.com') {
      this.accounts.push({
        name: 'dbcinema',
        email: dbEmail,
        password: dbPassword,
        label: 'DB Cinema',
      });
    }

    const leoEmail = process.env.HYGGLO_LEO_EMAIL;
    const leoPassword = process.env.HYGGLO_LEO_PASSWORD;
    if (leoEmail && leoPassword && leoEmail !== 'your_leo_email@example.com') {
      this.accounts.push({
        name: 'leo',
        email: leoEmail,
        password: leoPassword,
        label: 'Leo Adams',
      });
    }

    // Legacy fallback
    if (this.accounts.length === 0) {
      const legacyEmail = process.env.HYGGLO_EMAIL;
      const legacyPassword = process.env.HYGGLO_PASSWORD;
      if (legacyEmail && legacyPassword && legacyEmail !== 'your_email@example.com') {
        this.accounts.push({
          name: 'dbcinema',
          email: legacyEmail,
          password: legacyPassword,
          label: 'DB Cinema (legacy)',
        });
        this.logger.warn('Using legacy single-account credentials. Set HYGGLO_DBCINEMA_* and HYGGLO_LEO_* for multi-account.');
      }
    }
  }

  getAccounts(): HyggloAccountConfig[] {
    return [...this.accounts];
  }

  getCurrentAccount(): HyggloAccount | null {
    // Return first account with a valid token
    for (const account of this.accounts) {
      const token = this.tokens.get(account.name);
      if (token && token.expiresAt > Date.now()) {
        return account.name;
      }
    }
    return null;
  }

  // --- Authentication ---

  async authenticate(config?: HyggloAccountConfig): Promise<boolean> {
    try {
      let accountConfig: HyggloAccountConfig;

      if (config) {
        accountConfig = config;
      } else if (this.accounts.length > 0) {
        accountConfig = this.accounts[0];
      } else {
        throw new Error('No Hygglo account credentials configured. Set HYGGLO_DBCINEMA_EMAIL/PASSWORD or HYGGLO_EMAIL/PASSWORD.');
      }

      // If already have a valid token, skip
      const existingToken = this.tokens.get(accountConfig.name);
      if (existingToken && existingToken.expiresAt > Date.now() + 60000) {
        return true;
      }

      this.logger.log(`Authenticating as ${accountConfig.label} (${accountConfig.name})...`);
      this.loggingService.info('Starting Hygglo API authentication', { account: accountConfig.name, email: accountConfig.email });

      const params = new URLSearchParams();
      params.append('grant_type', 'password');
      params.append('username', accountConfig.email);
      params.append('password', accountConfig.password);
      params.append('client_id', CLIENT_ID);
      params.append('client_secret', CLIENT_SECRET);

      const response = await this.client.post(`/token?country=${COUNTRY}`, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const { access_token, refresh_token, expires_in } = response.data;

      if (!access_token) {
        throw new Error('No access_token in response');
      }

      this.tokens.set(accountConfig.name, {
        accessToken: access_token,
        refreshToken: refresh_token || '',
        expiresAt: Date.now() + (expires_in || 3600) * 1000,
      });

      this.logger.log(`Authenticated as ${accountConfig.label}`);
      this.loggingService.info('Hygglo API authentication successful', { account: accountConfig.name });
      return true;
    } catch (error) {
      const msg = error instanceof AxiosError
        ? `${error.response?.status} ${JSON.stringify(error.response?.data || error.message)}`
        : error.message;
      this.logger.error(`Authentication failed: ${msg}`);
      this.loggingService.error('Hygglo API authentication failed', { error: msg });
      return false;
    }
  }

  async logout(): Promise<void> {
    // No HTTP call needed -- just clear token
    const hadTokens = this.tokens.size > 0;
    this.tokens.clear();
    if (hadTokens) {
      this.loggingService.info('Logged out of all accounts (tokens cleared)');
    }
  }

  private async ensureAuthenticated(accountName: HyggloAccount): Promise<boolean> {
    const token = this.tokens.get(accountName);
    if (token && token.expiresAt > Date.now() + 60000) {
      return true;
    }

    // If an auth request is already in-flight for this account, await it
    const existing = this.authInFlight.get(accountName);
    if (existing) {
      return existing;
    }

    const config = this.accounts.find(a => a.name === accountName);
    if (!config) {
      this.logger.error(`Account not found: ${accountName}`);
      return false;
    }

    const authPromise = this.authenticate(config).finally(() => {
      this.authInFlight.delete(accountName);
    });
    this.authInFlight.set(accountName, authPromise);
    return authPromise;
  }

  // --- Scanning Methods ---

  /**
   * Scans all configured accounts in parallel via Promise.all().
   */
  async scanAllAccounts(status: 'ongoing' | 'upcoming' | 'both' = 'both'): Promise<RentalListing[]> {
    if (this.accounts.length === 0) {
      this.logger.warn('No accounts configured for scanning');
      return [];
    }

    const accountScanners = this.accounts.map(async (account) => {
      try {
        this.logger.log(`--- Scanning account: ${account.label} ---`);
        const authenticated = await this.authenticate(account);

        if (!authenticated) {
          this.logger.error(`Failed to authenticate ${account.label}, skipping`);
          return [];
        }

        const rentals: RentalListing[] = [];

        if (status === 'both' || status === 'ongoing') {
          const ongoing = await this.scanRentalsForAccount(account.name, 'ongoing');
          rentals.push(...ongoing);
        }

        if (status === 'both' || status === 'upcoming') {
          const upcoming = await this.scanRentalsForAccount(account.name, 'upcoming');
          rentals.push(...upcoming);
        }

        if (status === 'both') {
          const pending = await this.scanRentalsForAccount(account.name, 'pending');
          rentals.push(...pending);
        }

        return rentals;
      } catch (error) {
        this.logger.error(`Error scanning account ${account.label}: ${error.message}`);
        return [];
      }
    });

    const results = await Promise.all(accountScanners);
    const allRentals = results.flat();

    this.pruneLastMessageCheckTimes();

    this.logger.log(`Total rentals across all accounts: ${allRentals.length}`);
    return allRentals;
  }

  /**
   * Remove entries from lastMessageCheckTime older than 24 hours to prevent unbounded growth.
   */
  private pruneLastMessageCheckTimes() {
    const maxAge = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [key, timestamp] of this.lastMessageCheckTime) {
      if (now - timestamp > maxAge) {
        this.lastMessageCheckTime.delete(key);
      }
    }
    // Also prune sent message tracker
    for (const [key, timestamp] of this.recentlySentMessages) {
      if (now - timestamp > this.SENT_MESSAGE_TTL_MS) {
        this.recentlySentMessages.delete(key);
      }
    }
  }

  /**
   * Scans rentals for the first authenticated account (backwards-compatible).
   */
  async scanRentals(status: 'ongoing' | 'upcoming'): Promise<RentalListing[]> {
    const account = this.getCurrentAccount();
    if (!account) {
      // Try to authenticate first account
      if (this.accounts.length > 0) {
        const success = await this.authenticate(this.accounts[0]);
        if (!success) {
          this.logger.warn('Cannot scan rentals - not authenticated');
          return [];
        }
        return this.scanRentalsForAccount(this.accounts[0].name, status);
      }
      return [];
    }
    return this.scanRentalsForAccount(account, status);
  }

  private async scanRentalsForAccount(accountName: HyggloAccount, status: 'ongoing' | 'upcoming' | 'pending'): Promise<RentalListing[]> {
    try {
      const authenticated = await this.ensureAuthenticated(accountName);
      if (!authenticated) {
        this.logger.warn(`Cannot scan ${status} rentals for ${accountName} - not authenticated`);
        return [];
      }

      const token = this.tokens.get(accountName)!;
      this.logger.log(`Scanning ${status} rentals for ${accountName}...`);
      this.loggingService.info(`Scanning ${status} rentals via API`, { account: accountName });

      // Map our status to API filter parameter
      // API accepts: 'pending' | 'future' | 'current' | 'completed' | 'obsolete' for role=owner
      const filter = status === 'ongoing' ? 'current' : status === 'pending' ? 'pending' : 'future';

      const response = await this.client.get('/v4/my/orders', {
        params: {
          role: 'owner',
          filter,
          sort: 'order-start-date',
          offset: 0,
          limit: 50,
        },
        headers: {
          'Authorization': `Bearer ${token.accessToken}`,
        },
        __account: accountName,
      } as any);

      const data = response.data;

      // Handle both array and paginated response shapes
      const orders: any[] = Array.isArray(data) ? data : (data.items || data.results || data.data || []);

      this.logger.log(`Found ${orders.length} ${status} orders for ${accountName}`);
      this.loggingService.info(`Found ${orders.length} ${status} orders`, { account: accountName });

      // Fetch order detail for each order to get dates, prices, items
      const enrichedOrders = await this.enrichOrdersWithDetails(orders, accountName);

      return this.mapOrdersToRentalListings(enrichedOrders, status, accountName);
    } catch (error) {
      const msg = error instanceof AxiosError
        ? `${error.response?.status} ${JSON.stringify(error.response?.data || error.message)}`
        : error.message;
      this.logger.error(`Error scanning ${status} rentals for ${accountName}: ${msg}`);
      this.loggingService.error(`Error scanning ${status} rentals`, { error: msg, account: accountName });
      return [];
    }
  }

  /**
   * Fetches order detail for each order to enrich with dates, prices, items, and chat.
   * The list endpoint (/v4/my/orders) only returns id, labels, profileImage.
   * The detail endpoint (/v4/my/orders/:id?timezone=) returns full data.
   */
  private async enrichOrdersWithDetails(orders: any[], accountName: HyggloAccount): Promise<any[]> {
    const token = this.tokens.get(accountName);
    if (!token) return orders;

    const enriched: any[] = [];

    for (const order of orders) {
      const orderId = order.id;
      if (!orderId) {
        enriched.push(order);
        continue;
      }

      try {
        const detailRes = await this.client.get(`/v4/my/orders/${orderId}`, {
          params: { timezone: 'Europe/London' },
          headers: { 'Authorization': `Bearer ${token.accessToken}` },
          __account: accountName,
        } as any);

        const detail = detailRes.data;
        // Merge detail into order (detail has all the same fields plus more)
        enriched.push({ ...order, _detail: detail });
      } catch (error) {
        this.logger.debug(`Failed to fetch detail for order ${orderId}: ${error instanceof AxiosError ? error.response?.status : error.message}`);
        enriched.push(order);
      }
    }

    return enriched;
  }

  private mapOrdersToRentalListings(orders: any[], status: 'ongoing' | 'upcoming' | 'pending', account: HyggloAccount): RentalListing[] {
    return orders.map((order) => {
      const labels = order.labels || {};
      const detail = order._detail || {};

      // Title from labels.name (HTML-decoded)
      const rawTitle = labels.name || detail.labels?.name || order.title || 'Unknown';
      const title = rawTitle.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

      // Renter: prefer full name from detail.users.otherPart.name
      const renter = detail.users?.otherPart?.name
        || labels.otherPart
        || '';

      // Renter user ID for profile linking
      const renterUserId = detail.users?.otherPart?.id
        ? String(detail.users.otherPart.id)
        : undefined;

      // Photos from detail items
      const photosUrls: string[] = [];
      if (detail.items && Array.isArray(detail.items)) {
        for (const item of detail.items) {
          if (item.image?.fullSizeUrl) photosUrls.push(item.image.fullSizeUrl);
        }
      }
      if (order.otherPartsProfileImage) {
        photosUrls.unshift(order.otherPartsProfileImage);
      }

      // Listing URL from first item slug
      let listingUrl = '';
      if (detail.items && detail.items.length > 0 && detail.items[0].slug) {
        listingUrl = `https://www.hygglo.com/${detail.items[0].slug}`;
      }

      const listingId = String(order.id || `order_${Date.now()}_${Math.random().toString(36).slice(2)}`);

      // Description from listing details (if any)
      const description = '';

      // --- Dates from detail.rentalPeriod (UTC ISO strings) ---
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (detail.rentalPeriod?.startDateUTC) {
        startDate = new Date(detail.rentalPeriod.startDateUTC);
      }
      if (detail.rentalPeriod?.endDateUTC) {
        endDate = new Date(detail.rentalPeriod.endDateUTC);
      }

      // Hygglo models 1-day rentals as start == end. Normalize to start + 1 day.
      if (startDate && endDate && startDate.getTime() === endDate.getTime()) {
        endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      }

      // Fallback: parse dates from labels.duration.compact (e.g., "31 Dec-1 Jan", "30-31 Jan", "29 Jan")
      if (!startDate || !endDate) {
        const parsed = this.parseDurationLabel(labels.duration?.compact || labels.duration?.full || '');
        if (parsed.startDate && !startDate) startDate = parsed.startDate;
        if (parsed.endDate && !endDate) endDate = parsed.endDate;
      }

      // --- Price from detail.price ---
      let rentalPrice: number | undefined;
      let pricePerDay: number | undefined;
      let currency: string | undefined;

      if (detail.price) {
        // price.total = what renter pays, price.ownerEarnings = what owner gets
        rentalPrice = detail.price.total ?? undefined;
        currency = detail.price.currency ?? undefined;
      }

      // Calculate price per day
      if (rentalPrice && startDate && endDate) {
        const days = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
        pricePerDay = Math.round((rentalPrice / days) * 100) / 100;
      }

      return {
        listingId,
        title,
        status,
        startDate,
        endDate,
        renterInfo: renter,
        renterUserId,
        listingUrl,
        description,
        photosUrls,
        account,
        rentalPrice,
        pricePerDay,
        currency,
        // Pass detail through for downstream use (items, activities, ownerEarnings)
        _detail: detail,
      };
    });
  }

  /**
   * Parse Hygglo's createdAtLabel format (e.g. "4 Feb, 18:35", "4 Feb", "Yesterday, 14:00")
   * into a proper Date object.
   */
  private parseCreatedAtLabel(label: string): Date | null {
    if (!label) return null;

    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };

    // Format: "4 Feb, 18:35" or "4 Feb"
    const match = label.match(/^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:,?\s+(\d{1,2}):(\d{2}))?/);
    if (match) {
      const day = parseInt(match[1], 10);
      const month = months[match[2]];
      const now = new Date();
      const year = now.getFullYear();
      const hours = match[3] ? parseInt(match[3], 10) : 0;
      const minutes = match[4] ? parseInt(match[4], 10) : 0;

      const date = new Date(year, month, day, hours, minutes);
      // If the date is in the future by more than a day, it was probably last year
      if (date.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
        date.setFullYear(year - 1);
      }
      return date;
    }

    // Format: "Yesterday, 14:00"
    if (label.toLowerCase().startsWith('yesterday')) {
      const timeMatch = label.match(/(\d{1,2}):(\d{2})/);
      const now = new Date();
      now.setDate(now.getDate() - 1);
      if (timeMatch) {
        now.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);
      }
      return now;
    }

    // Format: "Today, 14:00"
    if (label.toLowerCase().startsWith('today')) {
      const timeMatch = label.match(/(\d{1,2}):(\d{2})/);
      const now = new Date();
      if (timeMatch) {
        now.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);
      }
      return now;
    }

    return null;
  }

  /**
   * Parse dates from Hygglo duration labels like "31 Dec-1 Jan", "30-31 Jan", "29 Jan".
   */
  private parseDurationLabel(label: string): { startDate?: Date; endDate?: Date } {
    if (!label) return {};

    // Remove "Rental period: " prefix if present
    const cleaned = label.replace(/^Rental period:\s*/i, '').trim();
    if (!cleaned) return {};

    const monthNames: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };

    const now = new Date();
    const currentYear = now.getFullYear();

    // Pattern: "31 Dec-1 Jan" (different months)
    const crossMonthMatch = cleaned.match(/^(\d{1,2})\s+(\w{3})\s*-\s*(\d{1,2})\s+(\w{3})$/i);
    if (crossMonthMatch) {
      const startDay = parseInt(crossMonthMatch[1]);
      const startMonth = monthNames[crossMonthMatch[2].toLowerCase()];
      const endDay = parseInt(crossMonthMatch[3]);
      const endMonth = monthNames[crossMonthMatch[4].toLowerCase()];
      if (startMonth !== undefined && endMonth !== undefined) {
        let startYear = currentYear;
        let endYear = currentYear;
        // If end month is before start month, it spans a year boundary
        if (endMonth < startMonth) endYear = startYear + 1;
        // If start is in the past by more than 6 months, shift forward
        const startDate = new Date(startYear, startMonth, startDay);
        const endDate = new Date(endYear, endMonth, endDay);
        return { startDate, endDate };
      }
    }

    // Pattern: "30-31 Jan" (same month range)
    const sameMonthMatch = cleaned.match(/^(\d{1,2})\s*-\s*(\d{1,2})\s+(\w{3})$/i);
    if (sameMonthMatch) {
      const startDay = parseInt(sameMonthMatch[1]);
      const endDay = parseInt(sameMonthMatch[2]);
      const month = monthNames[sameMonthMatch[3].toLowerCase()];
      if (month !== undefined) {
        const startDate = new Date(currentYear, month, startDay);
        const endDate = new Date(currentYear, month, endDay);
        return { startDate, endDate };
      }
    }

    // Pattern: "29 Jan" (single day)
    const singleDayMatch = cleaned.match(/^(\d{1,2})\s+(\w{3})$/i);
    if (singleDayMatch) {
      const day = parseInt(singleDayMatch[1]);
      const month = monthNames[singleDayMatch[2].toLowerCase()];
      if (month !== undefined) {
        const startDate = new Date(currentYear, month, day);
        const endDate = new Date(currentYear, month, day + 1);
        return { startDate, endDate };
      }
    }

    return {};
  }

  // --- Detailed Fetching ---

  async fetchListingDetails(listingUrl: string): Promise<RentalDetails> {
    try {
      // Extract slug from URL
      // URLs look like: https://www.hygglo.com/some-listing-slug or https://www.hygglo.se/listing/some-slug
      const slug = this.extractSlugFromUrl(listingUrl);
      if (!slug) {
        this.logger.warn(`Could not extract slug from URL: ${listingUrl}`);
        return { description: '', photosUrls: [] };
      }

      this.logger.log(`Fetching listing details for slug: ${slug}`);

      // Public endpoint -- no auth needed
      const response = await this.client.get(`/v2/product-listings/${slug}`);
      const data = response.data;

      this.logger.debug(`[API] /v2/product-listings/${slug} sample: ${JSON.stringify(data).substring(0, 1000)}`);

      const description = data.description || data.text || '';
      const images: any[] = data.images || data.photos || [];
      const photosUrls = images.map((img: any) => typeof img === 'string' ? img : (img?.url || img?.src || ''))
        .filter(Boolean);

      const pricing = data.price?.formatted || data.price?.toString() || data.pricing || '';
      const dates = data.availability || '';

      // Parse numeric price value
      let pricingNumeric: number | undefined;
      if (data.price?.amount != null) {
        pricingNumeric = data.price.amount;
      } else if (data.price?.value != null) {
        pricingNumeric = data.price.value;
      } else if (typeof data.price === 'number') {
        pricingNumeric = data.price;
      } else if (pricing) {
        const parsed = parseFloat(pricing.replace(/[^0-9.]/g, ''));
        if (!isNaN(parsed)) pricingNumeric = parsed;
      }

      const itemList: string[] = data.items || data.includedItems || [];

      this.logger.log(`Listing details fetched: ${description.substring(0, 80)}...`);

      return { description, photosUrls, pricing, pricingNumeric, dates, itemList };
    } catch (error) {
      const msg = error instanceof AxiosError
        ? `${error.response?.status} ${error.response?.statusText}`
        : error.message;
      this.logger.error(`Error fetching listing details: ${msg}`);
      return { description: '', photosUrls: [] };
    }
  }

  async fetchRentalDetails(rentalUrl: string): Promise<RentalDetails> {
    return this.fetchListingDetails(rentalUrl);
  }

  private extractSlugFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      // Remove leading slash, handle paths like /listing/slug or just /slug
      const pathname = parsed.pathname.replace(/^\//, '').replace(/\/$/, '');
      // If the path has segments like "listing/my-item", take the last segment
      const segments = pathname.split('/');
      return segments[segments.length - 1] || null;
    } catch {
      // If not a valid URL, treat the whole thing as a slug
      return url || null;
    }
  }

  // --- Own Listings & Requests ---

  async scanMyListings(): Promise<OwnListing[]> {
    const allListings: OwnListing[] = [];

    for (const account of this.accounts) {
      try {
        const authenticated = await this.ensureAuthenticated(account.name);
        if (!authenticated) continue;

        const token = this.tokens.get(account.name)!;
        this.logger.log(`Scanning own listings for ${account.name}...`);

        const response = await this.client.get('/v2/my/product-listings', {
          params: { limit: 50 },
          headers: { 'Authorization': `Bearer ${token.accessToken}` },
          __account: account.name,
        } as any);

        const data = response.data;
        const listings: any[] = Array.isArray(data) ? data : (data.items || data.results || data.data || []);

        this.logger.log(`Found ${listings.length} own listings for ${account.name}`);

        for (const listing of listings) {
          const slug = listing.slug || listing.id || '';
          allListings.push({
            title: listing.title || listing.name || 'Unknown',
            url: slug ? `https://www.hygglo.com/${slug}` : '',
            status: listing.status || 'active',
            account: account.name,
          });
        }
      } catch (error) {
        const msg = error instanceof AxiosError
          ? `${error.response?.status}`
          : error.message;
        this.logger.error(`Error scanning own listings for ${account.name}: ${msg}`);
      }
    }

    return allListings;
  }

  async scanRequests(): Promise<RentalRequest[]> {
    const allRequests: RentalRequest[] = [];

    for (const account of this.accounts) {
      try {
        const authenticated = await this.ensureAuthenticated(account.name);
        if (!authenticated) continue;

        const token = this.tokens.get(account.name)!;
        this.logger.log(`Scanning requests for ${account.name}...`);

        const response = await this.client.get('/v4/my/orders', {
          params: { role: 'owner', filter: 'requested', limit: 50 },
          headers: { 'Authorization': `Bearer ${token.accessToken}` },
          __account: account.name,
        } as any);

        const data = response.data;
        const orders: any[] = Array.isArray(data) ? data : (data.items || data.results || data.data || []);

        this.logger.log(`Found ${orders.length} requests for ${account.name}`);

        for (const order of orders) {
          const renterName = [order.renter?.firstName, order.renter?.lastName].filter(Boolean).join(' ')
            || order.renter?.name || 'Unknown';

          allRequests.push({
            id: String(order.id || order.orderId || `req_${Date.now()}`),
            renterName,
            itemTitle: order.listing?.title || order.productListing?.title || 'Unknown',
            dates: order.startDate && order.endDate
              ? `${order.startDate} - ${order.endDate}`
              : (order.dates || ''),
            status: order.status || 'pending',
            account: account.name,
          });
        }
      } catch (error) {
        const msg = error instanceof AxiosError
          ? `${error.response?.status}`
          : error.message;
        this.logger.error(`Error scanning requests for ${account.name}: ${msg}`);
      }
    }

    return allRequests;
  }

  // --- Status ---

  getAuthenticationStatus(): boolean {
    for (const account of this.accounts) {
      const token = this.tokens.get(account.name);
      if (token && token.expiresAt > Date.now()) {
        return true;
      }
    }
    return false;
  }

  // --- Messaging ---

  async readMessages(orderId: string): Promise<{ sender: string; content: string; timestamp: string }[]> {
    // Fetch order detail which contains activities (chat messages)
    // Try all accounts and prefer the owner perspective for correct sender labeling
    let fallbackResult: { detail: any; account: string } | null = null;

    for (const account of this.accounts) {
      const authenticated = await this.ensureAuthenticated(account.name);
      if (!authenticated) continue;

      const token = this.tokens.get(account.name)!;

      try {
        const response = await this.client.get(`/v4/my/orders/${orderId}`, {
          params: { timezone: 'Europe/London' },
          headers: { 'Authorization': `Bearer ${token.accessToken}` },
          __account: account.name,
        } as any);

        const detail = response.data;

        if (detail.role === 'owner') {
          // Preferred: reading as owner gives us the correct perspective
          return this.extractChatMessages(detail, account.name, true);
        }

        // Store as fallback in case no owner account can access this order
        if (!fallbackResult) {
          fallbackResult = { detail, account: account.name };
        }
      } catch (error) {
        const status = error instanceof AxiosError ? error.response?.status : 'unknown';
        this.logger.debug(`readMessages order detail for ${orderId} returned ${status} for ${account.name}`);
      }
    }

    // Use fallback (non-owner perspective) if no owner account found
    if (fallbackResult) {
      return this.extractChatMessages(fallbackResult.detail, fallbackResult.account, false);
    }

    this.logger.debug(`readMessages(${orderId}) — no messages found`);
    return [];
  }

  private extractChatMessages(detail: any, accountName: string, isOwnerPerspective: boolean): { sender: string; content: string; timestamp: string }[] {
    const activities: any[] = detail.activities || [];
    const otherPartName = detail.users?.otherPart?.name || detail.labels?.otherPart || 'Renter';

    const chatMessages = activities
      .filter((a: any) => a.chatMessage?.text?.content)
      .map((a: any) => {
        // Always label from the OWNER's perspective:
        // "Owner" = the listing owner, renterName = the person renting
        let sender: string;
        if (isOwnerPerspective) {
          sender = a.chatMessage.byMe ? 'Owner' : otherPartName;
        } else {
          // Viewing as renter: byMe=true means renter sent it, byMe=false means owner sent it
          sender = a.chatMessage.byMe ? otherPartName : 'Owner';
        }

        let timestamp = new Date().toISOString();
        if (a.createdAtLabel) {
          const parsed = this.parseCreatedAtLabel(a.createdAtLabel);
          if (parsed) timestamp = parsed.toISOString();
        }

        return { sender, content: a.chatMessage.text.content, timestamp };
      });

    if (chatMessages.length > 0) {
      this.logger.log(`readMessages(${detail.id}) found ${chatMessages.length} chat messages from order detail for ${accountName} (role: ${isOwnerPerspective ? 'owner' : 'customer'})`);
    }
    return chatMessages;
  }

  private isWriteEnabledRental(rentalId: string): boolean {
    const allowed = process.env.WRITE_ENABLED_RENTALS || '';
    if (!allowed) return false;
    return allowed.split(',').map(s => s.trim()).includes(rentalId);
  }

  async sendMessage(rentalId: string, message: string): Promise<boolean> {
    const readOnly = process.env.READ_ONLY_MODE === 'true';
    const writeEnabled = this.isWriteEnabledRental(rentalId);

    if (readOnly && !writeEnabled) {
      this.logger.warn(`BLOCKED [READ_ONLY_MODE] sendMessage on rental ${rentalId}: "${message.substring(0, 80)}..."`);
      return false;
    }

    // Send message via PATCH /v4/my/orders/{id}?timezone=Europe/London
    // Filter accounts: respect SEND_ENABLED_ACCOUNTS if set (comma-separated account names)
    const sendEnabledRaw = process.env.SEND_ENABLED_ACCOUNTS || '';
    const sendEnabledAccounts = sendEnabledRaw ? sendEnabledRaw.split(',').map(s => s.trim().toLowerCase()) : null;

    for (const account of this.accounts) {
      // Skip accounts not in the send-enabled list (if configured)
      if (sendEnabledAccounts && !sendEnabledAccounts.includes(account.name)) {
        this.logger.debug(`sendMessage: skipping ${account.name} — not in SEND_ENABLED_ACCOUNTS`);
        continue;
      }

      const authenticated = await this.ensureAuthenticated(account.name);
      if (!authenticated) continue;

      const token = this.tokens.get(account.name)!;

      try {
        const response = await this.client.patch(
          `/v4/my/orders/${rentalId}`,
          { action: 'chat', data: { message } },
          {
            params: { timezone: 'Europe/London' },
            headers: { 'Authorization': `Bearer ${token.accessToken}` },
            __account: account.name,
          } as any,
        );

        if (response.status === 200) {
          this.logger.log(`sendMessage(${rentalId}) sent via ${account.name}: "${message.substring(0, 80)}..."`);
          this.loggingService.info('Message sent', { rentalId, account: account.name, messageLength: message.length });
          // Track this message so the scanner won't re-process it as a new renter message
          this.recentlySentMessages.set(`${rentalId}:${message}`, Date.now());
          return true;
        }
      } catch (error) {
        const status = error instanceof AxiosError ? error.response?.status : 'unknown';
        this.logger.debug(`sendMessage for ${rentalId} failed on ${account.name}: ${status}`);
      }
    }

    this.logger.warn(`sendMessage(${rentalId}) failed on all accounts`);
    return false;
  }

  async checkNewMessages(): Promise<{ rentalId: string; sender: string; content: string; timestamp: string; isNew: boolean }[]> {
    const allNewMessages: { rentalId: string; sender: string; content: string; timestamp: string; isNew: boolean }[] = [];

    // Get all ongoing and upcoming orders to check for messages
    try {
      const allRentals = await this.scanAllAccounts('both');

      // Deduplicate: same listing can appear from multiple account scans
      const processedListingIds = new Set<string>();

      for (const rental of allRentals) {
        // Skip if we already processed this listing in this scan cycle
        if (processedListingIds.has(rental.listingId)) continue;
        processedListingIds.add(rental.listingId);

        try {
          const messages = await this.readMessages(rental.listingId);
          if (messages.length === 0) continue;

          let lastCheckTime = this.lastMessageCheckTime.get(rental.listingId);

          // On first check after startup, only treat messages from a recent window as "new"
          // to avoid re-processing the entire chat history on every restart
          if (lastCheckTime === undefined) {
            const isWriteEnabled = this.isWriteEnabledRental(rental.listingId);
            // Write-enabled rentals get a 24-hour lookback so we don't miss messages
            // that arrived before restart; all others get a conservative 5-minute window
            const STARTUP_WINDOW_MS = isWriteEnabled ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000;
            lastCheckTime = Date.now() - STARTUP_WINDOW_MS;
            this.logger.debug(`First message check for ${rental.listingId}, using startup window (${isWriteEnabled ? '24h — write-enabled' : '5 min'})`);
          }

          for (const msg of messages) {
            const msgTime = new Date(msg.timestamp).getTime();
            const isNew = !isNaN(msgTime) && msgTime > lastCheckTime;

            // Only process messages from the renter, not from ourselves (Owner)
            // Also skip messages whose content matches something we recently sent
            // (prevents re-processing bot responses picked up from another account perspective)
            if (isNew && msg.sender !== 'Owner') {
              const sentKey = `${rental.listingId}:${msg.content}`;
              const sentAt = this.recentlySentMessages.get(sentKey);
              if (sentAt && Date.now() - sentAt < this.SENT_MESSAGE_TTL_MS) {
                this.logger.debug(`Skipping own sent message for ${rental.listingId}: "${msg.content.substring(0, 50)}..."`);
                continue;
              }

              allNewMessages.push({
                rentalId: rental.listingId,
                sender: msg.sender,
                content: msg.content,
                timestamp: msg.timestamp,
                isNew: true,
              });
            }
          }

          // Update last check time
          this.lastMessageCheckTime.set(rental.listingId, Date.now());
        } catch (error) {
          this.logger.debug(`checkNewMessages: error reading messages for ${rental.listingId}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`checkNewMessages: error scanning rentals: ${error.message}`);
    }

    if (allNewMessages.length > 0) {
      this.logger.log(`checkNewMessages found ${allNewMessages.length} new message(s)`);
    }

    return allNewMessages;
  }

  // --- Completed/Obsolete Rental Scanning ---

  /**
   * Scan completed and obsolete rentals for a specific account.
   * Used by CompletedScanService (Rule 6) to sweep finished rentals.
   */
  async scanCompletedRentals(
    accountName: HyggloAccount,
    limit: number = 5,
  ): Promise<RentalListing[]> {
    try {
      const authenticated = await this.ensureAuthenticated(accountName);
      if (!authenticated) {
        this.logger.warn(`Cannot scan completed rentals for ${accountName} - not authenticated`);
        return [];
      }

      const token = this.tokens.get(accountName)!;
      const allRentals: RentalListing[] = [];

      for (const filter of ['completed', 'obsolete'] as const) {
        try {
          const response = await this.client.get('/v4/my/orders', {
            params: {
              role: 'owner',
              filter,
              sort: 'order-start-date',
              offset: 0,
              limit,
            },
            headers: {
              'Authorization': `Bearer ${token.accessToken}`,
            },
            __account: accountName,
          } as any);

          const data = response.data;
          const orders: any[] = Array.isArray(data) ? data : (data.items || data.results || data.data || []);

          // Enrich with details
          const enriched = await this.enrichOrdersWithDetails(orders.slice(0, limit), accountName);
          const mapped = this.mapOrdersToRentalListings(enriched, 'ongoing', accountName);
          allRentals.push(...mapped);
        } catch (error) {
          this.logger.debug(`scanCompletedRentals: ${filter} scan failed for ${accountName}: ${error.message}`);
        }
      }

      this.logger.log(`scanCompletedRentals(${accountName}): found ${allRentals.length} completed/obsolete rentals`);
      return allRentals.slice(0, limit);
    } catch (error) {
      this.logger.error(`scanCompletedRentals error for ${accountName}: ${error.message}`);
      return [];
    }
  }

  // --- Utility ---

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
