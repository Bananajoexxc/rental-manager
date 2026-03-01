import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService, RentalListing } from '../hygglo/hygglo.service';
import { findBestMatch, getInventoryItemNames, isAccessoryItem, MASTER_INVENTORY } from '../utils/item-matcher';
import { getOneDayPrice, PRICING_CATALOG } from '../data/pricing-catalog';

interface ItemAnalysis {
  item: string;
  matched: string | null;
  blocked: boolean;
  bookedQty: number;
  maxQty: number;
}

// Minimum revenue threshold — requests under £25 are discarded from metrics
const MIN_REVENUE_THRESHOLD = 25;

/**
 * Normalize long SEO-stuffed Hygglo titles into clean product names.
 * "3x Sony FX3 Full Frame Cinema Camera 3-Body Kit | Professional 4K..." → "Sony FX3"
 */
function normalizeItemTitle(raw: string): string {
  let s = raw;

  // Strip everything after | or  –  or  -  (SEO suffixes)
  s = s.split(/\s*\|\s*/)[0];
  s = s.split(/\s+–\s+/)[0];
  // Only split on ' - ' surrounded by spaces (not hyphens in model names like FX-3)
  s = s.split(/\s+-\s+/)[0];

  // Strip quantity prefixes: "2×", "3x", "4x" etc
  s = s.replace(/^\d+[×x]\s*/i, '');

  // Strip parenthetical alternatives: (like "Sony FX6 / a7siii")
  s = s.replace(/\((?:like\s+)?[""].*?[""]\)/gi, '');
  s = s.replace(/\([^)]*\)/g, '');

  // Strip filler words and SEO noise
  const fillerPatterns = [
    /\b(?:and more|full frame|cinema camera|professional|mirrorless)\b/gi,
    /\b(?:4k|120fps|video camera|photo camera|hybrid)\b/gi,
    /\b(?:kit|set|bundle|package|ultimate|production)\b/gi,
    /\b(?:run and gun|setup|rig|portable|battery powered)\b/gi,
    /\b(?:colour|color|studio|lighting|light stands?|power supplies|soft light|modifiers?|lantern)\b/gi,
    /\b(?:bluetooth|speaker|pa|dj speaker|party speaker)\b/gi,
    /\b(?:home cinema|events?|business|presentations?)\b/gi,
    /\b(?:cards?\s*&?\s*batteries|body)\b/gi,
    /\b(?:rental|london|hire)\b/gi,
    /\b(?:all\s+licenses|media)\b/gi,
    /\b(?:digital|coverage|vista\s+vision)\b/gi,
  ];
  for (const pattern of fillerPatterns) {
    s = s.replace(pattern, ' ');
  }

  // Normalize gmaster/g-master/g master → GM
  s = s.replace(/\bg[-\s]?master\b/gi, 'GM');
  s = s.replace(/\bgmaster\b/gi, 'GM');

  // Normalize FX-3 → FX3, a7s iii → A7SIII
  s = s.replace(/\bfx[-\s]3\b/gi, 'FX3');
  s = s.replace(/\ba7s\s*iii\b/gi, 'A7SIII');
  s = s.replace(/\ba7\s*v\b/gi, 'A7V');

  // Strip duplicate slashes: "FX3 / FX 3 / Cinema Camera / GM"
  s = s.replace(/\s*\/\s*/g, ' ');

  // Strip dangling numbers and hyphens left over from removals (e.g. "3-Body" → "3-")
  s = s.replace(/\b\d+-\s/g, ' ');
  s = s.replace(/\s-\d+\b/g, ' ');

  // Collapse whitespace and trim
  s = s.replace(/\s+/g, ' ').trim();

  // Strip trailing + signs and dangling connectors
  s = s.replace(/\s*\+\s*$/, '').replace(/^\s*\+\s*/, '');

  // Lowercase then title-case for consistency
  s = s.toLowerCase();
  s = s.replace(/\b\w/g, c => c.toUpperCase());

  // Ensure common acronyms stay uppercase
  const acronyms: Record<string, string> = {
    'Fx3': 'FX3', 'Gm': 'GM', 'Dj': 'DJ', 'Jbl': 'JBL', 'Dzo': 'DZO',
    'Dzofilm': 'DZOFILM', 'Rgb': 'RGB', 'Led': 'LED', 'Pl': 'PL', 'Rx': 'RX',
    'Pa': 'PA', 'Uhd': 'UHD', 'Hdmi': 'HDMI', 'Bmpcc': 'BMPCC', 'Arri': 'ARRI',
    'A7Siii': 'A7SIII', 'A7V': 'A7V', 'Fx6': 'FX6', 'Rx2': 'RX2', 'Rx3': 'RX3',
    'Wah': 'Wah', 'Dji': 'DJI',
  };
  for (const [pattern, replacement] of Object.entries(acronyms)) {
    s = s.replace(new RegExp(`\\b${pattern}\\b`, 'g'), replacement);
  }

  // Deduplicate consecutive identical tokens: "Sony FX3 FX3" → "Sony FX3"
  const tokens = s.split(' ');
  const deduped: string[] = [];
  for (const token of tokens) {
    if (deduped.length === 0 || deduped[deduped.length - 1].toLowerCase() !== token.toLowerCase()) {
      deduped.push(token);
    }
  }
  s = deduped.join(' ');

  // If result is too short or empty, fall back to truncated raw
  if (s.length < 3) {
    s = raw.split(/\s*\|\s*/)[0].substring(0, 60).trim();
  }

  return s;
}

@Injectable()
export class LostRevenueService {
  private readonly logger = new Logger(LostRevenueService.name);

  private parsedItemCache = new Map<string, string | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly hyggloService: HyggloService,
  ) {}

  /**
   * Extract the active order step from rental detail.
   * Steps: REQUEST → APPROVED → FUNDS_RESERVED → VERIFIED → BOOKED_AFTER_VERIFIED → DELIVERED → RETURNED → REVIEWED
   */
  private extractActiveOrderStep(detail: any): string | null {
    if (!detail?.steps || !Array.isArray(detail.steps)) return null;
    const active = detail.steps.find((s: any) => s.active === true);
    return active?.key || null;
  }

  /**
   * Check if a specific step is completed in the order detail.
   */
  private isStepCompleted(detail: any, stepKey: string): boolean {
    if (!detail?.steps || !Array.isArray(detail.steps)) return false;
    const step = detail.steps.find((s: any) => s.key === stepKey);
    return step?.completed === true;
  }

  /** Normalize a parsed_item name to its MASTER_INVENTORY key using token overlap. */
  private normalizeParsedItemName(parsedName: string): string | null {
    if (MASTER_INVENTORY[parsedName] !== undefined) return parsedName;
    if (this.parsedItemCache.has(parsedName)) return this.parsedItemCache.get(parsedName)!;

    const inputLower = parsedName.toLowerCase().replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim();
    const inputTokens = inputLower.split(' ');
    const inventoryNames = getInventoryItemNames();
    const fStopPattern = /^f\d/;
    const inputFStops = inputTokens.filter(t => fStopPattern.test(t));

    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const invName of inventoryNames) {
      const invLower = invName.toLowerCase().replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim();
      const invTokens = invLower.split(' ');

      if (inputFStops.length > 0) {
        const invFStops = invTokens.filter(t => fStopPattern.test(t));
        if (invFStops.length > 0 && !inputFStops.some(f => invFStops.includes(f))) continue;
      }

      let matched = 0;
      for (const t of inputTokens) {
        if (t.length < 2) continue;
        if (invTokens.some(it => it === t || (t.length >= 4 && it.includes(t)) || (it.length >= 4 && t.includes(it)))) {
          matched++;
        }
      }

      const significantTokens = inputTokens.filter(t => t.length >= 2).length;
      const coverage = significantTokens > 0 ? matched / significantTokens : 0;
      if (coverage >= 0.8 && matched > bestScore) {
        bestScore = matched;
        bestMatch = invName;
      }
    }

    this.parsedItemCache.set(parsedName, bestMatch);
    return bestMatch;
  }

  /**
   * Sync obsolete bookings from Hygglo and analyze for stock-blocked lost revenue.
   */
  async syncObsoleteBookings(
    account: 'dbcinema' | 'leo',
    sinceDaysBack: number = 90,
  ): Promise<{ imported: number; skipped: number }> {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - sinceDaysBack);

    const obsoleteRentals = await this.hyggloService.scanObsoleteRentalsPaginated(account, 0, sinceDate);
    this.logger.log(`Fetched ${obsoleteRentals.length} obsolete rentals for ${account} (since ${sinceDate.toISOString().split('T')[0]})`);

    let imported = 0;
    let skipped = 0;
    const inventoryNames = getInventoryItemNames();

    for (const rental of obsoleteRentals) {
      try {
        if (!rental.startDate || !rental.endDate) {
          skipped++;
          continue;
        }

        // If already imported, update active_step + denial_type if missing
        const existing = await this.prisma.lost_revenue_record.findUnique({
          where: { hygglo_order_id: rental.listingId },
        });
        if (existing) {
          // Reclassify records using active_step data
          if (existing.denial_type === 'expired' || !existing.denial_type || existing.denial_type === 'owner_denied') {
            const step = this.extractActiveOrderStep(rental._detail);
            const items = (existing.items_requested as any[]) || [];
            const hasMatched = items.some(i => i.matched !== null);
            const approved = this.isStepCompleted(rental._detail, 'APPROVED');
            let newType = existing.denial_type;
            if (step === 'CANCELED') {
              newType = 'renter_cancelled';
            } else if (step === 'VERIFICATION_FAILED' || (step && ['VERIFIED', 'FUNDS_RESERVED'].includes(step))) {
              newType = 'verification_failed';
            } else if (existing.stock_blocked) {
              newType = 'unavailable';
            } else if (hasMatched && !approved) {
              // Use active_step to distinguish: DENIED = owner denied, null = timeout
              newType = step === 'DENIED' ? 'owner_denied' : 'timeout';
            } else if (hasMatched && approved) {
              newType = 'expired';
            } else if (!hasMatched) {
              newType = 'unmatched';
            }
            if (newType !== existing.denial_type || step) {
              await this.prisma.lost_revenue_record.update({
                where: { id: existing.id },
                data: { active_step: step || existing.active_step, denial_type: newType },
              });
            }
          }
          skipped++;
          continue;
        }

        // Parse items from the rental
        const itemsAnalysis = await this.analyzeItems(rental, inventoryNames);

        // Calculate rental days
        const msPerDay = 86400000;
        let rentalDays = Math.max(1, Math.round((rental.endDate.getTime() - rental.startDate.getTime()) / msPerDay));

        // Determine blocked and unmatched items
        const blockedItems = itemsAnalysis.filter(i => i.blocked).map(i => i.matched!);
        const unmatchedItems = itemsAnalysis.filter(i => !i.matched).map(i => i.item);
        const stockBlocked = blockedItems.length > 0;

        // Classify denial type using order step
        // REQUEST active = owner never approved (declined or didn't respond) → owner_denied
        // APPROVED completed but went obsolete = not owner's fault
        // VERIFIED/FUNDS_RESERVED active = verification issue
        const activeStep = this.extractActiveOrderStep(rental._detail);
        const hasMatchedItems = itemsAnalysis.some(i => i.matched !== null);
        const approvedCompleted = this.isStepCompleted(rental._detail, 'APPROVED');
        let denialType: string;
        if (activeStep && ['VERIFIED', 'FUNDS_RESERVED'].includes(activeStep)) {
          denialType = 'verification_failed';
        } else if (stockBlocked) {
          denialType = 'unavailable';
        } else if (hasMatchedItems && !approvedCompleted) {
          // Items we stock, owner never approved the request
          denialType = 'owner_denied';
        } else if (hasMatchedItems && approvedCompleted) {
          // Owner approved but order still went obsolete (renter cancelled, etc.)
          denialType = 'expired';
        } else {
          denialType = 'unmatched';
        }

        // Calculate lost revenue
        const hyggloPrice = rental.rentalPrice && rental.rentalPrice > 0 ? rental.rentalPrice : null;
        let estimatedPrice: number | null = null;

        if (!hyggloPrice) {
          let totalEstimate = 0;
          for (const item of itemsAnalysis) {
            if (item.matched) {
              const dayPrice = getOneDayPrice(item.matched);
              if (dayPrice) totalEstimate += dayPrice * rentalDays * 0.64;
            }
          }
          estimatedPrice = totalEstimate > 0 ? Math.round(totalEstimate * 100) / 100 : null;
        }

        const lostRevenue = hyggloPrice ?? estimatedPrice ?? 0;

        // Refine denial type using Hygglo active_step:
        // - DENIED step = owner actively denied on Hygglo (confirmed via activities timeline)
        // - CANCELED step = renter cancelled or auto-cancelled after approval
        // - null step (old records) = keep as timeout (unknown, likely auto-expired)
        if (activeStep === 'DENIED') {
          denialType = 'owner_denied';
        } else if (denialType === 'owner_denied' && !activeStep) {
          // Old records without active_step — treat as timeout (can't confirm denial)
          denialType = 'timeout';
        }
        if (activeStep === 'CANCELED') {
          denialType = 'renter_cancelled';
        }
        if (activeStep === 'VERIFICATION_FAILED') {
          denialType = 'verification_failed';
        }

        // Skip low-value rentals under £25 — these would have been declined
        if (lostRevenue < MIN_REVENUE_THRESHOLD) {
          skipped++;
          continue;
        }

        await this.prisma.lost_revenue_record.create({
          data: {
            hygglo_order_id: rental.listingId,
            title: rental.title,
            renter_info: rental.renterInfo || null,
            account,
            start_date: rental.startDate,
            end_date: rental.endDate,
            rental_days: rentalDays,
            hygglo_price: hyggloPrice,
            estimated_price: estimatedPrice,
            lost_revenue: lostRevenue,
            items_requested: itemsAnalysis as any,
            stock_blocked: stockBlocked,
            blocked_items: blockedItems,
            unmatched_items: unmatchedItems,
            denial_type: denialType,
            active_step: activeStep,
          },
        });
        imported++;
      } catch (error) {
        this.logger.error(`Error processing obsolete rental ${rental.listingId}: ${error.message}`);
        skipped++;
      }
    }

    this.logger.log(`Sync ${account}: imported=${imported}, skipped=${skipped}`);
    return { imported, skipped };
  }

  /**
   * Analyze items in an obsolete rental: match to inventory and check if stock-blocked.
   */
  private async analyzeItems(rental: RentalListing, inventoryNames: string[]): Promise<ItemAnalysis[]> {
    const items: { name: string }[] = [];

    if (rental._detail?.items && Array.isArray(rental._detail.items)) {
      for (const item of rental._detail.items) {
        if (item.type === 'PRODUCT' && item.title) {
          items.push({ name: item.title });
        }
      }
    }

    if (items.length === 0) {
      items.push({ name: rental.title });
    }

    // Batch-fetch all overlapping confirmed bookings for this rental's date range (avoids N+1 per item)
    const bookedByItem = new Map<string, number>();
    if (rental.startDate && rental.endDate) {
      const allOverlapping = await this.prisma.booking.findMany({
        where: {
          status: 'confirmed',
          start_date: { lt: rental.endDate },
          end_date: { gt: rental.startDate },
        },
        select: { item_name: true, quantity: true },
      });
      for (const b of allOverlapping) {
        bookedByItem.set(b.item_name, (bookedByItem.get(b.item_name) || 0) + (b.quantity || 1));
      }
    }

    const results: ItemAnalysis[] = [];

    for (const item of items) {
      const matched = findBestMatch(item.name, inventoryNames);
      const maxQty = matched ? (MASTER_INVENTORY[matched] || 1) : 0;
      const bookedQty = matched ? (bookedByItem.get(matched) || 0) : 0;
      const blocked = bookedQty >= maxQty;

      results.push({ item: item.name, matched, blocked, bookedQty, maxQty });
    }

    return results;
  }

  // ────────────── QUERY METHODS ──────────────

  /**
   * Get denied revenue summary — items WERE available but owner didn't accept.
   */
  async getDeniedRevenueSummary(period: string = '3m', account?: string) {
    const { start, end } = this.getFlexiblePeriodRange(period);

    const where: any = { denial_type: 'owner_denied', lost_revenue: { gte: MIN_REVENUE_THRESHOLD } };
    if (account) where.account = account;
    if (start) where.start_date = { ...(where.start_date || {}), gte: start };
    if (end) where.start_date = { ...(where.start_date || {}), lt: end };

    const records = await this.prisma.lost_revenue_record.findMany({ where });

    const totalDeniedRevenue = records.reduce((sum, r) => sum + r.lost_revenue, 0);
    const deniedCount = records.length;

    // For owner-denied, use matched items from items_requested JSON
    const itemCounts: Record<string, { count: number; revenue: number }> = {};
    for (const record of records) {
      const items = (record.items_requested as any[]) || [];
      const matchedItems = items.filter(i => i.matched !== null);
      const share = matchedItems.length > 0 ? record.lost_revenue / matchedItems.length : 0;
      for (const item of matchedItems) {
        const name = item.matched;
        if (!itemCounts[name]) itemCounts[name] = { count: 0, revenue: 0 };
        itemCounts[name].count++;
        itemCounts[name].revenue += share;
      }
    }

    const topDeniedItems = Object.entries(itemCounts)
      .map(([item, data]) => ({ item, count: data.count, revenue: Math.round(data.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const uniqueItems = new Set(Object.keys(itemCounts));

    return {
      totalDeniedRevenue: Math.round(totalDeniedRevenue * 100) / 100,
      deniedCount,
      itemsAffected: uniqueItems.size,
      topDeniedItems,
      period,
    };
  }

  /**
   * Get missed revenue summary — items NOT in inventory (unmatched) with actual revenue amounts.
   */
  async getMissedRevenueSummary(period: string = '3m', account?: string) {
    const { start, end } = this.getFlexiblePeriodRange(period);

    const where: any = { denial_type: 'unmatched' };
    if (account) where.account = account;
    if (start) where.start_date = { ...(where.start_date || {}), gte: start };
    if (end) where.start_date = { ...(where.start_date || {}), lt: end };

    const records = await this.prisma.lost_revenue_record.findMany({ where });

    const totalMissedRevenue = records.reduce((sum, r) => sum + r.lost_revenue, 0);
    const missedCount = records.length;

    // Aggregate by unmatched item name, filtering out items that actually match inventory
    const inventoryNames = getInventoryItemNames();
    const itemCounts: Record<string, { count: number; revenue: number }> = {};
    for (const record of records) {
      const unmatchedCount = record.unmatched_items.length || 1;
      const share = record.lost_revenue / unmatchedCount;
      for (const rawItem of record.unmatched_items) {
        // Skip items that actually match our inventory (misclassified as unmatched)
        const matched = findBestMatch(rawItem, inventoryNames);
        if (matched) continue;
        const normalized = normalizeItemTitle(rawItem);
        const matchedNorm = findBestMatch(normalized, inventoryNames);
        if (matchedNorm) continue;
        const key = normalized.toLowerCase();
        if (!itemCounts[key]) itemCounts[key] = { count: 0, revenue: 0 };
        itemCounts[key].count++;
        itemCounts[key].revenue += share;
      }
    }

    const topMissedItems = Object.entries(itemCounts)
      .map(([key, data]) => {
        const displayName = key.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        return { item: displayName, count: data.count, revenue: Math.round(data.revenue * 100) / 100 };
      })
      .filter(i => i.count >= 2)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    return {
      totalMissedRevenue: Math.round(totalMissedRevenue * 100) / 100,
      missedCount,
      topMissedItems,
      period,
    };
  }

  /**
   * Get timeout revenue summary — items in stock but owner never responded.
   */
  async getTimeoutSummary(period: string = '3m', account?: string) {
    const { start, end } = this.getFlexiblePeriodRange(period);

    const where: any = { denial_type: 'timeout', lost_revenue: { gte: MIN_REVENUE_THRESHOLD } };
    if (account) where.account = account;
    if (start) where.start_date = { ...(where.start_date || {}), gte: start };
    if (end) where.start_date = { ...(where.start_date || {}), lt: end };

    const records = await this.prisma.lost_revenue_record.findMany({ where });

    const totalTimeoutRevenue = records.reduce((sum, r) => sum + r.lost_revenue, 0);
    const timeoutCount = records.length;

    const itemCounts: Record<string, { count: number; revenue: number }> = {};
    for (const record of records) {
      const items = (record.items_requested as any[]) || [];
      const matchedItems = items.filter(i => i.matched !== null);
      const share = matchedItems.length > 0 ? record.lost_revenue / matchedItems.length : 0;
      for (const item of matchedItems) {
        const name = item.matched;
        if (!itemCounts[name]) itemCounts[name] = { count: 0, revenue: 0 };
        itemCounts[name].count++;
        itemCounts[name].revenue += share;
      }
    }

    const topTimeoutItems = Object.entries(itemCounts)
      .map(([item, data]) => ({ item, count: data.count, revenue: Math.round(data.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const uniqueItems = new Set(Object.keys(itemCounts));

    return {
      totalTimeoutRevenue: Math.round(totalTimeoutRevenue * 100) / 100,
      timeoutCount,
      itemsAffected: uniqueItems.size,
      topTimeoutItems,
      period,
    };
  }

  /**
   * Get lost revenue summary — items were booked out/unavailable.
   */
  async getLostRevenueSummary(period: string = '3m', account?: string) {
    const { start, end } = this.getFlexiblePeriodRange(period);

    const where: any = { denial_type: 'unavailable', lost_revenue: { gte: MIN_REVENUE_THRESHOLD } };
    if (account) where.account = account;
    if (start) where.start_date = { ...(where.start_date || {}), gte: start };
    if (end) where.start_date = { ...(where.start_date || {}), lt: end };

    const records = await this.prisma.lost_revenue_record.findMany({ where });

    const totalLostRevenue = records.reduce((sum, r) => sum + r.lost_revenue, 0);
    const lostCount = records.length;

    const itemCounts: Record<string, { count: number; revenue: number }> = {};
    for (const record of records) {
      const share = record.blocked_items.length > 0 ? record.lost_revenue / record.blocked_items.length : 0;
      for (const item of record.blocked_items) {
        if (!itemCounts[item]) itemCounts[item] = { count: 0, revenue: 0 };
        itemCounts[item].count++;
        itemCounts[item].revenue += share;
      }
    }

    const topBlockedItems = Object.entries(itemCounts)
      .map(([item, data]) => ({ item, count: data.count, revenue: Math.round(data.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const uniqueItems = new Set<string>();
    for (const record of records) {
      for (const item of record.blocked_items) uniqueItems.add(item);
    }

    return {
      totalLostRevenue: Math.round(totalLostRevenue * 100) / 100,
      lostCount,
      itemsAffected: uniqueItems.size,
      topBlockedItems,
      period,
    };
  }

  /**
   * Get per-item breakdown of stock-blocked items.
   */
  async getBlockedItemsBreakdown(period: string = '3m', account?: string) {
    const { start, end } = this.getFlexiblePeriodRange(period);

    const where: any = { denial_type: 'unavailable', lost_revenue: { gte: MIN_REVENUE_THRESHOLD } };
    if (account) where.account = account;
    if (start) where.start_date = { ...(where.start_date || {}), gte: start };
    if (end) where.start_date = { ...(where.start_date || {}), lt: end };

    const records = await this.prisma.lost_revenue_record.findMany({ where });

    const itemData: Record<string, { deniedCount: number; totalLostRevenue: number }> = {};
    for (const record of records) {
      const share = record.blocked_items.length > 0 ? record.lost_revenue / record.blocked_items.length : 0;
      for (const item of record.blocked_items) {
        if (!itemData[item]) itemData[item] = { deniedCount: 0, totalLostRevenue: 0 };
        itemData[item].deniedCount++;
        itemData[item].totalLostRevenue += share;
      }
    }

    let periodMonths = 3;
    if (period === 'month') periodMonths = 1;
    else if (period === '6m') periodMonths = 6;
    else if (period === '12m') periodMonths = 12;
    else if (period === 'all') periodMonths = 12;
    else if (period === 'week') periodMonths = 0.25;

    return Object.entries(itemData)
      .map(([item, data]) => ({
        item,
        deniedCount: data.deniedCount,
        totalLostRevenue: Math.round(data.totalLostRevenue * 100) / 100,
        currentInventory: MASTER_INVENTORY[item] || 0,
        suggestedAdditional: Math.ceil(data.deniedCount / Math.max(periodMonths, 1)),
      }))
      .sort((a, b) => b.totalLostRevenue - a.totalLostRevenue);
  }

  /**
   * Get demand for items we DON'T stock — what people are requesting that we can't fulfill.
   */
  async getUnmatchedDemand(period: string = '6m', account?: string) {
    const { start, end } = this.getFlexiblePeriodRange(period);

    const where: any = { NOT: { unmatched_items: { isEmpty: true } } };
    if (account) where.account = account;
    if (start) where.start_date = { ...(where.start_date || {}), gte: start };
    if (end) where.start_date = { ...(where.start_date || {}), lt: end };

    const records = await this.prisma.lost_revenue_record.findMany({ where });

    // Normalize and aggregate unmatched item names, filtering out items that match inventory
    const inventoryNames = getInventoryItemNames();
    const itemData: Record<string, { requestCount: number; totalDays: number; totalRevenue: number; displayName: string }> = {};
    for (const record of records) {
      const unmatchedCount = record.unmatched_items.length || 1;
      const revenueShare = record.lost_revenue / unmatchedCount;
      for (const rawItem of record.unmatched_items) {
        // Skip items that actually match our inventory
        if (findBestMatch(rawItem, inventoryNames)) continue;
        const normalized = normalizeItemTitle(rawItem);
        if (findBestMatch(normalized, inventoryNames)) continue;
        const key = normalized.toLowerCase();
        if (!itemData[key]) itemData[key] = { requestCount: 0, totalDays: 0, totalRevenue: 0, displayName: normalized };
        itemData[key].requestCount++;
        itemData[key].totalDays += record.rental_days;
        itemData[key].totalRevenue += revenueShare;
      }
    }

    // Calculate avg days and format — includes actual lost_revenue from Hygglo records
    return Object.entries(itemData)
      .map(([, data]) => ({
        item: data.displayName,
        requestCount: data.requestCount,
        avgRentalDays: Math.round(data.totalDays / data.requestCount * 10) / 10,
        totalRevenue: Math.round(data.totalRevenue * 100) / 100,
      }))
      .filter(i => i.requestCount >= 2) // only show items requested 2+ times
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 30);
  }

  /**
   * Investment scorecard for all items (existing inventory).
   * Uses: actual revenue data, lost revenue data, demand signals.
   * Confidence scoring based on rental frequency, revenue per unit, and demand pressure.
   */
  async getRevenuePotential(period: string = '6m', account?: string) {
    const { start, end } = this.getFlexiblePeriodRange(period);

    // 1. ACTUAL REVENUE from RENTAL table (not booking table — booking includes unaccepted requests)
    // Only completed/ongoing/upcoming rentals with real revenue
    const rentalWhere: any = {
      status: { in: ['completed', 'ongoing', 'upcoming'] },
      rental_price: { not: null, gt: 0 },
      start_date: { not: null },
    };
    if (account) rentalWhere.account = account;
    if (start || end) {
      rentalWhere.start_date = {};
      if (start) rentalWhere.start_date.gte = start;
      if (end) rentalWhere.start_date.lt = end;
    }

    const rentals = await this.prisma.rental.findMany({
      where: rentalWhere,
      select: {
        id: true, listing_id: true, renter_info: true, start_date: true, end_date: true,
        rental_price: true, parsed_items: true,
      },
    });

    // Deduplicate rentals: listing_id + renter_info + start_date → keep highest revenue
    const rentalDedup = new Map<string, typeof rentals[0]>();
    for (const r of rentals) {
      if (!r.start_date || !r.renter_info) continue;
      const key = `${r.listing_id}|${r.renter_info.toLowerCase().trim()}|${r.start_date.toISOString().split('T')[0]}`;
      const existing = rentalDedup.get(key);
      if (!existing || (r.rental_price || 0) > (existing.rental_price || 0)) {
        rentalDedup.set(key, r);
      }
    }
    const dedupedRentals = Array.from(rentalDedup.values());

    // Per-item attribution: distribute each rental's revenue across its parsed_items proportionally
    const actualRevenue: Record<string, { revenue: number; rentalCount: number; totalDays: number }> = {};
    for (const r of dedupedRentals) {
      const parsedItems = (r.parsed_items as { item: string; qty: number }[] | null) || [];
      // Normalize parsed_item names to MASTER_INVENTORY keys via fuzzy match
      // (e.g. "Anamorphic Great Joy 50mm" → "Anamorphic Great Joy lens 50mm")
      const mainItems = parsedItems
        .map(p => {
          const resolved = this.normalizeParsedItemName(p.item);
          return resolved ? { item_name: resolved, qty: p.qty || 1 } : null;
        })
        .filter((p): p is { item_name: string; qty: number } => p !== null && !isAccessoryItem(p.item_name));

      if (mainItems.length === 0) continue;

      // Hygglo dates are INCLUSIVE (both start and end are rental days): days = diff + 1
      const days = r.end_date && r.start_date
        ? Math.max(1, Math.round((r.end_date.getTime() - r.start_date.getTime()) / 86400000) + 1)
        : 1;

      // Distribute revenue proportionally using catalog prices
      const totalWeight = mainItems.reduce((sum, i) => {
        const unitPrice = getOneDayPrice(i.item_name) || 0;
        return sum + (i.qty * unitPrice);
      }, 0);

      for (const item of mainItems) {
        const unitPrice = getOneDayPrice(item.item_name) || 0;
        const weight = item.qty * unitPrice;
        const share = totalWeight > 0
          ? (r.rental_price || 0) * (weight / totalWeight)
          : (r.rental_price || 0) / mainItems.length;

        if (!actualRevenue[item.item_name]) actualRevenue[item.item_name] = { revenue: 0, rentalCount: 0, totalDays: 0 };
        actualRevenue[item.item_name].revenue += share;
        actualRevenue[item.item_name].rentalCount++;
        actualRevenue[item.item_name].totalDays += days;
      }
    }

    // 2. Lost revenue per item (stock-blocked) — this data source is fine
    const dateFilter: any = {};
    if (start) dateFilter.gte = start;
    if (end) dateFilter.lt = end;
    const lostWhere: any = { stock_blocked: true, lost_revenue: { gte: MIN_REVENUE_THRESHOLD } };
    if (account) lostWhere.account = account;
    if (start || end) lostWhere.start_date = dateFilter;

    const lostRecords = await this.prisma.lost_revenue_record.findMany({ where: lostWhere });
    const lostRevenue: Record<string, { revenue: number; deniedCount: number }> = {};
    for (const r of lostRecords) {
      const share = r.blocked_items.length > 0 ? r.lost_revenue / r.blocked_items.length : 0;
      for (const item of r.blocked_items) {
        if (!lostRevenue[item]) lostRevenue[item] = { revenue: 0, deniedCount: 0 };
        lostRevenue[item].revenue += share;
        lostRevenue[item].deniedCount++;
      }
    }

    // 3. Calculate period months
    let periodMonths = 6;
    if (period === 'month') periodMonths = 1;
    else if (period === '3m') periodMonths = 3;
    else if (period === '6m') periodMonths = 6;
    else if (period === '12m') periodMonths = 12;
    else if (period === 'all') periodMonths = 12;

    // 4. Build scores for all inventory items
    const allItems = new Set([
      ...Object.keys(MASTER_INVENTORY),
      ...Object.keys(lostRevenue),
    ]);

    const results: {
      item: string;
      currentStock: number;
      dailyPrice: number | null;
      actualRevenue: number;
      lostRevenue: number;
      totalPotential: number;
      deniedRequests: number;
      rentalCount: number;
      utilization: number;
      rentedDaysPerMonth: number;
      rentalsPerMonth: number;
      revenuePerUnit: number;
      confidence: 'high' | 'medium' | 'low';
      confidenceScore: number;
    }[] = [];

    for (const item of allItems) {
      const stock = MASTER_INVENTORY[item] || 0;
      const dailyPrice = getOneDayPrice(item);
      const actual = actualRevenue[item] || { revenue: 0, rentalCount: 0, totalDays: 0 };
      const lost = lostRevenue[item] || { revenue: 0, deniedCount: 0 };
      const totalPotential = actual.revenue + lost.revenue;

      // Utilization: booked days / available days in period (per-unit)
      const availableDays = periodMonths * 30 * Math.max(stock, 1);
      const utilization = availableDays > 0 ? Math.min(Math.round((actual.totalDays / availableDays) * 100), 100) : 0;

      // Days rented per month (per unit)
      const rentedDaysPerMonth = Math.round(actual.totalDays / Math.max(periodMonths, 1) / Math.max(stock, 1) * 10) / 10;

      // Per-month metrics
      const rentalsPerMonth = actual.rentalCount / Math.max(periodMonths, 1);
      const revenuePerUnit = stock > 0 ? (actual.revenue / stock / Math.max(periodMonths, 1)) : 0;
      const demandPressure = lost.deniedCount / Math.max(periodMonths, 1);

      // Confidence scoring — weighted components (0-100 scale each)
      const freqScore = Math.min(rentalsPerMonth / 3 * 100, 100);   // 3 rentals/month = 100
      const revScore = Math.min(revenuePerUnit / 150 * 100, 100);   // £150/unit/month = 100
      const demandScore = Math.min(demandPressure / 2 * 100, 100);  // 2 blocked/month = 100
      const utilScore = utilization;                                  // Already 0-100

      // Balanced: frequency 30%, revenue 30%, utilization 25%, demand 15%
      const confidenceScore = Math.round(freqScore * 0.30 + revScore * 0.30 + utilScore * 0.25 + demandScore * 0.15);
      const confidence: 'high' | 'medium' | 'low' = confidenceScore >= 60 ? 'high' : confidenceScore >= 30 ? 'medium' : 'low';

      results.push({
        item,
        currentStock: stock,
        dailyPrice,
        actualRevenue: Math.round(actual.revenue * 100) / 100,
        lostRevenue: Math.round(lost.revenue * 100) / 100,
        totalPotential: Math.round(totalPotential * 100) / 100,
        deniedRequests: lost.deniedCount,
        rentalCount: actual.rentalCount,
        utilization,
        rentedDaysPerMonth,
        rentalsPerMonth: Math.round(rentalsPerMonth * 10) / 10,
        revenuePerUnit: Math.round(revenuePerUnit * 100) / 100,
        confidence,
        confidenceScore,
      });
    }

    return results
      .filter(r => r.totalPotential > 0 || r.rentalCount > 0)
      .sort((a, b) => b.confidenceScore - a.confidenceScore);
  }

  /**
   * Build a context string for the dashboard AI with all revenue intelligence.
   */
  async buildAIContext(): Promise<string> {
    const parts: string[] = [];

    // Denied revenue (owner didn't accept, 3m)
    try {
      const denied = await this.getDeniedRevenueSummary('3m');
      if (denied.deniedCount > 0) {
        parts.push(`DENIED REVENUE (last 3 months): £${denied.totalDeniedRevenue} from ${denied.deniedCount} requests where items were available but not accepted.`);
        parts.push('Top denied items: ' + denied.topDeniedItems.slice(0, 5).map((i: any) => `${i.item} (${i.count}x, £${i.revenue})`).join(', '));
      }
    } catch {}

    // Lost revenue (stock unavailable, 3m)
    try {
      const lost = await this.getLostRevenueSummary('3m');
      if (lost.lostCount > 0) {
        parts.push(`LOST REVENUE (last 3 months): £${lost.totalLostRevenue} from ${lost.lostCount} requests where stock was unavailable.`);
        parts.push('Top blocked items: ' + lost.topBlockedItems.slice(0, 5).map((i: any) => `${i.item} (${i.count}x, £${i.revenue})`).join(', '));
      }
    } catch {}

    // Unmatched demand
    try {
      const unmatched = await this.getUnmatchedDemand('6m');
      if (unmatched.length > 0) {
        parts.push('\nUNMATCHED DEMAND (items we don\'t stock, requested 2+ times in 6m):');
        for (const item of unmatched.slice(0, 10)) {
          parts.push(`- "${item.item}": ${item.requestCount} requests, avg ${item.avgRentalDays} days`);
        }
      }
    } catch {}

    // Investment scorecard
    try {
      const potential = await this.getRevenuePotential('6m');
      if (potential.length > 0) {
        parts.push('\nINVESTMENT SCORECARD (6m, sorted by confidence):');
        for (const item of potential.slice(0, 15)) {
          const lostStr = item.lostRevenue > 0 ? `, £${item.lostRevenue} lost` : '';
          parts.push(`- ${item.item}: £${item.actualRevenue} earned${lostStr}, ${item.utilization}% util, ${item.rentalsPerMonth}/mo, confidence=${item.confidence}`);
        }
      }
    } catch {}

    // Item pricing reference
    try {
      const pricingLines: string[] = [];
      for (const item of Object.keys(MASTER_INVENTORY)) {
        const price = getOneDayPrice(item);
        if (price) {
          pricingLines.push(`${item}: £${price}/day rent, stock: ${MASTER_INVENTORY[item]}`);
        }
      }
      if (pricingLines.length > 0) {
        parts.push('\nINVENTORY PRICING (daily rental rate, current stock):');
        parts.push(pricingLines.join('\n'));
      }
    } catch {}

    return parts.join('\n');
  }

  /**
   * Get items that are currently fully booked (all units out) and when they return.
   */
  async getCurrentlyUnavailable(): Promise<{
    item: string;
    totalStock: number;
    bookedUntil: string;
    currentRenters: string[];
    imageUrl?: string;
  }[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const results: { item: string; totalStock: number; bookedUntil: string; currentRenters: string[]; imageUrl?: string }[] = [];

    for (const [item, maxQty] of Object.entries(MASTER_INVENTORY)) {
      if (maxQty <= 0) continue;

      // Find confirmed bookings overlapping today — include rental_id for photo lookup
      const overlapping = await this.prisma.booking.findMany({
        where: {
          item_name: item,
          status: 'confirmed',
          start_date: { lt: tomorrow },
          end_date: { gt: today },
        },
        select: { quantity: true, end_date: true, renter_name: true, rental_id: true },
      });

      const bookedQty = overlapping.reduce((sum, b) => sum + (b.quantity || 1), 0);
      if (bookedQty >= maxQty) {
        // Find earliest end_date (when first unit comes back)
        const earliestEnd = overlapping.reduce((min, b) =>
          b.end_date < min ? b.end_date : min, overlapping[0].end_date);
        const renters = [...new Set(overlapping.map(b => b.renter_name).filter(Boolean))];

        // Get item image from the first booking's rental photos
        let imageUrl: string | undefined;
        const rentalIds = [...new Set(overlapping.map(b => b.rental_id).filter((id): id is string => !!id))];
        if (rentalIds.length > 0) {
          const rental = await this.prisma.rental.findFirst({
            where: { id: { in: rentalIds }, photos_urls: { isEmpty: false } },
            select: { photos_urls: true },
          });
          if (rental && rental.photos_urls.length > 0) {
            // Filter to product photos only (exclude renter profile avatars which contain /profiles/)
            const productPhoto = rental.photos_urls.find(u => u.includes('/products/'));
            if (productPhoto) imageUrl = productPhoto;
          }
        }

        results.push({
          item,
          totalStock: maxQty,
          bookedUntil: earliestEnd.toISOString().split('T')[0],
          currentRenters: renters,
          imageUrl,
        });
      }
    }

    return results.sort((a, b) => a.bookedUntil.localeCompare(b.bookedUntil));
  }

  // ────────────── CRON ──────────────

  /**
   * Save/update monthly snapshot of denied + lost revenue.
   */
  async saveMonthlySnapshot(periodStart: Date, periodEnd: Date) {
    // Per-account + global aggregation
    const records = await this.prisma.lost_revenue_record.findMany({
      where: {
        start_date: { gte: periodStart, lt: periodEnd },
        lost_revenue: { gte: MIN_REVENUE_THRESHOLD },
        denial_type: { in: ['owner_denied', 'unavailable'] },
      },
    });

    // Group by account (+ null for global)
    const accountGroups = new Map<string | null, typeof records>();
    accountGroups.set(null, records); // global
    for (const r of records) {
      if (!accountGroups.has(r.account)) accountGroups.set(r.account, []);
      accountGroups.get(r.account)!.push(r);
    }

    for (const [account, recs] of accountGroups) {
      const denied = recs.filter(r => r.denial_type === 'owner_denied');
      const lost = recs.filter(r => r.denial_type === 'unavailable');

      const deniedItems = new Set<string>();
      for (const r of denied) {
        const items = (r.items_requested as any[]) || [];
        items.filter(i => i.matched).forEach(i => deniedItems.add(i.matched));
      }

      const lostItems = new Set<string>();
      for (const r of lost) {
        r.blocked_items.forEach(i => lostItems.add(i));
      }

      const acctKey = account ?? '';
      await this.prisma.revenue_loss_monthly.upsert({
        where: {
          period_start_account: { period_start: periodStart, account: acctKey },
        },
        create: {
          period_start: periodStart,
          period_end: periodEnd,
          account: acctKey,
          denied_revenue: Math.round(denied.reduce((s, r) => s + r.lost_revenue, 0) * 100) / 100,
          denied_count: denied.length,
          denied_items: [...deniedItems],
          lost_revenue: Math.round(lost.reduce((s, r) => s + r.lost_revenue, 0) * 100) / 100,
          lost_count: lost.length,
          lost_items: [...lostItems],
        },
        update: {
          denied_revenue: Math.round(denied.reduce((s, r) => s + r.lost_revenue, 0) * 100) / 100,
          denied_count: denied.length,
          denied_items: [...deniedItems],
          lost_revenue: Math.round(lost.reduce((s, r) => s + r.lost_revenue, 0) * 100) / 100,
          lost_count: lost.length,
          lost_items: [...lostItems],
        },
      });
    }
  }

  /**
   * Backfill denial_type for existing records using active_step data.
   * Splits owner_denied into timeout (no response) vs owner_denied (actively declined).
   * Also reclassifies expired/null records and picks up verification_failed + renter_cancelled.
   */
  async backfillDenialTypes(): Promise<{ updated: number; breakdown: Record<string, number> }> {
    const records = await this.prisma.lost_revenue_record.findMany({
      where: {
        OR: [
          { denial_type: null },
          { denial_type: 'expired' },
          { denial_type: 'owner_denied' },
          { denial_type: 'timeout' },
        ],
      },
    });

    let updated = 0;
    const breakdown: Record<string, number> = {};
    for (const record of records) {
      let denialType: string;
      const activeStep = record.active_step as string | null;

      if (activeStep === 'CANCELED') {
        denialType = 'renter_cancelled';
      } else if (activeStep === 'VERIFICATION_FAILED') {
        denialType = 'verification_failed';
      } else if (record.stock_blocked) {
        denialType = 'unavailable';
      } else {
        const items = (record.items_requested as any[]) || [];
        const hasMatched = items.some(i => i.matched !== null);
        if (hasMatched) {
          // DENIED step = owner actively denied; null = timeout (unknown)
          denialType = activeStep === 'DENIED' ? 'owner_denied' : 'timeout';
        } else {
          denialType = 'unmatched';
        }
      }

      if (denialType !== record.denial_type) {
        await this.prisma.lost_revenue_record.update({
          where: { id: record.id },
          data: { denial_type: denialType },
        });
        updated++;
        breakdown[denialType] = (breakdown[denialType] || 0) + 1;
      }
    }

    this.logger.log(`Backfilled denial_type for ${updated} records: ${JSON.stringify(breakdown)}`);
    return { updated, breakdown };
  }

  @Cron('0 7 * * *')
  async dailySync() {
    this.logger.log('Starting daily lost revenue sync...');
    const accounts = this.hyggloService.getAccounts();
    for (const account of accounts) {
      try {
        await this.syncObsoleteBookings(account.name, 90);
      } catch (error) {
        this.logger.error(`Daily sync failed for ${account.name}: ${error.message}`);
      }
    }

    // Save/refresh monthly snapshot for current month
    try {
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      await this.saveMonthlySnapshot(periodStart, periodEnd);
      this.logger.log('Monthly snapshot updated.');
    } catch (error) {
      this.logger.error(`Monthly snapshot failed: ${error.message}`);
    }

    this.logger.log('Daily lost revenue sync complete.');
  }

  // ────────────── HELPERS ──────────────

  private getFlexiblePeriodRange(period: string): { start: Date | null; end: Date | null } {
    if (period === 'all') return { start: null, end: null };

    const now = new Date();

    if (period === 'week') {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { start, end: null };
    }

    if (/^\d{4}-\d{2}$/.test(period)) {
      const [year, month] = period.split('-').map(Number);
      return {
        start: new Date(year, month - 1, 1),
        end: new Date(year, month, 1),
      };
    }

    let monthsBack = 3;
    if (period === 'month') monthsBack = 1;
    else if (period === '3m') monthsBack = 3;
    else if (period === '6m') monthsBack = 6;
    else if (period === '12m') monthsBack = 12;

    return {
      start: new Date(now.getFullYear(), now.getMonth() - monthsBack + 1, 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
    };
  }
}
