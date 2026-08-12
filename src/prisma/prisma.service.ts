import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly moduleRef: ModuleRef) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('✅ Database connected successfully');

    // Centralized "booking confirmed" notification hook. Every code path that flips
    // booking.status to 'confirmed' (createBooking, createBookingsFromRental,
    // reconcileRecentBookings, syncBookingsWithExtractedItems, resyncFromParsedItems)
    // now reliably triggers the Woohoo Telegram notification from one place, instead
    // of relying on each call site to remember to notify.
    this.$use(async (params, next) => {
      // NOTE: prisma/schema.prisma declares this model as lowercase `booking`
      // (`model booking { ... }`), so params.model is 'booking' here, not 'Booking'
      // — verified empirically against the live generated client.
      if (params.model !== 'booking' || (params.action !== 'create' && params.action !== 'update')) {
        return next(params);
      }

      let oldStatus: string | undefined;
      if (params.action === 'update' && params.args?.data?.status !== undefined) {
        try {
          const existing = await this.booking.findUnique({
            where: params.args.where,
            select: { status: true },
          });
          oldStatus = existing?.status;
        } catch {
          // non-critical — pre-read failure just means we can't tell the old status;
          // fall through and let next() run as normal.
        }
      }

      const result = await next(params);

      // Only treat this as a genuine confirm event if this write actually touched
      // `status` (or is a create). An update that doesn't touch `status` at all —
      // e.g. a rescan/reconcile pass re-saving other fields on an already-confirmed
      // booking — must never re-fire the notification just because `oldStatus`
      // couldn't be determined; that was the cause of duplicate "Woohoo" pings on
      // every rescan.
      const statusFieldTouched =
        params.action === 'create' || params.args?.data?.status !== undefined;
      const becameConfirmed =
        statusFieldTouched &&
        result?.status === 'confirmed' &&
        (params.action === 'create' || oldStatus !== 'confirmed');

      if (becameConfirmed) {
        // Never block or fail the actual DB write on notification plumbing.
        setImmediate(() => {
          this.handleBookingConfirmed(result).catch((err) =>
            this.logger.warn('Booking notification failed: ' + err.message),
          );
        });
      }

      return result;
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('🔌 Database disconnected');
  }

  /**
   * Fires the centralized "booking confirmed" Telegram notification.
   *
   * ConfigManagerService and TelegramService are resolved lazily via ModuleRef +
   * dynamic import() rather than static top-level imports. Both of those services
   * import PrismaService directly (ConfigManagerService takes it in its constructor;
   * TelegramService does too), so a static `import { TelegramService } from
   * '../telegram/telegram.service'` at the top of this file creates a genuine
   * circular module dependency: when this file is required, the require() for
   * telegram.service.ts (and transitively config-manager.service.ts) would run
   * BEFORE the `PrismaService` class declaration below is reached and exported,
   * so those files' `constructor(private prisma: PrismaService)` decorator
   * metadata would capture `undefined` for the PrismaService param type, and
   * Nest's DI would fail to resolve PrismaService when constructing them
   * ("Nest can't resolve dependencies..."). This was confirmed by tracing the
   * require order rather than by hitting the error directly.
   *
   * Dynamic import() defers module resolution until this method actually runs —
   * always well after full Nest app bootstrap (it's only invoked from the
   * setImmediate() above, itself only reachable after a real booking write) — so
   * by call time both modules are already fully loaded and the cycle is a
   * non-issue. This avoids needing forwardRef() boilerplate.
   */
  private async handleBookingConfirmed(booking: any): Promise<void> {
    const { ConfigManagerService } = await import('../config/config-manager.service.js');
    const { TelegramService } = await import('../telegram/telegram.service.js');

    const configManager = this.moduleRef.get(ConfigManagerService, { strict: false });
    const telegramService = this.moduleRef.get(TelegramService, { strict: false });
    if (!telegramService) return; // defensive — shouldn't happen post-bootstrap

    // Two independently-toggleable delivery channels: Telegram (off by default)
    // and the dashboard Live Activity feed (on by default). Either, both, or
    // neither can be enabled at a time.
    const [telegramOn, activityOn] = configManager
      ? await Promise.all([
          configManager.getBool('notify_new_booking.telegram.enabled'),
          configManager.getBool('notify_new_booking.activity.enabled'),
        ])
      : [true, true];

    if (!telegramOn && !activityOn) return;

    const earnings: number | null = booking.revenue ?? booking.net_profit ?? null;
    const renter: string = booking.renter_name;
    const item: string = booking.item_name;
    const account: string = booking.account;

    if (telegramOn) {
      if (booking.rental_id) {
        // sendRentalUpdate() records this event to the dashboard Live Activity
        // feed internally (see TelegramService.recordActivity call inside it),
        // in addition to sending/buffering the Telegram push. Do NOT also call
        // recordBookingConfirmedActivity() below in this branch — doing so
        // recorded the exact same booking-confirmed event to the activity feed
        // a second time, which is what produced the duplicate "money made"
        // entry in the notifications panel whenever both
        // notify_new_booking.telegram.enabled and .activity.enabled were on.
        await telegramService.sendRentalUpdate(
          booking.rental_id,
          {
            type: 'booking_confirmed',
            priority: 'high',
            data: { earnings, renter, item, account },
          },
          { rentalTitle: item, renterName: renter, account },
        );
      } else {
        // No rental link (e.g. a manually created booking) — no rental thread to
        // consolidate into, so send the celebratory text directly. No `force`, so
        // it still respects the normal rate limiter/dedup. This path does NOT
        // touch the activity feed, so record it separately if enabled.
        const text = this.formatBookingConfirmedText(earnings, renter, item, account);
        await telegramService.sendProactiveMessage(text, 'Markdown');
        if (activityOn) {
          telegramService.recordBookingConfirmedActivity({ earnings, renter, item, account });
        }
      }
    } else if (activityOn) {
      telegramService.recordBookingConfirmedActivity({ earnings, renter, item, account });
    }
  }

  private formatBookingConfirmedText(earnings: number | null, renter: string, item: string, account: string): string {
    const accountLabel = account === 'leo' ? 'Leo' : account === 'dbcinema' ? 'DB Cinema' : account;
    const greeting = earnings != null
      ? `🎉 Woohoo! You just booked £${Math.round(earnings)} on ${accountLabel}!`
      : `🎉 Woohoo! New booking confirmed on ${accountLabel}!`;
    return `${greeting}\n${renter} — ${item}`;
  }
}
