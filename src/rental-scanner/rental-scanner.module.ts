import { Module } from '@nestjs/common';
import { RentalScannerService } from './rental-scanner.service';
import { HyggloModule } from '../hygglo/hygglo.module';
import { ImageAnalysisModule } from '../image-analysis/image-analysis.module';

@Module({
  imports: [HyggloModule, ImageAnalysisModule],
  providers: [RentalScannerService],
  exports: [RentalScannerService],
})
export class RentalScannerModule {}
