import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarService } from '../calendar/calendar.service';
import { TelegramService } from '../telegram/telegram.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { MASTER_INVENTORY, findBestMatch, getInventoryItemNames, FUNCTIONAL_EQUIVALENTS } from '../utils/item-matcher';

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

      // Get resolved items — photo_reference is most authoritative, then listing_title
      const seenItems = new Map<string, string>();
      for (const ei of rental.extracted_items) {
        const existing = seenItems.get(ei.item_name);
        if (!existing || ei.source === 'photo_reference') {
          seenItems.set(ei.item_name, ei.source);
        }
      }
      const titleItems = [...seenItems.keys()];
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

    // Guard: only contend on items actually requested in this rental's listing title.
    // Strip SEO keyword suffixes (after |, –, —) to get the core listing name.
    // Extract distinctive tokens from the matched item (non-brand, non-generic, len >= 3).
    // If any such tokens exist, at least one must appear in the core title.
    // This prevents false contentions from:
    //   - Bundle accessories (256GB card, batteries) not mentioned in the listing title
    //   - Marketing-keyword mismatches (JBL PARTYBOX 110 → JBL Club 120 speaker)
    const CONTENTION_BRANDS = new Set([
      'sony', 'canon', 'nikon', 'fuji', 'dji', 'rode', 'nanlite',
      'hollyland', 'atomos', 'jbl', 'sennheiser', 'anker', 'blackmagic', 'bmpcc', 'blazar',
    ]);
    const CONTENTION_GENERICS = new Set([
      'set', 'kit', 'and', 'with', 'for', 'the', 'all', 'new',
      'camera', 'lens', 'microphone', 'speaker', 'light', 'filter',
      'batteries', 'battery', 'tripod', 'gimbal', 'monitor', 'drone', 'card',
      'transmitter', 'receiver', 'wireless', 'mount', 'rig', 'slider', 'reflector',
      'system', 'production', 'professional', 'studio',
    ]);
    const coreTitle = (triggerRental.title || '').split(/[|–—]/)[0]
      .toLowerCase().replace(/[+&,×x]/g, ' ');
    const coreTitleWords = new Set(coreTitle.split(/\s+/).filter(Boolean));
    const matchedKeyTokens = matched.toLowerCase().split(/\s+/).filter(t =>
      t.length >= 3 && !CONTENTION_BRANDS.has(t) && !CONTENTION_GENERICS.has(t),
    );
    if (matchedKeyTokens.length > 0) {
      const titleRelevant = matchedKeyTokens.some(tok => {
        if (coreTitleWords.has(tok)) return true;
        for (const tw of coreTitleWords as Set<string>) {
          if (tw.length >= 3 && (tw.includes(tok) || tok.includes(tw)) &&
              Math.min(tok.length, tw.length) / Math.max(tok.length, tw.length) >= 0.8) return true;
        }
        return false;
      });
      if (!titleRelevant) {
        this.logger.debug(`Contention: skipping "${matched}" — tokens [${matchedKeyTokens.join(',')}] not in core title "${(triggerRental.title || '').substring(0, 60)}"`);
        return;
      }
    }

    const maxQty = MASTER_INVENTORY[matched] || 1;
    const startDate = triggerRental.start_date!;
    const endDate = triggerRental.end_date!;

    // Check already-confirmed bookings (exclude trigger rental's own bookings to avoid self-contention)
    const availability = await this.calendarService.checkAvailability(matched, startDate, endDate);
    const triggerOwnBookings = await this.prisma.booking.count({
      where: {
        rental_id: triggerRental.id,
        item_name: matched,
        status: 'confirmed',
        start_date: { lt: endDate },
        end_date: { gt: startDate },
      },
    });
    const confirmedBooked = Math.max(0, availability.booked - triggerOwnBookings);

    // Find ALL other active rentals wanting this item in overlapping dates
    const competitors = await this.prisma.rental.findMany({
      where: {
        id: { not: triggerRental.id },
        status: { in: ['pending'] }, // Exclude upcoming/ongoing � already counted by checkAvailability()
        start_date: { lt: endDate },
        end_date: { gt: startDate },
        extracted_items: {
          some: {
            item_name: matched,
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
    // Deduplicate by renter: same renter with multiple requests for the same item
    // counts as ONE demand unit. Keep the highest-revenue rental per renter.
    const allRaw = [triggerRental, ...aliveCompetitors];
    const byRenter = new Map<string, any>();
    for (const r of allRaw) {
      const renterKey = r.renter_info || r.id; // fallback to rental id if no renter_info
      const existing = byRenter.get(renterKey);
      if (!existing || (r.rental_price || 0) > (existing.rental_price || 0)) {
        byRenter.set(renterKey, r);
      }
    }
    const allCompeting = [...byRenter.values()];
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

    // Top non-confirmed rental → favored (gets urgency)
    const favoredRental = allCompeting.find(r => {
      // Don't favor already-confirmed rentals (they don't need urgency)
      const step = r.order_step;
      return !step || ['REQUEST', 'APPROVED'].includes(step);
    }) || allCompeting[0];

    // Bottom N by revenue → held (MUST exclude favored rental to prevent self-contention)
    const heldRentals = allCompeting
      .slice(allCompeting.length - holdCount)
      .filter(r => r.id !== favoredRental.id);

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
    // Never send hold message to the favored rental (self-contention guard)
    if (contention.favored_rental_id === rentalId) return false;

    const rental = await this.prisma.rental.findUnique({ where: { id: rentalId } });
    if (!rental) return false;

    // Check for available functional equivalents and offer them instead of a generic hold message
    let holdMsg: string;
    if (rental.start_date && rental.end_date) {
      const availableEquivalents = await this.findFunctionalEquivalents(
        contention.item_name, rental.start_date, rental.end_date,
      );
      if (availableEquivalents.length > 0) {
        const altList = availableEquivalents.join(' or ');
        holdMsg = `The ${contention.item_name} is in high demand for those dates — but I do have the ${altList} available, which works just as well. Would that work for you?`;
      } else {
        holdMsg = "Thanks for your interest! I'm just checking availability for those dates — I'll get back to you shortly.";
      }
    } else {
      holdMsg = "Thanks for your interest! I'm just checking availability for those dates — I'll get back to you shortly.";
    }

    await this.hyggloService.sendMessage(rental.listing_id, holdMsg); // respects READ_ONLY_MODE

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
   * Find available functional equivalents for a contended item.
   * Uses the FUNCTIONAL_EQUIVALENTS map (cross-brand where items serve the same purpose).
   */
  async findFunctionalEquivalents(itemName: string, startDate: Date, endDate: Date): Promise<string[]> {
    const equivalents = FUNCTIONAL_EQUIVALENTS[itemName] ?? [];
    const available: string[] = [];
    for (const equiv of equivalents) {
      const result = await this.calendarService.checkAvailability(equiv, startDate, endDate);
      if (result.available) {
        available.push(equiv);
      }
    }
    return available;
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
    const SILENCE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours

    for (const c of active) {
      // Check if favored rental has gone completely silent — auto-release held rentals
      if ((now.getTime() - c.created_at.getTime()) > SILENCE_THRESHOLD_MS) {
        const favoredRental = await this.prisma.rental.findUnique({ where: { id: c.favored_rental_id } });
        if (favoredRental) {
          const recentFavoredActivity = await this.prisma.conversation.findFirst({
            where: {
              chat_id: favoredRental.listing_id,
              role: 'user',
              created_at: { gt: new Date(now.getTime() - SILENCE_THRESHOLD_MS) },
            },
          });
          if (!recentFavoredActivity) {
            this.logger.log(`Contention ${c.id}: favored rental ${c.favored_rental_id} silent for 12h+ — auto-releasing held rentals`);
            await this.resolveContention(c.id, 'resolved_timeout', `Favored rental silent for 12h+`);
            continue;
          }
        }
      }

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

      // Check if follow-up service already sent a message recently (prevent double-tapping)
      const recentBotMsg = await this.prisma.conversation.findFirst({
        where: {
          chat_id: rental.listing_id,
          role: 'assistant',
          created_at: { gt: new Date(now.getTime() - 6 * 60 * 60 * 1000) },
        },
        orderBy: { created_at: 'desc' },
      });
      if (recentBotMsg) continue; // Bot already messaged recently, don't pile on

      // Build item name from rental title (first meaningful segment)
      const itemName = (rental.title || '').split(/[+|–—]/)[0].replace(/\d+x\s*/i, '').trim().substring(0, 60);

      // Send urgency follow-up — varied templates to avoid formulaic repetition
      const firstTemplates = [
        `Just a heads up — I've had another inquiry for the ${itemName} on those dates. Let me know if you'd like to go ahead and I'll hold it for you!`,
        `Wanted to flag — someone else is looking at the ${itemName} for similar dates. No pressure, just didn't want you to miss out if you're keen!`,
        `Quick one — there's interest building on the ${itemName} for your dates. Happy to lock it in for you if you'd like to secure it.`,
      ];
      const secondTemplates = [
        `Last check on the ${itemName} — I'll need to free it up soon if I don't hear back. Just send a quick message if you'd still like it!`,
        `Hey — just need to know if you're still keen on the ${itemName}. I've got someone else waiting so need to sort it today if possible.`,
      ];
      const templates = c.urgency_count === 0 ? firstTemplates : secondTemplates;
      const urgencyMsg = templates[Math.floor(Math.random() * templates.length)];

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
      if (hoursSinceLastUrgency < 4) continue; // was 6h — total max hold: 4+4+4=12h

      // Check if favored rental has advanced past REQUEST/APPROVED
      const rental = await this.prisma.rental.findUnique({ where: { id: c.favored_rental_id } });
      if (rental && rental.order_step && !['REQUEST', 'APPROVED'].includes(rental.order_step)) {
        // Actually booked — resolve as booked instead
        await this.resolveContention(c.id, 'resolved_booked', `Favored rental ${c.favored_rental_id} advanced to ${rental.order_step}`);
        continue;
      }

      // Timeout — favored rental didn't convert
      await this.resolveContention(c.id, 'resolved_timeout', `2 urgency follow-ups + 4h elapsed, order_step still ${rental?.order_step || 'unknown'}`);
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

    // If order_step advanced past REQUEST (including APPROVED), item is now committed by owner
    // APPROVED = owner has accepted, booking is confirmed in calendar — held rentals should be told
    if (orderStep && orderStep !== 'REQUEST') {
      const contentions = await this.prisma.inventory_contention.findMany({
        where: { status: 'active', favored_rental_id: rentalId },
      });
      for (const c of contentions) {
        await this.resolveContention(c.id, 'resolved_booked', `Order step advanced to ${orderStep}`);
      }

      // Also resolve contentions blocked by this approval consuming the last inventory unit
      await this.resolveContentionsBlockedByApproval(rentalId);
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

    // For resolved_booked: notify held rentals the item is taken, only if genuinely out of stock for their dates
    if (status === 'resolved_booked') {
      for (const heldId of contention.held_rental_ids) {
        const heldRental = await this.prisma.rental.findUnique({ where: { id: heldId } });
        if (!heldRental?.start_date || !heldRental?.end_date) continue;

        const state = await this.prisma.follow_up_state.findUnique({ where: { rental_id: heldId } });
        if (state && ['dead', 'completed'].includes(state.conversation_stage)) continue;

        // Only notify if genuinely out of stock for their specific dates
        const maxQty = MASTER_INVENTORY[contention.item_name] || 1;
        const availability = await this.calendarService.checkAvailability(
          contention.item_name, heldRental.start_date, heldRental.end_date,
        );
        if (availability.booked < maxQty) continue; // A unit freed up — no need to apologise

        // Find available alternatives of similar type
        const alternatives = await this.findAvailableAlternatives(
          contention.item_name, heldRental.start_date, heldRental.end_date,
        );

        let bookedMsg: string;
        if (alternatives.length > 0) {
          const altList = alternatives.map(a => `- ${a}`).join('\n');
          bookedMsg = `Hi! Unfortunately, the ${contention.item_name} has just been booked for those dates by another renter — sorry about that!\n\nIf you're still looking, I do have some alternatives available for those dates:\n${altList}\n\nHappy to help if any of those would work for you!`;
        } else {
          bookedMsg = `Hi! Unfortunately, the ${contention.item_name} has just been booked for those dates by another renter. I'm sorry I can't accommodate this one! If you need similar equipment for a different time or have other questions, feel free to get in touch.`;
        }

        await this.hyggloService.sendMessage(heldRental.listing_id, bookedMsg);
        this.logger.log(`Sent 'item booked' apology to held rental ${heldRental.listing_id} (contention ${contentionId})`);
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

  /**
   * When a rental becomes APPROVED (or later), check if it consumes the last inventory unit
   * for any item, and resolve any active contentions that are now blocked.
   */
  private async resolveContentionsBlockedByApproval(rentalId: string): Promise<void> {
    try {
      const rental = await this.prisma.rental.findUnique({
        where: { id: rentalId },
        include: { extracted_items: true },
      });
      if (!rental?.start_date || !rental?.end_date) return;

      const seenItems = new Set<string>();
      for (const ei of rental.extracted_items) {
        const matched = findBestMatch(ei.item_name, getInventoryItemNames());
        if (matched) seenItems.add(matched);
      }

      for (const matched of seenItems) {
        const maxQty = MASTER_INVENTORY[matched] || 1;
        const availability = await this.calendarService.checkAvailability(matched, rental.start_date, rental.end_date);
        if (availability.booked < maxQty) continue; // Still slots remaining

        // Item fully booked — find active contentions for overlapping dates not already resolved
        const blockedContentions = await this.prisma.inventory_contention.findMany({
          where: {
            item_name: matched,
            status: 'active',
            date_start: { lt: rental.end_date },
            date_end: { gt: rental.start_date },
            favored_rental_id: { not: rentalId },
          },
        });

        for (const c of blockedContentions) {
          await this.resolveContention(c.id, 'resolved_booked', `Item ${matched} fully booked by rental ${rentalId} (approved)`);
        }
      }
    } catch (err) {
      this.logger.error(`resolveContentionsBlockedByApproval failed for ${rentalId}: ${err.message}`);
    }
  }

  /**
   * Find available alternative items of the same brand/type for the given date range.
   * Returns up to 3 alternatives to suggest to a held renter whose item is now taken.
   */
  private async findAvailableAlternatives(itemName: string, startDate: Date, endDate: Date): Promise<string[]> {
    const firstWord = itemName.split(/\s+/)[0].toLowerCase(); // brand prefix (Sony, Nanlite, DJI, etc.)
    const alternatives: string[] = [];

    for (const candidateName of getInventoryItemNames()) {
      if (candidateName === itemName) continue;
      if (!candidateName.toLowerCase().startsWith(firstWord)) continue;

      const availability = await this.calendarService.checkAvailability(candidateName, startDate, endDate);
      if (availability.available) {
        alternatives.push(candidateName);
        if (alternatives.length >= 3) break;
      }
    }

    return alternatives;
  }

  private async notifyContentionDetected(
    contention: any, favoredRental: any, heldRentals: any[],
    itemName: string, maxQty: number, confirmedBooked: number,
  ): Promise<void> {
    // Clean item name: strip leading quantity digits (e.g. "Tilta Nucleus Nano 2 follow focus" → "Tilta Nucleus Nano follow focus")
    const cleanItemName = itemName.replace(/\s+\d+\s+/, ' ').replace(/\s+\d+$/, '').trim();

    const heldRentalData = heldRentals.map(r => ({
      renter: r.renter_info || 'Unknown',
      stage: r.follow_up_state?.conversation_stage || 'inquiry',
      revenue: r.rental_price || 0,
      account: r.account || '?',
      isSameRenter: (r.renter_info || '').toLowerCase() === (favoredRental.renter_info || '').toLowerCase(),
    }));

    await this.telegramService.sendRentalUpdate(favoredRental.id, {
      type: 'contention_detected',
      priority: 'high',
      data: {
        itemName: cleanItemName,
        maxQty,
        confirmedBooked,
        totalDemand: confirmedBooked + heldRentals.length + 1,
        favoredRenter: favoredRental.renter_info || 'Unknown',
        favoredRevenue: favoredRental.rental_price || 0,
        favoredStage: favoredRental.follow_up_state?.conversation_stage || 'inquiry',
        favoredAccount: favoredRental.account || '?',
        heldCount: heldRentals.length,
        heldRentalData,
        dateStart: contention.date_start,
        dateEnd: contention.date_end,
      },
    }, { rentalTitle: favoredRental.title, renterName: favoredRental.renter_info, account: favoredRental.account });
  }

  private async notifyContentionResolved(contention: any, status: string, reason: string): Promise<void> {
    // Clean item name
    const rawName = contention.item_name || 'Unknown item';
    const cleanItemName = rawName.replace(/\s+\d+\s+/, ' ').replace(/\s+\d+$/, '').trim();

    await this.telegramService.sendRentalUpdate(contention.favored_rental_id, {
      type: 'contention_resolved',
      priority: status === 'resolved_booked' ? 'high' : 'normal',
      data: {
        itemName: cleanItemName,
        status,
        heldCount: contention.held_rental_ids?.length || 0,
        favoredRevenue: contention.favored_revenue || 0,
      },
    }, {});
  }
}
