import { Module, Global } from '@nestjs/common';
import { ErrorLogService } from './error-log.service';

@Global()
@Module({
  providers: [ErrorLogService],
  exports: [ErrorLogService],
})
export class MonitoringModule {}
