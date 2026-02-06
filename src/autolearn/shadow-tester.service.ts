import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeminiService } from '../ai/gemini.service';
import { RulesService } from '../rules/rules.service';
import { PromptManagerService } from '../prompts/prompt-manager.service';
import { ValidationService } from '../validation/validation.service';
import { QualityScorerService } from '../evaluation/quality-scorer.service';
import { ProposalDraft, ShadowTestResult, ChangeType } from './autolearn.types';
import { ConfigManagerService } from './config-manager.service';

@Injectable()
export class ShadowTesterService {
  private readonly logger = new Logger(ShadowTesterService.name);

  constructor(
    private prisma: PrismaService,
    private geminiService: GeminiService,
    private rulesService: RulesService,
    private promptManager: PromptManagerService,
    private validationService: ValidationService,
    private qualityScorer: QualityScorerService,
    private configManager: ConfigManagerService,
  ) {}

  async test(proposal: ProposalDraft): Promise<ShadowTestResult> {
    const sampleSize = await this.configManager.getInt('autolearn.shadow_test_sample_size');

    // Always test on FRESH data — most recent conversations (not stale failures)
    const recentDecisions = await this.prisma.ai_decision.findMany({
      where: {
        created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { created_at: 'desc' },
      take: sampleSize * 2, // fetch more, prioritize diverse quality levels
    });

    // Mix: half low-quality (where improvement matters most), half recent (to catch regressions)
    const lowQuality = recentDecisions.filter(d => !d.was_sent || (d.confidence ?? 1) < 0.7);
    const highQuality = recentDecisions.filter(d => d.was_sent && (d.confidence ?? 1) >= 0.7);
    const failedDecisions = [
      ...lowQuality.slice(0, Math.ceil(sampleSize / 2)),
      ...highQuality.slice(0, Math.floor(sampleSize / 2)),
    ].slice(0, sampleSize);

    if (failedDecisions.length === 0) {
      return { replayed: 0, improved: 0, degraded: 0, neutral: 0, avgQualityDelta: 0 };
    }

    let improved = 0;
    let degraded = 0;
    let neutral = 0;
    let totalDelta = 0;

    for (const decision of failedDecisions) {
      try {
        // Get original quality score
        const originalQuality = await this.prisma.response_quality.findUnique({
          where: { ai_decision_id: decision.id },
        });
        const originalScore = originalQuality?.overall_quality ?? 0.5;

        // Build modified context with proposed change applied
        const modifiedRules = await this.buildModifiedContext(proposal);

        // Re-run AI call with modified context via Gemini Flash-Lite (bulk)
        const geminiResponse = await this.geminiService.processBulk(
          decision.input_summary,
          `${modifiedRules}\n\nSHADOW TEST — evaluate response quality`,
        );
        if (!geminiResponse) {
          neutral++; // Quota exhausted or API error — count as neutral
          continue;
        }
        const response = { content: geminiResponse.content };

        // Score the new response
        const validation = await this.validationService.validateResponse(response.content, {});
        const newQuality = await this.qualityScorer.scoreResponse(response.content, {}, validation);
        const newScore = newQuality.overallQuality;

        const delta = newScore - originalScore;
        totalDelta += delta;

        if (delta > 0.05) improved++;
        else if (delta < -0.05) degraded++;
        else neutral++;
      } catch (err) {
        this.logger.warn(`Shadow test replay failed for decision ${decision.id}: ${err.message}`);
        neutral++; // Count errors as neutral
      }
    }

    const replayed = failedDecisions.length;
    return {
      replayed,
      improved,
      degraded,
      neutral,
      avgQualityDelta: replayed > 0 ? totalDelta / replayed : 0,
    };
  }

  private async buildModifiedContext(proposal: ProposalDraft): Promise<string> {
    const currentRules = await this.rulesService.getFormattedRules();

    switch (proposal.changeType) {
      case ChangeType.RULE_ADD: {
        const { content, name } = proposal.changePayload.after;
        return `${currentRules}\n\nADDITIONAL RULE (${name}): ${content}`;
      }

      case ChangeType.RULE_EDIT: {
        const { before, after } = proposal.changePayload;
        return currentRules.replace(before, after.content || after);
      }

      case ChangeType.PROMPT_EDIT: {
        // For prompt edits, append the change as additional context
        const componentName = proposal.targetEntity.replace('prompt:', '');
        return `${currentRules}\n\n[MODIFIED ${componentName}]: ${proposal.changePayload.after}`;
      }

      default:
        return currentRules;
    }
  }
}
