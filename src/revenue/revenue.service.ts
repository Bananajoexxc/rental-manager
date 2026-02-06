import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RevenueService {
  private readonly logger = new Logger(RevenueService.name);

  constructor(private prisma: PrismaService) {}

  async recordRevenue(bookingId: string, revenue: number, platformFee = 0, deliveryFee = 0) {
    const netProfit = revenue - platformFee - deliveryFee;
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { revenue, platform_fee: platformFee, delivery_fee: deliveryFee, net_profit: netProfit },
    });
  }

  async getRevenueForPeriod(period: 'week' | 'month' | 'all') {
    const since = this.getPeriodStart(period);
    const where: any = { status: { not: 'cancelled' }, revenue: { not: null } };
    if (since) where.start_date = { gte: since };

    const bookings = await this.prisma.booking.findMany({ where });

    const totalRevenue = bookings.reduce((sum, b) => sum + (b.revenue || 0), 0);
    const totalFees = bookings.reduce((sum, b) => sum + (b.platform_fee || 0), 0);
    const totalDelivery = bookings.reduce((sum, b) => sum + (b.delivery_fee || 0), 0);
    const totalProfit = bookings.reduce((sum, b) => sum + (b.net_profit || 0), 0);

    return {
      bookings: bookings.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalFees: Math.round(totalFees * 100) / 100,
      totalDelivery: Math.round(totalDelivery * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
    };
  }

  async getWeeklyTotals(weeks = 8) {
    const results: { week: string; revenue: number; profit: number }[] = [];
    const now = new Date();

    for (let i = 0; i < weeks; i++) {
      const weekEnd = new Date(now);
      weekEnd.setDate(weekEnd.getDate() - i * 7);
      const weekStart = new Date(weekEnd);
      weekStart.setDate(weekStart.getDate() - 7);

      const bookings = await this.prisma.booking.findMany({
        where: {
          status: { not: 'cancelled' },
          revenue: { not: null },
          start_date: { gte: weekStart, lt: weekEnd },
        },
      });

      const revenue = bookings.reduce((sum, b) => sum + (b.revenue || 0), 0);
      const profit = bookings.reduce((sum, b) => sum + (b.net_profit || 0), 0);
      results.push({
        week: weekStart.toISOString().split('T')[0],
        revenue: Math.round(revenue * 100) / 100,
        profit: Math.round(profit * 100) / 100,
      });
    }

    return results.reverse();
  }

  async getMonthlyTotals(months = 6) {
    const results: { month: string; revenue: number; profit: number }[] = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

      const bookings = await this.prisma.booking.findMany({
        where: {
          status: { not: 'cancelled' },
          revenue: { not: null },
          start_date: { gte: monthStart, lt: monthEnd },
        },
      });

      const revenue = bookings.reduce((sum, b) => sum + (b.revenue || 0), 0);
      const profit = bookings.reduce((sum, b) => sum + (b.net_profit || 0), 0);
      results.push({
        month: monthStart.toISOString().split('T')[0].substring(0, 7),
        revenue: Math.round(revenue * 100) / 100,
        profit: Math.round(profit * 100) / 100,
      });
    }

    return results.reverse();
  }

  async getAccountBreakdown(period: 'week' | 'month' | 'all') {
    const since = this.getPeriodStart(period);
    const where: any = { status: { not: 'cancelled' }, revenue: { not: null } };
    if (since) where.start_date = { gte: since };

    const bookings = await this.prisma.booking.findMany({ where });

    const byAccount: Record<string, { revenue: number; profit: number; count: number }> = {};
    for (const b of bookings) {
      if (!byAccount[b.account]) byAccount[b.account] = { revenue: 0, profit: 0, count: 0 };
      byAccount[b.account].revenue += b.revenue || 0;
      byAccount[b.account].profit += b.net_profit || 0;
      byAccount[b.account].count++;
    }

    return byAccount;
  }

  async getTopEarningItems(period: 'week' | 'month' | 'all') {
    const since = this.getPeriodStart(period);
    const where: any = { status: { not: 'cancelled' }, revenue: { not: null } };
    if (since) where.start_date = { gte: since };

    const bookings = await this.prisma.booking.findMany({ where });

    const byItem: Record<string, { revenue: number; count: number }> = {};
    for (const b of bookings) {
      if (!byItem[b.item_name]) byItem[b.item_name] = { revenue: 0, count: 0 };
      byItem[b.item_name].revenue += b.revenue || 0;
      byItem[b.item_name].count++;
    }

    return Object.entries(byItem)
      .map(([item, data]) => ({ item, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);
  }

  async getFormattedRevenue(period: 'week' | 'month' | 'all'): Promise<string> {
    const [summary, accounts, topItems, weekly] = await Promise.all([
      this.getRevenueForPeriod(period),
      this.getAccountBreakdown(period),
      this.getTopEarningItems(period),
      period === 'week' ? this.getWeeklyTotals(4) : this.getWeeklyTotals(8),
    ]);

    const lines: string[] = [`Earnings Summary (${period}):`];
    lines.push(`Bookings: ${summary.bookings}`);
    lines.push(`Earnings: £${summary.totalRevenue}`);

    if (Object.keys(accounts).length > 0) {
      lines.push('\nBy Account:');
      for (const [acc, data] of Object.entries(accounts)) {
        lines.push(`  ${acc}: £${Math.round(data.revenue * 100) / 100} earnings, ${data.count} bookings`);
      }
    }

    if (topItems.length > 0) {
      lines.push('\nTop Earners:');
      for (const item of topItems.slice(0, 5)) {
        lines.push(`  £${Math.round(item.revenue * 100) / 100} - ${item.item} (${item.count}x)`);
      }
    }

    if (weekly.length > 0) {
      const maxRev = Math.max(...weekly.map((w) => w.revenue), 1);
      lines.push('\nWeekly Trend:');
      for (const w of weekly) {
        const barLen = Math.round((w.revenue / maxRev) * 20);
        const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
        lines.push(`  ${w.week} ${bar} £${w.revenue}`);
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
   * Returns aggregated data by metric type for a given period.
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

  /**
   * Format revenue metrics for the autolearn feedback summary.
   */
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

  private getPeriodStart(period: 'week' | 'month' | 'all'): Date | null {
    if (period === 'all') return null;
    const d = new Date();
    if (period === 'week') d.setDate(d.getDate() - 7);
    if (period === 'month') d.setMonth(d.getMonth() - 1);
    return d;
  }
}
