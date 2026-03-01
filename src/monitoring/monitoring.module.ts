import { Module, Global } from '@nestjs/common';
import { ErrorLogService } from './error-log.service';
import { DiagnosticService } from './diagnostic.service';

@Global()
@Module({
  providers: [ErrorLogService, DiagnosticService],
  exports: [ErrorLogService, DiagnosticService],
})
export class MonitoringModule {}
