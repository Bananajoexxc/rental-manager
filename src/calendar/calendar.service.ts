import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MASTER_INVENTORY, findBestMatch, getInventoryItemNames } from '../utils/item-matcher';
import { PRICING_CATALOG } from '../data/pricing-catalog';
import { DELIVERY_SPECS } from '../data/delivery-specs';

@Injectable()
export class CalendarService implements OnModuleInit {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Startup validation: cross-check PRICING_CATALOG and DELIVERY_SPECS against MASTER_INVENTORY.
   * Logs warnings for mismatches so they can be fixed.
   */
  async onModuleInit() {
    const inventoryNames = getInventoryItemNames();
    let issues = 0;

    // Check PRICING_CATALOG items exist in MASTER_INVENTORY
    for (const entry of PRICING_CATALOG) {
      if (entry.is_bundle || entry.marketing_only) continue;
      const matched = findBestMatch(entry.item_name, inventoryNames);
      if (!matched) {
        this.logger.error(
          `DATA MISMATCH: Pricing catalog item "${entry.item_name}" not found in MASTER_INVENTORY`,
        );
        issues++;
      }
    }

    // Check bundle items exist in MASTER_INVENTORY
    for (const entry of PRICING_CATALOG) {
      if (!entry.is_bundle || !entry.bundle_items) continue;
      for (const bundleItem of entry.bundle_items) {
        const matched = findBestMatch(bundleItem, inventoryNames);
        if (!matched) {
          this.logger.error(
            `DATA MISMATCH: Bundle "${entry.item_name}" references "${bundleItem}" not in MASTER_INVENTORY`,
          );
          issues++;
        }
      }
    }

    // Check DELIVERY_SPECS individual items exist in MASTER_INVENTORY
    for (const spec of DELIVERY_SPECS) {
      if (spec.category === 'bundle') continue;
      const matched = findBestMatch(spec.item_name, inventoryNames);
      if (!matched) {
        this.logger.warn(
          `DATA MISMATCH: Delivery spec "${spec.item_name}" not found in MASTER_INVENTORY`,
        );
        issues++;
      }
    }

    if (issues > 0) {
      this.logger.error(`Startup validation: ${issues} data mismatch(es) detected — review logs above`);
    } else {
      this.logger.log('Startup validation: all data sources consistent');
    }
  }

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

  /**
   * Check if a proposed pickup or return time for a specific item conflicts with
   * adjacent bookings on the same day, respecting a 1-hour buffer between rentals.
   * Returns { conflict: true, reason } if there's a conflict, { conflict: false } otherwise.
   */
  async checkTimeConflict(
    itemName: string,
    date: Date,
    proposedTime: string,
    type: 'pickup' | 'return',
    excludeRentalId?: string,
  ): Promise<{ conflict: boolean; reason?: string }> {
    const matched = findBestMatch(itemName, getInventoryItemNames());
    if (!matched) return { conflict: false };

    const maxQuantity = MASTER_INVENTORY[matched] || 1;

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    // Parse proposed time to minutes since midnight
    const [propHours, propMinutes] = proposedTime.split(':').map(Number);
    const proposedMinutes = propHours * 60 + propMinutes;
    const bufferMinutes = 60; // 1-hour buffer

    if (type === 'pickup') {
      // For pickup: find bookings for the same item whose end_date falls on this day
      // Check if any return_time is within 60 min of proposed pickup
      const returnsOnDay = await this.prisma.booking.findMany({
        where: {
          item_name: matched,
          status: 'confirmed',
          end_date: { gte: dayStart, lte: dayEnd },
          return_time: { not: null },
          ...(excludeRentalId ? { rental_id: { not: excludeRentalId } } : {}),
        },
      });

      // Count how many units are occupied at that time
      let conflictingUnits = 0;
      for (const b of returnsOnDay) {
        if (!b.return_time) continue;
        const [rH, rM] = b.return_time.split(':').map(Number);
        const returnMinutes = rH * 60 + rM;
        // Conflict if pickup is within 60 min of another return
        if (Math.abs(proposedMinutes - returnMinutes) < bufferMinutes) {
          conflictingUnits += b.quantity;
        }
      }

      if (conflictingUnits >= maxQuantity) {
        return {
          conflict: true,
          reason: `${matched} has a return scheduled within 1 hour of ${proposedTime} — need a buffer between rentals`,
        };
      }
    } else {
      // For return: find bookings for the same item whose start_date falls on this day
      // Check if any pickup_time is within 60 min of proposed return
      const pickupsOnDay = await this.prisma.booking.findMany({
        where: {
          item_name: matched,
          status: 'confirmed',
          start_date: { gte: dayStart, lte: dayEnd },
          pickup_time: { not: null },
          ...(excludeRentalId ? { rental_id: { not: excludeRentalId } } : {}),
        },
      });

      let conflictingUnits = 0;
      for (const b of pickupsOnDay) {
        if (!b.pickup_time) continue;
        const [pH, pM] = b.pickup_time.split(':').map(Number);
        const pickupMinutes = pH * 60 + pM;
        if (Math.abs(proposedMinutes - pickupMinutes) < bufferMinutes) {
          conflictingUnits += b.quantity;
        }
      }

      if (conflictingUnits >= maxQuantity) {
        return {
          conflict: true,
          reason: `${matched} has a pickup scheduled within 1 hour of ${proposedTime} — need a buffer between rentals`,
        };
      }
    }

    return { conflict: false };
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
      if (!matched) {
        this.logger.warn(`Skipping unrecognized item "${rawItem}" — not in MASTER_INVENTORY`);
        continue;
      }
      if (seen.has(matched)) continue;
      seen.add(matched);
      matchedItems.push({ name: matched, quantity: 1 });
    }

    // If no items extracted, try matching the rental title to inventory
    if (matchedItems.length === 0) {
      const matched = findBestMatch(rental.title, getInventoryItemNames());
      if (!matched) {
        this.logger.warn(`Cannot create bookings for rental ${rental.id}: title "${rental.title}" does not match any inventory item`);
        return [];
      }
      matchedItems.push({ name: matched, quantity: 1 });
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
      // Check if a booking already exists for this rental + item (any status)
      const existing = await this.prisma.booking.findFirst({
        where: {
          rental_id: rental.id,
          item_name: item.name,
          status: { in: ['confirmed', 'pending_review'] },
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

      // Auto-block overbooked items: set status to 'pending_review' instead of 'confirmed'
      const bookingStatus = availability.available ? 'confirmed' : 'pending_review';

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
          status: bookingStatus,
          notes: !availability.available
            ? `AUTO-BLOCKED: ${item.name} overbooked (${availability.booked}/${availability.maxQuantity} already booked)`
            : null,
        },
      });

      this.logger.log(
        `Auto-booked: ${item.name} for ${renterName} (${rental.start_date.toISOString().split('T')[0]} - ${rental.end_date.toISOString().split('T')[0]})` +
        (!availability.available ? ' [OVERBOOKED - BLOCKED]' : '') +
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

  // Compact inventory context cache (5-minute TTL)
  private compactInventoryCache: string | null = null;
  private compactInventoryCacheTime = 0;
  private static readonly COMPACT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Generate a compact inventory + availability context for the AI.
   * Groups items by category, lenses by mount system, includes current bookings.
   * Cached for 5 minutes to avoid repeated DB queries.
   */
  async getCompactInventoryContext(): Promise<string> {
    const now = Date.now();
    if (this.compactInventoryCache && (now - this.compactInventoryCacheTime) < CalendarService.COMPACT_CACHE_TTL) {
      return this.compactInventoryCache;
    }

    // Categorize inventory items
    const categories: Record<string, string[]> = {
      'CAMERAS': [],
      'LENSES (Sony E-mount)': [],
      'LENSES (Canon EF mount)': [],
      'ANAMORPHIC LENSES': [],
      'MOUNT ADAPTERS': [],
      'LIGHTS': [],
      'AUDIO': [],
      'MONITORS & TRANSMITTERS': [],
      'GIMBALS & SUPPORT': [],
      'DRONES & ACTION CAMS': [],
      'POWER': [],
      'ACCESSORIES': [],
    };

    const categorize = (name: string, qty: number): void => {
      const n = name.toLowerCase();
      const entry = qty > 1 ? `${name} ×${qty}` : name;

      // Min-quantity rules baked in
      if (name === 'Nanlite Pavotube 30x II') {
        categories['LIGHTS'].push(`${name} ×${qty} (min 2, sets of 2 or 4)`);
        return;
      }

      if (n.includes('anamorphic') || n.includes('blazar') || n.includes('great joy')) {
        categories['ANAMORPHIC LENSES'].push(entry);
      } else if (n.includes('canon ef')) {
        categories['LENSES (Canon EF mount)'].push(entry);
      } else if (n.includes('sony gm') || n.includes('sony 28-70') || n.includes('sony 11mm')) {
        categories['LENSES (Sony E-mount)'].push(entry);
      } else if (n.includes('pl to') || n.includes('mount')) {
        categories['MOUNT ADAPTERS'].push(entry);
      } else if (n.includes('fx3') || n.includes('a7 ') || n.includes('fujifilm') || n.includes('bmpcc')) {
        categories['CAMERAS'].push(entry);
      } else if (n.includes('nanlite') || n.includes('led') || n.includes('softbox') || n.includes('light') || n.includes('reflector') || n.includes('ambitful')) {
        categories['LIGHTS'].push(entry);
      } else if (n.includes('mic') || n.includes('rode') || n.includes('sennheiser') || n.includes('audio') || n.includes('boom') || n.includes('jbl wireless mic')) {
        categories['AUDIO'].push(entry);
      } else if (n.includes('monitor') || n.includes('atomos') || n.includes('hollyland') || n.includes('transmitter')) {
        categories['MONITORS & TRANSMITTERS'].push(entry);
      } else if (n.includes('gimbal') || n.includes('rs3') || n.includes('tripod') || n.includes('slider') || n.includes('monopod') || n.includes('shoulder') || n.includes('c-stand') || n.includes('follow focus') || n.includes('nucleus')) {
        categories['GIMBALS & SUPPORT'].push(entry);
      } else if (n.includes('drone') || n.includes('mavic') || n.includes('mini 4') || n.includes('gopro') || n.includes('osmo') || n.includes('action') || n.includes('suction')) {
        categories['DRONES & ACTION CAMS'].push(entry);
      } else if (n.includes('v-mount') || n.includes('npf') || n.includes('battery') || n.includes('anker') || n.includes('power')) {
        categories['POWER'].push(entry);
      } else {
        categories['ACCESSORIES'].push(entry);
      }
    };

    for (const [name, qty] of Object.entries(MASTER_INVENTORY)) {
      categorize(name, qty);
    }

    // Build inventory section
    const lines: string[] = ['--- OUR COMPLETE INVENTORY (with current bookings) ---'];
    for (const [category, items] of Object.entries(categories)) {
      if (items.length > 0) {
        lines.push(`${category}: ${items.join(', ')}`);
      }
    }

    // Fetch confirmed bookings for next 14 days
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 14);
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        end_date: { gte: new Date() },
        start_date: { lte: futureDate },
      },
      orderBy: { start_date: 'asc' },
    });

    if (bookings.length > 0) {
      lines.push('\nCURRENTLY BOOKED:');
      for (const b of bookings) {
        const start = b.start_date.toISOString().split('T')[0];
        const end = b.end_date.toISOString().split('T')[0];
        lines.push(`- ${b.item_name} ×${b.quantity}: ${start} to ${end} (${b.renter_name})`);
      }
    } else {
      lines.push('\nCURRENTLY BOOKED: None — all items available.');
    }

    lines.push(
      '\nRULES: This is ALL we stock. If renter asks for something NOT on this list, say "we don\'t currently stock [item]" and suggest the closest alternative from this list. NEVER confirm items not listed above.',
      'For lenses, note the mount system (Sony E-mount, Canon EF mount) — different mounts are NOT interchangeable. We do NOT stock Canon RF lenses.',
      'NEVER offer to source, procure, or find additional units beyond what is listed — our inventory is fixed.',
    );

    const result = lines.join('\n');
    this.compactInventoryCache = result;
    this.compactInventoryCacheTime = now;
    return result;
  }
}
