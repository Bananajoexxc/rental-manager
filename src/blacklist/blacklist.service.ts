import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Polite decline messages for blacklisted renters.
 * These NEVER mention blacklisting — the renter just hears a generic decline.
 */
const POLITE_DECLINES = [
  `Hi! Thanks for reaching out. Unfortunately we're not able to accommodate this rental at the moment. We wish you all the best!`,
  `Hey! Appreciate the interest. We're unable to take this one on right now. Good luck with your search!`,
  `Hi there! Thanks for getting in touch. Unfortunately this one won't work out on our end. Hope you find what you're looking for!`,
];

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);

  constructor(private prisma: PrismaService) {}

  async addToBlacklist(name: string, reason: string, addedBy = 'owner') {
    const normalized = name.trim();
    const existing = await this.prisma.blacklisted_renter.findFirst({
      where: { name: { equals: normalized, mode: 'insensitive' } },
    });

    if (existing) {
      return this.prisma.blacklisted_renter.update({
        where: { id: existing.id },
        data: { reason, added_by: addedBy },
      });
    }

    const entry = await this.prisma.blacklisted_renter.create({
      data: { name: normalized, reason, added_by: addedBy },
    });

    this.logger.log(`Blacklisted renter: ${normalized} (${reason})`);
    return entry;
  }

  async removeFromBlacklist(name: string) {
    const entry = await this.prisma.blacklisted_renter.findFirst({
      where: { name: { contains: name.trim(), mode: 'insensitive' } },
    });

    if (!entry) return null;

    await this.prisma.blacklisted_renter.delete({ where: { id: entry.id } });
    this.logger.log(`Removed from blacklist: ${entry.name}`);
    return entry;
  }

  /**
   * Check if a renter is blacklisted by name.
   * Also cross-references renter profiles to catch name variants.
   */
  async isBlacklisted(name: string): Promise<{ blacklisted: boolean; entry?: any }> {
    if (!name) return { blacklisted: false };

    const trimmed = name.trim();

    // Direct blacklist check
    const entry = await this.prisma.blacklisted_renter.findFirst({
      where: {
        OR: [
          { name: { contains: trimmed, mode: 'insensitive' } },
          { name: { equals: trimmed, mode: 'insensitive' } },
        ],
      },
    });

    if (entry) return { blacklisted: true, entry };

    // Cross-reference via renter profiles: check if any name variant is blacklisted
    const profile = await this.prisma.renter_profile.findFirst({
      where: {
        OR: [
          { name: { equals: trimmed, mode: 'insensitive' } },
          { name_variants: { has: trimmed } },
        ],
      },
    });

    if (profile) {
      // Check all known names for this profile against the blacklist
      const allNames = [profile.name, ...profile.name_variants];
      for (const variant of allNames) {
        const variantEntry = await this.prisma.blacklisted_renter.findFirst({
          where: {
            OR: [
              { name: { equals: variant, mode: 'insensitive' } },
              { name: { contains: variant, mode: 'insensitive' } },
            ],
          },
        });
        if (variantEntry) return { blacklisted: true, entry: variantEntry };
      }
    }

    return { blacklisted: false };
  }

  /**
   * Check if a renter on a specific rental is blacklisted.
   * Uses the rental's linked renter profile for thorough cross-referencing.
   */
  async isBlacklistedByRental(rentalId: string): Promise<{ blacklisted: boolean; entry?: any }> {
    const rental = await this.prisma.rental.findUnique({
      where: { id: rentalId },
      select: { renter_info: true },
    });

    if (!rental?.renter_info) return { blacklisted: false };

    // Check by name first
    const byName = await this.isBlacklisted(rental.renter_info);
    if (byName.blacklisted) return byName;

    // Also check via linked renter profile (catches Hygglo user ID matches)
    const link = await this.prisma.rental_renter_link.findFirst({
      where: { rental_id: rentalId },
      include: { renter_profile: true },
    });

    if (link?.renter_profile) {
      const allNames = [link.renter_profile.name, ...link.renter_profile.name_variants];
      for (const variant of allNames) {
        const entry = await this.prisma.blacklisted_renter.findFirst({
          where: {
            OR: [
              { name: { equals: variant, mode: 'insensitive' } },
              { name: { contains: variant, mode: 'insensitive' } },
            ],
          },
        });
        if (entry) return { blacklisted: true, entry };
      }
    }

    return { blacklisted: false };
  }

  /**
   * Get a polite decline message that does NOT mention blacklisting.
   */
  getPoliteDecline(): string {
    return POLITE_DECLINES[Math.floor(Math.random() * POLITE_DECLINES.length)];
  }

  async getAll() {
    return this.prisma.blacklisted_renter.findMany({
      orderBy: { created_at: 'desc' },
    });
  }

  async getFormattedBlacklist(): Promise<string> {
    const entries = await this.getAll();
    if (entries.length === 0) return '';

    return (
      'BLACKLISTED RENTERS (never rent to these people):\n' +
      entries.map((e) => `- ${e.name}: ${e.reason}`).join('\n')
    );
  }
}
