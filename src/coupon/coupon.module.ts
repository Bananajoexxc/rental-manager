import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CouponService } from './coupon.service';

@Module({
  imports: [PrismaModule],
  providers: [CouponService],
  exports: [CouponService],
})
export class CouponModule {}
