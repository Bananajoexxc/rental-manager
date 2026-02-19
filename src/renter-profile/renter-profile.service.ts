import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RenterProfileService {
  private readonly logger = new Logger(RenterProfileService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Determine loyalty tier based on total rentals.
   */
  getLoyaltyTier(totalRentals: number): { tier: string; discountPct: number } | null {
    // NOTE: discountPct is kept at 0 — Daniel's rules explicitly say "No loyalty discounts"
    // Tiers are for recognition/personalization only, NOT for offering discounts
    if (totalRentals >= 7) return { tier: 'Gold', discountPct: 0 };
    if (totalRentals >= 4) return { tier: 'Silver', discountPct: 0 };
    if (totalRentals >= 2) return { tier: 'Bronze', discountPct: 0 };
    return null;
  }

  /**
   * Find an existing renter profile or create a new one.
   * Deduplicates by hygglo_user_id first, then fuzzy name match.
   */
  async findOrCreateProfile(
    renterName: string,
    hyggloUserId?: string,
  ): Promise<{ id: string; isNew: boolean }> {
    // 1. Try exact match by hygglo_user_id
    if (hyggloUserId) {
      const byUserId = await this.prisma.renter_profile.findUnique({
        where: { hygglo_user_id: hyggloUserId },
      });
      if (byUserId) {
        // Name changed (e.g. Hygglo verification) — promote new name to primary, demote old to variant
        const nameVariants = byUserId.name_variants || [];
        if (
          renterName &&
          byUserId.name !== renterName
        ) {
          const updatedVariants = [...nameVariants];
          // Keep old primary as variant if not already there
          if (!updatedVariants.includes(byUserId.name)) {
            updatedVariants.push(byUserId.name);
          }
          // Remove new name from variants if it was there (it's now primary)
          const filtered = updatedVariants.filter(v => v !== renterName);
          await this.prisma.renter_profile.update({
            where: { id: byUserId.id },
            data: {
              name: renterName,
              name_variants: filtered,
              last_seen_at: new Date(),
            },
          });
          this.logger.log(`Renter name updated: "${byUserId.name}" → "${renterName}" (profile ${byUserId.id})`);
        } else {
          await this.prisma.renter_profile.update({
            where: { id: byUserId.id },
            data: { last_seen_at: new Date() },
          });
        }
        this.logger.debug(`Found renter profile by user ID: ${byUserId.name} (${byUserId.id})`);
        return { id: byUserId.id, isNew: false };
      }
    }

    // 2. Fuzzy name match - try exact name first
    if (renterName) {
      const byExactName = await this.prisma.renter_profile.findFirst({
        where: { name: renterName },
      });
      if (byExactName) {
        // Link hygglo_user_id if we have it and profile doesn't
        if (hyggloUserId && !byExactName.hygglo_user_id) {
          await this.prisma.renter_profile.update({
            where: { id: byExactName.id },
            data: { hygglo_user_id: hyggloUserId, last_seen_at: new Date() },
          });
        } else {
          await this.prisma.renter_profile.update({
            where: { id: byExactName.id },
            data: { last_seen_at: new Date() },
          });
        }
        this.logger.debug(`Found renter profile by exact name: ${byExactName.name} (${byExactName.id})`);
        return { id: byExactName.id, isNew: false };
      }

      // Try matching against name_variants
      const byVariant = await this.prisma.renter_profile.findFirst({
        where: { name_variants: { has: renterName } },
      });
      if (byVariant) {
        if (hyggloUserId && !byVariant.hygglo_user_id) {
          await this.prisma.renter_profile.update({
            where: { id: byVariant.id },
            data: { hygglo_user_id: hyggloUserId, last_seen_at: new Date() },
          });
        } else {
          await this.prisma.renter_profile.update({
            where: { id: byVariant.id },
            data: { last_seen_at: new Date() },
          });
        }
        this.logger.debug(`Found renter profile by name variant: ${byVariant.name} (${byVariant.id})`);
        return { id: byVariant.id, isNew: false };
      }

      // Try case-insensitive full name match (require BOTH first AND last name)
      const nameParts = renterName.trim().split(/\s+/);
      if (nameParts.length >= 2) {
        const firstName = nameParts[0];
        const lastName = nameParts[nameParts.length - 1];
        // Query profiles where name contains BOTH first and last name parts
        const candidates = await this.prisma.renter_profile.findMany({
          where: {
            name: { contains: firstName, mode: 'insensitive' },
          },
        });
        const byFuzzy = candidates.find((profile) => {
          const profileParts = profile.name.trim().split(/\s+/);
          const profileFirst = profileParts[0]?.toLowerCase();
          const profileLast = profileParts[profileParts.length - 1]?.toLowerCase();
          return (
            profileFirst === firstName.toLowerCase() &&
            profileLast === lastName.toLowerCase()
          );
        });
        if (byFuzzy) {
          const variants = byFuzzy.name_variants || [];
          if (!variants.includes(renterName)) {
            await this.prisma.renter_profile.update({
              where: { id: byFuzzy.id },
              data: {
                name_variants: [...variants, renterName],
                hygglo_user_id: hyggloUserId || byFuzzy.hygglo_user_id,
                last_seen_at: new Date(),
              },
            });
          }
          this.logger.debug(`Found renter profile by full name match: ${byFuzzy.name} (${byFuzzy.id})`);
          return { id: byFuzzy.id, isNew: false };
        }
      }
    }

    // 3. Create new profile
    const profile = await this.prisma.renter_profile.create({
      data: {
        name: renterName || 'Unknown',
        hygglo_user_id: hyggloUserId || null,
        name_variants: [],
        verification_status: 'unknown',
        total_rentals: 0,
      },
    });

    this.logger.log(`Created new renter profile: ${profile.name} (${profile.id})`);
    return { id: profile.id, isNew: true };
  }

  /**
   * Create a junction record linking a rental to a renter profile.
   */
  async linkRentalToProfile(rentalId: string, profileId: string): Promise<void> {
    try {
      // Check if link already exists — avoid double-incrementing total_rentals
      const existing = await this.prisma.rental_renter_link.findUnique({
        where: {
          rental_id_renter_profile_id: {
            rental_id: rentalId,
            renter_profile_id: profileId,
          },
        },
      });
      if (existing) return; // Already linked, skip

      await this.prisma.rental_renter_link.create({
        data: {
          rental_id: rentalId,
          renter_profile_id: profileId,
        },
      });

      // Get rental price to track total spend
      const rental = await this.prisma.rental.findUnique({
        where: { id: rentalId },
        select: { rental_price: true },
      });
      const rentalPrice = rental?.rental_price || 0;

      // Increment total_rentals and total_spend on the profile
      await this.prisma.renter_profile.update({
        where: { id: profileId },
        data: {
          total_rentals: { increment: 1 },
          ...(rentalPrice > 0 ? { total_spend: { increment: rentalPrice } } : {}),
        },
      });
    } catch (error) {
      // Ignore if already linked
      if (!error.message?.includes('Unique constraint')) {
        this.logger.warn(`Failed to link rental ${rentalId} to profile ${profileId}: ${error.message}`);
      }
    }
  }

  /**
   * Check if a renter is returning (has previous CONFIRMED rentals).
   * Only counts rentals that actually happened (upcoming/ongoing/completed),
   * not pending requests, rejections, or cancellations.
   */
  async isReturningRenter(renterName: string, currentRentalId: string): Promise<{
    isReturning: boolean;
    previousRentalCount: number;
    profileId?: string;
  }> {
    // Find profile by hygglo_user_id first (most reliable), then name
    const profile = await this.prisma.renter_profile.findFirst({
      where: {
        OR: [
          { name: renterName },
          { name_variants: { has: renterName } },
        ],
      },
      include: {
        renter_links: {
          include: { rental: { select: { id: true, status: true } } },
        },
      },
    });

    if (!profile) {
      return { isReturning: false, previousRentalCount: 0 };
    }

    // Only count COMPLETED rentals — upcoming/ongoing/confirmed don't count.
    // A renter is only "returning" if they've actually completed a rental before.
    // Unbooked requests, pending, cancelled, etc. do NOT qualify.
    const previousCompleted = profile.renter_links.filter(
      (link) =>
        link.rental_id !== currentRentalId &&
        (link.rental?.status || '').toLowerCase().includes('completed'),
    );

    return {
      isReturning: previousCompleted.length > 0,
      previousRentalCount: previousCompleted.length,
      profileId: profile.id,
    };
  }

  /**
   * Get active (upcoming/ongoing/confirmed) rentals for a profile, excluding a specific rental.
   * Used for detecting additions/extensions when a returning renter sends a new request.
   */
  /**
   * Get pending/upcoming rentals for a profile — used for cross-scan consolidation.
   * Returns rentals that are still pending or upcoming (not yet completed/cancelled/consolidated).
   */
  async getPendingRentalsForProfile(profileId: string, excludeRentalId: string): Promise<{
    id: string;
    title: string;
    status: string;
    listing_id: string;
    start_date: Date | null;
    end_date: Date | null;
    rental_price: number | null;
    account: string | null;
  }[]> {
    const PENDING_STATUSES = ['pending', 'pending_review', 'upcoming'];

    const profile = await this.prisma.renter_profile.findUnique({
      where: { id: profileId },
      include: {
        renter_links: {
          include: {
            rental: {
              select: {
                id: true,
                title: true,
                status: true,
                listing_id: true,
                start_date: true,
                end_date: true,
                rental_price: true,
                account: true,
              },
            },
          },
        },
      },
    });

    if (!profile) return [];

    return profile.renter_links
      .filter(
        (link) =>
          link.rental_id !== excludeRentalId &&
          PENDING_STATUSES.some(s => (link.rental?.status || '').toLowerCase().includes(s)),
      )
      .map((link) => link.rental)
      .filter(Boolean) as any[];
  }

  async getActiveRentalsForProfile(profileId: string, excludeRentalId: string): Promise<{
    id: string;
    title: string;
    status: string;
    start_date: Date | null;
    end_date: Date | null;
    listing_url: string;
    account: string | null;
  }[]> {
    const ACTIVE_STATUSES = ['upcoming', 'ongoing', 'confirmed'];

    const profile = await this.prisma.renter_profile.findUnique({
      where: { id: profileId },
      include: {
        renter_links: {
          include: {
            rental: {
              select: {
                id: true,
                title: true,
                status: true,
                start_date: true,
                end_date: true,
                listing_url: true,
                account: true,
              },
            },
          },
        },
      },
    });

    if (!profile) return [];

    return profile.renter_links
      .filter(
        (link) =>
          link.rental_id !== excludeRentalId &&
          ACTIVE_STATUSES.some(s => (link.rental?.status || '').toLowerCase().includes(s)),
      )
      .map((link) => link.rental)
      .filter(Boolean) as any[];
  }

  /**
   * Check if verification guidance has been sent for this profile.
   */
  async hasBeenSentVerificationGuidance(profileId: string): Promise<boolean> {
    const profile = await this.prisma.renter_profile.findUnique({
      where: { id: profileId },
      select: { verification_guided: true },
    });
    return profile?.verification_guided ?? false;
  }

  /**
   * Mark that verification guidance has been sent.
   */
  async markVerificationGuidanceSent(profileId: string): Promise<void> {
    await this.prisma.renter_profile.update({
      where: { id: profileId },
      data: { verification_guided: true },
    });
  }

  /**
   * Increment verification attempt counter and return new count.
   */
  async incrementVerificationAttempts(profileId: string): Promise<number> {
    const updated = await this.prisma.renter_profile.update({
      where: { id: profileId },
      data: { verification_attempts: { increment: 1 } },
    });
    return updated.verification_attempts;
  }

  /**
   * Update verification status on a profile.
   */
  async updateVerificationStatus(
    profileId: string,
    status: 'unknown' | 'pending' | 'verified' | 'failed',
  ): Promise<void> {
    await this.prisma.renter_profile.update({
      where: { id: profileId },
      data: { verification_status: status },
    });
  }

  /**
   * Check if verification failure guidance has been sent.
   */
  async hasBeenSentVerificationFailureGuidance(profileId: string): Promise<boolean> {
    const profile = await this.prisma.renter_profile.findUnique({
      where: { id: profileId },
      select: { verification_failure_guided: true },
    });
    return profile?.verification_failure_guided ?? false;
  }

  /**
   * Mark that verification failure guidance has been sent.
   */
  async markVerificationFailureGuidanceSent(profileId: string): Promise<void> {
    await this.prisma.renter_profile.update({
      where: { id: profileId },
      data: { verification_failure_guided: true },
    });
  }

  /**
   * Get a renter profile by ID.
   */
  async getProfile(profileId: string) {
    return this.prisma.renter_profile.findUnique({
      where: { id: profileId },
    });
  }

  /**
   * Find a renter profile linked to a rental.
   */
  async getProfileForRental(rentalId: string) {
    const link = await this.prisma.rental_renter_link.findFirst({
      where: { rental_id: rentalId },
      include: { renter_profile: true },
    });
    return link?.renter_profile ?? null;
  }

  /**
   * Build a comprehensive renter context string for AI prompts.
   * Pulls together: profile data, booking history across all linked rentals,
   * items previously requested, progress on the current request, and any
   * previous agreements that should carry over after cancellations/re-requests.
   */
  async buildRenterContext(profileId: string, currentRentalId: string): Promise<string> {
    const profile = await this.prisma.renter_profile.findUnique({
      where: { id: profileId },
      include: {
        renter_links: {
          include: {
            rental: {
              include: {
                bookings: { where: { status: { not: 'cancelled' } } },
                extracted_items: true,
              },
            },
          },
          orderBy: { created_at: 'desc' },
        },
      },
    });

    if (!profile) return '';

    // Count only COMPLETED rentals for loyalty — not just linked/requested
    const completedRentals = profile.renter_links.filter(
      (link) => link.rental_id !== currentRentalId &&
        (link.rental?.status || '').toLowerCase().includes('completed'),
    );
    const completedCount = completedRentals.length;

    const parts: string[] = [];
    parts.push(`--- RENTER PROFILE: ${profile.name} ---`);
    parts.push(`Completed rentals: ${completedCount}`);
    parts.push(`First seen: ${profile.first_seen_at.toISOString().split('T')[0]}`);

    // Loyalty tier — based on completed rentals only
    const loyalty = this.getLoyaltyTier(completedCount);
    if (loyalty) {
      parts.push(`Loyalty tier: ${loyalty.tier} (valued returning customer)`);
      parts.push(`Total spend: £${Math.round(profile.total_spend)}`);
      parts.push(`RETURNING CUSTOMER: Acknowledge their loyalty naturally ("Welcome back!" or "Good to see you again"). There IS a returning renter discount but do NOT mention it unless the renter specifically asks about discounts or returning renter pricing.`);
    }

    if (profile.verification_status !== 'unknown') {
      parts.push(`Verification: ${profile.verification_status}`);
    }

    if (profile.items_interested.length > 0) {
      parts.push(`Items previously interested in: ${profile.items_interested.join(', ')}`);
    }

    if (profile.rental_progress) {
      parts.push(`Current request progress: ${profile.rental_progress}`);
    }

    if (profile.previous_agreements) {
      parts.push(`Previous agreements (carry forward): ${profile.previous_agreements}`);
    }

    if (profile.last_inquiry_summary) {
      parts.push(`Last inquiry: ${profile.last_inquiry_summary}`);
    }

    // Build history from all linked rentals (excluding current)
    const previousRentals = profile.renter_links.filter(
      (link) => link.rental_id !== currentRentalId,
    );

    if (previousRentals.length > 0) {
      parts.push('');
      parts.push('RENTAL HISTORY:');

      for (const link of previousRentals.slice(0, 5)) {
        const r = link.rental;
        const dateRange = r.start_date && r.end_date
          ? `${r.start_date.toISOString().split('T')[0]} to ${r.end_date.toISOString().split('T')[0]}`
          : 'dates unknown';
        const items = r.extracted_items.map((ei) => ei.item_name).join(', ');
        const price = r.rental_price ? ` £${r.rental_price}` : '';

        parts.push(`- ${r.title} (${r.status}) ${dateRange}${price}${items ? ` [items: ${items}]` : ''}`);
      }
    }

    // Current rental bookings & items
    const currentLink = profile.renter_links.find(
      (link) => link.rental_id === currentRentalId,
    );
    if (currentLink) {
      const r = currentLink.rental;
      const bookings = r.bookings || [];
      const items = r.extracted_items || [];

      if (bookings.length > 0 || items.length > 0) {
        parts.push('');
        parts.push('CURRENT REQUEST:');
        if (items.length > 0) {
          parts.push(`Items: ${items.map((i) => i.item_name).join(', ')}`);
        }
        for (const b of bookings) {
          const dates = `${b.start_date.toISOString().split('T')[0]} to ${b.end_date.toISOString().split('T')[0]}`;
          const times = [
            b.pickup_time ? `pickup ${b.pickup_time}` : '',
            b.return_time ? `return ${b.return_time}` : '',
          ].filter(Boolean).join(', ');
          parts.push(`- Booking: ${b.item_name} x${b.quantity} (${dates})${times ? ` [${times}]` : ''} status=${b.status}`);
        }
      }
    }

    parts.push('---');
    return parts.join('\n');
  }

  /**
   * Update the progress snapshot on the renter profile.
   * Called after every AI interaction so the bot always knows where things stand.
   */
  async updateProgress(
    profileId: string,
    updates: {
      rental_progress?: string;
      last_inquiry_summary?: string;
      items_interested?: string[];
    },
  ): Promise<void> {
    const data: any = { last_seen_at: new Date() };

    if (updates.rental_progress !== undefined) {
      data.rental_progress = updates.rental_progress;
    }
    if (updates.last_inquiry_summary !== undefined) {
      data.last_inquiry_summary = updates.last_inquiry_summary;
    }
    if (updates.items_interested !== undefined && updates.items_interested.length > 0) {
      // Merge with existing items, deduplicate
      const profile = await this.prisma.renter_profile.findUnique({
        where: { id: profileId },
        select: { items_interested: true },
      });
      const existing = profile?.items_interested || [];
      const merged = [...new Set([...existing, ...updates.items_interested])];
      data.items_interested = merged;
    }

    await this.prisma.renter_profile.update({
      where: { id: profileId },
      data,
    });
  }

  /**
   * Snapshot the current rental's agreements into previous_agreements.
   * Called when a rental is cancelled or completed, so that if the same renter
   * sends a new request, the bot can skip re-asking everything and jump
   * straight to reconfirming and accepting.
   */
  async snapshotAgreements(profileId: string, rentalId: string): Promise<void> {
    // Build the snapshot from the rental's bookings, chat, and extracted items
    const rental = await this.prisma.rental.findUnique({
      where: { id: rentalId },
      include: {
        bookings: { where: { status: { not: 'cancelled' } } },
        extracted_items: true,
      },
    });

    if (!rental) return;

    const parts: string[] = [];
    parts.push(`Previously agreed rental: ${rental.title}`);

    if (rental.start_date && rental.end_date) {
      parts.push(`Dates: ${rental.start_date.toISOString().split('T')[0]} to ${rental.end_date.toISOString().split('T')[0]}`);
    }
    if (rental.rental_price) {
      parts.push(`Price: £${rental.rental_price}`);
    }

    const items = rental.extracted_items.map((i) => i.item_name);
    if (items.length > 0) {
      parts.push(`Items: ${items.join(', ')}`);
    }

    for (const b of rental.bookings) {
      const times = [
        b.pickup_time ? `pickup ${b.pickup_time}` : '',
        b.return_time ? `return ${b.return_time}` : '',
      ].filter(Boolean).join(', ');
      if (times) {
        parts.push(`Times: ${times}`);
        break; // Just need the first booking's times
      }
    }

    // Read last few chat messages for any final agreements
    const lastMessages = await this.prisma.conversation.findMany({
      where: { chat_id: `rental:${rentalId}` },
      orderBy: { created_at: 'desc' },
      take: 5,
      select: { role: true, content: true },
    });

    if (lastMessages.length > 0) {
      parts.push(`Last conversation state: ${lastMessages.reverse().map((m) => `${m.role}: ${m.content.substring(0, 80)}`).join(' | ')}`);
    }

    const snapshot = parts.join('. ');

    await this.prisma.renter_profile.update({
      where: { id: profileId },
      data: { previous_agreements: snapshot },
    });

    this.logger.log(`Snapshotted agreements for profile ${profileId}: ${snapshot.substring(0, 100)}...`);
  }
}
