import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarService } from '../calendar/calendar.service';
import { TelegramService } from '../telegram/telegram.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { MASTER_INVENTORY, findBestMatch, getInventoryItemNames } from '../utils/item-matcher';

@Injectable()
export class ContentionService {
  private readonly logger = new Logger(ContentionService.name);

  constructor(
    private prisma: PrismaService,
    private calendarService: CalendarService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private hyggloService: HyggloService,
  ) {}

  /**
   * Gate check — is this rental currently held by an active contention?
   */
  async isHeld(rentalId: string): Promise<{ held: boolean; contentionId?: string }> {
    const contention = await this.prisma.inventory_contention.findFirst({
      where: {
        status: 'active',
        held_rental_ids: { has: rentalId },
      },
    });
    if (contention) {
      return { held: true, contentionId: contention.id };
    }
    return { held: false };
  }

  /**
   * Detection — evaluate whether a rental triggers contention on any of its items.
   * Called when a new rental appears or when rental status changes.
   */
  async evaluateContention(triggerRentalId: string): Promise<void> {
    try {
      const rental = await this.prisma.rental.findUnique({
        where: { id: triggerRentalId },
        include: { extracted_items: true },
      });
      if (!rental || !rental.start_date || !rental.end_date) return;
      if (['cancelled', 'obsolete'].includes(rental.status)) return;

      // Get listing_title items (most reliable source)
      const titleItems = rental.extracted_items
        .filter(ei => ei.source === 'listing_title')
        .map(ei => ei.item_name);
      if (titleItems.length === 0) return;

      for (const itemName of titleItems) {
        await this.evaluateItemContention(itemName, rental);
      }
    } catch (err) {
      this.logger.error(`evaluateContention failed for ${triggerRentalId}: ${err.message}`);
    }
  }

  private async evaluateItemContention(itemName: string, triggerRental: any): Promise<void> {
    const matched = findBestMatch(itemName, getInventoryItemNames());
    if (!matched) return;

    const maxQty = MASTER_INVENTORY[matched] || 1;
    const startDate = triggerRental.start_date!;
    const endDate = triggerRental.end_date!;

    // Check already-confirmed bookings
    const availability = await this.calendarService.checkAvailability(matched, startDate, endDate);
    const confirmedBooked = availability.booked;

    // Find ALL other active rentals wanting this item in overlapping dates
    const competitors = await this.prisma.rental.findMany({
      where: {
        id: { not: triggerRental.id },
        status: { in: ['pending', 'upcoming', 'ongoing'] },
        start_date: { lt: endDate },
        end_date: { gt: startDate },
        extracted_items: {
          some: {
            item_name: matched,
            source: 'listing_title',
          },
        },
      },
      include: {
        follow_up_state: true,
      },
    });

    // Filter out dead/completed conversations
    const aliveCompetitors = competitors.filter(r => {
      const stage = r.follow_up_state?.conversation_stage;
      return !stage || !['dead', 'completed'].includes(stage);
    });

    // Include trigger rental in the competition pool
    const allCompeting = [triggerRental, ...aliveCompetitors];
    const competingDemand = allCompeting.length;

    // Only contend if demand exceeds available supply
    if (confirmedBooked + competingDemand <= maxQty) {
      // No contention — resolve any existing active contention for this item+overlap
      await this.resolveIfNoLongerContended(matched, startDate, endDate);
      return;
    }

    // Rank by revenue DESC, created_at ASC (tiebreaker: first-come-first-served)
    allCompeting.sort((a, b) => {
      const revDiff = (b.rental_price || 0) - (a.rental_price || 0);
      if (revDiff !== 0) return revDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    // How many must be held? demand - (maxQty - confirmedBooked)
    const availableSlots = Math.max(0, maxQty - confirmedBooked);
    const holdCount = Math.max(0, competingDemand - availableSlots);
    if (holdCount === 0) return;

    // Bottom N by revenue → held
    const heldRentals = allCompeting.slice(allCompeting.length - holdCount);
    // Top non-confirmed rental → favored (gets urgency)
    const favoredRental = allCompeting.find(r => {
      // Don't favor already-confirmed rentals (they don't need urgency)
      const step = r.order_step;
      return !step || ['REQUEST', 'APPROVED'].includes(step);
    }) || allCompeting[0];

    // Upsert contention record (idempotent for same item+overlap)
    const existing = await this.prisma.inventory_contention.findFirst({
      where: {
        item_name: matched,
        status: 'active',
        date_start: { lte: endDate },
        date_end: { gte: startDate },
      },
    });

    if (existing) {
      await this.prisma.inventory_contention.update({
        where: { id: existing.id },
        data: {
          favored_rental_id: favoredRental.id,
          held_rental_ids: heldRentals.map(r => r.id),
          favored_revenue: favoredRental.rental_price || 0,
          held_revenues: heldRentals.map(r => r.rental_price || 0),
        },
      });
      this.logger.log(`Updated contention ${existing.id} for ${matched}`);
    } else {
      const contention = await this.prisma.inventory_contention.create({
        data: {
          item_name: matched,
          date_start: startDate,
          date_end: endDate,
          favored_rental_id: favoredRental.id,
          held_rental_ids: heldRentals.map(r => r.id),
          favored_revenue: favoredRental.rental_price || 0,
          held_revenues: heldRentals.map(r => r.rental_price || 0),
          hold_message_sent_to: [],
        },
      });
      this.logger.log(`Created contention ${contention.id} for ${matched}: favored=${favoredRental.listing_id} (£${favoredRental.rental_price || 0}), held=${heldRentals.length} rental(s)`);

      // Notify Daniel
      await this.notifyContentionDetected(contention, favoredRental, heldRentals, matched, maxQty, confirmedBooked);

      // Log as ai_decision
      await this.prisma.ai_decision.create({
        data: {
          rental_id: favoredRental.id,
          decision_type: 'analyze',
          input_summary: `Inventory contention detected: ${matched} (${confirmedBooked + competingDemand}/${maxQty} demand)`,
          output_summary: `Favored: ${favoredRental.listing_id} (£${favoredRental.rental_price || 0}), Held: ${heldRentals.map(r => `${r.listing_id} (£${r.rental_price || 0})`).join(', ')}`,
          confidence: 1.0,
          action_taken: 'contention_hold',
        },
      });
    }
  }

  /**
   * Send hold message to a held rental's renter (one-time only).
   * Returns true if message was sent, false if already sent.
   */
  async sendHoldMessageIfNeeded(rentalId: string, contentionId: string): Promise<boolean> {
    const contention = await this.prisma.inventory_contention.findUnique({
      where: { id: contentionId },
    });
    if (!contention || contention.status !== 'active') return false;
    if (contention.hold_message_sent_to.includes(rentalId)) return false;

    const rental = await this.prisma.rental.findUnique({ where: { id: rentalId } });
    if (!rental) return false;

    const holdMsg = "Thanks for your interest! I'm just checking availability for those dates — I'll get back to you shortly.";
    await this.hyggloService.sendMessage(rental.listing_id, holdMsg);

    await this.prisma.inventory_contention.update({
      where: { id: contentionId },
      data: {
        hold_message_sent_to: { push: rentalId },
      },
    });

    this.logger.log(`Sent hold message to rental ${rental.listing_id} (contention ${contentionId})`);
    return true;
  }

  /**
   * Get active contentions where this rental is the favored one (for urgency injection).
   */
  async getActiveContentionsForRental(rentalId: string): Promise<any[]> {
    return this.prisma.inventory_contention.findMany({
      where: {
        status: 'active',
        favored_rental_id: rentalId,
      },
    });
  }

  /**
   * Resolve contention when a rental's booking is confirmed (order_step advancement).
   */
  async resolveByBooking(rentalId: string): Promise<void> {
    // Resolve contentions where this rental is the favored one
    const contentions = await this.prisma.inventory_contention.findMany({
      where: {
        status: 'active',
        favored_rental_id: rentalId,
      },
    });

    for (const c of contentions) {
      await this.resolveContention(c.id, 'resolved_booked', `Favored rental ${rentalId} booked`);
    }

    // Also re-evaluate contentions where this rental is held (it may have cancelled)
    const heldContentions = await this.prisma.inventory_contention.findMany({
      where: {
        status: 'active',
        held_rental_ids: { has: rentalId },
      },
    });

    for (const c of heldContentions) {
      // Remove this rental from held list
      const newHeld = c.held_rental_ids.filter(id => id !== rentalId);
      const idx = c.held_rental_ids.indexOf(rentalId);
      const newRevenues = c.held_revenues.filter((_, i) => i !== idx);

      if (newHeld.length === 0) {
        await this.resolveContention(c.id, 'resolved_cancelled', `Held rental ${rentalId} no longer competing`);
      } else {
        await this.prisma.inventory_contention.update({
          where: { id: c.id },
          data: { held_rental_ids: newHeld, held_revenues: newRevenues },
        });
      }
    }
  }

  /**
   * Urgency evaluation — called by follow-up cron every 2 min.
   * Sends urgency follow-ups to favored rentals.
   */
  async evaluateUrgency(): Promise<void> {
    const active = await this.prisma.inventory_contention.findMany({
      where: { status: 'active' },
    });

    const now = new Date();
    for (const c of active) {
      if (c.urgency_count >= 2) continue; // Max 2 urgency follow-ups

      const hoursSinceCreated = (now.getTime() - c.created_at.getTime()) / (1000 * 60 * 60);
      const hoursSinceLastUrgency = c.last_urgency_at
        ? (now.getTime() - c.last_urgency_at.getTime()) / (1000 * 60 * 60)
        : hoursSinceCreated;

      // First urgency: 4 hours after detection, Second: 4 hours after first
      const threshold = c.urgency_count === 0 ? 4 : 4;
      if (hoursSinceLastUrgency < threshold) continue;

      const rental = await this.prisma.rental.findUnique({
        where: { id: c.favored_rental_id },
      });
      if (!rental) continue;

      // Check if favored rental has had recent renter activity (skip if so — pipeline handles it)
      const recentActivity = await this.prisma.conversation.findFirst({
        where: {
          chat_id: rental.listing_id,
          role: 'user',
          created_at: { gt: new Date(now.getTime() - 4 * 60 * 60 * 1000) },
        },
      });
      if (recentActivity) continue; // Renter is active, pipeline will inject urgency

      // Send urgency follow-up
      const urgencyMsg = c.urgency_count === 0
        ? "Just a heads up — there's been a lot of interest in this gear for those dates. If you'd like to secure it, I'd recommend confirming soon!"
        : "Quick reminder — the dates you're looking at are in high demand. Let me know if you'd like to lock them in before they're gone!";

      await this.hyggloService.sendMessage(rental.listing_id, urgencyMsg);

      await this.prisma.inventory_contention.update({
        where: { id: c.id },
        data: {
          urgency_count: c.urgency_count + 1,
          last_urgency_at: now,
        },
      });

      this.logger.log(`Sent urgency follow-up #${c.urgency_count + 1} for contention ${c.id} (rental ${rental.listing_id})`);
    }
  }

  /**
   * Timeout check — called by follow-up cron every 2 min.
   * Resolves contentions where urgency is exhausted and enough time has passed.
   */
  async checkTimeouts(): Promise<void> {
    const now = new Date();
    const active = await this.prisma.inventory_contention.findMany({
      where: {
        status: 'active',
        urgency_count: { gte: 2 },
      },
    });

    for (const c of active) {
      if (!c.last_urgency_at) continue;
      const hoursSinceLastUrgency = (now.getTime() - c.last_urgency_at.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastUrgency < 6) continue;

      // Check if favored rental has advanced past REQUEST/APPROVED
      const rental = await this.prisma.rental.findUnique({ where: { id: c.favored_rental_id } });
      if (rental && rental.order_step && !['REQUEST', 'APPROVED'].includes(rental.order_step)) {
        // Actually booked — resolve as booked instead
        await this.resolveContention(c.id, 'resolved_booked', `Favored rental ${c.favored_rental_id} advanced to ${rental.order_step}`);
        continue;
      }

      // Timeout — favored rental didn't convert
      await this.resolveContention(c.id, 'resolved_timeout', `2 urgency follow-ups + 6h elapsed, order_step still ${rental?.order_step || 'unknown'}`);
    }
  }

  /**
   * Check if a rental's status change should trigger resolution.
   * Called from cascadeRentalStatusToBookings.
   */
  async onRentalStatusChange(rentalId: string, newStatus: string, orderStep?: string): Promise<void> {
    // If rental is cancelled/obsolete, resolve any contention
    if (['cancelled', 'obsolete'].includes(newStatus)) {
      await this.resolveByBooking(rentalId);
    }

    // If order_step advanced past REQUEST/APPROVED, resolve as booked
    if (orderStep && !['REQUEST', 'APPROVED'].includes(orderStep)) {
      const contentions = await this.prisma.inventory_contention.findMany({
        where: { status: 'active', favored_rental_id: rentalId },
      });
      for (const c of contentions) {
        await this.resolveContention(c.id, 'resolved_booked', `Order step advanced to ${orderStep}`);
      }
    }

    // Re-evaluate in case competition landscape changed
    await this.evaluateContention(rentalId);
  }

  private async resolveContention(contentionId: string, status: string, reason: string): Promise<void> {
    const contention = await this.prisma.inventory_contention.findUnique({
      where: { id: contentionId },
    });
    if (!contention || contention.status !== 'active') return;

    await this.prisma.inventory_contention.update({
      where: { id: contentionId },
      data: {
        status,
        resolution_reason: reason,
        resolved_at: new Date(),
      },
    });

    this.logger.log(`Resolved contention ${contentionId}: ${status} — ${reason}`);

    // Send release messages to held rentals (only for timeout/cancelled — not for booked)
    if (status === 'resolved_timeout' || status === 'resolved_cancelled') {
      for (const heldId of contention.held_rental_ids) {
        const heldRental = await this.prisma.rental.findUnique({ where: { id: heldId } });
        if (!heldRental) continue;

        // Check if rental is still alive
        const state = await this.prisma.follow_up_state.findUnique({
          where: { rental_id: heldId },
        });
        if (state && ['dead', 'completed'].includes(state.conversation_stage)) continue;

        const releaseMsg = `Great news — the ${contention.item_name} is available for your dates! Would you still like to go ahead?`;
        await this.hyggloService.sendMessage(heldRental.listing_id, releaseMsg);
        this.logger.log(`Sent release message to held rental ${heldRental.listing_id}`);
      }
    }

    // Notify Daniel
    await this.notifyContentionResolved(contention, status, reason);

    // Log as ai_decision
    await this.prisma.ai_decision.create({
      data: {
        rental_id: contention.favored_rental_id,
        decision_type: 'analyze',
        input_summary: `Contention resolved: ${contention.item_name} (${status})`,
        output_summary: reason,
        confidence: 1.0,
        action_taken: `contention_${status}`,
      },
    });
  }

  private async resolveIfNoLongerContended(itemName: string, startDate: Date, endDate: Date): Promise<void> {
    const existing = await this.prisma.inventory_contention.findFirst({
      where: {
        item_name: itemName,
        status: 'active',
        date_start: { lte: endDate },
        date_end: { gte: startDate },
      },
    });
    if (existing) {
      await this.resolveContention(existing.id, 'resolved_cancelled', 'Competition no longer exceeds supply');
    }
  }

  private async notifyContentionDetected(
    contention: any, favoredRental: any, heldRentals: any[],
    itemName: string, maxQty: number, confirmedBooked: number,
  ): Promise<void> {
    const heldLines = heldRentals.map(r =>
      `  "${r.title}" by ${r.renter_info || 'unknown'} | Stage: ${r.follow_up_state?.conversation_stage || '?'}\n  → Outbound paused`,
    ).join('\n\n');

    await this.telegramService.sendRentalUpdate(favoredRental.id, {
      type: 'contention_detected',
      priority: 'high',
      data: {
        itemName,
        maxQty,
        confirmedBooked,
        totalDemand: confirmedBooked + heldRentals.length + 1,
        favoredTitle: favoredRental.title,
        favoredRenter: favoredRental.renter_info || 'unknown',
        favoredRevenue: favoredRental.rental_price || 0,
        favoredStage: favoredRental.follow_up_state?.conversation_stage || '?',
        heldCount: heldRentals.length,
        heldSummary: heldLines,
        dateStart: contention.date_start,
        dateEnd: contention.date_end,
      },
    }, { rentalTitle: favoredRental.title, renterName: favoredRental.renter_info, account: favoredRental.account });
  }

  private async notifyContentionResolved(contention: any, status: string, reason: string): Promise<void> {
    const statusLabel = status === 'resolved_booked' ? 'BOOKED'
      : status === 'resolved_timeout' ? 'TIMEOUT'
      : 'CANCELLED';

    await this.telegramService.sendRentalUpdate(contention.favored_rental_id, {
      type: 'contention_resolved',
      priority: 'normal',
      data: {
        itemName: contention.item_name,
        statusLabel,
        reason,
        heldCount: contention.held_rental_ids.length,
        favoredRevenue: contention.favored_revenue,
        heldRevenues: contention.held_revenues,
      },
    }, {});
  }
}
