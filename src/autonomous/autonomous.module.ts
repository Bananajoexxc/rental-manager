import { Module, forwardRef } from '@nestjs/common';
import { AutonomousService } from './autonomous.service';
import { AiModule } from '../ai/ai.module';
import { RulesModule } from '../rules/rules.module';
import { MemoryModule } from '../memory/memory.module';
import { TelegramModule } from '../telegram/telegram.module';
import { HyggloModule } from '../hygglo/hygglo.module';
import { BlacklistModule } from '../blacklist/blacklist.module';
import { DemandModule } from '../demand/demand.module';
import { CalendarModule } from '../calendar/calendar.module';
import { DeliveryModule } from '../delivery/delivery.module';

@Module({
  imports: [
    AiModule,
    RulesModule,
    MemoryModule,
    forwardRef(() => TelegramModule),
    HyggloModule,
    BlacklistModule,
    DemandModule,
    CalendarModule,
    DeliveryModule,
  ],
  providers: [AutonomousService],
  exports: [AutonomousService],
})
export class AutonomousModule {}
