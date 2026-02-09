import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
}
