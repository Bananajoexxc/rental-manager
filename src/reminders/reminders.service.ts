import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { CalendarService } from '../calendar/calendar.service';
import { MemoryService } from '../memory/memory.service';
import { RevenueService } from '../revenue/revenue.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { getPickupLocation } from '../utils/pickup-locations';

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  private getArrivalReminderText(account: string): string {
    const location = getPickupLocation(account);
    if ((account || '').toLowerCase() === 'leo') {
      return (
        `When you arrive at ${location.shortName}, look for the Pret and wait outside — ` +
        'text arrived in this chat and we\'ll be right with you. PLEASE DON\'T GO IN ANYWHERE. ' +
        'If someone else picks up, forward this - they need the booking number or screenshot of this chat.'
      );
    }
    return (
      `When you arrive at ${location.shortName}, wait by the Statue of James II next to the Sainsburys Wing entrance ` +
      'of the National Gallery & text arrived in this chat - well be right with you. PLEASE DONT GO IN ANYWHERE. ' +
      `Location: ${location.mapsLink} ` +
      'If someone else picks up, forward this - they need the booking number or screenshot of this chat.'
    );
  }

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private calendarService: CalendarService,
    private memoryService: MemoryService,
    private revenueService: RevenueService,
    private hyggloService: HyggloService,
  ) {}

  // Every minute: check for upcoming pickups, late returns, and arrival confirmations
  @Cron('* * * * *')
  async checkReminders() {
    const now = new Date();
    const hour = now.getUTCHours();
    // Quiet hours 2-7 AM UTC — no renters active, skip all API calls
    if (hour >= 2 && hour < 7) return;

    try {
      // Check for pickups in next 5 minutes that haven't been reminded
      await this.checkUpcomingPickups(now);
      // Late return alerts disabled — Daniel handles return checks manually via dashboard
      // await this.checkLateReturns(now);
      // Send arrival confirmations to renters via Hygglo chat
      await this.checkArrivalConfirmations(now);
      // 1-hour pre-pickup/return reminders to renters with location + instructions
      await this.checkPrePickupReminders(now);
      await this.checkPreReturnReminders(now);
      // Mid-rental check-in: "everything working okay?"
      await this.checkMidRentalCheckins(now);
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
   * Build daily revenue message — only rentals starting today, one line per rental.
   */
  private async buildDailyRevenueMessage(): Promise<string> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Fetch via rentals starting today — one row per rental, not per item
    const todayRentals = await this.prisma.rental.findMany({
      where: {
        status: { in: ['upcoming', 'ongoing', 'completed'] },
        start_date: { gte: todayStart, lte: todayEnd },
      },
      select: { id: true, title: true, renter_info: true, rental_price: true, account: true },
      orderBy: { rental_price: 'desc' },
    });

    const todayRevenue = todayRentals.reduce((sum, r) => sum + (r.rental_price || 0), 0);

    const lines: string[] = [];
    for (const r of todayRentals) {
      const cleanTitle = (r.title || 'gear').split(/\s*[|–—]\s*/)[0]
        .replace(/\s*\((?:like|similar to|comparable to|replaces|vs|or)\s[^)]+\)/gi, '')
        .trim();
      const account = r.account === 'leo' ? 'Leo' : 'DB Cinema';
      const renter = (r.renter_info || 'Unknown').split(' ').slice(0, 2).join(' ');
      lines.push(`  ${renter} — ${cleanTitle}: £${Math.round(r.rental_price || 0)} (${account})`);
    }

    let msg = `*Today's Revenue (${todayRentals.length} rental${todayRentals.length !== 1 ? 's' : ''}):*\n`;
    msg += `  £${Math.round(todayRevenue)} total\n`;
    if (lines.length > 0) {
      msg += `\n${lines.join('\n')}`;
    }

    return msg;
  }

  async getTodayScheduleFormatted(): Promise<string> {
    return this.calendarService.getFormattedSchedule(new Date());
  }

  // Hourly: auto-assign missing pickup/return times — only after follow-ups triggered and ≤16h before rental
  @Cron('0 * * * *')
  async autoAssignMissingTimes() {
    try {
      const now = new Date();
      const hour = now.getUTCHours();
      // Quiet hours 2-7 AM UTC — don't send time assignment messages at night
      if (hour >= 2 && hour < 7) return;
      // Expanded window: bookings starting within next 24h OR currently ongoing
      const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Find confirmed bookings starting soon OR currently ongoing with missing times
      const bookingsNoTimes = await this.prisma.booking.findMany({
        where: {
          status: 'confirmed',
          OR: [
            // Starting within next 24h
            { start_date: { gte: now, lte: next24h } },
            // Currently ongoing (expanded: start <= now AND end >= now)
            { start_date: { lte: now }, end_date: { gte: now } },
          ],
          AND: [
            {
              OR: [
                { pickup_time: null },
                { return_time: null },
              ],
            },
          ],
        },
        include: { rental: true },
      });

      if (bookingsNoTimes.length === 0) return;

      // Stage gate: auto_assign_times only at 'confirmed' + follow-ups must have been triggered
      const rentalIds = [...new Set(bookingsNoTimes.map(b => b.rental_id).filter(Boolean))] as string[];
      const followUpStates = await this.prisma.follow_up_state.findMany({
        where: {
          rental_id: { in: rentalIds },
          conversation_stage: 'confirmed',
          times_auto_assigned: false,
          // GATE: follow-ups must have been triggered (at least one time follow-up sent)
          time_followup_count: { gte: 1 },
        },
      });

      // Additional gate: only auto-assign if ≤16h before rental start (or already ongoing)
      const eligibleRentalIds = new Set<string>();
      for (const state of followUpStates) {
        const booking = bookingsNoTimes.find(b => b.rental_id === state.rental_id);
        if (!booking) continue;

        const hoursUntilStart = (booking.start_date.getTime() - now.getTime()) / (1000 * 60 * 60);
        // Already ongoing (past start) or within 16 hours of start
        if (hoursUntilStart <= 16) {
          eligibleRentalIds.add(state.rental_id);
        } else {
          this.logger.debug(
            `Skipping auto-assign for rental ${state.rental_id}: ${hoursUntilStart.toFixed(1)}h until start (need ≤16h)`,
          );
        }
      }

      // Get ALL bookings starting within next 24h + ongoing (with times) for trip optimization
      const allUpcomingBookings = await this.prisma.booking.findMany({
        where: {
          status: 'confirmed',
          OR: [
            { start_date: { gte: now, lte: next24h } },
            { start_date: { lte: now }, end_date: { gte: now } },
          ],
        },
      });

      // Find the most popular pickup time cluster
      const pickupClusters = new Map<string, number>();
      const returnClusters = new Map<string, number>();
      for (const b of allUpcomingBookings) {
        if (b.pickup_time) pickupClusters.set(b.pickup_time, (pickupClusters.get(b.pickup_time) || 0) + 1);
        if (b.return_time) returnClusters.set(b.return_time, (returnClusters.get(b.return_time) || 0) + 1);
      }

      // Find most popular times (or defaults)
      const bestPickup = this.findMostPopularTime(pickupClusters) || '10:00';
      const bestReturn = this.findMostPopularTime(returnClusters) || '19:00';

      // Track which rental_ids have already sent notifications (one rental can have multiple bookings)
      const notifiedRentalIds = new Set<string>();

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

        // Update booking (each booking gets its own times)
        const updateData: any = {};
        if (assignPickup) updateData.pickup_time = pickupTime;
        if (assignReturn) updateData.return_time = returnTime;

        await this.prisma.booking.update({
          where: { id: booking.id },
          data: updateData,
        });

        this.logger.log(`Auto-assigned times for ${booking.item_name} (${booking.renter_name}): pickup=${pickupTime}, return=${returnTime}`);

        // Send notifications only once per rental (not once per booking item)
        if (!notifiedRentalIds.has(booking.rental_id)) {
          notifiedRentalIds.add(booking.rental_id);

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
              const assignedParts: string[] = [];
              if (assignPickup) assignedParts.push(`pickup at ${pickupTime}`);
              if (assignReturn) assignedParts.push(`return at ${returnTime}`);
              const assignedText = assignedParts.join(' and ');
              const autoAssignMsg = `Just a heads up — since we hadn't heard back on times after a few reminders, I've gone ahead and assigned ${assignedText} for your rental starting tomorrow. If those times don't work for you, just let me know and we can adjust!`;
              await this.hyggloService.sendMessage(booking.rental.listing_id, autoAssignMsg);
              if (booking.rental_id) {
                await this.memoryService.storeConversation(`rental:${booking.rental_id}`, 'assistant', autoAssignMsg, { model: 'auto-assign' });
              }
            } catch (sendErr) {
              this.logger.warn(`Failed to notify renter about auto-assigned times: ${sendErr.message}`);
            }
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

  // ══════════════════════════════════════════════
  // ARRIVAL CONFIRMATION SYSTEM
  // ══════════════════════════════════════════════

  private readonly pickupArrivalMessage2 =
    'Just following up — are you on your way for pickup? ' +
    'Let me know when you\'re here or if you need any help finding the spot.';

  private readonly returnArrivalMessage1 =
    'Hey! Just checking — have you arrived to return the gear? ' +
    'Text "arrived" when you\'re here and we\'ll come meet you.';

  private readonly returnArrivalMessage2 =
    'Following up on the return — are you on your way back? ' +
    'Let me know when you\'re here or if you need a bit more time.';

  /**
   * Check and send arrival confirmations to renters.
   * Pickup: T+5 min first message, T+15 min second message.
   * Return: same pattern.
   * Stops permanently once renter confirms arrival in chat.
   */
  private async checkArrivalConfirmations(now: Date) {
    // Get all confirmed bookings with times that are happening in a 3-day window around today
    const windowStart = new Date(now);
    windowStart.setDate(windowStart.getDate() - 1);
    windowStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(now);
    windowEnd.setDate(windowEnd.getDate() + 1);
    windowEnd.setHours(23, 59, 59, 999);

    // Simple query: get all confirmed bookings with pickup or return times in date range
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        pickup_time: { not: null },
        // Date window: either pickup_date/start_date or return_date/end_date falls within range
        OR: [
          { pickup_date: { gte: windowStart, lte: windowEnd } },
          { start_date: { gte: windowStart, lte: windowEnd } },
          { return_date: { gte: windowStart, lte: windowEnd } },
          { end_date: { gte: windowStart, lte: windowEnd } },
        ],
      },
      include: { rental: true },
    });

    // Only log when there are actually bookings to check (avoids per-minute noise)

    for (const booking of bookings) {
      try {
        const listingId = booking.rental?.listing_id;
        if (!listingId) continue;

        // === PICKUP ARRIVAL ===
        if (!booking.pickup_arrival_confirmed && booking.pickup_time) {
          const pickupDate = booking.pickup_date || booking.start_date;
          const pickupDateTime = this.buildDateTime(pickupDate, booking.pickup_time);
          if (!pickupDateTime) continue;

          const minSincePickup = (now.getTime() - pickupDateTime.getTime()) / (1000 * 60);

          // First message: 5 min after pickup time
          if (minSincePickup >= 5 && !booking.pickup_arrival_sent_at) {
            await this.sendArrivalCheck(listingId, booking.id, 'pickup', 1, booking.account);
          }
          // Second message: 15 min after pickup time (10 min after first)
          else if (minSincePickup >= 15 && booking.pickup_arrival_sent_at && !booking.pickup_arrival_followup_sent) {
            await this.sendArrivalCheck(listingId, booking.id, 'pickup', 2, booking.account);
          }
        }

        // === RETURN ARRIVAL (only after pickup confirmed) ===
        if (booking.pickup_arrival_confirmed && !booking.return_arrival_confirmed && booking.return_time) {
          const returnDate = booking.return_date || booking.end_date;
          const returnDateTime = this.buildDateTime(returnDate, booking.return_time);
          if (!returnDateTime) continue;

          const minSinceReturn = (now.getTime() - returnDateTime.getTime()) / (1000 * 60);

          // First message: 5 min after return time
          if (minSinceReturn >= 5 && !booking.return_arrival_sent_at) {
            await this.sendArrivalCheck(listingId, booking.id, 'return', 1, booking.account);
          }
          // Second message: 15 min after return time (10 min after first)
          else if (minSinceReturn >= 15 && booking.return_arrival_sent_at && !booking.return_arrival_followup_sent) {
            await this.sendArrivalCheck(listingId, booking.id, 'return', 2, booking.account);
          }
        }
      } catch (err) {
        this.logger.warn(`Arrival check failed for booking ${booking.id}: ${err.message}`);
      }
    }
  }

  /**
   * Send arrival check message via Hygglo and update booking state.
   */
  private async sendArrivalCheck(
    listingId: string,
    bookingId: string,
    phase: 'pickup' | 'return',
    messageNum: 1 | 2,
    account?: string,
  ) {
    const pickupMsg1 =
      'Hey! Just checking — have you arrived at the pickup point? ' +
      'Text "arrived" in this chat when you\'re here and we\'ll be right with you.\n\n' +
      this.getArrivalReminderText(account || 'dbcinema');

    const messages = {
      pickup: { 1: pickupMsg1, 2: this.pickupArrivalMessage2 },
      return: { 1: this.returnArrivalMessage1, 2: this.returnArrivalMessage2 },
    };

    const message = messages[phase][messageNum];

    try {
      this.logger.log(`Sending arrival check: ${phase} #${messageNum} for booking ${bookingId} via listing ${listingId}`);
      const sent = await this.hyggloService.sendMessage(listingId, message);

      // Store in conversation history so bot has context for renter replies
      try {
        const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { rental_id: true } });
        if (booking?.rental_id) {
          await this.memoryService.storeConversation(`rental:${booking.rental_id}`, 'assistant', message, { model: 'arrival-check' });
        }
      } catch { /* non-critical */ }

      // Update state: mark as sent so we don't re-send.
      // In READ_ONLY_MODE, sendMessage returns false — still update state to prevent retry spam.
      const updateData: any = {};
      if (phase === 'pickup') {
        if (messageNum === 1) updateData.pickup_arrival_sent_at = new Date();
        if (messageNum === 2) updateData.pickup_arrival_followup_sent = true;
      } else {
        if (messageNum === 1) updateData.return_arrival_sent_at = new Date();
        if (messageNum === 2) updateData.return_arrival_followup_sent = true;
      }

      if (Object.keys(updateData).length > 0) {
        await this.prisma.booking.update({
          where: { id: bookingId },
          data: updateData,
        });

        this.logger.log(`Arrival check ${sent ? 'sent' : 'queued (READ_ONLY)'}: ${phase} #${messageNum} for booking ${bookingId}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to send arrival check (${phase} #${messageNum}): ${err.message}`);
    }
  }

  /**
   * Build a DateTime from a date and time string (HH:MM).
   */
  private buildDateTime(date: Date, time: string): Date | null {
    if (!date || !time) return null;
    const [hours, minutes] = time.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) return null;
    const dt = new Date(date);
    dt.setHours(hours, minutes, 0, 0);
    return dt;
  }

  // ══════════════════════════════════════════════
  // 1-HOUR PRE-PICKUP/RETURN REMINDERS
  // ══════════════════════════════════════════════

  private async checkPrePickupReminders(now: Date) {
    // Look at today and tomorrow to catch bookings near midnight
    const windowStart = new Date(now);
    windowStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(now);
    windowEnd.setDate(windowEnd.getDate() + 1);
    windowEnd.setHours(23, 59, 59, 999);

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        pickup_pre_reminded: false,
        pickup_time: { not: null },
        OR: [
          { pickup_date: { gte: windowStart, lte: windowEnd } },
          { start_date: { gte: windowStart, lte: windowEnd } },
        ],
      },
      include: { rental: true },
    });

    for (const booking of bookings) {
      if (!booking.pickup_time) continue;
      const pickupDate = booking.pickup_date || booking.start_date;
      const pickupDateTime = this.buildDateTime(pickupDate, booking.pickup_time);
      if (!pickupDateTime) continue;

      const minsUntilPickup = (pickupDateTime.getTime() - now.getTime()) / (1000 * 60);

      // Send when 50-70 minutes before pickup (cron runs every minute, catches the window)
      if (minsUntilPickup >= 50 && minsUntilPickup <= 70) {
        const listingId = booking.rental?.listing_id;
        if (!listingId) continue;

        const location = getPickupLocation(booking.account);
        const mapsLine = location.mapsLink ? `\nGoogle Maps: ${location.mapsLink}` : '';

        const message =
          `Hey! Just a reminder — your pickup is confirmed for ${booking.pickup_time} today.\n\n` +
          `📍 Pickup location: ${location.address}${mapsLine}\n\n` +
          `Please text "arrived" in this chat when you get there and we'll be right with you.\n` +
          `If you think you won't make it on time, just let us know as early as you can so we can adjust!`;

        try {
          await this.hyggloService.sendMessage(listingId, message);
          this.logger.log(`Pre-pickup reminder sent for ${booking.renter_name} (booking ${booking.id})`);

          // Store in conversation history
          if (booking.rental_id) {
            await this.memoryService.storeConversation(
              `rental:${booking.rental_id}`, 'assistant', message, { model: 'pre-pickup-reminder' },
            );
          }
        } catch (err) {
          this.logger.warn(`Failed to send pre-pickup reminder: ${err.message}`);
        }

        // Mark as reminded (even if send failed, to prevent retry spam)
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { pickup_pre_reminded: true },
        });
      }
    }
  }

  private async checkPreReturnReminders(now: Date) {
    const windowStart = new Date(now);
    windowStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(now);
    windowEnd.setDate(windowEnd.getDate() + 1);
    windowEnd.setHours(23, 59, 59, 999);

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        return_pre_reminded: false,
        return_time: { not: null },
        OR: [
          { return_date: { gte: windowStart, lte: windowEnd } },
          { end_date: { gte: windowStart, lte: windowEnd } },
        ],
      },
      include: { rental: true },
    });

    for (const booking of bookings) {
      if (!booking.return_time) continue;
      const returnDate = booking.return_date || booking.end_date;
      const returnDateTime = this.buildDateTime(returnDate, booking.return_time);
      if (!returnDateTime) continue;

      const minsUntilReturn = (returnDateTime.getTime() - now.getTime()) / (1000 * 60);

      if (minsUntilReturn >= 50 && minsUntilReturn <= 70) {
        const listingId = booking.rental?.listing_id;
        if (!listingId) continue;

        const location = getPickupLocation(booking.account);
        const mapsLine = location.mapsLink ? `\nGoogle Maps: ${location.mapsLink}` : '';

        const message =
          `Hey! Just a reminder — your return is scheduled for ${booking.return_time} today.\n\n` +
          `📍 Return location: ${location.address}${mapsLine}\n\n` +
          `Before heading over, please make sure:\n` +
          `• Lens caps and body caps are back on all lenses and camera bodies\n` +
          `• All batteries and SD cards are back in the camera/gear\n` +
          `• Everything is packed securely in the divided sections of the bag/case\n\n` +
          `Missing items or signs of negligence may result in late fees while we locate items, or charges for damage. We appreciate you taking a moment to double-check!\n\n` +
          `If you think you won't make it on time, just let us know as early as you can so we can adjust.`;

        try {
          await this.hyggloService.sendMessage(listingId, message);
          this.logger.log(`Pre-return reminder sent for ${booking.renter_name} (booking ${booking.id})`);

          if (booking.rental_id) {
            await this.memoryService.storeConversation(
              `rental:${booking.rental_id}`, 'assistant', message, { model: 'pre-return-reminder' },
            );
          }
        } catch (err) {
          this.logger.warn(`Failed to send pre-return reminder: ${err.message}`);
        }

        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { return_pre_reminded: true },
        });
      }
    }
  }

  // ══════════════════════════════════════════════
  // MID-RENTAL CHECK-IN
  // ══════════════════════════════════════════════

  private async checkMidRentalCheckins(now: Date) {
    const hour = now.getUTCHours();
    // Only send check-ins during reasonable hours (9am–8pm UTC)
    if (hour < 9 || hour >= 20) return;

    // Find confirmed bookings that are currently active (started, not yet ended)
    // and haven't had their mid-rental check-in sent yet
    const activeBookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        midpoint_checkin_sent: false,
        pickup_arrival_confirmed: true, // They actually have the gear
        start_date: { lte: now },
        end_date: { gte: now },
      },
      include: { rental: true },
    });

    if (activeBookings.length === 0) return;

    // Group bookings by rental (send one check-in message per renter, not per item)
    const rentalGroups = new Map<string, typeof activeBookings>();
    for (const b of activeBookings) {
      if (!b.rental?.listing_id || !b.rental_id) continue;
      const key = b.rental_id;
      if (!rentalGroups.has(key)) rentalGroups.set(key, []);
      rentalGroups.get(key)!.push(b);
    }

    for (const [rentalId, bookings] of rentalGroups) {
      const booking = bookings[0];
      const rental = booking.rental;
      if (!rental) continue;

      // Calculate midpoint between pickup and return
      const pickupDate = booking.pickup_date || booking.start_date;
      const returnDate = booking.return_date || booking.end_date;
      const pickupTime = booking.pickup_time || '10:00';
      const returnTime = booking.return_time || '19:00';

      const pickupDT = this.buildDateTime(pickupDate, pickupTime);
      const returnDT = this.buildDateTime(returnDate, returnTime);
      if (!pickupDT || !returnDT) continue;

      const midpointMs = pickupDT.getTime() + (returnDT.getTime() - pickupDT.getTime()) / 2;
      const midpoint = new Date(midpointMs);

      // Send when we're within 30 minutes of the midpoint
      const minsFromMidpoint = Math.abs((now.getTime() - midpoint.getTime()) / (1000 * 60));
      if (minsFromMidpoint > 30) continue;

      const message =
        `Hey! Just checking in — hope everything's going well with the gear! ` +
        `If anything's not working as expected or you need any help at all, just let me know.`;

      try {
        await this.hyggloService.sendMessage(rental.listing_id, message);
        this.logger.log(`Mid-rental check-in sent for ${booking.renter_name} (rental ${rentalId})`);

        await this.memoryService.storeConversation(
          `rental:${rentalId}`, 'assistant', message, { model: 'mid-rental-checkin' },
        );
      } catch (err) {
        this.logger.warn(`Failed to send mid-rental check-in: ${err.message}`);
      }

      // Mark ALL bookings for this rental as checked in
      const bookingIds = bookings.map(b => b.id);
      await this.prisma.booking.updateMany({
        where: { id: { in: bookingIds } },
        data: { midpoint_checkin_sent: true },
      });
    }
  }

  /**
   * Confirm renter arrival — called from processMessage when renter says "arrived"/"I'm here".
   * Returns which phase was confirmed (pickup/return/null).
   */
  async confirmArrival(rentalId: string): Promise<'pickup' | 'return' | null> {
    // Find all confirmed bookings for this rental
    const bookings = await this.prisma.booking.findMany({
      where: { rental_id: rentalId, status: 'confirmed' },
    });

    if (bookings.length === 0) return null;

    let confirmedPhase: 'pickup' | 'return' | null = null;

    for (const booking of bookings) {
      // First check: is this a return confirmation? (pickup already done)
      if (booking.pickup_arrival_confirmed && !booking.return_arrival_confirmed) {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { return_arrival_confirmed: true },
        });
        confirmedPhase = 'return';
        this.logger.log(`Return arrival confirmed for booking ${booking.id} (${booking.renter_name})`);
      }
      // Second check: is this a pickup confirmation?
      else if (!booking.pickup_arrival_confirmed) {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { pickup_arrival_confirmed: true },
        });
        confirmedPhase = 'pickup';
        this.logger.log(`Pickup arrival confirmed for booking ${booking.id} (${booking.renter_name})`);
      }
    }

    // Notify Daniel
    if (confirmedPhase) {
      const booking = bookings[0];
      await this.telegramService.sendProactiveMessage(
        `✅ *Renter Arrived (${confirmedPhase})*\n\n` +
        `├ 👤 ${booking.renter_name}\n` +
        `├ 📦 ${booking.item_name}\n` +
        `└ ${confirmedPhase === 'pickup' ? '📍 Ready for pickup' : '📍 Ready for return'}`,
      );
    }

    return confirmedPhase;
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
    // Try preferred time — checkTimeConflict now checks BOTH booking conflicts AND vacation
    const check = await this.calendarService.checkTimeConflict(
      itemName, date, preferredTime, type, excludeRentalId,
    );
    if (!check.conflict) return preferredTime;

    // If vacation conflict returned a suggested alternative, try it first
    const suggestedAlt = (check as any).suggestedAlternative;
    if (suggestedAlt) {
      const altCheck = await this.calendarService.checkTimeConflict(
        itemName, date, suggestedAlt, type, excludeRentalId,
      );
      if (!altCheck.conflict) return suggestedAlt;
    }

    // Fallback times: work backward from evening for pickup, forward from morning for return
    const fallbacks = type === 'pickup'
      ? ['10:00', '11:00', '12:00', '19:00', '20:00', '21:00']
      : ['19:00', '20:00', '21:00', '12:00', '11:00', '10:00'];

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
