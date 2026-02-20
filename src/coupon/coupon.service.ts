import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class CouponService implements OnModuleInit {
  private readonly logger = new Logger(CouponService.name);

  constructor(private prisma: PrismaService) {}

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

    return {
      valid: true,
      discount_percent: coupon.discount_percent,
      description: coupon.description || undefined,
    };
  }

  async buildAICouponContext(): Promise<string> {
    const coupons = await this.prisma.coupon_code.findMany({
      where: { active: true },
    });

    if (coupons.length === 0) return '';

    const lines = coupons.map(c =>
      `- Code "${c.code}": ${c.discount_percent}% off${c.description ? ` (${c.description})` : ''}${c.account ? ` [${c.account} only]` : ' [all accounts]'}`,
    );

    return [
      'ACTIVE DISCOUNT CODES:',
      ...lines,
      'If a renter mentions one of these codes, confirm the discount and apply it to their booking.',
    ].join('\n');
  }

  // === Loyalty Voucher System ===

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
  }
}
