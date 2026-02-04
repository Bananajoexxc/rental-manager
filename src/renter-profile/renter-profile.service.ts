import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RenterProfileService {
  private readonly logger = new Logger(RenterProfileService.name);

  constructor(private prisma: PrismaService) {}

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
        // Update name if different, add variant
        const nameVariants = byUserId.name_variants || [];
        if (
          renterName &&
          byUserId.name !== renterName &&
          !nameVariants.includes(renterName)
        ) {
          await this.prisma.renter_profile.update({
            where: { id: byUserId.id },
            data: {
              name_variants: [...nameVariants, renterName],
              last_seen_at: new Date(),
            },
          });
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

      // Try case-insensitive partial match (first name + last name)
      const nameParts = renterName.trim().split(/\s+/);
      if (nameParts.length >= 2) {
        const byFuzzy = await this.prisma.renter_profile.findFirst({
          where: {
            OR: [
              { name: { contains: nameParts[0], mode: 'insensitive' } },
              { name_variants: { has: nameParts[0] } },
            ],
          },
        });
        if (byFuzzy) {
          // Only match if last name also matches (to avoid false positives)
          const lastName = nameParts[nameParts.length - 1].toLowerCase();
          const profileLastName = byFuzzy.name.split(/\s+/).pop()?.toLowerCase();
          if (profileLastName === lastName) {
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
            this.logger.debug(`Found renter profile by fuzzy name match: ${byFuzzy.name} (${byFuzzy.id})`);
            return { id: byFuzzy.id, isNew: false };
          }
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
      await this.prisma.rental_renter_link.upsert({
        where: {
          rental_id_renter_profile_id: {
            rental_id: rentalId,
            renter_profile_id: profileId,
          },
        },
        create: {
          rental_id: rentalId,
          renter_profile_id: profileId,
        },
        update: {},
      });

      // Increment total_rentals on the profile
      await this.prisma.renter_profile.update({
        where: { id: profileId },
        data: { total_rentals: { increment: 1 } },
      });
    } catch (error) {
      // Ignore if already linked
      if (!error.message?.includes('Unique constraint')) {
        this.logger.warn(`Failed to link rental ${rentalId} to profile ${profileId}: ${error.message}`);
      }
    }
  }

  /**
   * Check if a renter is returning (has previous rentals).
   */
  async isReturningRenter(renterName: string, currentRentalId: string): Promise<{
    isReturning: boolean;
    previousRentalCount: number;
    profileId?: string;
  }> {
    // Find profile
    const profile = await this.prisma.renter_profile.findFirst({
      where: {
        OR: [
          { name: renterName },
          { name_variants: { has: renterName } },
        ],
      },
      include: {
        renter_links: {
          include: { rental: true },
        },
      },
    });

    if (!profile) {
      return { isReturning: false, previousRentalCount: 0 };
    }

    // Count previous rentals (excluding current)
    const previousRentals = profile.renter_links.filter(
      (link) => link.rental_id !== currentRentalId,
    );

    return {
      isReturning: previousRentals.length > 0,
      previousRentalCount: previousRentals.length,
      profileId: profile.id,
    };
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

    const parts: string[] = [];
    parts.push(`--- RENTER PROFILE: ${profile.name} ---`);
    parts.push(`Total rentals: ${profile.total_rentals}`);
    parts.push(`First seen: ${profile.first_seen_at.toISOString().split('T')[0]}`);

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
