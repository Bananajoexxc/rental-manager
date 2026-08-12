import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { MASTER_INVENTORY } from '../utils/item-matcher';
import { getOneDayPrice, PRICING_CATALOG } from '../data/pricing-catalog';
import { RevenueService } from '../revenue/revenue.service';
import { TelegramService } from '../telegram/telegram.service';

// ── Config ──

const HYGGLO_SEARCH_BASE = 'https://api.hygglo.com/api/v2/product-listings/search';
const HYGGLO_OWNER_TAKE = 0.64;

const HYGGLO_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Country': 'GB',
};

/** Brands tracked — derived from MASTER_INVENTORY items */
const TRACKED_BRANDS: { brand: string; searchTerms: string[] }[] = [
  { brand: 'Sony', searchTerms: ['sony camera london', 'sony lens london', 'sony fx london'] },
  { brand: 'Canon', searchTerms: ['canon camera london', 'canon lens london'] },
  { brand: 'Blackmagic', searchTerms: ['blackmagic camera london'] },
  { brand: 'Fujifilm', searchTerms: ['fujifilm camera london'] },
  { brand: 'DJI', searchTerms: ['dji drone london', 'dji gimbal london', 'dji action london'] },
  { brand: 'Panasonic', searchTerms: ['panasonic camera london', 'panasonic lumix london'] },
  { brand: 'Nanlite', searchTerms: ['nanlite light london'] },
  { brand: 'Rode', searchTerms: ['rode wireless london', 'rode mic london'] },
  { brand: 'Atomos', searchTerms: ['atomos monitor london'] },
  { brand: 'Hollyland', searchTerms: ['hollyland wireless london'] },
  { brand: 'Aputure', searchTerms: ['aputure light london'] },
  { brand: 'Tilta', searchTerms: ['tilta camera london'] },
  { brand: 'RED', searchTerms: ['red camera london', 'red komodo london'] },
  { brand: 'Nikon', searchTerms: ['nikon camera london'] },
];

interface MarketItem {
  title: string;
  brand: string;
  dailyPrice: number;
  ownerEarnings: number;
  listingCount: number; // how many listings on Hygglo for this item
  avgRating: number | null;
  recentlyListed: boolean; // listed in last 90 days
}

interface OpportunityItem extends MarketItem {
  similarItem: string | null; // closest item in our inventory
  similarItemRevenue: number; // monthly revenue of similar item
  similarItemRentals: number; // monthly rental count
  estimatedMonthlyRevenue: number;
  confidenceScore: number; // 0-100
}

@Injectable()
export class MarketReleasesService {
  private readonly logger = new Logger(MarketReleasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly revenueService: RevenueService,
    private readonly telegramService: TelegramService,
    private readonly aiService: AiService,
  ) {}

  private delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  // ── Monthly cron: 1st of each month at 10 AM ──
  @Cron('0 10 1 * *')
  async monthlyReleaseScan() {
    this.logger.log('Starting monthly market release scan...');
    try {
      const items = await this.scanMarketplace();
      this.logger.log(`Found ${items.length} items on Hygglo not in our inventory`);

      if (items.length === 0) {
        this.logger.log('No new market items found');
        return;
      }

      const opportunities = await this.analyzeOpportunities(items);
      this.logger.log(`Identified ${opportunities.length} opportunities`);

      const insights = await this.generateInsights(opportunities);
      await this.storeInsights(insights, opportunities);
      await this.notifyOwner(insights, opportunities);

      this.logger.log('Monthly release scan complete');
    } catch (error) {
      this.logger.error(`Monthly release scan failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Scan Hygglo marketplace for items by tracked brands that we DON'T stock.
   * Groups by normalized item name to avoid duplicates from listing title variations.
   */
  async scanMarketplace(): Promise<MarketItem[]> {
    const inventoryNames = Object.keys(MASTER_INVENTORY).map(n => n.toLowerCase());
    const seenItems = new Map<string, MarketItem>();

    for (const { brand, searchTerms } of TRACKED_BRANDS) {
      for (const term of searchTerms) {
        try {
          const response = await axios.get(HYGGLO_SEARCH_BASE, {
            params: { keywords: term, country: 'GB', pageSize: 50, pageIndex: 0 },
            headers: HYGGLO_HEADERS,
            timeout: 15000,
          });

          const listings: any[] = response.data?.productListings || [];

          for (const listing of listings) {
            const product = listing.product;
            if (!product) continue;

            const title = (product.name || product.title || '').trim();
            if (!title) continue;

            // Check if title contains this brand
            if (!title.toLowerCase().includes(brand.toLowerCase())) continue;

            // Check if we already stock this item
            const titleLower = title.toLowerCase();
            const isInInventory = inventoryNames.some(inv => {
              return this.tokenOverlap(titleLower, inv) >= 0.7;
            });
            if (isInInventory) continue;

            // Normalize title for grouping
            const normalized = this.normalizeItemTitle(title, brand);
            const dailyPrice = this.extractHighestDayPrice(listing, product);

            if (dailyPrice <= 0) continue;

            const existing = seenItems.get(normalized);
            if (existing) {
              existing.listingCount++;
              if (dailyPrice > existing.dailyPrice) {
                existing.dailyPrice = dailyPrice;
                existing.ownerEarnings = Math.round(dailyPrice * HYGGLO_OWNER_TAKE * 100) / 100;
              }
            } else {
              const firstListed = listing.createdAt ? new Date(listing.createdAt) : (product.createdAt ? new Date(product.createdAt) : null);
              const ninetyDaysAgo = new Date();
              ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

              seenItems.set(normalized, {
                title: normalized,
                brand,
                dailyPrice,
                ownerEarnings: Math.round(dailyPrice * HYGGLO_OWNER_TAKE * 100) / 100,
                listingCount: 1,
                avgRating: product.stats?.avgRating || product.avgRating || null,
                recentlyListed: firstListed ? firstListed > ninetyDaysAgo : false,
              });
            }
          }

          await this.delay(1500);
        } catch (error) {
          this.logger.debug(`Search failed for "${term}": ${error.message}`);
        }
      }
    }

    // Sort by listing count (most popular first), then by price
    return Array.from(seenItems.values())
      .sort((a, b) => b.listingCount - a.listingCount || b.dailyPrice - a.dailyPrice);
  }

  /**
   * Match market items to our closest existing inventory items and estimate revenue.
   */
  async analyzeOpportunities(items: MarketItem[]): Promise<OpportunityItem[]> {
    // Get our actual rental performance (6-month window)
    const topItems = await this.revenueService.getTopEarningItems('6m');
    const itemData = Array.isArray(topItems) ? topItems : (topItems as any).items || [];

    // Build lookup: item_name → { monthlyRevenue, monthlyRentals }
    const perfMap = new Map<string, { monthlyRevenue: number; monthlyRentals: number }>();
    for (const item of itemData) {
      perfMap.set(item.item.toLowerCase(), {
        monthlyRevenue: Math.round((item.profit || 0) / 6 * 100) / 100,
        monthlyRentals: Math.round((item.count || 0) / 6 * 10) / 10,
      });
    }

    const opportunities: OpportunityItem[] = [];

    for (const marketItem of items) {
      const { similarItem, score } = this.findSimilarInventoryItem(marketItem);
      const perf = similarItem ? perfMap.get(similarItem.toLowerCase()) : null;

      let estimatedMonthlyRevenue = 0;
      let similarItemRevenue = 0;
      let similarItemRentals = 0;

      if (perf && score >= 0.3) {
        similarItemRevenue = perf.monthlyRevenue;
        similarItemRentals = perf.monthlyRentals;

        // Estimate: scale similar item revenue by price ratio
        const similarDayPrice = getOneDayPrice(similarItem!) || 30;
        const priceRatio = marketItem.ownerEarnings / (similarDayPrice * HYGGLO_OWNER_TAKE);
        estimatedMonthlyRevenue = Math.round(similarItemRevenue * Math.min(priceRatio, 2.0) * 100) / 100;
      } else {
        // No close match — estimate conservatively from listing price
        // Assume 4 rentals/month at 2.5 days average
        estimatedMonthlyRevenue = Math.round(marketItem.ownerEarnings * 2.5 * 4 * 100) / 100;
      }

      // Confidence: higher if more listings (demand signal), has similar item, reasonable price
      let confidence = 0;
      if (marketItem.listingCount >= 3) confidence += 30;
      else if (marketItem.listingCount >= 2) confidence += 20;
      else confidence += 10;

      if (similarItem && score >= 0.5) confidence += 30;
      else if (similarItem && score >= 0.3) confidence += 15;

      if (marketItem.dailyPrice >= 20 && marketItem.dailyPrice <= 150) confidence += 20;
      if (marketItem.recentlyListed) confidence += 10;
      if (marketItem.avgRating && marketItem.avgRating >= 4.5) confidence += 10;

      opportunities.push({
        ...marketItem,
        similarItem,
        similarItemRevenue,
        similarItemRentals,
        estimatedMonthlyRevenue,
        confidenceScore: Math.min(confidence, 100),
      });
    }

    // Sort by estimated revenue × confidence
    return opportunities
      .sort((a, b) => (b.estimatedMonthlyRevenue * b.confidenceScore) - (a.estimatedMonthlyRevenue * a.confidenceScore))
      .slice(0, 25);
  }

  /**
   * Use AI to generate actionable opportunity insights from the analyzed data.
   */
  async generateInsights(opportunities: OpportunityItem[]): Promise<{
    title: string;
    description: string;
    estimatedRevenue: number;
    confidence: 'high' | 'medium' | 'low';
    category: string;
    items: string[];
  }[]> {
    if (opportunities.length === 0) return [];

    // Build our inventory context
    const inventoryLines = Object.entries(MASTER_INVENTORY)
      .map(([name, qty]) => {
        const price = getOneDayPrice(name);
        return `  ${name} (${qty} units, £${price || '?'}/day)`;
      })
      .join('\n');

    // Build opportunity data
    const oppLines = opportunities.map(o => {
      const sim = o.similarItem
        ? `Similar to: ${o.similarItem} (earns £${o.similarItemRevenue}/mo, ${o.similarItemRentals} rentals/mo)`
        : 'No close match in inventory';
      return [
        `  ${o.title} — £${o.dailyPrice}/day listed, £${o.ownerEarnings}/day earnings`,
        `    ${o.listingCount} listings on Hygglo | ${o.recentlyListed ? 'NEW (last 90 days)' : 'Established'}`,
        `    ${sim}`,
        `    Est. monthly revenue: £${o.estimatedMonthlyRevenue} | Confidence: ${o.confidenceScore}%`,
      ].join('\n');
    }).join('\n\n');

    const prompt = `You are a camera rental business analyst. Analyze these market opportunities and generate exactly 5 ranked insights.

## OUR CURRENT INVENTORY
${inventoryLines}

## MARKET OPPORTUNITIES (items on Hygglo we don't stock)
${oppLines}

## INSTRUCTIONS
Generate exactly 5 insights as a JSON array. Each insight must:
1. Identify a specific revenue opportunity based on the data above
2. Reference the estimated revenue AND the similar item's actual performance
3. Be actionable (what to buy, at what price point, expected return)
4. Consider whether adding stock complements our existing lineup

Categories: "new_product" (recently released gear), "expansion" (proven demand we could fill), "upgrade" (newer version of something we stock), "niche" (specialized gear with less competition)

Respond with ONLY a JSON array, no other text:
[{
  "title": "2-6 word actionable title",
  "description": "2-3 sentences with specific £ numbers from the data. Reference similar item performance.",
  "estimatedRevenue": <number, monthly £>,
  "confidence": "high|medium|low",
  "category": "new_product|expansion|upgrade|niche",
  "items": ["item name 1"]
}]`;

    try {
      const aiPrompt = `Respond with ONLY a valid JSON array. No preamble, no markdown fences.\n\n${prompt}`;
      const response = await this.aiService.processExtraction(aiPrompt, { maxTokens: 2000 });
      const text = response.content || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger.warn('AI response did not contain valid JSON array');
        return [];
      }

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      this.logger.error(`AI insight generation failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Store insights in competitor_insight table with type='market_releases'.
   */
  private async storeInsights(
    insights: any[],
    opportunities: OpportunityItem[],
  ) {
    const content = insights.map((i, idx) =>
      `${idx + 1}. **${i.title}** (${i.confidence} confidence)\n${i.description}\nEst. £${i.estimatedRevenue}/mo`
    ).join('\n\n');

    await this.prisma.competitor_insight.create({
      data: {
        insight_type: 'market_releases',
        content,
        recommendations: insights as any,
        data_snapshot: {
          type: 'market_releases',
          totalOpportunities: opportunities.length,
          topItems: opportunities.slice(0, 10).map(o => ({
            title: o.title,
            dailyPrice: o.dailyPrice,
            listingCount: o.listingCount,
            estimatedMonthly: o.estimatedMonthlyRevenue,
            similarItem: o.similarItem,
            confidence: o.confidenceScore,
          })),
          scannedAt: new Date().toISOString(),
          brandsScanned: TRACKED_BRANDS.map(b => b.brand),
        } as any,
      },
    });
  }

  /**
   * Send Telegram notification with top opportunities.
   */
  private async notifyOwner(insights: any[], opportunities: OpportunityItem[]) {
    if (insights.length === 0) return;

    const lines = [
      '📊 *Monthly Market Release Scan*\n',
      `Scanned ${TRACKED_BRANDS.length} brands across Hygglo marketplace.`,
      `Found ${opportunities.length} items we don't stock.\n`,
    ];

    for (const insight of insights.slice(0, 5)) {
      const badge = insight.confidence === 'high' ? '🟢' : insight.confidence === 'medium' ? '🟡' : '🔴';
      const cat = insight.category === 'new_product' ? '🆕' :
                  insight.category === 'upgrade' ? '⬆️' :
                  insight.category === 'expansion' ? '📈' : '🎯';
      lines.push(`${badge}${cat} *${insight.title}*`);
      lines.push(`${insight.description}`);
      lines.push(`_Est. £${insight.estimatedRevenue}/mo_\n`);
    }

    lines.push('_View full report on dashboard → AI Insights_');

    await this.telegramService.sendProactiveMessage(lines.join('\n'), 'Markdown');
  }

  /**
   * Get latest market release insights for dashboard.
   */
  async getLatestInsights(): Promise<{
    insights: any[];
    opportunities: any[];
    scannedAt: string | null;
  }> {
    const latest = await this.prisma.competitor_insight.findFirst({
      where: { insight_type: 'market_releases' },
      orderBy: { created_at: 'desc' },
    });

    if (!latest) return { insights: [], opportunities: [], scannedAt: null };

    return {
      insights: (latest.recommendations as any[]) || [],
      opportunities: (latest.data_snapshot as any)?.topItems || [],
      scannedAt: (latest.data_snapshot as any)?.scannedAt || latest.created_at.toISOString(),
    };
  }

  // ── Helpers ──

  private extractHighestDayPrice(listing: any, product: any): number {
    // highestPricePerDay is on the product object
    if (product.highestPricePerDay) return product.highestPricePerDay;

    // Fallback: check prices array on listing or product
    const prices = listing.prices || product.prices || [];
    let best = 0;
    for (const p of prices) {
      if (p.days === 1 && p.price > best) best = p.price;
    }
    if (best === 0 && prices.length > 0) {
      best = Math.max(...prices.map((p: any) => p.pricePerDay || p.price || 0));
    }
    return best;
  }

  /**
   * Normalize a Hygglo listing title into a clean product name.
   * "Sony FX6 Full Frame Cinema Camera rental London" → "Sony FX6"
   */
  private normalizeItemTitle(title: string, brand: string): string {
    const noise = ['rental', 'hire', 'london', 'uk', 'professional', 'pro kit', 'kit',
      'bundle', 'package', 'set', 'with', 'and', 'for', 'the', 'full frame',
      'cinema camera', 'mirrorless', 'camera body', 'body only'];

    let clean = title;
    for (const word of noise) {
      clean = clean.replace(new RegExp('\\b' + word + '\\b', 'gi'), '');
    }
    clean = clean.replace(/[^\w\s.-]/g, ' ').replace(/\s+/g, ' ').trim();

    // Keep first meaningful tokens (brand + model)
    const tokens = clean.split(' ').filter(t => t.length > 0);
    // Take up to 5 tokens that include the brand + model identifiers
    const kept = tokens.slice(0, 5).join(' ');
    return kept || title.slice(0, 40);
  }

  /**
   * Token overlap ratio between two strings.
   */
  private tokenOverlap(a: string, b: string): number {
    const tokA = new Set(a.toLowerCase().split(/[\s-]+/).filter(t => t.length > 1));
    const tokB = new Set(b.toLowerCase().split(/[\s-]+/).filter(t => t.length > 1));
    if (tokA.size === 0 || tokB.size === 0) return 0;

    let overlap = 0;
    for (const t of tokA) {
      if (tokB.has(t)) overlap++;
    }
    return overlap / Math.min(tokA.size, tokB.size);
  }

  /**
   * Find the closest matching item in our inventory to a market item.
   */
  private findSimilarInventoryItem(item: MarketItem): { similarItem: string | null; score: number } {
    const itemLower = item.title.toLowerCase();
    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const invName of Object.keys(MASTER_INVENTORY)) {
      const score = this.tokenOverlap(itemLower, invName.toLowerCase());

      // Brand must match
      if (!itemLower.includes(item.brand.toLowerCase())) continue;
      if (!invName.toLowerCase().includes(item.brand.toLowerCase()) &&
          item.brand.toLowerCase() !== 'dji' // DJI might not be in name
      ) continue;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = invName;
      }
    }

    // Also try category matching: same brand + same category (camera, lens, etc.)
    if (bestScore < 0.3) {
      const isCamera = /\b(camera|fx\d|a7|bmpcc|x\d00|gh\d)\b/i.test(item.title);
      const isLens = /\b(lens|mm|f\d|f\/\d)\b/i.test(item.title);
      const isDrone = /\b(drone|mavic|mini|air)\b/i.test(item.title);

      for (const invName of Object.keys(MASTER_INVENTORY)) {
        const invLower = invName.toLowerCase();
        if (!invLower.includes(item.brand.toLowerCase())) continue;

        const invIsCamera = /\b(camera|fx\d|a7|bmpcc|x\d00|gh\d)\b/i.test(invName);
        const invIsLens = /\b(lens|mm|f\d|f\/\d)\b/i.test(invName);
        const invIsDrone = /\b(drone|mavic|mini|air)\b/i.test(invName);

        if ((isCamera && invIsCamera) || (isLens && invIsLens) || (isDrone && invIsDrone)) {
          // Same brand + same category = reasonable similar item
          if (bestScore < 0.25) {
            bestMatch = invName;
            bestScore = 0.25;
          }
        }
      }
    }

    return { similarItem: bestMatch, score: bestScore };
  }
}
