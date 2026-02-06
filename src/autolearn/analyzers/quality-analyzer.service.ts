import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GeminiService } from '../../ai/gemini.service';
import { PromptManagerService } from '../../prompts/prompt-manager.service';
import { AnalyzerType, ChangeType, ProposalDraft, SAFETY } from '../autolearn.types';

@Injectable()
export class QualityAnalyzerService {
  private readonly logger = new Logger(QualityAnalyzerService.name);

  constructor(
    private prisma: PrismaService,
    private geminiService: GeminiService,
    private promptManager: PromptManagerService,
  ) {}

  async analyze(since: Date): Promise<ProposalDraft[]> {
    const proposals: ProposalDraft[] = [];

    // Query response_quality for last hour
    const scores = await this.prisma.response_quality.findMany({
      where: { created_at: { gte: since } },
      orderBy: { created_at: 'desc' },
      take: 100,
    });

    if (scores.length < 5) return proposals; // Need minimum sample

    // Compute per-dimension averages
    const dims = {
      pricing_accuracy: { sum: 0, count: 0 },
      rule_compliance: { sum: 0, count: 0 },
      conciseness: { sum: 0, count: 0 },
      tone_match: { sum: 0, count: 0 },
    };

    for (const s of scores) {
      if (s.pricing_accuracy != null) {
        dims.pricing_accuracy.sum += s.pricing_accuracy;
        dims.pricing_accuracy.count++;
      }
      dims.rule_compliance.sum += s.rule_compliance;
      dims.rule_compliance.count++;
      dims.conciseness.sum += s.conciseness;
      dims.conciseness.count++;
      dims.tone_match.sum += s.tone_match;
      dims.tone_match.count++;
    }

    // Find dimensions trending below threshold
    const weakDimensions: { name: string; avg: number }[] = [];
    for (const [name, data] of Object.entries(dims)) {
      if (data.count === 0) continue;
      const avg = data.sum / data.count;
      if (avg < SAFETY.QUALITY_FLOOR) {
        weakDimensions.push({ name, avg });
      }
    }

    if (weakDimensions.length === 0) return proposals;

    // Map weak dimensions to prompt components
    const dimToComponent: Record<string, string> = {
      tone_match: 'communication_style',
      pricing_accuracy: 'pricing_domain',
      rule_compliance: 'critical_rules',
      conciseness: 'formatting_guide',
    };

    for (const weak of weakDimensions) {
      const componentName = dimToComponent[weak.name];
      if (!componentName) continue;
      if (SAFETY.PROTECTED_COMPONENTS.includes(componentName)) continue;

      const currentContent = await this.promptManager.getComponent(componentName);
      if (!currentContent) continue;

      // Fetch sample low-quality responses for this dimension
      const lowScores = scores
        .filter(s => {
          const val = (s as any)[weak.name];
          return val != null && val < SAFETY.QUALITY_FLOOR;
        })
        .slice(0, 5);

      const decisionIds = lowScores.map(s => s.ai_decision_id);
      const decisions = decisionIds.length > 0
        ? await this.prisma.ai_decision.findMany({
            where: { id: { in: decisionIds } },
            take: 5,
          })
        : [];

      const sampleOutputs = decisions
        .map(d => d.output_summary?.substring(0, 200))
        .filter(Boolean)
        .join('\n---\n');

      // Use Sonnet to suggest improvements
      const prompt =
        `The "${componentName}" prompt component is causing low ${weak.name} scores (avg: ${weak.avg.toFixed(2)}, target: ≥${SAFETY.QUALITY_FLOOR}).\n\n` +
        `Current component content:\n${currentContent}\n\n` +
        `Sample problematic outputs:\n${sampleOutputs || 'No samples available'}\n\n` +
        `Suggest an improved version of this component that specifically addresses the ${weak.name} issue.\n` +
        `Respond with ONLY the improved component content (no explanations, no JSON wrapper). Keep the same structure but fix the weakness.`;

      try {
        const geminiResponse = await this.geminiService.processAnalysis(
          prompt,
          'You are a prompt engineering specialist. Respond with only the improved component content.',
        );
        if (!geminiResponse) continue;
        const improved = geminiResponse.content.trim();

        if (improved.length > 50 && improved !== currentContent) {
          proposals.push({
            analyzer: AnalyzerType.QUALITY,
            changeType: ChangeType.PROMPT_EDIT,
            targetEntity: `prompt:${componentName}`,
            description: `Improve ${componentName} to raise ${weak.name} (${weak.avg.toFixed(2)} → target ≥${SAFETY.QUALITY_FLOOR})`,
            changePayload: {
              before: currentContent,
              after: improved,
              metadata: { dimension: weak.name, currentAvg: weak.avg, sampleCount: scores.length },
            },
          });
        }
      } catch (err) {
        this.logger.warn(`Quality improvement AI call failed for ${componentName}: ${err.message}`);
      }
    }

    return proposals;
  }
}
