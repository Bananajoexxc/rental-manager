import { Module, forwardRef } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [forwardRef(() => AiModule)],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
