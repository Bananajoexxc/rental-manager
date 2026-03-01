import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { RevenueService } from '../revenue/revenue.service';
import { LostRevenueService } from '../lost-revenue/lost-revenue.service';
import { MASTER_INVENTORY, ACCESSORY_ITEMS, isAccessoryItem, findBestMatch } from '../utils/item-matcher';
import { getOneDayPrice, PRICING_CATALOG } from '../data/pricing-catalog';
import { getOwnedItemCost } from '../data/acquisition-costs';
import { BUNDLE_DEFINITIONS } from '../data/bundle-suggestions';

export interface SellRecommendation {
  item: string;
  category: string;
  qtyOwned: number;
  lifetimeRevenue: number;
  last6mRevenue: number;
  last3mRevenue: number;
  rentalsPerMonth: number;
  rentedDaysPerMonth: number;
  daysSinceLastRental: number | null;
  ebayResalePrice: number | null;
  ebaySampleCount: number;
  ebayLastScraped: string | null;
  revenueVsResale: number | null;
  monthlyRevenuePerUnit: number;
  sellScore: number;
  sellVerdict: 'sell' | 'consider' | 'keep';
  sellReason: string;
  // Bundle synergy fields
  bundleRate: number;
  bundleRevenue: number;
  topPartners: { item: string; count: number }[];
  bundleDependencyScore: number;
  bundleSynergyScore: number;
  bundlePenalty: number;
  // Purchase cost fields
  purchaseCost: number | null;
  purchaseCostROI: number | null;
}

export interface SellResponse {
  recommendations: SellRecommendation[];
  summary: {
    totalItems: number;
    sellCount: number;
    considerCount: number;
    keepCount: number;
    totalPotentialResaleValue: number;
    bundleProtectedCount: number;
  };
  ebayDataAge: string | null;
}

@Injectable()
export class SellRecommenderService {
  private readonly logger = new Logger(SellRecommenderService.name);

  private static readonly USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueService: RevenueService,
    private readonly lostRevenueService: LostRevenueService,
  ) {}

  // ────────────── eBay Search Query Builder ──────────────

  /**
   * Build an optimised eBay search query from an inventory item name.
   * Strips set markers, adds category context for ambiguous names.
   */
  private buildEbaySearchQuery(itemName: string): string {
    let q = itemName;

    // Strip quantity/set markers
    q = q.replace(/^\d+x\s*/i, '');
    q = q.replace(/\b\d+x\s+sets?\b/gi, '');
    q = q.replace(/\bsets?\b/gi, '').trim();

    // Get category from pricing catalog for context
    const entry = PRICING_CATALOG.find(
      p => p.item_name.toLowerCase() === itemName.toLowerCase() && !p.is_bundle,
    );
    const category = entry?.category || '';

    // Add category suffixes for ambiguous items
    if (category === 'lens' && !q.toLowerCase().includes('lens')) {
      q += ' lens';
    }
    if (category === 'camera' && !q.toLowerCase().includes('camera') && !q.toLowerCase().includes('fx3') && !q.toLowerCase().includes('gopro')) {
      q += ' camera';
    }
    if (category === 'light' && !q.toLowerCase().includes('light')) {
      q += ' light';
    }
    if (category === 'gimbal' && !q.toLowerCase().includes('gimbal')) {
      q += ' gimbal';
    }

    // Clean up double spaces
    q = q.replace(/\s+/g, ' ').trim();

    return q;
  }

  // ────────────── eBay Scraping ──────────────

  /**
   * Scrape eBay UK sold listings for a single item.
   * NOTE: eBay blocks datacenter IPs — use manual import if automated scrape fails.
   */
  private async scrapeEbayPrices(searchQuery: string): Promise<number[]> {
    const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchQuery)}&LH_Complete=1&LH_Sold=1&_sop=13&LH_PrefLoc=1`;

    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': SellRecommenderService.USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
        maxRedirects: 10,
        timeout: 15000,
      });

      const html: string = response.data;
      if (html.includes('Pardon our interruption')) return [];

      const prices: number[] = [];
      const bundlePattern = /\b(bundle|lot|joblot|job lot|set of \d|sets of|bulk|wholesale|parts|spares|faulty|broken|for parts)\b/i;

      const itemBlocks = html.split(/class="s-item\b/);
      for (const block of itemBlocks.slice(1)) {
        const titleMatch = block.match(/class="s-item__title"[^>]*>(?:<span[^>]*>)?([^<]+)/);
        const title = titleMatch ? titleMatch[1] : '';
        if (bundlePattern.test(title)) continue;

        const priceMatch = block.match(/£([\d,]+\.?\d*)/);
        if (priceMatch) {
          const price = parseFloat(priceMatch[1].replace(/,/g, ''));
          if (price > 5 && price < 50000) {
            prices.push(price);
          }
        }
      }

      return prices;
    } catch (err) {
      this.logger.warn(`eBay scrape failed for "${searchQuery}": ${err.message}`);
      return [];
    }
  }

  /**
   * Scrape and cache eBay sold prices for all inventory items.
   * Skips items scraped within the last 24 hours.
   * Rate-limited: 2.5s between requests.
   */
  async scrapeAllEbayPrices(): Promise<{
    scraped: number;
    skipped: number;
    failed: number;
    results: { item: string; query: string; prices: number; median: number | null }[];
  }> {
    const inventoryItems = Object.keys(MASTER_INVENTORY).filter(item => !isAccessoryItem(item));
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    let scraped = 0;
    let skipped = 0;
    let failed = 0;
    const results: { item: string; query: string; prices: number; median: number | null }[] = [];

    for (const item of inventoryItems) {
      // Check if recently scraped
      const cached = await this.prisma.ebay_price_cache.findUnique({
        where: { item_name: item },
      });
      if (cached && cached.scraped_at > oneDayAgo) {
        skipped++;
        results.push({ item, query: cached.search_query, prices: cached.sample_count, median: cached.median_price });
        continue;
      }

      const query = this.buildEbaySearchQuery(item);
      const prices = await this.scrapeEbayPrices(query);

      if (prices.length === 0) {
        failed++;
        results.push({ item, query, prices: 0, median: null });
      } else {
        // Calculate stats
        const sorted = [...prices].sort((a, b) => a - b);
        const median = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];
        const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
        const min = sorted[0];
        const max = sorted[sorted.length - 1];

        // Upsert into cache
        await this.prisma.ebay_price_cache.upsert({
          where: { item_name: item },
          create: {
            item_name: item,
            search_query: query,
            sold_prices: prices,
            median_price: Math.round(median * 100) / 100,
            avg_price: Math.round(avg * 100) / 100,
            min_price: Math.round(min * 100) / 100,
            max_price: Math.round(max * 100) / 100,
            sample_count: prices.length,
          },
          update: {
            search_query: query,
            sold_prices: prices,
            median_price: Math.round(median * 100) / 100,
            avg_price: Math.round(avg * 100) / 100,
            min_price: Math.round(min * 100) / 100,
            max_price: Math.round(max * 100) / 100,
            sample_count: prices.length,
            scraped_at: new Date(),
          },
        });

        scraped++;
        results.push({ item, query, prices: prices.length, median: Math.round(median * 100) / 100 });
      }

      // Rate limit: 2.5s between requests
      await new Promise(r => setTimeout(r, 2500));
    }

    this.logger.log(`eBay scrape: ${scraped} scraped, ${skipped} cached, ${failed} failed`);
    return { scraped, skipped, failed, results };
  }

  /**
   * Quarterly cron (1st of Jan/Apr/Jul/Oct at 8 AM) — refresh eBay sold prices.
   * Moved from 5am to avoid quiet hours (2-7 AM).
   */
  @Cron('0 8 1 1,4,7,10 *')
  async quarterlyEbayScrape(): Promise<void> {
    this.logger.log('=== Quarterly eBay price scrape starting ===');
    try {
      await this.scrapeAllEbayPrices();
    } catch (err) {
      this.logger.error(`Daily eBay scrape failed: ${err.message}`);
    }
  }

  // ────────────── Last Rented Dates ──────────────

  private static readonly MAX_IDLE_WINDOW = 730; // 2 years max idle window

  /**
   * Get the last AND first rental dates for each item.
   * Checks BOTH the booking table AND rental.parsed_items to catch items
   * that are rented as part of bundle/set listings (e.g., lenses in the GM Triple Set).
   * Only considers activity within the last 2 years.
   */
  private async getRentalDateRanges(): Promise<Map<string, { daysSinceLastRental: number; daysSinceFirstRental: number } | null>> {
    const twoYearsAgo = new Date(Date.now() - SellRecommenderService.MAX_IDLE_WINDOW * 86400000);
    const now = new Date();
    const map = new Map<string, { daysSinceLastRental: number; daysSinceFirstRental: number } | null>();

    // Source 1: booking table (individual bookings)
    const bookingResults = await this.prisma.booking.groupBy({
      by: ['item_name'],
      where: {
        status: { in: ['confirmed', 'completed'] },
        start_date: { gte: twoYearsAgo },
      },
      _max: { end_date: true },
      _min: { start_date: true },
    });

    for (const r of bookingResults) {
      if (r._max.end_date) {
        const daysSinceLast = Math.max(0, Math.round((now.getTime() - r._max.end_date.getTime()) / 86400000));
        const daysSinceFirst = r._min.start_date
          ? Math.max(0, Math.round((now.getTime() - r._min.start_date.getTime()) / 86400000))
          : daysSinceLast;
        map.set(r.item_name, { daysSinceLastRental: daysSinceLast, daysSinceFirstRental: daysSinceFirst });
      }
    }

    // Source 2: rental.parsed_items — catches items rented in bundle/set listings
    // that may not have individual bookings created
    const rentals = await this.prisma.rental.findMany({
      where: {
        parsed_items: { not: { equals: null as any } },
        start_date: { gte: twoYearsAgo },
        status: { in: ['completed', 'ongoing', 'upcoming'] },
      },
      select: {
        parsed_items: true,
        start_date: true,
        end_date: true,
      },
    });

    for (const r of rentals) {
      const parsedItems = r.parsed_items as { item: string; qty: number }[] | null;
      if (!parsedItems || !r.start_date) continue;

      for (const p of parsedItems) {
        const itemName = p.item;
        // Only merge if this is a real inventory item
        if (MASTER_INVENTORY[itemName] === undefined) continue;

        const endDate = r.end_date || r.start_date;
        const daysSinceLast = Math.max(0, Math.round((now.getTime() - endDate.getTime()) / 86400000));
        const daysSinceFirst = Math.max(0, Math.round((now.getTime() - r.start_date.getTime()) / 86400000));

        const existing = map.get(itemName);
        if (existing) {
          // Merge: take the more recent last rental and oldest first rental
          existing.daysSinceLastRental = Math.min(existing.daysSinceLastRental, daysSinceLast);
          existing.daysSinceFirstRental = Math.max(existing.daysSinceFirstRental, daysSinceFirst);
        } else {
          map.set(itemName, { daysSinceLastRental: daysSinceLast, daysSinceFirstRental: daysSinceFirst });
        }
      }
    }

    return map;
  }

  // ────────────── Bundle Synergy Analysis ──────────────

  /**
   * Analyze bundle co-rental patterns for all items.
   * Checks BOTH the booking table AND rental.parsed_items to catch items
   * rented in set/bundle listings that may lack individual bookings.
   * Returns per-item bundle metrics: rate, revenue, top partners, dependency score.
   */
  private async getBundleAnalysis(): Promise<Map<string, {
    bundleRate: number;
    bundleRevenue: number;
    topPartners: { item: string; count: number }[];
    bundleDependencyScore: number;
  }>> {
    // Per-item accumulators
    const itemTotalRentals = new Map<string, number>();
    const itemBundleRentals = new Map<string, number>();
    const itemBundleRevenue = new Map<string, number>();
    const itemPartners = new Map<string, Map<string, number>>();

    const processGroup = (items: string[], revenue: number) => {
      const isMultiItem = items.length > 1;
      // De-dup items within same group for counting (avoid double-counting same item)
      const unique = [...new Set(items)];
      for (const item of unique) {
        itemTotalRentals.set(item, (itemTotalRentals.get(item) || 0) + 1);
        if (isMultiItem) {
          itemBundleRentals.set(item, (itemBundleRentals.get(item) || 0) + 1);
          itemBundleRevenue.set(item, (itemBundleRevenue.get(item) || 0) + revenue);
          if (!itemPartners.has(item)) itemPartners.set(item, new Map());
          const partners = itemPartners.get(item)!;
          for (const other of unique) {
            if (other !== item) {
              partners.set(other, (partners.get(other) || 0) + 1);
            }
          }
        }
      }
    };

    // Source 1: booking table (grouped by rental_id)
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ['confirmed', 'completed'] },
        rental_id: { not: null },
      },
      select: { item_name: true, rental_id: true, revenue: true },
    });

    const bookingGroups = new Map<string, { items: string[]; revenue: number }>();
    for (const b of bookings) {
      if (!b.rental_id) continue;
      const group = bookingGroups.get(b.rental_id);
      if (group) {
        group.items.push(b.item_name);
        group.revenue += (b.revenue || 0);
      } else {
        bookingGroups.set(b.rental_id, { items: [b.item_name], revenue: b.revenue || 0 });
      }
    }
    // Track which rental_ids we've already processed (avoid double-counting)
    const processedRentalIds = new Set<string>();
    for (const [rentalId, group] of bookingGroups) {
      processGroup(group.items, group.revenue);
      processedRentalIds.add(rentalId);
    }

    // Source 2: rental.parsed_items — catches items in set listings without individual bookings
    const rentals = await this.prisma.rental.findMany({
      where: {
        parsed_items: { not: { equals: null as any } },
        status: { in: ['completed', 'ongoing', 'upcoming'] },
      },
      select: { id: true, parsed_items: true, rental_price: true },
    });

    for (const r of rentals) {
      if (processedRentalIds.has(r.id)) continue; // Already counted from bookings
      const parsedItems = r.parsed_items as { item: string; qty: number }[] | null;
      if (!parsedItems) continue;

      // Expand items by quantity
      const expandedItems: string[] = [];
      for (const p of parsedItems) {
        // Only include real inventory items
        if (MASTER_INVENTORY[p.item] !== undefined) {
          for (let i = 0; i < (p.qty || 1); i++) {
            expandedItems.push(p.item);
          }
        }
      }
      if (expandedItems.length > 0) {
        processGroup(expandedItems, r.rental_price || 0);
      }
    }

    // Build result map
    const result = new Map<string, {
      bundleRate: number;
      bundleRevenue: number;
      topPartners: { item: string; count: number }[];
      bundleDependencyScore: number;
    }>();

    for (const [item] of Object.entries(MASTER_INVENTORY)) {
      const total = itemTotalRentals.get(item) || 0;
      const bundled = itemBundleRentals.get(item) || 0;
      const bundleRate = total > 0 ? Math.round((bundled / total) * 100) : 0;
      const bundleRevenue = Math.round((itemBundleRevenue.get(item) || 0) * 100) / 100;

      // Top 3 partners by frequency
      const partners = itemPartners.get(item) || new Map<string, number>();
      const topPartners = [...partners.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([partnerItem, count]) => ({ item: partnerItem, count }));

      // Bundle dependency score: for each top partner, what % of THEIR rentals include this item?
      let dependencySum = 0;
      let dependencyCount = 0;
      for (const partner of topPartners) {
        const partnerTotal = itemTotalRentals.get(partner.item) || 0;
        if (partnerTotal > 0) {
          dependencySum += partner.count / partnerTotal;
          dependencyCount++;
        }
      }
      const bundleDependencyScore = dependencyCount > 0
        ? Math.min(100, Math.round((dependencySum / dependencyCount) * 100))
        : 0;

      result.set(item, { bundleRate, bundleRevenue, topPartners, bundleDependencyScore });
    }

    return result;
  }

  // ────────────── Sell Score Algorithm ──────────────

  /**
   * Calculate sell score (0-100). Higher = stronger sell signal.
   *
   * | Signal              | Weight | 0 (keep)            | 100 (sell)          |
   * |---------------------|--------|---------------------|---------------------|
   * | Idle time           | 30%    | 0 days idle         | 180+ days idle      |
   * | Utilization         | 25%    | 100% utilized       | 0% utilized         |
   * | Revenue trend       | 20%    | Growing (3m > prev) | Declining >50%      |
   * | ROI (earned/resale) | 15%    | Earned < resale     | Earned >> resale     |
   * | Daily rental value  | 10%    | High (£25+/day)     | Low (<£8/day)       |
   */
  private calculateSellScore(params: {
    daysSinceLastRental: number | null;
    daysSinceFirstRental: number | null;
    utilization: number;
    last3mRevenue: number;
    last6mRevenue: number;
    lifetimeRevenue: number;
    ebayResalePrice: number | null;
    dailyPrice: number | null;
    isAccessory: boolean;
    qtyOwned: number;
    purchaseCost: number | null;
  }): { score: number; verdict: 'sell' | 'consider' | 'keep'; reason: string } {
    // Accessories always keep
    if (params.isAccessory) {
      return { score: 0, verdict: 'keep', reason: 'Accessory — bundled with main equipment.' };
    }

    // 1. Idle time (30%) — 0 days = 0, 180+ days = 100
    // Capped by how long we've owned the item (daysSinceFirstRental), max 2 years
    const maxIdle = params.daysSinceFirstRental != null
      ? Math.min(params.daysSinceFirstRental, SellRecommenderService.MAX_IDLE_WINDOW)
      : 180; // unknown ownership → moderate default
    const rawIdle = params.daysSinceLastRental ?? maxIdle;
    const idleDays = Math.min(rawIdle, maxIdle);
    const idleScore = Math.min(idleDays / 180, 1) * 100;

    // 2. Utilization (25%) — 100% = 0, 0% = 100
    const utilScore = (1 - params.utilization / 100) * 100;

    // 3. Revenue trend (20%) — compare last 3m to the 3m before that
    const prev3mRevenue = params.last6mRevenue - params.last3mRevenue;
    let trendScore = 50; // neutral default
    if (prev3mRevenue > 0 && params.last3mRevenue > 0) {
      const change = (params.last3mRevenue - prev3mRevenue) / prev3mRevenue;
      if (change > 0) {
        // Growing — score 0 (keep)
        trendScore = Math.max(0, 50 - change * 100);
      } else {
        // Declining — score up to 100 (sell)
        trendScore = Math.min(100, 50 + Math.abs(change) * 100);
      }
    } else if (params.last3mRevenue === 0 && prev3mRevenue > 0) {
      // Went from earning to nothing = strong sell signal
      trendScore = 95;
    } else if (params.last3mRevenue === 0 && prev3mRevenue === 0) {
      // Never earned = sell signal
      trendScore = 80;
    }

    // 4. ROI — earned vs resale (15%)
    // High ratio (earned >> resale) = great earner = KEEP. Low ratio = poor performer = sell.
    let roiScore = 50; // neutral when no eBay data
    if (params.ebayResalePrice && params.ebayResalePrice > 0) {
      const ratio = params.lifetimeRevenue / params.ebayResalePrice;
      if (ratio > 3) roiScore = 5;       // incredible earner (3x+ resale) — strong keep
      else if (ratio > 2) roiScore = 10;  // great earner — keep
      else if (ratio > 1) roiScore = 20;  // solid earner — keep
      else if (ratio > 0.5) roiScore = 45; // moderate — neutral
      else if (ratio > 0.2) roiScore = 65; // underperforming — lean sell
      else roiScore = 80; // barely earned anything — sell signal
    }

    // Purchase cost ROI: high ROI = keep, low ROI + old = sell
    if (params.purchaseCost && params.purchaseCost > 0) {
      const daysOwned = params.daysSinceFirstRental ?? 180;
      const purchaseRecovery = params.lifetimeRevenue / params.purchaseCost;
      if (purchaseRecovery >= 2) {
        // 200%+ ROI — item is paying for itself well, strong keep signal
        roiScore = Math.min(roiScore, 5);
      } else if (purchaseRecovery >= 1) {
        // Paid for itself — keep
        roiScore = Math.min(roiScore, 15);
      } else if (daysOwned >= 180) {
        // Owned 6+ months with poor recovery
        if (purchaseRecovery < 0.33) roiScore = Math.max(roiScore, 80); // <33% recovered → sell
        else if (purchaseRecovery < 0.5) roiScore = Math.max(roiScore, 65); // <50% → lean sell
      }
    }

    // 5. Daily rental value (10%) — £25+ = 0, <£8 = 100
    const dailyPrice = params.dailyPrice || 0;
    let dailyValueScore = 50;
    if (dailyPrice >= 25) dailyValueScore = 0;
    else if (dailyPrice >= 15) dailyValueScore = 25;
    else if (dailyPrice >= 8) dailyValueScore = 60;
    else dailyValueScore = 100;

    // Weighted total
    const score = Math.round(
      idleScore * 0.30 +
      utilScore * 0.25 +
      trendScore * 0.20 +
      roiScore * 0.15 +
      dailyValueScore * 0.10,
    );

    // Verdict
    let verdict: 'sell' | 'consider' | 'keep';
    if (score >= 70) verdict = 'sell';
    else if (score >= 45) verdict = 'consider';
    else verdict = 'keep';

    // Build reason
    const reasons: string[] = [];
    if (idleDays > 90) reasons.push(`idle ${idleDays} days`);
    if (params.utilization < 10) reasons.push(`${params.utilization}% utilization`);
    if (trendScore > 70) reasons.push('revenue declining');
    if (params.last3mRevenue === 0 && params.last6mRevenue === 0) reasons.push('no revenue in 6 months');
    if (params.ebayResalePrice && params.ebayResalePrice > 0) {
      const ratio = params.lifetimeRevenue / params.ebayResalePrice;
      if (ratio > 2) reasons.push(`strong earner: ${ratio.toFixed(1)}x resale value`);
      else if (roiScore > 60) reasons.push(`underperforming: earned ${ratio.toFixed(1)}x resale`);
    }
    if (params.purchaseCost && params.purchaseCost > 0) {
      const recovery = Math.round((params.lifetimeRevenue / params.purchaseCost) * 100);
      if (recovery >= 200) reasons.push(`${recovery}% ROI on £${params.purchaseCost} cost`);
      else if (recovery < 50) reasons.push(`only ${recovery}% of £${params.purchaseCost} cost recovered`);
    }
    if (dailyValueScore > 70) reasons.push(`low daily value (£${dailyPrice}/day)`);
    if (params.ebayResalePrice) reasons.push(`eBay ~£${Math.round(params.ebayResalePrice)}`);

    let reason = reasons.length > 0 ? reasons.join(', ') : 'No strong sell signals.';

    // Multi-quantity hint
    if (verdict === 'sell' && params.qtyOwned > 1) {
      reason = `Consider reducing from ${params.qtyOwned} to ${params.qtyOwned - 1} units. ${reason}`;
    }

    return { score, verdict, reason };
  }

  // ────────────── Main Recommendations ──────────────

  /**
   * Generate sell recommendations for all inventory items.
   * Combines rental performance with eBay resale prices.
   */
  async getSellRecommendations(account?: string): Promise<SellResponse> {
    // 1. Get revenue data + bundle analysis in parallel
    const [allTimeData, sixMonthData, threeMonthData, bundleMap] = await Promise.all([
      this.revenueService.getItemRevenueBreakdown('all', account),
      this.revenueService.getItemRevenueBreakdown('6m', account),
      this.revenueService.getItemRevenueBreakdown('3m', account),
      this.getBundleAnalysis(),
    ]);

    // Build item revenue maps
    const lifetimeMap = new Map<string, { revenue: number; count: number }>();
    for (const item of allTimeData.items) {
      lifetimeMap.set(item.item, { revenue: item.totalRevenue, count: item.totalCount });
    }

    const sixMonthMap = new Map<string, { revenue: number; count: number }>();
    for (const item of sixMonthData.items) {
      sixMonthMap.set(item.item, { revenue: item.totalRevenue, count: item.totalCount });
    }

    const threeMonthMap = new Map<string, { revenue: number; count: number }>();
    for (const item of threeMonthData.items) {
      threeMonthMap.set(item.item, { revenue: item.totalRevenue, count: item.totalCount });
    }

    // 2. Get utilization data
    let potentialData: any[] = [];
    try {
      potentialData = await this.lostRevenueService.getRevenuePotential('6m', account);
    } catch { /* ok — may not have lost revenue data */ }
    const potentialMap = new Map<string, { utilization: number; rentalsPerMonth: number; rentedDaysPerMonth: number }>();
    for (const item of potentialData) {
      potentialMap.set(item.item, {
        utilization: item.utilization || 0,
        rentalsPerMonth: item.rentalsPerMonth || 0,
        rentedDaysPerMonth: item.rentedDaysPerMonth || 0,
      });
    }

    // 3. Get rental date ranges (first + last, within 2 year window)
    const rentalDateMap = await this.getRentalDateRanges();

    // 4. Get eBay price cache
    const ebayCache = await this.prisma.ebay_price_cache.findMany();
    const ebayMap = new Map<string, { median: number | null; count: number; scrapedAt: Date }>();
    for (const e of ebayCache) {
      ebayMap.set(e.item_name, {
        median: e.median_price,
        count: e.sample_count,
        scrapedAt: e.scraped_at,
      });
    }

    // 5. Build recommendations
    const recommendations: SellRecommendation[] = [];
    let oldestScrape: Date | null = null;

    for (const [itemName, qty] of Object.entries(MASTER_INVENTORY)) {
      // Skip accessories entirely — they're bundled with main equipment
      if (isAccessoryItem(itemName)) continue;

      // Get category from pricing catalog
      const pricingEntry = PRICING_CATALOG.find(
        p => p.item_name.toLowerCase() === itemName.toLowerCase() && !p.is_bundle,
      );
      const category = pricingEntry?.category || 'other';
      const dailyPrice = getOneDayPrice(itemName);

      // Revenue data
      const lifetime = lifetimeMap.get(itemName) || { revenue: 0, count: 0 };
      const sixMonth = sixMonthMap.get(itemName) || { revenue: 0, count: 0 };
      const threeMonth = threeMonthMap.get(itemName) || { revenue: 0, count: 0 };

      // Utilization
      const potential = potentialMap.get(itemName) || { utilization: 0, rentalsPerMonth: 0, rentedDaysPerMonth: 0 };

      // Last rented (within 2-year window)
      const rentalDates = rentalDateMap.get(itemName);
      const daysSinceLastRental = rentalDates?.daysSinceLastRental ?? null;
      const daysSinceFirstRental = rentalDates?.daysSinceFirstRental ?? null;

      // eBay price
      const ebay = ebayMap.get(itemName);
      const ebayResalePrice = ebay?.median ?? null;
      const ebaySampleCount = ebay?.count ?? 0;
      const ebayLastScraped = ebay?.scrapedAt?.toISOString() ?? null;

      if (ebay?.scrapedAt) {
        if (!oldestScrape || ebay.scrapedAt < oldestScrape) {
          oldestScrape = ebay.scrapedAt;
        }
      }

      // Revenue vs resale ratio
      const revenueVsResale = ebayResalePrice && ebayResalePrice > 0
        ? Math.round((lifetime.revenue / ebayResalePrice) * 100) / 100
        : null;

      // Monthly revenue per unit
      const monthlyRevenuePerUnit = qty > 0
        ? Math.round((sixMonth.revenue / qty / 6) * 100) / 100
        : 0;

      // Purchase cost
      const purchaseCost = getOwnedItemCost(itemName);
      const purchaseCostROI = purchaseCost && purchaseCost > 0
        ? Math.round((lifetime.revenue / purchaseCost) * 100) / 100
        : null;

      // Calculate sell score
      const { score: rawScore, verdict: rawVerdict, reason } = this.calculateSellScore({
        daysSinceLastRental,
        daysSinceFirstRental,
        utilization: potential.utilization,
        last3mRevenue: threeMonth.revenue,
        last6mRevenue: sixMonth.revenue,
        lifetimeRevenue: lifetime.revenue,
        ebayResalePrice,
        dailyPrice,
        isAccessory: false, // accessories are pre-filtered above
        qtyOwned: qty,
        purchaseCost,
      });

      // Bundle synergy — post-processing penalty
      const bundle = bundleMap.get(itemName) || { bundleRate: 0, bundleRevenue: 0, topPartners: [], bundleDependencyScore: 0 };

      // Check if this item is part of any REAL listed bundle (from BUNDLE_DEFINITIONS)
      const listedBundles = BUNDLE_DEFINITIONS.filter(b => b.items.includes(itemName));
      const inListedBundle = listedBundles.length > 0;
      const listedBundleNames = listedBundles.map(b => b.bundle_name);

      // Base synergy from co-rental patterns
      const bundleSynergyScore = Math.min(100, Math.round(bundle.bundleRate * 0.4 + bundle.bundleDependencyScore * 0.6));

      // Stronger penalty for items in REAL listed bundles (up to -35 pts)
      // vs generic co-rental synergy (up to -20 pts)
      let bundlePenalty: number;
      if (inListedBundle) {
        // Listed bundle items get heavy protection: base synergy + listed bundle bonus
        bundlePenalty = Math.min(35, Math.round(bundleSynergyScore * 0.20) + 15);
      } else {
        bundlePenalty = Math.round(bundleSynergyScore * 0.20); // max -20 points
      }
      let score = Math.max(0, rawScore - bundlePenalty);

      // Hard ROI cap: items with 200%+ purchase cost ROI are returning good money.
      // They should never be recommended to sell or even flagged as "consider".
      if (purchaseCostROI !== null && purchaseCostROI >= 2.0) {
        score = Math.min(score, 40); // Forces "keep" (below 45 threshold)
      }

      // Re-evaluate verdict after bundle penalty + ROI cap
      let verdict: 'sell' | 'consider' | 'keep';
      if (score >= 70) verdict = 'sell';
      else if (score >= 45) verdict = 'consider';
      else verdict = 'keep';

      // Augment reason with bundle context
      let finalReason = reason;
      if (inListedBundle) {
        const bundleList = listedBundleNames.length <= 2
          ? listedBundleNames.join(', ')
          : listedBundleNames.slice(0, 2).join(', ') + ` +${listedBundleNames.length - 2} more`;
        finalReason += ` · Listed bundle (-${bundlePenalty}pts): ${bundleList}`;
      } else if (bundlePenalty > 0) {
        const partnerNames = bundle.topPartners.slice(0, 2).map(p => p.item).join(', ');
        finalReason += ` · Bundle-protected (-${bundlePenalty}pts): ${bundle.bundleRate}% bundled with ${partnerNames}`;
      }
      if (purchaseCost && purchaseCostROI !== null && purchaseCostROI < 1) {
        finalReason += ` · ${Math.round(purchaseCostROI * 100)}% of £${purchaseCost} cost recovered`;
      }

      recommendations.push({
        item: itemName,
        category,
        qtyOwned: qty,
        lifetimeRevenue: Math.round(lifetime.revenue * 100) / 100,
        last6mRevenue: Math.round(sixMonth.revenue * 100) / 100,
        last3mRevenue: Math.round(threeMonth.revenue * 100) / 100,
        rentalsPerMonth: potential.rentalsPerMonth,
        rentedDaysPerMonth: potential.rentedDaysPerMonth,
        daysSinceLastRental,
        ebayResalePrice,
        ebaySampleCount,
        ebayLastScraped,
        revenueVsResale,
        monthlyRevenuePerUnit,
        sellScore: score,
        sellVerdict: verdict,
        sellReason: finalReason,
        // Bundle synergy
        bundleRate: bundle.bundleRate,
        bundleRevenue: bundle.bundleRevenue,
        topPartners: bundle.topPartners,
        bundleDependencyScore: bundle.bundleDependencyScore,
        bundleSynergyScore,
        bundlePenalty,
        // Purchase cost
        purchaseCost: purchaseCost ?? null,
        purchaseCostROI,
      });
    }

    // Sort by sell score descending (strongest sell signals first)
    recommendations.sort((a, b) => b.sellScore - a.sellScore);

    // Summary
    const sellItems = recommendations.filter(r => r.sellVerdict === 'sell');
    const considerItems = recommendations.filter(r => r.sellVerdict === 'consider');
    const keepItems = recommendations.filter(r => r.sellVerdict === 'keep');

    const totalPotentialResaleValue = sellItems.reduce(
      (sum, r) => sum + (r.ebayResalePrice || 0), 0,
    );
    const bundleProtectedCount = recommendations.filter(r => r.bundlePenalty > 0).length;

    // eBay data age
    let ebayDataAge: string | null = null;
    if (oldestScrape) {
      const hoursAgo = Math.round((Date.now() - oldestScrape.getTime()) / 3600000);
      ebayDataAge = hoursAgo < 24
        ? `${hoursAgo}h ago`
        : `${Math.round(hoursAgo / 24)}d ago`;
    }

    return {
      recommendations,
      summary: {
        totalItems: recommendations.length,
        sellCount: sellItems.length,
        considerCount: considerItems.length,
        keepCount: keepItems.length,
        totalPotentialResaleValue: Math.round(totalPotentialResaleValue * 100) / 100,
        bundleProtectedCount,
      },
      ebayDataAge,
    };
  }

  // ────────────── Manual Price Import ──────────────

  /**
   * Import eBay prices manually. Accepts a map of item_name → price.
   * Use this when automated scraping is blocked (eBay blocks datacenter IPs).
   */
  async importEbayPrices(prices: Record<string, number>): Promise<{
    imported: number;
    skipped: string[];
  }> {
    const inventoryItems = new Set(Object.keys(MASTER_INVENTORY));
    let imported = 0;
    const skipped: string[] = [];

    for (const [item, price] of Object.entries(prices)) {
      if (!inventoryItems.has(item) || isAccessoryItem(item)) {
        skipped.push(item);
        continue;
      }
      if (typeof price !== 'number' || price <= 0) {
        skipped.push(item);
        continue;
      }

      await this.prisma.ebay_price_cache.upsert({
        where: { item_name: item },
        create: {
          item_name: item,
          search_query: 'manual import',
          sold_prices: [price],
          median_price: price,
          avg_price: price,
          min_price: price,
          max_price: price,
          sample_count: 1,
        },
        update: {
          median_price: price,
          avg_price: price,
          min_price: price,
          max_price: price,
          sample_count: 1,
          sold_prices: [price],
          scraped_at: new Date(),
        },
      });
      imported++;
    }

    this.logger.log(`Manual eBay import: ${imported} imported, ${skipped.length} skipped`);
    return { imported, skipped };
  }

  // ────────────── Inventory Valuation ──────────────

  /**
   * Get total inventory valuation using conservative eBay sold prices.
   * Conservative = 25th percentile of sold prices (or min if few samples).
   * Multiplied by quantity owned.
   */
  async getInventoryValuation(): Promise<{
    totalResaleValue: number;
    totalPurchaseCost: number;
    gainLoss: number;
    gainLossPercent: number;
    itemCount: number;
    pricedCount: number;
    unpricedItems: string[];
    lastScraped: string | null;
    items: {
      name: string;
      qty: number;
      purchasePrice: number | null;
      resalePrice: number | null;
      totalResale: number;
      totalCost: number;
      sampleCount: number;
    }[];
  }> {
    const cache = await this.prisma.ebay_price_cache.findMany();
    const cacheMap = new Map(cache.map(c => [c.item_name, c]));

    const items: {
      name: string;
      qty: number;
      purchasePrice: number | null;
      resalePrice: number | null;
      totalResale: number;
      totalCost: number;
      sampleCount: number;
    }[] = [];

    let totalResale = 0;
    let totalCost = 0;
    let pricedCount = 0;
    const unpricedItems: string[] = [];
    let oldestScrape: Date | null = null;

    for (const [itemName, qty] of Object.entries(MASTER_INVENTORY)) {
      const cached = cacheMap.get(itemName);
      const purchasePrice = getOwnedItemCost(itemName);

      // Conservative price: 25th percentile from sold_prices array
      let resalePrice: number | null = null;
      let sampleCount = 0;

      if (cached) {
        sampleCount = cached.sample_count;
        const soldPrices = cached.sold_prices as number[] | null;

        if (soldPrices && soldPrices.length >= 4) {
          // 25th percentile
          const sorted = [...soldPrices].sort((a, b) => a - b);
          const idx = Math.floor(sorted.length * 0.25);
          resalePrice = Math.round(sorted[idx]);
        } else if (cached.min_price != null) {
          // Few samples — use min as conservative
          resalePrice = cached.min_price;
        } else if (cached.median_price != null) {
          // Fallback to median (manual imports have sample_count=1)
          resalePrice = Math.round(cached.median_price * 0.85); // 15% below median for conservatism
        }

        if (cached.scraped_at) {
          if (!oldestScrape || cached.scraped_at < oldestScrape) {
            oldestScrape = cached.scraped_at;
          }
        }
      }

      if (resalePrice != null) {
        pricedCount++;
      } else {
        unpricedItems.push(itemName);
      }

      const itemTotalResale = (resalePrice || 0) * qty;
      const itemTotalCost = (purchasePrice || 0) * qty;
      totalResale += itemTotalResale;
      totalCost += itemTotalCost;

      items.push({
        name: itemName,
        qty,
        purchasePrice: purchasePrice ?? null,
        resalePrice,
        totalResale: itemTotalResale,
        totalCost: itemTotalCost,
        sampleCount,
      });
    }

    // Sort by total resale value descending
    items.sort((a, b) => b.totalResale - a.totalResale);

    const gainLoss = totalResale - totalCost;
    const gainLossPercent = totalCost > 0 ? Math.round((gainLoss / totalCost) * 100) : 0;

    let lastScraped: string | null = null;
    if (oldestScrape) {
      const daysAgo = Math.round((Date.now() - oldestScrape.getTime()) / 86400000);
      lastScraped = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
    }

    return {
      totalResaleValue: Math.round(totalResale),
      totalPurchaseCost: Math.round(totalCost),
      gainLoss: Math.round(gainLoss),
      gainLossPercent,
      itemCount: items.length,
      pricedCount,
      unpricedItems,
      lastScraped,
      items,
    };
  }

  /**
   * Get all current eBay cached prices for building the import template.
   */
  async getEbayPriceTemplate(): Promise<Record<string, number | null>> {
    const items = Object.keys(MASTER_INVENTORY).filter(i => !isAccessoryItem(i));
    const cache = await this.prisma.ebay_price_cache.findMany();
    const cacheMap = new Map(cache.map(c => [c.item_name, c.median_price]));

    const template: Record<string, number | null> = {};
    for (const item of items) {
      template[item] = cacheMap.get(item) ?? null;
    }
    return template;
  }
}
