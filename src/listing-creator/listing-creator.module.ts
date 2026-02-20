import { Module } from '@nestjs/common';
import { ListingCreatorService } from './listing-creator.service';
import { ImageFinderService } from './image-finder.service';
import { BackgroundRemoverService } from './background-remover.service';
import { ImageComposerService } from './image-composer.service';
import { CompetitorIntelModule } from '../competitor-intel/competitor-intel.module';

@Module({
  imports: [CompetitorIntelModule],
  providers: [
    ListingCreatorService,
    ImageFinderService,
    BackgroundRemoverService,
    ImageComposerService,
  ],
  exports: [ListingCreatorService],
})
export class ListingCreatorModule {}
