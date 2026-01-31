import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  async isBlacklisted(name: string): Promise<{ blacklisted: boolean; entry?: any }> {
    if (!name) return { blacklisted: false };

    const entry = await this.prisma.blacklisted_renter.findFirst({
      where: {
        OR: [
          { name: { contains: name.trim(), mode: 'insensitive' } },
          { name: { equals: name.trim(), mode: 'insensitive' } },
        ],
      },
    });

    return entry ? { blacklisted: true, entry } : { blacklisted: false };
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
