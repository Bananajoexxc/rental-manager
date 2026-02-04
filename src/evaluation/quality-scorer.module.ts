import { Module } from '@nestjs/common';
import { QualityScorerService } from './quality-scorer.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [QualityScorerService],
  exports: [QualityScorerService],
})
export class QualityScorerModule {}
