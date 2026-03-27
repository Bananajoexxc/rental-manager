import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HyggloService } from '../hygglo/hygglo.service';

type HyggloAccount = 'dbcinema' | 'leo';

/** Our account display names on Hygglo (used to match review authors). */
const OUR_ACCOUNT_NAMES = ['db cinema rentals', 'leo adams'];
import * as crypto from 'crypto';

@Injectable()
export class CouponService implements OnModuleInit {
  private readonly logger = new Logger(CouponService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => HyggloService)) private hyggloService: HyggloService,
  ) {}

  async onModuleInit() {
    await this.seedDefaults();
  }

  private async seedDefaults() {
    const existing = await this.prisma.coupon_code.findUnique({
      where: { code: 'db15off' },
    });
    if (!existing) {
      await this.prisma.coupon_code.create({
        data: {
          code: 'db15off',
          discount_percent: 15,
          description: 'Return customer thank-you discount',
          active: true,
        },
      });
      this.logger.log('Seeded default coupon: db15off (15% off)');
    }

    // Seed DBCINEMA30 - loyalty client discount (permanent)
    const loyaltyExisting = await this.prisma.coupon_code.findUnique({
      where: { code: 'dbcinema30' },
    });
    if (!loyaltyExisting) {
      await this.prisma.coupon_code.create({
        data: {
          code: 'dbcinema30',
          discount_percent: 30,
          description: 'Loyalty client discount - 30% off for 5-star renters with 7+ reviews who rent exclusively with us',
          active: true,
        },
      });
      this.logger.log('Seeded loyalty coupon: DBCINEMA30 (30% off)');
    }
  }

  async getActiveCoupons(account?: string) {
    const where: any = { active: true };
    if (account) {
      where.OR = [{ account }, { account: null }];
    }
    return this.prisma.coupon_code.findMany({ where });
  }

  async validateCoupon(code: string): Promise<{ valid: boolean; discount_percent?: number; description?: string }> {
    const coupon = await this.prisma.coupon_code.findUnique({
      where: { code: code.toLowerCase().trim() },
    });

    if (!coupon || !coupon.active) {
      return { valid: false };
    }

    if (coupon.max_uses && coupon.times_used >= coupon.max_uses) {
      return { valid: false };
    }

    if (coupon.expires_at && coupon.expires_at < new Date()) {
      return { valid: false };
    }

    return {
      valid: true,
      discount_percent: coupon.discount_percent,
      description: coupon.description || undefined,
    };
  }

  async buildAICouponContext(): Promise<string> {
    const coupons = await this.prisma.coupon_code.findMany({
      where: {
        active: true,
        OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
      },
    });

    if (coupons.length === 0) return '';

    const lines = coupons.map(c =>
      `- Code "${c.code}": ${c.discount_percent}% off${c.description ? ` (${c.description})` : ''}${c.account ? ` [${c.account} only]` : ' [all accounts]'}`,
    );

    return [
      'ACTIVE DISCOUNT CODES:',
      ...lines,
      'If a renter mentions one of these codes, confirm the discount and apply it to their booking.',
      '',
      'SPECIAL - DBCINEMA30 LOYALTY CODE:',
      'This code requires real-time validation before confirming. The system validates automatically',
      'and injects the result into context. Follow the DBCINEMA30 VALIDATED or DBCINEMA30 INVALID',
      'instruction. If no validation result appears, do NOT confirm the discount - ask the renter',
      'to try again or say you need to verify their eligibility.',
      'The 30% discount applies AFTER minimum earnings are met (DB Cinema: \u00a320, Leo: \u00a325).',
      'Cannot be stacked with other discounts.',
    ].join('\n');
  }

  // === Loyalty Client Discount (DBCINEMA30) ===

  /**
   * Check if a renter qualifies for DBCINEMA30 after a return.
   * Eligibility: 7+ total reviews AND 5.0 average rating on Hygglo.
   */
  async checkLoyaltyEligibility(
    orderId: string,
    account: HyggloAccount,
  ): Promise<{ eligible: boolean; totalReviews?: number; averageRating?: number }> {
    try {
      const stats = await this.hyggloService.fetchCustomerReviews(orderId, account);
      if (!stats) return { eligible: false };

      const eligible = stats.totalReviews >= 7 && stats.averageRating === 5;
      return { eligible, totalReviews: stats.totalReviews, averageRating: stats.averageRating };
    } catch (err) {
      this.logger.warn('Loyalty eligibility check failed for order ' + orderId + ': ' + err.message);
      return { eligible: false };
    }
  }

  /**
   * Validate DBCINEMA30 for a renter. Checks:
   * 1. 7+ reviews with 5.0 average
   * 2. Most recent review is from one of our accounts (DB Cinema Rentals or Leo Adams)
   *
   * Must be revalidated every time - a competitor rental in between invalidates it.
   */
  async validateLoyaltyCode(
    orderId: string,
    account: HyggloAccount,
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      const stats = await this.hyggloService.fetchCustomerReviews(orderId, account);
      if (!stats) return { valid: false, reason: 'Could not fetch review data from Hygglo' };

      if (stats.totalReviews < 7) {
        return { valid: false, reason: 'Only ' + stats.totalReviews + ' reviews (need 7+)' };
      }
      if (stats.averageRating < 5) {
        return { valid: false, reason: 'Average rating ' + stats.averageRating + ' (need 5.0)' };
      }
      if (!stats.reviews || stats.reviews.length === 0) {
        return { valid: false, reason: 'No review details available' };
      }

      // Most recent review must be from one of our accounts
      const mostRecent = stats.reviews[0];
      const authorLower = mostRecent.authorName.toLowerCase();

      if (!OUR_ACCOUNT_NAMES.some(name => authorLower.includes(name))) {
        return {
          valid: false,
          reason: 'Most recent review from "' + mostRecent.authorName + '" - not our account. Renter used another company since last rental with us.',
        };
      }

      return { valid: true };
    } catch (err) {
      this.logger.warn('DBCINEMA30 validation failed for order ' + orderId + ': ' + err.message);
      return { valid: false, reason: 'Validation error' };
    }
  }

  // === Loyalty Voucher System (THANKYOU-* decay codes) ===

  generateVoucherCode(): string {
    return 'THANKYOU-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  /**
   * Issue a new loyalty voucher for a renter. Deletes any existing voucher first (one active per renter).
   */
  async issueVoucher(renterProfileId: string, rentalId: string): Promise<string> {
    // Delete existing voucher for this renter (one active at a time)
    await this.prisma.loyalty_voucher.deleteMany({
      where: { renter_profile_id: renterProfileId },
    });

    const code = this.generateVoucherCode();
    await this.prisma.loyalty_voucher.create({
      data: {
        code,
        renter_profile_id: renterProfileId,
        rental_id: rentalId,
      },
    });

    this.logger.log(`Issued loyalty voucher ${code} for renter profile ${renterProfileId} (rental ${rentalId})`);
    return code;
  }

  /**
   * Get a renter's active voucher with current discount % and days remaining.
   */
  async getRenterVoucher(renterProfileId: string): Promise<{
    code: string;
    discountPercent: number;
    daysLeft: number;
    issuedAt: Date;
  } | null> {
    const voucher = await this.prisma.loyalty_voucher.findUnique({
      where: { renter_profile_id: renterProfileId },
    });

    if (!voucher || voucher.used_at || voucher.expired) return null;

    const daysSinceIssue = Math.floor((Date.now() - voucher.issued_at.getTime()) / 86400000);
    const discountPercent = Math.max(0, 20 - daysSinceIssue);

    if (discountPercent <= 0) return null;

    return {
      code: voucher.code,
      discountPercent,
      daysLeft: discountPercent, // days left = current discount (1:1 since it drops 1%/day)
      issuedAt: voucher.issued_at,
    };
  }

  /**
   * Validate a loyalty voucher code. Returns current decay-adjusted discount.
   */
  async validateLoyaltyVoucher(code: string): Promise<{
    valid: boolean;
    discountPercent?: number;
    renterProfileId?: string;
    voucherId?: string;
  }> {
    const voucher = await this.prisma.loyalty_voucher.findUnique({
      where: { code: code.toUpperCase().trim() },
    });

    if (!voucher || voucher.used_at || voucher.expired) {
      return { valid: false };
    }

    const daysSinceIssue = Math.floor((Date.now() - voucher.issued_at.getTime()) / 86400000);
    const discountPercent = Math.max(0, 20 - daysSinceIssue);

    if (discountPercent <= 0) {
      return { valid: false };
    }

    return {
      valid: true,
      discountPercent,
      renterProfileId: voucher.renter_profile_id,
      voucherId: voucher.id,
    };
  }

  /**
   * Redeem a voucher (mark as used).
   */
  async redeemVoucher(code: string, rentalId: string): Promise<void> {
    await this.prisma.loyalty_voucher.update({
      where: { code: code.toUpperCase().trim() },
      data: {
        used_at: new Date(),
        used_rental_id: rentalId,
      },
    });
    this.logger.log(`Redeemed loyalty voucher ${code} for rental ${rentalId}`);
  }

  /**
   * Nightly cleanup: expire vouchers older than 20 days.
   */
  @Cron('0 3 * * *')
  async cleanupExpiredVouchers(): Promise<void> {
    const cutoff = new Date(Date.now() - 20 * 86400000);
    const result = await this.prisma.loyalty_voucher.updateMany({
      where: {
        issued_at: { lt: cutoff },
        expired: false,
        used_at: null,
      },
      data: { expired: true },
    });

    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} loyalty voucher(s) older than 20 days`);
    }

    // Also deactivate expired coupon codes
    const couponResult = await this.prisma.coupon_code.updateMany({
      where: { expires_at: { lt: new Date() }, active: true },
      data: { active: false },
    });
    if (couponResult.count > 0) {
      this.logger.log(`Deactivated ${couponResult.count} expired coupon code(s)`);
    }
  }
}
