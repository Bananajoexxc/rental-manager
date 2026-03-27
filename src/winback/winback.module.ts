import { Module, forwardRef } from '@nestjs/common';
import { WinbackService } from './winback.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HyggloModule } from '../hygglo/hygglo.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [PrismaModule, HyggloModule, forwardRef(() => TelegramModule)],
  providers: [WinbackService],
  exports: [WinbackService],
})
export class WinbackModule {}
