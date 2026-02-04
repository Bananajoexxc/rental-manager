import { Module, forwardRef } from '@nestjs/common';
import { CompletedScanService } from './completed-scan.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HyggloModule } from '../hygglo/hygglo.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AiModule } from '../ai/ai.module';
import { RulesModule } from '../rules/rules.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [
    PrismaModule,
    HyggloModule,
    forwardRef(() => TelegramModule),
    AiModule,
    RulesModule,
    MemoryModule,
  ],
  providers: [CompletedScanService],
  exports: [CompletedScanService],
})
export class CompletedScanModule {}
