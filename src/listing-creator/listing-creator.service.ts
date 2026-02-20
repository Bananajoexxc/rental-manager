import { Injectable, Logger } from '@nestjs/common';
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
   * Uses competitor review frequency and pricing data.
   */
  async estimateRevenue(
    itemName: string,
    competitorNames: string[],
  ): Promise<{ low: number; high: number; basis: string }> {
    const parts: string[] = [];

    // Look up competitor pricing for similar items
    const competitorListings = await this.prisma.competitor_listing.findMany({
      where: {
        is_active: true,
        competitor: { name: { in: competitorNames } },
      },
      include: { competitor: true },
    });

    // Find listings with similar items
    const similarListings = competitorListings.filter(l => {
      const title = l.title.toLowerCase();
      const item = itemName.toLowerCase();
      // Simple substring match for finding related listings
      const itemTokens = item.split(/\s+/).filter(t => t.length > 2);
      const matchCount = itemTokens.filter(t => title.includes(t)).length;
      return matchCount >= Math.ceil(itemTokens.length * 0.5);
    });

    let avgDailyPrice = 0;
    if (similarListings.length > 0) {
      const prices = similarListings.filter(l => l.daily_price).map(l => l.daily_price!);
      avgDailyPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
      parts.push(`Competitor avg daily price: £${avgDailyPrice.toFixed(0)} (${prices.length} listings)`);
    }

    // Count reviews per month for demand estimation
    const reviewsLast90 = await this.prisma.competitor_review.count({
      where: {
        item_rented: itemName,
        review_date: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
      },
    });
    const reviewsPerMonth = reviewsLast90 / 3;
    parts.push(`Review frequency: ${reviewsPerMonth.toFixed(1)}/month (${reviewsLast90} in 90 days)`);

    // Estimate: avg 2.5 rental days per booking, owner takes 64%
    const avgRentalDays = 2.5;
    const dailyOwnerEarnings = avgDailyPrice * HYGGLO_OWNER_TAKE;
    const baseMonthly = dailyOwnerEarnings * avgRentalDays * reviewsPerMonth;

    // ±30% variance for low/high
    const low = Math.round(baseMonthly * 0.7);
    const high = Math.round(baseMonthly * 1.3);

    parts.push(`Calc: £${dailyOwnerEarnings.toFixed(0)}/day × ${avgRentalDays} days × ${reviewsPerMonth.toFixed(1)} bookings/mo × 0.7-1.3`);

    return {
      low: Math.max(low, 0),
      high: Math.max(high, 0),
      basis: parts.join('. '),
    };
  }

  // ────────────── PRICING ──────────────

  /**
   * Estimate pricing for a marketing listing item based on competitor data and our catalog.
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

    // Look up competitor pricing
    const competitorListings = await this.prisma.competitor_listing.findMany({
      where: {
        is_active: true,
        title: { contains: itemName.split(' ').slice(0, 2).join(' '), mode: 'insensitive' },
      },
    });

    if (competitorListings.length > 0) {
      const prices = competitorListings.filter(l => l.daily_price).map(l => l.daily_price!);
      if (prices.length > 0) {
        const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
        return {
          price1Day: avgPrice,
          price3Day: Math.round(avgPrice * 2.5),
          price7Day: Math.round(avgPrice * 5),
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
   * Generate a listing title matching existing account patterns.
   * DB Cinema pattern: "Sony FX3 + GM 24-70mm f2.8 + DJI RS3 Pro Gimbal | Cinema Kit"
   * Leo pattern: "Sony FX3 Camera + 28-70mm Lens | Interview Set"
   */
  private generateListingTitle(itemName: string, category: string): string {
    const categoryLabels: Record<string, string> = {
      camera: 'Camera',
      lens: 'Lens',
      drone: 'Drone',
      lighting: 'Light',
      audio: 'Mic Kit',
      gimbal: 'Gimbal',
      accessory: 'Kit',
      other: 'Equipment',
    };

    const label = categoryLabels[category] || 'Equipment';
    return `${itemName} ${label} | Rental`;
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

    const result = await this.prisma.marketing_listing.create({
      data: {
        title,
        items: [{ item: data.itemName, qty: 1 }],
        accessories: accessories.length > 0 ? accessories : undefined,
        account,
        source: 'manual',
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
   */
  async recordMarketingDemand(hyggloListingId: string, renterName?: string): Promise<void> {
    const listing = await this.prisma.marketing_listing.findFirst({
      where: { hygglo_listing_id: hyggloListingId },
      select: { id: true, title: true, items: true },
    });
    if (!listing) return;

    const items = (listing.items as Array<{ item: string }>) || [];
    const itemNames = items.map(i => i.item);

    this.logger.log(`Marketing demand: "${listing.title}" requested by ${renterName || 'unknown'}`);
  }

  // ────────────── IMAGE PIPELINE ORCHESTRATION ──────────────

  /**
   * Generate listing images for a marketing listing.
   * Pipeline: find product images → remove backgrounds → compose final image.
   */
  async generateImages(listingId: string): Promise<{ success: boolean; composedImage?: string; error?: string }> {
    const listing = await this.prisma.marketing_listing.findUnique({ where: { id: listingId } });
    if (!listing) return { success: false, error: 'Listing not found' };

    const items = listing.items as Array<{ item: string; qty?: number }>;
    if (!items || items.length === 0) return { success: false, error: 'No items in listing' };

    try {
      // Step 1: Find product images for each item
      this.logger.log(`[${listingId}] Step 1: Finding product images...`);
      const allSourcePaths: string[] = [];

      for (const entry of items) {
        const paths = await this.imageFinderService.findProductImages(listingId, entry.item);
        allSourcePaths.push(...paths);
      }

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
      this.logger.log(`[${listingId}] Found ${allSourcePaths.length} source images`);

      // Step 2: Remove backgrounds
      this.logger.log(`[${listingId}] Step 2: Removing backgrounds...`);
      const transparentPaths: string[] = [];

      for (const sourcePath of allSourcePaths) {
        const transparent = await this.backgroundRemoverService.removeBackground(listingId, sourcePath);
        if (transparent) transparentPaths.push(transparent);
      }

      if (transparentPaths.length === 0) {
        return { success: false, error: 'Background removal failed for all images' };
      }

      await this.prisma.marketing_listing.update({
        where: { id: listingId },
        data: { image_status: 'bg_removed' },
      });
      this.logger.log(`[${listingId}] ${transparentPaths.length} transparent images ready`);

      // Step 3: Compose final listing image
      this.logger.log(`[${listingId}] Step 3: Composing listing image...`);
      const account = (listing.account || 'dbcinema') as 'dbcinema' | 'leo';
      const title = listing.title || 'Untitled Listing';

      const composedPath = await this.imageComposerService.composeListingImage(
        listingId,
        account,
        title,
        transparentPaths,
      );

      if (!composedPath) {
        return { success: false, error: 'Image composition failed' };
      }

      // Step 4: Update listing with final image
      await this.prisma.marketing_listing.update({
        where: { id: listingId },
        data: {
          image_status: 'ready',
          composed_image: composedPath,
        },
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
}
