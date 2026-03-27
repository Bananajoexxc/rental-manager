import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HyggloModule } from '../hygglo/hygglo.module';
import { CouponService } from './coupon.service';

@Module({
  imports: [PrismaModule, forwardRef(() => HyggloModule)],
  providers: [CouponService],
  exports: [CouponService],
})
export class CouponModule {}
