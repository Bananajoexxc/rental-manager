import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeminiService } from '../ai/gemini.service';
import { ShadowTesterService } from './shadow-tester.service';
import { ConfigManagerService } from './config-manager.service';
import {
  ProposalDraft,
  ProposalStatus,
  LogEventType,
  SAFETY,
} from './autolearn.types';
import { randomUUID } from 'crypto';

@Injectable()
export class ReworkService {
  private readonly logger = new Logger(ReworkService.name);

  constructor(
    private prisma: PrismaService,
    private geminiService: GeminiService,
    private shadowTester: ShadowTesterService,
    private configManager: ConfigManagerService,
  ) {}

  /**
   * Fetch REWORK proposals under the attempt limit and process up to MAX_REWORKS_PER_RUN.
   * Returns arrays of promoted (shadow-passed) and exhausted (max attempts reached) proposal IDs.
   */
  async processReworkQueue(): Promise<{
    promoted: { id: string; parentId: string; description: string }[];
    exhausted: { id: string; description: string; analyzer: string; reworkCount: number }[];
  }> {
    const maxAttempts = await this.configManager.getInt('autolearn.max_rework_attempts');

    const queue = await this.prisma.autolearn_proposal.findMany({
      where: {
        status: ProposalStatus.REWORK,
        rework_count: { lt: maxAttempts },
      },
      orderBy: { created_at: 'asc' },
      take: SAFETY.MAX_REWORKS_PER_RUN,
    });

    if (queue.length === 0) return { promoted: [], exhausted: [] };

    this.logger.log(`Processing ${queue.length} rework proposals`);

    const promoted: { id: string; parentId: string; description: string }[] = [];
    const exhausted: { id: string; description: string; analyzer: string; reworkCount: number }[] = [];

    for (const proposal of queue) {
      try {
        const reworked = await this.generateRework(proposal);

        if (!reworked) {
          await this.incrementAttempt(proposal, 'AI failed to generate reworked proposal');
          if (proposal.rework_count + 1 >= maxAttempts) {
            await this.markExhausted(proposal.id, 'AI could not generate a viable rework');
            exhausted.push({
              id: proposal.id,
              description: proposal.description,
              analyzer: proposal.analyzer,
              reworkCount: proposal.rework_count + 1,
            });
          }
          continue;
        }

        // Shadow test the reworked version
        const shadowResult = await this.shadowTester.test(reworked);

        if (shadowResult.improved > shadowResult.degraded && shadowResult.avgQualityDelta > 0) {
          // Shadow passed — create and auto-apply immediately
          const newProposal = await this.prisma.autolearn_proposal.create({
            data: {
              cycle_id: randomUUID(),
              analyzer: reworked.analyzer,
              change_type: reworked.changeType,
              target_entity: reworked.targetEntity,
              description: reworked.description,
              change_payload: reworked.changePayload,
              shadow_result: shadowResult as any,
              status: ProposalStatus.PENDING,
              veto_deadline: new Date(), // immediate
              parent_id: proposal.id,
            },
          });

          await this.prisma.autolearn_proposal.update({
            where: { id: proposal.id },
            data: { status: ProposalStatus.EXPIRED },
          });

          await this.prisma.autolearn_log.create({
            data: {
              proposal_id: newProposal.id,
              event_type: LogEventType.REWORK_SUCCESS,
              details: {
                originalId: proposal.id,
                attempt: proposal.rework_count + 1,
                shadowResult: shadowResult as any,
              },
            },
          });

          promoted.push({
            id: newProposal.id,
            parentId: proposal.id,
            description: reworked.description,
          });

          this.logger.log(
            `Rework succeeded for proposal ${proposal.id.substring(0, 5)}: ${shadowResult.improved}up ${shadowResult.degraded}down`,
          );
        } else {
          // Shadow failed again — increment attempt
          await this.incrementAttempt(proposal, `Shadow failed: ${shadowResult.improved}up ${shadowResult.degraded}down delta=${shadowResult.avgQualityDelta.toFixed(3)}`, shadowResult);

          if (proposal.rework_count + 1 >= maxAttempts) {
            await this.markExhausted(
              proposal.id,
              `Exhausted after ${proposal.rework_count + 1} attempts. Last shadow: ${shadowResult.improved}up ${shadowResult.degraded}down`,
            );
            exhausted.push({
              id: proposal.id,
              description: proposal.description,
              analyzer: proposal.analyzer,
              reworkCount: proposal.rework_count + 1,
            });
          }

          this.logger.log(
            `Rework attempt ${proposal.rework_count + 1} failed for ${proposal.id.substring(0, 5)}: ${shadowResult.improved}up ${shadowResult.degraded}down`,
          );
        }
      } catch (err) {
        this.logger.error(`Rework processing error for ${proposal.id.substring(0, 5)}: ${err.message}`);
        await this.incrementAttempt(proposal, `Error: ${err.message}`);
        if (proposal.rework_count + 1 >= (await this.configManager.getInt('autolearn.max_rework_attempts'))) {
          await this.markExhausted(proposal.id, `Error during rework: ${err.message}`);
          exhausted.push({
            id: proposal.id,
            description: proposal.description,
            analyzer: proposal.analyzer,
            reworkCount: proposal.rework_count + 1,
          });
        }
      }
    }

    return { promoted, exhausted };
  }

  /**
   * Use Sonnet to analyze why the shadow test failed and generate an improved proposal.
   */
  private async generateRework(proposal: any): Promise<ProposalDraft | null> {
    const failedShadow = proposal.failed_shadow || proposal.shadow_result;
    const previousReason = proposal.rework_reason;

    const prompt = [
      'You are an AI system improvement analyst. A proposed rule change failed shadow testing.',
      '',
      `Analyzer: ${proposal.analyzer}`,
      `Change type: ${proposal.change_type}`,
      `Target: ${proposal.target_entity}`,
      `Description: ${proposal.description}`,
      `Attempt: ${proposal.rework_count + 1}`,
      '',
      `Original change payload:`,
      JSON.stringify(proposal.change_payload, null, 2),
      '',
      `Shadow test result (FAILED):`,
      JSON.stringify(failedShadow, null, 2),
      '',
      previousReason ? `Previous rework reason: ${previousReason}` : '',
      '',
      'Analyze WHY the shadow test failed. The change either degraded responses or had no positive effect.',
      'Generate an IMPROVED version of the change that addresses the failure.',
      '',
      'Respond in JSON format:',
      '{',
      '  "analysis": "why the previous attempt failed",',
      '  "improved_description": "what the new change does differently",',
      '  "improved_payload": { "before": ..., "after": ..., "metadata": { "rework_analysis": "..." } }',
      '}',
    ].join('\n');

    try {
      const geminiResponse = await this.geminiService.processAnalysis(
        prompt,
        'AUTOLEARN REWORK — generate improved rule proposal. Respond with valid JSON only.',
      );
      if (!geminiResponse) return null;

      const jsonMatch = geminiResponse.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.improved_description || !parsed.improved_payload) return null;

      return {
        analyzer: proposal.analyzer as any,
        changeType: proposal.change_type as any,
        targetEntity: proposal.target_entity,
        description: `[Reworked] ${parsed.improved_description}`,
        changePayload: parsed.improved_payload,
      };
    } catch (err) {
      this.logger.warn(`Failed to generate rework for ${proposal.id.substring(0, 5)}: ${err.message}`);
      return null;
    }
  }

  private async incrementAttempt(proposal: any, reason: string, shadowResult?: any): Promise<void> {
    const updateData: any = {
      rework_count: proposal.rework_count + 1,
      rework_reason: reason,
    };
    if (shadowResult) {
      updateData.failed_shadow = shadowResult;
    }

    await this.prisma.autolearn_proposal.update({
      where: { id: proposal.id },
      data: updateData,
    });

    await this.prisma.autolearn_log.create({
      data: {
        proposal_id: proposal.id,
        event_type: LogEventType.REWORK_ATTEMPT,
        details: {
          attempt: proposal.rework_count + 1,
          reason,
          shadowResult: shadowResult || null,
        },
      },
    });
  }

  async markExhausted(proposalId: string, reason: string): Promise<void> {
    await this.prisma.autolearn_proposal.update({
      where: { id: proposalId },
      data: {
        status: ProposalStatus.FAILED,
        rework_reason: reason,
      },
    });

    await this.prisma.autolearn_log.create({
      data: {
        proposal_id: proposalId,
        event_type: LogEventType.REWORK_EXHAUSTED,
        details: { reason },
      },
    });
  }
}
