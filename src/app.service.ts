import { Injectable } from '@nestjs/common';
import { RentalScannerService } from './rental-scanner/rental-scanner.service';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(
    private rentalScannerService: RentalScannerService,
    private prisma: PrismaService,
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

  async getRentalStats() {
    const total = await this.prisma.rental.count();
    const ongoing = await this.prisma.rental.count({
      where: { status: 'ongoing' },
    });
    const upcoming = await this.prisma.rental.count({
      where: { status: 'upcoming' },
    });

    return {
      total,
      ongoing,
      upcoming,
    };
  }

  async getRecentRentals(limit: number = 10) {
    return await this.prisma.rental.findMany({
      take: limit,
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

  async getRecentItems(limit: number = 20) {
    return await this.prisma.extracteditem.findMany({
      take: limit,
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
}
