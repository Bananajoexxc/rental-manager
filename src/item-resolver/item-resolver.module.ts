import { Module } from '@nestjs/common';
import { ItemResolverService } from './item-resolver.service';

@Module({
  providers: [ItemResolverService],
  exports: [ItemResolverService],
})
export class ItemResolverModule {}
