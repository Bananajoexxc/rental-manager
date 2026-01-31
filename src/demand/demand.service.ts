import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DemandService {
  private readonly logger = new Logger(DemandService.name);

  constructor(private prisma: PrismaService) {}

  async recordDemand(data: {
    items: string[];
    bundle_label?: string;
    dates_start?: Date;
    dates_end?: Date;
    renter_name?: string;
    account?: string;
    outcome?: string;
    rejection_reason?: string;
    rental_value?: number;
    source?: string;
  }) {
    return this.prisma.demand_record.create({ data });
  }

  async getTopRequestedItems(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const records = await this.prisma.demand_record.findMany({
      where: { created_at: { gte: since } },
      select: { items: true },
    });

    const counts: Record<string, number> = {};
    for (const r of records) {
      for (const item of r.items) {
        counts[item] = (counts[item] || 0) + 1;
      }
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
  }

  async getPopularBundles(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const records = await this.prisma.demand_record.findMany({
      where: {
        created_at: { gte: since },
        bundle_label: { not: null },
      },
      select: { bundle_label: true },
    });

    const counts: Record<string, number> = {};
    for (const r of records) {
      if (r.bundle_label) {
        counts[r.bundle_label] = (counts[r.bundle_label] || 0) + 1;
      }
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }

  async getConversionRate(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const total = await this.prisma.demand_record.count({
      where: { created_at: { gte: since } },
    });

    const accepted = await this.prisma.demand_record.count({
      where: { created_at: { gte: since }, outcome: 'accepted' },
    });

    return {
      total,
      accepted,
      rate: total > 0 ? Math.round((accepted / total) * 100) : 0,
    };
  }

  async getFormattedDemandReport(days = 30): Promise<string> {
    const [topItems, bundles, conversion] = await Promise.all([
      this.getTopRequestedItems(days),
      this.getPopularBundles(days),
      this.getConversionRate(days),
    ]);

    const lines: string[] = [`Demand Report (last ${days} days):`];

    lines.push(`\nConversion: ${conversion.accepted}/${conversion.total} (${conversion.rate}%)`);

    if (topItems.length > 0) {
      lines.push('\nTop Requested Items:');
      for (const [item, count] of topItems) {
        lines.push(`  ${count}x ${item}`);
      }
    }

    if (bundles.length > 0) {
      lines.push('\nPopular Bundles:');
      for (const [bundle, count] of bundles) {
        lines.push(`  ${count}x ${bundle}`);
      }
    }

    return lines.join('\n');
  }
}
