import { Module } from '@nestjs/common';
import { ImageAnalysisService } from './image-analysis.service';

@Module({
  providers: [ImageAnalysisService],
  exports: [ImageAnalysisService],
})
export class ImageAnalysisModule {}
