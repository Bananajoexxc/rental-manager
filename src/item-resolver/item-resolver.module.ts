import { Module } from '@nestjs/common';
import { ItemResolverService } from './item-resolver.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [AiModule],
  providers: [ItemResolverService],
  exports: [ItemResolverService],
})
export class ItemResolverModule {}
