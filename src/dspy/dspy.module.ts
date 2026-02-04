import { Module, Global } from '@nestjs/common';
import { DspyService } from './dspy.service';

@Global()
@Module({
  providers: [DspyService],
  exports: [DspyService],
})
export class DspyModule {}
