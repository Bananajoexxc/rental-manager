import { Module } from '@nestjs/common';
import { ConversationStageService } from './conversation-stage.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ConversationStageService],
  exports: [ConversationStageService],
})
export class ConversationStageModule {}
