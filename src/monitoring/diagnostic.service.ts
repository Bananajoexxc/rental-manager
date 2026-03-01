import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DiagnosticService {
  private readonly logger = new Logger(DiagnosticService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Log a diagnostic event to the database.
   * Fire-and-forget: never crashes the caller.
   */
  async log(
    category: string,
    eventType: string,
    summary: string,
    data: Record<string, any>,
    rentalId?: string,
  ): Promise<void> {
    try {
      await this.prisma.system_diagnostic.create({
        data: {
          category,
          event_type: eventType,
          summary,
          data: data as any,
          rental_id: rentalId || null,
        },
      });
    } catch (err) {
      // Diagnostic logging must never crash the caller
      this.logger.debug(`Diagnostic log failed: ${err.message}`);
    }
  }

  /** Auto-prune entries older than 90 days (daily at 3:15 AM) */
  @Cron('15 3 * * *')
  async pruneOldDiagnostics(): Promise<void> {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.system_diagnostic.deleteMany({
        where: { created_at: { lt: cutoff } },
      });
      if (count > 0) {
        this.logger.log(`Pruned ${count} diagnostic entries older than 90 days`);
      }
    } catch (err) {
      this.logger.warn(`Diagnostic prune failed: ${err.message}`);
    }
  }
}
