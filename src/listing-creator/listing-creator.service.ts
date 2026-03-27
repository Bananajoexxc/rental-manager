import { Injectable, Logger } from '@nestjs/common';
import { execSync } from 'child_process';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CompetitorIntelService } from '../competitor-intel/competitor-intel.service';
import { ImageFinderService } from './image-finder.service';
import { BackgroundRemoverService } from './background-remover.service';
import { ImageComposerService } from './image-composer.service';
import { MASTER_INVENTORY, findBestMatch, getInventoryItemNames } from '../utils/item-matcher';
import { ITEM_COMPATIBILITY } from '../data/item-compatibility';
import { PRICING_CATALOG } from '../data/pricing-catalog';
import { setMarketingListingItems } from '../pipeline/assemble';

const HYGGLO_OWNER_TAKE = 0.64;

@Injectable()
export class ListingCreatorService {
  private readonly logger = new Logger(ListingCreatorService.name);
  private readonly inventoryItems: Set<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly competitorIntelService: CompetitorIntelService,
    private readonly imageFinderService: ImageFinderService,
    private readonly backgroundRemoverService: BackgroundRemoverService,
    private readonly imageComposerService: ImageComposerService,
  ) {
    this.inventoryItems = new Set(Object.keys(MASTER_INVENTORY));
    // Load marketing items into the bot safeguard on startup
    this.loadMarketingItemsForBotGuard().catch(() => {});
  }

  /**
   * Load marketing listing item names into the pipeline's knowledge fence.
   * Called on startup and after new listings are created.
   */
  private async loadMarketingItemsForBotGuard(): Promise<void> {
    try {
      const listings = await this.prisma.marketing_listing.findMany({
        where: { upload_status: { not: 'removed' } },
        select: { items: true },
      });
      const itemNames: string[] = [];
      for (const listing of listings) {
        const items = listing.items as Array<{ item: string }>;
        if (items) {
          for (const entry of items) {
            if (entry.item && !itemNames.includes(entry.item)) {
              itemNames.push(entry.item);
            }
          }
        }
      }
      setMarketingListingItems(itemNames);
      if (itemNames.length > 0) {
        this.logger.log(`Bot guard loaded ${itemNames.length} marketing-only items`);
      }
    } catch (error) {
      this.logger.warn(`Failed to load marketing items for bot guard: ${error.message}`);
    }
  }

  // ────────────── CRON: Bi-monthly listing discovery ──────────────

  /**
   * Bi-monthly cron: 1st of every other month at 10 AM.
   * Scrapes competitor reviews → discovers new listing candidates.
   */
  @Cron('0 10 1 */2 *')
  async biMonthlyListingDiscovery() {
    this.logger.log('=== Bi-monthly listing discovery started ===');
    try {
      // Step 1: Scrape latest competitor reviews
      const reviewCount = await this.competitorIntelService.scrapeCompetitorReviews();
      this.logger.log(`Scraped ${reviewCount} new competitor reviews`);

      // Step 2: Discover new listing candidates from reviews
      const discovered = await this.discoverListingsFromReviews();
      this.logger.log(`Discovered ${discovered} new marketing listing candidates`);
    } catch (error) {
      this.logger.error(`Bi-monthly discovery failed: ${error.message}`);
    }
  }

  // ────────────── DISCOVERY ──────────────

  /**
   * Scan competitor reviews for items we don't stock and haven't already listed.
   * Creates candidate marketing_listing records for items with demand signal.
   */
  async discoverListingsFromReviews(): Promise<number> {
    // Get reviews from last 90 days with item_rented set
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const reviews = await this.prisma.competitor_review.findMany({
      where: {
        item_rented: { not: null },
        review_date: { gte: ninetyDaysAgo },
      },
      include: { competitor: true },
    });

    if (reviews.length === 0) {
      this.logger.log('No recent competitor reviews with item_rented found');
      return 0;
    }

    // Get existing marketing listings to avoid duplicates
    const existingListings = await this.prisma.marketing_listing.findMany({
      select: { title: true, items: true },
    });
    const existingTitles = new Set(existingListings.map(l => l.title.toLowerCase()));

    // Group reviews by item to find demand patterns
    const itemDemand = new Map<string, { count: number; competitors: Set<string>; avgRating: number; reviews: typeof reviews }>();

    for (const review of reviews) {
      const itemName = review.item_rented!;
      const normalized = itemName.trim();
      if (!normalized) continue;

      // Check if this item is already in our inventory
      const match = findBestMatch(normalized, getInventoryItemNames());
      if (match && this.inventoryItems.has(match)) continue;

      // Check if already in marketing listings
      if (existingTitles.has(normalized.toLowerCase())) continue;

      if (!itemDemand.has(normalized)) {
        itemDemand.set(normalized, { count: 0, competitors: new Set(), avgRating: 0, reviews: [] });
      }
      const demand = itemDemand.get(normalized)!;
      demand.count++;
      demand.competitors.add(review.competitor.name);
      if (review.rating) demand.avgRating = (demand.avgRating * (demand.count - 1) + review.rating) / demand.count;
      demand.reviews.push(review);
    }

    let created = 0;

    for (const [itemName, demand] of itemDemand.entries()) {
      // Only create listings for items with at least 1 review (all signals count)
      try {
        // Determine accessories from compatibility data
        const accessories = this.findAccessoriesForItem(itemName);

        // Estimate pricing from competitor data
        const pricing = await this.estimatePricing(itemName);

        // Estimate revenue
        const revenueEst = await this.estimateRevenue(itemName, Array.from(demand.competitors));

        // Determine account (default to dbcinema for cameras/lenses, leo for other)
        const category = this.categorizeItem(itemName);
        const account = ['camera', 'lens', 'gimbal'].includes(category) ? 'dbcinema' : 'dbcinema';

        // Generate title matching existing listing patterns
        const title = this.generateListingTitle(itemName, category);

        await this.prisma.marketing_listing.create({
          data: {
            title,
            items: [{ item: itemName, qty: 1 }],
            accessories: accessories.length > 0 ? accessories : undefined,
            account,
            source: 'competitor_review',
            source_competitor: Array.from(demand.competitors).join(', '),
            price_1day: pricing.price1Day,
            price_3day: pricing.price3Day,
            price_7day: pricing.price7Day,
            estimated_value: pricing.estimatedValue,
            est_monthly_rev_low: revenueEst.low,
            est_monthly_rev_high: revenueEst.high,
            estimation_basis: revenueEst.basis,
          },
        });

        created++;
        this.logger.log(`Created marketing listing: "${title}" (source: ${demand.competitors.size} competitor(s), ${demand.count} review(s))`);
      } catch (error) {
        this.logger.warn(`Failed to create marketing listing for "${itemName}": ${error.message}`);
      }
    }

    return created;
  }

  // ────────────── REVENUE ESTIMATION ──────────────

  /**
   * Estimate monthly revenue for a marketing listing item.
   * Uses competitor review frequency and pricing data with FUZZY matching.
   * Enriched estimation_basis with competitor names, review counts, and account info.
   */
  async estimateRevenue(
    itemName: string,
    competitorNames: string[],
  ): Promise<{ low: number; high: number; basis: string }> {
    const parts: string[] = [];
    const modelSigs = this.extractModelSignature(itemName);

    // Look up ALL active competitor listings — model-specific matching
    const competitorListings = await this.prisma.competitor_listing.findMany({
      where: { is_active: true },
      include: { competitor: true },
    });

    const similarListings = this.findMatchingCompetitorListings(competitorListings, itemName);

    let avgDailyPrice = 0;
    const competitorPriceDetails: string[] = [];
    parts.push(`Model signature: [${modelSigs.join(', ')}]`);

    if (similarListings.length > 0) {
      const priceByCompetitor = new Map<string, { prices: number[]; titles: string[] }>();
      for (const l of similarListings) {
        const name = l.competitor?.name || 'Unknown';
        if (!priceByCompetitor.has(name)) priceByCompetitor.set(name, { prices: [], titles: [] });
        const entry = priceByCompetitor.get(name)!;
        if (l.daily_price) entry.prices.push(l.daily_price);
        entry.titles.push((l.title || '').substring(0, 60));
      }

      const allPrices: number[] = [];
      for (const [name, data] of priceByCompetitor) {
        if (data.prices.length > 0) {
          const avg = data.prices.reduce((a, b) => a + b, 0) / data.prices.length;
          allPrices.push(...data.prices);
          competitorPriceDetails.push(`${name}: £${avg.toFixed(0)}/day (${data.prices.length} listings: ${data.titles[0]}${data.titles.length > 1 ? '...' : ''})`);
        }
      }

      if (allPrices.length > 0) {
        allPrices.sort((a, b) => a - b);
        const median = allPrices[Math.floor(allPrices.length / 2)];
        avgDailyPrice = median; // Use median, not mean — resistant to outliers
        parts.push(`Competitor pricing: ${competitorPriceDetails.join('; ')}`);
        parts.push(`Market median: £${median}/day across ${allPrices.length} listings`);
      }
    }

    // Model-specific review matching
    const allRecentReviews = await this.prisma.competitor_review.findMany({
      where: {
        item_rented: { not: null },
        review_date: { gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) },
      },
      include: { competitor: true },
      orderBy: { review_date: 'desc' },
    });

    const matchingReviews = allRecentReviews.filter(r => {
      const rented = (r.item_rented || '').toLowerCase();
      // Require ALL model signature tokens to match
      return modelSigs.length > 0 && modelSigs.every(sig => rented.includes(sig));
    });

    const reviewsByCompetitor = new Map<string, number>();
    for (const r of matchingReviews) {
      const name = r.competitor?.name || 'Unknown';
      reviewsByCompetitor.set(name, (reviewsByCompetitor.get(name) || 0) + 1);
    }

    const reviewsPerMonth = matchingReviews.length / 6; // 180 days = 6 months
    const reviewDetails = Array.from(reviewsByCompetitor.entries())
      .map(([name, count]) => `${name}: ${count} reviews`)
      .join('; ');
    parts.push(`Demand signal (6mo): ${matchingReviews.length} reviews (${reviewsPerMonth.toFixed(1)}/mo). ${reviewDetails || 'No matching reviews'}`);

    // If no competitor pricing, estimate from category
    if (avgDailyPrice === 0) {
      avgDailyPrice = this.estimateCategoryPrice(itemName);
      if (avgDailyPrice > 0) {
        parts.push(`Category-based price estimate: £${avgDailyPrice.toFixed(0)}/day`);
      }
    }

    // Estimate: avg 2.5 rental days per booking, owner takes 64%
    const avgRentalDays = 2.5;
    const dailyOwnerEarnings = avgDailyPrice * HYGGLO_OWNER_TAKE;
    const effectiveReviewsPerMonth = Math.max(reviewsPerMonth, 0.5); // Floor at 0.5 if unknown
    const baseMonthly = dailyOwnerEarnings * avgRentalDays * effectiveReviewsPerMonth;

    const low = Math.round(baseMonthly * 0.7);
    const high = Math.round(baseMonthly * 1.3);

    parts.push(`Calc: £${dailyOwnerEarnings.toFixed(0)} owner/day × ${avgRentalDays} days × ${effectiveReviewsPerMonth.toFixed(1)} bookings/mo`);

    return {
      low: Math.max(low, 0),
      high: Math.max(high, 0),
      basis: parts.join('\n'),
    };
  }

  /**
   * Rough price estimate by item category when no competitor data exists.
   */
  private estimateCategoryPrice(itemName: string): number {
    const t = itemName.toLowerCase();
    if (/fx[0-9]|red\b|arri|bmpcc.*6k|cinema/i.test(t)) return 75;
    if (/a7|gh[0-9]|r[0-9].*mark|eos r|z[0-9]/i.test(t)) return 50;
    if (/drone|mavic|phantom/i.test(t)) return 45;
    if (/70.200|24.70|gm\b|f\/?1\.[24]/i.test(t)) return 30;
    if (/lens|mm\b/i.test(t)) return 20;
    if (/gimbal|ronin|rs[0-9]/i.test(t)) return 30;
    if (/light|aputure|nanlite|godox/i.test(t)) return 25;
    if (/mic|audio|wireless/i.test(t)) return 15;
    return 25; // default
  }

  // ────────────── PRICING ──────────────

  /**
   * Extract the "model signature" from an item name — the specific identifying part
   * that distinguishes this item from others sharing the same brand.
   *
   * Returns an array of required patterns that ALL must match in a competitor title.
   * e.g. "Canon R6 Mark III" → ["r6", "mark iii"] — both must appear
   *      "Canon RF 24-70mm f2.8" → ["24-70"] — the focal range is the key identifier
   *      "Sony A7s III" → ["a7s"] — the model
   */
  private extractModelSignature(itemName: string): string[] {
    const t = itemName.toLowerCase();
    const sigs: string[] = [];

    // Camera model numbers — brand + specific model
    const cameraMatch = t.match(/\b(fx[0-9]+|a[0-9]+[a-z]*|r[0-9]+|gh[0-9]+|z[0-9]+|bmpcc|pyxis|c[0-9]{2}|x-?[tshp][0-9]+|x100|gopro|mavic|mini\s*\d|red\s*\w+|komodo|venice|alexa)\b/i);
    if (cameraMatch) sigs.push(cameraMatch[1]);

    // Mark/version (Mark II, Mark III, etc.)
    const markMatch = t.match(/\b(mark\s*[iv]+|mk\s*[iv]+)\b/i);
    if (markMatch) sigs.push(markMatch[1].replace(/\s+/g, ' '));

    // Lens focal length — THE key identifier for lenses
    const focalMatch = t.match(/\b(\d+-\d+mm|\d+mm)\b/i);
    if (focalMatch) sigs.push(focalMatch[1]);

    // Aperture for disambiguation (f1.2 vs f2.8 vs f4)
    const apertureMatch = t.match(/\bf\/?(\d+\.?\d*)(?=[^0-9]|$)/i);
    if (apertureMatch) sigs.push(`f${apertureMatch[1]}`);

    // If no signatures found, fall back to the first 2-3 significant words
    if (sigs.length === 0) {
      const words = t.split(/\s+/).filter(w => w.length > 2 && !/^(the|and|for|with|set|kit|pro|mark|camera|lens|light|rental)$/i.test(w));
      sigs.push(...words.slice(0, 3));
    }

    return sigs;
  }

  /**
   * Find competitor listings that match a specific item by model signature.
   * Requires ALL signature parts to appear in the listing title.
   * Filters out service listings (operator, DP, photographer, etc.)
   */
  private findMatchingCompetitorListings(
    allListings: Array<{ title: string; daily_price: number | null; competitor?: { name: string } | null }>,
    itemName: string,
  ): typeof allListings {
    const sigs = this.extractModelSignature(itemName);
    if (sigs.length === 0) return [];

    return allListings.filter(l => {
      const title = l.title?.toLowerCase() || '';

      // Filter out service/operator listings — these include labour costs, not just equipment
      if (/operator|cinematographer|photographer|gaffer|focus puller|dp\b|\bdop\b|£\d+\/hour/i.test(title)) return false;

      // ALL signatures must match
      return sigs.every(sig => title.includes(sig));
    });
  }

  /**
   * Estimate pricing for a marketing listing item based on competitor data and our catalog.
   * Uses MODEL-SPECIFIC matching (not keyword matching) to find the right competitor prices.
   */
  private async estimatePricing(itemName: string): Promise<{
    price1Day: number | null;
    price3Day: number | null;
    price7Day: number | null;
    estimatedValue: number | null;
  }> {
    // Check if we have this item in our pricing catalog
    const catalogEntry = PRICING_CATALOG.find(
      p => p.item_name.toLowerCase() === itemName.toLowerCase(),
    );
    if (catalogEntry) {
      return {
        price1Day: catalogEntry.daily_price_max,
        price3Day: Math.round(catalogEntry.daily_price_max * 2.5),
        price7Day: Math.round(catalogEntry.daily_price_max * 5),
        estimatedValue: null,
      };
    }

    // Look up competitor pricing — model-specific matching
    const allListings = await this.prisma.competitor_listing.findMany({
      where: { is_active: true },
      include: { competitor: true },
    });

    const matchingListings = this.findMatchingCompetitorListings(allListings, itemName);

    if (matchingListings.length > 0) {
      // Extract equipment-only prices (filter outlier high prices likely including operator)
      const prices = matchingListings
        .filter(l => l.daily_price && l.daily_price > 0)
        .map(l => l.daily_price!);

      if (prices.length > 0) {
        // Use median instead of mean to reduce outlier impact
        prices.sort((a, b) => a - b);
        const median = prices[Math.floor(prices.length / 2)];

        // Competitive pricing: 5-10% below median
        const competitivePrice = Math.round(median * 0.92);
        return {
          price1Day: competitivePrice,
          price3Day: Math.round(competitivePrice * 2.4),
          price7Day: Math.round(competitivePrice * 4.8),
          estimatedValue: null,
        };
      }
    }

    // Look up eBay price cache for estimated value
    const ebayCache = await this.prisma.ebay_price_cache.findFirst({
      where: { item_name: { contains: itemName.split(' ').slice(0, 2).join(' '), mode: 'insensitive' } },
    });

    return {
      price1Day: null,
      price3Day: null,
      price7Day: null,
      estimatedValue: ebayCache?.median_price || null,
    };
  }

  // ────────────── ACCESSORIES ──────────────

  /**
   * Find appropriate accessories for an item based on compatibility data.
   */
  private findAccessoriesForItem(itemName: string): Array<{ item: string; qty: number }> {
    const normalized = itemName.toLowerCase();
    const entry = ITEM_COMPATIBILITY.find(
      c => c.item_name.toLowerCase() === normalized ||
        normalized.includes(c.item_name.toLowerCase()) ||
        c.item_name.toLowerCase().includes(normalized),
    );

    if (!entry) return [];

    const accessories: Array<{ item: string; qty: number }> = [];
    for (const inc of entry.included_with_rental) {
      // Parse "3x NP-FZ100 batteries" format
      const qtyMatch = inc.match(/^(\d+)x?\s+(.+)/);
      if (qtyMatch) {
        accessories.push({ item: qtyMatch[2], qty: parseInt(qtyMatch[1], 10) });
      } else {
        accessories.push({ item: inc, qty: 1 });
      }
    }

    return accessories;
  }

  // ────────────── CATEGORIZATION ──────────────

  private categorizeItem(title: string): string {
    const t = title.toLowerCase();
    if (/\bcamera\b|fx[0-9]|a7|bmpcc|6k|gopro|osmo|x100|gh[0-9]|r[0-9]|eos/i.test(t)) return 'camera';
    if (/\blens\b|\bmm\b|f[0-9]|sigma|tamron|gm\b|prime|zoom/i.test(t)) return 'lens';
    if (/\bdrone\b|mavic|dji.*air|phantom|mini.*[0-9]/i.test(t)) return 'drone';
    if (/\blight\b|aputure|godox|nanlite|led\b|panel|softbox|strobe|monolight/i.test(t)) return 'lighting';
    if (/\baudio\b|\bmic\b|\bmicrophone\b|rode|sennheiser|zoom h[0-9]|recorder|wireless.*lav/i.test(t)) return 'audio';
    if (/\bgimbal\b|ronin|zhiyun|moza|stabilizer/i.test(t)) return 'gimbal';
    if (/\btripod\b|monopod|slider|dolly|cage|rig|follow focus|matte box|monitor\b|v.?mount|battery/i.test(t)) return 'accessory';
    return 'other';
  }

  // ────────────── TITLE GENERATION ──────────────

  /**
   * Generate a listing title matching Daniel's actual style.
   * DB Cinema: "SONY A7 V CAMERA + 24-70MM + FLASH SET"
   * Leo: "SONY FX3 CAMERA + 28-70MM LENS | INTERVIEW SET"
   *
   * Cleans up raw review data artifacts (random codes, duplicates).
   */
  private generateListingTitle(itemName: string, category: string): string {
    // Clean up the item name — remove artifacts from review scraping
    let cleaned = itemName
      .replace(/\b[A-Z0-9]{2,4}\b(?=\s|$)/g, (m) => {
        // Keep legitimate model numbers (A7, FX3, R5, GH6, Z8, RS3, etc.)
        if (/^(A[0-9]|FX[0-9]|R[0-9]|GH[0-9]|Z[0-9]|RS[0-9]|XT[0-9]|S[0-9]|XH[0-9])/i.test(m)) return m;
        // Keep known brands/models
        if (/^(GM|II|III|IV|MK|PRO|DJI|LED|RGB|USB|4K|6K|8K|SD|CF|MIC)$/i.test(m)) return m;
        return m; // Keep by default — only strip truly random-looking codes later
      })
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Build title in Daniel's style
    const categoryLabels: Record<string, string> = {
      camera: 'Camera',
      lens: 'Lens',
      drone: 'Drone Kit',
      lighting: 'Light Kit',
      audio: 'Mic Kit',
      gimbal: 'Gimbal',
      accessory: 'Kit',
      other: 'Equipment',
    };

    const label = categoryLabels[category] || 'Equipment';

    // If the item already contains the category word, don't duplicate it
    const hasCategory = cleaned.toLowerCase().includes(label.toLowerCase().replace(' kit', ''));
    if (hasCategory) {
      return `${cleaned} | Rental Set`;
    }
    return `${cleaned} ${label} | Rental Set`;
  }

  // ────────────── DESCRIPTION GENERATOR ──────────────

  /**
   * Generate a listing description matching existing account templates.
   * DB Cinema: Professional cinema-focused, mentions quality and support.
   * Leo: Friendly, mentions flexibility and location convenience.
   *
   * GUARD: Never includes internal address (23 Whitcomb Street).
   * GUARD: Never claims items are "in stock" or "immediately available".
   */
  generateDescription(
    account: 'dbcinema' | 'leo',
    title: string,
    items: Array<{ item: string; qty?: number }>,
    accessories?: Array<{ item: string; qty: number }>,
    pricing?: { price1Day?: number; price3Day?: number; price7Day?: number },
  ): string {
    const mainItems = items.map(i => `${i.qty && i.qty > 1 ? i.qty + 'x ' : ''}${i.item}`).join(', ');
    const accList = accessories?.map(a => `${a.qty > 1 ? a.qty + 'x ' : ''}${a.item}`).join(', ');

    const pickupLocation = account === 'dbcinema'
      ? 'Statue of James II, 11 Trafalgar Square, London'
      : '5 Pall Mall East, London';

    const accountName = account === 'dbcinema' ? 'DB Cinema Rentals' : 'Leo Adams';

    const priceLine = pricing?.price1Day
      ? `From £${pricing.price1Day}/day (multi-day discounts available).`
      : '';

    if (account === 'dbcinema') {
      return [
        `Professional rental set from ${accountName}.`,
        '',
        `Includes: ${mainItems}`,
        accList ? `Accessories included: ${accList}` : '',
        '',
        `All equipment is tested and prepared before each rental. We provide full support throughout your booking.`,
        '',
        priceLine,
        '',
        `Pickup: Central London — near ${pickupLocation}.`,
        '',
        `Questions? Message us directly through the platform.`,
      ].filter(Boolean).join('\n');
    }

    // Leo account
    return [
      `${title} — available for rental from ${accountName}.`,
      '',
      `What's included: ${mainItems}`,
      accList ? `Plus: ${accList}` : '',
      '',
      `Flexible rental periods available. All gear checked and ready to go.`,
      '',
      priceLine,
      '',
      `Collection: Central London — near ${pickupLocation}.`,
      '',
      `Drop me a message if you have any questions!`,
    ].filter(Boolean).join('\n');
  }

  // ────────────── CRUD OPERATIONS ──────────────

  /**
   * Get all marketing listings with optional filters.
   */
  async getMarketingListings(filters?: {
    image_status?: string;
    upload_status?: string;
    account?: string;
  }) {
    const where: any = {};
    if (filters?.image_status) where.image_status = filters.image_status;
    if (filters?.upload_status) where.upload_status = filters.upload_status;
    if (filters?.account) where.account = filters.account;

    return this.prisma.marketing_listing.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Get a single marketing listing by ID.
   */
  async getMarketingListing(id: string) {
    return this.prisma.marketing_listing.findUnique({ where: { id } });
  }

  /**
   * Create a marketing listing manually (from dashboard search bar).
   */
  async createMarketingListing(data: {
    title?: string;
    itemName: string;
    account?: string;
  }) {
    const category = this.categorizeItem(data.itemName);
    const title = data.title || this.generateListingTitle(data.itemName, category);
    const account = data.account || 'dbcinema';
    const accessories = this.findAccessoriesForItem(data.itemName);
    const pricing = await this.estimatePricing(data.itemName);
    const revenueEst = await this.estimateRevenue(data.itemName, []);

    const items = [{ item: data.itemName, qty: 1 }];
    const description = this.generateDescription(
      account as 'dbcinema' | 'leo',
      title,
      items,
      accessories.length > 0 ? accessories : undefined,
      { price1Day: pricing.price1Day ?? undefined, price3Day: pricing.price3Day ?? undefined, price7Day: pricing.price7Day ?? undefined },
    );

    const result = await this.prisma.marketing_listing.create({
      data: {
        title,
        items,
        accessories: accessories.length > 0 ? accessories : undefined,
        account,
        source: 'manual',
        description,
        price_1day: pricing.price1Day,
        price_3day: pricing.price3Day,
        price_7day: pricing.price7Day,
        estimated_value: pricing.estimatedValue,
        est_monthly_rev_low: revenueEst.low,
        est_monthly_rev_high: revenueEst.high,
        estimation_basis: revenueEst.basis,
      },
    });
    // Refresh bot guard with new item
    this.loadMarketingItemsForBotGuard().catch(() => {});
    return result;
  }

  /**
   * Update a marketing listing's fields.
   */
  async updateMarketingListing(id: string, data: Record<string, any>) {
    // Only allow updating specific fields
    const allowedFields = [
      'title', 'seo_tag', 'account', 'description',
      'price_1day', 'price_3day', 'price_7day', 'estimated_value',
      'image_status', 'upload_status', 'composed_image',
    ];
    const updateData: Record<string, any> = {};
    for (const key of allowedFields) {
      if (data[key] !== undefined) updateData[key] = data[key];
    }

    return this.prisma.marketing_listing.update({
      where: { id },
      data: updateData,
    });
  }

  /**
   * Approve a marketing listing for upload.
   */
  async approveMarketingListing(id: string) {
    return this.prisma.marketing_listing.update({
      where: { id },
      data: {
        approved_by: 'owner',
        approved_at: new Date(),
        upload_status: 'pending_upload',
      },
    });
  }

  /**
   * Delete a marketing listing.
   */
  async deleteMarketingListing(id: string) {
    const result = await this.prisma.marketing_listing.delete({ where: { id } });
    // Refresh bot guard after removal
    this.loadMarketingItemsForBotGuard().catch(() => {});
    return result;
  }

  /**
   * Get summary stats for marketing listings.
   */
  async getMarketingListingStats() {
    const [total, draft, pendingUpload, uploaded, pendingImages, readyImages] = await Promise.all([
      this.prisma.marketing_listing.count(),
      this.prisma.marketing_listing.count({ where: { upload_status: 'draft' } }),
      this.prisma.marketing_listing.count({ where: { upload_status: 'pending_upload' } }),
      this.prisma.marketing_listing.count({ where: { upload_status: 'uploaded' } }),
      this.prisma.marketing_listing.count({ where: { image_status: 'pending' } }),
      this.prisma.marketing_listing.count({ where: { image_status: 'ready' } }),
    ]);

    return { total, draft, pendingUpload, uploaded, pendingImages, readyImages };
  }

  /**
   * Check if a Hygglo listing ID belongs to a marketing-only listing.
   * Used by autonomous service to detect marketing demand.
   */
  async isMarketingListing(hyggloListingId: string): Promise<boolean> {
    const found = await this.prisma.marketing_listing.findFirst({
      where: { hygglo_listing_id: hyggloListingId },
      select: { id: true },
    });
    return !!found;
  }

  /**
   * Record a demand signal for a marketing listing.
   * Writes to demand_record table with source='marketing_listing'.
   */
  async recordMarketingDemand(hyggloListingId: string, renterName?: string): Promise<void> {
    const listing = await this.prisma.marketing_listing.findFirst({
      where: { hygglo_listing_id: hyggloListingId },
      select: { id: true, title: true, items: true, account: true, price_1day: true },
    });
    if (!listing) return;

    const items = (listing.items as Array<{ item: string }>) || [];
    const itemNames = items.map(i => i.item);

    // Write to demand_record for lost revenue tracking
    await this.prisma.demand_record.create({
      data: {
        items: itemNames,
        bundle_label: listing.title,
        renter_name: renterName,
        account: listing.account,
        outcome: 'rejected',
        rejection_reason: 'Marketing-only listing — item not in physical inventory',
        rental_value: listing.price_1day,
        source: 'marketing_listing',
      },
    });

    this.logger.log(`Marketing demand recorded: "${listing.title}" requested by ${renterName || 'unknown'}`);
  }

  // ────────────── ITEM PARSING & ACCESSORY DETECTION ──────────────

  /**
   * Parse a compound item name into distinct products.
   * "Canon R6 mark II Canon RF 24-70mm f2.8" → ["Canon R6 Mark II", "Canon RF 24-70mm f2.8"]
   * "Sony A7s iii + 3 batteries +256GB V90"  → ["Sony A7s III"] (batteries/cards extracted as accessories)
   * "Aputure LS 600c Pro + Lantern"          → ["Aputure LS 600c Pro", "Lantern"]
   */
  private parseMainProducts(rawItem: string): string[] {
    // First, try splitting on explicit delimiters: + , " - " and "and"
    let segments = rawItem.split(/\s*[\+]\s*|\s*,\s*|\s+\-\s+|\s+and\s+/i)
      .map(s => s.trim())
      .filter(s => s.length > 2);

    // If only 1 segment, try to detect concatenated camera+lens patterns
    // e.g. "Canon R6 mark II Canon RF 24-70mm f2.8" → ["Canon R6 mark II", "Canon RF 24-70mm f2.8"]
    if (segments.length === 1) {
      const text = segments[0];
      // Split where a brand name starts a lens/second product mid-string
      // Pattern: "<anything> <Brand> <lens/RF/EF/FE/XF pattern>"
      const splitMatch = text.match(
        /^(.+?)\s+((?:Canon|Sony|Nikon|Fuji\w*|Sigma|Tamron|Panasonic|Leica|Zeiss)\s+(?:RF|EF|FE|XF|GF|E|Z|S|GM|Art|DG)\s+\d+.*)$/i
      );
      if (splitMatch && splitMatch[1].length > 4 && splitMatch[2].length > 4) {
        segments = [splitMatch[1].trim(), splitMatch[2].trim()];
      }
    }

    const products: string[] = [];
    for (const seg of segments) {
      const lower = seg.toLowerCase();
      // Skip pure accessories — batteries, SD cards, cables, memory, qty prefixes
      if (/^\d+x?\s/i.test(seg) && /batter|card|cable|charger|sd|cf|memory/i.test(lower)) continue;
      if (/^\d+gb\b|^\d+tb\b|^v90\b|^v60\b/i.test(lower)) continue;
      if (/^batter|^sd card|^memory card|^cable|^charger|^strap/i.test(lower)) continue;
      products.push(seg);
    }

    return products.length > 0 ? products.slice(0, 3) : [rawItem]; // Max 3 main products
  }

  /**
   * Determine standard accessories for a camera/device based on brand/type.
   * Returns search-friendly names for the image finder.
   *
   * Context-aware rules:
   * - Cinema cameras (FX3, FX6, RED, ARRI, BMPCC): 3x batteries + V90 SD card
   * - Photo/hybrid cameras (A7, R6, Z8): 3x batteries + V90 SD card
   * - Action/compact (GoPro, DJI): 1x battery + standard SD
   * - Lenses/lights/audio: no accessories
   */
  private determineAccessoriesForSearch(mainProducts: string[]): string[] {
    const accessories: string[] = [];
    const allText = mainProducts.join(' ').toLowerCase();

    // Cinema/professional cameras get 3x batteries; compact get 1x
    const isCinemaKit = /fx[0-9]|a7|a9|a1|r[0-9]|bmpcc|blackmagic|pyxis|red\b|komodo|arri|alexa|gh[0-9]|z[0-9]|s[0-9]h|x-h/i.test(allText);
    const isCompactCam = /gopro|osmo|insta360|x100|zv-/i.test(allText);
    const isCamera = isCinemaKit || isCompactCam || /camera|drone|mavic/i.test(allText);

    // Detect camera brand for correct battery type
    const batteryMap: Array<[RegExp, string]> = [
      [/sony\s*(fx|a7|a9|a1|zv)/i, 'Sony NP-FZ100 battery'],
      [/canon\s*(r[0-9]|eos\s*r|c[0-9])/i, 'Canon LP-E6NH battery'],
      [/canon\s*r[0-9].*mark/i, 'Canon LP-E6NH battery'],
      [/fuji|x-t[0-9]|x-h[0-9]|x100/i, 'Fujifilm NP-W235 battery'],
      [/nikon\s*z/i, 'Nikon EN-EL15c battery'],
      [/panasonic|lumix|gh[0-9]|s[0-9]h/i, 'Panasonic DMW-BLK22 battery'],
      [/bmpcc|blackmagic|pyxis/i, 'Canon LP-E6NH battery'],
      [/red\b|komodo/i, 'V-mount battery'],
      [/arri|alexa/i, 'V-mount battery'],
    ];

    let batteryName = '';
    for (const [pattern, battery] of batteryMap) {
      if (pattern.test(allText)) {
        batteryName = battery;
        break;
      }
    }

    // Cinema/pro cameras: 3x batteries. Compact: 1x.
    if (batteryName) {
      const batteryCount = isCinemaKit ? 3 : 1;
      for (let i = 0; i < batteryCount; i++) {
        accessories.push(batteryName);
      }
    }

    // SD card: Cinema cameras need V90 high-speed cards, not generic SD
    if (isCamera) {
      if (isCinemaKit) {
        accessories.push('Lexar Professional 256GB V90 SD card');
      } else {
        accessories.push('128GB SD card');
      }
    }

    return accessories;
  }

  // ────────────── IMAGE PIPELINE ORCHESTRATION ──────────────

  /**
   * Generate listing images for a marketing listing.
   * Pipeline: parse items → find images (main + accessories) → remove backgrounds → compose.
   *
   * The composer expects SEPARATE mainPaths and accPaths arrays.
   * Main = camera bodies, lenses, gimbals, lights (the hero products)
   * Acc = batteries, SD cards, cables (small supporting items)
   */
  async generateImages(listingId: string): Promise<{ success: boolean; composedImage?: string; error?: string }> {
    const listing = await this.prisma.marketing_listing.findUnique({ where: { id: listingId } });
    if (!listing) return { success: false, error: 'Listing not found' };

    const items = listing.items as Array<{ item: string; qty?: number }>;
    if (!items || items.length === 0) return { success: false, error: 'No items in listing' };

    try {
      // Step 1: Collect main products from ALL items entries + determine accessories
      // For bundles: each items[] entry is a main product
      // For single items: parse the compound name into separate products
      let mainProducts: string[];
      if (items.length > 1) {
        // Bundle: each item entry is a main product
        mainProducts = items.map(e => e.item).slice(0, 3); // Max 3 main items for layout
      } else {
        // Single item: parse compound names (e.g., "Canon R6 + Canon RF 24-70mm")
        mainProducts = this.parseMainProducts(items[0]?.item || '');
      }
      const accessorySearchTerms = this.determineAccessoriesForSearch(mainProducts);

      this.logger.log(`[${listingId}] Parsed: ${mainProducts.length} main products, ${accessorySearchTerms.length} accessories`);
      this.logger.log(`[${listingId}]   Main: ${mainProducts.join(' | ')}`);
      if (accessorySearchTerms.length > 0) {
        this.logger.log(`[${listingId}]   Acc: ${accessorySearchTerms.join(' | ')}`);
      }

      // Step 2: Find product images — main items first, then accessories
      this.logger.log(`[${listingId}] Step 2: Finding product images...`);
      const mainSourcePaths: string[] = [];
      const accSourcePaths: string[] = [];

      for (let i = 0; i < mainProducts.length; i++) {
        const paths = await this.imageFinderService.findProductImages(listingId, mainProducts[i], `main${i}`);
        if (paths.length > 0) mainSourcePaths.push(paths[0]); // 1 image per main product
      }

      for (let i = 0; i < accessorySearchTerms.length; i++) {
        const paths = await this.imageFinderService.findProductImages(listingId, accessorySearchTerms[i], `acc${i}`);
        if (paths.length > 0) accSourcePaths.push(paths[0]); // 1 image per accessory
      }

      const allSourcePaths = [...mainSourcePaths, ...accSourcePaths];
      if (allSourcePaths.length === 0) {
        await this.prisma.marketing_listing.update({
          where: { id: listingId },
          data: { image_status: 'images_found' },
        });
        return { success: false, error: 'No product images found for any items' };
      }

      await this.prisma.marketing_listing.update({
        where: { id: listingId },
        data: {
          image_status: 'images_found',
          product_images: allSourcePaths,
        },
      });
      this.logger.log(`[${listingId}] Found ${mainSourcePaths.length} main + ${accSourcePaths.length} accessory images`);

      // Step 3: Remove backgrounds — track main vs acc separately
      this.logger.log(`[${listingId}] Step 3: Removing backgrounds...`);
      const mainTransparent: string[] = [];
      const accTransparent: string[] = [];

      for (const sourcePath of mainSourcePaths) {
        const transparent = await this.backgroundRemoverService.removeBackground(listingId, sourcePath);
        if (transparent) mainTransparent.push(transparent);
      }

      for (const sourcePath of accSourcePaths) {
        const transparent = await this.backgroundRemoverService.removeBackground(listingId, sourcePath);
        if (transparent) accTransparent.push(transparent);
      }

      if (mainTransparent.length === 0 && accTransparent.length === 0) {
        return { success: false, error: 'Background removal failed for all images' };
      }

      await this.prisma.marketing_listing.update({
        where: { id: listingId },
        data: { image_status: 'bg_removed' },
      });
      this.logger.log(`[${listingId}] ${mainTransparent.length} main + ${accTransparent.length} acc transparent images`);

      // Step 4: Compose final listing image — mainPaths and accPaths separately
      this.logger.log(`[${listingId}] Step 4: Composing listing image...`);
      const account = (listing.account || 'dbcinema') as 'dbcinema' | 'leo';
      const title = listing.title || 'Untitled Listing';

      const composedPath = await this.imageComposerService.composeListingImage(
        listingId,
        account,
        title,
        mainTransparent,
        accTransparent,
      );

      if (!composedPath) {
        return { success: false, error: 'Image composition failed' };
      }

      // Step 5: Update listing with final image + store accessories if not set
      const updateData: any = {
        image_status: 'ready',
        composed_image: composedPath,
      };
      if (!listing.accessories && accessorySearchTerms.length > 0) {
        updateData.accessories = accessorySearchTerms.map(a => ({ item: a, qty: 1 }));
      }

      await this.prisma.marketing_listing.update({
        where: { id: listingId },
        data: updateData,
      });

      this.logger.log(`[${listingId}] Image pipeline complete: ${composedPath}`);
      return { success: true, composedImage: composedPath };

    } catch (error) {
      this.logger.error(`[${listingId}] Image pipeline failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate images for all pending listings (batch).
   */
  async generateAllPendingImages(): Promise<{ processed: number; succeeded: number; failed: number }> {
    const pending = await this.prisma.marketing_listing.findMany({
      where: { image_status: 'pending' },
      select: { id: true, title: true },
    });

    let succeeded = 0;
    let failed = 0;

    for (const listing of pending) {
      this.logger.log(`Processing images for: ${listing.title}`);
      const result = await this.generateImages(listing.id);
      if (result.success) succeeded++;
      else failed++;
    }

    return { processed: pending.length, succeeded, failed };
  }

  // ────────────── BATCH RE-ESTIMATION ──────────────

  /**
   * Re-estimate pricing and revenue for ALL existing marketing listings.
   * Uses updated fuzzy matching logic and competitive pricing.
   * Also cleans up titles with artifacts.
   */
  async reEstimateAll(): Promise<{ updated: number; errors: number }> {
    const listings = await this.prisma.marketing_listing.findMany();
    let updated = 0;
    let errors = 0;

    for (const listing of listings) {
      try {
        const items = listing.items as Array<{ item: string; qty?: number }>;
        const isBundle = items && items.length > 1;
        const mainItem = items?.[0]?.item || listing.title;
        const competitorNames = listing.source_competitor
          ? listing.source_competitor.split(', ')
          : [];

        // For BUNDLES: estimate pricing by summing individual items
        // For SINGLE items: estimate as before
        let totalPrice1Day: number | null = null;
        let pricingBasis: string[] = [];

        if (isBundle) {
          let sum = 0;
          let foundAny = false;
          for (const entry of items) {
            const itemPricing = await this.estimatePricing(entry.item);
            const qty = entry.qty || 1;
            if (itemPricing.price1Day) {
              sum += itemPricing.price1Day * qty;
              foundAny = true;
              pricingBasis.push(`${entry.item}: £${itemPricing.price1Day}/day × ${qty}`);
            } else {
              // Fallback to category price
              const catPrice = this.estimateCategoryPrice(entry.item);
              sum += catPrice * qty;
              pricingBasis.push(`${entry.item}: £${catPrice}/day (category est.) × ${qty}`);
            }
          }
          // Bundle discount: 10% off sum (bundling incentive)
          totalPrice1Day = foundAny ? Math.round(sum * 0.9) : null;
          if (totalPrice1Day) {
            pricingBasis.push(`Bundle total: £${sum}/day → £${totalPrice1Day}/day (10% bundle discount)`);
          }
        } else {
          const pricing = await this.estimatePricing(mainItem);
          totalPrice1Day = pricing.price1Day;
        }

        const price1Day = totalPrice1Day;
        const price3Day = price1Day ? Math.round(price1Day * 2.4) : null;
        const price7Day = price1Day ? Math.round(price1Day * 4.8) : null;

        // Re-estimate revenue with model-specific matching on primary item
        const revenueEst = await this.estimateRevenue(mainItem, competitorNames);
        if (pricingBasis.length > 0) {
          revenueEst.basis = `Bundle pricing:\n${pricingBasis.join('\n')}\n\n${revenueEst.basis}`;
        }
        // Adjust revenue for bundle price if different
        if (isBundle && price1Day) {
          const dailyOwnerEarnings = price1Day * HYGGLO_OWNER_TAKE;
          const avgRentalDays = 2.5;
          const effectiveBookings = Math.max(0.5, revenueEst.high / (dailyOwnerEarnings * avgRentalDays * 1.3) || 0.5);
          revenueEst.low = Math.round(dailyOwnerEarnings * avgRentalDays * effectiveBookings * 0.7);
          revenueEst.high = Math.round(dailyOwnerEarnings * avgRentalDays * effectiveBookings * 1.3);
        }

        // Title: NEVER overwrite bundle titles (multi-item) or manual titles
        // Only auto-clean single-item titles from automated sources (competitor_review)
        const preserveTitle = isBundle || listing.source === 'manual';
        const cleanTitle = preserveTitle
          ? listing.title
          : this.generateListingTitle(mainItem, this.categorizeItem(mainItem));

        // Generate description
        const account = (listing.account || 'dbcinema') as 'dbcinema' | 'leo';
        const accessories = listing.accessories as Array<{ item: string; qty: number }> | null;
        const description = this.generateDescription(
          account,
          cleanTitle,
          items || [{ item: mainItem, qty: 1 }],
          accessories || undefined,
          { price1Day: price1Day ?? undefined, price3Day: price3Day ?? undefined, price7Day: price7Day ?? undefined },
        );

        await this.prisma.marketing_listing.update({
          where: { id: listing.id },
          data: {
            title: cleanTitle,
            description,
            price_1day: price1Day ?? listing.price_1day,
            price_3day: price3Day ?? listing.price_3day,
            price_7day: price7Day ?? listing.price_7day,
            est_monthly_rev_low: revenueEst.low,
            est_monthly_rev_high: revenueEst.high,
            estimation_basis: revenueEst.basis,
          },
        });

        updated++;
        this.logger.debug(`Re-estimated: ${cleanTitle} → £${revenueEst.low}-${revenueEst.high}/mo`);
      } catch (error) {
        errors++;
        this.logger.warn(`Failed to re-estimate ${listing.id}: ${error.message}`);
      }
    }

    this.logger.log(`Re-estimation complete: ${updated} updated, ${errors} errors`);
    return { updated, errors };
  }

  /**
   * Reset image status for all listings so they can be re-processed.
   */
  async resetImageStatuses(): Promise<number> {
    const result = await this.prisma.marketing_listing.updateMany({
      where: { image_status: { not: 'ready' } },
      data: {
        image_status: 'pending',
        product_images: [],
        composed_image: null,
      },
    });
    this.logger.log(`Reset ${result.count} listings to pending image status`);
    return result.count;
  }




  // ────────────── PORT TO LEO: GAP DETECTION ──────────────

  /**
   * Return DB Cinema listings that Leo doesn't have, with their Hygglo images.
   */
  async getPortableGaps(): Promise<{ gaps: Array<{ title: string; slug: string; price: number; image: string }> }> {
    const dbCinemaRentals = await this.prisma.$queryRaw<Array<{
      title: string; listing_url: string; photos_urls: string[]; rental_price: number;
    }>>`
      SELECT DISTINCT ON (title) title, listing_url, photos_urls, rental_price
      FROM rental
      WHERE account = 'dbcinema'
        AND status NOT IN ('cancelled', 'obsolete', 'consolidated')
        AND listing_url IS NOT NULL
      ORDER BY title, created_at DESC
    `;

    const leoRentals = await this.prisma.$queryRaw<Array<{ title: string }>>`
      SELECT DISTINCT title FROM rental
      WHERE account = 'leo'
        AND status NOT IN ('cancelled', 'obsolete', 'consolidated')
        AND listing_url IS NOT NULL
    `;

    const existingLeoMarketing = await this.prisma.marketing_listing.findMany({
      where: { account: 'leo' },
      select: { title: true },
    });

    const leoTitlesNorm = new Set([
      ...leoRentals.map(r => this.normalizeForComparison(r.title)),
      ...existingLeoMarketing.map(r => this.normalizeForComparison(r.title)),
    ]);

    const gaps: Array<{ title: string; slug: string; price: number; image: string }> = [];

    for (const db of dbCinemaRentals) {
      const dbNorm = this.normalizeForComparison(db.title);
      let found = false;

      for (const leoNorm of leoTitlesNorm) {
        const dbWords = new Set(dbNorm.split(/\s+/).filter((w: string) => w.length > 2));
        const leoWords = new Set(leoNorm.split(/\s+/).filter((w: string) => w.length > 2));
        if (dbWords.size > 0 && leoWords.size > 0) {
          let overlap = 0;
          for (const w of dbWords) { if (leoWords.has(w)) overlap++; }
          if (overlap / Math.max(dbWords.size, leoWords.size) > 0.5) {
            found = true;
            break;
          }
        }
      }

      if (!found) {
        const slug = db.listing_url ? db.listing_url.replace(/\/$/, '').split('/').pop() || '' : '';
        const image = db.photos_urls?.[0] || '';
        gaps.push({
          title: db.title,
          slug,
          price: Number(db.rental_price) || 0,
          image,
        });
      }
    }

    return { gaps };
  }

  // ────────────── PORT TO LEO: EXECUTE SINGLE ──────────────

  async portSingleListing(input: {
    slug: string; title: string; image?: string; price?: number;
  }): Promise<{ success: boolean; listingId?: string; composedImage?: string; description?: string; title?: string; dailyPrice?: number; price3days?: number; price7days?: number; estimatedValue?: number; error?: string }> {
    const fs = require('fs');
    const pathMod = require('path');
    const { execSync } = require('child_process');

    try {
      const itemName = this.extractCoreItemName(input.title);
      const listing = await this.prisma.marketing_listing.create({
        data: {
          title: input.title,
          items: [{ item: itemName, qty: 1 }],
          account: 'leo',
          source: 'port_from_dbcinema',
          source_competitor: 'dbcinema',
          price_1day: input.price && input.price > 0 ? input.price : null,  // Will be updated with API prices below
          image_status: 'pending',
          upload_status: 'draft',
        },
      });
      const listingId = listing.id;
      const imgDir = pathMod.join(process.cwd(), 'listing-creator-images', listingId);
      fs.mkdirSync(pathMod.join(imgDir, 'composed'), { recursive: true });

      // Step 1: Download the DB Cinema listing image
      let composedPath: string | null = null;
      if (input.image) {
        const srcPath = pathMod.join(imgDir, 'source.jpg');
        const outPath = pathMod.join(imgDir, 'composed', 'listing.jpg');

        const response = await fetch(input.image);
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(srcPath, buffer);
          this.logger.log('[port] Downloaded image for ' + input.title.substring(0, 50));

          // Step 2: Background swap — cut out ALL foreground, composite onto Leo gradient
          try {
            execSync(
              'python3 ' + pathMod.join(process.cwd(), 'bg_swap.py') + ' "' + srcPath + '" "' + outPath + '"',
              { timeout: 180000, encoding: 'utf-8' },
            );
            if (fs.existsSync(outPath)) {
              composedPath = outPath;
              this.logger.log('[port] Background swapped to Leo gradient');
            }
          } catch (bgErr: any) {
            this.logger.warn('[port] bg_swap failed: ' + (bgErr.message || '').substring(0, 200));
          }
        }
      }

      // Step 3: Copy DB Cinema description, swap footer to Leo's
      let leoDesc: string | null = null;
      let price1day = input.price && input.price > 0 ? input.price : null;
      let price3day: number | null = null;
      let price7day: number | null = null;
      if (input.slug) {
        try {
          const apiResponse = await fetch(
            'https://api.hygglo.com/api/v2/product-listings/' + input.slug,
            { headers: { Country: 'GB', Accept: 'application/json', 'User-Client': 'Hygglo-web' } },
          );
          if (apiResponse.ok) {
            const data = await apiResponse.json();
            const prod = data.product || data;
            const dbDesc: string = prod.description || '';
            if (dbDesc) {
              leoDesc = this.convertDescriptionToLeo(dbDesc);
            }
            // Extract multi-day prices from API
            if (Array.isArray(prod.prices)) {
              for (const p of prod.prices) {
                if (p.days === 1) price1day = p.price;
                if (p.days === 3) price3day = p.price;
                if (p.days === 7) price7day = p.price;
              }
            }
          }
        } catch (descErr: any) {
          this.logger.warn('[port] Failed to fetch description: ' + descErr.message);
        }
      }

      // Step 4: Update listing
      await this.prisma.marketing_listing.update({
        where: { id: listingId },
        data: {
          description: leoDesc || undefined,
          image_status: composedPath ? 'ready' : 'pending',
          composed_image: composedPath || undefined,
          price_1day: price1day || undefined,
          price_3day: price3day || undefined,
          price_7day: price7day || undefined,
        },
      });

      await this.loadMarketingItemsForBotGuard().catch(() => {});
      // Fetch pricing info from the created listing for edit panel
      const createdListing = await this.prisma.marketing_listing.findUnique({ where: { id: listingId } });
      return {
        success: true,
        listingId,
        composedImage: composedPath || undefined,
        description: leoDesc || undefined,
        title: input.title,
        dailyPrice: createdListing?.price_1day ? Number(createdListing.price_1day) : (input.price || undefined),
        price3days: createdListing?.price_3day ? Number(createdListing.price_3day) : undefined,
        price7days: createdListing?.price_7day ? Number(createdListing.price_7day) : undefined,
        estimatedValue: createdListing?.estimated_value ? Number(createdListing.estimated_value) : undefined,
      };
    } catch (e: any) {
      this.logger.error('[port] Failed: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  private normalizeForComparison(title: string): string {
    return title
      .toLowerCase()
      .replace(/\b(rental|set|kit|hire|london|professional|cinema|like|and more)\b/g, '')
      .replace(/[|\u2022\-\u2013\u2014"()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractCoreItemName(title: string): string {
    let name = title.split(/\s*[|]\s*/)[0].trim();
    name = name.replace(/\b(rental|set|kit|hire)\b/gi, '').trim();
    if (name.length > 60) name = name.substring(0, 60).trim();
    return name;
  }

  private async generateLeoDescriptionViaCLI(title: string, dbDescription: string): Promise<string | null> {
    const itemName = this.extractCoreItemName(title);
    const prompt = `You are writing a Hygglo rental listing description for Leo Adams' account.

Here is the DB Cinema listing for the same item:
TITLE: ${title}
DESCRIPTION: ${dbDescription.substring(0, 2000)}

Convert this to Leo's description format. Follow this EXACT structure:

1. Start with: Included in this ${itemName} Rental Set
   Then list items grouped by category using bullet format

2. Then: About the ${itemName}
   Write 2-3 sentences describing the item. Enthusiastic but factual.

3. Then: Perfect for:
   List 5-6 use cases

4. Then: ${itemName} highlights:
   List 5-7 key features as bullet points

5. Then add this EXACT footer:

First time renting? Get 20 pounds off with code: dani-2dbf0

About us
Operation times: 9am to 12pm and 5pm to 9pm
Located near Pall Mall East, 3 min from Charing Cross
Delivery available! Please enquire for rates

DISCOUNTS
7 days for the price of 5
1 month for the price of 2.5 weeks

ADD-ONS
We also offer cameras, lenses, gimbals, drones, lights, LEDs, wireless mics, monitors, tripods, sliders, smoke machines, filters, and more. Ask us!

RULES:
- No specific prices
- No competitor mentions
- Friendly, professional tone
- Only output the description text`;

    try {
      const { execSync } = require('child_process');
      const result = execSync('claude --print --model haiku', {
        input: prompt,
        timeout: 90000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return result.trim() || null;
    } catch (e: any) {
      this.logger.error('claude CLI failed: ' + e.message);
      return null;
    }
  }


  /**
   * Convert a DB Cinema description to Leo's format.
   * Copies the item list and product info exactly, swaps only the footer.
   */
  private convertDescriptionToLeo(dbDesc: string): string {
    let desc = dbDesc;

    // Location swaps
    desc = desc.replace(/Trafalgar Square/gi, 'Pall Mall East');
    desc = desc.replace(/Tottenham Court Road/gi, 'Charing Cross');
    desc = desc.replace(/near Statue of James II[^\n]*/gi, 'near Pall Mall East, 3 min from Charing Cross');

    // Operation times: Leo uses 9am-12pm and 5pm-9pm
    desc = desc.replace(/9am[\u2013\-]12pm and 7pm[\u2013\-]9pm/g, '9am\u201312pm and 5pm\u20139pm');

    // Account name
    desc = desc.replace(/DB Cinema Rentals?/gi, 'Leo Adams');
    desc = desc.replace(/DB Cinema/gi, 'Leo Adams');

    return desc;
  }

}
