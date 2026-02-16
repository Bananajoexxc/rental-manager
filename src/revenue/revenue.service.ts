import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService, HyggloAccount } from '../hygglo/hygglo.service';
import { Prisma } from '@prisma/client';
import { isAccessoryItem, MASTER_INVENTORY, findBestMatch, getInventoryItemNames } from '../utils/item-matcher';
import { getOneDayPrice } from '../data/pricing-catalog';
import { HISTORICAL_REVENUE, getHistoricalMonth, getHistoricalStart } from '../data/historical-revenue';
import { getTotalEquipmentValue } from '../data/acquisition-costs';
import { BUNDLE_DEFINITIONS } from '../data/bundle-suggestions';
import { LostRevenueService } from '../lost-revenue/lost-revenue.service';

/** Rental table row used for revenue calculations (captures ALL Hygglo revenue, not just matched items) */
interface RentalRevenueRow {
  id: string;
  listing_id: string;
  title: string;
  renter_info: string | null;
  account: string | null;
  start_date: Date | null;
  end_date: Date | null;
  rental_price: number | null;
  status: string;
  parsed_items: { item: string; qty: number }[] | null;
  /** Effective date for revenue attribution: actual pickup date (when gear goes out), falls back to start_date */
  _effectiveDate: Date;
}

type BookingLifecycle = 'completed' | 'ongoing' | 'upcoming';

/**
 * Pickup-date revenue attribution.
 * Revenue is attributed to the actual pickup date (when gear physically goes out).
 * Falls back to rental start_date if no pickup date is set.
 * This is more accurate than Hygglo booking dates for internal metrics.
 */

@Injectable()
export class RevenueService {
  private readonly logger = new Logger(RevenueService.name);

  /** Cached data-derived baselines (computed once, stored in DB) */
  private baselinesCache: {
    responseCoverage: number;
    offHoursHandling: number;
    followUpRate: number;
    conversionRate: number;
    qualityScore: number;
  } | null = null;

  private static readonly AI_DEPLOY_DATE = new Date('2026-01-29');

  /**
   * Cache for parsed_item name → MASTER_INVENTORY name resolution.
   * Many parsed_items have slight name differences (e.g. "Anamorphic Great Joy 50mm"
   * vs MASTER_INVENTORY's "Anamorphic Great Joy lens 50mm"). Without normalization,
   * revenue for those items goes to the "otherRevenue" bucket and becomes invisible.
   */
  private itemNameCache = new Map<string, string | null>();

  constructor(
    private prisma: PrismaService,
    private hyggloService: HyggloService,
    private lostRevenueService: LostRevenueService,
  ) {}

  /**
   * Normalize a parsed_item name to its MASTER_INVENTORY key.
   * Parsed items come from AI extraction and are CLOSE to inventory names
   * but may have small differences (e.g. missing "lens" word).
   * Uses token-overlap scoring with ALL specific tokens required to match.
   * Caches results for performance.
   */
  private normalizeItemName(parsedName: string): string | null {
    if (MASTER_INVENTORY[parsedName] !== undefined) return parsedName;
    if (this.itemNameCache.has(parsedName)) return this.itemNameCache.get(parsedName)!;

    const inputLower = parsedName.toLowerCase().replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim();
    const inputTokens = inputLower.split(' ');
    const inventoryNames = getInventoryItemNames();

    let bestMatch: string | null = null;
    let bestScore = 0;

    // f-stop pattern for conflict detection (f2.8 vs f4 = different lens)
    const fStopPattern = /^f\d/;
    const inputFStops = inputTokens.filter(t => fStopPattern.test(t));

    // Model number tokens from input (standalone digits like "3", "4", "12")
    const modelNumPattern = /^\d{1,4}$/;
    const inputModelNums = inputTokens.filter(t => modelNumPattern.test(t));
    // Camera model suffix detection (a7s ≠ a7, a7r ≠ a7c)
    const a7Pattern = /^a7([srciv]*)$/;
    const inputA7 = inputTokens.filter(t => a7Pattern.test(t));

    for (const invName of inventoryNames) {
      const invLower = invName.toLowerCase().replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim();
      const invTokens = invLower.split(' ');

      // f-stop conflict: if both have f-numbers and they differ, skip (different lens)
      if (inputFStops.length > 0) {
        const invFStops = invTokens.filter(t => fStopPattern.test(t));
        if (invFStops.length > 0 && !inputFStops.some(f => invFStops.includes(f))) continue;
      }

      // Model number conflict: standalone digits that differ (Mini 3 ≠ Mini 4, GoPro 10 ≠ 12)
      const invModelNums = invTokens.filter(t => modelNumPattern.test(t));
      if (inputModelNums.length > 0 && invModelNums.length > 0) {
        if (!inputModelNums.some(n => invModelNums.includes(n))) continue;
      }

      // Camera model suffix conflict (a7s ≠ a7, a7r ≠ a7)
      const invA7 = invTokens.filter(t => a7Pattern.test(t));
      if (inputA7.length > 0 && invA7.length > 0) {
        if (inputA7[0] !== invA7[0]) continue;
      }

      // Product variant conflict (classic ≠ pro, lite ≠ max)
      const VARIANT_WORDS = ['classic', 'pro', 'plus', 'max', 'lite', 'standard', 'ultra'];
      const inputVars = inputTokens.filter(t => VARIANT_WORDS.includes(t));
      const invVars = invTokens.filter(t => VARIANT_WORDS.includes(t));
      if (inputVars.length > 0 && invVars.length > 0) {
        const common = inputTokens.filter(t => invTokens.includes(t) && !VARIANT_WORDS.includes(t) && t.length >= 2);
        if (common.length >= 2 && !inputVars.some(v => invVars.includes(v))) continue;
      }

      // Count how many input tokens appear in inventory name
      let matched = 0;
      for (const t of inputTokens) {
        if (t.length < 2) continue;
        if (invTokens.some(it => it === t || (t.length >= 4 && it.includes(t)) || (it.length >= 4 && t.includes(it)))) {
          matched++;
        }
      }

      // Require at least 80% of input tokens to match (high precision for revenue)
      const significantTokens = inputTokens.filter(t => t.length >= 2).length;
      const coverage = significantTokens > 0 ? matched / significantTokens : 0;
      if (coverage >= 0.8 && matched > bestScore) {
        bestScore = matched;
        bestMatch = invName;
      }
    }

    this.itemNameCache.set(parsedName, bestMatch);
    return bestMatch;
  }

  /**
   * Derive lifecycle from dates.
   * Accepts both rental rows ({start_date, end_date}) and grouped rentals ({startDate, endDate}).
   */
  private getLifecycle(b: { start_date?: Date | null; end_date?: Date | null; startDate?: Date | null; endDate?: Date | null }): BookingLifecycle {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const start = b.start_date || b.startDate;
    const end = b.end_date || b.endDate;
    if (!start || !end) return 'upcoming';

    if (end < todayStart) return 'completed';
    if (start < todayEnd) return 'ongoing';
    return 'upcoming';
  }

  /**
   * Fetch all rentals with revenue from the RENTAL table (not booking table).
   * The rental table captures ALL Hygglo revenue including items that don't match MASTER_INVENTORY.
   * Booking table misses ~50% of historical revenue because createBookingsFromRental() skips unmatched items.
   * Includes completed + ongoing + upcoming (NOT pending — those aren't accepted yet).
   */
  private async getRentalsWithRevenue(account?: string): Promise<RentalRevenueRow[]> {
    const where: any = {
      status: { in: ['completed', 'ongoing', 'upcoming'] },
      rental_price: { not: null, gt: 0 },
      start_date: { not: null },
    };
    if (account) where.account = account;

    const rentals = await this.prisma.rental.findMany({
      where,
      select: {
        id: true, listing_id: true, title: true, renter_info: true,
        account: true, start_date: true, end_date: true, rental_price: true, status: true,
        parsed_items: true,
        // Get actual pickup date from confirmed bookings (when gear physically goes out)
        bookings: {
          where: { status: 'confirmed' },
          select: { pickup_date: true, return_date: true },
          take: 1,
        },
      },
    });

    // Deduplicate by listing_id + renter_info + start_date (keep highest revenue)
    const seen = new Map<string, RentalRevenueRow>();
    for (const r of rentals) {
      if (!r.start_date || !r.renter_info) continue;
      // Upcoming rentals require at least 1 confirmed booking to count in revenue.
      // Without confirmed bookings, the rental is unvalidated (phantom).
      // Completed/ongoing already happened — rental_price is the truth.
      if (r.status === 'upcoming' && r.bookings.length === 0) continue;
      const key = `${r.listing_id}|${r.renter_info}|${r.start_date.toISOString().split('T')[0]}`;
      const existing = seen.get(key);
      if (!existing || (r.rental_price || 0) > (existing.rental_price || 0)) {
        // Use actual pickup date for revenue attribution; fall back to rental start_date
        const pickupDate = r.bookings?.[0]?.pickup_date;
        seen.set(key, {
          id: r.id,
          listing_id: r.listing_id,
          title: r.title,
          renter_info: r.renter_info,
          account: r.account,
          start_date: r.start_date,
          end_date: r.end_date,
          rental_price: r.rental_price,
          status: r.status,
          parsed_items: r.parsed_items as any,
          _effectiveDate: pickupDate || r.start_date,
        });
      }
    }
    return Array.from(seen.values());
  }

  async recordRevenue(bookingId: string, revenue: number, platformFee = 0, deliveryFee = 0) {
    const netProfit = revenue - platformFee - deliveryFee;
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { revenue, platform_fee: platformFee, delivery_fee: deliveryFee, net_profit: netProfit },
    });
  }

  /**
   * Revenue for a period — from RENTAL table (captures ALL Hygglo revenue).
   * Revenue attributed to actual pickup date (when gear goes out), not Hygglo booking start_date.
   * 'month' = current calendar month, 'week' = last 7 days, 'all' = all time.
   */
  async getRevenueForPeriod(period: 'week' | 'month' | 'all', account?: string) {
    const rentals = await this.getRentalsWithRevenue(account);
    const { start, end } = this.getFlexiblePeriodRange(period);

    const filtered = rentals.filter(r => {
      if (start && r._effectiveDate < start) return false;
      if (end && r._effectiveDate >= end) return false;
      return true;
    });

    const totalEarnings = filtered.reduce((sum, r) => sum + (r.rental_price || 0), 0);
    const visitKeys = new Set<string>();
    for (const r of filtered) {
      const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
      visitKeys.add(`${renterNorm}|${r._effectiveDate.toISOString().split('T')[0]}`);
    }

    return {
      bookings: visitKeys.size,
      totalEarnings: Math.round(totalEarnings * 100) / 100,
      totalRevenue: Math.round(totalEarnings * 100) / 100,
      totalProfit: Math.round(totalEarnings * 100) / 100,
      totalFees: 0,
      totalDelivery: 0,
    };
  }

  /**
   * Weekly revenue totals — from RENTAL table.
   * Revenue attributed to the week of the actual pickup date (when gear goes out).
   */
  async getWeeklyTotals(weeks = 8, account?: string) {
    const rentals = await this.getRentalsWithRevenue(account);
    const results: { week: string; earnings: number; revenue: number; profit: number; count: number }[] = [];
    const now = new Date();

    for (let i = 0; i < weeks; i++) {
      const weekEnd = new Date(now);
      weekEnd.setDate(weekEnd.getDate() - i * 7);
      weekEnd.setHours(23, 59, 59, 999);
      const weekStart = new Date(weekEnd);
      weekStart.setDate(weekStart.getDate() - 6);
      weekStart.setHours(0, 0, 0, 0);

      const weekRentals = rentals.filter(r =>
        r._effectiveDate >= weekStart && r._effectiveDate <= weekEnd
      );

      const earnings = weekRentals.reduce((sum, r) => sum + (r.rental_price || 0), 0);
      const visitKeys = new Set<string>();
      for (const r of weekRentals) {
        const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
        visitKeys.add(`${renterNorm}|${r._effectiveDate.toISOString().split('T')[0]}`);
      }
      results.push({
        week: weekStart.toISOString().split('T')[0],
        earnings: Math.round(earnings * 100) / 100,
        revenue: Math.round(earnings * 100) / 100,
        profit: Math.round(earnings * 100) / 100,
        count: visitKeys.size,
      });
    }

    return results.reverse();
  }

  /**
   * Monthly revenue totals — from RENTAL table.
   * Revenue attributed to the month of the actual pickup date (when gear goes out).
   * Current month includes completed + ongoing + upcoming.
   */
  async getMonthlyTotals(months = 6, account?: string) {
    const rentals = await this.getRentalsWithRevenue(account);
    const results: { month: string; revenue: number; profit: number; count: number; breakdown?: { completed: number; ongoing: number; upcoming: number } }[] = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

      const monthRentals = rentals.filter(r =>
        r._effectiveDate >= monthStart && r._effectiveDate < monthEnd
      );

      const earnings = monthRentals.reduce((sum, r) => sum + (r.rental_price || 0), 0);

      const visitKeys = new Set<string>();
      for (const r of monthRentals) {
        const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
        visitKeys.add(`${renterNorm}|${r._effectiveDate.toISOString().split('T')[0]}`);
      }

      // For current month, include lifecycle breakdown (by visit)
      const isCurrentMonth = i === 0;
      let breakdown: { completed: number; ongoing: number; upcoming: number } | undefined;
      if (isCurrentMonth) {
        const visitMap = new Map<string, { startDate: Date; endDate: Date }>();
        for (const r of monthRentals) {
          const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
          const key = `${renterNorm}|${r._effectiveDate.toISOString().split('T')[0]}`;
          const existing = visitMap.get(key);
          if (existing) {
            if (r.end_date && r.end_date > existing.endDate) existing.endDate = r.end_date;
          } else {
            visitMap.set(key, { startDate: r.start_date!, endDate: r.end_date || r.start_date! });
          }
        }
        const visits = Array.from(visitMap.values());
        breakdown = {
          completed: visits.filter(v => this.getLifecycle({ startDate: v.startDate, endDate: v.endDate }) === 'completed').length,
          ongoing: visits.filter(v => this.getLifecycle({ startDate: v.startDate, endDate: v.endDate }) === 'ongoing').length,
          upcoming: visits.filter(v => this.getLifecycle({ startDate: v.startDate, endDate: v.endDate }) === 'upcoming').length,
        };
      }

      results.push({
        month: monthStart.toISOString().split('T')[0].substring(0, 7),
        revenue: Math.round(earnings * 100) / 100,
        profit: Math.round(earnings * 100) / 100,
        count: visitKeys.size,
        ...(breakdown ? { breakdown } : {}),
      });
    }

    return results.reverse();
  }

  /**
   * Lifetime monthly revenue with cumulative totals — for the growth chart.
   * Returns every month from the first rental to now.
   */
  async getLifetimeRevenue(account?: string): Promise<{
    months: { month: string; revenue: number; cumulative: number; count: number; aiAttribution: number; dbcinemaRevenue: number; leoRevenue: number; danielRevenue: number; vertusRevenue: number; damageRevenue: number; bookedRevenue: number; bookedDbcinema: number; bookedLeo: number }[];
    totalRevenue: number;
    totalMonths: number;
    avgMonthly: number;
    strongestMonth: { month: string; revenue: number } | null;
    weakestMonth: { month: string; revenue: number } | null;
    boostRate: number;
    aiActiveFrom: string;
    targets: { month: string; target: number }[];
  }> {
    const rentals = await this.getRentalsWithRevenue(account);
    const hasHistorical = !account && HISTORICAL_REVENUE.length > 0;
    if (rentals.length === 0 && !hasHistorical) return { months: [], totalRevenue: 0, totalMonths: 0, avgMonthly: 0, strongestMonth: null, weakestMonth: null, boostRate: 0, aiActiveFrom: '2026-02', targets: [], };

    // Find the earliest start_date (include historical data if not filtered by account)
    let earliest = new Date();
    for (const r of rentals) {
      if (r.start_date && r.start_date < earliest) earliest = r.start_date;
    }
    // Extend to cover historical revenue from retired accounts (Daniel, Vertus)
    const histStart = getHistoricalStart();
    if (hasHistorical && histStart) {
      const [hy, hm] = histStart.split('-').map(Number);
      const histDate = new Date(hy, hm - 1, 1);
      if (histDate < earliest) earliest = histDate;
    }

    const now = new Date();
    const startMonth = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
    const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const results: { month: string; revenue: number; cumulative: number; count: number; aiAttribution: number; dbcinemaRevenue: number; leoRevenue: number; danielRevenue: number; vertusRevenue: number; damageRevenue: number; bookedRevenue: number; bookedDbcinema: number; bookedLeo: number }[] = [];
    let cumulative = 0;

    // Get the current AI boost rate for attribution calculation
    const AI_ACTIVE_FROM = '2026-02';
    const { boostRate } = await this.getLatestBoostRate();

    const cursor = new Date(startMonth);
    while (cursor < endMonth) {
      const monthStart = new Date(cursor);
      const monthNext = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);

      // Revenue attributed to pickup date in this month
      const monthRentals = rentals.filter(r =>
        r._effectiveDate >= monthStart && r._effectiveDate < monthNext
      );

      const revenue = monthRentals.reduce((sum, r) => sum + (r.rental_price || 0), 0);
      const visitKeys = new Set<string>();
      for (const r of monthRentals) {
        const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
        visitKeys.add(`${renterNorm}|${r._effectiveDate.toISOString().split('T')[0]}`);
      }

      const rounded = Math.round(revenue * 100) / 100;
      cumulative += rounded;

      // Split revenue by account
      const dbRev = monthRentals.filter(r => r.account === 'dbcinema').reduce((s, r) => s + (r.rental_price || 0), 0);
      const leoRev = monthRentals.filter(r => r.account === 'leo').reduce((s, r) => s + (r.rental_price || 0), 0);
      // Attribute null-account rentals to dbcinema (legacy primary)
      const unattributed = revenue - dbRev - leoRev;

      // AI attribution: only for months >= 2026-02 (when AI went live)
      const monthKey = monthStart.toISOString().split('T')[0].substring(0, 7);
      const aiAttribution = monthKey >= AI_ACTIVE_FROM
        ? Math.round((rounded * boostRate / (1 + boostRate)) * 100) / 100
        : 0;

      results.push({
        month: monthKey,
        revenue: rounded,
        cumulative: Math.round(cumulative * 100) / 100,
        count: visitKeys.size,
        aiAttribution,
        dbcinemaRevenue: Math.round((dbRev + unattributed) * 100) / 100,
        leoRevenue: Math.round(leoRev * 100) / 100,
        danielRevenue: 0,
        vertusRevenue: 0,
        damageRevenue: 0,
        bookedRevenue: 0,
        bookedDbcinema: 0,
        bookedLeo: 0,
      });

      cursor.setMonth(cursor.getMonth() + 1);
    }

    // Merge historical revenue from retired accounts (Daniel, Vertus) + damage costs
    // Only when viewing all accounts (not filtered by specific account)
    if (hasHistorical) {
      let cumulativeAdj = 0;
      for (const entry of results) {
        const hist = getHistoricalMonth(entry.month);
        if (hist) {
          const damageRevenue = hist.damageCosts;

          if (hist.totalOverallMade > 0) {
            // Full historical override: totalOverallMade is the definitive total (payment-date)
            const netRental = hist.totalOverallMade - damageRevenue;
            // Cap tracked revenue to net rental (payment-date vs rental-date timing lag)
            const totalTracked = entry.dbcinemaRevenue + entry.leoRevenue;
            if (totalTracked > netRental) {
              const ratio = netRental / totalTracked;
              entry.dbcinemaRevenue = Math.round(entry.dbcinemaRevenue * ratio * 100) / 100;
              entry.leoRevenue = Math.round(entry.leoRevenue * ratio * 100) / 100;
            }
            const cappedTracked = Math.min(totalTracked, netRental);
            // Remainder after tracked accounts = Daniel + Vertus (split 50/50)
            const remainder = Math.max(0, netRental - cappedTracked);
            const danielShare = Math.round(remainder / 2 * 100) / 100;
            const vertusShare = Math.round((remainder - danielShare) * 100) / 100;
            entry.danielRevenue = danielShare;
            entry.vertusRevenue = vertusShare;
            entry.damageRevenue = damageRevenue;
            entry.revenue = hist.totalOverallMade;
          } else if (damageRevenue > 0) {
            // Damage-only overlay: don't override tracked rental revenue, just add damage
            entry.damageRevenue = damageRevenue;
            entry.revenue += damageRevenue;
          }
        }
        cumulativeAdj += entry.revenue;
        entry.cumulative = Math.round(cumulativeAdj * 100) / 100;
      }
      cumulative = cumulativeAdj;
    }

    // Merge DB-backed insurance claims (is_new=true) into damageRevenue per month
    try {
      const dbClaims = await this.prisma.insurance_claim.findMany({
        where: { is_new: true },
      });
      if (dbClaims.length > 0) {
        const claimsByMonth = new Map<string, number>();
        for (const c of dbClaims) {
          const m = c.claim_date.toISOString().substring(0, 7);
          claimsByMonth.set(m, (claimsByMonth.get(m) || 0) + c.amount);
        }
        let recalcCumulative = 0;
        for (const entry of results) {
          const dbAmount = claimsByMonth.get(entry.month) || 0;
          if (dbAmount > 0) {
            entry.damageRevenue += dbAmount;
            entry.revenue += dbAmount;
          }
          recalcCumulative += entry.revenue;
          entry.cumulative = Math.round(recalcCumulative * 100) / 100;
        }
        cumulative = recalcCumulative;
      }
    } catch { /* DB claims optional */ }

    // Compute stats: avg monthly, strongest month, weakest month
    // Exclude current month from "worst" — it's always incomplete and would always win
    // Exclude first 12 months — early revenue is not representative of mature performance
    const currentMonth = now.toISOString().split('T')[0].substring(0, 7);
    const oneYearAfterStart = new Date(startMonth);
    oneYearAfterStart.setMonth(oneYearAfterStart.getMonth() + 12);
    const matureCutoff = oneYearAfterStart.toISOString().split('T')[0].substring(0, 7);

    const nonZeroMonths = results.filter(m => m.revenue > 0);
    const matureMonths = nonZeroMonths.filter(m => m.month >= matureCutoff);
    const completedMature = matureMonths.filter(m => m.month !== currentMonth);
    const avgMonthly = matureMonths.length > 0
      ? Math.round(matureMonths.reduce((s, m) => s + m.revenue, 0) / matureMonths.length)
      : 0;
    const strongest = matureMonths.length > 0
      ? matureMonths.reduce((best, m) => m.revenue > best.revenue ? m : best)
      : null;
    const weakest = completedMature.length > 0
      ? completedMature.reduce((worst, m) => m.revenue < worst.revenue ? m : worst)
      : null;

    // Revenue targets for current month + next month based on real data
    const targets: { month: string; target: number }[] = [];

    // Current month target: use projection (confirmed + daily rate × remaining)
    const projection = await this.getMonthlyProjection(account);
    targets.push({ month: currentMonth, target: Math.round(projection.projectedMonthEarnings) });

    // Next month target: weighted average of last 3 completed months (most recent = heaviest)
    const completedMonths = results.filter(m => m.month < currentMonth && m.revenue > 0);
    const recent3 = completedMonths.slice(-3);
    let nextTarget = avgMonthly; // fallback
    if (recent3.length >= 3) {
      nextTarget = Math.round(recent3[2].revenue * 0.5 + recent3[1].revenue * 0.3 + recent3[0].revenue * 0.2);
    } else if (recent3.length >= 2) {
      nextTarget = Math.round(recent3[recent3.length - 1].revenue * 0.6 + recent3[recent3.length - 2].revenue * 0.4);
    } else if (recent3.length === 1) {
      nextTarget = Math.round(recent3[0].revenue);
    }
    const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonthKey = nextMonthDate.toISOString().split('T')[0].substring(0, 7);
    targets.push({ month: nextMonthKey, target: nextTarget });

    // Query confirmed bookings for next month to show "already booked" preview
    const nextStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextEnd = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const bookedWhere: any = {
      status: 'confirmed',
      start_date: { gte: nextStart, lt: nextEnd },
      revenue: { gt: 0 },
    };
    if (account) bookedWhere.account = account;
    const booked = await this.prisma.booking.findMany({
      where: bookedWhere,
      select: { revenue: true, account: true },
    });
    const bookedTotal = booked.reduce((s, b) => s + (b.revenue || 0), 0);
    const bookedDb = booked.filter(b => b.account === 'dbcinema' || (!b.account && !account)).reduce((s, b) => s + (b.revenue || 0), 0);
    const bookedLeo = booked.filter(b => b.account === 'leo').reduce((s, b) => s + (b.revenue || 0), 0);

    // Add next month entry to results so the chart has an x-axis label for it
    results.push({
      month: nextMonthKey,
      revenue: 0,
      cumulative: Math.round(cumulative * 100) / 100,
      count: 0,
      aiAttribution: 0,
      dbcinemaRevenue: 0,
      leoRevenue: 0,
      danielRevenue: 0,
      vertusRevenue: 0,
      damageRevenue: 0,
      bookedRevenue: Math.round(bookedTotal * 100) / 100,
      bookedDbcinema: Math.round(bookedDb * 100) / 100,
      bookedLeo: Math.round(bookedLeo * 100) / 100,
    });

    return {
      months: results,
      totalRevenue: Math.round(cumulative * 100) / 100,
      totalMonths: results.length,
      avgMonthly,
      strongestMonth: strongest ? { month: strongest.month, revenue: strongest.revenue } : null,
      weakestMonth: weakest ? { month: weakest.month, revenue: weakest.revenue } : null,
      boostRate,
      aiActiveFrom: AI_ACTIVE_FROM,
      targets,
    };
  }

  /**
   * Expected monthly earnings projection based on:
   * 1. Current month's confirmed earnings so far (completed + ongoing + upcoming)
   * 2. Historical daily average from past 2 completed months
   * 3. Remaining days in the current month × daily average
   *
   * Uses RENTAL table for accurate revenue (captures ALL Hygglo earnings).
   * Groups by renter+date for rental-level breakdown counts.
   */
  async getMonthlyProjection(account?: string): Promise<{
    currentMonthEarnings: number;
    currentMonthRentals: number;
    projectedMonthEarnings: number;
    daysElapsed: number;
    daysRemaining: number;
    dailyAvgEarnings: number;
    breakdown: { completed: number; ongoing: number; upcoming: number };
  }> {
    const allRentals = await this.getRentalsWithRevenue(account);
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const daysInMonth = Math.round((nextMonthStart.getTime() - currentMonthStart.getTime()) / 86400000);
    const daysElapsed = now.getDate();
    const daysRemaining = daysInMonth - daysElapsed;

    // Current month rentals: pickup date in current month
    const currentMonth = allRentals.filter(r =>
      r._effectiveDate >= currentMonthStart && r._effectiveDate < nextMonthStart
    );

    const currentEarnings = currentMonth.reduce((sum, r) => sum + (r.rental_price || 0), 0);

    // Group into rental visits (renter+date = one visit) for breakdown counts
    const rentalGroups = new Map<string, { earnings: number; startDate: Date; endDate: Date }>();
    for (const r of currentMonth) {
      const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const key = `${renterNorm}|${r._effectiveDate.toISOString().split('T')[0]}`;
      const existing = rentalGroups.get(key);
      if (existing) {
        existing.earnings += r.rental_price || 0;
        if (r.start_date! < existing.startDate) existing.startDate = r.start_date!;
        if (r.end_date && r.end_date > existing.endDate) existing.endDate = r.end_date;
      } else {
        rentalGroups.set(key, {
          earnings: r.rental_price || 0,
          startDate: r.start_date!,
          endDate: r.end_date || r.start_date!,
        });
      }
    }
    const visits = Array.from(rentalGroups.values());

    const completed = visits.filter(v => this.getLifecycle({ startDate: v.startDate, endDate: v.endDate }) === 'completed').length;
    const ongoing = visits.filter(v => this.getLifecycle({ startDate: v.startDate, endDate: v.endDate }) === 'ongoing').length;
    const upcoming = visits.filter(v => this.getLifecycle({ startDate: v.startDate, endDate: v.endDate }) === 'upcoming').length;

    // Daily rate = ALL confirmed revenue / days elapsed — goes up with every new booking
    const currentDailyRate = daysElapsed > 0 ? currentEarnings / daysElapsed : 0;

    // Historical data: previous 2 months (by pickup date) — floor for projection
    const prev1Start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prev1End = currentMonthStart;
    const prev2Start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const prev2End = prev1Start;

    const prev1Earnings = allRentals.filter(r => r._effectiveDate >= prev1Start && r._effectiveDate < prev1End)
      .reduce((sum, r) => sum + (r.rental_price || 0), 0);
    const prev2Earnings = allRentals.filter(r => r._effectiveDate >= prev2Start && r._effectiveDate < prev2End)
      .reduce((sum, r) => sum + (r.rental_price || 0), 0);

    const prev1Days = Math.round((prev1End.getTime() - prev1Start.getTime()) / 86400000);
    const prev2Days = Math.round((prev2End.getTime() - prev2Start.getTime()) / 86400000);

    // Historical daily average (weighted: 60% recent, 40% older)
    let historicalDaily: number;
    if (prev1Earnings > 0 && prev2Earnings > 0) {
      historicalDaily = (prev1Earnings / prev1Days) * 0.6 + (prev2Earnings / prev2Days) * 0.4;
    } else if (prev1Earnings > 0) {
      historicalDaily = prev1Earnings / prev1Days;
    } else {
      historicalDaily = 0;
    }

    // Displayed daily avg = current month's actual rate (responsive to new bookings)
    const dailyAvgEarnings = currentDailyRate;

    // Projection uses MAX(current, historical) as the rate — historical is floor
    const projectionRate = Math.max(currentDailyRate, historicalDaily);
    const projectedEarnings = currentEarnings + projectionRate * daysRemaining;

    return {
      currentMonthEarnings: Math.round(currentEarnings * 100) / 100,
      currentMonthRentals: visits.length,
      projectedMonthEarnings: Math.round(projectedEarnings * 100) / 100,
      daysElapsed,
      daysRemaining,
      dailyAvgEarnings: Math.round(dailyAvgEarnings * 100) / 100,
      breakdown: { completed, ongoing, upcoming },
    };
  }

  /**
   * Account breakdown — from RENTAL table. Revenue attributed to pickup date.
   */
  async getAccountBreakdown(period: 'week' | 'month' | 'all', account?: string) {
    const rentals = await this.getRentalsWithRevenue(account);
    const { start, end } = this.getFlexiblePeriodRange(period);

    const filtered = rentals.filter(r => {
      if (start && r._effectiveDate < start) return false;
      if (end && r._effectiveDate >= end) return false;
      return true;
    });

    const byAccount: Record<string, { revenue: number; profit: number; count: number }> = {};
    const visitKeysByAccount: Record<string, Set<string>> = {};
    for (const r of filtered) {
      const acc = r.account || 'unknown';
      if (!byAccount[acc]) { byAccount[acc] = { revenue: 0, profit: 0, count: 0 }; visitKeysByAccount[acc] = new Set(); }
      byAccount[acc].revenue += r.rental_price || 0;
      byAccount[acc].profit += r.rental_price || 0;
      const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
      visitKeysByAccount[acc].add(`${renterNorm}|${r._effectiveDate.toISOString().split('T')[0]}`);
    }
    for (const acc of Object.keys(byAccount)) {
      byAccount[acc].revenue = Math.round(byAccount[acc].revenue * 100) / 100;
      byAccount[acc].profit = Math.round(byAccount[acc].profit * 100) / 100;
      byAccount[acc].count = (visitKeysByAccount[acc] || new Set()).size;
    }

    return byAccount;
  }

  /**
   * Distribute a booking's revenue proportionally based on each item's daily catalog price.
   * If a bundle has FX3 (£40/day) + lens (£20/day), FX3 gets 2/3 of the revenue.
   * Falls back to equal split if catalog prices aren't available.
   */
  private distributeRevenueProportionally(
    items: { item_name: string; qty?: number }[],
    totalRevenue: number,
  ): { item_name: string; attributedRevenue: number; qty: number }[] {
    const mainItems = items.filter(i => !isAccessoryItem(i.item_name));
    if (mainItems.length === 0) return [];
    if (mainItems.length === 1) {
      return [{ item_name: mainItems[0].item_name, attributedRevenue: totalRevenue, qty: mainItems[0].qty || 1 }];
    }

    // Multiple items — distribute proportionally by qty × catalog daily price
    const priced = mainItems.map(i => {
      const qty = i.qty || 1;
      const unitPrice = getOneDayPrice(i.item_name) || 0;
      return {
        item_name: i.item_name,
        qty,
        weightedPrice: qty * unitPrice, // 3x GoPro @ £15/day = £45 weight
      };
    });
    const totalWeightedValue = priced.reduce((sum, p) => sum + p.weightedPrice, 0);

    return priced.map(p => ({
      item_name: p.item_name,
      qty: p.qty,
      attributedRevenue: totalWeightedValue > 0
        ? totalRevenue * (p.weightedPrice / totalWeightedValue)
        : totalRevenue / priced.length,
    }));
  }

  /**
   * Top earning items with proportional bundle attribution.
   * Uses parsed_items from rental table (AI-parsed, covers 100% of revenue).
   * Supports flexible periods: 'week', 'month', '3m', '6m', '12m', 'all',
   * or a specific month string like '2025-11'.
   */
  async getTopEarningItems(
    period: string = 'month',
    account?: string,
    limit: number = 10,
  ): Promise<{ item: string; profit: number; revenue: number; count: number; avgPerRental: number }[]> {
    const rentals = await this.getRentalsWithRevenue(account);
    const { start, end } = this.getFlexiblePeriodRange(period);

    const periodFiltered = rentals.filter(r => {
      if (start && r._effectiveDate < start) return false;
      if (end && r._effectiveDate >= end) return false;
      return true;
    });

    // Split: rentals with parsed items vs without
    const filtered = periodFiltered.filter(r => r.parsed_items && (r.parsed_items as any[]).length > 0);
    const noParsedItems = periodFiltered.filter(r => !r.parsed_items || (r.parsed_items as any[]).length === 0);

    // Distribute revenue proportionally for each rental using parsed_items
    const byItem: Record<string, { profit: number; revenue: number; count: number }> = {};
    const byRetired: Record<string, { profit: number; revenue: number; count: number }> = {};
    // Revenue from rentals with no parsed_items goes straight to otherRevenue
    let otherRevenue = noParsedItems.reduce((sum, r) => sum + (r.rental_price || 0), 0);
    for (const r of filtered) {
      const items = (r.parsed_items as { item: string; qty: number }[])
        .map(p => ({ item_name: this.normalizeItemName(p.item) || p.item, qty: p.qty || 1 }));
      const attributed = this.distributeRevenueProportionally(items, r.rental_price || 0);
      for (const a of attributed) {
        if (!MASTER_INVENTORY[a.item_name]) {
          // Track retired/old items separately from truly unmatched revenue
          if (!byRetired[a.item_name]) byRetired[a.item_name] = { profit: 0, revenue: 0, count: 0 };
          byRetired[a.item_name].profit += a.attributedRevenue;
          byRetired[a.item_name].revenue += a.attributedRevenue;
          byRetired[a.item_name].count += a.qty;
          continue;
        }
        if (!byItem[a.item_name]) byItem[a.item_name] = { profit: 0, revenue: 0, count: 0 };
        byItem[a.item_name].profit += a.attributedRevenue;
        byItem[a.item_name].revenue += a.attributedRevenue;
        byItem[a.item_name].count += a.qty;
      }
    }

    const items = Object.entries(byItem)
      .map(([item, data]) => ({
        item,
        profit: Math.round(data.profit * 100) / 100,
        revenue: Math.round(data.revenue * 100) / 100,
        count: data.count,
        avgPerRental: data.count > 0 ? Math.round((data.profit / data.count) * 100) / 100 : 0,
      }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, limit);

    const retiredItems = Object.entries(byRetired)
      .map(([item, data]) => ({
        item,
        profit: Math.round(data.profit * 100) / 100,
        revenue: Math.round(data.revenue * 100) / 100,
        count: data.count,
        avgPerRental: data.count > 0 ? Math.round((data.profit / data.count) * 100) / 100 : 0,
      }))
      .filter(i => i.profit > 0) // Only show items with actual attributed revenue
      .sort((a, b) => b.profit - a.profit);

    // Ensure displayed items + retiredItems + otherRevenue = total period revenue (no revenue lost)
    const totalPeriodRevenue = periodFiltered.reduce((sum, r) => sum + (r.rental_price || 0), 0);
    const displayedTotal = items.reduce((sum, i) => sum + i.profit, 0);
    const retiredTotal = retiredItems.reduce((sum, i) => sum + i.profit, 0);
    otherRevenue = totalPeriodRevenue - displayedTotal - retiredTotal;

    return { items, retiredItems, otherRevenue: Math.round(otherRevenue * 100) / 100, totalRevenue: Math.round(totalPeriodRevenue * 100) / 100 } as any;
  }

  /**
   * All items revenue breakdown — full list, not just top 10.
   * Uses parsed_items from rental table (AI-parsed, covers 100% of revenue).
   * Includes monthly breakdown for each item.
   * Also tracks unmatched items (not in MASTER_INVENTORY) with their revenue.
   */
  async getItemRevenueBreakdown(
    period: string = '6m',
    account?: string,
  ): Promise<{
    items: {
      item: string;
      totalRevenue: number;
      totalCount: number;
      avgPerRental: number;
      monthlyBreakdown: { month: string; revenue: number; count: number }[];
    }[];
    unmatchedItems: { item: string; totalRevenue: number; totalCount: number }[];
    period: string;
    totalRevenue: number;
    otherRevenue: number;
  }> {
    const rentals = await this.getRentalsWithRevenue(account);
    const { start, end } = this.getFlexiblePeriodRange(period);

    const periodFiltered = rentals.filter(r => {
      if (start && r._effectiveDate < start) return false;
      if (end && r._effectiveDate >= end) return false;
      return true;
    });

    const filtered = periodFiltered.filter(r => r.parsed_items && (r.parsed_items as any[]).length > 0);
    const noParsedItems = periodFiltered.filter(r => !r.parsed_items || (r.parsed_items as any[]).length === 0);

    // Distribute and accumulate with monthly breakdown
    const byItem: Record<string, {
      totalRevenue: number;
      totalCount: number;
      months: Record<string, { revenue: number; count: number }>;
    }> = {};
    // Track items not in MASTER_INVENTORY separately (sold/removed/untracked equipment)
    const byUnmatched: Record<string, { totalRevenue: number; totalCount: number }> = {};
    let otherRevenue = noParsedItems.reduce((sum, r) => sum + (r.rental_price || 0), 0);

    for (const r of filtered) {
      const month = r._effectiveDate.toISOString().substring(0, 7);
      const items = (r.parsed_items as { item: string; qty: number }[])
        .map(p => ({ item_name: this.normalizeItemName(p.item) || p.item, originalName: p.item, qty: p.qty || 1 }));
      // Build name→originalName lookup (distributeRevenueProportionally filters accessories,
      // so attributed array indices DON'T align with items array indices)
      const nameToOriginal = new Map(items.map(i => [i.item_name, i.originalName]));
      const attributed = this.distributeRevenueProportionally(
        items.map(i => ({ item_name: i.item_name, qty: i.qty })),
        r.rental_price || 0,
      );
      for (const a of attributed) {
        // Only include items that exist in MASTER_INVENTORY
        if (!MASTER_INVENTORY[a.item_name]) {
          // Track unmatched item by its original parsed name
          const origName = nameToOriginal.get(a.item_name) || a.item_name;
          if (!byUnmatched[origName]) byUnmatched[origName] = { totalRevenue: 0, totalCount: 0 };
          byUnmatched[origName].totalRevenue += a.attributedRevenue;
          byUnmatched[origName].totalCount += a.qty;
          continue;
        }
        if (!byItem[a.item_name]) byItem[a.item_name] = { totalRevenue: 0, totalCount: 0, months: {} };
        byItem[a.item_name].totalRevenue += a.attributedRevenue;
        byItem[a.item_name].totalCount += a.qty;
        if (!byItem[a.item_name].months[month]) byItem[a.item_name].months[month] = { revenue: 0, count: 0 };
        byItem[a.item_name].months[month].revenue += a.attributedRevenue;
        byItem[a.item_name].months[month].count += a.qty;
      }
    }

    // Ensure items + unmatched + otherRevenue = total period revenue (no revenue lost)
    const totalPeriodRevenue = periodFiltered.reduce((sum, r) => sum + (r.rental_price || 0), 0);
    const attributedTotal = Object.values(byItem).reduce((sum, i) => sum + i.totalRevenue, 0);
    const unmatchedTotal = Object.values(byUnmatched).reduce((sum, i) => sum + i.totalRevenue, 0);
    otherRevenue = totalPeriodRevenue - attributedTotal - unmatchedTotal;

    const items = Object.entries(byItem)
      .map(([item, data]) => ({
        item,
        totalRevenue: Math.round(data.totalRevenue * 100) / 100,
        totalCount: data.totalCount,
        avgPerRental: data.totalCount > 0 ? Math.round((data.totalRevenue / data.totalCount) * 100) / 100 : 0,
        monthlyBreakdown: Object.entries(data.months)
          .map(([month, md]) => ({
            month,
            revenue: Math.round(md.revenue * 100) / 100,
            count: md.count,
          }))
          .sort((a, b) => a.month.localeCompare(b.month)),
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    const unmatchedItems = Object.entries(byUnmatched)
      .map(([item, data]) => ({
        item,
        totalRevenue: Math.round(data.totalRevenue * 100) / 100,
        totalCount: data.totalCount,
      }))
      .filter(i => i.totalRevenue >= 10) // only show items worth £10+
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    return {
      items,
      unmatchedItems,
      period,
      totalRevenue: Math.round(totalPeriodRevenue * 100) / 100,
      otherRevenue: Math.round(Math.max(otherRevenue, 0) * 100) / 100,
    };
  }

  async getFormattedRevenue(period: 'week' | 'month' | 'all'): Promise<string> {
    const [summary, accounts, topItems, weekly] = await Promise.all([
      this.getRevenueForPeriod(period),
      this.getAccountBreakdown(period),
      this.getTopEarningItems(period),
      period === 'week' ? this.getWeeklyTotals(4) : this.getWeeklyTotals(8),
    ]);

    const lines: string[] = [`Profit Summary (${period}):`];
    lines.push(`Bookings: ${summary.bookings}`);
    lines.push(`Profit: £${summary.totalProfit}`);

    if (Object.keys(accounts).length > 0) {
      lines.push('\nBy Account:');
      for (const [acc, data] of Object.entries(accounts)) {
        lines.push(`  ${acc}: £${Math.round(data.profit * 100) / 100} profit, ${data.count} bookings`);
      }
    }

    if (topItems.length > 0) {
      lines.push('\nTop Items:');
      for (const item of topItems.slice(0, 5)) {
        lines.push(`  £${Math.round(item.profit * 100) / 100} - ${item.item} (${item.count}x)`);
      }
    }

    if (weekly.length > 0) {
      const maxRev = Math.max(...weekly.map((w) => w.profit), 1);
      lines.push('\nWeekly Trend:');
      for (const w of weekly) {
        const barLen = Math.round((w.profit / maxRev) * 20);
        const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
        lines.push(`  ${w.week} ${bar} £${w.profit}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Track a revenue metric event for the autolearn engine.
   */
  async trackRevenueMetric(data: {
    rentalId?: string;
    metricType: 'booking_revenue' | 'upsell_revenue' | 'discount_applied' | 'delivery_fee' | 'platform_fee';
    amount: number;
    account?: string;
    metadata?: Record<string, any>;
    periodStart?: Date;
    periodEnd?: Date;
  }): Promise<void> {
    await this.prisma.revenue_metric.create({
      data: {
        rental_id: data.rentalId,
        metric_type: data.metricType,
        amount: data.amount,
        account: data.account,
        metadata: data.metadata || undefined,
        period_start: data.periodStart,
        period_end: data.periodEnd,
      },
    });
  }

  /**
   * Get revenue metrics summary for the autolearn engine.
   */
  async getRevenueMetrics(days: number = 30): Promise<{
    totalBookingRevenue: number;
    totalUpsellRevenue: number;
    totalDiscountsApplied: number;
    totalDeliveryFees: number;
    totalPlatformFees: number;
    metricCount: number;
    byAccount: Record<string, number>;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const metrics = await this.prisma.revenue_metric.findMany({
      where: { created_at: { gte: since } },
    });

    const byType: Record<string, number> = {};
    const byAccount: Record<string, number> = {};

    for (const m of metrics) {
      byType[m.metric_type] = (byType[m.metric_type] || 0) + m.amount;
      if (m.account) {
        byAccount[m.account] = (byAccount[m.account] || 0) + m.amount;
      }
    }

    return {
      totalBookingRevenue: Math.round((byType['booking_revenue'] || 0) * 100) / 100,
      totalUpsellRevenue: Math.round((byType['upsell_revenue'] || 0) * 100) / 100,
      totalDiscountsApplied: Math.round((byType['discount_applied'] || 0) * 100) / 100,
      totalDeliveryFees: Math.round((byType['delivery_fee'] || 0) * 100) / 100,
      totalPlatformFees: Math.round((byType['platform_fee'] || 0) * 100) / 100,
      metricCount: metrics.length,
      byAccount,
    };
  }

  async getFormattedRevenueMetrics(days: number = 30): Promise<string> {
    const metrics = await this.getRevenueMetrics(days);
    const lines: string[] = [`Revenue Metrics (last ${days} days):`];
    lines.push(`Booking revenue: £${metrics.totalBookingRevenue}`);
    lines.push(`Upsell revenue: £${metrics.totalUpsellRevenue}`);
    lines.push(`Discounts applied: -£${metrics.totalDiscountsApplied}`);
    lines.push(`Delivery fees: £${metrics.totalDeliveryFees}`);
    lines.push(`Platform fees: -£${metrics.totalPlatformFees}`);
    if (Object.keys(metrics.byAccount).length > 0) {
      lines.push('\nBy Account:');
      for (const [acc, total] of Object.entries(metrics.byAccount)) {
        lines.push(`  ${acc}: £${Math.round(total * 100) / 100}`);
      }
    }
    return lines.join('\n');
  }

  // --- Pre-AI baseline fallbacks (used only when real data is insufficient) ---
  private static readonly BASELINE_FALLBACKS = {
    responseCoverage: 0.65,    // fallback: 65% of messages got manual replies
    offHoursHandling: 0,       // correct: 0% off-hours replies (manual = daytime only)
    followUpRate: 0,           // correct: 0 automated follow-ups
    conversionRate: 0.10,      // fallback: 10% industry average
    qualityScore: 0.70,        // fallback: 70% estimated manual reply quality
  };

  /**
   * Compute pre-AI conversion rate from real data.
   * Formula: confirmed_rentals / (confirmed_rentals + lost_revenue_records) for pre-AI period.
   */
  private async computeConversionBaseline(): Promise<{ rate: number; dataPoints: number; source: string }> {
    const aiDeploy = RevenueService.AI_DEPLOY_DATE;

    const [confirmedCount, lostCount] = await Promise.all([
      this.prisma.rental.count({
        where: {
          status: { in: ['completed', 'ongoing', 'upcoming'] },
          rental_price: { gt: 0 },
          start_date: { lt: aiDeploy },
        },
      }),
      this.prisma.lost_revenue_record.count({
        where: { start_date: { lt: aiDeploy } },
      }),
    ]);

    const total = confirmedCount + lostCount;
    if (total < 20) {
      return { rate: RevenueService.BASELINE_FALLBACKS.conversionRate, dataPoints: total, source: 'fallback (< 20 data points)' };
    }

    const rate = Math.round((confirmedCount / total) * 1000) / 1000;
    return { rate, dataPoints: total, source: `${confirmedCount} confirmed / ${total} total (pre-AI)` };
  }

  /**
   * Compute quality baseline as P25 of all measured AI quality scores.
   * P25 approximates human-level quality (bottom quartile of AI performance).
   */
  private async computeQualityBaseline(): Promise<{ score: number; dataPoints: number; source: string }> {
    const result = await this.prisma.$queryRaw<[{ p25: number | null; cnt: number }]>`
      SELECT
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY overall_quality)::float as p25,
        COUNT(*)::int as cnt
      FROM response_quality
      WHERE overall_quality IS NOT NULL
    `;

    const p25 = result[0]?.p25;
    const cnt = result[0]?.cnt || 0;

    if (p25 === null || cnt === 0) {
      return { score: RevenueService.BASELINE_FALLBACKS.qualityScore, dataPoints: 0, source: 'fallback (no quality data)' };
    }

    const score = Math.round(p25 * 1000) / 1000;
    return { score, dataPoints: cnt, source: `P25 of ${cnt} quality scores` };
  }

  /**
   * Analyze historical Hygglo chat data to compute pre-AI response coverage.
   * Fetches completed orders, analyzes activities to find renter message sequences
   * and whether they got owner replies.
   */
  private async analyzeHistoricalResponseRate(): Promise<{ rate: number; ordersAnalyzed: number; source: string }> {
    const accounts: HyggloAccount[] = ['dbcinema', 'leo'];
    let totalSequences = 0;
    let repliedSequences = 0;
    let ordersAnalyzed = 0;

    for (const account of accounts) {
      try {
        const orders = await this.hyggloService.scanCompletedRentalsPaginated(account, 50);

        for (const order of orders) {
          const activities: any[] = order._detail?.activities || [];
          const chatMessages = activities
            .filter((a: any) => a.chatMessage?.text?.content)
            .map((a: any) => ({ byMe: !!a.chatMessage.byMe }));

          if (chatMessages.length < 2) continue; // Need at least a renter msg + potential reply
          ordersAnalyzed++;

          // Identify renter message sequences (byMe=false from owner perspective = renter sent it)
          let inRenterSequence = false;
          for (let i = 0; i < chatMessages.length; i++) {
            const msg = chatMessages[i];
            if (!msg.byMe) {
              // Renter message
              if (!inRenterSequence) {
                inRenterSequence = true;
                totalSequences++;
              }
            } else {
              // Owner reply
              if (inRenterSequence) {
                repliedSequences++;
                inRenterSequence = false;
              }
            }
          }
          // If conversation ended with unanswered renter sequence, it stays uncounted as replied
        }
      } catch (err) {
        this.logger.warn(`Failed to analyze response rate for ${account}: ${err.message}`);
      }
    }

    if (ordersAnalyzed < 10 || totalSequences === 0) {
      return { rate: RevenueService.BASELINE_FALLBACKS.responseCoverage, ordersAnalyzed, source: 'fallback (< 10 orders analyzable)' };
    }

    const rate = Math.round((repliedSequences / totalSequences) * 1000) / 1000;
    return { rate, ordersAnalyzed, source: `${repliedSequences}/${totalSequences} sequences replied across ${ordersAnalyzed} orders` };
  }

  /**
   * Get data-derived baselines (cached in memory, persisted in DB).
   * Replaces the old static PRE_AI_BASELINES.
   */
  private async getBaselines(): Promise<{
    responseCoverage: number;
    offHoursHandling: number;
    followUpRate: number;
    conversionRate: number;
    qualityScore: number;
  }> {
    // Memory cache hit
    if (this.baselinesCache) return this.baselinesCache;

    // Try loading from DB
    const stored = await this.prisma.ai_decision.findMany({
      where: { decision_type: { in: ['baseline_conversion_rate', 'baseline_quality_score', 'baseline_response_coverage'] } },
      orderBy: { created_at: 'desc' },
    });

    const conversionRow = stored.find(r => r.decision_type === 'baseline_conversion_rate');
    const qualityRow = stored.find(r => r.decision_type === 'baseline_quality_score');
    const coverageRow = stored.find(r => r.decision_type === 'baseline_response_coverage');

    let conversionRate = conversionRow?.confidence ?? null;
    let qualityScore = qualityRow?.confidence ?? null;
    let responseCoverage = coverageRow?.confidence ?? null;

    // Compute any missing baselines
    if (conversionRate === null) {
      const result = await this.computeConversionBaseline();
      conversionRate = result.rate;
      await this.storeBaseline('baseline_conversion_rate', result.rate, result.source, result.dataPoints);
    }
    if (qualityScore === null) {
      const result = await this.computeQualityBaseline();
      qualityScore = result.score;
      await this.storeBaseline('baseline_quality_score', result.score, result.source, result.dataPoints);
    }
    if (responseCoverage === null) {
      const result = await this.analyzeHistoricalResponseRate();
      responseCoverage = result.rate;
      await this.storeBaseline('baseline_response_coverage', result.rate, result.source, result.ordersAnalyzed);
    }

    this.baselinesCache = {
      responseCoverage,
      offHoursHandling: 0,
      followUpRate: 0,
      conversionRate,
      qualityScore,
    };

    return this.baselinesCache;
  }

  /** Store a computed baseline in ai_decision for persistence. */
  private async storeBaseline(type: string, value: number, source: string, dataPoints: number): Promise<void> {
    await this.prisma.ai_decision.create({
      data: {
        decision_type: type,
        input_summary: `Baseline calculation: ${type}`,
        output_summary: JSON.stringify({ value, source, dataPoints, calculatedAt: new Date().toISOString() }),
        confidence: value,
        action_taken: `${type} = ${value} (${source})`,
        notified: false,
      },
    });
  }

  /**
   * Force-recalculate all 3 data-derived baselines.
   * Clears cache, recomputes from source data, stores in DB.
   */
  async calibrateBaselines(): Promise<{
    conversionRate: { value: number; dataPoints: number; source: string };
    qualityScore: { value: number; dataPoints: number; source: string };
    responseCoverage: { value: number; ordersAnalyzed: number; source: string };
    calibratedAt: string;
  }> {
    this.baselinesCache = null;

    const [conversion, quality, coverage] = await Promise.all([
      this.computeConversionBaseline(),
      this.computeQualityBaseline(),
      this.analyzeHistoricalResponseRate(),
    ]);

    // Store all 3 fresh baselines
    await Promise.all([
      this.storeBaseline('baseline_conversion_rate', conversion.rate, conversion.source, conversion.dataPoints),
      this.storeBaseline('baseline_quality_score', quality.score, quality.source, quality.dataPoints),
      this.storeBaseline('baseline_response_coverage', coverage.rate, coverage.source, coverage.ordersAnalyzed),
    ]);

    // Update cache
    this.baselinesCache = {
      responseCoverage: coverage.rate,
      offHoursHandling: 0,
      followUpRate: 0,
      conversionRate: conversion.rate,
      qualityScore: quality.score,
    };

    return {
      conversionRate: { value: conversion.rate, dataPoints: conversion.dataPoints, source: conversion.source },
      qualityScore: { value: quality.score, dataPoints: quality.dataPoints, source: quality.source },
      responseCoverage: { value: coverage.rate, ordersAnalyzed: coverage.ordersAnalyzed, source: coverage.source },
      calibratedAt: new Date().toISOString(),
    };
  }

  /**
   * Weekly cron: Self-evaluate AI boost rate by measuring actual performance
   * against pre-AI baselines. Stores result in ai_decision table.
   * Runs every Monday at 3am.
   */
  @Cron('0 3 * * 1')
  async weeklyAiBoostEvaluation(): Promise<void> {
    this.logger.log('=== WEEKLY AI BOOST EVALUATION: Starting ===');
    try {
      const evaluation = await this.evaluateAiPerformance();
      await this.storeBoostEvaluation(evaluation);
      this.logger.log(`AI Boost evaluation: ${(evaluation.boostRate * 100).toFixed(1)}% (${evaluation.factors.map(f => `${f.name}: ${(f.rate * 100).toFixed(1)}%`).join(', ')})`);
    } catch (err) {
      this.logger.error(`AI Boost evaluation failed: ${err.message}`);
    }
  }

  /**
   * Evaluate AI performance from actual system data over the last 7 days.
   * Compares against pre-AI baselines to derive a dynamic boost rate.
   */
  async evaluateAiPerformance(): Promise<{
    boostRate: number;
    factors: { name: string; rate: number; measured: number; baseline: number; description: string }[];
    evaluatedAt: string;
    dataPoints: number;
  }> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const baselines = await this.getBaselines();

    // 1. RESPONSE COVERAGE — what % of renter messages got AI responses?
    const messageDecisions = await this.prisma.ai_decision.count({
      where: { decision_type: 'message', created_at: { gte: weekAgo } },
    });
    const totalConversations = await this.prisma.follow_up_state.count({
      where: { last_renter_message_at: { gte: weekAgo } },
    });
    const aiResponseCoverage = totalConversations > 0
      ? Math.min(messageDecisions / totalConversations, 1.0)
      : 0.95; // default if no data
    // Boost from coverage improvement: AI handles more messages → more potential conversions
    const coverageLift = Math.max(0, (aiResponseCoverage - baselines.responseCoverage) / baselines.responseCoverage);
    const speedRate = Math.min(coverageLift * 0.20, 0.18); // cap at 18%

    // 2. OFF-HOURS AVAILABILITY — what % of AI responses were outside 9am-6pm?
    const offHoursDecisions = await this.prisma.$queryRaw<[{ cnt: number }]>`
      SELECT COUNT(*)::int as cnt FROM ai_decision
      WHERE decision_type = 'message' AND created_at >= ${weekAgo}
        AND (EXTRACT(HOUR FROM created_at) < 9 OR EXTRACT(HOUR FROM created_at) >= 18
             OR EXTRACT(DOW FROM created_at) IN (0, 6))
    `;
    const offHoursCount = offHoursDecisions[0]?.cnt || 0;
    const offHoursRate = messageDecisions > 0 ? offHoursCount / messageDecisions : 0.25;
    // Every off-hours response is a conversion the human couldn't have made
    const availabilityRate = Math.min(offHoursRate * 0.25, 0.10); // cap at 10%

    // 3. FOLLOW-UP EFFECTIVENESS — how many follow-ups sent, and what % of conversations progressed?
    const withFollowups = await this.prisma.follow_up_state.count({
      where: { followup_count: { gt: 0 } },
    });
    const totalStates = await this.prisma.follow_up_state.count();
    const followUpEngagement = totalStates > 0 ? withFollowups / totalStates : 0;
    // Conversations that progressed past INQUIRY (would have gone cold without follow-ups)
    const progressedPastInquiry = await this.prisma.follow_up_state.count({
      where: { conversation_stage: { notIn: ['inquiry', 'dead'] } },
    });
    const progressionRate = totalStates > 0 ? progressedPastInquiry / totalStates : 0;
    const followUpRate = Math.min(followUpEngagement * progressionRate * 0.40, 0.12); // cap at 12%

    // 4. CONVERSION FUNNEL — actual conversion rate vs funnel snapshot baseline (or pre-AI fallback)
    const confirmedStages = await this.prisma.follow_up_state.count({
      where: { conversation_stage: { in: ['confirmed', 'completed', 'booked'] } },
    });
    const actualConversion = totalStates > 0 ? confirmedStages / totalStates : baselines.conversionRate;
    // Prefer real funnel snapshot data over pre-AI estimate
    // Use earliest snapshot with actual conversation data (total > 0)
    const earliestSnapshot = await this.prisma.funnel_snapshot.findFirst({
      where: { account: null, total: { gt: 0 } },
      orderBy: { period_start: 'asc' },
    });
    const baselineConversion = earliestSnapshot
      ? earliestSnapshot.conversion_rate
      : baselines.conversionRate;
    const conversionBaselineSource = earliestSnapshot
      ? `funnel log ${earliestSnapshot.period_start.toISOString().substring(0, 7)}`
      : 'data-derived';
    const conversionLift = Math.max(0, (actualConversion - baselineConversion) / Math.max(baselineConversion, 0.01));
    const conversionRate = Math.min(conversionLift * 0.10, 0.08); // cap at 8%

    // 5. QUALITY SCORE — from response_quality table
    const qualityAvg = await this.prisma.$queryRaw<[{ avg: number | null }]>`
      SELECT AVG(overall_quality)::float as avg FROM response_quality
      WHERE created_at >= ${weekAgo} AND overall_quality IS NOT NULL
    `;
    const aiQuality = qualityAvg[0]?.avg || 0.85;
    const qualityLift = Math.max(0, (aiQuality - baselines.qualityScore) / baselines.qualityScore);
    // Higher quality → fewer lost deals from bad responses
    const qualityRate = Math.min(qualityLift * 0.05, 0.05); // cap at 5%

    // 6. MISSED REVENUE RECOVERY — denied + expired revenue that AI instant service would capture
    let missedRecoveryRate = 0;
    let missedRevTotal = 0;
    let missedRevCount = 0;
    try {
      const [denied, expired] = await Promise.all([
        this.lostRevenueService.getDeniedRevenueSummary('3m'),
        this.prisma.lost_revenue_record.aggregate({
          where: {
            denial_type: { in: ['owner_denied', 'expired'] },
            lost_revenue: { gte: 25 },
            start_date: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
          },
          _sum: { lost_revenue: true },
          _count: true,
        }),
      ]);
      missedRevTotal = (expired._sum.lost_revenue || 0);
      missedRevCount = expired._count || 0;
      // What fraction of actual revenue do missed opportunities represent?
      // AI would capture ~60% of these (some renters wouldn't convert regardless)
      const monthlyActual = await this.prisma.rental.aggregate({
        where: {
          status: { in: ['completed', 'ongoing', 'upcoming'] },
          rental_price: { gt: 0 },
          start_date: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
        },
        _sum: { rental_price: true },
      });
      const actualRev3m = monthlyActual._sum.rental_price || 1;
      const recoveryRatio = missedRevTotal / actualRev3m;
      // AI would recover ~60% of missed revenue, capped at 15% boost contribution
      missedRecoveryRate = Math.min(recoveryRatio * 0.60, 0.15);
    } catch (err) {
      this.logger.debug(`Missed revenue recovery calc failed: ${err.message}`);
    }

    const boostRate = Math.round((speedRate + availabilityRate + followUpRate + conversionRate + qualityRate + missedRecoveryRate) * 100) / 100;
    const dataPoints = messageDecisions + totalStates;

    return {
      boostRate: Math.max(0.05, Math.min(boostRate, 0.50)), // floor 5%, cap 50%
      factors: [
        { name: 'Response Speed', rate: Math.round(speedRate * 100) / 100, measured: Math.round(aiResponseCoverage * 100) / 100, baseline: baselines.responseCoverage, description: `${Math.round(aiResponseCoverage * 100)}% coverage vs ${Math.round(baselines.responseCoverage * 100)}% pre-AI (data-derived)` },
        { name: '24/7 Availability', rate: Math.round(availabilityRate * 100) / 100, measured: Math.round(offHoursRate * 100) / 100, baseline: baselines.offHoursHandling, description: `${Math.round(offHoursRate * 100)}% off-hours responses` },
        { name: 'Auto Follow-ups', rate: Math.round(followUpRate * 100) / 100, measured: Math.round(followUpEngagement * 100) / 100, baseline: baselines.followUpRate, description: `${Math.round(followUpEngagement * 100)}% conversations got follow-ups, ${Math.round(progressionRate * 100)}% progressed` },
        { name: 'Conversion Lift', rate: Math.round(conversionRate * 100) / 100, measured: Math.round(actualConversion * 100) / 100, baseline: baselineConversion, description: `${Math.round(actualConversion * 100)}% conversion vs ${Math.round(baselineConversion * 100)}% month-1 (${conversionBaselineSource})` },
        { name: 'Quality Premium', rate: Math.round(qualityRate * 100) / 100, measured: Math.round(aiQuality * 100) / 100, baseline: baselines.qualityScore, description: `${Math.round(aiQuality * 100)}% quality vs ${Math.round(baselines.qualityScore * 100)}% pre-AI (data-derived)` },
        { name: 'Missed Revenue Recovery', rate: Math.round(missedRecoveryRate * 100) / 100, measured: Math.round(missedRevTotal), baseline: 0, description: `£${Math.round(missedRevTotal)} from ${missedRevCount} denied/expired requests (3mo) — AI instant response would recover ~60%` },
      ],
      evaluatedAt: new Date().toISOString(),
      dataPoints,
    };
  }

  /** Store evaluation result in ai_decision table for persistence. */
  async storeBoostEvaluation(evaluation: Awaited<ReturnType<typeof this.evaluateAiPerformance>>): Promise<void> {
    await this.prisma.ai_decision.create({
      data: {
        decision_type: 'ai_boost_evaluation',
        input_summary: `Weekly AI boost evaluation (${evaluation.dataPoints} data points)`,
        output_summary: JSON.stringify(evaluation),
        confidence: evaluation.boostRate,
        action_taken: `Boost rate: ${(evaluation.boostRate * 100).toFixed(1)}%`,
        notified: false,
      },
    });
  }

  /** Get the latest stored evaluation, or run a fresh one if none exists. */
  private async getLatestBoostRate(): Promise<{
    boostRate: number;
    factors: { name: string; rate: number; description: string }[];
  }> {
    const latest = await this.prisma.ai_decision.findFirst({
      where: { decision_type: 'ai_boost_evaluation' },
      orderBy: { created_at: 'desc' },
    });

    if (latest?.output_summary) {
      try {
        const eval_ = JSON.parse(latest.output_summary);
        return {
          boostRate: eval_.boostRate,
          factors: eval_.factors.map((f: any) => ({ name: f.name, rate: f.rate, description: f.description })),
        };
      } catch { /* fall through to fresh eval */ }
    }

    // No stored evaluation — run one now
    const fresh = await this.evaluateAiPerformance();
    await this.storeBoostEvaluation(fresh);
    return {
      boostRate: fresh.boostRate,
      factors: fresh.factors.map(f => ({ name: f.name, rate: f.rate, description: f.description })),
    };
  }

  /**
   * AI Boost metric — estimates additional revenue generated by AI automation.
   * Uses dynamically-evaluated boost rate (updated weekly) instead of static 29%.
   * Formula: without_ai = actual / (1 + boostRate), boost = actual - without_ai
   */
  async getAiBoostMetric(period: 'month' | 'year', account?: string): Promise<{
    aiBoost: number;
    actualRevenue: number;
    withoutAiEstimate: number;
    boostRate: number;
    period: string;
    factors: { name: string; rate: number; description: string }[];
  }> {
    const [allRentals, { boostRate, factors }] = await Promise.all([
      this.getRentalsWithRevenue(account),
      this.getLatestBoostRate(),
    ]);
    const now = new Date();

    let start: Date;
    let end: Date;
    if (period === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    } else {
      start = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    }

    const filtered = allRentals.filter(r =>
      r._effectiveDate >= start && r._effectiveDate < end,
    );

    const actualRevenue = filtered.reduce((sum, r) => sum + (r.rental_price || 0), 0);
    const withoutAiEstimate = actualRevenue / (1 + boostRate);
    const aiBoost = actualRevenue - withoutAiEstimate;

    return {
      aiBoost: Math.round(aiBoost * 100) / 100,
      actualRevenue: Math.round(actualRevenue * 100) / 100,
      withoutAiEstimate: Math.round(withoutAiEstimate * 100) / 100,
      boostRate,
      period,
      factors,
    };
  }

  /**
   * Complete per-item earnings from the BOOKING table (clean MASTER_INVENTORY names).
   * Only counts COMPLETED bookings (end_date < today) — upcoming/ongoing excluded.
   * Returns EVERY inventory item including £0 earners, plus retired/old items not in current inventory.
   */
  async getAllItemEarnings(): Promise<{
    currentItems: { item: string; totalRevenue: number; rentalCount: number; lastRented: string | null }[];
    retiredItems: { item: string; totalRevenue: number; rentalCount: number; firstRented: string | null; lastRented: string | null }[];
  }> {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    // Only count bookings where rental period has ended (completed revenue only)
    const rows = await this.prisma.booking.groupBy({
      by: ['item_name'],
      where: {
        status: { in: ['confirmed', 'completed'] },
        revenue: { not: null, gt: 0 },
        end_date: { lt: now },
      },
      _sum: { revenue: true },
      _count: { id: true },
      _max: { start_date: true },
      _min: { start_date: true },
    });

    const earningsMap = new Map<string, { totalRevenue: number; rentalCount: number; firstRented: string | null; lastRented: string | null }>();
    for (const r of rows) {
      earningsMap.set(r.item_name, {
        totalRevenue: Math.round((r._sum.revenue || 0) * 100) / 100,
        rentalCount: r._count.id,
        firstRented: r._min.start_date ? r._min.start_date.toISOString().split('T')[0] : null,
        lastRented: r._max.start_date ? r._max.start_date.toISOString().split('T')[0] : null,
      });
    }

    // Current inventory items (every MASTER_INVENTORY item, including £0 earners)
    const allItems = getInventoryItemNames();
    const inventorySet = new Set(allItems);
    const currentItems = allItems.map(item => ({
      item,
      totalRevenue: earningsMap.get(item)?.totalRevenue || 0,
      rentalCount: earningsMap.get(item)?.rentalCount || 0,
      lastRented: earningsMap.get(item)?.lastRented || null,
    })).sort((a, b) => b.totalRevenue - a.totalRevenue);

    // Retired/old items: items in bookings but NOT in current MASTER_INVENTORY
    const retiredItems: { item: string; totalRevenue: number; rentalCount: number; firstRented: string | null; lastRented: string | null }[] = [];
    for (const [itemName, data] of earningsMap) {
      if (!inventorySet.has(itemName)) {
        retiredItems.push({ item: itemName, ...data });
      }
    }
    retiredItems.sort((a, b) => b.totalRevenue - a.totalRevenue);

    return { currentItems, retiredItems };
  }

  // ==========================================
  // Monthly Funnel Snapshot Log
  // ==========================================

  /**
   * Monthly cron: snapshot the previous month's funnel metrics on the 1st at 5am.
   * Runs after monthlyRevenueSync (4am) so revenue data is fresh.
   */
  @Cron('0 5 1 * *')
  async monthlyFunnelSnapshot(): Promise<void> {
    this.logger.log('=== MONTHLY FUNNEL SNAPSHOT: Starting ===');
    try {
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth(), 1);
      const results = await this.takeFunnelSnapshot(periodStart, periodEnd);
      this.logger.log(`Funnel snapshot: ${results.length} rows saved for ${periodStart.toISOString().substring(0, 7)}`);
    } catch (err) {
      this.logger.error(`Monthly funnel snapshot failed: ${err.message}`);
    }
  }

  /**
   * Core snapshot logic: query funnel stage counts, revenue, and AI context for a period.
   * Upserts 3 rows: all-accounts (account=null), dbcinema, leo.
   */
  async takeFunnelSnapshot(periodStart: Date, periodEnd: Date): Promise<any[]> {
    const accountScopes: (string | null)[] = [null, 'dbcinema', 'leo'];
    const results: any[] = [];

    for (const account of accountScopes) {
      // 1. Query stage counts from follow_up_state joined with rental
      const whereRental: any = {
        created_at: { lt: periodEnd },
        OR: [
          { end_date: { gte: periodStart } },
          { status: 'pending', start_date: { lt: periodEnd } },
        ],
      };
      if (account) whereRental.account = account;

      const states = await this.prisma.follow_up_state.findMany({
        where: {
          rental: whereRental,
        },
        select: { conversation_stage: true },
      });

      // Map stages to counts
      const stageCounts: Record<string, number> = {
        inquiry: 0, interested: 0, ready_to_book: 0, booked: 0,
        pending: 0, confirmed: 0, completed: 0, dead: 0,
      };
      for (const s of states) {
        const stage = s.conversation_stage || 'inquiry';
        if (stageCounts[stage] !== undefined) {
          stageCounts[stage]++;
        } else {
          stageCounts['inquiry']++; // unknown stages count as inquiry
        }
      }

      const total = states.length;
      const inquiry = stageCounts['inquiry'];
      const interested = stageCounts['interested'];
      const readyToBook = stageCounts['ready_to_book'];
      const booked = stageCounts['booked'];
      const pending = stageCounts['pending'];
      const confirmed = stageCounts['confirmed'];
      const completed = stageCounts['completed'];
      const dead = stageCounts['dead'];

      // 2. Derived rates
      const engaged = total - inquiry;
      const conversionRate = total > 0 ? (confirmed + completed) / total : 0;
      const engagementRate = total > 0 ? engaged / total : 0;
      const bookingRate = engaged > 0 ? (booked + pending + confirmed + completed) / engaged : 0;
      const dropOffRate = total > 0 ? dead / total : 0;

      // 3. Revenue for the period from rental table
      const rentalWhere: any = {
        status: { in: ['completed', 'ongoing', 'upcoming'] },
        rental_price: { not: null, gt: 0 },
        start_date: { lt: periodEnd },
        end_date: { gte: periodStart },
      };
      if (account) rentalWhere.account = account;

      const rentals = await this.prisma.rental.findMany({
        where: rentalWhere,
        select: { rental_price: true, renter_info: true, start_date: true },
      });

      const revenue = rentals.reduce((sum, r) => sum + (r.rental_price || 0), 0);
      const visitKeys = new Set<string>();
      for (const r of rentals) {
        const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
        visitKeys.add(`${renterNorm}|${r.start_date?.toISOString().split('T')[0]}`);
      }

      // 4. Latest AI boost evaluation
      const latestEval = await this.prisma.ai_decision.findFirst({
        where: { decision_type: 'ai_boost_evaluation' },
        orderBy: { created_at: 'desc' },
      });
      let aiBoostRate: number | null = null;
      let aiResponseCov: number | null = null;
      if (latestEval?.output_summary) {
        try {
          const evalData = JSON.parse(latestEval.output_summary);
          aiBoostRate = evalData.boostRate ?? null;
          const speedFactor = evalData.factors?.find((f: any) => f.name === 'Response Speed');
          aiResponseCov = speedFactor?.measured ?? null;
        } catch { /* ignore parse errors */ }
      }

      // 5. Upsert snapshot row (findFirst+update/create because null account breaks compound unique upsert)
      const snapshotData = {
        period_end: periodEnd,
        total,
        inquiry,
        interested,
        ready_to_book: readyToBook,
        booked,
        confirmed,
        completed,
        dead,
        pending,
        conversion_rate: Math.round(conversionRate * 10000) / 10000,
        engagement_rate: Math.round(engagementRate * 10000) / 10000,
        booking_rate: Math.round(bookingRate * 10000) / 10000,
        drop_off_rate: Math.round(dropOffRate * 10000) / 10000,
        revenue: Math.round(revenue * 100) / 100,
        rental_count: visitKeys.size,
        ai_boost_rate: aiBoostRate,
        ai_response_coverage: aiResponseCov,
      };

      const existingSnapshot = await this.prisma.funnel_snapshot.findFirst({
        where: { period_start: periodStart, account: account },
      });

      let row;
      if (existingSnapshot) {
        row = await this.prisma.funnel_snapshot.update({
          where: { id: existingSnapshot.id },
          data: snapshotData,
        });
      } else {
        row = await this.prisma.funnel_snapshot.create({
          data: {
            period_start: periodStart,
            account: account,
            ...snapshotData,
          },
        });
      }

      results.push(row);
    }

    return results;
  }

  /**
   * Get all funnel snapshots ordered by period, optionally filtered by account.
   */
  async getFunnelHistory(account?: string): Promise<any[]> {
    const where: any = {};
    if (account === undefined) {
      where.account = null;
    } else {
      where.account = account;
    }

    return this.prisma.funnel_snapshot.findMany({
      where,
      orderBy: { period_start: 'asc' },
    });
  }

  /**
   * One-time backfill: generate funnel snapshots for all historical months.
   * Iterates from earliest rental month to last month, skipping months that already have a snapshot.
   */
  async backfillFunnelSnapshots(): Promise<{ monthsProcessed: number; monthsSkipped: number; months: string[] }> {
    const earliest = await this.prisma.rental.findFirst({
      where: { start_date: { not: null } },
      orderBy: { start_date: 'asc' },
      select: { start_date: true },
    });

    if (!earliest?.start_date) {
      return { monthsProcessed: 0, monthsSkipped: 0, months: [] };
    }

    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const cursor = new Date(earliest.start_date.getFullYear(), earliest.start_date.getMonth(), 1);

    let monthsProcessed = 0;
    let monthsSkipped = 0;
    const months: string[] = [];

    while (cursor < currentMonthStart) {
      const periodStart = new Date(cursor);
      const periodEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);

      // Check if snapshot already exists for this month
      const existing = await this.prisma.funnel_snapshot.findFirst({
        where: { period_start: periodStart, account: null },
      });

      if (existing) {
        monthsSkipped++;
      } else {
        await this.takeFunnelSnapshot(periodStart, periodEnd);
        months.push(periodStart.toISOString().substring(0, 7));
        monthsProcessed++;
      }

      cursor.setMonth(cursor.getMonth() + 1);
    }

    this.logger.log(`Funnel backfill: ${monthsProcessed} months processed, ${monthsSkipped} skipped`);
    return { monthsProcessed, monthsSkipped, months };
  }

  // ==========================================
  // Per-Item Monthly Earnings Snapshots
  // ==========================================

  /**
   * Monthly cron: snapshot per-item earnings for the previous month.
   * Runs at 5:30am on the 1st (after funnel snapshot at 5am).
   */
  @Cron('0 30 5 1 * *')
  async monthlyItemEarningsSnapshot(): Promise<void> {
    this.logger.log('=== MONTHLY ITEM EARNINGS SNAPSHOT: Starting ===');
    try {
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth(), 1);
      const count = await this.takeItemEarningsSnapshot(periodStart, periodEnd);
      this.logger.log(`Item earnings snapshot: ${count} rows saved for ${periodStart.toISOString().substring(0, 7)}`);
    } catch (err) {
      this.logger.error(`Monthly item earnings snapshot failed: ${err.message}`);
    }
  }

  /**
   * Core logic: snapshot per-item earnings for a given period.
   * Groups completed bookings by item_name, computes revenue, rental count, days rented.
   * Tracks cumulative all-time stats and current/retired status.
   */
  async takeItemEarningsSnapshot(periodStart: Date, periodEnd: Date): Promise<number> {
    const inventorySet = new Set(getInventoryItemNames());

    // Get all completed bookings in this period (end_date within period = revenue recognized)
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ['confirmed', 'completed'] },
        revenue: { not: null, gt: 0 },
        end_date: { gte: periodStart, lt: periodEnd },
      },
      select: {
        item_name: true,
        revenue: true,
        start_date: true,
        end_date: true,
        account: true,
      },
    });

    // Group by item_name + account
    const groups = new Map<string, {
      revenue: number;
      count: number;
      days: number;
      accounts: Set<string>;
    }>();

    for (const b of bookings) {
      const key = b.item_name;
      if (!groups.has(key)) {
        groups.set(key, { revenue: 0, count: 0, days: 0, accounts: new Set() });
      }
      const g = groups.get(key)!;
      g.revenue += b.revenue || 0;
      g.count += 1;
      if (b.start_date && b.end_date) {
        g.days += Math.max(1, Math.round((b.end_date.getTime() - b.start_date.getTime()) / 86400000) + 1);
      }
      if (b.account) g.accounts.add(b.account);
    }

    // Get cumulative all-time stats per item (up to and including this period)
    const cumulativeRows = await this.prisma.booking.groupBy({
      by: ['item_name'],
      where: {
        status: { in: ['confirmed', 'completed'] },
        revenue: { not: null, gt: 0 },
        end_date: { lt: periodEnd },
      },
      _sum: { revenue: true },
      _count: { id: true },
      _min: { start_date: true },
      _max: { end_date: true },
    });

    const cumulativeMap = new Map<string, {
      revenue: number;
      count: number;
      firstRental: Date | null;
      lastRental: Date | null;
    }>();
    for (const r of cumulativeRows) {
      cumulativeMap.set(r.item_name, {
        revenue: r._sum.revenue || 0,
        count: r._count.id,
        firstRental: r._min.start_date,
        lastRental: r._max.end_date,
      });
    }

    // Collect all item names (from this period + cumulative)
    const allItemNames = new Set([...groups.keys(), ...cumulativeMap.keys()]);

    let savedCount = 0;

    for (const itemName of allItemNames) {
      const periodData = groups.get(itemName);
      const cumData = cumulativeMap.get(itemName);
      const isCurrent = inventorySet.has(itemName);

      const revenue = periodData ? Math.round(periodData.revenue * 100) / 100 : 0;
      const rentalCount = periodData?.count || 0;
      const avgPerRental = rentalCount > 0 ? Math.round((revenue / rentalCount) * 100) / 100 : 0;
      const daysRented = periodData?.days || 0;

      // Only save if there's either period activity or cumulative history
      if (revenue === 0 && (!cumData || cumData.revenue === 0)) continue;

      const data = {
        period_start: periodStart,
        period_end: periodEnd,
        item_name: itemName,
        account: null as string | null,
        revenue,
        rental_count: rentalCount,
        avg_per_rental: avgPerRental,
        days_rented: daysRented,
        is_current: isCurrent,
        first_rental: cumData?.firstRental || null,
        last_rental: cumData?.lastRental || null,
        cumulative_revenue: Math.round((cumData?.revenue || 0) * 100) / 100,
        cumulative_rentals: cumData?.count || 0,
      };

      // Upsert (findFirst + create/update for nullable account)
      const existing = await this.prisma.item_earnings_snapshot.findFirst({
        where: { period_start: periodStart, item_name: itemName, account: null },
      });

      if (existing) {
        await this.prisma.item_earnings_snapshot.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await this.prisma.item_earnings_snapshot.create({ data });
      }
      savedCount++;
    }

    return savedCount;
  }

  /**
   * Get item earnings history — monthly snapshots for a specific item or all items.
   */
  async getItemEarningsHistory(itemName?: string, account?: string): Promise<any[]> {
    const where: any = {};
    if (itemName) where.item_name = itemName;
    if (account) where.account = account;
    else where.account = null;

    return this.prisma.item_earnings_snapshot.findMany({
      where,
      orderBy: [{ item_name: 'asc' }, { period_start: 'asc' }],
    });
  }

  /**
   * Backfill item earnings snapshots from earliest booking month to last completed month.
   */
  async backfillItemEarningsSnapshots(): Promise<{ monthsProcessed: number; itemsTotal: number }> {
    const earliest = await this.prisma.booking.findFirst({
      where: { status: { in: ['confirmed', 'completed'] }, revenue: { gt: 0 } },
      orderBy: { start_date: 'asc' },
      select: { start_date: true },
    });

    if (!earliest?.start_date) {
      return { monthsProcessed: 0, itemsTotal: 0 };
    }

    const now = new Date();
    const cursor = new Date(earliest.start_date.getFullYear(), earliest.start_date.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth(), 1); // up to but not including current month

    let monthsProcessed = 0;
    let itemsTotal = 0;

    while (cursor < lastMonth) {
      const periodStart = new Date(cursor);
      const periodEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);

      // Skip if already exists
      const existing = await this.prisma.item_earnings_snapshot.findFirst({
        where: { period_start: periodStart, account: null },
      });

      if (!existing) {
        const count = await this.takeItemEarningsSnapshot(periodStart, periodEnd);
        itemsTotal += count;
        monthsProcessed++;
      }

      cursor.setMonth(cursor.getMonth() + 1);
    }

    this.logger.log(`Item earnings backfill: ${monthsProcessed} months, ${itemsTotal} item-rows`);
    return { monthsProcessed, itemsTotal };
  }

  // ==========================================
  // Bundle/Set Revenue Snapshots
  // ==========================================

  /**
   * Match a rental's parsed items to a REAL listed bundle from BUNDLE_DEFINITIONS.
   * Returns the bundle_name of the best (largest) matching bundle, or null.
   * A bundle matches if ALL of its items are present in the rental's items (multiset).
   */
  private matchRentalToBundle(parsedItems: { item: string; qty: number }[]): string | null {
    // Expand rental items by quantity, normalize names
    const rentalItems: string[] = [];
    for (const p of parsedItems) {
      const normalized = this.normalizeItemName(p.item) || p.item;
      for (let i = 0; i < (p.qty || 1); i++) {
        rentalItems.push(normalized);
      }
    }

    // Build frequency map for rental items
    const rentalFreq = new Map<string, number>();
    for (const item of rentalItems) {
      rentalFreq.set(item, (rentalFreq.get(item) || 0) + 1);
    }

    let bestMatch: string | null = null;
    let bestMatchSize = 0;

    for (const bundle of BUNDLE_DEFINITIONS) {
      // Build frequency map for bundle items
      const bundleFreq = new Map<string, number>();
      for (const item of bundle.items) {
        bundleFreq.set(item, (bundleFreq.get(item) || 0) + 1);
      }

      // Check if ALL bundle items are present in rental items (with correct quantities)
      let allPresent = true;
      for (const [item, count] of bundleFreq.entries()) {
        if ((rentalFreq.get(item) || 0) < count) {
          allPresent = false;
          break;
        }
      }

      // Pick the largest matching bundle (most specific)
      if (allPresent && bundle.items.length > bestMatchSize) {
        bestMatch = bundle.bundle_name;
        bestMatchSize = bundle.items.length;
      }
    }

    return bestMatch;
  }

  /**
   * Monthly cron: snapshot bundle revenue for the previous month.
   * Runs at 5:45am on the 1st (after item earnings at 5:30).
   */
  @Cron('0 45 5 1 * *')
  async monthlyBundleRevenueSnapshot(): Promise<void> {
    this.logger.log('=== MONTHLY BUNDLE REVENUE SNAPSHOT: Starting ===');
    try {
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth(), 1);
      const count = await this.takeBundleRevenueSnapshot(periodStart, periodEnd);
      this.logger.log(`Bundle revenue snapshot: ${count} rows saved for ${periodStart.toISOString().substring(0, 7)}`);
    } catch (err) {
      this.logger.error(`Monthly bundle revenue snapshot failed: ${err.message}`);
    }
  }

  /**
   * Monthly cron: refresh item cycle tracker cache.
   * Runs at 6:00am on the 1st (after bundle snapshots at 5:45).
   */
  @Cron('0 0 6 1 * *')
  async monthlyItemCycleRefresh(): Promise<void> {
    this.logger.log('=== MONTHLY ITEM CYCLE CACHE REFRESH: Starting ===');
    try {
      for (const account of [undefined, 'dbcinema', 'leo']) {
        const data = await this.computeItemCycleData(account);
        const cacheKey = `item_cycle_${account || 'all'}`;

        // Delete old cache entries for this key
        await this.prisma.ai_decision.deleteMany({
          where: { decision_type: 'item_cycle_cache', output_summary: cacheKey },
        });

        // Write fresh cache
        await this.prisma.ai_decision.create({
          data: {
            decision_type: 'item_cycle_cache',
            input_summary: JSON.stringify(data),
            output_summary: cacheKey,
          },
        });

        this.logger.log(`Item cycle cache refreshed for ${account || 'all'}: ${data.categories.length} categories, ${data.yearsAnalyzed} years`);
      }
    } catch (err) {
      this.logger.error(`Monthly item cycle refresh failed: ${err.message}`);
    }
  }

  /**
   * Core logic: snapshot bundle/set revenue for a period.
   * Only counts rentals that match REAL listed bundles from BUNDLE_DEFINITIONS.
   */
  async takeBundleRevenueSnapshot(periodStart: Date, periodEnd: Date): Promise<number> {
    // Get rentals in this period (end_date within period)
    const rentals = await this.prisma.rental.findMany({
      where: {
        rental_price: { gt: 0 },
        parsed_items: { not: Prisma.JsonNull },
        end_date: { gte: periodStart, lt: periodEnd },
      },
      select: {
        parsed_items: true,
        rental_price: true,
        start_date: true,
        end_date: true,
      },
    });

    // Match each rental to a real bundle and group by bundle name
    const bundleGroups = new Map<string, { revenue: number; count: number; days: number }>();

    for (const r of rentals) {
      const parsedItems = r.parsed_items as { item: string; qty: number }[];
      if (!parsedItems || parsedItems.length < 1) continue;

      const bundleName = this.matchRentalToBundle(parsedItems);
      if (!bundleName) continue;

      if (!bundleGroups.has(bundleName)) {
        bundleGroups.set(bundleName, { revenue: 0, count: 0, days: 0 });
      }
      const g = bundleGroups.get(bundleName)!;
      g.revenue += r.rental_price || 0;
      g.count += 1;
      if (r.start_date && r.end_date) {
        g.days += Math.max(1, Math.round((r.end_date.getTime() - r.start_date.getTime()) / 86400000) + 1);
      }
    }

    // Get cumulative all-time stats per bundle (up to and including this period)
    const allRentals = await this.prisma.rental.findMany({
      where: {
        rental_price: { gt: 0 },
        parsed_items: { not: Prisma.JsonNull },
        end_date: { lt: periodEnd },
      },
      select: {
        parsed_items: true,
        rental_price: true,
        start_date: true,
        end_date: true,
      },
    });

    const cumulativeMap = new Map<string, { revenue: number; count: number; firstRental: Date | null; lastRental: Date | null }>();
    for (const r of allRentals) {
      const parsedItems = r.parsed_items as { item: string; qty: number }[];
      if (!parsedItems || parsedItems.length < 1) continue;
      const bundleName = this.matchRentalToBundle(parsedItems);
      if (!bundleName) continue;

      if (!cumulativeMap.has(bundleName)) {
        cumulativeMap.set(bundleName, { revenue: 0, count: 0, firstRental: null, lastRental: null });
      }
      const c = cumulativeMap.get(bundleName)!;
      c.revenue += r.rental_price || 0;
      c.count += 1;
      if (!c.firstRental || (r.start_date && r.start_date < c.firstRental)) c.firstRental = r.start_date;
      if (!c.lastRental || (r.end_date && r.end_date > c.lastRental)) c.lastRental = r.end_date;
    }

    // Save snapshots for bundles that had activity this period
    let savedCount = 0;
    const allBundleNames = new Set([...bundleGroups.keys(), ...cumulativeMap.keys()]);

    for (const bundleName of allBundleNames) {
      const periodData = bundleGroups.get(bundleName);
      const cumData = cumulativeMap.get(bundleName);

      const revenue = periodData ? Math.round(periodData.revenue * 100) / 100 : 0;
      const rentalCount = periodData?.count || 0;
      if (revenue === 0 && (!cumData || cumData.revenue === 0)) continue;
      if (revenue === 0) continue;

      const bundleDef = BUNDLE_DEFINITIONS.find(b => b.bundle_name === bundleName);
      const items = bundleDef?.items || [];

      const data = {
        period_start: periodStart,
        period_end: periodEnd,
        bundle_key: bundleName,
        bundle_label: bundleName,
        items,
        listing_title: null,
        revenue,
        rental_count: rentalCount,
        avg_per_rental: rentalCount > 0 ? Math.round((revenue / rentalCount) * 100) / 100 : 0,
        days_rented: periodData?.days || 0,
        cumulative_revenue: Math.round((cumData?.revenue || 0) * 100) / 100,
        cumulative_rentals: cumData?.count || 0,
        first_rental: cumData?.firstRental || null,
        last_rental: cumData?.lastRental || null,
      };

      const existing = await this.prisma.bundle_revenue_snapshot.findFirst({
        where: { period_start: periodStart, bundle_key: bundleName },
      });

      if (existing) {
        await this.prisma.bundle_revenue_snapshot.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.bundle_revenue_snapshot.create({ data });
      }
      savedCount++;
    }

    return savedCount;
  }

  /**
   * Get bundle revenue history.
   */
  async getBundleRevenueHistory(bundleKey?: string): Promise<any[]> {
    const where: any = {};
    if (bundleKey) where.bundle_key = bundleKey;

    return this.prisma.bundle_revenue_snapshot.findMany({
      where,
      orderBy: [{ cumulative_revenue: 'desc' }, { period_start: 'asc' }],
    });
  }

  /**
   * Get top bundles by all-time revenue (latest snapshot per bundle).
   */
  async getTopBundles(limit: number = 20): Promise<any[]> {
    // Get the most recent snapshot for each bundle
    const all = await this.prisma.bundle_revenue_snapshot.findMany({
      orderBy: { period_start: 'desc' },
    });

    // Deduplicate: keep latest snapshot per bundle_key
    const latest = new Map<string, any>();
    for (const row of all) {
      if (!latest.has(row.bundle_key)) {
        latest.set(row.bundle_key, row);
      }
    }

    return [...latest.values()]
      .sort((a, b) => b.cumulative_revenue - a.cumulative_revenue)
      .slice(0, limit);
  }

  /**
   * Backfill bundle revenue snapshots from earliest rental.
   * Wipes all old data first for a clean rebuild with real bundle matching.
   */
  async backfillBundleRevenueSnapshots(): Promise<{ monthsProcessed: number; bundlesTotal: number }> {
    // Wipe all old snapshots (old data used wrong matching logic)
    const deleted = await this.prisma.bundle_revenue_snapshot.deleteMany({});
    this.logger.log(`Wiped ${deleted.count} old bundle revenue snapshots for clean backfill`);

    const earliest = await this.prisma.rental.findFirst({
      where: { rental_price: { gt: 0 }, parsed_items: { not: Prisma.JsonNull } },
      orderBy: { start_date: 'asc' },
      select: { start_date: true },
    });

    if (!earliest?.start_date) {
      return { monthsProcessed: 0, bundlesTotal: 0 };
    }

    const now = new Date();
    const cursor = new Date(earliest.start_date.getFullYear(), earliest.start_date.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let monthsProcessed = 0;
    let bundlesTotal = 0;

    while (cursor < lastMonth) {
      const periodStart = new Date(cursor);
      const periodEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      const count = await this.takeBundleRevenueSnapshot(periodStart, periodEnd);
      bundlesTotal += count;
      monthsProcessed++;
      cursor.setMonth(cursor.getMonth() + 1);
    }

    this.logger.log(`Bundle revenue backfill: ${monthsProcessed} months, ${bundlesTotal} bundle-rows`);
    return { monthsProcessed, bundlesTotal };
  }

  private getPeriodStart(period: 'week' | 'month' | 'all'): Date | null {
    if (period === 'all') return null;
    if (period === 'week') {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return d;
    }
    // 'month' = start of current calendar month (not "last 30 days")
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }

  /**
   * Flexible period range for item analytics.
   * Supports: 'week', 'month', '3m', '6m', '12m', 'all', or specific month 'YYYY-MM'.
   */
  /**
   * Fix misattributed parsed_items and bookings where old/retired items were
   * incorrectly mapped to current inventory items by the AI parser.
   * E.g., "DJI Mini 3 Pro" → was stored as "DJI Mini 4 Pro"
   */
  async fixMisattributedItems(): Promise<{
    parsedItemsFixed: number;
    bookingsFixed: number;
    details: { title: string; from: string; to: string }[];
  }> {
    // Known misattributions: title pattern → { wrong parsed name → correct name }
    const MISATTRIBUTION_RULES: { titlePattern: RegExp; wrongName: string; correctName: string }[] = [
      { titlePattern: /mini 3/i, wrongName: 'DJI Mini 4 Pro', correctName: 'DJI Mini 3 Pro' },
      { titlePattern: /mavic 3 classic/i, wrongName: 'DJI Mavic 3 Pro', correctName: 'DJI Mavic 3 Classic' },
      { titlePattern: /a7s/i, wrongName: 'Sony A7 III', correctName: 'Sony A7S III' },
      { titlePattern: /a7r/i, wrongName: 'Sony A7 III', correctName: 'Sony A7R III' },
      { titlePattern: /a7c/i, wrongName: 'Sony A7 III', correctName: 'Sony A7C' },
    ];

    let parsedItemsFixed = 0;
    let bookingsFixed = 0;
    const details: { title: string; from: string; to: string }[] = [];

    for (const rule of MISATTRIBUTION_RULES) {
      // Find rentals matching the title pattern
      const rentals = await this.prisma.rental.findMany({
        where: { parsed_items: { not: Prisma.JsonNull } },
        select: { id: true, title: true, parsed_items: true },
      });

      const matching = rentals.filter(r => rule.titlePattern.test(r.title));

      for (const rental of matching) {
        const items = rental.parsed_items as { item: string; qty: number }[];
        // Skip FX3 listings that mention a7s in SEO title
        if (rule.titlePattern.source === 'a7s' && /\bfx\s*3\b/i.test(rental.title) && !rental.title.toLowerCase().startsWith('sony a7s')) {
          continue;
        }

        let changed = false;
        const updatedItems = items.map(item => {
          if (item.item === rule.wrongName) {
            changed = true;
            details.push({ title: rental.title.substring(0, 60), from: rule.wrongName, to: rule.correctName });
            return { ...item, item: rule.correctName };
          }
          return item;
        });

        if (changed) {
          const jsonValue = JSON.stringify(updatedItems);
          await this.prisma.$executeRaw`
            UPDATE rental SET parsed_items = ${jsonValue}::jsonb, updated_at = NOW()
            WHERE id = ${rental.id}
          `;
          parsedItemsFixed++;

          // Also fix any bookings created from this rental
          const updated = await this.prisma.booking.updateMany({
            where: { rental_id: rental.id, item_name: rule.wrongName },
            data: { item_name: rule.correctName },
          });
          bookingsFixed += updated.count;
        }
      }
    }

    this.logger.log(`Misattribution fix: ${parsedItemsFixed} rentals, ${bookingsFixed} bookings corrected`);
    return { parsedItemsFixed, bookingsFixed, details };
  }

  /**
   * Get top bundles with period filtering (live query from rental data, not snapshots).
   * Only matches rentals to REAL listed bundles from BUNDLE_DEFINITIONS.
   * For dashboard tile display.
   */
  async getTopBundlesLive(
    period: string = '6m',
    account?: string,
    limit: number = 15,
  ): Promise<{ bundles: any[]; totalBundleRevenue: number }> {
    const rentals = await this.getRentalsWithRevenue(account);
    const { start, end } = this.getFlexiblePeriodRange(period);

    const periodFiltered = rentals.filter(r => {
      if (start && r._effectiveDate < start) return false;
      if (end && r._effectiveDate >= end) return false;
      return true;
    });

    // Match each rental to a real bundle and aggregate
    const byBundle: Record<string, {
      label: string;
      items: string[];
      revenue: number;
      count: number;
      days: number;
    }> = {};

    for (const r of periodFiltered) {
      const parsedItems = r.parsed_items as { item: string; qty: number }[];
      if (!parsedItems || parsedItems.length < 1) continue;

      const bundleName = this.matchRentalToBundle(parsedItems);
      if (!bundleName) continue;

      if (!byBundle[bundleName]) {
        const bundleDef = BUNDLE_DEFINITIONS.find(b => b.bundle_name === bundleName);
        byBundle[bundleName] = {
          label: bundleName,
          items: bundleDef?.items || [],
          revenue: 0,
          count: 0,
          days: 0,
        };
      }
      byBundle[bundleName].revenue += r.rental_price || 0;
      byBundle[bundleName].count += 1;
      if (r.start_date && r.end_date) {
        byBundle[bundleName].days += Math.max(1, Math.round((r.end_date.getTime() - r.start_date.getTime()) / 86400000) + 1);
      }
    }

    const sorted = Object.values(byBundle)
      .map(b => ({
        ...b,
        revenue: Math.round(b.revenue * 100) / 100,
        avgPerRental: b.count > 0 ? Math.round((b.revenue / b.count) * 100) / 100 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);

    const totalBundleRevenue = Math.round(Object.values(byBundle).reduce((s, b) => s + b.revenue, 0) * 100) / 100;

    return { bundles: sorted, totalBundleRevenue };
  }

  /**
   * Item Cycle Tracker — seasonal demand patterns by equipment category.
   * Averages rental counts per month (Jan-Dec) across all years, normalized 0-1.
   * Returns smooth seasonal curves for each category.
   */
  async getItemCycleData(account?: string): Promise<{
    categories: {
      name: string;
      color: string;
      data: number[]; // 12 values (Jan-Dec), normalized 0-1
      rawCounts: number[]; // 12 raw average counts
      totalRentals: number;
    }[];
    monthLabels: string[];
    yearsAnalyzed: number;
  }> {
    // Try cache first (refreshed monthly by cron)
    const cacheKey = `item_cycle_${account || 'all'}`;
    const cached = await this.prisma.ai_decision.findFirst({
      where: { decision_type: 'item_cycle_cache', output_summary: cacheKey },
      orderBy: { created_at: 'desc' },
    });
    if (cached?.input_summary) {
      try {
        const parsed = JSON.parse(cached.input_summary);
        // Cache valid for 35 days
        const age = Date.now() - new Date(cached.created_at).getTime();
        if (age < 35 * 24 * 60 * 60 * 1000) return parsed;
      } catch {}
    }

    return this.computeItemCycleData(account);
  }

  async computeItemCycleData(account?: string): Promise<{
    categories: {
      name: string;
      color: string;
      data: number[];
      rawCounts: number[];
      totalRentals: number;
    }[];
    monthLabels: string[];
    yearsAnalyzed: number;
  }> {
    const rentals = await this.getRentalsWithRevenue(account);

    // Category definitions with colors
    const CATEGORIES: { name: string; color: string; match: (item: string) => boolean }[] = [
      {
        name: 'Cameras',
        color: '#3b82f6',
        match: (item) => /\b(fx3|a7|bmpcc|x100|camera)\b/i.test(item) && !/action/i.test(item),
      },
      {
        name: 'Lenses',
        color: '#8b5cf6',
        match: (item) => /\b(gm|f2\.?8|f4|mm|lens|anamorphic|blazar|great joy|vespid|fisheye)\b/i.test(item),
      },
      {
        name: 'Drones',
        color: '#06b6d4',
        match: (item) => /\b(mavic|mini [34]|drone)\b/i.test(item),
      },
      {
        name: 'Lighting',
        color: '#f59e0b',
        match: (item) => /\b(nanlite|forza|pavotube|led|light|softbox|ambitful|reflector|flash)\b/i.test(item),
      },
      {
        name: 'Audio',
        color: '#ef4444',
        match: (item) => /\b(rode|mic|wireless|sennheiser|boom|audio|jbl wireless)\b/i.test(item),
      },
      {
        name: 'Gimbals & Support',
        color: '#22c55e',
        match: (item) => /\b(gimbal|rs3|tripod|sirui|slider|follow focus|shoulder|monopod|c.stand)\b/i.test(item),
      },
      {
        name: 'Action & Adventure',
        color: '#f97316',
        match: (item) => /\b(gopro|osmo action|suction|action pro)\b/i.test(item),
      },
      {
        name: 'DJ & Events',
        color: '#ec4899',
        match: (item) => /\b(dj|pioneer|rx3|jbl club|speaker|smoke|fogger|hazer|party)\b/i.test(item),
      },
      {
        name: 'Monitors & TX',
        color: '#14b8a6',
        match: (item) => /\b(atomos|ninja|hollyland|monitor|transmitter|mars|pyro)\b/i.test(item),
      },
      {
        name: 'Power',
        color: '#a3a3a3',
        match: (item) => /\b(v.mount|battery|anker|power station|npf)\b/i.test(item),
      },
    ];

    // Filter to last 2 years for more accurate/current seasonal patterns
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    // Count rentals per category per month across last 2 years
    const yearSet = new Set<number>();
    const categoryCounts: Record<string, number[]> = {};
    for (const cat of CATEGORIES) {
      categoryCounts[cat.name] = new Array(12).fill(0);
    }

    for (const r of rentals) {
      if (!r.start_date || !r.parsed_items) continue;
      if (r.start_date < twoYearsAgo) continue; // Skip older data
      const monthIdx = r.start_date.getMonth(); // 0-11
      yearSet.add(r.start_date.getFullYear());

      const items = r.parsed_items as { item: string; qty: number }[];
      const matchedCategories = new Set<string>();

      for (const item of items) {
        for (const cat of CATEGORIES) {
          if (cat.match(item.item)) {
            matchedCategories.add(cat.name);
          }
        }
      }

      // Also try matching against the listing title for broader coverage
      for (const cat of CATEGORIES) {
        if (cat.match(r.title)) {
          matchedCategories.add(cat.name);
        }
      }

      for (const catName of matchedCategories) {
        categoryCounts[catName][monthIdx]++;
      }
    }

    const yearsAnalyzed = Math.max(yearSet.size, 1);

    // Build result: average per month, then normalize 0-1
    const categories = CATEGORIES.map(cat => {
      const rawCounts = categoryCounts[cat.name].map(c => Math.round((c / yearsAnalyzed) * 100) / 100);
      const maxCount = Math.max(...rawCounts, 0.01); // avoid division by zero
      const minCount = Math.min(...rawCounts);
      const range = maxCount - minCount || 1;

      // Normalize to 0-1 range
      const normalized = rawCounts.map(c => Math.round(((c - minCount) / range) * 100) / 100);

      return {
        name: cat.name,
        color: cat.color,
        data: normalized,
        rawCounts,
        totalRentals: categoryCounts[cat.name].reduce((s, c) => s + c, 0),
      };
    }).filter(cat => cat.totalRentals > 0); // Only show categories with actual data

    return {
      categories,
      monthLabels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      yearsAnalyzed,
    };
  }

  private getFlexiblePeriodRange(period: string): { start: Date | null; end: Date | null } {
    if (period === 'all') return { start: null, end: null };

    const now = new Date();

    if (period === 'week') {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { start, end: null };
    }

    // Specific month: 'YYYY-MM'
    if (/^\d{4}-\d{2}$/.test(period)) {
      const [year, month] = period.split('-').map(Number);
      return {
        start: new Date(year, month - 1, 1),
        end: new Date(year, month, 1),
      };
    }

    // Period shortcuts: 'month', '3m', '6m', '12m'
    let monthsBack = 1;
    if (period === 'month') monthsBack = 1;
    else if (period === '3m') monthsBack = 3;
    else if (period === '6m') monthsBack = 6;
    else if (period === '12m') monthsBack = 12;

    return {
      start: new Date(now.getFullYear(), now.getMonth() - monthsBack + 1, 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1), // cap at end of current month
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // UK TAX CALCULATION — Sole trader, not VAT registered
  // Tax year runs April 6 → April 5. Uses 2025/26 rates.
  // ════════════════════════════════════════════════════════════════════

  /**
   * Get the UK tax year boundaries for a given date.
   * UK tax year: 6 April Year1 → 5 April Year2
   */
  private getUkTaxYear(date: Date = new Date()): { label: string; start: Date; end: Date } {
    const year = date.getFullYear();
    const month = date.getMonth(); // 0-indexed
    const day = date.getDate();

    // If before April 6, we're in the previous year's tax year
    const taxYearStartYear = (month < 3 || (month === 3 && day < 6)) ? year - 1 : year;
    return {
      label: `${taxYearStartYear}/${(taxYearStartYear + 1).toString().slice(-2)}`,
      start: new Date(taxYearStartYear, 3, 6), // April 6
      end: new Date(taxYearStartYear + 1, 3, 5, 23, 59, 59, 999), // April 5 next year
    };
  }

  /**
   * Calculate UK income tax for a sole trader (2025/26 rates).
   * Personal allowance: £12,570
   * Basic rate: 20% on £12,571–£50,270
   * Higher rate: 40% on £50,271–£125,140
   * Additional rate: 45% above £125,140
   */
  private calculateIncomeTax(taxableProfit: number): {
    total: number;
    personalAllowance: number;
    basicRate: number;
    higherRate: number;
    additionalRate: number;
    bands: { band: string; rate: number; taxable: number; tax: number }[];
  } {
    const PERSONAL_ALLOWANCE = 12570;
    const BASIC_LIMIT = 50270;
    const HIGHER_LIMIT = 125140;

    // Personal allowance tapers above £100,000 (£1 lost per £2 over £100k)
    let personalAllowance = PERSONAL_ALLOWANCE;
    if (taxableProfit > 100000) {
      personalAllowance = Math.max(0, PERSONAL_ALLOWANCE - Math.floor((taxableProfit - 100000) / 2));
    }

    const taxableAfterAllowance = Math.max(0, taxableProfit - personalAllowance);

    const bands: { band: string; rate: number; taxable: number; tax: number }[] = [];

    // Basic rate: 20% on first £37,700 (£50,270 - £12,570)
    const basicBand = Math.min(taxableAfterAllowance, BASIC_LIMIT - PERSONAL_ALLOWANCE);
    const basicTax = basicBand * 0.20;
    if (basicBand > 0) bands.push({ band: 'Basic (20%)', rate: 20, taxable: Math.round(basicBand), tax: Math.round(basicTax) });

    // Higher rate: 40% on £50,271–£125,140
    const higherBand = Math.max(0, Math.min(taxableAfterAllowance, HIGHER_LIMIT - PERSONAL_ALLOWANCE) - (BASIC_LIMIT - PERSONAL_ALLOWANCE));
    const higherTax = higherBand * 0.40;
    if (higherBand > 0) bands.push({ band: 'Higher (40%)', rate: 40, taxable: Math.round(higherBand), tax: Math.round(higherTax) });

    // Additional rate: 45% above £125,140
    const additionalBand = Math.max(0, taxableAfterAllowance - (HIGHER_LIMIT - personalAllowance));
    const additionalTax = additionalBand * 0.45;
    if (additionalBand > 0) bands.push({ band: 'Additional (45%)', rate: 45, taxable: Math.round(additionalBand), tax: Math.round(additionalTax) });

    return {
      total: Math.round(basicTax + higherTax + additionalTax),
      personalAllowance,
      basicRate: Math.round(basicTax),
      higherRate: Math.round(higherTax),
      additionalRate: Math.round(additionalTax),
      bands,
    };
  }

  /**
   * Calculate Class 4 National Insurance (2025/26 rates).
   * Class 2 abolished from April 2025.
   * Class 4: 6% on £12,570–£50,270, 2% above £50,270.
   */
  private calculateClass4NIC(taxableProfit: number): {
    total: number;
    mainRate: number;
    upperRate: number;
    bands: { band: string; rate: number; taxable: number; nic: number }[];
  } {
    const LOWER_THRESHOLD = 12570;
    const UPPER_THRESHOLD = 50270;

    const bands: { band: string; rate: number; taxable: number; nic: number }[] = [];

    // Main rate: 6% on £12,570–£50,270
    const mainBand = Math.max(0, Math.min(taxableProfit, UPPER_THRESHOLD) - LOWER_THRESHOLD);
    const mainNic = mainBand * 0.06;
    if (mainBand > 0) bands.push({ band: 'Main (6%)', rate: 6, taxable: Math.round(mainBand), nic: Math.round(mainNic) });

    // Upper rate: 2% above £50,270
    const upperBand = Math.max(0, taxableProfit - UPPER_THRESHOLD);
    const upperNic = upperBand * 0.02;
    if (upperBand > 0) bands.push({ band: 'Upper (2%)', rate: 2, taxable: Math.round(upperBand), nic: Math.round(upperNic) });

    return {
      total: Math.round(mainNic + upperNic),
      mainRate: Math.round(mainNic),
      upperRate: Math.round(upperNic),
      bands,
    };
  }

  /**
   * Full tax summary for the current UK tax year.
   * Revenue: From rental table (Daniel's take-home after platform fees).
   * Deductions: Insurance payouts excluded, equipment AIA capital allowance.
   */
  async getTaxSummary(account?: string) {
    const now = new Date();
    const taxYear = this.getUkTaxYear(now);
    const rentals = await this.getRentalsWithRevenue(account);

    // Filter rentals to current tax year
    const taxYearRentals = rentals.filter(r =>
      r._effectiveDate >= taxYear.start && r._effectiveDate <= taxYear.end
    );

    // Gross rental revenue (this is already Daniel's earnings after ~36% platform fees)
    const grossRevenue = taxYearRentals.reduce((sum, r) => sum + (r.rental_price || 0), 0);

    // Insurance/damage payouts from historical data + DB claims (these months in the tax year)
    let insurancePayouts = 0;
    const taxYearStartMonth = `${taxYear.start.getFullYear()}-${String(taxYear.start.getMonth() + 1).padStart(2, '0')}`;
    const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    for (const hist of HISTORICAL_REVENUE) {
      if (hist.month >= taxYearStartMonth && hist.month <= nowMonth && hist.damageCosts > 0) {
        insurancePayouts += hist.damageCosts;
      }
    }
    // Also add DB-backed insurance claims (is_new=true) for this tax year
    try {
      const dbClaimsForTax = await this.prisma.insurance_claim.findMany({
        where: { is_new: true, claim_date: { gte: taxYear.start, lte: now } },
      });
      for (const c of dbClaimsForTax) {
        insurancePayouts += c.amount;
      }
    } catch { /* DB claims optional */ }

    // Revenue excluding insurance
    const revenueExInsurance = grossRevenue;
    // Note: grossRevenue from rental table doesn't include insurance payouts.
    // Insurance payouts from historical data were added to the lifetime chart but
    // aren't in the rental table. So grossRevenue is already "clean" rental income.
    // We still track insurancePayouts for display purposes.

    // Equipment capital allowances (AIA) — 100% deduction in year of purchase
    const equipment = getTotalEquipmentValue();

    // Days elapsed in tax year → project full year
    const msElapsed = now.getTime() - taxYear.start.getTime();
    const daysElapsed = Math.max(1, Math.round(msElapsed / 86400000));
    const totalTaxYearDays = Math.round((taxYear.end.getTime() - taxYear.start.getTime()) / 86400000);
    const projectedAnnualRevenue = Math.round(grossRevenue * totalTaxYearDays / daysElapsed);

    // Taxable profit = revenue - capital allowances (AIA)
    // AIA can reduce profit to zero but not below
    const capitalAllowance = Math.min(equipment.totalValue, Math.round(projectedAnnualRevenue));
    const taxableProfit = Math.max(0, projectedAnnualRevenue - capitalAllowance);

    // Also calculate on ACTUAL revenue so far (not projected)
    const actualCapitalAllowance = Math.min(equipment.totalValue, Math.round(grossRevenue));
    const actualTaxableProfit = Math.max(0, Math.round(grossRevenue) - actualCapitalAllowance);

    // Tax calculations on projected full year
    const incomeTax = this.calculateIncomeTax(taxableProfit);
    const class4NIC = this.calculateClass4NIC(taxableProfit);
    const totalTax = incomeTax.total + class4NIC.total;
    const effectiveRate = projectedAnnualRevenue > 0 ? Math.round(totalTax / projectedAnnualRevenue * 1000) / 10 : 0;
    const netAfterTax = projectedAnnualRevenue - totalTax;

    // Tax calculations on actual YTD revenue
    const actualIncomeTax = this.calculateIncomeTax(actualTaxableProfit);
    const actualClass4NIC = this.calculateClass4NIC(actualTaxableProfit);
    const actualTotalTax = actualIncomeTax.total + actualClass4NIC.total;
    const actualEffectiveRate = grossRevenue > 0 ? Math.round(actualTotalTax / grossRevenue * 1000) / 10 : 0;

    // Determine tax band
    let taxCategory = 'Below personal allowance';
    if (taxableProfit > 125140) taxCategory = 'Additional rate taxpayer';
    else if (taxableProfit > 50270) taxCategory = 'Higher rate taxpayer';
    else if (taxableProfit > 12570) taxCategory = 'Basic rate taxpayer';

    // Monthly revenue breakdown for the tax year
    const monthlyBreakdown: { month: string; revenue: number }[] = [];
    const cursor = new Date(taxYear.start.getFullYear(), taxYear.start.getMonth(), 1);
    const endCursor = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    while (cursor < endCursor) {
      const monthStart = new Date(cursor);
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      const monthRevenue = taxYearRentals
        .filter(r => r._effectiveDate >= monthStart && r._effectiveDate < monthEnd)
        .reduce((sum, r) => sum + (r.rental_price || 0), 0);
      monthlyBreakdown.push({
        month: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
        revenue: Math.round(monthRevenue),
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return {
      taxYear: taxYear.label,
      taxYearStart: taxYear.start.toISOString().split('T')[0],
      taxYearEnd: taxYear.end.toISOString().split('T')[0],
      daysElapsed,
      totalTaxYearDays,
      daysRemaining: totalTaxYearDays - daysElapsed,

      // Revenue
      grossRevenue: Math.round(grossRevenue),
      projectedAnnualRevenue,
      insurancePayouts: Math.round(insurancePayouts),
      insuranceNote: 'Excluded — not taxable when equipment replaced (AIA offsets balancing charge)',

      // Capital allowances
      equipmentValue: equipment.totalValue,
      capitalAllowanceUsed: capitalAllowance,
      capitalAllowanceNote: 'Annual Investment Allowance (AIA) — 100% first-year deduction on business equipment',
      equipmentItems: equipment.items.slice(0, 15), // Top 15 by value

      // Projected full year
      taxableProfit,
      taxCategory,
      incomeTax: incomeTax.total,
      incomeTaxBands: incomeTax.bands,
      personalAllowance: incomeTax.personalAllowance,
      class4NIC: class4NIC.total,
      class4NIBands: class4NIC.bands,
      totalTax,
      effectiveRate,
      netAfterTax,

      // Actual YTD
      actual: {
        revenue: Math.round(grossRevenue),
        capitalAllowance: actualCapitalAllowance,
        taxableProfit: actualTaxableProfit,
        incomeTax: actualIncomeTax.total,
        class4NIC: actualClass4NIC.total,
        totalTax: actualTotalTax,
        effectiveRate: actualEffectiveRate,
      },

      monthlyBreakdown,

      // "No AIA" scenario: what tax would be without capital allowances
      noAia: (() => {
        const noAiaProfit = projectedAnnualRevenue;
        const noAiaIT = this.calculateIncomeTax(noAiaProfit);
        const noAiaNIC = this.calculateClass4NIC(noAiaProfit);
        const noAiaTotal = noAiaIT.total + noAiaNIC.total;
        let noAiaCategory = 'Below personal allowance';
        if (noAiaProfit > 125140) noAiaCategory = 'Additional rate taxpayer';
        else if (noAiaProfit > 50270) noAiaCategory = 'Higher rate taxpayer';
        else if (noAiaProfit > 12570) noAiaCategory = 'Basic rate taxpayer';
        return {
          taxableProfit: noAiaProfit,
          taxCategory: noAiaCategory,
          personalAllowance: noAiaIT.personalAllowance,
          incomeTax: noAiaIT.total,
          incomeTaxBands: noAiaIT.bands,
          class4NIC: noAiaNIC.total,
          class4NIBands: noAiaNIC.bands,
          totalTax: noAiaTotal,
          effectiveRate: projectedAnnualRevenue > 0 ? Math.round(noAiaTotal / projectedAnnualRevenue * 1000) / 10 : 0,
          netAfterTax: projectedAnnualRevenue - noAiaTotal,
        };
      })(),
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // MULTI-YEAR TAX CALCULATION
  // ════════════════════════════════════════════════════════════════════

  /** UK tax rate tables per tax year (rates changed year-to-year) */
  private static readonly TAX_RATES: Record<string, {
    personalAllowance: number;
    basicLimit: number;
    higherLimit: number;
    basicRate: number;
    higherRate: number;
    additionalRate: number;
    class4MainRate: number;
    class4UpperRate: number;
    class4LowerThreshold: number;
    class4UpperThreshold: number;
    class2WeeklyRate: number;
    class2SmallProfitsThreshold: number;
    filingDeadline: Date;
    paymentDeadline: Date;
  }> = {
    '2022/23': {
      personalAllowance: 12570, basicLimit: 50270, higherLimit: 150000,
      basicRate: 0.20, higherRate: 0.40, additionalRate: 0.45,
      class4MainRate: 0.0973, class4UpperRate: 0.02,
      class4LowerThreshold: 11909, class4UpperThreshold: 50270,
      class2WeeklyRate: 3.15, class2SmallProfitsThreshold: 6725,
      filingDeadline: new Date(2024, 0, 31), // Jan 31 2024
      paymentDeadline: new Date(2024, 0, 31),
    },
    '2023/24': {
      personalAllowance: 12570, basicLimit: 50270, higherLimit: 125140,
      basicRate: 0.20, higherRate: 0.40, additionalRate: 0.45,
      class4MainRate: 0.09, class4UpperRate: 0.02,
      class4LowerThreshold: 12570, class4UpperThreshold: 50270,
      class2WeeklyRate: 3.45, class2SmallProfitsThreshold: 6725,
      filingDeadline: new Date(2025, 0, 31), // Jan 31 2025
      paymentDeadline: new Date(2025, 0, 31),
    },
    '2024/25': {
      personalAllowance: 12570, basicLimit: 50270, higherLimit: 125140,
      basicRate: 0.20, higherRate: 0.40, additionalRate: 0.45,
      class4MainRate: 0.06, class4UpperRate: 0.02,
      class4LowerThreshold: 12570, class4UpperThreshold: 50270,
      class2WeeklyRate: 0, class2SmallProfitsThreshold: 0, // Abolished
      filingDeadline: new Date(2026, 0, 31), // Jan 31 2026
      paymentDeadline: new Date(2026, 0, 31),
    },
    '2025/26': {
      personalAllowance: 12570, basicLimit: 50270, higherLimit: 125140,
      basicRate: 0.20, higherRate: 0.40, additionalRate: 0.45,
      class4MainRate: 0.06, class4UpperRate: 0.02,
      class4LowerThreshold: 12570, class4UpperThreshold: 50270,
      class2WeeklyRate: 0, class2SmallProfitsThreshold: 0, // Abolished
      filingDeadline: new Date(2027, 0, 31), // Jan 31 2027
      paymentDeadline: new Date(2027, 0, 31),
    },
  };

  /**
   * Additional business deductions beyond AIA equipment write-off.
   * Home office: actual cost method (30% business use of rent — reasonable for
   * sole trader managing rental business from bedroom 8-10hrs/day, 5-6 days/week).
   * Capital losses: one-off items sold at a loss.
   * DZO lenses: stolen, insurance payout > cost. AIA clawed back via balancing charge,
   * £800 excess CGT-exempt within annual allowance. Net effect: tax-neutral.
   */
  private static readonly RENT_HISTORY: { from: string; to: string; monthlyRent: number }[] = [
    { from: '2022-08-01', to: '2025-05-14', monthlyRent: 1200 },
    { from: '2025-05-15', to: '2026-04-05', monthlyRent: 1700 },
  ];
  private static readonly HOME_OFFICE_BUSINESS_PCT = 0.30;

  private static readonly CAPITAL_LOSSES: { yearLabel: string; description: string; amount: number }[] = [
    { yearLabel: '2024/25', description: 'Camera (bought for rental, never rented, sold at loss)', amount: 4500 },
  ];

  /** Calculate home office deduction for a tax year using actual cost method */
  private calculateHomeOfficeDeduction(yearLabel: string): { totalRent: number; deduction: number; months: number } {
    const startYear = parseInt(yearLabel.split('/')[0]);
    const taxYearStart = new Date(startYear, 3, 6); // Apr 6
    const taxYearEnd = new Date(startYear + 1, 3, 5, 23, 59, 59, 999); // Apr 5

    let totalRent = 0;
    // For each day in the tax year, determine which rent period applies
    const cursor = new Date(taxYearStart);
    let monthsCount = 0;
    while (cursor <= taxYearEnd) {
      const monthStart = new Date(cursor);
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999); // last day of month
      const effectiveStart = monthStart < taxYearStart ? taxYearStart : monthStart;
      const effectiveEnd = monthEnd > taxYearEnd ? taxYearEnd : monthEnd;
      const daysInMonth = monthEnd.getDate();
      const daysInRange = Math.round((effectiveEnd.getTime() - effectiveStart.getTime()) / 86400000) + 1;

      // Find applicable rent for this month
      const dateStr = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      let monthlyRent = 0;
      for (const period of RevenueService.RENT_HISTORY) {
        if (dateStr >= period.from && dateStr <= period.to) {
          monthlyRent = period.monthlyRent;
          break;
        }
      }

      if (monthlyRent > 0) {
        totalRent += Math.round(monthlyRent * daysInRange / daysInMonth);
        monthsCount += daysInRange / daysInMonth;
      }

      cursor.setMonth(cursor.getMonth() + 1);
      cursor.setDate(1);
    }

    const deduction = Math.round(totalRent * RevenueService.HOME_OFFICE_BUSINESS_PCT);
    return { totalRent: Math.round(totalRent), deduction, months: Math.round(monthsCount * 10) / 10 };
  }

  /** Calculate income tax with year-specific rates */
  private calculateIncomeTaxForYear(taxableProfit: number, yearLabel: string) {
    const rates = RevenueService.TAX_RATES[yearLabel] || RevenueService.TAX_RATES['2025/26'];

    let personalAllowance = rates.personalAllowance;
    if (taxableProfit > 100000) {
      personalAllowance = Math.max(0, rates.personalAllowance - Math.floor((taxableProfit - 100000) / 2));
    }

    const taxableAfterAllowance = Math.max(0, taxableProfit - personalAllowance);
    const bands: { band: string; rate: number; taxable: number; tax: number }[] = [];

    const basicBand = Math.min(taxableAfterAllowance, rates.basicLimit - rates.personalAllowance);
    const basicTax = basicBand * rates.basicRate;
    if (basicBand > 0) bands.push({ band: `Basic (${rates.basicRate * 100}%)`, rate: rates.basicRate * 100, taxable: Math.round(basicBand), tax: Math.round(basicTax) });

    const higherBand = Math.max(0, Math.min(taxableAfterAllowance, rates.higherLimit - rates.personalAllowance) - (rates.basicLimit - rates.personalAllowance));
    const higherTax = higherBand * rates.higherRate;
    if (higherBand > 0) bands.push({ band: `Higher (${rates.higherRate * 100}%)`, rate: rates.higherRate * 100, taxable: Math.round(higherBand), tax: Math.round(higherTax) });

    const additionalBand = Math.max(0, taxableAfterAllowance - (rates.higherLimit - personalAllowance));
    const additionalTax = additionalBand * rates.additionalRate;
    if (additionalBand > 0) bands.push({ band: `Additional (${rates.additionalRate * 100}%)`, rate: rates.additionalRate * 100, taxable: Math.round(additionalBand), tax: Math.round(additionalTax) });

    return {
      total: Math.round(basicTax + higherTax + additionalTax),
      personalAllowance,
      bands,
    };
  }

  /** Calculate Class 4 NIC with year-specific rates */
  private calculateClass4NICForYear(taxableProfit: number, yearLabel: string) {
    const rates = RevenueService.TAX_RATES[yearLabel] || RevenueService.TAX_RATES['2025/26'];
    const bands: { band: string; rate: number; taxable: number; nic: number }[] = [];

    const mainBand = Math.max(0, Math.min(taxableProfit, rates.class4UpperThreshold) - rates.class4LowerThreshold);
    const mainNic = mainBand * rates.class4MainRate;
    if (mainBand > 0) bands.push({ band: `Main (${(rates.class4MainRate * 100).toFixed(2)}%)`, rate: +(rates.class4MainRate * 100).toFixed(2), taxable: Math.round(mainBand), nic: Math.round(mainNic) });

    const upperBand = Math.max(0, taxableProfit - rates.class4UpperThreshold);
    const upperNic = upperBand * rates.class4UpperRate;
    if (upperBand > 0) bands.push({ band: `Upper (${rates.class4UpperRate * 100}%)`, rate: rates.class4UpperRate * 100, taxable: Math.round(upperBand), nic: Math.round(upperNic) });

    return { total: Math.round(mainNic + upperNic), bands };
  }

  /** Calculate Class 2 NIC for years where it applies */
  private calculateClass2NIC(taxableProfit: number, yearLabel: string): number {
    const rates = RevenueService.TAX_RATES[yearLabel];
    if (!rates || rates.class2WeeklyRate === 0) return 0;
    if (taxableProfit < rates.class2SmallProfitsThreshold) return 0;
    return Math.round(rates.class2WeeklyRate * 52);
  }

  /**
   * Get revenue broken down by UK tax year.
   * Uses historical data for months where HISTORICAL_REVENUE has totalRevenue > 0,
   * and rental table data for months where historical is 0 (sentinel).
   * Prorates April at the April 6 boundary: 5/30 to old year, 25/30 to new year.
   */
  private async getRevenueByTaxYear(account?: string): Promise<Map<string, { revenue: number; months: { month: string; revenue: number; source: string }[] }>> {
    const rentals = await this.getRentalsWithRevenue(account);

    // Build monthly revenue from rental table
    const rentalMonthlyMap = new Map<string, number>();
    for (const r of rentals) {
      if (!r._effectiveDate || !r.rental_price) continue;
      const key = `${r._effectiveDate.getFullYear()}-${String(r._effectiveDate.getMonth() + 1).padStart(2, '0')}`;
      rentalMonthlyMap.set(key, (rentalMonthlyMap.get(key) || 0) + r.rental_price);
    }

    // Build combined monthly revenue: historical where available, rental table otherwise
    const allMonths = new Map<string, { revenue: number; source: string }>();

    // Add all historical months with real data
    for (const hist of HISTORICAL_REVENUE) {
      if (hist.totalRevenue > 0) {
        allMonths.set(hist.month, { revenue: hist.totalRevenue, source: 'historical' });
      }
    }

    // Add rental table months where historical is sentinel (0) or missing
    for (const [month, rev] of rentalMonthlyMap.entries()) {
      const existing = allMonths.get(month);
      if (!existing) {
        allMonths.set(month, { revenue: rev, source: 'rental_table' });
      }
      // If historical exists with real data, keep it — it's the authoritative source
    }

    // Map months to tax years with April proration
    const taxYears = new Map<string, { revenue: number; months: { month: string; revenue: number; source: string }[] }>();

    for (const [month, data] of allMonths.entries()) {
      const [yearStr, monthStr] = month.split('-');
      const year = parseInt(yearStr);
      const mon = parseInt(monthStr); // 1-indexed

      if (mon === 4) {
        // April: prorate at April 6 boundary — 5/30 to old year, 25/30 to new year
        const oldYearLabel = `${year - 1}/${String(year).slice(-2)}`;
        const newYearLabel = `${year}/${String(year + 1).slice(-2)}`;
        const oldPortion = Math.round(data.revenue * 5 / 30);
        const newPortion = data.revenue - oldPortion;

        if (oldPortion > 0) {
          const entry = taxYears.get(oldYearLabel) || { revenue: 0, months: [] };
          entry.revenue += oldPortion;
          entry.months.push({ month, revenue: oldPortion, source: data.source + ' (Apr 1-5)' });
          taxYears.set(oldYearLabel, entry);
        }
        if (newPortion > 0) {
          const entry = taxYears.get(newYearLabel) || { revenue: 0, months: [] };
          entry.revenue += newPortion;
          entry.months.push({ month, revenue: newPortion, source: data.source + ' (Apr 6-30)' });
          taxYears.set(newYearLabel, entry);
        }
      } else {
        // Non-April: full month to appropriate tax year
        // Tax year runs Apr 6 to Apr 5: Jan-Mar = previous year's tax year, May-Dec = current year's tax year
        const taxYearStartYear = mon <= 3 ? year - 1 : year;
        const yearLabel = `${taxYearStartYear}/${String(taxYearStartYear + 1).slice(-2)}`;

        const entry = taxYears.get(yearLabel) || { revenue: 0, months: [] };
        entry.revenue += data.revenue;
        entry.months.push({ month, revenue: Math.round(data.revenue), source: data.source });
        taxYears.set(yearLabel, entry);
      }
    }

    return taxYears;
  }

  /** Calculate late filing penalties for a given tax year */
  private calculateFilingPenalties(taxOwed: number, filingDeadline: Date, now: Date): {
    total: number;
    breakdown: { description: string; amount: number; applies: boolean }[];
    daysLate: number;
  } {
    if (now <= filingDeadline) return { total: 0, breakdown: [], daysLate: 0 };

    const daysLate = Math.round((now.getTime() - filingDeadline.getTime()) / 86400000);
    const breakdown: { description: string; amount: number; applies: boolean }[] = [];
    let total = 0;

    // 1 day late: £100
    const initialPenalty = 100;
    breakdown.push({ description: 'Initial late filing penalty (1 day+)', amount: initialPenalty, applies: true });
    total += initialPenalty;

    // 3 months late: £10/day for up to 90 days = max £900
    if (daysLate > 90) {
      const dailyPenaltyDays = Math.min(daysLate - 90, 90);
      const dailyPenalty = Math.min(dailyPenaltyDays * 10, 900);
      breakdown.push({ description: `Daily penalty (£10/day × ${dailyPenaltyDays} days, 3-6 months)`, amount: dailyPenalty, applies: dailyPenalty > 0 });
      total += dailyPenalty;
    } else {
      breakdown.push({ description: 'Daily penalty (3+ months — not yet)', amount: 0, applies: false });
    }

    // 6 months late: greater of £300 or 5% of tax due
    if (daysLate > 180) {
      const sixMonthPenalty = Math.max(300, Math.round(taxOwed * 0.05));
      breakdown.push({ description: `6-month penalty (max of £300 or 5% of tax)`, amount: sixMonthPenalty, applies: true });
      total += sixMonthPenalty;
    } else {
      breakdown.push({ description: '6-month penalty — not yet', amount: 0, applies: false });
    }

    // 12 months late: additional greater of £300 or 5% of tax due
    if (daysLate > 365) {
      const twelveMonthPenalty = Math.max(300, Math.round(taxOwed * 0.05));
      breakdown.push({ description: `12-month penalty (max of £300 or 5% of tax)`, amount: twelveMonthPenalty, applies: true });
      total += twelveMonthPenalty;
    } else {
      breakdown.push({ description: '12-month penalty — not yet', amount: 0, applies: false });
    }

    return { total, breakdown, daysLate };
  }

  /** Calculate late payment penalties */
  private calculatePaymentPenalties(taxOwed: number, paymentDeadline: Date, now: Date): {
    total: number;
    breakdown: { description: string; amount: number; applies: boolean }[];
    daysLate: number;
  } {
    if (taxOwed <= 0 || now <= paymentDeadline) return { total: 0, breakdown: [], daysLate: 0 };

    const daysLate = Math.round((now.getTime() - paymentDeadline.getTime()) / 86400000);
    const breakdown: { description: string; amount: number; applies: boolean }[] = [];
    let total = 0;

    // 30 days late: 5% of outstanding tax
    if (daysLate > 30) {
      const p = Math.round(taxOwed * 0.05);
      breakdown.push({ description: '30-day surcharge (5% of tax)', amount: p, applies: true });
      total += p;
    } else {
      breakdown.push({ description: '30-day surcharge — not yet', amount: 0, applies: false });
    }

    // 6 months late: additional 5%
    if (daysLate > 180) {
      const p = Math.round(taxOwed * 0.05);
      breakdown.push({ description: '6-month surcharge (5% of tax)', amount: p, applies: true });
      total += p;
    } else {
      breakdown.push({ description: '6-month surcharge — not yet', amount: 0, applies: false });
    }

    // 12 months late: additional 5%
    if (daysLate > 365) {
      const p = Math.round(taxOwed * 0.05);
      breakdown.push({ description: '12-month surcharge (5% of tax)', amount: p, applies: true });
      total += p;
    } else {
      breakdown.push({ description: '12-month surcharge — not yet', amount: 0, applies: false });
    }

    return { total, breakdown, daysLate };
  }

  /** Calculate interest on unpaid tax (HMRC late payment interest rate ~7.75% as of Feb 2026) */
  private calculateInterest(taxOwed: number, paymentDeadline: Date, now: Date): number {
    if (taxOwed <= 0 || now <= paymentDeadline) return 0;
    const daysLate = Math.round((now.getTime() - paymentDeadline.getTime()) / 86400000);
    // HMRC interest: Bank of England base rate + 2.5%. Currently ~7.75% annual.
    return Math.round(taxOwed * 0.0775 * daysLate / 365);
  }

  /**
   * Full multi-year tax summary covering all rental years (2022/23 through 2025/26).
   * Includes per-year tax calculations with/without AIA, late filing/payment penalties, and interest.
   */
  async getMultiYearTaxSummary(account?: string) {
    const now = new Date();
    const revenueByYear = await this.getRevenueByTaxYear(account);
    const equipment = getTotalEquipmentValue();
    const currentTaxYear = this.getUkTaxYear(now);

    const years: any[] = [];
    let grandTotalTax = 0;
    let grandTotalPenalties = 0;
    let grandTotalInterest = 0;

    const yearLabels = ['2022/23', '2023/24', '2024/25', '2025/26'];

    for (const yearLabel of yearLabels) {
      const rates = RevenueService.TAX_RATES[yearLabel];
      if (!rates) continue;

      const yearData = revenueByYear.get(yearLabel);
      const revenue = yearData ? Math.round(yearData.revenue) : 0;
      const months = yearData?.months || [];
      const isCurrent = yearLabel === currentTaxYear.label;
      const isPast = !isCurrent && rates.paymentDeadline < now;

      // Tax year date range
      const startYear = parseInt(yearLabel.split('/')[0]);
      const taxYearStart = new Date(startYear, 3, 6);
      const taxYearEnd = new Date(startYear + 1, 3, 5, 23, 59, 59, 999);

      // For current year, project annual revenue
      let annualRevenue = revenue;
      let projectedNote = '';
      if (isCurrent) {
        const msElapsed = now.getTime() - taxYearStart.getTime();
        const daysElapsed = Math.max(1, Math.round(msElapsed / 86400000));
        const totalDays = Math.round((taxYearEnd.getTime() - taxYearStart.getTime()) / 86400000);
        annualRevenue = Math.round(revenue * totalDays / daysElapsed);
        projectedNote = `Projected from ${daysElapsed} days of data`;
      }

      // === Business deductions (always claimable) ===
      const homeOffice = this.calculateHomeOfficeDeduction(yearLabel);
      const capitalLosses = RevenueService.CAPITAL_LOSSES
        .filter(l => l.yearLabel === yearLabel)
        .reduce((sum, l) => sum + l.amount, 0);
      const capitalLossItems = RevenueService.CAPITAL_LOSSES.filter(l => l.yearLabel === yearLabel);
      const totalOtherDeductions = homeOffice.deduction + capitalLosses;

      // === Scenario 1: No AIA (but with home office + capital losses) ===
      const noAiaTaxableProfit = Math.max(0, annualRevenue - totalOtherDeductions);
      const noAiaIT = this.calculateIncomeTaxForYear(noAiaTaxableProfit, yearLabel);
      const noAiaNIC = this.calculateClass4NICForYear(noAiaTaxableProfit, yearLabel);
      const noAiaClass2 = this.calculateClass2NIC(noAiaTaxableProfit, yearLabel);
      const noAiaTax = noAiaIT.total + noAiaNIC.total + noAiaClass2;

      // === Scenario 2: With AIA + all deductions ===
      const aiaDeduction = Math.min(equipment.totalValue, annualRevenue);
      const allDeductions = aiaDeduction + totalOtherDeductions;
      const aiaTaxableProfit = Math.max(0, annualRevenue - allDeductions);
      const aiaIT = this.calculateIncomeTaxForYear(aiaTaxableProfit, yearLabel);
      const aiaNIC = this.calculateClass4NICForYear(aiaTaxableProfit, yearLabel);
      const aiaClass2 = this.calculateClass2NIC(aiaTaxableProfit, yearLabel);
      const aiaTax = aiaIT.total + aiaNIC.total + aiaClass2;

      // Use "no AIA" tax for penalty calculations (conservative — assumes no AIA claimed yet)
      const taxForPenalties = noAiaTax;

      // Filing penalties
      const filingPenalties = this.calculateFilingPenalties(taxForPenalties, rates.filingDeadline, now);

      // Payment penalties
      const paymentPenalties = this.calculatePaymentPenalties(taxForPenalties, rates.paymentDeadline, now);

      // Interest on unpaid tax
      const interest = this.calculateInterest(taxForPenalties, rates.paymentDeadline, now);

      // Status determination
      let status: 'no_tax' | 'current' | 'future' | 'overdue' | 'urgent';
      if (isCurrent) {
        status = 'current';
      } else if (rates.filingDeadline > now) {
        status = 'future';
      } else if (noAiaTax === 0) {
        status = 'no_tax';
      } else if (filingPenalties.daysLate <= 30) {
        status = 'urgent';
      } else {
        status = 'overdue';
      }

      const totalPenalties = filingPenalties.total + paymentPenalties.total;

      grandTotalTax += noAiaTax;
      grandTotalPenalties += totalPenalties;
      grandTotalInterest += interest;

      years.push({
        yearLabel,
        taxYearStart: taxYearStart.toISOString().split('T')[0],
        taxYearEnd: taxYearEnd.toISOString().split('T')[0],
        status,
        isCurrent,
        revenue,
        annualRevenue,
        projectedNote,
        months,

        // Business deductions (always claimable, separate from AIA)
        deductions: {
          homeOffice: {
            totalRent: homeOffice.totalRent,
            businessPct: RevenueService.HOME_OFFICE_BUSINESS_PCT * 100,
            deduction: homeOffice.deduction,
            months: homeOffice.months,
            method: 'Actual cost (30% business use of rent)',
          },
          capitalLosses: capitalLossItems.map(l => ({ description: l.description, amount: l.amount })),
          totalOtherDeductions,
        },

        // No AIA scenario (with home office + capital losses, but no equipment AIA)
        noAia: {
          taxableProfit: noAiaTaxableProfit,
          personalAllowance: noAiaIT.personalAllowance,
          incomeTax: noAiaIT.total,
          incomeTaxBands: noAiaIT.bands,
          class4NIC: noAiaNIC.total,
          class4NIBands: noAiaNIC.bands,
          class2NIC: noAiaClass2,
          totalTax: noAiaTax,
          effectiveRate: annualRevenue > 0 ? Math.round(noAiaTax / annualRevenue * 1000) / 10 : 0,
        },

        // With AIA scenario (all deductions: AIA + home office + capital losses)
        withAia: {
          aiaDeduction,
          totalDeductions: allDeductions,
          taxableProfit: aiaTaxableProfit,
          personalAllowance: aiaIT.personalAllowance,
          incomeTax: aiaIT.total,
          incomeTaxBands: aiaIT.bands,
          class4NIC: aiaNIC.total,
          class4NIBands: aiaNIC.bands,
          class2NIC: aiaClass2,
          totalTax: aiaTax,
          effectiveRate: annualRevenue > 0 ? Math.round(aiaTax / annualRevenue * 1000) / 10 : 0,
          note: 'AIA can only be claimed once per item. Allocation across years depends on actual purchase dates.',
        },

        // Penalties (based on no-AIA tax — conservative)
        penalties: {
          filingDeadline: rates.filingDeadline.toISOString().split('T')[0],
          paymentDeadline: rates.paymentDeadline.toISOString().split('T')[0],
          filingDaysLate: filingPenalties.daysLate,
          filing: filingPenalties,
          payment: paymentPenalties,
          interest,
          totalPenalties,
          totalOwed: noAiaTax + totalPenalties + interest,
        },
      });
    }

    const totalHomeOffice = years.reduce((s, y) => s + y.deductions.homeOffice.deduction, 0);
    const totalCapitalLosses = years.reduce((s: number, y: any) => s + y.deductions.capitalLosses.reduce((ss: number, l: any) => ss + l.amount, 0), 0);

    return {
      generatedAt: now.toISOString(),
      currentTaxYear: currentTaxYear.label,
      equipmentTotalValue: equipment.totalValue,
      equipmentNote: 'AIA can be allocated to any year with sufficient equipment purchases. Without knowing exact purchase dates, full value is shown for each year as a ceiling.',
      homeOfficeMethod: `Actual cost method: ${RevenueService.HOME_OFFICE_BUSINESS_PCT * 100}% business use of rent (sole trader managing rental business from bedroom)`,
      dzoLensesNote: 'DZO lenses (cost £5,200, insurance £6,000): AIA deduction clawed back via £5,200 balancing charge (disposal value capped at cost per CAA 2001 s.62). £800 excess is CGT-exempt within annual allowance. Net effect: tax-neutral.',

      years,

      grandTotals: {
        totalTax: grandTotalTax,
        totalPenalties: grandTotalPenalties,
        totalInterest: grandTotalInterest,
        totalOwed: grandTotalTax + grandTotalPenalties + grandTotalInterest,
        totalHomeOfficeDeductions: totalHomeOffice,
        totalCapitalLosses,
        withAia: {
          totalTax: years.reduce((s, y) => s + y.withAia.totalTax, 0),
          totalOwed: years.reduce((s, y) => s + y.withAia.totalTax + y.penalties.totalPenalties + y.penalties.interest, 0),
        },
      },
    };
  }
}
