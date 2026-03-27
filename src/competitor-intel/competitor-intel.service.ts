import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../prisma/prisma.service';
import { RevenueService } from '../revenue/revenue.service';
import { getItemPrice, getOneDayPrice, PRICING_CATALOG } from '../data/pricing-catalog';
import { findBestMatch, getInventoryItemNames, isAccessoryItem, MASTER_INVENTORY } from '../utils/item-matcher';

// ── Competitor config ──

interface CompetitorConfig {
  name: string;
  searchTerms: string[];
  hyggloOwnerId?: number; // Direct owner ID (most reliable — Hygglo search doesn't return owner names)
}

const COMPETITORS: CompetitorConfig[] = [
  { name: 'DJ W', searchTerms: ['sony camera'], hyggloOwnerId: 13179996 },
  { name: 'GB', searchTerms: ['sony camera'], hyggloOwnerId: 13180098 },
  { name: 'Rey R', searchTerms: ['sony fx3'], hyggloOwnerId: 13310468 },
  { name: 'Dita', searchTerms: ['blackmagic camera'], hyggloOwnerId: 12972685 },
  { name: 'Art N Studio', searchTerms: ['leica camera'], hyggloOwnerId: 13580595 },
  { name: 'Dom', searchTerms: ['sony fx3'], hyggloOwnerId: 12879273 },
];

const HYGGLO_OWNER_TAKE = 0.64; // Owner earns ~64% of listed price
const HYGGLO_SEARCH_BASE = 'https://api.hygglo.com/api/v2/product-listings/search';
const HYGGLO_LISTING_BASE = 'https://api.hygglo.com/api/v2/product-listings';
const HYGGLO_REVIEWS_BASE = 'https://api.hygglo.com/api/v2/product-reviews';

const HYGGLO_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Country': 'GB',
};

// ── Category detection ──

function categorizeItem(title: string): string {
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

// ── Strict match validation for competitor price comparison ──
// findBestMatch is designed for renter messages (loose, informal) — too permissive for competitor listings.
// This function validates that a match actually represents the SAME product.

const NOISE_TOKENS = new Set([
  'the', 'a', 'an', 'for', 'with', 'and', 'or', 'of', 'in', 'on', 'to',
  'like', 'similar', 'mount', 'full', 'frame', 'professional', 'cinema',
  'rental', 'hire', 'pro', 'digital', 'camera', 'lens', 'fe', 'ef',
]);

function isValidCompetitorMatch(inventoryItem: string, competitorTitle: string): boolean {
  const inv = inventoryItem.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  const comp = competitorTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();

  // 1. Category cross-check: reject blatant cross-category matches
  const invCat = categorizeItem(inv);
  const compCat = categorizeItem(comp);
  if (invCat !== 'other' && compCat !== 'other' && invCat !== compCat) return false;

  // 2. Extract significant tokens from inventory item (the thing we need to find in the competitor title)
  const invTokens = inv.split(/\s+/).filter(t => t.length > 1 && !NOISE_TOKENS.has(t));
  const compTokensSet = new Set(comp.split(/\s+/).filter(t => t.length > 1));

  // 3. Brand conflict check — different brands = different product
  const KNOWN_BRANDS = new Set([
    'sony', 'canon', 'cannon', 'nikon', 'panasonic', 'fujifilm', 'blackmagic', 'dji', 'rode',
    'sennheiser', 'nanlite', 'aputure', 'godox', 'hollyland', 'anker', 'ecoflow',
    'pioneer', 'jbl', 'gopro', 'tilta', 'smallrig', 'atomos', 'blazar', 'sirui',
    'manfrotto', 'sachtler', 'neewer', 'ambitful', 'deity', 'ttartisan', '7artisans', 'sigma',
  ]);
  // Normalize brand aliases (common misspellings)
  const normalizeBrand = (b: string) => b === 'cannon' ? 'canon' : b;
  const invBrands = invTokens.filter(t => KNOWN_BRANDS.has(t)).map(normalizeBrand);
  const compTokensArr = comp.split(/\s+/).filter(t => t.length > 1);
  const compBrands = compTokensArr.filter(t => KNOWN_BRANDS.has(t)).map(normalizeBrand);
  // If both have brands and NO overlap, reject (Sony vs Canon, Anker vs EcoFlow, etc.)
  if (invBrands.length > 0 && compBrands.length > 0) {
    const brandOverlap = invBrands.some(b => compBrands.includes(b));
    if (!brandOverlap) return false;
  }
  // If our item has a brand but competitor doesn't mention ANY known brand,
  // require that our brand appears somewhere in the competitor title
  if (invBrands.length > 0 && compBrands.length === 0) {
    const hasBrandInComp = invBrands.some(b => comp.includes(b));
    if (!hasBrandInComp) return false;
  }

  // 4. Count how many significant inventory tokens appear in competitor title
  let matches = 0;
  for (const token of invTokens) {
    // Direct match
    if (compTokensSet.has(token)) { matches++; continue; }
    // Fuzzy: check if comp contains a token that starts with or contains ours (e.g., "500b" in "500")
    let found = false;
    for (const ct of compTokensSet) {
      if (ct.includes(token) || token.includes(ct)) { found = true; break; }
    }
    if (found) matches++;
  }

  const coverage = invTokens.length > 0 ? matches / invTokens.length : 0;
  if (coverage < 0.5) return false;
  // For multi-token items, require at least 2 significant tokens to match
  // (prevents single-keyword matches like "nanlite" matching a C-Stand that mentions Nanlite)
  if (invTokens.length >= 2 && matches < 2) return false;

  // 4. Model number conflict detection — if both have a model number pattern, they must match
  // Sony camera models: a7 II, a7 III, a7s III, a7c, a7r IV, a1, fx3, fx6, zv-e1
  const sonyModelPattern = /\b(a7s?\s*(?:iv|iii|ii|i|c|r\s*(?:iv|iii|ii|v)?)?|a1|a9|fx[36]|zv\s*e?\d)/i;
  const invSonyModel = inv.match(sonyModelPattern);
  const compSonyModel = comp.match(sonyModelPattern);
  if (invSonyModel && compSonyModel) {
    const invM = invSonyModel[1].replace(/\s+/g, '').toLowerCase();
    const compM = compSonyModel[1].replace(/\s+/g, '').toLowerCase();
    if (invM !== compM) return false;
  }
  // If our item IS a Sony camera model but competitor has a DIFFERENT model
  if (invSonyModel && !compSonyModel) return false;

  // DJI model conflicts: Mavic 2 vs 3, Mini 3 vs 4, RS3 vs RS4
  const djiModelPattern = /\b(mavic|mini|rs)\s*(\d)/i;
  const invDji = inv.match(djiModelPattern);
  const compDji = comp.match(djiModelPattern);
  if (invDji && compDji && invDji[1].toLowerCase() === compDji[1].toLowerCase()) {
    if (invDji[2] !== compDji[2]) return false;
  }

  // Atomos model conflicts: Ninja V vs Shogun, Shinobi
  if (/\bninja\b/i.test(inv) && !/\bninja\b/i.test(comp) && /\b(shogun|shinobi)\b/i.test(comp)) return false;

  // Blazar Remus focal length conflict
  const blazarFocalPattern = /remus\s*(\d+)/i;
  const invBlazar = inv.match(blazarFocalPattern);
  const compBlazar = comp.match(blazarFocalPattern);
  if (invBlazar && compBlazar && invBlazar[1] !== compBlazar[1]) return false;
  // Remus shouldn't match Sirui anamorphic
  if (/remus/i.test(inv) && /sirui/i.test(comp)) return false;

  // Sony GM lens check: if our item does NOT have "GM" but competitor does, or vice versa,
  // it's a fundamentally different product (e.g., Sony 28-70mm kit vs 28-70mm F2.8 GM II)
  const invHasGM = /\bgm\b/i.test(inventoryItem);
  const compHasGM = /\bgm\b|g\s*master/i.test(competitorTitle);
  // Use ORIGINAL strings for focal length detection (cleaned strings strip hyphens from "24-70mm")
  if (invHasGM !== compHasGM && /sony/i.test(inventoryItem) && /\d+-\d+mm/i.test(inventoryItem)) {
    return false;
  }

  // Generic focal length conflict: 24-70mm shouldn't match 16-35mm, etc.
  // MUST use original strings — cleaned versions strip hyphens, breaking range patterns.
  const focalPattern = /\b(\d{1,3})-(\d{1,3})mm\b|\b(\d{1,3})mm\b/i;
  const invFocal = inventoryItem.match(focalPattern);
  const compFocal = competitorTitle.match(focalPattern);
  if (invFocal && compFocal) {
    const invFocalStr = invFocal[0].toLowerCase();
    const compFocalStr = compFocal[0].toLowerCase();
    // Both have focal lengths — they should be the same
    if (invFocalStr !== compFocalStr) {
      const invIsRange = invFocal[1] != null && invFocal[2] != null; // matched X-Ymm
      const compIsRange = compFocal[1] != null && compFocal[2] != null;
      // Zoom range vs prime single = different lens type, reject
      if (invIsRange !== compIsRange) return false;
      // Both ranges or both primes: check if numbers overlap (±2mm tolerance)
      const invNums = invFocal[0].match(/\d+/g)?.map(Number) || [];
      const compNums = compFocal[0].match(/\d+/g)?.map(Number) || [];
      if (invNums.length > 0 && compNums.length > 0) {
        const hasOverlap = invNums.some(n => compNums.some(cn => Math.abs(n - cn) <= 2));
        if (!hasOverlap) return false;
      }
    }
  }

  return true;
}

// ── Service ──

@Injectable()
export class CompetitorIntelService {
  private readonly logger = new Logger(CompetitorIntelService.name);
  private readonly claude: Anthropic;
  private readonly model: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly revenueService: RevenueService,
  ) {
    this.claude = new Anthropic({ apiKey: this.configService.get('ANTHROPIC_API_KEY') });
    this.model = this.configService.get('CLAUDE_MODEL_COMPLEX') || 'claude-sonnet-4-6-20250514';
  }

  // ────────────── SCRAPING ──────────────

  /**
   * Scrape Hygglo search results for all competitor listings.
   * Strategy: search to discover ownerId, then paginate all their listings.
   */
  async scrapeCompetitorListings(): Promise<number> {
    let totalScraped = 0;

    for (const config of COMPETITORS) {
      const slug = config.name.toLowerCase().replace(/\s+/g, '-');

      // Upsert competitor profile
      let profile = await this.prisma.competitor_profile.findUnique({ where: { slug } });
      if (!profile) {
        profile = await this.prisma.competitor_profile.create({
          data: { name: config.name, slug },
        });
      }

      try {
        // Use known ownerId, or try to discover via search
        const ownerId = config.hyggloOwnerId || await this.discoverOwnerId(config);
        if (!ownerId) {
          this.logger.warn(`Could not find ownerId for ${config.name}`);
          continue;
        }

        this.logger.log(`Using ownerId ${ownerId} for ${config.name}`);

        // Update profile URL
        await this.prisma.competitor_profile.update({
          where: { id: profile.id },
          data: { profile_url: `https://www.hygglo.com/user/${ownerId}` },
        });

        // Step 2: Paginate ALL listings for this owner
        const listings = await this.scrapeAllOwnerListings(ownerId);
        this.logger.log(`Found ${listings.length} listings for ${config.name}`);

        for (const listing of listings) {
          const ownerEarnings = listing.dailyPrice
            ? Math.round(listing.dailyPrice * HYGGLO_OWNER_TAKE * 100) / 100
            : null;

          await this.prisma.competitor_listing.upsert({
            where: {
              competitor_id_title: {
                competitor_id: profile.id,
                title: listing.title,
              },
            },
            update: {
              daily_price: listing.dailyPrice,
              owner_earnings: ownerEarnings,
              listing_url: listing.url,
              listing_slug: listing.slug,
              item_category: categorizeItem(listing.title),
              is_active: true,
              last_seen: new Date(),
            },
            create: {
              competitor_id: profile.id,
              title: listing.title,
              daily_price: listing.dailyPrice,
              owner_earnings: ownerEarnings,
              listing_url: listing.url,
              listing_slug: listing.slug,
              item_category: categorizeItem(listing.title),
            },
          });
          totalScraped++;
        }

        // Update profile stats
        const listingCount = await this.prisma.competitor_listing.count({
          where: { competitor_id: profile.id, is_active: true },
        });
        await this.prisma.competitor_profile.update({
          where: { id: profile.id },
          data: { total_listings: listingCount, last_scraped: new Date() },
        });
      } catch (error) {
        this.logger.warn(`Scrape failed for ${config.name}: ${error.message}`);
      }
    }

    // Mark listings not seen in 4 weeks as inactive
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    await this.prisma.competitor_listing.updateMany({
      where: { last_seen: { lt: fourWeeksAgo }, is_active: true },
      data: { is_active: false },
    });

    this.logger.log(`Scraped ${totalScraped} competitor listings`);
    return totalScraped;
  }

  /**
   * Discover a competitor's Hygglo ownerId by searching and matching owner name.
   */
  private async discoverOwnerId(config: CompetitorConfig): Promise<number | null> {
    const competitorLower = config.name.toLowerCase();
    const nameTokens = competitorLower.split(/\s+/).filter(t => t.length > 1);

    for (const term of config.searchTerms) {
      try {
        const response = await axios.get(HYGGLO_SEARCH_BASE, {
          params: { keywords: term, country: 'GB', pageSize: 50, pageIndex: 0 },
          headers: HYGGLO_HEADERS,
          timeout: 15000,
        });

        const listings: any[] = response.data?.productListings || [];

        for (const item of listings) {
          const ownerName = (item.product?.owner?.name || '').toLowerCase();
          if (!ownerName) continue;

          // Fuzzy match: check if competitor name tokens appear in owner name
          const matches = nameTokens.filter(t => ownerName.includes(t));
          if (matches.length >= Math.max(1, nameTokens.length - 1)) {
            const id = item.product?.owner?.id;
            if (id) return Number(id);
          }
        }

        await this.delay(1500);
      } catch (error) {
        this.logger.debug(`Owner discovery failed for "${term}": ${error.message}`);
      }
    }

    return null;
  }

  /**
   * Paginate through ALL listings for a given ownerId.
   */
  private async scrapeAllOwnerListings(
    ownerId: number,
  ): Promise<{ title: string; dailyPrice: number | null; url: string | null; slug: string | null }[]> {
    const results: { title: string; dailyPrice: number | null; url: string | null; slug: string | null }[] = [];
    const seen = new Set<string>();
    let pageIndex = 0;
    let hasMore = true;
    const pageSize = 50;

    while (hasMore) {
      try {
        const response = await axios.get(HYGGLO_SEARCH_BASE, {
          params: { ownerId, country: 'GB', pageSize, pageIndex },
          headers: HYGGLO_HEADERS,
          timeout: 15000,
        });

        const data = response.data;
        const listings: any[] = data?.productListings || [];

        if (listings.length === 0) {
          hasMore = false;
          break;
        }

        for (const item of listings) {
          const product = item.product || {};
          const title = product.name || '';
          if (!title || seen.has(title)) continue;
          seen.add(title);

          // Price: use highestPricePerDay (1-day rate = what borrower pays)
          const dailyPrice = product.highestPricePerDay ?? product.lowestPricePerDay ?? null;

          const itemSlug = item.slug || null;
          const url = item.publicUrl || (itemSlug ? `https://www.hygglo.com/uk/i/${itemSlug}` : null);

          results.push({ title, dailyPrice, url, slug: itemSlug });
        }

        pageIndex++;
        if (!data.hasNextPage || listings.length < pageSize) hasMore = false;

        // Rate limit between pages
        await this.delay(1500);
      } catch (error) {
        this.logger.warn(`Owner listing scrape error (ownerId=${ownerId}, page=${pageIndex}): ${error.message}`);
        hasMore = false;
      }
    }

    return results;
  }

  /**
   * Scrape reviews for all discovered competitors using their ownerId.
   * Uses the dedicated /v2/product-reviews endpoint.
   */
  async scrapeCompetitorReviews(): Promise<number> {
    let totalReviews = 0;

    const profiles = await this.prisma.competitor_profile.findMany();

    for (const profile of profiles) {
      // Extract ownerId from profile URL
      const ownerIdMatch = profile.profile_url?.match(/\/user\/(\d+)/);
      if (!ownerIdMatch) continue;
      const ownerId = ownerIdMatch[1];

      try {
        const response = await axios.get(HYGGLO_REVIEWS_BASE, {
          params: { ownerId, '$limit': 100, country: 'GB' },
          headers: HYGGLO_HEADERS,
          timeout: 15000,
        });

        const data = response.data;
        const reviews: any[] = Array.isArray(data) ? data : (data.data || data.reviews || data.items || []);

        // Update profile rating from aggregate
        if (reviews.length > 0) {
          const ratings = reviews.filter(r => r.rating != null).map(r => Number(r.rating));
          if (ratings.length > 0) {
            const avgRating = Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 10) / 10;
            await this.prisma.competitor_profile.update({
              where: { id: profile.id },
              data: { avg_rating: avgRating, total_reviews: reviews.length },
            });
          }
        }

        for (const review of reviews) {
          const reviewerName = review.user?.name || review.reviewer?.name || review.authorName || null;
          const reviewDate = review.createdAt ? new Date(review.createdAt) : (review.date ? new Date(review.date) : null);
          const content = review.text || review.content || review.comment || review.body || null;
          const rating = review.rating || review.score || null;
          const itemRented = review.productListing?.name || review.product?.name || review.itemName || null;

          if (!content && !rating) continue;

          // Dedup
          const existing = await this.prisma.competitor_review.findFirst({
            where: {
              competitor_id: profile.id,
              reviewer_name: reviewerName,
              ...(reviewDate ? { review_date: reviewDate } : {}),
            },
          });
          if (existing) continue;

          await this.prisma.competitor_review.create({
            data: {
              competitor_id: profile.id,
              reviewer_name: reviewerName,
              rating,
              content,
              item_rented: itemRented,
              review_date: reviewDate,
            },
          });
          totalReviews++;
        }

        await this.delay(2000);
      } catch (error) {
        this.logger.debug(`Review scrape failed for ${profile.name} (ownerId=${ownerId}): ${error.message}`);
      }
    }

    this.logger.log(`Scraped ${totalReviews} competitor reviews`);
    return totalReviews;
  }

  // ────────────── QUERY METHODS ──────────────

  /**
   * Get all active competitor listings grouped by competitor.
   */
  async getCompetitorCatalog(competitorName?: string) {
    const where: any = {};
    if (competitorName) {
      where.name = { contains: competitorName, mode: 'insensitive' };
    }

    const profiles = await this.prisma.competitor_profile.findMany({
      where,
      include: {
        listings: {
          where: { is_active: true },
          orderBy: { daily_price: 'desc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    return {
      competitors: profiles.map(p => ({
        name: p.name,
        listingCount: p.total_listings,
        avgRating: p.avg_rating,
        totalReviews: p.total_reviews,
        lastScraped: p.last_scraped,
        listings: p.listings.map(l => ({
          title: l.title,
          category: l.item_category,
          dailyPrice: l.daily_price,
          ownerEarnings: l.owner_earnings,
          url: l.listing_url,
          firstSeen: l.first_seen,
          lastSeen: l.last_seen,
        })),
      })),
    };
  }

  /**
   * Get recent competitor reviews.
   */
  async getCompetitorReviews(competitorName?: string, limit: number = 20) {
    const where: any = {};
    if (competitorName) {
      where.competitor = { name: { contains: competitorName, mode: 'insensitive' } };
    }

    const reviews = await this.prisma.competitor_review.findMany({
      where,
      include: { competitor: { select: { name: true } } },
      orderBy: { scraped_at: 'desc' },
      take: limit,
    });

    return reviews.map(r => ({
      competitorName: r.competitor.name,
      reviewerName: r.reviewer_name,
      rating: r.rating,
      content: r.content,
      itemRented: r.item_rented,
      reviewDate: r.review_date,
    }));
  }

  /**
   * Get aggregate summary across all competitors.
   */
  async getCompetitorSummary() {
    const profiles = await this.prisma.competitor_profile.findMany({
      include: {
        listings: { where: { is_active: true } },
        _count: { select: { reviews: true } },
      },
    });

    // Per-competitor stats
    const competitors = profiles.map(p => {
      const prices = p.listings
        .filter(l => l.daily_price != null)
        .map(l => l.daily_price!);
      const avgPrice = prices.length > 0
        ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100
        : null;

      // Category breakdown
      const categories: Record<string, { count: number; avgPrice: number }> = {};
      for (const listing of p.listings) {
        const cat = listing.item_category || 'other';
        if (!categories[cat]) categories[cat] = { count: 0, avgPrice: 0 };
        categories[cat].count++;
        if (listing.daily_price) {
          categories[cat].avgPrice =
            (categories[cat].avgPrice * (categories[cat].count - 1) + listing.daily_price) /
            categories[cat].count;
        }
      }

      // Round avgPrice in categories
      for (const cat of Object.keys(categories)) {
        categories[cat].avgPrice = Math.round(categories[cat].avgPrice * 100) / 100;
      }

      return {
        name: p.name,
        listingCount: p.listings.length,
        avgPrice,
        totalReviews: p._count.reviews,
        avgRating: p.avg_rating,
        lastScraped: p.last_scraped,
        categories,
      };
    });

    // Market gaps: items competitors have that we don't stock
    const ourItems = new Set(Object.keys(MASTER_INVENTORY).map(i => i.toLowerCase()));
    const competitorItems = new Set<string>();
    for (const p of profiles) {
      for (const l of p.listings) {
        competitorItems.add(l.title.toLowerCase());
      }
    }

    const marketGaps: string[] = [];
    for (const item of competitorItems) {
      const matchesOurs = [...ourItems].some(our => {
        const ourTokens = our.split(/\s+/);
        const itemTokens = item.split(/\s+/);
        const overlap = ourTokens.filter(t => itemTokens.includes(t));
        return overlap.length >= Math.min(ourTokens.length, itemTokens.length) * 0.5;
      });
      if (!matchesOurs) marketGaps.push(item);
    }

    return { competitors, marketGaps: marketGaps.slice(0, 20) };
  }

  // ────────────── PRICE RECOMMENDATIONS ──────────────

  /**
   * Per-item pricing comparison: our price vs competitors, our rental history vs competitor reviews.
   * Signals: overpriced (>15% above avg competitor), underpriced (>15% below), competitive, no_data.
   */
  async getPriceRecommendations(): Promise<{
    items: any[];
    summary: { overpriced: number; underpriced: number; competitive: number; no_data: number; total: number };
  }> {
    const inventoryItems = getInventoryItemNames().filter(name => !isAccessoryItem(name));

    // Parallel data fetches
    const [allEarnings, revenueBreakdown, catalog, competitorReviews, effectiveRates] = await Promise.all([
      this.revenueService.getAllItemEarnings(),
      this.revenueService.getItemRevenueBreakdown('all'),
      this.getCompetitorCatalog(),
      this.prisma.competitor_review.findMany({
        where: { item_rented: { not: null } },
        select: { item_rented: true, competitor_id: true },
      }),
      // Compute effective daily rate from actual booking data (revenue / rental days).
      // This is what we ACTUALLY earn per day, accounting for multi-day discounts and bundle pricing.
      this.prisma.$queryRaw<{ item_name: string; total_revenue: number; total_days: number; rental_count: number }[]>`
        SELECT
          item_name,
          COALESCE(SUM(revenue), 0)::float AS total_revenue,
          COALESCE(SUM(GREATEST(1, ROUND(EXTRACT(EPOCH FROM (end_date - start_date)) / 86400) + 1)), 0)::float AS total_days,
          COUNT(*)::int AS rental_count
        FROM booking
        WHERE status IN ('confirmed', 'completed')
          AND revenue IS NOT NULL AND revenue > 0
          AND end_date < NOW()
        GROUP BY item_name
      `,
    ]);

    // Build effective daily rate lookup (owner earnings per rental day from real data)
    const effectiveRateMap = new Map<string, number>();
    for (const row of effectiveRates) {
      if (row.total_days > 0) {
        effectiveRateMap.set(row.item_name, Math.round((row.total_revenue / row.total_days) * 100) / 100);
      }
    }

    // Build earnings lookup
    const earningsMap = new Map<string, { totalRevenue: number; rentalCount: number }>();
    for (const item of allEarnings.currentItems) {
      earningsMap.set(item.item, { totalRevenue: item.totalRevenue, rentalCount: item.rentalCount });
    }

    // Build monthly revenue lookup (avg monthly = total / months with activity)
    const monthlyMap = new Map<string, number>();
    for (const item of revenueBreakdown.items) {
      const activeMonths = item.monthlyBreakdown.filter((m: any) => m.revenue > 0).length;
      monthlyMap.set(item.item, activeMonths > 0 ? Math.round((item.totalRevenue / activeMonths) * 100) / 100 : 0);
    }

    // Pre-compute best inventory match for each competitor listing.
    // CRITICAL: Only match SINGLE-ITEM listings — bundles/kits have inflated prices
    // that don't represent individual item value.
    // Bundle detection: title has "+" separating products, or explicit bundle words
    // with quantity markers (e.g., "2x Sony FX3 + 2x lens"), or "Package N" patterns.
    // Detect bundle/multi-item listings: " + " separator, "Nx " quantity prefix,
    // "Package N", or explicit set/kit/combo words in the title
    const bundlePattern = /\s\+\s|(?:^|\s)[2-9]x\s|\bpackage\s*\d|\b(?:set|kit|combo)\b/i;

    const listingToItem = new Map<string, { competitorName: string; title: string; dailyPrice: number; bestMatch: string }>();
    for (const comp of catalog.competitors) {
      for (const listing of comp.listings) {
        if (!listing.dailyPrice) continue;

        // Skip obvious bundles by title pattern
        if (bundlePattern.test(listing.title)) continue;

        const bestMatch = findBestMatch(listing.title, inventoryItems);
        if (bestMatch && isValidCompetitorMatch(bestMatch, listing.title)) {
          const key = `${comp.name}::${listing.title}`;
          listingToItem.set(key, {
            competitorName: comp.name,
            title: listing.title,
            dailyPrice: listing.dailyPrice,
            bestMatch,
          });
        }
      }
    }

    // Pre-compute best inventory match for each competitor review
    const reviewToItem = new Map<number, string>();
    for (let i = 0; i < competitorReviews.length; i++) {
      const review = competitorReviews[i];
      if (review.item_rented) {
        const bestMatch = findBestMatch(review.item_rented, inventoryItems);
        if (bestMatch) reviewToItem.set(i, bestMatch);
      }
    }

    const results: any[] = [];

    for (const itemName of inventoryItems) {
      const priceEntry = getItemPrice(itemName);
      const catalogPrice = priceEntry?.daily_price_max ?? null;
      // Use catalog price as primary comparison — this is our listed 1-day rate that renters see.
      // Effective rate from bookings is unreliable: item-matching errors + multi-day discount averaging.
      const ourDailyPrice = catalogPrice;
      // Effective daily rate as secondary insight: what we actually earn per rental day (owner earnings).
      const effectiveOwnerRate = effectiveRateMap.get(itemName) ?? null;
      const effectiveDailyRate = effectiveOwnerRate
        ? Math.round((effectiveOwnerRate / HYGGLO_OWNER_TAKE) * 100) / 100
        : null;
      const earnings = earningsMap.get(itemName);
      const ourRentalCount = earnings?.rentalCount ?? 0;
      const ourTotalRevenue = earnings?.totalRevenue ?? 0;
      const avgMonthlyRevenue = monthlyMap.get(itemName) ?? 0;

      // Collect competitor listings whose BEST match is this item
      const competitorMatches: { competitorName: string; title: string; dailyPrice: number }[] = [];
      for (const entry of listingToItem.values()) {
        if (entry.bestMatch === itemName) {
          competitorMatches.push(entry);
        }
      }

      // Competitor average daily price (renter-facing listed price)
      const compAvgPrice = competitorMatches.length > 0
        ? Math.round(competitorMatches.reduce((s, c) => s + c.dailyPrice, 0) / competitorMatches.length * 100) / 100
        : null;

      // Count competitor reviews whose BEST match is this item
      let compReviewCount = 0;
      for (const [, matchedItem] of reviewToItem) {
        if (matchedItem === itemName) compReviewCount++;
      }

      // Compute price gap and signal
      let gapPercent: number | null = null;
      let signal: 'overpriced' | 'underpriced' | 'competitive' | 'no_data' = 'no_data';

      if (ourDailyPrice && compAvgPrice) {
        gapPercent = Math.round(((ourDailyPrice - compAvgPrice) / compAvgPrice) * 100);
        if (gapPercent > 15) signal = 'overpriced';
        else if (gapPercent < -15) signal = 'underpriced';
        else signal = 'competitive';
      }

      // Determine category from pricing catalog
      const category = priceEntry?.category ?? 'other';

      results.push({
        item: itemName,
        category,
        ourDailyPrice,
        effectiveDailyRate,
        compAvgPrice,
        gapPercent,
        signal,
        ourRentalCount,
        ourTotalRevenue,
        avgMonthlyRevenue,
        compReviewCount,
        competitorMatches: competitorMatches.map(c => ({
          competitor: c.competitorName,
          title: c.title,
          dailyPrice: c.dailyPrice,
        })),
      });
    }

    // Sort: overpriced first, then underpriced, competitive, no_data
    const signalOrder: Record<string, number> = { overpriced: 0, underpriced: 1, competitive: 2, no_data: 3 };
    results.sort((a, b) => {
      const orderDiff = (signalOrder[a.signal] ?? 9) - (signalOrder[b.signal] ?? 9);
      if (orderDiff !== 0) return orderDiff;
      // Within same signal, sort by absolute gap descending
      return Math.abs(b.gapPercent ?? 0) - Math.abs(a.gapPercent ?? 0);
    });

    const summary = {
      overpriced: results.filter(r => r.signal === 'overpriced').length,
      underpriced: results.filter(r => r.signal === 'underpriced').length,
      competitive: results.filter(r => r.signal === 'competitive').length,
      no_data: results.filter(r => r.signal === 'no_data').length,
      total: results.length,
    };

    return { items: results, summary };
  }

  // ────────────── AI INSIGHTS ──────────────

  /**
   * Generate AI-powered strategic recommendations using competitor data.
   */
  /**
   * Calculate data-grounded revenue estimates for competitor listings.
   * Uses listing price × 0.64 × estimated rental frequency (from review data).
   */
  private async calculateDataGroundedEstimates(profiles: any[]): Promise<Map<string, { monthlyEstimate: number; reviewRate: number; estimatedRentalsPerMonth: number }>> {
    const estimates = new Map<string, { monthlyEstimate: number; reviewRate: number; estimatedRentalsPerMonth: number }>();

    for (const p of profiles) {
      const totalReviews = p._count?.reviews || p.total_reviews || 0;
      const firstListing = p.listings?.[0];
      const firstSeen = firstListing?.first_seen || p.created_at;
      const monthsActive = firstSeen
        ? Math.max(1, Math.round((Date.now() - new Date(firstSeen).getTime()) / (30 * 86400000)))
        : 6; // default 6 months if unknown

      const reviewsPerMonth = totalReviews / monthsActive;
      // ~30% of rentals leave a review
      const estimatedRentalsPerMonth = Math.min(reviewsPerMonth / 0.3, 8); // cap at 8/month

      for (const l of (p.listings || [])) {
        if (!l.daily_price) continue;
        const ownerDailyEarnings = l.daily_price * HYGGLO_OWNER_TAKE;
        const avgRentalDays = 2.5; // conservative average
        const monthlyEstimate = Math.round(ownerDailyEarnings * avgRentalDays * estimatedRentalsPerMonth * 100) / 100;

        estimates.set(l.title, {
          monthlyEstimate,
          reviewRate: Math.round(reviewsPerMonth * 10) / 10,
          estimatedRentalsPerMonth: Math.round(estimatedRentalsPerMonth * 10) / 10,
        });
      }
    }

    return estimates;
  }

  async generateInsights(forceRegenerate = false): Promise<{
    recommendations: { title: string; description: string; opportunityType: string; confidence: string }[];
    generatedAt: string;
  }> {
    // Check for recent insight (last 24h) — skip if force-regenerating
    if (!forceRegenerate) {
      const dayAgo = new Date();
      dayAgo.setDate(dayAgo.getDate() - 1);
      const recent = await this.prisma.competitor_insight.findFirst({
        where: { insight_type: 'ai_recommendation', created_at: { gte: dayAgo } },
        orderBy: { created_at: 'desc' },
      });
      if (recent?.recommendations && (recent.recommendations as any[]).length > 0) {
        return {
          recommendations: recent.recommendations as any[],
          generatedAt: recent.created_at.toISOString(),
        };
      }
    }

    // Build context with data-grounded estimates
    const profiles = await this.prisma.competitor_profile.findMany({
      include: {
        listings: { where: { is_active: true }, orderBy: { daily_price: 'desc' } },
        _count: { select: { reviews: true } },
      },
    });
    const catalog = await this.getCompetitorCatalog();
    const reviews = await this.getCompetitorReviews(undefined, 30);

    // Calculate data-grounded revenue estimates
    const estimates = await this.calculateDataGroundedEstimates(profiles);

    // Competitor listings summary with data-grounded estimates
    const competitorLines: string[] = [];
    for (const comp of catalog.competitors) {
      competitorLines.push(`\n${comp.name} (${comp.listingCount} listings, rating: ${comp.avgRating ?? 'unknown'}, ${comp.totalReviews || 0} reviews):`);
      for (const l of comp.listings.slice(0, 15)) {
        const est = estimates.get(l.title);
        const estStr = est ? `, est. £${est.monthlyEstimate}/mo (${est.estimatedRentalsPerMonth} rentals/mo from review data)` : '';
        competitorLines.push(`  - ${l.title}: £${l.dailyPrice}/day (owner gets ~£${l.ownerEarnings})${estStr}`);
      }
    }

    // Our inventory + pricing
    const ourLines: string[] = [];
    for (const [item, qty] of Object.entries(MASTER_INVENTORY)) {
      const price = getOneDayPrice(item);
      ourLines.push(`- ${item}: ${qty} units, £${price || '?'}/day`);
    }

    // Recent reviews
    const reviewLines = reviews.slice(0, 15).map(r =>
      `- ${r.competitorName}: ${r.rating ? r.rating + '★' : ''} "${(r.content || '').substring(0, 100)}" (${r.itemRented || 'unknown item'})`,
    );

    const prompt = `You are a camera rental business strategist for DB Cinema and Leo Adams (two Hygglo accounts in London).

COMPETITOR DATA (revenue estimates are calculated from listing price × 0.64 × rental frequency from review data):
${competitorLines.join('\n')}

OUR INVENTORY:
${ourLines.join('\n')}

RECENT COMPETITOR REVIEWS:
${reviewLines.join('\n') || 'No reviews available yet.'}

Based on this data, provide exactly 5 actionable insights. Each must include:
1. Title (2-6 words)
2. Description with supporting data from the provided numbers (2-3 sentences)
3. Opportunity type: pricing_gap | inventory_gap | service_gap | bundle_idea
4. Confidence: high | medium | low

Rules:
- Use ONLY the revenue estimates provided in the data. Do NOT make up your own numbers.
- Compare our actual daily rates vs competitor daily rates.
- Flag pricing gaps where our daily rate differs >15% from competitors.
- Note items competitors rent frequently (by review data) that we don't stock.
- Reference specific prices and numbers from the data above.

Format your response as JSON array:
[{"title":"...","description":"...","opportunityType":"pricing_gap|inventory_gap|service_gap|bundle_idea","confidence":"high|medium|low"}]`;

    try {
      const response = await this.claude.messages.create({
        model: this.model,
        max_tokens: 2000,
        system: 'You are a camera rental business strategist. Respond ONLY with the JSON array requested. No preamble, no disclaimers, no role refusals.',
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('\n');

      this.logger.log(`Insight AI: model=${this.model}, in=${response.usage.input_tokens}, out=${response.usage.output_tokens}`);

      // Parse JSON from response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      let recommendations: any[] = [];
      if (jsonMatch) {
        try {
          recommendations = JSON.parse(jsonMatch[0]);
        } catch {
          this.logger.warn('Failed to parse AI insight JSON, using raw content');
          recommendations = [{
            title: 'Analysis Available',
            description: content.substring(0, 500),
            expectedRevenue: 'See details',
            confidence: 'medium',
          }];
        }
      }

      // Store insight
      await this.prisma.competitor_insight.create({
        data: {
          insight_type: 'ai_recommendation',
          content,
          recommendations: recommendations as any,
          data_snapshot: {
            competitorCount: catalog.competitors.length,
            totalListings: catalog.competitors.reduce((s, c) => s + c.listingCount, 0),
            reviewCount: reviews.length,
          } as any,
        },
      });

      return {
        recommendations: recommendations.slice(0, 5),
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Insight generation failed: ${error.message}`);
      return {
        recommendations: [{
          title: 'Analysis Pending',
          description: 'Sync competitor data first, then insights will be generated.',
          opportunityType: 'service_gap',
          confidence: 'low',
        }],
        generatedAt: new Date().toISOString(),
      };
    }
  }

  // ────────────── BUDGET INSIGHTS ──────────────

  /**
   * Generate budget-specific investment recommendations using Sonnet.
   * Includes bundle listings, addons, gear switches, and new acquisitions.
   */
  async generateBudgetInsights(
    budget: string,
    revenueContext: string,
    forceRegenerate = false,
  ): Promise<{
    recommendations: { title: string; description: string; type: string; estimatedCost: string; estimatedReturn: string; confidence: string }[];
    budget: string;
    generatedAt: string;
  }> {
    const cacheKey = `budget_insights_${budget}`;

    // Check cache (24h)
    if (!forceRegenerate) {
      const dayAgo = new Date();
      dayAgo.setDate(dayAgo.getDate() - 1);
      const recent = await this.prisma.competitor_insight.findFirst({
        where: { insight_type: cacheKey, created_at: { gte: dayAgo } },
        orderBy: { created_at: 'desc' },
      });
      if (recent?.recommendations && (recent.recommendations as any[]).length > 0) {
        return {
          recommendations: recent.recommendations as any[],
          budget,
          generatedAt: recent.created_at.toISOString(),
        };
      }
    }

    // Build bundle catalog
    const bundleLines: string[] = [];
    for (const item of PRICING_CATALOG) {
      if (item.is_bundle && item.bundle_items) {
        bundleLines.push(`- ${item.item_name}: £${item.daily_price_max}/day (contains: ${item.bundle_items.join(', ')})`);
      }
    }

    // Build individual item catalog with stock
    const itemLines: string[] = [];
    for (const [item, qty] of Object.entries(MASTER_INVENTORY)) {
      const price = getOneDayPrice(item);
      if (price) itemLines.push(`- ${item}: £${price}/day, stock: ${qty}`);
    }

    // Competitor context
    const profiles = await this.prisma.competitor_profile.findMany({
      include: {
        listings: { where: { is_active: true }, take: 8, orderBy: { daily_price: 'desc' } },
      },
    });
    const competitorLines: string[] = [];
    for (const p of profiles) {
      if (p.listings.length > 0) {
        competitorLines.push(`${p.name}:`);
        for (const l of p.listings.slice(0, 5)) {
          competitorLines.push(`  - ${l.title}: £${l.daily_price}/day`);
        }
      }
    }

    // Budget-specific framing
    const budgetFrames: Record<string, string> = {
      '0-500': 'Budget: £0-500. Focus on: accessories, addons to existing gear, creating new bundle listings from existing inventory, small upgrades. Do NOT recommend cameras costing £1000+.',
      '500-2000': 'Budget: £500-2000. Focus on: adding second units of popular items, mid-range gear additions, lens upgrades, lighting kits, gear switches (sell underperforming → buy high-demand). Include purchase price estimates.',
      '2000+': 'Budget: £2000+. Focus on: new camera bodies, premium lens sets, complete production packages, strategic inventory expansion based on demand data. Include purchase price estimates.',
    };

    const prompt = `You are the ULTIMATE MARKETING RESEARCH ENGINE for a camera rental business (DB Cinema + Leo Adams, London, Hygglo platform). Your single mission: find ways to MAKE MORE MONEY.

${budgetFrames[budget] || budgetFrames['0-500']}

DECISION FRAMEWORK — Analyze every recommendation through these lenses:
1. CAPITAL INVESTMENT vs RETURN: What's the purchase cost? What's the realistic monthly ROI based on the actual rental data below? How many months to break even?
2. HISTORIC ROI: Which items in the data below ACTUALLY earn the most per unit? Which have the highest utilization? Don't guess — the numbers are provided.
3. INVENTORY SATURATION: Items at high utilization with denied requests = money left on the table. Adding units here is nearly guaranteed revenue.
4. AGEING / UNDERPERFORMING EQUIPMENT: Items with LOW utilization and LOW rentals/month are dead capital. Consider selling them and reinvesting in high-demand gear.
5. RENTAL QUANTITY & FREQUENCY: Items rented 3+ times/month are proven performers. Items rented <1/month are questionable investments.
6. UNMATCHED DEMAND: The data below includes items that renters REQUESTED but we DON'T STOCK. These are validated market signals — real people wanted to pay for these items.

CURRENT INVENTORY & PRICING:
${itemLines.join('\n')}

EXISTING BUNDLE LISTINGS:
${bundleLines.join('\n')}

${revenueContext}

COMPETITOR LANDSCAPE:
${competitorLines.join('\n') || 'No competitor data available.'}

Generate exactly 6 actionable recommendations, ranked by expected ROI (best first). Each MUST include:
1. Title (2-8 words, specific — name the item/bundle)
2. Description: Reference SPECIFIC numbers from the data (revenue earned, denied requests, utilization %, rentals/month). Explain the ROI logic. 2-3 sentences.
3. Type: new_acquisition | add_unit | bundle_listing | addon | gear_switch
4. Estimated cost to implement (purchase price, or "Free" for bundle listings)
5. Estimated monthly return — CONSERVATIVE, based on the revenue data provided. For add_unit, use the per-unit revenue already shown. For new items, base on similar item performance.
6. Confidence: high (proven by data) | medium (supported by signals) | low (speculative)

Types:
- new_acquisition: Buy gear you don't own — justified by unmatched demand data or competitor gap
- add_unit: Buy another unit of high-demand gear that's stock-blocked (denied requests prove the demand)
- bundle_listing: Create a new Hygglo listing combining EXISTING inventory items (free, just a new listing)
- addon: Buy a small accessory that makes existing popular items more rentable or increases daily rate
- gear_switch: Sell underperforming gear (low util, low rentals/mo), buy high-demand replacement. State what to sell AND what to buy.

Rules:
- Every recommendation must be actionable within the stated budget
- PRIORITIZE by ROI: stock-blocked items first (guaranteed demand), then high-frequency items, then market gaps
- For gear_switch, calculate: sell price of old gear + budget = total available for new gear
- Bundle listings are FREE revenue — always include at least 1 if there's an untapped combination
- Use ONLY numbers from the data above. Do NOT invent revenue figures.
- Factor in that items degrade over time — older high-use items may need replacement consideration

Format as JSON array:
[{"title":"...","description":"...","type":"new_acquisition|add_unit|bundle_listing|addon|gear_switch","estimatedCost":"£X","estimatedReturn":"£X/mo","confidence":"high|medium|low"}]`;

    try {
      const response = await this.claude.messages.create({
        model: this.model,
        max_tokens: 3000,
        system: 'You are a camera rental business investment advisor. Respond ONLY with the JSON array requested. No preamble.',
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('\n');

      this.logger.log(`Budget insights (${budget}): model=${this.model}, in=${response.usage.input_tokens}, out=${response.usage.output_tokens}`);

      const jsonMatch = content.match(/\[[\s\S]*\]/);
      let recommendations: any[] = [];
      if (jsonMatch) {
        try {
          recommendations = JSON.parse(jsonMatch[0]);
        } catch {
          this.logger.warn('Failed to parse budget insight JSON');
          recommendations = [{ title: 'Analysis Error', description: content.substring(0, 300), type: 'new_acquisition', estimatedCost: 'N/A', estimatedReturn: 'N/A', confidence: 'low' }];
        }
      }

      // Cache
      await this.prisma.competitor_insight.create({
        data: {
          insight_type: cacheKey,
          content,
          recommendations: recommendations as any,
          data_snapshot: { budget, itemCount: itemLines.length, bundleCount: bundleLines.length } as any,
        },
      });

      return {
        recommendations: recommendations.slice(0, 6),
        budget,
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Budget insight generation failed: ${error.message}`);
      return {
        recommendations: [{ title: 'Analysis Pending', description: 'Sync data first, then generate insights.', type: 'new_acquisition', estimatedCost: 'N/A', estimatedReturn: 'N/A', confidence: 'low' }],
        budget,
        generatedAt: new Date().toISOString(),
      };
    }
  }

  // ────────────── AI CHAT CONTEXT ──────────────

  /**
   * Build a concise context block for the dashboard AI chat.
   * Only used in POST /api/chat — never in renter-facing prompts.
   */
  async buildAIContext(): Promise<string> {
    const profiles = await this.prisma.competitor_profile.findMany({
      include: {
        listings: { where: { is_active: true }, take: 10, orderBy: { daily_price: 'desc' } },
        _count: { select: { reviews: true } },
      },
    });

    if (profiles.length === 0) return '';

    const parts: string[] = [];
    parts.push('COMPETITOR OVERVIEW:');

    for (const p of profiles) {
      const prices = p.listings.filter(l => l.daily_price).map(l => l.daily_price!);
      const avgPrice = prices.length > 0
        ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
        : 0;
      parts.push(`${p.name}: ${p.listings.length} active listings, avg £${avgPrice}/day, ${p._count.reviews} reviews, rating ${p.avg_rating ?? 'N/A'}`);

      // Top listings by price
      for (const l of p.listings.slice(0, 5)) {
        parts.push(`  - ${l.title}: £${l.daily_price}/day (owner ~£${l.owner_earnings})`);
      }
    }

    // Price comparison with our items
    const comparisons: string[] = [];
    for (const [item, _qty] of Object.entries(MASTER_INVENTORY)) {
      const ourPrice = getOneDayPrice(item);
      if (!ourPrice) continue;

      // Find similar competitor listings
      for (const p of profiles) {
        for (const l of p.listings) {
          if (l.daily_price && this.isSimilarItem(item, l.title)) {
            const diff = ourPrice - l.daily_price;
            const pct = Math.round((diff / l.daily_price) * 100);
            if (Math.abs(pct) >= 10) {
              comparisons.push(`${item}: ours £${ourPrice} vs ${p.name}'s "${l.title}" £${l.daily_price} (${pct > 0 ? '+' : ''}${pct}%)`);
            }
          }
        }
      }
    }

    if (comparisons.length > 0) {
      parts.push('\nPRICE COMPARISONS (>10% difference):');
      parts.push(...comparisons.slice(0, 10));
    }

    // Items competitors have that we don't
    const ourItems = Object.keys(MASTER_INVENTORY).map(i => i.toLowerCase());
    const gaps: string[] = [];
    for (const p of profiles) {
      for (const l of p.listings) {
        const hasMatch = ourItems.some(our => this.isSimilarItem(our, l.title));
        if (!hasMatch && l.daily_price && l.daily_price > 15) {
          gaps.push(`${l.title} (£${l.daily_price}/day, ${p.name})`);
        }
      }
    }
    if (gaps.length > 0) {
      parts.push('\nITEMS COMPETITORS STOCK THAT WE DON\'T:');
      parts.push(...[...new Set(gaps)].slice(0, 10).map(g => `- ${g}`));
    }

    return parts.join('\n');
  }

  /**
   * Simple similarity check between our inventory item and a competitor listing title.
   */
  private isSimilarItem(ourItem: string, competitorTitle: string): boolean {
    const ourTokens = ourItem.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 1);
    const compTokens = competitorTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 1);
    const overlap = ourTokens.filter(t => compTokens.includes(t));
    return overlap.length >= Math.min(ourTokens.length, 2);
  }

  // ────────────── CRON ──────────────

  /**
   * Weekly sync: Sunday 4 PM (before existing market report at 6 PM).
   */
  @Cron('0 16 * * 0')
  async weeklySync() {
    this.logger.log('Starting weekly competitor intelligence sync...');
    try {
      const scraped = await this.scrapeCompetitorListings();
      const reviews = await this.scrapeCompetitorReviews();
      await this.generateInsights();
      this.logger.log(`Weekly competitor sync complete: ${scraped} listings, ${reviews} reviews`);
    } catch (error) {
      this.logger.error(`Weekly competitor sync failed: ${error.message}`);
    }
  }

  // ────────────── UTIL ──────────────

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
