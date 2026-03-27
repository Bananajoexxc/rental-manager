import { Module } from '@nestjs/common';
import { ConversationArchiveService } from './conversation-archive.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [PrismaModule, AiModule],
  providers: [ConversationArchiveService],
  exports: [ConversationArchiveService],
})
export class ConversationArchiveModule {}
