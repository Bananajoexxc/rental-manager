import { Module } from '@nestjs/common';
import { PromptManagerService } from './prompt-manager.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [PromptManagerService],
  exports: [PromptManagerService],
})
export class PromptManagerModule {}
