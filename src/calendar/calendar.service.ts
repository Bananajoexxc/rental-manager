import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MASTER_INVENTORY, findBestMatch, getInventoryItemNames } from '../utils/item-matcher';

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private prisma: PrismaService) {}

  async createBooking(data: {
    item_name: string;
    quantity?: number;
    start_date: Date;
    end_date: Date;
    renter_name: string;
    renter_contact?: string;
    account: string;
    rental_id?: string;
    pickup_time?: string;
    return_time?: string;
    notes?: string;
    revenue?: number;
    platform_fee?: number;
    delivery_fee?: number;
  }) {
    const matched = findBestMatch(data.item_name, getInventoryItemNames());
    const itemName = matched || data.item_name;

    const netProfit =
      data.revenue != null
        ? data.revenue - (data.platform_fee || 0) - (data.delivery_fee || 0)
        : null;

    const booking = await this.prisma.booking.create({
      data: {
        item_name: itemName,
        quantity: data.quantity || 1,
        start_date: data.start_date,
        end_date: data.end_date,
        renter_name: data.renter_name,
        renter_contact: data.renter_contact,
        account: data.account,
        rental_id: data.rental_id,
        pickup_time: data.pickup_time,
        return_time: data.return_time,
        notes: data.notes,
        revenue: data.revenue,
        platform_fee: data.platform_fee,
        delivery_fee: data.delivery_fee,
        net_profit: netProfit,
      },
    });

    this.logger.log(`Booking created: ${itemName} for ${data.renter_name} (${data.start_date.toISOString().split('T')[0]} - ${data.end_date.toISOString().split('T')[0]})`);
    return booking;
  }

  async cancelBooking(partialId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: { id: { startsWith: partialId }, status: 'confirmed' },
    });

    if (bookings.length === 0) return null;
    if (bookings.length > 1) throw new Error('Multiple bookings match. Be more specific.');

    return this.prisma.booking.update({
      where: { id: bookings[0].id },
      data: { status: 'cancelled' },
    });
  }

  async getBooking(partialId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: { id: { startsWith: partialId } },
    });
    return bookings.length === 1 ? bookings[0] : null;
  }

  async checkAvailability(itemName: string, startDate: Date, endDate: Date): Promise<{ available: boolean; booked: number; maxQuantity: number; matchedItem: string | null }> {
    const matched = findBestMatch(itemName, getInventoryItemNames());
    const maxQuantity = matched ? (MASTER_INVENTORY[matched] || 1) : 0;

    if (!matched) {
      return { available: false, booked: 0, maxQuantity: 0, matchedItem: null };
    }

    // 1-hour buffer: extend search range by 1 hour on each side
    const bufferStart = new Date(startDate.getTime() - 60 * 60 * 1000);
    const bufferEnd = new Date(endDate.getTime() + 60 * 60 * 1000);

    const overlapping = await this.prisma.booking.findMany({
      where: {
        item_name: matched,
        status: 'confirmed',
        start_date: { lt: bufferEnd },
        end_date: { gt: bufferStart },
      },
    });

    const bookedQuantity = overlapping.reduce((sum, b) => sum + b.quantity, 0);

    return {
      available: bookedQuantity < maxQuantity,
      booked: bookedQuantity,
      maxQuantity,
      matchedItem: matched,
    };
  }

  async getDaySchedule(date: Date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        start_date: { lte: dayEnd },
        end_date: { gte: dayStart },
      },
      orderBy: { start_date: 'asc' },
    });

    const pickups = bookings.filter(
      (b) => b.start_date >= dayStart && b.start_date <= dayEnd,
    );
    const returns = bookings.filter(
      (b) => b.end_date >= dayStart && b.end_date <= dayEnd,
    );
    const active = bookings.filter(
      (b) => b.start_date < dayStart && b.end_date > dayEnd,
    );

    return { pickups, returns, active, all: bookings };
  }

  getItemMaxQuantity(itemName: string): number {
    const matched = findBestMatch(itemName, getInventoryItemNames());
    return matched ? (MASTER_INVENTORY[matched] || 0) : 0;
  }

  async getAvailabilitySummary(itemNames: string[], startDate: Date, endDate: Date): Promise<string> {
    const lines: string[] = [];

    for (const name of itemNames) {
      const result = await this.checkAvailability(name, startDate, endDate);
      if (!result.matchedItem) {
        lines.push(`${name}: not found in inventory`);
        continue;
      }

      const available = result.maxQuantity - result.booked;
      const status = result.available ? 'AVAILABLE' : 'FULLY BOOKED';
      lines.push(`${result.matchedItem}: ${status} — ${available}/${result.maxQuantity} available (${result.booked} booked)`);
    }

    return lines.length > 0
      ? `LIVE AVAILABILITY CHECK (${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}):\n${lines.join('\n')}`
      : '';
  }

  async getAllUpcomingBookings(days: number = 14): Promise<string> {
    const now = new Date();
    const futureDate = new Date(now);
    futureDate.setDate(futureDate.getDate() + days);

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        end_date: { gte: now },
        start_date: { lte: futureDate },
      },
      orderBy: { start_date: 'asc' },
    });

    if (bookings.length === 0) {
      return `No bookings in the next ${days} days.`;
    }

    const lines = bookings.map((b) => {
      const start = b.start_date.toISOString().split('T')[0];
      const end = b.end_date.toISOString().split('T')[0];
      const times = [
        b.pickup_time ? `pickup ${b.pickup_time}` : null,
        b.return_time ? `return ${b.return_time}` : null,
      ].filter(Boolean).join(', ');
      return `- ${b.item_name} x${b.quantity}: ${start} to ${end} (${b.renter_name}) [${b.account}]${times ? ` [${times}]` : ''}`;
    });

    return `UPCOMING BOOKINGS (next ${days} days):\n${lines.join('\n')}`;
  }

  async updateBookingTimes(rentalId: string, pickupTime?: string, returnTime?: string): Promise<any> {
    // Find bookings linked to this rental
    const bookings = await this.prisma.booking.findMany({
      where: { rental_id: rentalId, status: 'confirmed' },
    });

    if (bookings.length === 0) {
      this.logger.warn(`updateBookingTimes: no confirmed bookings found for rental ${rentalId}`);
      return null;
    }

    const updateData: any = {};
    if (pickupTime) updateData.pickup_time = pickupTime;
    if (returnTime) updateData.return_time = returnTime;

    if (Object.keys(updateData).length === 0) return null;

    const updated = await this.prisma.booking.updateMany({
      where: { rental_id: rentalId, status: 'confirmed' },
      data: updateData,
    });

    this.logger.log(`Updated ${updated.count} booking(s) for rental ${rentalId}: pickup=${pickupTime || 'unchanged'}, return=${returnTime || 'unchanged'}`);
    return updated;
  }

  async createBookingsFromRental(
    rental: {
      id: string;
      title: string;
      start_date?: Date | null;
      end_date?: Date | null;
      renter_info?: string | null;
      account?: string | null;
      rental_price?: number | null;
      price_per_day?: number | null;
    },
    extractedItems: string[],
  ): Promise<any[]> {
    if (!rental.start_date || !rental.end_date) {
      this.logger.warn(`Cannot create bookings for rental ${rental.id}: missing dates`);
      return [];
    }

    // Deduplicate and match items to inventory
    const matchedItems: { name: string; quantity: number }[] = [];
    const seen = new Set<string>();

    for (const rawItem of extractedItems) {
      const matched = findBestMatch(rawItem, getInventoryItemNames());
      const itemName = matched || rawItem;
      if (seen.has(itemName)) continue;
      seen.add(itemName);
      matchedItems.push({ name: itemName, quantity: 1 });
    }

    // If no items extracted, create a single booking with the rental title
    if (matchedItems.length === 0) {
      const matched = findBestMatch(rental.title, getInventoryItemNames());
      matchedItems.push({ name: matched || rental.title, quantity: 1 });
    }

    // Distribute revenue across items
    const totalRevenue = rental.rental_price || 0;
    const perItemRevenue = matchedItems.length > 0 ? totalRevenue / matchedItems.length : 0;
    // Estimate 15% platform fee (Hygglo standard)
    const platformFeeRate = 0.15;

    const createdBookings: any[] = [];
    const renterName = rental.renter_info || 'Unknown';
    const account = rental.account || 'dbcinema';

    for (const item of matchedItems) {
      // Check if a booking already exists for this rental + item
      const existing = await this.prisma.booking.findFirst({
        where: {
          rental_id: rental.id,
          item_name: item.name,
          status: 'confirmed',
        },
      });

      if (existing) {
        this.logger.debug(`Booking already exists for ${item.name} on rental ${rental.id}`);
        continue;
      }

      // Check availability before booking
      const availability = await this.checkAvailability(item.name, rental.start_date, rental.end_date);

      const itemRevenue = Math.round(perItemRevenue * 100) / 100;
      const itemFee = Math.round(itemRevenue * platformFeeRate * 100) / 100;

      const booking = await this.prisma.booking.create({
        data: {
          item_name: item.name,
          quantity: item.quantity,
          start_date: rental.start_date,
          end_date: rental.end_date,
          renter_name: renterName,
          account,
          rental_id: rental.id,
          revenue: itemRevenue > 0 ? itemRevenue : null,
          platform_fee: itemFee > 0 ? itemFee : null,
          net_profit: itemRevenue > 0 ? Math.round((itemRevenue - itemFee) * 100) / 100 : null,
        },
      });

      this.logger.log(
        `Auto-booked: ${item.name} for ${renterName} (${rental.start_date.toISOString().split('T')[0]} - ${rental.end_date.toISOString().split('T')[0]})` +
        (!availability.available ? ' [OVERBOOKED]' : '') +
        (itemRevenue > 0 ? ` [£${itemRevenue}]` : ''),
      );

      createdBookings.push({
        ...booking,
        wasOverbooked: !availability.available,
        availableSlots: availability.maxQuantity - availability.booked,
        maxQuantity: availability.maxQuantity,
      });
    }

    return createdBookings;
  }

  async getFullInventoryStatus(daysAhead = 7): Promise<string> {
    const now = new Date();
    const futureDate = new Date(now);
    futureDate.setDate(futureDate.getDate() + daysAhead);

    const allItems = getInventoryItemNames();
    const lines: string[] = [`Inventory Status (next ${daysAhead} days):\n`];

    // Get all confirmed bookings in the date range
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        start_date: { lte: futureDate },
        end_date: { gte: now },
      },
    });

    // Count booked quantities per item
    const bookedMap: Record<string, { qty: number; renters: string[] }> = {};
    for (const b of bookings) {
      if (!bookedMap[b.item_name]) bookedMap[b.item_name] = { qty: 0, renters: [] };
      bookedMap[b.item_name].qty += b.quantity;
      if (!bookedMap[b.item_name].renters.includes(b.renter_name)) {
        bookedMap[b.item_name].renters.push(b.renter_name);
      }
    }

    // Calculate revenue from active bookings
    let totalRevenue = 0;
    let totalProfit = 0;

    for (const b of bookings) {
      totalRevenue += b.revenue || 0;
      totalProfit += b.net_profit || 0;
    }

    // Categorize items
    const fullyBooked: string[] = [];
    const partiallyBooked: string[] = [];
    const available: string[] = [];

    for (const item of allItems) {
      const max = MASTER_INVENTORY[item] || 1;
      const booked = bookedMap[item]?.qty || 0;
      const avail = max - booked;

      if (booked >= max) {
        const renters = bookedMap[item]?.renters.join(', ') || '';
        fullyBooked.push(`  ${item}: FULL (${booked}/${max}) → ${renters}`);
      } else if (booked > 0) {
        const renters = bookedMap[item]?.renters.join(', ') || '';
        partiallyBooked.push(`  ${item}: ${avail}/${max} free (${booked} booked) → ${renters}`);
      } else if (max > 1) {
        available.push(`  ${item}: ${max} available`);
      }
    }

    if (fullyBooked.length > 0) {
      lines.push(`FULLY BOOKED (${fullyBooked.length}):`);
      lines.push(...fullyBooked);
      lines.push('');
    }

    if (partiallyBooked.length > 0) {
      lines.push(`PARTIALLY BOOKED (${partiallyBooked.length}):`);
      lines.push(...partiallyBooked);
      lines.push('');
    }

    lines.push(`AVAILABLE: ${allItems.length - fullyBooked.length - partiallyBooked.length} items fully free`);
    lines.push(`Active bookings: ${bookings.length}`);
    lines.push(`Revenue (active): £${Math.round(totalRevenue * 100) / 100}`);
    lines.push(`Net profit (active): £${Math.round(totalProfit * 100) / 100}`);

    return lines.join('\n');
  }

  async getFormattedSchedule(date: Date): Promise<string> {
    const schedule = await this.getDaySchedule(date);
    const dateStr = date.toISOString().split('T')[0];

    if (schedule.all.length === 0) {
      return `No bookings for ${dateStr}.`;
    }

    const lines: string[] = [`Schedule for ${dateStr}:`];

    if (schedule.pickups.length > 0) {
      lines.push('\nPickups:');
      for (const b of schedule.pickups) {
        lines.push(`  - ${b.item_name} x${b.quantity} → ${b.renter_name} [${b.account}] ${b.pickup_time || ''}`);
      }
    }

    if (schedule.returns.length > 0) {
      lines.push('\nReturns:');
      for (const b of schedule.returns) {
        lines.push(`  - ${b.item_name} x${b.quantity} ← ${b.renter_name} [${b.account}] ${b.return_time || ''}`);
      }
    }

    if (schedule.active.length > 0) {
      lines.push('\nActive (ongoing):');
      for (const b of schedule.active) {
        lines.push(`  - ${b.item_name} x${b.quantity} (${b.renter_name}) [${b.account}]`);
      }
    }

    return lines.join('\n');
  }
}
