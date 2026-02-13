import { Injectable, Logger } from '@nestjs/common';
import { RentalScannerService } from './rental-scanner/rental-scanner.service';
import { PrismaService } from './prisma/prisma.service';
import { BlacklistService } from './blacklist/blacklist.service';
import { PlaywrightService } from './playwright/playwright.service';
import { HyggloService } from './hygglo/hygglo.service';
import { isAccessoryItem, findBestMatch, getInventoryItemNames } from './utils/item-matcher';

interface BookingRow {
  id: string;
  item_name: string;
  renter_name: string;
  start_date: Date;
  end_date: Date;
  revenue: number | null;
  net_profit: number | null;
  rental_id: string | null;
  account: string;
}

/** A unique rental = one renter + date range, possibly with multiple items */
interface GroupedRental {
  rentalId: string | null;
  renter: string;
  account: string;
  items: string[];
  startDate: Date;
  endDate: Date;
  earnings: number; // Daniel's take-home (sum of booking.revenue for this rental)
}

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private rentalScannerService: RentalScannerService,
    private prisma: PrismaService,
    private blacklistService: BlacklistService,
    private playwrightService: PlaywrightService,
    private hyggloService: HyggloService,
  ) {}

  async getHealthStatus() {
    let dbStatus: 'connected' | 'unreachable' = 'connected';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'unreachable';
    }

    return {
      status: dbStatus === 'connected' ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      db: dbStatus,
      scanner: this.rentalScannerService.getStatus(),
    };
  }

  getScannerStatus() {
    return this.rentalScannerService.getStatus();
  }

  /**
   * Deduplicate bookings by item_name + renter_name + start_date, keeping highest revenue.
   * Handles ghost booking duplicates from Feb 6 bug.
   */
  private deduplicateBookings(bookings: BookingRow[]): BookingRow[] {
    const seen = new Map<string, BookingRow>();
    for (const b of bookings) {
      const key = `${b.item_name}|${b.renter_name}|${b.start_date.toISOString().split('T')[0]}`;
      const existing = seen.get(key);
      if (!existing || (b.revenue || 0) > (existing.revenue || 0)) {
        seen.set(key, b);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Group deduped bookings into rentals (one renter + date range with multiple items).
   * Groups by normalized renter_name + start_date — one person on one date = one rental,
   * regardless of how many Hygglo listings/accounts they booked across.
   */
  private groupIntoRentals(bookings: BookingRow[]): GroupedRental[] {
    const groups = new Map<string, GroupedRental>();

    for (const b of bookings) {
      // Skip accessories from item counts (but keep their revenue in the rental total)
      const isAccessory = isAccessoryItem(b.item_name);

      // Group key: renter (normalized) + start_date = one rental visit
      const renterNorm = b.renter_name.trim().toLowerCase().replace(/\s+/g, ' ');
      const groupKey = `${renterNorm}|${b.start_date.toISOString().split('T')[0]}`;

      const existing = groups.get(groupKey);
      if (existing) {
        if (!isAccessory) existing.items.push(b.item_name);
        existing.earnings += b.revenue || 0;
        // Expand date range to cover all items
        if (b.start_date < existing.startDate) existing.startDate = b.start_date;
        if (b.end_date > existing.endDate) existing.endDate = b.end_date;
      } else {
        groups.set(groupKey, {
          rentalId: b.rental_id,
          renter: b.renter_name,
          account: b.account,
          items: isAccessory ? [] : [b.item_name],
          startDate: b.start_date,
          endDate: b.end_date,
          earnings: b.revenue || 0,
        });
      }
    }

    return Array.from(groups.values());
  }

  /**
   * Fetch all confirmed bookings, deduped and grouped by rental.
   * This is the single source of truth for all dashboard stats.
   */
  private async getConfirmedRentals(account?: string): Promise<{ bookings: BookingRow[]; rentals: GroupedRental[] }> {
    const where: any = { status: 'confirmed' };
    if (account) where.account = account;

    const allConfirmed = await this.prisma.booking.findMany({
      where,
      select: {
        id: true, item_name: true, renter_name: true,
        start_date: true, end_date: true,
        revenue: true, net_profit: true,
        rental_id: true, account: true,
      },
    });

    const deduped = this.deduplicateBookings(allConfirmed as BookingRow[]);
    const rentals = this.groupIntoRentals(deduped);
    return { bookings: deduped, rentals };
  }

  /**
   * Dashboard booking stats — counts RENTALS (unique renter+dates), not individual items.
   * A renter with FX3 + lens + mic = 1 rental, not 3.
   * Earnings come from the RENTAL table (captures ALL Hygglo revenue, not just matched items).
   */
  async getBookingStats(account?: string) {
    const { bookings, rentals } = await this.getConfirmedRentals(account);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    // Fetch actual Hygglo status for active rentals (catches overdue/unreturned gear)
    const activeRentalIds = rentals.map(r => r.rentalId).filter(Boolean) as string[];
    const rentalStatusMap = new Map<string, string>();
    if (activeRentalIds.length > 0) {
      const rentalStatuses = await this.prisma.rental.findMany({
        where: { id: { in: activeRentalIds } },
        select: { id: true, status: true },
      });
      for (const rs of rentalStatuses) {
        rentalStatusMap.set(rs.id, rs.status);
      }
    }

    // Lifecycle at RENTAL level (not item level) — from booking table (reconciled with Hygglo)
    // Only show rentals whose end_date hasn't passed yet (overdue ones stay in return hub only)
    const ongoingRentals = rentals.filter(r =>
      r.startDate <= todayEnd && r.endDate >= todayStart
    );
    const upcomingRentals = rentals.filter(r =>
      r.startDate > todayEnd
    );

    // Earnings from RENTAL TABLE (captures all Hygglo revenue including unmatched items)
    // Pickup-date attribution: 100% of revenue attributed to the actual pickup date
    // (when gear physically goes out), NOT spread across rental days.
    const rentalWhere: any = {
      status: { in: ['completed', 'ongoing', 'upcoming'] },
      rental_price: { not: null, gt: 0 },
      start_date: { not: null },
    };
    if (account) rentalWhere.account = account;

    const allRentalsForEarnings = await this.prisma.rental.findMany({
      where: rentalWhere,
      select: {
        start_date: true, end_date: true, rental_price: true, renter_info: true, listing_id: true,
        bookings: {
          where: { status: { in: ['confirmed', 'pending_review'] } },
          select: { pickup_date: true },
          take: 1,
        },
      },
    });

    // Deduplicate by listing_id + renter_info + start_date (keep highest revenue)
    const deduped = new Map<string, typeof allRentalsForEarnings[0] & { _effectiveDate: Date }>();
    for (const r of allRentalsForEarnings) {
      if (!r.start_date) continue;
      const key = `${(r as any).listing_id}|${r.renter_info}|${r.start_date.toISOString().split('T')[0]}`;
      const existing = deduped.get(key);
      if (!existing || (r.rental_price || 0) > (existing.rental_price || 0)) {
        const pickupDate = r.bookings?.[0]?.pickup_date;
        deduped.set(key, { ...r, _effectiveDate: pickupDate || r.start_date });
      }
    }
    const dedupedRentals = Array.from(deduped.values());

    // Today's earnings: rentals where pickup date == today (100% revenue on pickup day)
    let todayRentalEarnings = 0;
    let todayRentalCount = 0;
    const todayPickupRentals: typeof dedupedRentals = [];
    for (const r of dedupedRentals) {
      const ed = new Date(r._effectiveDate); ed.setHours(0, 0, 0, 0);
      if (ed >= todayStart && ed <= todayEnd) {
        todayRentalEarnings += r.rental_price || 0;
        todayRentalCount++;
        todayPickupRentals.push(r);
      }
    }

    // Week earnings: rentals where pickup date is within last 7 days
    let weekRentalEarnings = 0;
    for (const r of dedupedRentals) {
      const ed = new Date(r._effectiveDate); ed.setHours(0, 0, 0, 0);
      if (ed >= weekStart && ed <= todayEnd) {
        weekRentalEarnings += r.rental_price || 0;
      }
    }

    // Total items out (for sub-text detail) — from booking table (has clean item names)
    // Include overdue items (Hygglo still says 'ongoing' even if end date passed)
    const ongoingItems = bookings.filter(b => {
      if (isAccessoryItem(b.item_name)) return false;
      const dateOngoing = b.start_date <= todayEnd && b.end_date >= todayStart;
      const hyggloOngoing = b.rental_id ? rentalStatusMap.get(b.rental_id) === 'ongoing' : false;
      return dateOngoing || hyggloOngoing;
    }).length;
    const upcomingItems = bookings.filter(b =>
      b.start_date > todayEnd && !isAccessoryItem(b.item_name)
    ).length;

    // Rental details for expandable tiles (photos, names, items, earnings)
    const detailRentalIds = [...new Set([
      ...ongoingRentals.map(r => r.rentalId),
      ...upcomingRentals.map(r => r.rentalId),
    ])].filter(Boolean);

    const detailRentals = detailRentalIds.length > 0
      ? await this.prisma.rental.findMany({
          where: { id: { in: detailRentalIds as string[] } },
          select: {
            id: true, title: true, renter_info: true, account: true,
            start_date: true, end_date: true, rental_price: true,
            photos_urls: true, status: true,
          },
        })
      : [];
    const rentalDetailMap = new Map(detailRentals.map(r => [r.id, r]));

    const mapRentalDetail = (grouped: GroupedRental) => {
      const detail = grouped.rentalId ? rentalDetailMap.get(grouped.rentalId) : null;
      return {
        renter: grouped.renter,
        items: grouped.items,
        earnings: Math.round(grouped.earnings * 100) / 100,
        startDate: grouped.startDate,
        endDate: grouped.endDate,
        account: grouped.account,
        photo: detail?.photos_urls?.[0] || null,
      };
    };

    // === Pending verification rentals (display only — NOT in any earnings/count calculations) ===
    // "Pending" = owner accepted on Hygglo, but platform is verifying the renter.
    // Detected via order_step='VERIFIED' (the VERIFIED step is active, meaning awaiting docs/ID).
    const pendingVerificationRentals = await this.prisma.rental.findMany({
      where: {
        order_step: 'VERIFIED',
        ...(account ? { account } : {}),
      },
      select: {
        id: true, title: true, renter_info: true, account: true,
        start_date: true, end_date: true, photos_urls: true, rental_price: true,
      },
      orderBy: { start_date: 'asc' },
    });

    // Group by renter+date (one person on one date = one pending visit)
    const pendingVisitMap = new Map<string, {
      renter: string; items: string[]; startDate: Date; endDate: Date;
      account: string; photo: string | null; earnings: number;
    }>();
    for (const r of pendingVerificationRentals) {
      const renterNorm = (r.renter_info || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const dateKey = r.start_date ? r.start_date.toISOString().split('T')[0] : '';
      const key = `${renterNorm}|${dateKey}`;
      const existing = pendingVisitMap.get(key);
      if (existing) {
        existing.items.push(r.title);
        existing.earnings += r.rental_price || 0;
        if (r.end_date && (!existing.endDate || r.end_date > existing.endDate)) {
          existing.endDate = r.end_date;
        }
        if (!existing.photo && r.photos_urls?.[0]) existing.photo = r.photos_urls[0];
      } else {
        pendingVisitMap.set(key, {
          renter: r.renter_info || 'Unknown',
          items: [r.title],
          startDate: r.start_date!,
          endDate: r.end_date!,
          account: r.account || 'dbcinema',
          photo: r.photos_urls?.[0] || null,
          earnings: r.rental_price || 0,
        });
      }
    }
    const pendingDetails = Array.from(pendingVisitMap.values()).map(d => ({
      ...d,
      earnings: Math.round(d.earnings * 100) / 100,
    }));

    return {
      // Rental-level counts (what Daniel cares about) — from booking table (reconciled)
      ongoingRentals: ongoingRentals.length,
      upcomingRentals: upcomingRentals.length,
      activeRentals: ongoingRentals.length + upcomingRentals.length,
      // Item-level detail (for sub-text)
      ongoingItems,
      upcomingItems,
      // Earnings from rental table (pickup-date attribution)
      todayEarnings: Math.round(todayRentalEarnings * 100) / 100,
      todayRentalCount,
      weekEarnings: Math.round(weekRentalEarnings * 100) / 100,
      // Rental details for expandable tiles
      ongoingDetails: ongoingRentals.map(mapRentalDetail),
      upcomingDetails: upcomingRentals.slice(0, 8).map(mapRentalDetail),
      todayDetails: todayPickupRentals.map(r => ({
        renter: r.renter_info || 'Unknown',
        earnings: Math.round((r.rental_price || 0) * 100) / 100,
      })),
      // Pending Hygglo rentals (display only — NO earnings impact)
      pendingRentals: pendingVisitMap.size,
      pendingDetails,
    };
  }

  /**
   * Calendar data: bookings grouped by date for the calendar view.
   */
  /**
   * CALENDAR BOOKING RULES (authoritative — do not weaken):
   *
   * WHAT APPEARS IN THE CALENDAR:
   *   A rental appears ONLY if it has at least one booking with status = 'confirmed'.
   *   'confirmed' means: Hygglo rental accepted (upcoming/ongoing/completed) AND inventory available.
   *
   * WHAT NEVER APPEARS:
   *   - Unaccepted Hygglo requests (rental status = 'pending')
   *   - Bookings with status = 'pending_review' as standalone entries
   *   - Cancelled or obsolete rentals
   *   - Items not in MASTER_INVENTORY
   *
   * SUPPLEMENTARY ITEMS:
   *   When a renter has BOTH confirmed AND pending_review bookings for the same account+date,
   *   the pending items appear as annotations on the confirmed entry (labeled "pending").
   *   They NEVER create their own calendar entry.
   *
   * PHOTOS:
   *   Photos come ONLY from confirmed bookings' linked rentals.
   *   Pending bookings' photos are excluded to prevent cross-listing image contamination.
   *
   * GROUPING:
   *   Entries group by renter_name + account + start_date.
   *   Account is part of the key to prevent cross-account merging (Leo ≠ DB Cinema).
   *
   * EARNINGS:
   *   Only confirmed booking revenue counts. Pending revenue is excluded.
   */
  async getCalendarBookings(startDate: string, endDate: string, account?: string) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const dateOverlap = [
      { start_date: { lte: end }, OR: [
        { return_date: { gte: start } },
        { return_date: null, end_date: { gte: start } },
      ]},
      { pickup_date: { gte: start, lte: end } },
      { return_date: { gte: start, lte: end } },
    ];

    // === PRIMARY: confirmed bookings only — these define what appears in the calendar ===
    const confirmedWhere: any = { status: 'confirmed', OR: dateOverlap };
    if (account) confirmedWhere.account = account;

    const confirmedBookings = await this.prisma.booking.findMany({
      where: confirmedWhere,
      select: {
        id: true, item_name: true, renter_name: true,
        start_date: true, end_date: true,
        account: true, revenue: true, rental_id: true,
        notes: true, pickup_time: true, return_time: true,
        pickup_date: true, return_date: true,
        rental: {
          select: { photos_urls: true, parsed_items: true },
        },
      },
      orderBy: { start_date: 'asc' },
    });

    const deduped = this.deduplicateBookings(confirmedBookings as unknown as BookingRow[]);

    // Group confirmed bookings by renter+account+date (account in key prevents cross-account merging)
    const rentalMap = new Map<string, {
      renter: string;
      account: string;
      items: string[];
      pendingItems: string[];
      startDate: string;
      endDate: string;
      earnings: number;
      photos: string[];
      notes: any;
      pickupTime: string | null;
      returnTime: string | null;
      pickupDate: string | null;
      returnDate: string | null;
    }>();

    for (const b of deduped) {
      const renterNorm = b.renter_name.trim().toLowerCase().replace(/\s+/g, ' ');
      const key = `${renterNorm}|${b.account}|${b.start_date.toISOString().split('T')[0]}`;

      let notesObj: any = null;
      try { notesObj = (b as any).notes ? JSON.parse((b as any).notes) : null; } catch { /* ignore */ }

      // Photos from confirmed bookings' rentals only
      const rental = (b as any).rental;
      const photos: string[] = rental?.photos_urls || [];

      const parsedItems: string[] = rental?.parsed_items
        ? (rental.parsed_items as any[]).map((pi: any) => pi.item || pi.name).filter(Boolean)
        : [];

      const existing = rentalMap.get(key);
      if (existing) {
        if (!isAccessoryItem(b.item_name)) existing.items.push(b.item_name);
        existing.earnings += b.revenue || 0;
        if (b.start_date.toISOString() < existing.startDate) existing.startDate = b.start_date.toISOString();
        if (b.end_date.toISOString() > existing.endDate) existing.endDate = b.end_date.toISOString();
        if (!existing.pickupTime && (b as any).pickup_time) existing.pickupTime = (b as any).pickup_time;
        if (!existing.returnTime && (b as any).return_time) existing.returnTime = (b as any).return_time;
        if (!existing.pickupDate && (b as any).pickup_date) existing.pickupDate = (b as any).pickup_date.toISOString();
        if (!existing.returnDate && (b as any).return_date) existing.returnDate = (b as any).return_date.toISOString();
        for (const p of photos) { if (!existing.photos.includes(p)) existing.photos.push(p); }
        if (notesObj) {
          if (!existing.notes) existing.notes = notesObj;
          else if (notesObj.ownerNotes) {
            if (!existing.notes.ownerNotes) existing.notes.ownerNotes = [];
            existing.notes.ownerNotes.push(...notesObj.ownerNotes);
          }
        }
        if (parsedItems.length > 0) {
          if (!existing.notes) existing.notes = {};
          if (!existing.notes.allItems) existing.notes.allItems = [];
          for (const pi of parsedItems) {
            if (!existing.notes.allItems.includes(pi)) existing.notes.allItems.push(pi);
          }
        }
      } else {
        if (parsedItems.length > 0 && notesObj && !notesObj.allItems?.length) {
          notesObj.allItems = parsedItems;
        } else if (parsedItems.length > 0 && !notesObj) {
          notesObj = { allItems: parsedItems };
        }

        rentalMap.set(key, {
          renter: b.renter_name,
          account: b.account,
          items: isAccessoryItem(b.item_name) ? [] : [b.item_name],
          pendingItems: [],
          startDate: b.start_date.toISOString(),
          endDate: b.end_date.toISOString(),
          earnings: b.revenue || 0,
          photos,
          notes: notesObj,
          pickupTime: (b as any).pickup_time || null,
          returnTime: (b as any).return_time || null,
          pickupDate: (b as any).pickup_date ? (b as any).pickup_date.toISOString() : null,
          returnDate: (b as any).return_date ? (b as any).return_date.toISOString() : null,
        });
      }
    }

    // === SECONDARY: pending_review bookings — supplement items on existing confirmed entries only ===
    // These NEVER create standalone calendar entries. They only annotate confirmed entries.
    // Matches by renter+date ACROSS accounts (same renter may have listings on both Leo & DB Cinema).
    // Photos are NOT included from pending bookings — only items are supplemented.
    if (rentalMap.size > 0) {
      // Build a renter+date → entry lookup (without account) for cross-account matching
      const renterDateIndex = new Map<string, typeof rentalMap extends Map<string, infer V> ? V : never>();
      for (const [, entry] of rentalMap) {
        const renterNorm = entry.renter.trim().toLowerCase().replace(/\s+/g, ' ');
        const dateKey = `${renterNorm}|${entry.startDate.split('T')[0]}`;
        // If multiple confirmed entries for same renter+date on different accounts, pick the first
        if (!renterDateIndex.has(dateKey)) {
          renterDateIndex.set(dateKey, entry);
        }
      }

      const pendingWhere: any = { status: 'pending_review', OR: dateOverlap };
      if (account) pendingWhere.account = account;

      const pendingBookings = await this.prisma.booking.findMany({
        where: pendingWhere,
        select: { item_name: true, renter_name: true, start_date: true, account: true },
      });

      for (const pb of pendingBookings) {
        const renterNorm = pb.renter_name.trim().toLowerCase().replace(/\s+/g, ' ');
        const dateKey = `${renterNorm}|${pb.start_date.toISOString().split('T')[0]}`;
        const entry = renterDateIndex.get(dateKey);
        // Only supplement if a confirmed entry exists for this renter+date (any account)
        if (entry && !isAccessoryItem(pb.item_name)) {
          if (!entry.items.includes(pb.item_name) && !entry.pendingItems.includes(pb.item_name)) {
            entry.pendingItems.push(pb.item_name);
          }
        }
        // If no confirmed entry exists → pending booking is silently ignored (by design)
      }
    }

    const inventoryNames = getInventoryItemNames();
    return Array.from(rentalMap.values()).map(r => {
      if (!r.notes) r.notes = {};
      // Dedup allItems through inventory matching — "Anamorphic Great Joy 35mm" and
      // "Anamorphic Great Joy lens 35mm" both resolve to the same inventory item
      const mergedItems: string[] = [];
      const seenInventory = new Set<string>();
      for (const item of [...(r.notes.allItems || []), ...r.items]) {
        const matched = findBestMatch(item, inventoryNames);
        const key = matched || item; // use inventory name if matched, else raw
        if (!seenInventory.has(key)) {
          seenInventory.add(key);
          mergedItems.push(matched || item); // prefer canonical inventory name
        }
      }
      r.notes.allItems = mergedItems;

      const mainItems: string[] = [];
      const accessories: string[] = [];
      for (const item of r.notes.allItems) {
        if (isAccessoryItem(item)) accessories.push(item);
        else mainItems.push(item);
      }
      r.notes.allItems = mainItems;
      r.notes.accessories = accessories;
      r.notes.pendingItems = r.pendingItems.filter(pi => {
        const piMatch = findBestMatch(pi, inventoryNames) || pi;
        return !seenInventory.has(piMatch) && !accessories.includes(pi);
      });
      return {
        ...r,
        pendingItems: r.pendingItems,
        earnings: Math.round(r.earnings * 100) / 100,
      };
    });
  }

  async getBookingsByStage(account?: string) {
    // Active pipeline only — conversations that are actually live or recently finished
    // Excludes old completed/cancelled/obsolete rentals
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const where: any = {
      status: 'active',
      rental: {
        OR: [
          { status: 'pending', start_date: { gte: todayStart } }, // Pending with future start date only
          { status: { in: ['upcoming', 'ongoing'] } },            // Accepted/active rentals
          { end_date: { gte: twoDaysAgo }, status: { in: ['completed', 'ongoing'] } }, // Drop 48h after end
        ],
        ...(account ? { account } : {}),
      },
    };

    const states = await this.prisma.follow_up_state.findMany({
      where,
      select: { conversation_stage: true },
    });

    const counts: Record<string, number> = {};
    for (const s of states) {
      const stage = s.conversation_stage || 'inquiry';
      counts[stage] = (counts[stage] || 0) + 1;
    }

    // "Pending" = owner accepted on Hygglo but platform verifying renter (order_step='VERIFIED').
    const pendingVerCount = await this.prisma.rental.count({
      where: {
        order_step: 'VERIFIED',
        ...(account ? { account } : {}),
      },
    });
    counts['pending'] = pendingVerCount;

    return counts;
  }

  async getRecentRentals(limit: number = 10, account?: string) {
    const where: any = account ? { account } : {};
    return await this.prisma.rental.findMany({
      take: limit,
      where,
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        listing_id: true,
        title: true,
        status: true,
        start_date: true,
        end_date: true,
        renter_info: true,
        listing_url: true,
        account: true,
        created_at: true,
        updated_at: true,
      },
    });
  }

  async getRecentItems(limit: number = 20, account?: string) {
    const where: any = {};
    if (account) where.rental = { account };
    return await this.prisma.extracteditem.findMany({
      take: limit,
      where,
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        item_name: true,
        source: true,
        confidence_score: true,
        created_at: true,
        rental: {
          select: {
            title: true,
            listing_id: true,
          },
        },
      },
    });
  }

  async getItemCatalog(limit: number = 50) {
    return await this.prisma.itemcatalog.findMany({
      take: limit,
      orderBy: { first_seen_at: 'desc' },
      select: {
        id: true,
        listing_id: true,
        item_name: true,
        description: true,
        first_seen_at: true,
      },
    });
  }

  /**
   * Get ongoing rentals for Return Hub.
   * Includes: (1) date-based ongoing (start <= today AND end >= today)
   * AND (2) overdue rentals (Hygglo still says 'ongoing' but end date has passed — gear not returned).
   */
  async getOngoingRentals(account?: string) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const where: any = {
      rental_price: { gt: 0 },
      OR: [
        // Normal ongoing: within date range
        {
          status: { in: ['ongoing', 'upcoming'] },
          start_date: { lte: todayEnd },
          end_date: { gte: todayStart },
        },
        // Overdue: Hygglo still says ongoing but end date has passed (gear not returned)
        {
          status: 'ongoing',
          start_date: { lte: todayEnd },
          end_date: { lt: todayStart },
        },
      ],
    };
    if (account) where.account = account;

    const rentals = await this.prisma.rental.findMany({
      where,
      orderBy: { end_date: 'asc' },
      select: {
        id: true,
        listing_id: true,
        title: true,
        renter_info: true,
        account: true,
        start_date: true,
        end_date: true,
        rental_price: true,
        photos_urls: true,
        parsed_items: true,
        bookings: {
          where: { status: 'confirmed' },
          select: { item_name: true, pickup_time: true, return_time: true },
        },
      },
    });

    // Check which have already been processed
    const rentalIds = rentals.map(r => r.id);
    const processed = await this.prisma.return_processing.findMany({
      where: { rental_id: { in: rentalIds } },
      select: { rental_id: true },
    });
    const processedSet = new Set(processed.map(p => p.rental_id));

    return rentals
      .filter(r => !processedSet.has(r.id))
      .map(r => {
        const items: string[] = [];
        // Prefer parsed_items for richer data
        if (r.parsed_items && Array.isArray(r.parsed_items)) {
          for (const pi of r.parsed_items as any[]) {
            if (pi.item && !isAccessoryItem(pi.item)) items.push(pi.item);
          }
        }
        // Fall back to booking items
        if (items.length === 0) {
          for (const b of r.bookings) {
            if (!isAccessoryItem(b.item_name)) items.push(b.item_name);
          }
        }

        const returnTime = r.bookings.find(b => b.return_time)?.return_time || null;

        return {
          id: r.id,
          listingId: r.listing_id,
          renterName: r.renter_info || 'Unknown',
          account: r.account || 'dbcinema',
          startDate: r.start_date,
          endDate: r.end_date,
          items,
          earnings: Math.round((r.rental_price || 0) * 100) / 100,
          photos: r.photos_urls || [],
          returnTime,
          overdue: r.end_date ? r.end_date < todayStart : false,
        };
      });
  }

  /**
   * Process a rental return (good or issues).
   */
  async processReturn(rentalId: string, body: {
    outcome: 'good' | 'issues';
    blacklist?: boolean;
    reason?: string;
    issues?: string[];
    skipFollowUp?: boolean;
    dashboardApproved?: boolean;
  }) {
    const rental = await this.prisma.rental.findUnique({
      where: { id: rentalId },
      select: {
        id: true, listing_id: true, title: true, renter_info: true, account: true,
        rental_price: true, status: true, renter_links: {
          select: { renter_profile: { select: { id: true, rental_issues_note: true } } },
        },
      },
    });

    if (!rental) {
      return { error: 'Rental not found' };
    }

    const renterName = rental.renter_info || 'Unknown';
    const account = (rental.account || 'dbcinema') as 'dbcinema' | 'leo';
    let reviewLeft = false;
    let thankYouSent = false;
    let thankYouText: string | null = null;
    let markedOnHygglo = false;

    if (body.outcome === 'issues') {
      // Build issue note with date context
      const dateStr = new Date().toISOString().split('T')[0];
      const issueItems = (body.issues || []).length > 0
        ? body.issues!.join('; ')
        : '';
      const customNote = body.reason || '';
      const newEntry = `[${dateStr}] ${rental.title || 'Rental'}: ${[issueItems, customNote].filter(Boolean).join(' — ')}`;

      // Append to existing issues (permanent history)
      const profileLink = rental.renter_links?.[0];
      const existingNotes = profileLink?.renter_profile?.rental_issues_note || '';
      const updatedNotes = existingNotes
        ? existingNotes + '\n' + newEntry
        : newEntry;

      if (body.blacklist) {
        await this.blacklistService.addToBlacklist(
          renterName,
          body.reason || issueItems || 'Flagged during return processing',
          'dashboard',
        );
        if (profileLink) {
          await this.prisma.renter_profile.update({
            where: { id: profileLink.renter_profile.id },
            data: {
              requires_manual_approval: true,
              rental_issues_note: updatedNotes,
            },
          });
        }
        this.logger.log(`Blacklisted renter ${renterName} via return hub: ${issueItems}`);
      } else {
        if (profileLink) {
          await this.prisma.renter_profile.update({
            where: { id: profileLink.renter_profile.id },
            data: {
              requires_manual_approval: true,
              rental_issues_note: updatedNotes,
            },
          });
          this.logger.log(`Flagged renter ${renterName} for manual approval: ${issueItems}`);
        }
      }
    } else if (!body.skipFollowUp) {
      // Good outcome WITH follow-up — leave review + send thank you
      try {
        const reviewResult = await this.playwrightService.leaveReview(rental.listing_id, account, 5, !!body.dashboardApproved);
        reviewLeft = reviewResult.success;
        if (!reviewResult.success) {
          this.logger.warn(`Review not left for ${rental.listing_id}: ${reviewResult.error}`);
        }
      } catch (err) {
        this.logger.warn(`leaveReview failed: ${err.message}`);
      }

      const reviewRequest = `\n\nIf you enjoyed the experience, we'd really appreciate a quick review on Hygglo — it helps us a lot!`;
      thankYouText = account === 'leo'
        ? `Hey! Thanks so much for renting with me, really appreciate it! Hope the gear worked out great for your project. If you'd like to rent again, use code db15off for 15% off your next booking. Cheers!` + reviewRequest
        : `Thanks for choosing DB Cinema Rentals! We hope the equipment performed perfectly for your production. As a thank you, here's 15% off your next rental — just use code db15off when booking. Looking forward to working with you again!` + reviewRequest;

      try {
        thankYouSent = await this.hyggloService.sendMessage(rental.listing_id, thankYouText, !!body.dashboardApproved);
        if (thankYouSent) {
          this.logger.log(`Auto-sent thank you + review request for rental ${rentalId}`);
        }
      } catch (err) {
        this.logger.warn(`Failed to auto-send thank you for rental ${rentalId}: ${err.message}`);
      }
    } else {
      // skipFollowUp = true — no review, no thank you (bad renter)
      this.logger.log(`No follow-up for rental ${rentalId} (${renterName}) — skipped by owner`);
    }

    // Mark as returned on Hygglo — always attempt regardless of local status
    // (scanner may auto-complete locally but rental may still be open on Hygglo)
    const listingId = rental.listing_id;
    const forceReturn = !!body.dashboardApproved;
    try {
      // Try API first (fast)
      const apiResult = await this.hyggloService.markAsReturned(listingId, account, forceReturn);
      if (apiResult.success) {
        this.logger.log(`Marked rental ${rentalId} as returned via Hygglo API`);
        markedOnHygglo = true;
      } else {
        this.logger.debug(`API markAsReturned failed for ${rentalId}: ${apiResult.error}`);
      }

      // Always also try Playwright — API may return 200 without actually marking on Hygglo
      try {
        const pwResult = await this.playwrightService.markAsReturned(listingId, account, forceReturn);
        if (pwResult.success) {
          this.logger.log(`Marked rental ${rentalId} as returned via Playwright`);
          markedOnHygglo = true;
        } else if (!markedOnHygglo) {
          this.logger.warn(`Failed to mark rental ${rentalId} as returned on Hygglo: API=${apiResult.error}, Playwright=${pwResult.error}`);
        }
      } catch (pwErr) {
        if (!markedOnHygglo) {
          this.logger.warn(`Playwright markAsReturned failed for ${rentalId}: ${pwErr.message}`);
        }
      }

      // Update local status if marked on Hygglo
      if (markedOnHygglo && rental.status !== 'completed') {
        await this.prisma.rental.update({ where: { id: rentalId }, data: { status: 'completed' } });
        this.logger.log(`Updated rental ${rentalId} local status to completed`);
      }
    } catch (err) {
      this.logger.warn(`markAsReturned failed for rental ${rentalId}: ${err.message}`);
    }

    // Create return_processing record
    await this.prisma.return_processing.create({
      data: {
        rental_id: rentalId,
        outcome: body.outcome,
        blacklisted: body.outcome === 'issues' && body.blacklist === true,
        flagged: body.outcome === 'issues' && !body.blacklist,
        review_left: reviewLeft,
        thank_you_sent: thankYouSent,
        thank_you_text: thankYouText,
        earnings: rental.rental_price || 0,
        notes: body.reason || (body.skipFollowUp ? 'No follow-up (owner choice)' : null),
      },
    });

    return {
      success: true,
      earnings: Math.round((rental.rental_price || 0) * 100) / 100,
      outcome: body.outcome,
      reviewLeft,
      thankYouSent,
      markedOnHygglo,
      renterName,
    };
  }

  /**
   * Manually send thank you + review request for a rental.
   * Idempotent — rejects if already sent.
   */
  async sendThankYou(rentalId: string) {
    const existing = await this.prisma.return_processing.findUnique({
      where: { rental_id: rentalId },
    });

    if (existing?.thank_you_sent) {
      return { error: 'Thank you already sent for this rental' };
    }

    const rental = await this.prisma.rental.findUnique({
      where: { id: rentalId },
      select: { listing_id: true, account: true },
    });

    if (!rental) {
      return { error: 'Rental not found' };
    }

    const account = (rental.account || 'dbcinema') as 'dbcinema' | 'leo';
    const reviewRequest = `\n\nIf you enjoyed the experience, we'd really appreciate a quick review on Hygglo — it helps us a lot!`;
    const message = account === 'leo'
      ? `Hey! Thanks so much for renting with me, really appreciate it! Hope the gear worked out great for your project. If you'd like to rent again, use code db15off for 15% off your next booking. Cheers!` + reviewRequest
      : `Thanks for choosing DB Cinema Rentals! We hope the equipment performed perfectly for your production. As a thank you, here's 15% off your next rental — just use code db15off when booking. Looking forward to working with you again!` + reviewRequest;

    // Dashboard-triggered — bypass read-only for this specific rental
    const sent = await this.hyggloService.sendMessage(rental.listing_id, message, true);

    if (sent) {
      await this.prisma.return_processing.upsert({
        where: { rental_id: rentalId },
        update: { thank_you_sent: true, thank_you_text: message },
        create: {
          rental_id: rentalId,
          outcome: 'good',
          thank_you_sent: true,
          thank_you_text: message,
          earnings: 0,
        },
      });
    }

    return { success: sent, message: sent ? 'Thank you sent' : 'Failed to send' };
  }
}
