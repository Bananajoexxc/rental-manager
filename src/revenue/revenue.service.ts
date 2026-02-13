import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService, HyggloAccount } from '../hygglo/hygglo.service';
import { isAccessoryItem, MASTER_INVENTORY, findBestMatch, getInventoryItemNames } from '../utils/item-matcher';
import { getOneDayPrice } from '../data/pricing-catalog';

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

    for (const invName of inventoryNames) {
      const invLower = invName.toLowerCase().replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim();
      const invTokens = invLower.split(' ');

      // f-stop conflict: if both have f-numbers and they differ, skip (different lens)
      if (inputFStops.length > 0) {
        const invFStops = invTokens.filter(t => fStopPattern.test(t));
        if (invFStops.length > 0 && !inputFStops.some(f => invFStops.includes(f))) continue;
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
          where: { status: { in: ['confirmed', 'pending_review'] } },
          select: { pickup_date: true, return_date: true },
          take: 1,
        },
      },
    });

    // Deduplicate by listing_id + renter_info + start_date (keep highest revenue)
    const seen = new Map<string, RentalRevenueRow>();
    for (const r of rentals) {
      if (!r.start_date || !r.renter_info) continue;
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
    months: { month: string; revenue: number; cumulative: number; count: number; aiAttribution: number }[];
    totalRevenue: number;
    totalMonths: number;
    avgMonthly: number;
    strongestMonth: { month: string; revenue: number } | null;
    weakestMonth: { month: string; revenue: number } | null;
    boostRate: number;
    aiActiveFrom: string;
  }> {
    const rentals = await this.getRentalsWithRevenue(account);
    if (rentals.length === 0) return { months: [], totalRevenue: 0, totalMonths: 0, avgMonthly: 0, strongestMonth: null, weakestMonth: null, boostRate: 0, aiActiveFrom: '2026-02' };

    // Find the earliest start_date
    let earliest = new Date();
    for (const r of rentals) {
      if (r.start_date && r.start_date < earliest) earliest = r.start_date;
    }

    const now = new Date();
    const startMonth = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
    const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const results: { month: string; revenue: number; cumulative: number; count: number; aiAttribution: number }[] = [];
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
      });

      cursor.setMonth(cursor.getMonth() + 1);
    }

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

    return {
      months: results,
      totalRevenue: Math.round(cumulative * 100) / 100,
      totalMonths: results.length,
      avgMonthly,
      strongestMonth: strongest ? { month: strongest.month, revenue: strongest.revenue } : null,
      weakestMonth: weakest ? { month: weakest.month, revenue: weakest.revenue } : null,
      boostRate,
      aiActiveFrom: AI_ACTIVE_FROM,
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

    // Upcoming earnings to avoid double-counting in projection
    const upcomingEarnings = visits
      .filter(v => this.getLifecycle({ startDate: v.startDate, endDate: v.endDate }) === 'upcoming')
      .reduce((sum, v) => sum + v.earnings, 0);

    // Historical data: previous 2 months (by pickup date)
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

    // Current month daily run rate
    const currentDailyRate = daysElapsed > 0 ? currentEarnings / daysElapsed : 0;

    // Historical daily average (weighted: 60% recent, 40% older)
    let historicalDaily: number;
    if (prev1Earnings > 0 && prev2Earnings > 0) {
      historicalDaily = (prev1Earnings / prev1Days) * 0.6 + (prev2Earnings / prev2Days) * 0.4;
    } else if (prev1Earnings > 0) {
      historicalDaily = prev1Earnings / prev1Days;
    } else {
      historicalDaily = 0;
    }

    // Use the HIGHER of current trajectory vs historical average
    let dailyAvgEarnings: number;
    if (currentDailyRate > 0 && historicalDaily > 0) {
      dailyAvgEarnings = Math.max(currentDailyRate, historicalDaily);
    } else if (currentDailyRate > 0) {
      dailyAvgEarnings = currentDailyRate;
    } else {
      dailyAvgEarnings = historicalDaily;
    }

    // Projection: current confirmed + (daily rate × remaining days) - already-counted upcoming
    const projectedFromRemaining = Math.max(0, dailyAvgEarnings * daysRemaining - upcomingEarnings);
    const projectedEarnings = currentEarnings + projectedFromRemaining;

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

    const boostRate = Math.round((speedRate + availabilityRate + followUpRate + conversionRate + qualityRate) * 100) / 100;
    const dataPoints = messageDecisions + totalStates;

    return {
      boostRate: Math.max(0.05, Math.min(boostRate, 0.50)), // floor 5%, cap 50%
      factors: [
        { name: 'Response Speed', rate: Math.round(speedRate * 100) / 100, measured: Math.round(aiResponseCoverage * 100) / 100, baseline: baselines.responseCoverage, description: `${Math.round(aiResponseCoverage * 100)}% coverage vs ${Math.round(baselines.responseCoverage * 100)}% pre-AI (data-derived)` },
        { name: '24/7 Availability', rate: Math.round(availabilityRate * 100) / 100, measured: Math.round(offHoursRate * 100) / 100, baseline: baselines.offHoursHandling, description: `${Math.round(offHoursRate * 100)}% off-hours responses` },
        { name: 'Auto Follow-ups', rate: Math.round(followUpRate * 100) / 100, measured: Math.round(followUpEngagement * 100) / 100, baseline: baselines.followUpRate, description: `${Math.round(followUpEngagement * 100)}% conversations got follow-ups, ${Math.round(progressionRate * 100)}% progressed` },
        { name: 'Conversion Lift', rate: Math.round(conversionRate * 100) / 100, measured: Math.round(actualConversion * 100) / 100, baseline: baselineConversion, description: `${Math.round(actualConversion * 100)}% conversion vs ${Math.round(baselineConversion * 100)}% month-1 (${conversionBaselineSource})` },
        { name: 'Quality Premium', rate: Math.round(qualityRate * 100) / 100, measured: Math.round(aiQuality * 100) / 100, baseline: baselines.qualityScore, description: `${Math.round(aiQuality * 100)}% quality vs ${Math.round(baselines.qualityScore * 100)}% pre-AI (data-derived)` },
      ],
      evaluatedAt: new Date().toISOString(),
      dataPoints,
    };
  }

  /** Store evaluation result in ai_decision table for persistence. */
  private async storeBoostEvaluation(evaluation: Awaited<ReturnType<typeof this.evaluateAiPerformance>>): Promise<void> {
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
        awaiting_verification: 0, confirmed: 0, completed: 0, dead: 0,
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
      const pending = stageCounts['awaiting_verification'];
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
}
