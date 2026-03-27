import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { TelegramService } from '../telegram/telegram.service';
import * as crypto from 'crypto';

@Injectable()
export class WinbackService {
  private readonly logger = new Logger(WinbackService.name);

  constructor(
    private prisma: PrismaService,
    private hyggloService: HyggloService,
    private telegramService: TelegramService,
  ) {}

  /**
   * Monthly winback campaign — runs 1st of each month at 10am UTC.
   * Finds renters who completed rentals 3 months ago, haven't rebooked, and sends a 30% discount code.
   */
  @Cron('0 10 1 * *')
  async runMonthlyWinback(): Promise<void> {
    this.logger.log('Starting monthly winback campaign...');

    try {
      const now = new Date();
      const campaignMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      // Target window = 3 months ago (e.g. June 1st cron → March completions)
      const targetStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      const targetEnd = new Date(now.getFullYear(), now.getMonth() - 2, 1);

      this.logger.log(
        `Target window: ${targetStart.toISOString().slice(0, 10)} to ${targetEnd.toISOString().slice(0, 10)}`,
      );

      // Find completed bookings with end_date in the target window
      const completedBookings = await this.prisma.booking.findMany({
        where: {
          status: 'completed',
          end_date: { gte: targetStart, lt: targetEnd },
          rental_id: { not: null },
        },
        include: {
          rental: {
            include: {
              renter_links: {
                include: { renter_profile: true },
              },
            },
          },
        },
      });

      if (completedBookings.length === 0) {
        this.logger.log('No completed bookings in target window. Skipping.');
        return;
      }

      // Get existing winback records (never contact same renter twice)
      const existingWinbacks = await this.prisma.winback_campaign.findMany({
        select: { renter_profile_id: true },
      });
      const alreadyContacted = new Set(existingWinbacks.map(w => w.renter_profile_id));

      // Build eligible renters map: profileId → { profile, rental, listingId, account }
      const eligibleMap = new Map<string, {
        profile: { id: string; name: string };
        rentalId: string;
        listingId: string;
        account: string;
      }>();

      for (const booking of completedBookings) {
        if (!booking.rental) continue;
        const rental = booking.rental;
        const account = rental.account || 'dbcinema';

        for (const link of rental.renter_links) {
          const profileId = link.renter_profile_id;
          if (alreadyContacted.has(profileId)) continue;
          if (eligibleMap.has(profileId)) continue;

          eligibleMap.set(profileId, {
            profile: { id: profileId, name: link.renter_profile.name },
            rentalId: rental.id,
            listingId: rental.listing_id,
            account,
          });
        }
      }

      if (eligibleMap.size === 0) {
        this.logger.log('No eligible renters (all already contacted or no profiles). Skipping.');
        return;
      }

      // Exclude renters who rebooked after the target window
      const profileIds = Array.from(eligibleMap.keys());
      const rebookedProfiles = await this.prisma.rental_renter_link.findMany({
        where: {
          renter_profile_id: { in: profileIds },
          rental: {
            bookings: {
              some: {
                start_date: { gte: targetEnd },
                status: { not: 'cancelled' },
              },
            },
          },
        },
        select: { renter_profile_id: true },
        distinct: ['renter_profile_id'],
      });

      const rebookedSet = new Set(rebookedProfiles.map(r => r.renter_profile_id));
      for (const profileId of rebookedSet) {
        eligibleMap.delete(profileId);
      }

      if (eligibleMap.size === 0) {
        this.logger.log('All eligible renters have rebooked. No winback needed.');
        return;
      }

      this.logger.log(`Found ${eligibleMap.size} eligible renter(s) for winback`);

      // Send winback messages
      let sentCount = 0;
      let failedCount = 0;
      const results: { name: string; account: string; code: string; sent: boolean }[] = [];

      for (const [profileId, data] of eligibleMap) {
        try {
          const code = `wb-${crypto.randomBytes(3).toString('hex')}`;
          const expiresAt = new Date(Date.now() + 30 * 86400000);
          const firstName = data.profile.name.split(' ')[0];

          // Create coupon code
          await this.prisma.coupon_code.create({
            data: {
              code,
              discount_percent: 30,
              description: `Winback 30% for ${data.profile.name}`,
              active: true,
              account: data.account,
              max_uses: 1,
              expires_at: expiresAt,
            },
          });

          // Build message based on account
          const message = data.account === 'leo'
            ? `Hi ${firstName}! Haven't seen you in a while — hope your last shoot went great.\nGot a 30% discount code for you as a welcome-back offer: ${code}\nDrop the code in chat when you're booking next and I'll sort the discount. Good for 30 days — minimum rental value still applies.\nCheers!`
            : `Hey ${firstName}! It's been a while since your last rental with us and we'd love to have you back.\nHere's a personal 30% discount code just for you: ${code}\nJust mention the code in this chat when you're ready to book and we'll apply it. Valid for 30 days — minimum rental value still applies.\nHope to see you again soon!`;

          // Send via Hygglo
          const sent = await this.hyggloService.sendMessage(data.listingId, message);

          if (sent) {
            // Store in conversation history
            await this.prisma.conversation.create({
              data: {
                chat_id: data.listingId,
                role: 'assistant',
                content: message,
                metadata: { source: 'winback_campaign', coupon_code: code },
              },
            });
            sentCount++;
          } else {
            failedCount++;
          }

          // Record campaign entry regardless of send success
          await this.prisma.winback_campaign.create({
            data: {
              renter_profile_id: profileId,
              rental_id: data.rentalId,
              listing_id: data.listingId,
              account: data.account,
              coupon_code: code,
              sent_at: sent ? new Date() : null,
              campaign_month: campaignMonth,
            },
          });

          results.push({ name: data.profile.name, account: data.account, code, sent });
        } catch (error) {
          // Unique constraint = already contacted (race condition safety)
          if (error?.code === 'P2002') {
            this.logger.warn(`Skipping duplicate winback for profile ${profileId}`);
            continue;
          }
          this.logger.error(`Failed winback for ${data.profile.name}: ${error.message}`);
          failedCount++;
          results.push({ name: data.profile.name, account: data.account, code: '?', sent: false });
        }
      }

      // Notify Daniel via Telegram
      const summary = [
        `*Winback Campaign — ${campaignMonth.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}*`,
        `Window: ${targetStart.toISOString().slice(0, 10)} → ${targetEnd.toISOString().slice(0, 10)}`,
        `Sent: ${sentCount} | Failed: ${failedCount}`,
        '',
        ...results.map(r => `${r.sent ? '✅' : '❌'} ${r.name} (${r.account}) — \`${r.code}\``),
      ].join('\n');

      await this.telegramService.sendProactiveMessage(summary);
      this.logger.log(`Winback campaign complete: ${sentCount} sent, ${failedCount} failed`);
    } catch (error) {
      this.logger.error(`Winback campaign failed: ${error.message}`, error.stack);
    }
  }
}
