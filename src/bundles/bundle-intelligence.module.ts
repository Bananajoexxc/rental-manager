import { Module } from '@nestjs/common';
import { BundleIntelligenceService } from './bundle-intelligence.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [BundleIntelligenceService],
  exports: [BundleIntelligenceService],
})
export class BundleIntelligenceModule {}
