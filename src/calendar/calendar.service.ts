import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MASTER_INVENTORY, findBestMatch, getInventoryItemNames, isAccessoryItem } from '../utils/item-matcher';
import { PRICING_CATALOG, getOneDayPrice } from '../data/pricing-catalog';
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

    // Use return_date when available (actual physical return may differ from rental end_date)
    const overlapping = await this.prisma.booking.findMany({
      where: {
        item_name: matched,
        status: 'confirmed',
        start_date: { lt: bufferEnd },
        OR: [
          { return_date: { gt: bufferStart } },
          { return_date: null, end_date: { gt: bufferStart } },
        ],
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

    // Wider query: catch bookings by standard dates OR actual pickup/return dates
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        OR: [
          { start_date: { lte: dayEnd }, end_date: { gte: dayStart } },
          { return_date: { gte: dayStart, lte: dayEnd } },
          { pickup_date: { gte: dayStart, lte: dayEnd } },
        ],
      },
      orderBy: { start_date: 'asc' },
    });

    // Deduplicate (OR query can match same booking multiple ways)
    const seen = new Set<string>();
    const unique = bookings.filter(b => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });

    // Use actual dates when available (pickup_date/return_date > start_date/end_date)
    const pickups = unique.filter(b => {
      const d = b.pickup_date || b.start_date;
      return d >= dayStart && d <= dayEnd;
    });
    const returns = unique.filter(b => {
      const d = b.return_date || b.end_date;
      return d >= dayStart && d <= dayEnd;
    });
    const active = unique.filter(b => {
      const effectiveStart = b.pickup_date || b.start_date;
      const effectiveEnd = b.return_date || b.end_date;
      return effectiveStart < dayStart && effectiveEnd > dayEnd;
    });

    return { pickups, returns, active, all: unique };
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

    // Include bookings where actual return (return_date) extends past end_date
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        start_date: { lte: futureDate },
        OR: [
          { return_date: { gte: now } },
          { return_date: null, end_date: { gte: now } },
        ],
      },
      orderBy: { start_date: 'asc' },
    });

    if (bookings.length === 0) {
      return `No bookings in the next ${days} days.`;
    }

    const lines = bookings.map((b) => {
      const start = (b.pickup_date || b.start_date).toISOString().split('T')[0];
      const end = (b.return_date || b.end_date).toISOString().split('T')[0];
      const times = [
        b.pickup_time ? `pickup ${b.pickup_time}` : null,
        b.return_time ? `return ${b.return_time} on ${end}` : null,
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
      // For pickup: find bookings for the same item whose actual return falls on this day
      // Use return_date when available, fall back to end_date
      const returnsOnDay = await this.prisma.booking.findMany({
        where: {
          item_name: matched,
          status: 'confirmed',
          return_time: { not: null },
          ...(excludeRentalId ? { rental_id: { not: excludeRentalId } } : {}),
          OR: [
            { return_date: { gte: dayStart, lte: dayEnd } },
            { return_date: null, end_date: { gte: dayStart, lte: dayEnd } },
          ],
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
      // For return: find bookings for the same item whose actual pickup falls on this day
      // Use pickup_date when available, fall back to start_date
      const pickupsOnDay = await this.prisma.booking.findMany({
        where: {
          item_name: matched,
          status: 'confirmed',
          pickup_time: { not: null },
          ...(excludeRentalId ? { rental_id: { not: excludeRentalId } } : {}),
          OR: [
            { pickup_date: { gte: dayStart, lte: dayEnd } },
            { pickup_date: null, start_date: { gte: dayStart, lte: dayEnd } },
          ],
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

    // Vacation conflict gate: check if proposed time falls during owner unavailability
    const vacationCheck = await this.checkVacationConflict(date, proposedTime);
    if (vacationCheck.conflict) {
      return {
        conflict: true,
        reason: vacationCheck.reason,
        suggestedAlternative: vacationCheck.suggestedAlternative,
      } as any;
    }

    return { conflict: false };
  }

  // === Owner Unavailability / Vacation ===

  async createUnavailability(data: {
    start_time: Date;
    end_time?: Date | null;
    reason?: string;
    all_day?: boolean;
  }) {
    const record = await this.prisma.owner_unavailability.create({
      data: {
        start_time: data.start_time,
        end_time: data.end_time || null,
        reason: data.reason || null,
        all_day: data.all_day || false,
        active: true,
      },
    });
    // Invalidate compact inventory cache so next AI call sees vacation blocks
    this.compactInventoryCache = null;
    this.logger.log(`Owner unavailability created: ${record.id} (${data.start_time.toISOString()}${data.end_time ? ' - ' + data.end_time.toISOString() : ' onwards'})`);
    return record;
  }

  async getActiveUnavailabilities(from?: Date, to?: Date) {
    const where: any = { active: true };
    if (from || to) {
      // Overlapping range query
      if (from) {
        where.OR = [
          { end_time: { gte: from } },
          { end_time: null }, // open-ended blocks always overlap future
        ];
      }
      if (to) {
        where.start_time = { lte: to };
      }
    }
    return this.prisma.owner_unavailability.findMany({
      where,
      orderBy: { start_time: 'asc' },
    });
  }

  async cancelUnavailability(partialId: string) {
    const blocks = await this.prisma.owner_unavailability.findMany({
      where: { id: { startsWith: partialId }, active: true },
    });
    if (blocks.length === 0) return null;
    if (blocks.length > 1) throw new Error('Multiple blocks match. Be more specific.');
    const updated = await this.prisma.owner_unavailability.update({
      where: { id: blocks[0].id },
      data: { active: false },
    });
    this.compactInventoryCache = null;
    return updated;
  }

  /**
   * Check if the owner is unavailable during a given time range.
   * For null end_time, treats as end-of-day (23:59:59).
   */
  async isOwnerUnavailable(checkStart: Date, checkEnd: Date): Promise<{ unavailable: boolean; blocks: any[] }> {
    const allBlocks = await this.prisma.owner_unavailability.findMany({
      where: {
        active: true,
        start_time: { lte: checkEnd },
      },
      orderBy: { start_time: 'asc' },
    });

    const overlapping = allBlocks.filter(block => {
      const blockEnd = block.end_time || this.endOfDay(block.start_time);
      return block.start_time < checkEnd && blockEnd > checkStart;
    });

    return { unavailable: overlapping.length > 0, blocks: overlapping };
  }

  /**
   * Check if a proposed time on a given date conflicts with owner vacation.
   * Returns conflict info + suggested alternative time.
   */
  async checkVacationConflict(
    date: Date,
    proposedTime: string,
  ): Promise<{ conflict: boolean; reason?: string; suggestedAlternative?: string }> {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const blocks = await this.prisma.owner_unavailability.findMany({
      where: {
        active: true,
        start_time: { lte: dayEnd },
      },
    });

    // Filter to blocks overlapping this day
    const dayBlocks = blocks.filter(b => {
      const bEnd = b.end_time || this.endOfDay(b.start_time);
      return b.start_time < dayEnd && bEnd > dayStart;
    });

    if (dayBlocks.length === 0) return { conflict: false };

    const [propH, propM] = proposedTime.split(':').map(Number);
    const proposedMinutes = propH * 60 + propM;

    for (const block of dayBlocks) {
      // If all_day, the entire day is blocked
      if (block.all_day) {
        return {
          conflict: true,
          reason: `Owner unavailable all day (${block.reason || 'personal'})`,
        };
      }

      const blockStartOnDay = block.start_time >= dayStart ? block.start_time : dayStart;
      const blockEndOnDay = (block.end_time || this.endOfDay(block.start_time));
      const effectiveEnd = blockEndOnDay <= dayEnd ? blockEndOnDay : dayEnd;

      const blockStartMin = blockStartOnDay.getHours() * 60 + blockStartOnDay.getMinutes();
      const blockEndMin = effectiveEnd.getHours() * 60 + effectiveEnd.getMinutes();

      // 30-min buffer around vacation
      if (proposedMinutes >= (blockStartMin - 30) && proposedMinutes <= blockEndMin) {
        // Suggest 30 min before vacation starts, clamped to 10:00-21:00
        let suggestedMin = blockStartMin - 30;
        if (suggestedMin < 600) suggestedMin = 600; // 10:00
        if (suggestedMin > 1260) suggestedMin = 1260; // 21:00
        const sugH = Math.floor(suggestedMin / 60);
        const sugM = suggestedMin % 60;
        const suggestedAlternative = `${String(sugH).padStart(2, '0')}:${String(sugM).padStart(2, '0')}`;

        return {
          conflict: true,
          reason: `Owner unavailable from ${this.formatTimeFromDate(blockStartOnDay)}${block.end_time ? ' to ' + this.formatTimeFromDate(effectiveEnd) : ' onwards'} (${block.reason || 'personal'})`,
          suggestedAlternative,
        };
      }
    }

    return { conflict: false };
  }

  private endOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  private formatTimeFromDate(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * Sanitize an extracted time: reject times outside business hours (07:00-22:00).
   * If time is 01:00-06:59, assume AM/PM conversion error and add 12 hours.
   */
  private sanitizeTime(time: string): string | null {
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    let hour = parseInt(match[1], 10);
    const min = parseInt(match[2], 10);
    // Likely AM/PM error: 01:00-06:59 → add 12h (e.g., 03:00 meant 15:00)
    if (hour >= 1 && hour <= 6) {
      hour += 12;
    }
    if (hour < 7 || hour > 22) return null; // outside 07:00-22:00
    return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  async updateBookingTimes(
    rentalId: string,
    pickupTime?: string,
    returnTime?: string,
    pickupDate?: string,
    returnDate?: string,
  ): Promise<any> {
    // Find bookings linked to this rental (include pending_review so times aren't lost before promotion)
    const bookings = await this.prisma.booking.findMany({
      where: { rental_id: rentalId, status: { in: ['confirmed', 'pending_review'] } },
    });

    if (bookings.length === 0) {
      this.logger.warn(`updateBookingTimes: no confirmed/pending_review bookings found for rental ${rentalId}`);
      return null;
    }

    const refBooking = bookings[0];
    const updateData: any = {};

    // Sanitize times: reject outside business hours, fix AM/PM errors
    if (pickupTime) {
      const sanitized = this.sanitizeTime(pickupTime);
      if (sanitized) {
        updateData.pickup_time = sanitized;
      } else {
        this.logger.warn(`updateBookingTimes: rejected pickup time ${pickupTime} (outside 07:00-22:00) for rental ${rentalId}`);
      }
    }
    if (returnTime) {
      const sanitized = this.sanitizeTime(returnTime);
      if (sanitized) {
        updateData.return_time = sanitized;
      } else {
        this.logger.warn(`updateBookingTimes: rejected return time ${returnTime} (outside 07:00-22:00) for rental ${rentalId}`);
      }
    }

    // Validate dates: pickup/return dates must be within ±3 days of booking start/end.
    // This prevents AI hallucinating wrong dates (e.g., "Friday" → this Friday, not the rental's Friday).
    if (pickupDate && refBooking.start_date) {
      const pd = new Date(pickupDate);
      const diff = Math.abs(pd.getTime() - refBooking.start_date.getTime()) / 86400000;
      if (diff <= 3) {
        updateData.pickup_date = pd;
      } else {
        this.logger.warn(`updateBookingTimes: rejected pickup date ${pickupDate} (${Math.round(diff)}d from start ${refBooking.start_date.toISOString().split('T')[0]}) for rental ${rentalId}`);
      }
    }
    if (returnDate && refBooking.end_date) {
      const rd = new Date(returnDate);
      const diff = Math.abs(rd.getTime() - refBooking.end_date.getTime()) / 86400000;
      if (diff <= 3) {
        updateData.return_date = rd;
      } else {
        this.logger.warn(`updateBookingTimes: rejected return date ${returnDate} (${Math.round(diff)}d from end ${refBooking.end_date.toISOString().split('T')[0]}) for rental ${rentalId}`);
      }
    }

    if (Object.keys(updateData).length === 0) return null;

    const updated = await this.prisma.booking.updateMany({
      where: { rental_id: rentalId, status: { in: ['confirmed', 'pending_review'] } },
      data: updateData,
    });

    this.logger.log(`Updated ${updated.count} booking(s) for rental ${rentalId}: pickup=${updateData.pickup_time || 'unchanged'} ${updateData.pickup_date ? updateData.pickup_date.toISOString().split('T')[0] : ''}, return=${updateData.return_time || 'unchanged'} ${updateData.return_date ? updateData.return_date.toISOString().split('T')[0] : ''}`);
    return updated;
  }

  /**
   * Filter extracted items to only those relevant to the listing title.
   * Prevents photo-extracted items from stock/promo images creating wrong bookings.
   * E.g., a "V-mount battery" listing with a stock DJI photo shouldn't book an FX3.
   */
  private filterByListingRelevance(
    items: { name: string; quantity: number }[],
    listingTitle: string,
    strict = false,
  ): { name: string; quantity: number }[] {
    if (!listingTitle || items.length <= 1) return items;

    // Strip SEO comparison text like "(Like Aputure / Nanlite Pavotube)" before matching
    const cleanedTitle = listingTitle
      .replace(/\(?\blike\b[^)]*\)?/gi, '')  // "(Like X / Y)" or "Like X"
      .replace(/\(?\bsimilar\s+to\b[^)]*\)?/gi, '')  // "(Similar to X)"
      .replace(/\|[^|]*$/g, '')  // trailing "| SEO / keywords" sections
      .trim();
    const title = cleanedTitle.toLowerCase();

    // Bundle/kit/set listings: extracted items are expected to be diverse
    // In strict mode (resync), skip the bundle bypass — always apply per-item filtering
    // In normal mode, bypass for genuine multi-category bundles (not SEO "kit" text)
    if (!strict && /\b(bundle|combo|package|ultimate|short\s*film)\b/i.test(title)) return items;
    if (!strict && /\b(kit|set)\b/i.test(title)) {
      // Only bypass if title has 3+ items separated by +/&/,/and (genuine bundle)
      const separators = title.split(/[+&,]|\band\b/).filter(s => s.trim().length > 3);
      if (separators.length >= 3) return items;
    }

    // Map item names and title to broad equipment categories
    const CATEGORY_RULES: [RegExp, RegExp][] = [
      // [item name pattern, title pattern that makes this category relevant]
      [/sony (fx|a7|a\d)|bmpcc|canon c\d|red\s/i, /camera|sony|bmpcc|blackmagic|canon\s*c|fx\d|a7|cinema/i],
      [/\d+mm|lens|anamorphic|fisheye|great\s*joy/i, /\d+mm|lens|anamorphic|fisheye|f\/?\d|zoom|gm\b/i],
      [/gimbal|rs\d|ronin/i, /gimbal|rs\d|ronin|stabiliz/i],
      [/tripod/i, /tripod|stand/i],
      [/slider|dolly/i, /slider|dolly|motoriz/i],
      [/v-mount|npf|battery/i, /batter|v[\s-]?mount|charger|wah|mah|power\b|npf/i],
      [/nanlite|pavotube|led.*panel|ambitful|light\s*panel/i, /light|nanlite|pavotube|led|tube|rgb/i],
      [/mic|rode|sennheiser|boom/i, /mic|rode|sennheiser|boom|audio|wireless\s+(mic|pro)/i],
      [/drone|mavic|osmo|action\s*\d/i, /drone|mavic|dji.*action|osmo/i],
      [/monitor|atomos|ninja/i, /monitor|atomos|ninja/i],
      [/filter|cinebloom/i, /filter|cinebloom|nd\b/i],
      [/transmitter|hollyland|mars/i, /transmitter|hollyland|wireless\s*video/i],
      [/power\s*station|anker/i, /power\s*station|anker|generator/i],
      [/partybox|speaker/i, /partybox|speaker|party/i],
    ];

    const relevant = items.filter(item => {
      const name = item.name.toLowerCase();
      const titleNorm = title.replace(/[^a-z0-9\s-]/g, ' ');

      // Focal length conflict: "90mm" item vs "24-70mm" title = different product
      const itemFocals = name.match(/\d+(?:-\d+)?mm/g) || [];
      const titleFocals = titleNorm.match(/\d+(?:\s*-\s*\d+)?\s*mm/g)?.map(s => s.replace(/\s/g, '')) || [];
      if (itemFocals.length > 0 && titleFocals.length > 0) {
        const focalOverlap = itemFocals.some(f => titleFocals.includes(f));
        if (!focalOverlap) return false; // Different focal lengths = different lens/product
      }

      // Direct token overlap: item name shares meaningful tokens with title
      // Exclude brand-only matches (too generic) — require non-brand token overlap
      const BRAND_TOKENS = new Set(['sony', 'dji', 'canon', 'rode', 'sennheiser', 'nanlite', 'blackmagic', 'hollyland', 'anker', 'atomos', 'sirui', 'smallrig']);
      const itemTokens = name.split(/[\s\-]+/).filter(t => t.length >= 3 && !/^(pro|set|the|and|for|with)$/.test(t));
      const nonBrandOverlap = itemTokens.filter(t => !BRAND_TOKENS.has(t) && titleNorm.includes(t));
      if (nonBrandOverlap.length >= 1) return true;

      // Brand overlap is allowed only if no conflicting specifics (focal length already checked above)
      const brandOverlap = itemTokens.filter(t => BRAND_TOKENS.has(t) && titleNorm.includes(t));
      if (brandOverlap.length > 0 && itemTokens.length <= 2) return true; // very short item name with brand match

      // Category match: item's category is mentioned in the title
      // But check for competing brands within the same category
      const COMPETING_BRANDS: [RegExp, string[]][] = [
        // [item brand pattern, all brands in this product subcategory]
        [/nanlite|pavotube/i, ['nanlite', 'pavotube', 'ambitful', 'forza']],
        [/ambitful/i, ['ambitful', 'nanlite', 'pavotube']],
        [/rode/i, ['rode', 'sennheiser', 'dji']],
        [/sennheiser/i, ['sennheiser', 'rode', 'dji']],
      ];
      for (const [itemPattern, titlePattern] of CATEGORY_RULES) {
        if (itemPattern.test(name)) {
          if (!titlePattern.test(title)) return false;
          // Category matches — but check for competing brand conflict
          for (const [brandPattern, competitors] of COMPETING_BRANDS) {
            if (brandPattern.test(name)) {
              // Item has this specific brand — check if title has a DIFFERENT brand from same group
              const itemBrand = competitors.find(b => name.includes(b));
              const titleBrand = competitors.find(b => b !== itemBrand && titleNorm.includes(b));
              if (titleBrand && itemBrand && !titleNorm.includes(itemBrand)) {
                return false; // Competing brand in title, item's brand absent
              }
            }
          }
          return true;
        }
      }

      // Unknown category: allow by default (don't filter what we don't understand)
      return true;
    });

    if (relevant.length > 0 && relevant.length < items.length) {
      const filtered = items.filter(i => !relevant.includes(i));
      this.logger.warn(
        `Listing relevance filter removed ${filtered.length} item(s) not matching "${listingTitle}": ` +
        filtered.map(i => i.name).join(', '),
      );
      return relevant;
    }

    return items;
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
      status?: string | null;
    },
    extractedItems: string[],
    options?: { forceStatus?: 'pending_review' | 'confirmed' },
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

    // Filter items that are irrelevant to the listing title (e.g., stock photo misidentification)
    const filteredItems = this.filterByListingRelevance(matchedItems, rental.title || '');
    matchedItems.length = 0;
    matchedItems.push(...filteredItems);

    // Separate main items from accessories — accessories don't get their own bookings
    const mainItems = matchedItems.filter(i => !isAccessoryItem(i.name));
    const accessoryItems = matchedItems.filter(i => isAccessoryItem(i.name));

    // If only accessories matched, promote them to main items — the listing IS for those items
    // (e.g., a listing for "V-mount batteries" should create battery bookings)
    if (mainItems.length === 0 && accessoryItems.length > 0) {
      this.logger.log(`Promoting ${accessoryItems.length} accessory item(s) to main items (accessory-only listing): ${accessoryItems.map(i => i.name).join(', ')}`);
      mainItems.push(...accessoryItems);
      accessoryItems.length = 0;
    }

    if (accessoryItems.length > 0) {
      this.logger.log(`Filtered ${accessoryItems.length} accessory item(s) from booking creation: ${accessoryItems.map(i => i.name).join(', ')}`);
    }

    // If no items matched at all, fall back to rental title match
    if (mainItems.length === 0) {
      const matched = findBestMatch(rental.title, getInventoryItemNames());
      if (!matched) {
        this.logger.warn(`Cannot create bookings for rental ${rental.id}: title "${rental.title}" does not match any inventory item`);
        return [];
      }
      mainItems.push({ name: matched, quantity: 1 });
    }

    // All revenue goes to main items only (accessories are bundled, not separate revenue items)
    // rental_price is set to ownerEarnings by the scanner — platform fees already deducted by Hygglo
    const totalRevenue = rental.rental_price || 0;

    // Proportional revenue split using catalog daily prices as weights
    // Items without catalog prices get a default weight of 15 (median daily price)
    const DEFAULT_DAILY_PRICE = 15;
    const itemWeights = mainItems.map(item => ({
      name: item.name,
      quantity: item.quantity,
      weight: getOneDayPrice(item.name) || DEFAULT_DAILY_PRICE,
    }));
    const totalWeight = itemWeights.reduce((sum, iw) => sum + iw.weight * iw.quantity, 0);
    const revenueByItem = new Map<string, number>();
    if (totalWeight > 0) {
      for (const iw of itemWeights) {
        revenueByItem.set(iw.name, Math.round((iw.weight / totalWeight) * totalRevenue * 100) / 100);
      }
    } else {
      // Fallback to equal split if no catalog prices at all
      const perItem = mainItems.length > 0 ? totalRevenue / mainItems.length : 0;
      for (const item of mainItems) {
        revenueByItem.set(item.name, Math.round(perItem * 100) / 100);
      }
    }

    const createdBookings: any[] = [];
    const renterName = rental.renter_info || 'Unknown';
    const account = rental.account || 'dbcinema';

    // Load ALL existing bookings for this rental upfront (single query, prevents race condition).
    // Per-item queries inside the loop are vulnerable to concurrent creation by parallel scan paths.
    const existingBookings = await this.prisma.booking.findMany({
      where: { rental_id: rental.id, status: { in: ['confirmed', 'pending_review'] } },
      select: { item_name: true },
    });
    const existingItemNames = new Set(existingBookings.map(b => b.item_name));
    // Also build a fuzzy set: match each existing item name against inventory to catch near-dupes
    // (e.g., "Anamorphic Great Joy 35mm" vs "Anamorphic Great Joy lens 35mm")
    const existingFuzzyNames = new Set<string>();
    for (const name of existingItemNames) {
      existingFuzzyNames.add(name);
      const fuzzyMatch = findBestMatch(name, getInventoryItemNames());
      if (fuzzyMatch) existingFuzzyNames.add(fuzzyMatch);
    }

    for (const item of mainItems) {
      // Skip if this item (or a fuzzy match) already has a booking for this rental
      if (existingItemNames.has(item.name) || existingFuzzyNames.has(item.name)) {
        this.logger.debug(`Booking already exists for ${item.name} on rental ${rental.id}`);
        continue;
      }

      // Check availability before booking
      const availability = await this.checkAvailability(item.name, rental.start_date, rental.end_date);

      const itemRevenue = revenueByItem.get(item.name) || 0;
      // Platform fee is 0: rental_price is already ownerEarnings (Hygglo fees pre-deducted)
      const itemFee = 0;

      // Booking status depends on BOTH rental acceptance AND inventory availability:
      // - forceStatus override (e.g., auto-accepted new rentals await owner acknowledgment)
      // - pending rental → always pending_review (not yet accepted on Hygglo)
      // - accepted rental + available → confirmed
      // - accepted rental + overbooked → pending_review
      let bookingStatus: 'confirmed' | 'pending_review';
      if (options?.forceStatus) {
        bookingStatus = !availability.available ? 'pending_review' : options.forceStatus;
      } else {
        const rentalAccepted = rental.status && ['upcoming', 'ongoing', 'completed'].includes(rental.status);
        bookingStatus = (!rentalAccepted || !availability.available) ? 'pending_review' : 'confirmed';
      }

      // Build rich notes JSON: all bundle items (main + accessories) + auto-block info
      const bundleNotes: any = {
        allItems: matchedItems.map(i => i.name),
        accessories: accessoryItems.map(i => i.name),
      };
      if (!availability.available) {
        bundleNotes.autoBlocked = `${item.name} overbooked (${availability.booked}/${availability.maxQuantity} already booked)`;
      }

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
          platform_fee: itemFee,
          net_profit: itemRevenue > 0 ? itemRevenue : null,
          status: bookingStatus,
          notes: JSON.stringify(bundleNotes),
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

  /**
   * Add owner decision notes to all bookings for a rental.
   * Called when Daniel approves/confirms something via Telegram decision prompts.
   */
  async addDecisionNotesToBookings(
    rentalId: string,
    decisionNote: string,
  ): Promise<number> {
    const bookings = await this.prisma.booking.findMany({
      where: { rental_id: rentalId, status: { in: ['confirmed', 'pending_review'] } },
      select: { id: true, notes: true },
    });

    let updated = 0;
    for (const booking of bookings) {
      let notesObj: any = {};
      try { notesObj = booking.notes ? JSON.parse(booking.notes) : {}; } catch { notesObj = {}; }
      if (!notesObj.ownerNotes) notesObj.ownerNotes = [];
      notesObj.ownerNotes.push({
        note: decisionNote,
        timestamp: new Date().toISOString(),
      });
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: { notes: JSON.stringify(notesObj) },
      });
      updated++;
    }
    this.logger.log(`Added decision note to ${updated} booking(s) for rental ${rentalId}`);
    return updated;
  }

  /**
   * Add included extras (small items approved by owner) to booking notes.
   * Merges with existing includedExtras using Set dedup.
   */
  async addIncludedExtrasToBookings(rentalId: string, items: string[]): Promise<number> {
    const bookings = await this.prisma.booking.findMany({
      where: { rental_id: rentalId, status: { in: ['confirmed', 'pending_review'] } },
      select: { id: true, notes: true },
    });

    if (bookings.length === 0) {
      this.logger.warn(`No bookings found for rental ${rentalId} when adding included extras`);
      return 0;
    }

    let updated = 0;
    for (const booking of bookings) {
      let notesObj: any = {};
      try { notesObj = booking.notes ? JSON.parse(booking.notes) : {}; } catch { notesObj = {}; }

      const existing = Array.isArray(notesObj.includedExtras) ? notesObj.includedExtras : [];
      const merged = [...new Set([...existing, ...items])];
      notesObj.includedExtras = merged;
      notesObj.includedExtrasApprovedAt = new Date().toISOString();

      await this.prisma.booking.update({
        where: { id: booking.id },
        data: { notes: JSON.stringify(notesObj) },
      });
      updated++;
    }
    this.logger.log(`Added ${items.length} included extras to ${updated} booking(s) for rental ${rentalId}`);
    return updated;
  }

  /**
   * Cascade rental status changes to related bookings.
   * When a rental goes from pending → accepted (upcoming/ongoing), promote bookings to confirmed.
   * When a rental goes to cancelled/obsolete, cancel bookings.
   */
  async cascadeRentalStatusToBookings(rentalId: string, newRentalStatus: string, oldRentalStatus?: string): Promise<number> {
    const accepted = ['upcoming', 'ongoing', 'completed'];
    const wasAccepted = oldRentalStatus && accepted.includes(oldRentalStatus);
    const isNowAccepted = accepted.includes(newRentalStatus);
    const isCancelled = ['cancelled', 'obsolete'].includes(newRentalStatus);

    let updated = 0;

    if (!wasAccepted && isNowAccepted) {
      // Rental accepted — promote pending_review bookings to confirmed (if available)
      const bookings = await this.prisma.booking.findMany({
        where: { rental_id: rentalId, status: 'pending_review' },
      });
      for (const booking of bookings) {
        const availability = await this.checkAvailability(
          booking.item_name, booking.start_date, booking.end_date,
        );
        const newStatus = availability.available ? 'confirmed' : 'pending_review';
        if (newStatus !== booking.status) {
          await this.prisma.booking.update({
            where: { id: booking.id },
            data: { status: newStatus },
          });
          updated++;
        }
      }
      if (updated > 0) {
        this.logger.log(`Promoted ${updated} booking(s) to confirmed for rental ${rentalId}`);
      }
    } else if (isCancelled) {
      // Rental cancelled — cancel all active bookings
      const result = await this.prisma.booking.updateMany({
        where: { rental_id: rentalId, status: { in: ['confirmed', 'pending_review'] } },
        data: { status: 'cancelled' },
      });
      updated = result.count;
      if (updated > 0) {
        this.logger.log(`Cancelled ${updated} booking(s) for cancelled rental ${rentalId}`);
      }
    } else if (wasAccepted && !isNowAccepted && !isCancelled) {
      // Rental went from accepted back to pending — demote bookings
      const result = await this.prisma.booking.updateMany({
        where: { rental_id: rentalId, status: 'confirmed' },
        data: { status: 'pending_review' },
      });
      updated = result.count;
      if (updated > 0) {
        this.logger.log(`Demoted ${updated} booking(s) to pending_review for rental ${rentalId}`);
      }
    }

    return updated;
  }

  /**
   * Reconcile bookings for recent rentals using parsed_items.
   * For each rental in the last N days, checks parsed_items against existing bookings.
   * Creates missing bookings for non-accessory items that match MASTER_INVENTORY.
   * Returns a detailed report of what was found and created.
   */
  async reconcileRecentBookings(days = 14): Promise<{
    rentalsScanned: number;
    bookingsCreated: number;
    itemsSkipped: { item: string; reason: string }[];
    details: { rentalId: string; title: string; item: string; action: string }[];
  }> {
    const cutoff = new Date(Date.now() - days * 86400000);
    const inventoryNames = getInventoryItemNames();

    // Load all rentals with parsed_items in the window
    const rentals = await this.prisma.rental.findMany({
      where: {
        created_at: { gte: cutoff },
        start_date: { not: undefined },
        end_date: { not: undefined },
      },
    });

    let bookingsCreated = 0;
    const itemsSkipped: { item: string; reason: string }[] = [];
    const details: { rentalId: string; title: string; item: string; action: string }[] = [];
    const skipReasons = new Map<string, string>();

    for (const rental of rentals) {
      if (!rental.start_date || !rental.end_date || !rental.parsed_items) continue;

      // Parse items from the JSON field
      let parsedItems: { item: string; qty: number }[];
      try {
        const raw = typeof rental.parsed_items === 'string'
          ? JSON.parse(rental.parsed_items as string)
          : rental.parsed_items;
        if (!Array.isArray(raw)) continue;
        parsedItems = raw.map((e: any) => ({
          item: e.item || '',
          qty: e.qty || 1,
        }));
      } catch {
        continue;
      }

      // Existing booking item names for this rental
      const existingBookings = await this.prisma.booking.findMany({
        where: { rental_id: rental.id, status: { in: ['confirmed', 'pending_review'] } },
        select: { item_name: true },
      });
      const existingItems = new Set(existingBookings.map(b => b.item_name));

      for (const parsed of parsedItems) {
        if (!parsed.item) continue;

        // Run through findBestMatch to resolve to MASTER_INVENTORY name
        const matched = findBestMatch(parsed.item, inventoryNames);

        // High-confidence gate: for reconciliation, require parsed item name to be
        // very close to the matched inventory name.
        // Two checks: (1) bidirectional token overlap ≥60%, (2) no version/model number conflicts
        if (matched && matched.toLowerCase() !== parsed.item.toLowerCase()) {
          const pTokens = parsed.item.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length >= 1);
          const mTokens = matched.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length >= 1);

          // Version/model conflict: if both have tokens that are pure numbers or roman numerals
          // and they DON'T match, it's a different model (A7 V ≠ A7 III, Mavic 4 ≠ Mavic 3)
          const isVersionToken = (t: string) => /^(i{1,3}|iv|v|vi{0,3}|[0-9]+)$/.test(t);
          const pVersions = pTokens.filter(isVersionToken);
          const mVersions = mTokens.filter(isVersionToken);
          if (pVersions.length > 0 && mVersions.length > 0) {
            const pSet = new Set(pVersions);
            const mSet = new Set(mVersions);
            // Check if there's a version in parsed that ISN'T in matched (and vice versa)
            const pOnly = pVersions.filter(v => !mSet.has(v));
            const mOnly = mVersions.filter(v => !pSet.has(v));
            if (pOnly.length > 0 && mOnly.length > 0) {
              // Different version numbers → different product
              if (!skipReasons.has(parsed.item)) {
                skipReasons.set(parsed.item, `version mismatch: ${parsed.item} [${pOnly.join(',')}] ≠ ${matched} [${mOnly.join(',')}]`);
                itemsSkipped.push({ item: parsed.item, reason: `version mismatch → ${matched}` });
              }
              details.push({ rentalId: rental.id, title: rental.title.substring(0, 50), item: `${parsed.item} ✗ ${matched}`, action: 'skipped_version_mismatch' });
              continue;
            }
          }

          // Bidirectional token overlap check (only for tokens ≥2 chars for fuzzy matching)
          const pLong = pTokens.filter(t => t.length >= 2);
          const mLong = mTokens.filter(t => t.length >= 2);
          const pInM = pLong.filter(t => mLong.some(m => m === t || (t.length >= 4 && m.includes(t)) || (m.length >= 4 && t.includes(m)))).length;
          const mInP = mLong.filter(t => pLong.some(p => p === t || (t.length >= 4 && p.includes(t)) || (p.length >= 4 && t.includes(p)))).length;
          const pRatio = pLong.length > 0 ? pInM / pLong.length : 0;
          const mRatio = mLong.length > 0 ? mInP / mLong.length : 0;
          // If one direction is very high (≥0.9), the shorter name is a subset — accept at lower threshold
          const bidirectional = (pRatio >= 0.9 || mRatio >= 0.9)
            ? Math.max(pRatio, mRatio) * 0.75  // weight toward the high direction
            : Math.min(pRatio, mRatio);
          if (bidirectional < 0.65) {
            if (!skipReasons.has(parsed.item)) {
              skipReasons.set(parsed.item, `low confidence match → ${matched} (${Math.round(bidirectional * 100)}%)`);
              itemsSkipped.push({ item: parsed.item, reason: `low confidence → ${matched} (${Math.round(bidirectional * 100)}%)` });
            }
            details.push({ rentalId: rental.id, title: rental.title.substring(0, 50), item: `${parsed.item} ✗ ${matched}`, action: 'skipped_low_confidence' });
            continue;
          }
        }

        if (!matched) {
          if (!skipReasons.has(parsed.item)) {
            skipReasons.set(parsed.item, 'not in MASTER_INVENTORY');
            itemsSkipped.push({ item: parsed.item, reason: 'not in MASTER_INVENTORY' });
          }
          details.push({ rentalId: rental.id, title: rental.title.substring(0, 50), item: parsed.item, action: 'skipped_no_match' });
          continue;
        }

        // Skip accessories
        if (isAccessoryItem(matched)) {
          details.push({ rentalId: rental.id, title: rental.title.substring(0, 50), item: `${parsed.item} → ${matched}`, action: 'skipped_accessory' });
          continue;
        }

        // Already has a booking for this item
        if (existingItems.has(matched)) {
          continue; // no action needed
        }

        // Create missing booking
        const availability = await this.checkAvailability(matched, rental.start_date, rental.end_date);
        const rentalAccepted = rental.status && ['upcoming', 'ongoing', 'completed'].includes(rental.status);
        const bookingStatus = (!rentalAccepted || !availability.available) ? 'pending_review' : 'confirmed';

        // Revenue: split total across UNIQUE non-accessory inventory items
        // Dedup by matched inventory name so "Great Joy 35mm" and "Great Joy lens 35mm"
        // count as ONE item for revenue splitting
        const seenForRevenue = new Set<string>();
        const mainParsedItems = parsedItems.filter(p => {
          const m = findBestMatch(p.item, inventoryNames);
          if (!m || isAccessoryItem(m)) return false;
          if (seenForRevenue.has(m)) return false;
          seenForRevenue.add(m);
          return true;
        });
        const totalRevenue = rental.rental_price || 0;
        const perItemRevenue = mainParsedItems.length > 0
          ? Math.round((totalRevenue / mainParsedItems.length) * 100) / 100
          : 0;

        await this.prisma.booking.create({
          data: {
            item_name: matched,
            quantity: 1,
            start_date: rental.start_date,
            end_date: rental.end_date,
            renter_name: rental.renter_info || 'Unknown',
            account: rental.account || 'dbcinema',
            rental_id: rental.id,
            revenue: perItemRevenue > 0 ? perItemRevenue : null,
            platform_fee: 0,
            net_profit: perItemRevenue > 0 ? perItemRevenue : null,
            status: bookingStatus,
            notes: JSON.stringify({ reconciled: true, parsedAs: parsed.item, matchedTo: matched }),
          },
        });

        existingItems.add(matched); // prevent duplicates within same rental
        bookingsCreated++;
        details.push({
          rentalId: rental.id,
          title: rental.title.substring(0, 50),
          item: `${parsed.item} → ${matched}`,
          action: `created_${bookingStatus}`,
        });

        this.logger.log(`Reconciled: ${matched} for rental "${rental.title.substring(0, 40)}" [${bookingStatus}]`);
      }
    }

    this.logger.log(`Booking reconciliation: scanned ${rentals.length} rentals, created ${bookingsCreated} bookings, skipped ${itemsSkipped.length} unmatched item types`);

    return {
      rentalsScanned: rentals.length,
      bookingsCreated,
      itemsSkipped,
      details,
    };
  }

  /**
   * Additive resync: creates missing bookings from rental.parsed_items.
   * NEVER deletes existing bookings — they may include items from additional
   * listings added during the rental conversation (not captured in the title).
   * Also enriches parsed_items with items found in existing bookings.
   */
  async resyncFromParsedItems(days = 365): Promise<{
    rentalsProcessed: number;
    bookingsCreated: number;
    parsedItemsEnriched: number;
    details: { rentalId: string; title: string; action: string }[];
  }> {
    const cutoff = new Date(Date.now() - days * 86400000);
    const inventoryNames = getInventoryItemNames();

    const rentals = await this.prisma.rental.findMany({
      where: {
        created_at: { gte: cutoff },
        start_date: { not: null },
        end_date: { not: null },
        status: { in: ['completed', 'ongoing', 'upcoming'] },
      },
      include: {
        bookings: { where: { status: { in: ['confirmed', 'pending_review'] } } },
      },
    });

    let bookingsCreated = 0;
    let parsedItemsEnriched = 0;
    let rentalsProcessed = 0;
    const details: { rentalId: string; title: string; action: string }[] = [];

    for (const rental of rentals) {
      if (!rental.parsed_items || !rental.start_date || !rental.end_date) continue;

      let parsedItems: { item: string; qty: number }[];
      try {
        const raw = typeof rental.parsed_items === 'string'
          ? JSON.parse(rental.parsed_items as string)
          : rental.parsed_items;
        if (!Array.isArray(raw) || raw.length === 0) continue;
        parsedItems = raw.map((e: any) => ({ item: e.item || '', qty: e.qty || 1 }));
      } catch { continue; }

      // Existing booking item names
      const existingBookingItems = new Set(rental.bookings.map(b => b.item_name));

      // Resolve parsed items to canonical MASTER_INVENTORY names
      const parsedResolved = new Map<string, string>(); // canonical → original
      const parsedQty = new Map<string, number>(); // canonical → qty
      for (const pi of parsedItems) {
        const matched = findBestMatch(pi.item, inventoryNames);
        if (matched) {
          parsedResolved.set(matched, pi.item);
          parsedQty.set(matched, pi.qty || 1);
        }
      }

      // Filter resolved items through listing relevance to prevent stock-photo contamination
      // Use strict mode: no kit/bundle bypass, always apply per-item category matching
      const resolvedItems = [...parsedResolved.keys()].map(name => ({
        name,
        quantity: parsedQty.get(name) || 1,
      }));
      const relevantItems = this.filterByListingRelevance(resolvedItems, rental.title, true);
      const relevantNames = new Set(relevantItems.map(i => i.name));

      // Find items in parsed_items that DON'T have a booking yet (only relevant ones)
      const missingFromBookings: string[] = [];
      for (const [canonical] of parsedResolved) {
        if (!existingBookingItems.has(canonical) && relevantNames.has(canonical)) {
          missingFromBookings.push(canonical);
        }
      }

      // Find items in bookings that DON'T exist in parsed_items (from additional listings)
      // Enrich parsed_items to include them so revenue attribution sees all items
      const parsedItemNames = new Set(parsedItems.map(p => {
        const m = findBestMatch(p.item, inventoryNames);
        return m || p.item;
      }));
      let enriched = false;
      for (const bookingItem of existingBookingItems) {
        if (!parsedItemNames.has(bookingItem)) {
          parsedItems.push({ item: bookingItem, qty: 1 });
          enriched = true;
        }
      }
      if (enriched) {
        await this.prisma.rental.update({
          where: { id: rental.id },
          data: { parsed_items: parsedItems as any },
        });
        parsedItemsEnriched++;
        details.push({
          rentalId: rental.id,
          title: rental.title.substring(0, 50),
          action: `enriched_parsed_items: added ${[...existingBookingItems].filter(b => !parsedItemNames.has(b)).join(', ')}`,
        });
      }

      // Create missing bookings directly with listing relevance filtering
      // Uses parsedQty for correct quantities, capped by MASTER_INVENTORY max
      if (missingFromBookings.length > 0 && rental.start_date && rental.end_date) {
        // Revenue proportional split using ALL items (parsed + existing bookings)
        const DEFAULT_DAILY_PRICE = 15;
        const allResolvedItems = [...parsedResolved.keys(), ...existingBookingItems];
        const uniqueItems = [...new Set(allResolvedItems)];
        const totalRevenue = rental.rental_price ? Number(rental.rental_price) : 0;
        const itemWeights = uniqueItems.map(name => ({
          name,
          weight: getOneDayPrice(name) || DEFAULT_DAILY_PRICE,
        }));
        const totalWeight = itemWeights.reduce((sum, iw) => sum + iw.weight, 0);

        const createdNames: string[] = [];
        for (const itemName of missingFromBookings) {
          const itemRevenue = totalWeight > 0
            ? Math.round((((getOneDayPrice(itemName) || DEFAULT_DAILY_PRICE) / totalWeight) * totalRevenue) * 100) / 100
            : 0;

          const itemQty = Math.min(
            parsedQty.get(itemName) || 1,
            MASTER_INVENTORY[itemName] || 1,
          );
          const booking = await this.prisma.booking.create({
            data: {
              item_name: itemName,
              quantity: itemQty,
              start_date: rental.start_date,
              end_date: rental.end_date,
              renter_name: rental.renter_info || 'Unknown',
              account: rental.account || 'dbcinema',
              rental_id: rental.id,
              revenue: itemRevenue > 0 ? itemRevenue : null,
              platform_fee: 0,
              net_profit: itemRevenue > 0 ? itemRevenue : null,
              status: 'confirmed',
              notes: JSON.stringify({ source: 'resync_from_parsed', allItems: uniqueItems }),
            },
          });
          createdNames.push(itemName);
          bookingsCreated++;
        }
        if (createdNames.length > 0) {
          details.push({
            rentalId: rental.id,
            title: rental.title.substring(0, 50),
            action: `created_bookings: ${createdNames.join(', ')}`,
          });
        }
        rentalsProcessed++;
      }
    }

    this.logger.log(`Resync: ${rentalsProcessed} rentals with new bookings, ${bookingsCreated} created, ${parsedItemsEnriched} parsed_items enriched`);
    return { rentalsProcessed, bookingsCreated, parsedItemsEnriched, details };
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

    // Owner unavailability blocks for this day
    try {
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
      const vacationBlocks = await this.getActiveUnavailabilities(dayStart, dayEnd);
      if (vacationBlocks.length > 0) {
        lines.push('\nOWNER UNAVAILABLE:');
        for (const block of vacationBlocks) {
          if (block.all_day) {
            lines.push(`  - ALL DAY${block.reason ? ` (${block.reason})` : ''}`);
          } else {
            const startStr = this.formatTimeFromDate(block.start_time);
            const endStr = block.end_time ? this.formatTimeFromDate(block.end_time) : 'onwards';
            lines.push(`  - ${startStr} ${endStr === 'onwards' ? 'onwards' : `to ${endStr}`}${block.reason ? ` (${block.reason})` : ''}`);
          }
        }
      }
    } catch (vacErr) {
      this.logger.debug(`Vacation block fetch for schedule failed: ${vacErr.message}`);
    }

    return lines.join('\n');
  }

  // Compact inventory context cache (5-minute TTL)
  private compactInventoryCache: string | null = null;
  private compactInventoryCacheTime = 0;
  private static readonly COMPACT_CACHE_TTL = 60 * 1000; // 60 seconds — fresh availability for AI context

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

    // Upcoming owner unavailability blocks (next 5)
    try {
      const upcomingVacations = await this.prisma.owner_unavailability.findMany({
        where: {
          active: true,
          OR: [
            { end_time: { gte: new Date() } },
            { end_time: null },
          ],
        },
        orderBy: { start_time: 'asc' },
        take: 5,
      });
      if (upcomingVacations.length > 0) {
        lines.push('\nOWNER UNAVAILABLE (no pickups/returns during these times):');
        for (const v of upcomingVacations) {
          const dayStr = v.start_time.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
          if (v.all_day) {
            lines.push(`- ${dayStr}: ALL DAY${v.reason ? ` (${v.reason})` : ''}`);
          } else {
            const startStr = this.formatTimeFromDate(v.start_time);
            const endStr = v.end_time ? this.formatTimeFromDate(v.end_time) : 'onwards';
            lines.push(`- ${dayStr} from ${startStr} ${endStr === 'onwards' ? 'onwards' : `to ${endStr}`}${v.reason ? ` (${v.reason})` : ''}`);
          }
        }
      }
    } catch (vacErr) {
      this.logger.debug(`Vacation blocks for inventory context failed: ${vacErr.message}`);
    }

    // Marketing-only items: listed on Hygglo for visibility but NOT physically available
    const marketingOnlyItems = PRICING_CATALOG.filter(p => p.marketing_only).map(p => p.item_name);
    if (marketingOnlyItems.length > 0) {
      lines.push(
        `\nMARKETING-ONLY LISTINGS (listed for visibility, NOT physically available): ${marketingOnlyItems.join(', ')}`,
        'If renter asks about these, say "currently unavailable" and suggest closest owned alternative from inventory above.',
      );
    }

    // Visibility redirect listings: items listed for SEO/visibility, redirect to actual stock.
    // NEVER tell the renter the listing exists for visibility — naturally pivot to the real item.
    const VISIBILITY_REDIRECTS: Record<string, string> = {
      // DJ equipment
      'Pioneer XDJ-RX2': 'DJ RX3 Pioneer controller',
      // Cameras
      'Blackmagic Pyxis 6K': 'BMPCC 6K Pro',
      'Pyxis 6K': 'BMPCC 6K Pro',
      // Drones
      'DJI Mavic 4 Pro': 'DJI Mavic 3 Pro',
      'Mavic 4': 'DJI Mavic 3 Pro',
      // Canon RF lenses (we only stock Canon EF mount)
      'Canon RF 24-70mm': 'Canon EF 24-105mm f4 (EF mount)',
      'Canon RF 24-70mm f2.8': 'Canon EF 24-105mm f4 (EF mount)',
      // Sony GM lenses not in stock
      'Sony GM 12-24mm': 'Sony GM 16-35mm f2.8',
      'Sony GM 12-24mm f2.8': 'Sony GM 16-35mm f2.8',
      'Sony GM 35mm f1.4': 'Sony GM 24-70mm f2.8',
      'Sigma 14-24mm f2.8': 'Sony GM 16-35mm f2.8',
      // Fisheye lenses
      '7Artisans 7.5mm': 'Sony 11mm f2.8 fisheye',
      '7Artisans 7.5mm f2.8 Fisheye': 'Sony 11mm f2.8 fisheye',
      '8-15mm Fisheye Zoom': 'Sony 11mm f2.8 fisheye',
      'Canon 8-15mm f2.8 Fisheye': 'Sony 11mm f2.8 fisheye',
      // Cinema prime lens sets (we have anamorphic sets)
      'DZO ARLES': 'Anamorphic Blazar Remus lens set or Anamorphic Great Joy lens set',
      'DZO Vespid': 'Anamorphic Blazar Remus lens set or Anamorphic Great Joy lens set',
      // Aputure lighting (not in our stock — we have Nanlite)
      'Aputure 300D II': 'Nanlite Forza 300 or Nanlite 500B',
      'Aputure Amaran 300c': 'Nanlite Forza 300 or Nanlite 500B',
      'Aputure MC Pro': 'Ambitful RGB light tubes 2x set',
      'Aputure Light Dome': 'Softbox 85cm',
      'Nanlite Forza 60C': 'Nanlite Forza 300',
      // Audio
      'Rode NTG5': 'Audio boom mic Sennheiser',
      'Rode Wireless Go II': 'Rode Wireless Mic Pro set',
      // Projectors (no direct equivalent — mention unavailable)
      'ViewSonic 4K Projector': 'not currently available (no projectors in stock)',
      'Anker Nebula Projector': 'not currently available (no projectors in stock)',
    };
    const redirectLines: string[] = [];
    for (const [listedItem, actualItem] of Object.entries(VISIBILITY_REDIRECTS)) {
      redirectLines.push(`${listedItem} → ${actualItem}`);
    }
    if (redirectLines.length > 0) {
      lines.push(
        `\nVISIBILITY REDIRECT LISTINGS: Some Hygglo listings advertise items we don't physically stock. When a renter comes through one of these listings or asks about these items, naturally recommend what we actually have. Do NOT say "we don't have that" or "that's not available" — instead say something like "our [real item] is great for [their use case]" and pivot naturally. NEVER reveal listings exist for visibility. Treat it as if we simply have the alternative ready to go.`,
        ...redirectLines,
      );
    }

    lines.push(
      '\nRULES: This is ALL we stock. If renter asks for something NOT on this list, say it is "currently unavailable" and suggest the closest alternative from this list. Frame as a temporary stock issue, NEVER as a permanent gap. NEVER confirm items not listed above.',
      'For lenses, note the mount system (Sony E-mount, Canon EF mount) — different mounts are NOT interchangeable. We do NOT stock Canon RF lenses.',
      'NEVER offer to source, procure, or find additional units beyond what is listed — our inventory is fixed.',
    );

    const result = lines.join('\n');
    this.compactInventoryCache = result;
    this.compactInventoryCacheTime = now;
    return result;
  }

  /**
   * Recompute revenue for all multi-item bookings using proportional split by catalog daily price.
   * Fixes historical equal-split allocations where cheap items (tripod £8/day) got same revenue as expensive items (FX3 £40/day).
   */
  async recomputeBookingRevenue(): Promise<{ updated: number; skipped: number; examples: any[] }> {
    const DEFAULT_DAILY_PRICE = 15;

    // Get all rentals that have multiple active bookings
    const rentals = await this.prisma.rental.findMany({
      where: {
        rental_price: { gt: 0 },
      },
      select: {
        id: true,
        rental_price: true,
        bookings: {
          where: { status: { in: ['confirmed', 'pending_review'] } },
          select: { id: true, item_name: true, revenue: true, quantity: true },
        },
      },
    });

    let updated = 0;
    let skipped = 0;
    const examples: any[] = [];

    for (const rental of rentals) {
      let mainBookings = rental.bookings.filter(b => !isAccessoryItem(b.item_name));
      // If no main items exist (accessory-only listing), promote all bookings to main
      // Also: if accessories have their own bookings, they were intentionally created and should get revenue
      if (mainBookings.length === 0) {
        mainBookings = rental.bookings;
      } else if (mainBookings.length < rental.bookings.length) {
        // Mixed: include accessories that have their own bookings — they were promoted during creation
        mainBookings = rental.bookings;
      }
      if (mainBookings.length < 2) {
        // Single-item rentals: just ensure revenue = rental_price
        if (mainBookings.length === 1 && mainBookings[0].revenue !== rental.rental_price) {
          await this.prisma.booking.update({
            where: { id: mainBookings[0].id },
            data: {
              revenue: rental.rental_price,
              net_profit: rental.rental_price,
            },
          });
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      // Multi-item: proportional split by catalog daily price
      const itemWeights = mainBookings.map(b => ({
        id: b.id,
        item: b.item_name,
        oldRevenue: b.revenue,
        weight: getOneDayPrice(b.item_name) || DEFAULT_DAILY_PRICE,
        quantity: b.quantity || 1,
      }));
      const totalWeight = itemWeights.reduce((sum, iw) => sum + iw.weight * iw.quantity, 0);

      if (totalWeight <= 0) { skipped++; continue; }

      let anyChanged = false;
      for (const iw of itemWeights) {
        const newRevenue = Math.round((iw.weight * iw.quantity / totalWeight) * (rental.rental_price ?? 0) * 100) / 100;
        if (iw.oldRevenue !== newRevenue) {
          await this.prisma.booking.update({
            where: { id: iw.id },
            data: { revenue: newRevenue, net_profit: newRevenue },
          });
          anyChanged = true;
          if (examples.length < 10 && Math.abs((iw.oldRevenue || 0) - newRevenue) > 1) {
            examples.push({
              item: iw.item,
              oldRevenue: iw.oldRevenue,
              newRevenue,
              catalogDaily: iw.weight,
              rentalTotal: rental.rental_price,
              itemCount: mainBookings.length,
            });
          }
        }
      }
      if (anyChanged) updated++; else skipped++;
    }

    this.logger.log(`Revenue recompute: ${updated} rentals updated, ${skipped} skipped`);
    return { updated, skipped, examples };
  }
}
