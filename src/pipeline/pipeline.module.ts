import { Module } from '@nestjs/common';
import { PipelineService } from './pipeline.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { RulesModule } from '../rules/rules.module';
import { MemoryModule } from '../memory/memory.module';
import { CalendarModule } from '../calendar/calendar.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { RecommendationModule } from '../recommendations/recommendation.module';
import { DemandModule } from '../demand/demand.module';
import { ConversationStageModule } from '../conversation-tree/conversation-stage.module';
import { FollowUpModule } from '../follow-up/follow-up.module';
import { ContentionModule } from '../contention/contention.module';
import { RenterProfileModule } from '../renter-profile/renter-profile.module';

@Module({
  imports: [
    PrismaModule,
    AiModule,
    RulesModule,
    MemoryModule,
    CalendarModule,
    DeliveryModule,
    RecommendationModule,
    DemandModule,
    ConversationStageModule,
    FollowUpModule,
    ContentionModule,
    RenterProfileModule,
  ],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}
