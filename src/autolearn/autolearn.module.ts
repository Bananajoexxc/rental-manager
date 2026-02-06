import { Module, forwardRef } from '@nestjs/common';
import { AutolearnService } from './autolearn.service';
import { ConfigManagerService } from './config-manager.service';
import { ViolationAnalyzerService } from './analyzers/violation-analyzer.service';
import { QualityAnalyzerService } from './analyzers/quality-analyzer.service';
import { ConversionAnalyzerService } from './analyzers/conversion-analyzer.service';
import { TokenAnalyzerService } from './analyzers/token-analyzer.service';
import { CorrectionDetectorService } from './correction-detector.service';
import { ShadowTesterService } from './shadow-tester.service';
import { RollbackManagerService } from './rollback-manager.service';
import { ReworkService } from './rework.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { RulesModule } from '../rules/rules.module';
import { PromptManagerModule } from '../prompts/prompt-manager.module';
import { ValidationModule } from '../validation/validation.module';
import { QualityScorerModule } from '../evaluation/quality-scorer.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [
    PrismaModule,
    AiModule,
    RulesModule,
    PromptManagerModule,
    ValidationModule,
    QualityScorerModule,
    forwardRef(() => TelegramModule),
  ],
  providers: [
    AutolearnService,
    ConfigManagerService,
    ViolationAnalyzerService,
    QualityAnalyzerService,
    ConversionAnalyzerService,
    TokenAnalyzerService,
    CorrectionDetectorService,
    ShadowTesterService,
    RollbackManagerService,
    ReworkService,
  ],
  exports: [
    AutolearnService,
    ConfigManagerService,
    CorrectionDetectorService,
  ],
})
export class AutolearnModule {}
