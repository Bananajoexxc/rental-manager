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

  private getPeriodStart(period: 'week' | 'month' | 'all'): Date | null {
    if (period === 'all') return null;
    const d = new Date();
    if (period === 'week') d.setDate(d.getDate() - 7);
    if (period === 'month') d.setMonth(d.getMonth() - 1);
    return d;
  }
}
