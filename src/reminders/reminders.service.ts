import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { CalendarService } from '../calendar/calendar.service';
import { MemoryService } from '../memory/memory.service';
import { RevenueService } from '../revenue/revenue.service';

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  private readonly arrivalReminderText =
    'When you arrive at Trafalgar Square, wait by the Statue of James II next to the Sainsburys Wing entrance ' +
    'of the National Gallery & text arrived in this chat - well be right with you. PLEASE DONT GO IN ANYWHERE. ' +
    'Location: https://share.google/G28UkWpFMDB2BDVWi ' +
    'If someone else picks up, forward this - they need the booking number or screenshot of this chat.';

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private calendarService: CalendarService,
    private memoryService: MemoryService,
    private revenueService: RevenueService,
  ) {}

  // Every minute: check for upcoming pickups and late returns
  @Cron('* * * * *')
  async checkReminders() {
    const now = new Date();

    try {
      // Check for pickups in next 5 minutes that haven't been reminded
      await this.checkUpcomingPickups(now);
      // Check for returns 30+ min late
      await this.checkLateReturns(now);
    } catch (error) {
      this.logger.error(`Reminder check error: ${error.message}`);
    }
  }

  private async checkUpcomingPickups(now: Date) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        pickup_reminded: false,
        start_date: { gte: today, lte: todayEnd },
        pickup_time: { not: null },
      },
    });

    for (const booking of bookings) {
      if (!booking.pickup_time) continue;

      const [hours, minutes] = booking.pickup_time.split(':').map(Number);
      const pickupTime = new Date(today);
      pickupTime.setHours(hours, minutes, 0, 0);

      const diffMin = (pickupTime.getTime() - now.getTime()) / (1000 * 60);

      if (diffMin <= 5 && diffMin >= -2) {
        await this.telegramService.sendProactiveMessage(
          `🔔 *Pickup Reminder*\n\n` +
          `├ 👤 ${booking.renter_name}\n` +
          `├ 📦 ${booking.item_name}\n` +
          `├ ⏰ ${booking.pickup_time}\n` +
          `└ 👤 ${booking.account}\n\n` +
          `_Arrival reminder ready to send._`,
        );

        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { pickup_reminded: true },
        });
      }
    }
  }

  private async checkLateReturns(now: Date) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        return_reminded: false,
        end_date: { gte: today, lte: todayEnd },
        return_time: { not: null },
      },
    });

    for (const booking of bookings) {
      if (!booking.return_time) continue;

      const [hours, minutes] = booking.return_time.split(':').map(Number);
      const returnTime = new Date(today);
      returnTime.setHours(hours, minutes, 0, 0);

      const diffMin = (now.getTime() - returnTime.getTime()) / (1000 * 60);

      if (diffMin >= 30) {
        await this.telegramService.sendProactiveMessage(
          `🚨 *LATE RETURN*\n\n` +
          `├ 👤 ${booking.renter_name}\n` +
          `├ 📦 ${booking.item_name}\n` +
          `├ ⏰ Expected: ${booking.return_time} (30+ min late)\n` +
          `└ 👤 ${booking.account}\n\n` +
          `_Check for booking conflicts._`,
        );

        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { return_reminded: true },
        });
      }
    }
  }

  // Morning briefing at 9am with revenue
  @Cron('0 9 * * *')
  async morningBriefing() {
    this.logger.log('Running morning briefing...');

    try {
      const revMsg = await this.buildDailyRevenueMessage();

      const today = new Date();
      const schedule = await this.calendarService.getFormattedSchedule(today);

      const totalConfirmed = await this.prisma.booking.count({
        where: { status: 'confirmed' },
      });

      await this.telegramService.sendProactiveMessage(
        `☀️ *Morning Briefing*\n\n` +
        `${schedule}\n\n` +
        `${revMsg}\n\n` +
        `📋 Active bookings: ${totalConfirmed}`,
      );
    } catch (error) {
      this.logger.error(`Morning briefing error: ${error.message}`);
    }
  }

  // Evening revenue update at 6pm
  @Cron('0 18 * * *')
  async eveningRevenueUpdate() {
    this.logger.log('Running evening revenue update...');

    try {
      const revMsg = await this.buildDailyRevenueMessage();
      const weekRevenue = await this.revenueService.getRevenueForPeriod('week');

      await this.telegramService.sendProactiveMessage(
        `🌙 *Evening Revenue*\n\n` +
        `${revMsg}\n\n` +
        `💰 *Week total:* £${weekRevenue.totalRevenue} revenue, £${weekRevenue.totalProfit} profit (${weekRevenue.bookings} bookings)`,
      );
    } catch (error) {
      this.logger.error(`Evening revenue update error: ${error.message}`);
    }
  }

  /**
   * Build daily revenue message — only bookings starting today count.
   */
  private async buildDailyRevenueMessage(): Promise<string> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const todayBookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        start_date: { gte: todayStart, lte: todayEnd },
      },
      orderBy: { start_date: 'asc' },
    });

    const todayRevenue = todayBookings.reduce((sum, b) => sum + (b.revenue || 0), 0);
    const todayProfit = todayBookings.reduce((sum, b) => sum + (b.net_profit || 0), 0);

    const lines: string[] = [];
    for (const b of todayBookings) {
      lines.push(`  ${b.item_name} — ${b.renter_name}: £${b.revenue || 0}`);
    }

    let msg = `*Today's Revenue (${todayBookings.length} bookings):*\n`;
    msg += `  £${Math.round(todayRevenue * 100) / 100} revenue, £${Math.round(todayProfit * 100) / 100} profit\n`;
    if (lines.length > 0) {
      msg += `\n${lines.join('\n')}`;
    }

    return msg;
  }

  async getTodayScheduleFormatted(): Promise<string> {
    return this.calendarService.getFormattedSchedule(new Date());
  }
}
