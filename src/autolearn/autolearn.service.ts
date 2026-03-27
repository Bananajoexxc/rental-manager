import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { DspyService } from '../dspy/dspy.service';
import { ConfigManagerService } from './config-manager.service';
import { ViolationAnalyzerService } from './analyzers/violation-analyzer.service';
import { QualityAnalyzerService } from './analyzers/quality-analyzer.service';
import { ConversionAnalyzerService } from './analyzers/conversion-analyzer.service';
import { TokenAnalyzerService } from './analyzers/token-analyzer.service';
import { CorrectionDetectorService } from './correction-detector.service';
import { ShadowTesterService } from './shadow-tester.service';
import { RollbackManagerService } from './rollback-manager.service';
import { ReworkService } from './rework.service';
import {
  ProposalDraft,
  ProposalStatus,
  LogEventType,
  CycleFinding,
  SAFETY,
} from './autolearn.types';
import { randomUUID } from 'crypto';

/** Escape Telegram Markdown v1 special characters */
function escapeMd(text: string): string {
  return text.replace(/([_*`\[])/g, '\\$1');
}

@Injectable()
export class AutolearnService {
  private readonly logger = new Logger(AutolearnService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private dspyService: DspyService,
    private configManager: ConfigManagerService,
    private violationAnalyzer: ViolationAnalyzerService,
    private qualityAnalyzer: QualityAnalyzerService,
    private conversionAnalyzer: ConversionAnalyzerService,
    private tokenAnalyzer: TokenAnalyzerService,
    private correctionDetector: CorrectionDetectorService,
    private shadowTester: ShadowTesterService,
    private rollbackManager: RollbackManagerService,
    private reworkService: ReworkService,
  ) {}

  // --- Cron schedules ---

  @Cron('0 */4 * * *')
  async runHourlyCycle(): Promise<void> {
    const enabled = await this.configManager.getBool('autolearn.enabled');
    const paused = await this.configManager.getBool('autolearn.paused');
    if (!enabled || paused || this.isQuietHours()) return;

    // Gate: skip cycle if insufficient new data since last run (4 hours)
    const sinceLastCycle = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const newDecisionCount = await this.prisma.ai_decision.count({
      where: { created_at: { gte: sinceLastCycle } },
    });
    if (newDecisionCount < 3) {
      this.logger.log(`Skipping autolearn cycle — insufficient new data (${newDecisionCount} decisions in last 4h)`);
      return;
    }

    const cycleId = randomUUID();
    this.logger.log(`Starting 4-hourly cycle ${cycleId} (${newDecisionCount} new decisions)`);

    await this.prisma.autolearn_log.create({
      data: { event_type: LogEventType.CYCLE_START, details: { cycleId } },
    });

    try {
      // Check daily limit
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const maxPerDay = await this.configManager.getInt('autolearn.max_proposals_per_day');
      const todayCount = await this.prisma.autolearn_proposal.count({
        where: { created_at: { gte: todayStart } },
      });
      if (todayCount >= maxPerDay) {
        this.logger.log(`Daily limit reached (${todayCount}/${maxPerDay}), skipping cycle`);
        return;
      }

      const since = new Date(Date.now() - 4 * 60 * 60 * 1000); // Last 4 hours

      // Run all analyzers + correction detector in parallel
      const [violations, quality, conversion, tokens, corrections] = await Promise.all([
        this.violationAnalyzer.analyze(since),
        this.qualityAnalyzer.analyze(since),
        this.conversionAnalyzer.analyze(since),
        this.tokenAnalyzer.analyze(since),
        this.correctionDetector.getRecentCorrections(since),
      ]);

      let allProposals: ProposalDraft[] = [
        ...violations,
        ...quality,
        ...conversion,
        ...tokens,
        ...corrections,
      ];

      // Track safety-blocked findings for digest
      const blockedFindings: CycleFinding[] = [];

      // Safety: block changes to protected components
      allProposals = allProposals.filter(p => {
        for (const protected_ of SAFETY.PROTECTED_COMPONENTS) {
          if (p.targetEntity.includes(protected_)) {
            this.logger.warn(`Blocked proposal targeting protected component: ${p.targetEntity}`);
            blockedFindings.push({
              analyzer: p.analyzer,
              description: p.description,
              status: 'blocked_safety',
            });
            return false;
          }
        }
        return true;
      });

      // Safety: block deactivation of high-priority rules
      allProposals = allProposals.filter(p => {
        if (p.changeType === 'rule_deactivate' && p.changePayload.before?.priority >= SAFETY.MIN_PROTECTED_RULE_PRIORITY) {
          this.logger.warn(`Blocked deactivation of high-priority rule: ${p.targetEntity}`);
          blockedFindings.push({
            analyzer: p.analyzer,
            description: p.description,
            status: 'blocked_safety',
          });
          return false;
        }
        return true;
      });

      // Rate limit: max per cycle
      const maxPerCycle = await this.configManager.getInt('autolearn.max_proposals_per_cycle');
      const remainingSlots = Math.min(maxPerCycle, maxPerDay - todayCount);
      allProposals = allProposals.slice(0, remainingSlots);

      if (allProposals.length === 0 && blockedFindings.length === 0) {
        this.logger.log('No proposals generated this cycle');
        await this.prisma.autolearn_log.create({
          data: { event_type: LogEventType.CYCLE_END, details: { cycleId, proposals: 0 } },
        });
        return;
      }

      if (allProposals.length === 0 && blockedFindings.length > 0) {
        // Only safety-blocked proposals — send digest and return
        await this.sendFindingsDigest(blockedFindings);
        await this.prisma.autolearn_log.create({
          data: { event_type: LogEventType.CYCLE_END, details: { cycleId, proposals: 0, blockedBySafety: blockedFindings.length } },
        });
        return;
      }

      // Track all findings for the digest (include safety-blocked ones)
      const findings: CycleFinding[] = [...blockedFindings];

      // Shadow test each proposal
      const testedProposals: { draft: ProposalDraft; result: any }[] = [];
      for (const draft of allProposals) {
        try {
          const result = await this.shadowTester.test(draft);
          // Filter: improved must > degraded AND avgQualityDelta > 0
          if (result.improved > result.degraded && result.avgQualityDelta > 0) {
            testedProposals.push({ draft, result });
            findings.push({
              analyzer: draft.analyzer,
              description: draft.description,
              shadowResult: result,
              status: 'passed',
            });
          } else {
            this.logger.log(
              `Shadow test failed for "${draft.description}": ${result.improved}↑ ${result.degraded}↓ ${result.neutral}→ (delta: ${result.avgQualityDelta.toFixed(3)})`,
            );

            // Store as REWORK instead of discarding
            await this.prisma.autolearn_proposal.create({
              data: {
                cycle_id: cycleId,
                analyzer: draft.analyzer,
                change_type: draft.changeType,
                target_entity: draft.targetEntity,
                description: draft.description,
                change_payload: draft.changePayload,
                shadow_result: result as any,
                failed_shadow: result as any,
                status: ProposalStatus.REWORK,
                veto_deadline: new Date(), // not used for rework, but required
                rework_count: 0,
                rework_reason: `Initial shadow failed: ${result.improved}↑ ${result.degraded}↓ delta=${result.avgQualityDelta.toFixed(3)}`,
              },
            });

            findings.push({
              analyzer: draft.analyzer,
              description: draft.description,
              shadowResult: result,
              status: 'failed_shadow',
            });
          }
        } catch (err) {
          this.logger.warn(`Shadow test error: ${err.message}`);
          findings.push({
            analyzer: draft.analyzer,
            description: draft.description,
            status: 'error',
          });
        }
      }

      // Auto-apply: shadow tests are the gate. Apply immediately, no veto window.
      for (const { draft, result } of testedProposals) {
        const proposal = await this.prisma.autolearn_proposal.create({
          data: {
            cycle_id: cycleId,
            analyzer: draft.analyzer,
            change_type: draft.changeType,
            target_entity: draft.targetEntity,
            description: draft.description,
            change_payload: draft.changePayload,
            shadow_result: result,
            status: ProposalStatus.PENDING,
            veto_deadline: new Date(), // immediate — past deadline triggers apply
          },
        });

        // Apply immediately
        try {
          await this.rollbackManager.apply(proposal.id);
          const shortId = proposal.id.substring(0, 5);
          this.logger.log(`Auto-applied proposal #${shortId}: ${draft.description} (${result.improved}↑ ${result.degraded}↓ +${result.avgQualityDelta.toFixed(2)})`);
        } catch (applyErr) {
          this.logger.error(`Failed to auto-apply proposal: ${applyErr.message}`);
        }
      }

      // Send findings digest (only if there are rework/blocked/error findings)
      await this.sendFindingsDigest(findings);

      // Mark processed decisions as feedback_analyzed
      await this.markAnalyzed(since);

      await this.prisma.autolearn_log.create({
        data: {
          event_type: LogEventType.CYCLE_END,
          details: {
            cycleId,
            generated: allProposals.length,
            passedShadow: testedProposals.length,
            sentToRework: findings.filter(f => f.status === 'failed_shadow').length,
            submitted: testedProposals.length,
          },
        },
      });

      this.logger.log(
        `Cycle ${cycleId} complete: ${allProposals.length} generated, ${testedProposals.length} passed shadow, ${findings.filter(f => f.status === 'failed_shadow').length} sent to rework`,
      );
    } catch (err) {
      this.logger.error(`Hourly cycle failed: ${err.message}`, err.stack);
    }
  }

  @Cron('*/30 * * * *')
  async applyApprovedProposals(): Promise<void> {
    const enabled = await this.configManager.getBool('autolearn.enabled');
    if (!enabled) return;

    // Find proposals past veto deadline that are still pending
    const now = new Date();
    const readyToApply = await this.prisma.autolearn_proposal.findMany({
      where: {
        status: ProposalStatus.PENDING,
        veto_deadline: { lte: now },
      },
    });

    for (const proposal of readyToApply) {
      await this.rollbackManager.apply(proposal.id);
    }

    // Expire old pending proposals (>24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await this.prisma.autolearn_proposal.updateMany({
      where: {
        status: ProposalStatus.PENDING,
        created_at: { lt: oneDayAgo },
      },
      data: { status: ProposalStatus.EXPIRED },
    });
  }

  @Cron('0 * * * *')
  async monitorPostChangeQuality(): Promise<void> {
    const enabled = await this.configManager.getBool('autolearn.enabled');
    if (!enabled) return;

    await this.rollbackManager.checkDegradation();
  }

  @Cron('0 9 * * *')
  async sendDailySummary(): Promise<void> {
    const enabled = await this.configManager.getBool('autolearn.enabled');
    if (!enabled) return;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const weekAgoStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Count proposals by status
    const [applied, vetoed, rolledBack, reworking, failed] = await Promise.all([
      this.prisma.autolearn_proposal.count({ where: { status: ProposalStatus.APPLIED, applied_at: { gte: yesterdayStart } } }),
      this.prisma.autolearn_proposal.count({ where: { status: ProposalStatus.VETOED, created_at: { gte: yesterdayStart } } }),
      this.prisma.autolearn_proposal.count({ where: { status: ProposalStatus.ROLLED_BACK, rolled_back_at: { gte: yesterdayStart } } }),
      this.prisma.autolearn_proposal.count({ where: { status: ProposalStatus.REWORK } }),
      this.prisma.autolearn_proposal.count({ where: { status: ProposalStatus.FAILED, created_at: { gte: yesterdayStart } } }),
    ]);

    // Quality trends
    const [todayQuality, yesterdayQuality, weekQuality] = await Promise.all([
      this.getAvgQuality(yesterdayStart, todayStart),
      this.getAvgQuality(new Date(yesterdayStart.getTime() - 24 * 60 * 60 * 1000), yesterdayStart),
      this.getAvgQuality(weekAgoStart, todayStart),
    ]);

    const qualityDayChange = todayQuality && yesterdayQuality
      ? ((todayQuality - yesterdayQuality) / yesterdayQuality * 100).toFixed(0)
      : '?';
    const qualityWeekChange = todayQuality && weekQuality
      ? ((todayQuality - weekQuality) / weekQuality * 100).toFixed(0)
      : '?';

    // Token stats
    const recentDecisions = await this.prisma.ai_decision.findMany({
      where: { created_at: { gte: yesterdayStart } },
      select: { output_summary: true },
    });
    const avgTokens = recentDecisions.length > 0
      ? Math.round(recentDecisions.reduce((s, d) => s + (d.output_summary?.length || 0) / 4, 0) / recentDecisions.length)
      : 0;

    // Funnel
    const funnelStates = await this.prisma.follow_up_state.findMany({
      where: { updated_at: { gte: yesterdayStart } },
    });
    const stages: Record<string, number> = {};
    for (const s of funnelStates) {
      stages[s.conversation_stage] = (stages[s.conversation_stage] || 0) + 1;
    }

    // Top remaining violations
    const violations = await this.prisma.validation_log.findMany({
      where: { created_at: { gte: yesterdayStart }, blocked: true },
      take: 50,
    });
    const violationTypes: Record<string, number> = {};
    for (const v of violations) {
      for (const viol of v.violations) {
        const key = viol.split(':')[0].trim();
        violationTypes[key] = (violationTypes[key] || 0) + 1;
      }
    }
    const topViolations = Object.entries(violationTypes)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([type, count]) => `${escapeMd(type)}: ${count}x`);

    const summary =
      `*AutoLearn Daily Summary*\n\n` +
      `Applied: ${applied} | Vetoed: ${vetoed} | Rolled back: ${rolledBack}\n` +
      (reworking > 0 || failed > 0 ? `Reworking: ${reworking} | Failed (needs review): ${failed}\n` : '') +
      `Quality: ${todayQuality?.toFixed(2) || '?'} (${qualityDayChange}% vs yesterday, ${qualityWeekChange}% vs 7d avg)\n` +
      `Tokens: ${avgTokens} avg/msg\n` +
      (Object.keys(stages).length > 0
        ? `Funnel: ${['inquiry', 'interested', 'ready_to_book', 'booked', 'confirmed'].map(s => `${stages[s] || 0} ${s}`).join(' → ')}\n`
        : '') +
      (topViolations.length > 0
        ? `Top violations: ${topViolations.join(', ')}\n`
        : 'No blocked violations yesterday');

    await this.telegramService.sendProactiveMessage(summary);

    await this.prisma.autolearn_log.create({
      data: {
        event_type: LogEventType.DAILY_SUMMARY,
        details: { applied, vetoed, rolledBack, reworking, failed, quality: todayQuality, tokens: avgTokens },
      },
    });
  }

  @Cron('0 8 * * 1')
  async weeklyDspyOptimization(): Promise<void> {
    if (!this.dspyService.isEnabled()) return;

    this.logger.log('Starting weekly DSPy optimization (ported from FeedbackService)...');
    try {
      const result = await this.dspyService.runOptimization('rental');
      const summary =
        `*Weekly DSPy Optimization*\n\n` +
        `*Status*: ${result.success ? 'Success' : 'Failed'}\n` +
        `*Module*: ${result.moduleType}\n` +
        `*Training Examples*: ${result.trainingExamples}\n` +
        `*Validation Quality*: ${result.validationQuality.toFixed(3)}\n` +
        `*Token Savings*: ${result.estimatedTokenSavingsPct}%\n` +
        `*Meets Target*: ${result.meetsTarget ? 'Yes' : 'No'}` +
        (result.error ? `\n*Error*: ${result.error}` : '');

      await this.telegramService.sendProactiveMessage(summary);
    } catch (err) {
      this.logger.error(`Weekly DSPy optimization failed: ${err.message}`, err.stack);
      await this.telegramService.sendProactiveMessage(
        `*Weekly DSPy Optimization Failed*\n\nError: ${err.message}`,
      );
    }
  }

  @Cron('0 4 * * *')
  async cleanupOldSnapshots(): Promise<void> {
    await this.rollbackManager.cleanupSnapshots();
  }

  @Cron('0 */2 * * *')
  async processReworkPipeline(): Promise<void> {
    const enabled = await this.configManager.getBool('autolearn.enabled');
    const paused = await this.configManager.getBool('autolearn.paused');
    if (!enabled || paused || this.isQuietHours()) return;

    try {
      const { promoted, exhausted } = await this.reworkService.processReworkQueue();

      // Send notifications for promoted (reworked) proposals
      for (const p of promoted) {
        const proposal = await this.prisma.autolearn_proposal.findUnique({ where: { id: p.id } });
        if (!proposal) continue;

        const shortId = proposal.id.substring(0, 5);
        const vetoTime = proposal.veto_deadline.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const minutesLeft = Math.round((proposal.veto_deadline.getTime() - Date.now()) / 60000);
        const shadow = proposal.shadow_result as any;

        const notificationText =
          `*\\[Reworked\\] AutoLearn Proposal #${shortId}*\n` +
          `Type: ${escapeMd(this.formatChangeType(proposal.change_type))} (${proposal.analyzer} analyzer)\n` +
          `${escapeMd('→')} ${escapeMd(p.description)}\n` +
          `Shadow: ${shadow?.replayed || '?'} tested, ${shadow?.improved || 0}↑ ${shadow?.degraded || 0}↓ ${shadow?.neutral || 0}→ (+${(shadow?.avgQualityDelta || 0).toFixed(2)} quality)\n` +
          `Auto-applies: ${vetoTime} (${minutesLeft} min)\n\n` +
          `/veto ${shortId} [reason]`;

        this.logger.log(`Reworked proposal #${shortId} promoted: ${p.description}`);
        await this.telegramService.sendProactiveMessage(notificationText);
      }

      // Notify exhausted reworks
      await this.notifyExhaustedReworks(exhausted);
    } catch (err) {
      this.logger.error(`Rework pipeline error: ${err.message}`, err.stack);
    }
  }

  // --- Public methods for Telegram commands ---

  async getStatus(): Promise<{
    enabled: boolean;
    paused: boolean;
    todayProposals: number;
    pendingProposals: number;
    reworkingProposals: number;
    failedProposals: number;
    qualityTrend: number | null;
  }> {
    const enabled = await this.configManager.getBool('autolearn.enabled');
    const paused = await this.configManager.getBool('autolearn.paused');

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayProposals, pendingProposals, reworkingProposals, failedProposals] = await Promise.all([
      this.prisma.autolearn_proposal.count({ where: { created_at: { gte: todayStart } } }),
      this.prisma.autolearn_proposal.count({ where: { status: ProposalStatus.PENDING } }),
      this.prisma.autolearn_proposal.count({ where: { status: ProposalStatus.REWORK } }),
      this.prisma.autolearn_proposal.count({ where: { status: ProposalStatus.FAILED } }),
    ]);

    const qualityTrend = await this.getAvgQuality(
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      new Date(),
    );

    return { enabled, paused, todayProposals, pendingProposals, reworkingProposals, failedProposals, qualityTrend };
  }

  async vetoProposal(shortId: string, reason?: string, vetoedBy: string = 'Daniel'): Promise<string> {
    // Find proposal by short ID prefix
    const proposals = await this.prisma.autolearn_proposal.findMany({
      where: { status: ProposalStatus.PENDING },
    });

    const proposal = proposals.find(p => p.id.startsWith(shortId));
    if (!proposal) return `No pending proposal found matching #${shortId}`;

    await this.prisma.autolearn_proposal.update({
      where: { id: proposal.id },
      data: {
        status: ProposalStatus.VETOED,
        vetoed_by: vetoedBy,
        veto_reason: reason || 'Manual veto',
      },
    });

    await this.prisma.autolearn_log.create({
      data: {
        proposal_id: proposal.id,
        event_type: LogEventType.VETOED,
        details: { reason, vetoedBy },
      },
    });

    return `Vetoed proposal #${shortId}: ${proposal.description}`;
  }

  async pause(): Promise<void> {
    await this.configManager.set('autolearn.paused', 'true');
  }

  async resume(): Promise<void> {
    await this.configManager.set('autolearn.paused', 'false');
  }

  // --- Private helpers ---

  /** AutoLearn is silent between 2 AM and 11 AM (London time) to avoid noise during sleep hours */
  private isQuietHours(): boolean {
    const now = new Date();
    // Get current hour in Europe/London timezone
    const londonHour = parseInt(
      now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }),
    );
    return londonHour >= 2 && londonHour < 11;
  }

  private async markAnalyzed(since: Date): Promise<void> {
    await this.prisma.ai_decision.updateMany({
      where: {
        feedback_analyzed: false,
        created_at: { gte: since },
        OR: [
          { was_sent: false },
          { was_sent: true, confidence: { lt: 0.7 } },
        ],
      },
      data: { feedback_analyzed: true },
    });

    await this.prisma.error_log.updateMany({
      where: {
        feedback_analyzed: false,
        created_at: { gte: since },
      },
      data: { feedback_analyzed: true },
    });
  }

  private async getAvgQuality(from: Date, to: Date): Promise<number | null> {
    const scores = await this.prisma.response_quality.findMany({
      where: { created_at: { gte: from, lt: to } },
      select: { overall_quality: true },
    });
    if (scores.length === 0) return null;
    return scores.reduce((s, q) => s + q.overall_quality, 0) / scores.length;
  }

  private async sendFindingsDigest(findings: CycleFinding[]): Promise<void> {
    const notificationsEnabled = await this.configManager.getBool('autolearn.findings_notifications');
    if (!notificationsEnabled) return;

    const passed = findings.filter(f => f.status === 'passed');
    const rework = findings.filter(f => f.status === 'failed_shadow');
    const blocked = findings.filter(f => f.status === 'blocked_safety');
    const errors = findings.filter(f => f.status === 'error');

    // Skip if everything passed (those already get individual proposal notifications)
    if (rework.length === 0 && blocked.length === 0 && errors.length === 0) return;

    const lines: string[] = ['*AutoLearn Findings Digest*\n'];
    lines.push(`${findings.length} issues detected:`);

    if (passed.length > 0) lines.push(`  ${passed.length} auto-fix ready (pending veto)`);
    if (rework.length > 0) lines.push(`  ${rework.length} sent to rework pipeline`);
    if (blocked.length > 0) lines.push(`  ${blocked.length} blocked by safety filters`);
    if (errors.length > 0) lines.push(`  ${errors.length} errored during shadow test`);

    // Show details for rework items
    if (rework.length > 0) {
      lines.push('\n*Sent to rework:*');
      for (const f of rework.slice(0, 5)) {
        const shadow = f.shadowResult;
        const shadowInfo = shadow
          ? ` (${shadow.improved}↑ ${shadow.degraded}↓ delta=${shadow.avgQualityDelta.toFixed(2)})`
          : '';
        lines.push(`  ${escapeMd('•')} ${escapeMd(f.description)}${shadowInfo}`);
      }
    }

    if (blocked.length > 0) {
      lines.push('\n*Blocked by safety:*');
      for (const f of blocked.slice(0, 3)) {
        lines.push(`  ${escapeMd('•')} ${escapeMd(f.description)} (${f.analyzer})`);
      }
    }

    this.logger.log(`AutoLearn findings: ${passed.length} passed, ${rework.length} rework, ${blocked.length} blocked, ${errors.length} errors`);

    await this.prisma.autolearn_log.create({
      data: {
        event_type: LogEventType.FINDINGS_SENT,
        details: {
          total: findings.length,
          passed: passed.length,
          rework: rework.length,
          blocked: blocked.length,
          errors: errors.length,
        },
      },
    });
    await this.telegramService.sendProactiveMessage(lines.join('\n'));
  }

  private async notifyExhaustedReworks(
    exhausted: { id: string; description: string; analyzer: string; reworkCount: number }[],
  ): Promise<void> {
    if (exhausted.length === 0) return;

    for (const item of exhausted) {
      const shortId = item.id.substring(0, 5);
      this.logger.warn(`Rework exhausted #${shortId}: ${item.description} (${item.reworkCount} attempts, analyzer: ${item.analyzer})`);
    }

    const details = exhausted.map(item => {
      const shortId = item.id.substring(0, 5);
      return `  #${shortId}: ${item.description} (${item.reworkCount} attempts, ${item.analyzer})`;
    }).join("\n");
    await this.telegramService.sendProactiveMessage(
      `⚠️ Autolearn: ${exhausted.length} proposal(s) exhausted all rework attempts\n${details}`
    );
  }

  private formatChangeType(type: string): string {
    const map: Record<string, string> = {
      rule_add: 'Rule Addition',
      rule_edit: 'Rule Edit',
      rule_deactivate: 'Rule Deactivation',
      prompt_edit: 'Prompt Edit',
      threshold_adjust: 'Threshold Adjustment',
    };
    return map[type] || type;
  }
}
