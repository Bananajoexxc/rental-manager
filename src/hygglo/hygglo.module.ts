import { Module } from '@nestjs/common';
import { HyggloService } from './hygglo.service';

@Module({
  providers: [HyggloService],
  exports: [HyggloService],
})
export class HyggloModule {}
