import { Module } from '@nestjs/common';
import { RenterProfileService } from './renter-profile.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [RenterProfileService],
  exports: [RenterProfileService],
})
export class RenterProfileModule {}
