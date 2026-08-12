import { Module } from '@nestjs/common';
import { ConfigManagerService } from './config-manager.service';

@Module({
  providers: [ConfigManagerService],
  exports: [ConfigManagerService],
})
export class ConfigManagerModule {}
