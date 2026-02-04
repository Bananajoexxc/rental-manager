import { Module } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RenterProfileModule } from '../renter-profile/renter-profile.module';
import { PlaywrightModule } from '../playwright/playwright.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [PrismaModule, RenterProfileModule, PlaywrightModule, TelegramModule],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
