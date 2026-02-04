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
}
