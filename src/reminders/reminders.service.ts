import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { CalendarService } from '../calendar/calendar.service';
import { MemoryService } from '../memory/memory.service';
import { RevenueService } from '../revenue/revenue.service';
import { HyggloService } from '../hygglo/hygglo.service';

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
    private hyggloService: HyggloService,
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

  // Hourly: auto-assign missing pickup/return times for bookings starting tomorrow
  @Cron('0 * * * *')
  async autoAssignMissingTimes() {
    try {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      const tomorrowEnd = new Date(tomorrow);
      tomorrowEnd.setHours(23, 59, 59, 999);

      // Find confirmed bookings starting tomorrow with missing times
      const bookingsNoTimes = await this.prisma.booking.findMany({
        where: {
          status: 'confirmed',
          start_date: { gte: tomorrow, lte: tomorrowEnd },
          OR: [
            { pickup_time: null },
            { return_time: null },
          ],
        },
        include: { rental: true },
      });

      if (bookingsNoTimes.length === 0) return;

      // Check follow_up_state: only auto-assign if stage is confirmed and not already auto-assigned
      const rentalIds = [...new Set(bookingsNoTimes.map(b => b.rental_id).filter(Boolean))] as string[];
      const followUpStates = await this.prisma.follow_up_state.findMany({
        where: {
          rental_id: { in: rentalIds },
          conversation_stage: 'confirmed',
          times_auto_assigned: false,
        },
      });
      const eligibleRentalIds = new Set(followUpStates.map(s => s.rental_id));

      // Get ALL bookings for tomorrow (with times) for trip optimization
      const allTomorrowBookings = await this.prisma.booking.findMany({
        where: {
          status: 'confirmed',
          start_date: { gte: tomorrow, lte: tomorrowEnd },
        },
      });

      // Find the most popular pickup time cluster
      const pickupClusters = new Map<string, number>();
      const returnClusters = new Map<string, number>();
      for (const b of allTomorrowBookings) {
        if (b.pickup_time) pickupClusters.set(b.pickup_time, (pickupClusters.get(b.pickup_time) || 0) + 1);
        if (b.return_time) returnClusters.set(b.return_time, (returnClusters.get(b.return_time) || 0) + 1);
      }

      // Find most popular times (or defaults)
      const bestPickup = this.findMostPopularTime(pickupClusters) || '10:00';
      const bestReturn = this.findMostPopularTime(returnClusters) || '19:00';

      for (const booking of bookingsNoTimes) {
        if (!booking.rental_id || !eligibleRentalIds.has(booking.rental_id)) continue;

        const assignPickup = !booking.pickup_time;
        const assignReturn = !booking.return_time;

        let pickupTime = booking.pickup_time || bestPickup;
        let returnTime = booking.return_time || bestReturn;

        // Validate cluster time, fall back to alternatives if conflict
        if (assignPickup) {
          pickupTime = await this.findSafeTimeSlot(
            booking.item_name, booking.start_date, bestPickup, 'pickup', booking.rental_id,
          );
        }

        if (assignReturn) {
          const returnDate = booking.end_date || booking.start_date;
          returnTime = await this.findSafeTimeSlot(
            booking.item_name, returnDate, bestReturn, 'return', booking.rental_id,
          );
        }

        // Update booking
        const updateData: any = {};
        if (assignPickup) updateData.pickup_time = pickupTime;
        if (assignReturn) updateData.return_time = returnTime;

        await this.prisma.booking.update({
          where: { id: booking.id },
          data: updateData,
        });

        this.logger.log(`Auto-assigned times for ${booking.item_name} (${booking.renter_name}): pickup=${pickupTime}, return=${returnTime}`);

        // Notify Daniel
        await this.telegramService.sendProactiveMessage(
          `⏰ *Auto-Assigned Times*\n\n` +
          `├ 📦 ${booking.item_name}\n` +
          `├ 👤 ${booking.renter_name}\n` +
          `├ 📅 ${booking.start_date.toISOString().split('T')[0]}\n` +
          `├ ⏰ Pickup: ${pickupTime}\n` +
          `├ ⏰ Return: ${returnTime}\n` +
          `└ Renter will be notified`,
        );

        // Notify renter via Hygglo
        if (booking.rental?.listing_id) {
          try {
            await this.hyggloService.sendMessage(
              booking.rental.listing_id,
              `Since the rental starts tomorrow, I've set pickup for ${pickupTime} and return for ${returnTime}. Let me know if you need to adjust!`,
            );
          } catch (sendErr) {
            this.logger.warn(`Failed to notify renter about auto-assigned times: ${sendErr.message}`);
          }
        }
      }

      // Update follow_up_state for all processed rentals
      for (const rentalId of eligibleRentalIds) {
        const hasBooking = bookingsNoTimes.some(b => b.rental_id === rentalId);
        if (!hasBooking) continue;

        await this.prisma.follow_up_state.updateMany({
          where: { rental_id: rentalId },
          data: {
            times_status: 'auto_assigned',
            times_auto_assigned: true,
            times_auto_assigned_at: new Date(),
          },
        });
      }
    } catch (error) {
      this.logger.error(`autoAssignMissingTimes cron error: ${error.message}`);
    }
  }

  /**
   * Find the most popular time from a cluster map.
   */
  private findMostPopularTime(clusters: Map<string, number>): string | null {
    if (clusters.size === 0) return null;
    let best: string | null = null;
    let bestCount = 0;
    for (const [time, count] of clusters) {
      if (count > bestCount) {
        best = time;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * Find a safe time slot that doesn't conflict with other bookings.
   * Tries the preferred time first, then falls back to alternatives.
   */
  private async findSafeTimeSlot(
    itemName: string,
    date: Date,
    preferredTime: string,
    type: 'pickup' | 'return',
    excludeRentalId?: string,
  ): Promise<string> {
    // Try preferred time
    const check = await this.calendarService.checkTimeConflict(
      itemName, date, preferredTime, type, excludeRentalId,
    );
    if (!check.conflict) return preferredTime;

    // Fallback times: work backward from evening for pickup, forward from morning for return
    const fallbacks = type === 'pickup'
      ? ['10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']
      : ['19:00', '18:00', '17:00', '16:00', '15:00', '14:00', '12:00', '11:00', '10:00'];

    for (const fallback of fallbacks) {
      if (fallback === preferredTime) continue;
      const fbCheck = await this.calendarService.checkTimeConflict(
        itemName, date, fallback, type, excludeRentalId,
      );
      if (!fbCheck.conflict) return fallback;
    }

    // Ultimate fallback: return the preferred time anyway (best effort)
    return preferredTime;
  }
}
