import { Injectable, Logger } from '@nestjs/common';
import { RentalScannerService } from './rental-scanner/rental-scanner.service';
import { PrismaService } from './prisma/prisma.service';
import { BlacklistService } from './blacklist/blacklist.service';
import { PlaywrightService } from './playwright/playwright.service';
import { HyggloService } from './hygglo/hygglo.service';
import { isAccessoryItem } from './utils/item-matcher';

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
    // Include overdue rentals: end date passed but Hygglo still says 'ongoing' (gear not returned)
    const ongoingRentals = rentals.filter(r => {
      const dateOngoing = r.startDate <= todayEnd && r.endDate >= todayStart;
      const hyggloOngoing = r.rentalId ? rentalStatusMap.get(r.rentalId) === 'ongoing' : false;
      return dateOngoing || hyggloOngoing;
    });
    const upcomingRentals = rentals.filter(r =>
      r.startDate > todayEnd
    );

    // Earnings from RENTAL TABLE (captures all Hygglo revenue including unmatched items)
    const rentalWhere: any = {
      status: { in: ['completed', 'ongoing', 'upcoming'] },
      rental_price: { not: null, gt: 0 },
      start_date: { not: null },
    };
    if (account) rentalWhere.account = account;

    const allRentalsForEarnings = await this.prisma.rental.findMany({
      where: rentalWhere,
      select: { start_date: true, rental_price: true, renter_info: true, listing_id: true },
    });

    // Deduplicate by listing_id + renter_info + start_date (keep highest revenue)
    const deduped = new Map<string, typeof allRentalsForEarnings[0]>();
    for (const r of allRentalsForEarnings) {
      if (!r.start_date) continue;
      const key = `${(r as any).listing_id}|${r.renter_info}|${r.start_date.toISOString().split('T')[0]}`;
      const existing = deduped.get(key);
      if (!existing || (r.rental_price || 0) > (existing.rental_price || 0)) {
        deduped.set(key, r);
      }
    }
    const dedupedRentals = Array.from(deduped.values());

    const todayRentalEarnings = dedupedRentals
      .filter(r => r.start_date! >= todayStart && r.start_date! <= todayEnd)
      .reduce((sum, r) => sum + (r.rental_price || 0), 0);
    const todayRentalCount = dedupedRentals
      .filter(r => r.start_date! >= todayStart && r.start_date! <= todayEnd).length;

    const weekRentalEarnings = dedupedRentals
      .filter(r => r.start_date! >= weekStart && r.start_date! <= todayEnd)
      .reduce((sum, r) => sum + (r.rental_price || 0), 0);

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

    // Today's rental breakdown
    const todayRentals = dedupedRentals
      .filter(r => r.start_date! >= todayStart && r.start_date! <= todayEnd);

    return {
      // Rental-level counts (what Daniel cares about) — from booking table (reconciled)
      ongoingRentals: ongoingRentals.length,
      upcomingRentals: upcomingRentals.length,
      activeRentals: ongoingRentals.length + upcomingRentals.length,
      // Item-level detail (for sub-text)
      ongoingItems,
      upcomingItems,
      // Earnings from rental table
      todayEarnings: Math.round(todayRentalEarnings * 100) / 100,
      todayRentalCount,
      weekEarnings: Math.round(weekRentalEarnings * 100) / 100,
      // Rental details for expandable tiles
      ongoingDetails: ongoingRentals.map(mapRentalDetail),
      upcomingDetails: upcomingRentals.slice(0, 8).map(mapRentalDetail),
      todayDetails: todayRentals.map(r => ({
        renter: r.renter_info || 'Unknown',
        earnings: Math.round((r.rental_price || 0) * 100) / 100,
      })),
    };
  }

  /**
   * Calendar data: bookings grouped by date for the calendar view.
   */
  async getCalendarBookings(startDate: string, endDate: string, account?: string) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const where: any = {
      status: 'confirmed',
      // Booking overlaps with the requested range (use return_date when available)
      start_date: { lte: end },
      OR: [
        { return_date: { gte: start } },
        { return_date: null, end_date: { gte: start } },
      ],
    };
    if (account) where.account = account;

    const bookings = await this.prisma.booking.findMany({
      where,
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

    // Deduplicate
    const deduped = this.deduplicateBookings(bookings as unknown as BookingRow[]);

    // Group by rental for calendar display
    const rentalMap = new Map<string, {
      renter: string;
      account: string;
      items: string[];
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
      const key = `${renterNorm}|${b.start_date.toISOString().split('T')[0]}`;

      // Parse notes JSON
      let notesObj: any = null;
      try { notesObj = (b as any).notes ? JSON.parse((b as any).notes) : null; } catch { /* ignore */ }

      // Get photos from linked rental
      const rental = (b as any).rental;
      const photos: string[] = rental?.photos_urls || [];

      // Get all bundle items from parsed_items (richer than booking-level items)
      const parsedItems: string[] = rental?.parsed_items
        ? (rental.parsed_items as any[]).map((pi: any) => pi.item || pi.name).filter(Boolean)
        : [];

      const existing = rentalMap.get(key);
      if (existing) {
        if (!isAccessoryItem(b.item_name)) existing.items.push(b.item_name);
        existing.earnings += b.revenue || 0;
        if (b.start_date.toISOString() < existing.startDate) existing.startDate = b.start_date.toISOString();
        if (b.end_date.toISOString() > existing.endDate) existing.endDate = b.end_date.toISOString();
        // Capture times from any booking in the rental group
        if (!existing.pickupTime && (b as any).pickup_time) existing.pickupTime = (b as any).pickup_time;
        if (!existing.returnTime && (b as any).return_time) existing.returnTime = (b as any).return_time;
        if (!existing.pickupDate && (b as any).pickup_date) existing.pickupDate = (b as any).pickup_date.toISOString();
        if (!existing.returnDate && (b as any).return_date) existing.returnDate = (b as any).return_date.toISOString();
        // Merge photos (dedup)
        for (const p of photos) { if (!existing.photos.includes(p)) existing.photos.push(p); }
        // Merge notes
        if (notesObj) {
          if (!existing.notes) existing.notes = notesObj;
          else if (notesObj.ownerNotes) {
            if (!existing.notes.ownerNotes) existing.notes.ownerNotes = [];
            existing.notes.ownerNotes.push(...notesObj.ownerNotes);
          }
        }
        // Merge parsed items
        if (parsedItems.length > 0 && (!existing.notes || !existing.notes.allItems?.length)) {
          if (!existing.notes) existing.notes = {};
          existing.notes.allItems = parsedItems;
        }
      } else {
        // Populate allItems from parsed_items if notes don't have them
        if (parsedItems.length > 0 && notesObj && !notesObj.allItems?.length) {
          notesObj.allItems = parsedItems;
        } else if (parsedItems.length > 0 && !notesObj) {
          notesObj = { allItems: parsedItems };
        }

        rentalMap.set(key, {
          renter: b.renter_name,
          account: b.account,
          items: isAccessoryItem(b.item_name) ? [] : [b.item_name],
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

    return Array.from(rentalMap.values()).map(r => {
      // Classify accessories from allItems so frontend can render them differently
      if (r.notes?.allItems?.length) {
        const mainItems: string[] = [];
        const accessories: string[] = [];
        for (const item of r.notes.allItems) {
          if (isAccessoryItem(item)) accessories.push(item);
          else mainItems.push(item);
        }
        r.notes.allItems = mainItems;
        r.notes.accessories = accessories;
      }
      return { ...r, earnings: Math.round(r.earnings * 100) / 100 };
    });
  }

  async getBookingsByStage(account?: string) {
    // Active pipeline only — conversations that are actually live or recently finished
    // Excludes old completed/cancelled/obsolete rentals
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const where: any = {
      status: 'active',
      rental: {
        OR: [
          { status: { in: ['pending', 'upcoming', 'ongoing'] } }, // Active conversations
          { end_date: { gte: twoWeeksAgo } }, // Recently ended (for completed/dead tracking)
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
        const reviewResult = await this.playwrightService.leaveReview(rental.listing_id, account, 5);
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
        thankYouSent = await this.hyggloService.sendMessage(rental.listing_id, thankYouText);
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

    // Mark as returned on Hygglo — runs async (don't block HTTP response)
    if (rental.status !== 'completed') {
      const listingId = rental.listing_id;
      const rid = rentalId;
      // Fire-and-forget: try API first, then Playwright fallback
      (async () => {
        try {
          const apiResult = await this.hyggloService.markAsReturned(listingId, account);
          if (apiResult.success) {
            await this.prisma.rental.update({ where: { id: rid }, data: { status: 'completed' } });
            this.logger.log(`Marked rental ${rid} as returned via Hygglo API + updated local status`);
            return;
          }
          this.logger.debug(`API markAsReturned failed, trying Playwright: ${apiResult.error}`);
          const pwResult = await this.playwrightService.markAsReturned(listingId, account);
          if (pwResult.success) {
            await this.prisma.rental.update({ where: { id: rid }, data: { status: 'completed' } });
            this.logger.log(`Marked rental ${rid} as returned via Playwright + updated local status`);
          } else {
            this.logger.warn(`Failed to mark rental ${rid} as returned on Hygglo: API=${apiResult.error}, Playwright=${pwResult.error}`);
          }
        } catch (err) {
          this.logger.warn(`markAsReturned failed for rental ${rid}: ${err.message}`);
        }
      })();
      markedOnHygglo = false; // Will complete async
    } else {
      markedOnHygglo = true; // Already completed
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

    const sent = await this.hyggloService.sendMessage(rental.listing_id, message);

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

    return { success: sent, message: sent ? 'Thank you sent' : 'Failed to send (check READ_ONLY_MODE)' };
  }
}
