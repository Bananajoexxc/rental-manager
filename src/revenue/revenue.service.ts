import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService, HyggloAccount } from '../hygglo/hygglo.service';
import { isAccessoryItem, MASTER_INVENTORY } from '../utils/item-matcher';
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
}

type BookingLifecycle = 'completed' | 'ongoing' | 'upcoming';

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

  constructor(
    private prisma: PrismaService,
    private hyggloService: HyggloService,
  ) {}

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
      },
    });

    // Deduplicate by listing_id + renter_info + start_date (keep highest revenue)
    const seen = new Map<string, RentalRevenueRow>();
    for (const r of rentals) {
      if (!r.start_date || !r.renter_info) continue;
      const key = `${r.listing_id}|${r.renter_info}|${r.start_date.toISOString().split('T')[0]}`;
      const existing = seen.get(key);
      if (!existing || (r.rental_price || 0) > (existing.rental_price || 0)) {
        seen.set(key, r as RentalRevenueRow);
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
   * 'month' = current calendar month, 'week' = last 7 days, 'all' = all time.
   */
  async getRevenueForPeriod(period: 'week' | 'month' | 'all', account?: string) {
    const rentals = await this.getRentalsWithRevenue(account);
    const { start, end } = this.getFlexiblePeriodRange(period);

    const filtered = rentals.filter(r => {
      if (start && r.start_date! < start) return false;
      if (end && r.start_date! >= end) return false;
      return true;
    });

    // rental_price = Daniel's earnings (ownerEarnings from Hygglo, post-platform-fee)
    const totalEarnings = filtered.reduce((sum, r) => sum + (r.rental_price || 0), 0);

    // Count unique rental visits, not raw item rows
    const visitKeys = new Set<string>();
    for (const r of filtered) {
      const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
      visitKeys.add(`${renterNorm}|${r.start_date!.toISOString().split('T')[0]}`);
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
   * Weekly revenue totals — from RENTAL table. Revenue attributed to the week the rental started.
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
        r.start_date! >= weekStart && r.start_date! <= weekEnd
      );

      const earnings = weekRentals.reduce((sum, r) => sum + (r.rental_price || 0), 0);
      // Count unique rental visits, not raw item rows
      const visitKeys = new Set<string>();
      for (const r of weekRentals) {
        const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
        visitKeys.add(`${renterNorm}|${r.start_date!.toISOString().split('T')[0]}`);
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
   * Monthly revenue totals — from RENTAL table. Counts all rentals starting in each month.
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
        r.start_date! >= monthStart && r.start_date! < monthEnd
      );

      const earnings = monthRentals.reduce((sum, r) => sum + (r.rental_price || 0), 0);

      // Count unique rental visits (renter+date), not raw item rows
      const visitKeys = new Set<string>();
      for (const r of monthRentals) {
        const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
        visitKeys.add(`${renterNorm}|${r.start_date!.toISOString().split('T')[0]}`);
      }

      // For current month, include lifecycle breakdown (by visit)
      const isCurrentMonth = i === 0;
      let breakdown: { completed: number; ongoing: number; upcoming: number } | undefined;
      if (isCurrentMonth) {
        // Group into visits for lifecycle breakdown
        const visitMap = new Map<string, { startDate: Date; endDate: Date }>();
        for (const r of monthRentals) {
          const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
          const key = `${renterNorm}|${r.start_date!.toISOString().split('T')[0]}`;
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
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);

      const monthRentals = rentals.filter(r =>
        r.start_date! >= monthStart && r.start_date! < monthEnd
      );

      const revenue = monthRentals.reduce((sum, r) => sum + (r.rental_price || 0), 0);
      const rounded = Math.round(revenue * 100) / 100;
      cumulative += rounded;

      // Count unique rental visits
      const visitKeys = new Set<string>();
      for (const r of monthRentals) {
        const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
        visitKeys.add(`${renterNorm}|${r.start_date!.toISOString().split('T')[0]}`);
      }

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
    const currentMonth = now.toISOString().split('T')[0].substring(0, 7);
    const nonZeroMonths = results.filter(m => m.revenue > 0);
    const completedNonZero = nonZeroMonths.filter(m => m.month !== currentMonth);
    const avgMonthly = nonZeroMonths.length > 0
      ? Math.round(nonZeroMonths.reduce((s, m) => s + m.revenue, 0) / nonZeroMonths.length)
      : 0;
    const strongest = nonZeroMonths.length > 0
      ? nonZeroMonths.reduce((best, m) => m.revenue > best.revenue ? m : best)
      : null;
    const weakest = completedNonZero.length > 0
      ? completedNonZero.reduce((worst, m) => m.revenue < worst.revenue ? m : worst)
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

    // Current month rentals
    const currentMonth = allRentals.filter(r =>
      r.start_date! >= currentMonthStart && r.start_date! < nextMonthStart
    );

    const currentEarnings = currentMonth.reduce((sum, r) => sum + (r.rental_price || 0), 0);

    // Group into rental visits (renter+date = one visit) for breakdown counts
    const rentalGroups = new Map<string, { earnings: number; startDate: Date; endDate: Date }>();
    for (const r of currentMonth) {
      const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const key = `${renterNorm}|${r.start_date!.toISOString().split('T')[0]}`;
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

    // Historical data: previous 2 months (from rental table)
    const prev1Start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prev2Start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const prev1End = currentMonthStart;
    const prev2End = prev1Start;

    const prev1Earnings = allRentals.filter(r => r.start_date! >= prev1Start && r.start_date! < prev1End)
      .reduce((sum, r) => sum + (r.rental_price || 0), 0);
    const prev2Earnings = allRentals.filter(r => r.start_date! >= prev2Start && r.start_date! < prev2End)
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
   * Account breakdown — from RENTAL table.
   */
  async getAccountBreakdown(period: 'week' | 'month' | 'all', account?: string) {
    const rentals = await this.getRentalsWithRevenue(account);
    const { start, end } = this.getFlexiblePeriodRange(period);
    const filtered = rentals.filter(r => {
      if (start && r.start_date! < start) return false;
      if (end && r.start_date! >= end) return false;
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
      visitKeysByAccount[acc].add(`${renterNorm}|${r.start_date!.toISOString().split('T')[0]}`);
    }
    // Use visit-deduped counts
    for (const acc of Object.keys(byAccount)) {
      byAccount[acc].count = visitKeysByAccount[acc].size;
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
      if (start && r.start_date! < start) return false;
      if (end && r.start_date! >= end) return false;
      return true;
    });

    // Split: rentals with parsed items vs without
    const filtered = periodFiltered.filter(r => r.parsed_items && (r.parsed_items as any[]).length > 0);
    const noParsedItems = periodFiltered.filter(r => !r.parsed_items || (r.parsed_items as any[]).length === 0);

    // Distribute revenue proportionally for each rental using parsed_items
    const byItem: Record<string, { profit: number; revenue: number; count: number }> = {};
    // Revenue from rentals with no parsed_items goes straight to otherRevenue
    let otherRevenue = noParsedItems.reduce((sum, r) => sum + (r.rental_price || 0), 0);
    for (const r of filtered) {
      const items = (r.parsed_items as { item: string; qty: number }[])
        .map(p => ({ item_name: p.item, qty: p.qty || 1 }));
      const attributed = this.distributeRevenueProportionally(items, r.rental_price || 0);
      for (const a of attributed) {
        // Only include items that exist in MASTER_INVENTORY
        if (!MASTER_INVENTORY[a.item_name]) {
          otherRevenue += a.attributedRevenue;
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

    // Ensure displayed items + otherRevenue = total period revenue (no revenue lost)
    const totalPeriodRevenue = periodFiltered.reduce((sum, r) => sum + (r.rental_price || 0), 0);
    const displayedTotal = items.reduce((sum, i) => sum + i.profit, 0);
    otherRevenue = totalPeriodRevenue - displayedTotal;

    return { items, otherRevenue: Math.round(otherRevenue * 100) / 100, totalRevenue: Math.round(totalPeriodRevenue * 100) / 100 } as any;
  }

  /**
   * All items revenue breakdown — full list, not just top 10.
   * Uses parsed_items from rental table (AI-parsed, covers 100% of revenue).
   * Includes monthly breakdown for each item.
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
    period: string;
    totalRevenue: number;
    otherRevenue: number;
  }> {
    const rentals = await this.getRentalsWithRevenue(account);
    const { start, end } = this.getFlexiblePeriodRange(period);

    const periodFiltered = rentals.filter(r => {
      if (start && r.start_date! < start) return false;
      if (end && r.start_date! >= end) return false;
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
    let otherRevenue = noParsedItems.reduce((sum, r) => sum + (r.rental_price || 0), 0);

    for (const r of filtered) {
      const month = r.start_date!.toISOString().substring(0, 7);
      const items = (r.parsed_items as { item: string; qty: number }[])
        .map(p => ({ item_name: p.item, qty: p.qty || 1 }));
      const attributed = this.distributeRevenueProportionally(items, r.rental_price || 0);
      for (const a of attributed) {
        // Only include items that exist in MASTER_INVENTORY
        if (!MASTER_INVENTORY[a.item_name]) {
          otherRevenue += a.attributedRevenue;
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

    // Ensure items + otherRevenue = total period revenue (no revenue lost)
    const totalPeriodRevenue = periodFiltered.reduce((sum, r) => sum + (r.rental_price || 0), 0);
    const attributedTotal = Object.values(byItem).reduce((sum, i) => sum + i.totalRevenue, 0);
    otherRevenue = totalPeriodRevenue - attributedTotal;

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

    return {
      items,
      period,
      totalRevenue: Math.round(totalPeriodRevenue * 100) / 100,
      otherRevenue: Math.round(otherRevenue * 100) / 100,
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

    // 4. CONVERSION FUNNEL — actual conversion rate vs pre-AI baseline
    const confirmedStages = await this.prisma.follow_up_state.count({
      where: { conversation_stage: { in: ['confirmed', 'completed', 'booked'] } },
    });
    const actualConversion = totalStates > 0 ? confirmedStages / totalStates : baselines.conversionRate;
    const conversionLift = Math.max(0, (actualConversion - baselines.conversionRate) / baselines.conversionRate);
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
        { name: 'Conversion Lift', rate: Math.round(conversionRate * 100) / 100, measured: Math.round(actualConversion * 100) / 100, baseline: baselines.conversionRate, description: `${Math.round(actualConversion * 100)}% conversion vs ${Math.round(baselines.conversionRate * 100)}% pre-AI (data-derived)` },
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
      r.start_date! >= start && r.start_date! < end,
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
