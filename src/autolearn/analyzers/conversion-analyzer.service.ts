import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GeminiService } from '../../ai/gemini.service';
import { AnalyzerType, ChangeType, ProposalDraft } from '../autolearn.types';

@Injectable()
export class ConversionAnalyzerService {
  private readonly logger = new Logger(ConversionAnalyzerService.name);

  constructor(
    private prisma: PrismaService,
    private geminiService: GeminiService,
  ) {}

  async analyze(since: Date): Promise<ProposalDraft[]> {
    const proposals: ProposalDraft[] = [];

    // Query follow_up_state for stage transitions
    const states = await this.prisma.follow_up_state.findMany({
      where: { updated_at: { gte: since } },
      include: { rental: true },
    });

    if (states.length < 3) return proposals; // Need minimum sample

    // Compute drop-off rates per stage
    const stageCounts: Record<string, number> = {};
    for (const s of states) {
      stageCounts[s.conversation_stage] = (stageCounts[s.conversation_stage] || 0) + 1;
    }

    // Expected funnel: inquiry → interested → ready_to_book → booked → confirmed
    const funnel = ['inquiry', 'interested', 'ready_to_book', 'booked', 'confirmed'];
    const funnelCounts = funnel.map(stage => ({ stage, count: stageCounts[stage] || 0 }));

    // Find high drop-off stages (>50% drop from previous)
    const dropOffs: { from: string; to: string; dropRate: number }[] = [];
    for (let i = 0; i < funnelCounts.length - 1; i++) {
      const current = funnelCounts[i].count;
      const next = funnelCounts[i + 1].count;
      if (current > 0) {
        const dropRate = 1 - (next / current);
        if (dropRate > 0.5 && current >= 3) {
          dropOffs.push({
            from: funnelCounts[i].stage,
            to: funnelCounts[i + 1].stage,
            dropRate,
          });
        }
      }
    }

    if (dropOffs.length === 0) return proposals;

    // For highest drop-off stage, fetch sample conversations
    const worstDropOff = dropOffs.sort((a, b) => b.dropRate - a.dropRate)[0];
    const stuckStates = states
      .filter(s => s.conversation_stage === worstDropOff.from)
      .slice(0, 5);

    const sampleRentalIds = stuckStates
      .map(s => s.rental_id)
      .filter(Boolean);

    let sampleConversations = '';
    if (sampleRentalIds.length > 0) {
      const decisions = await this.prisma.ai_decision.findMany({
        where: { rental_id: { in: sampleRentalIds } },
        orderBy: { created_at: 'desc' },
        take: 10,
      });
      sampleConversations = decisions
        .map(d => `INPUT: "${d.input_summary?.substring(0, 100)}"\nOUTPUT: "${d.output_summary?.substring(0, 150)}"`)
        .join('\n---\n');
    }

    // Use Sonnet to identify messaging improvements
    const prompt =
      `Conversation funnel analysis shows a ${(worstDropOff.dropRate * 100).toFixed(0)}% drop from "${worstDropOff.from}" to "${worstDropOff.to}" stage.\n\n` +
      `Funnel: ${funnelCounts.map(f => `${f.stage}: ${f.count}`).join(' → ')}\n\n` +
      `Sample conversations stuck at "${worstDropOff.from}":\n${sampleConversations || 'No samples available'}\n\n` +
      `Suggest ONE specific rule that could improve conversion from "${worstDropOff.from}" to "${worstDropOff.to}".\n` +
      `Respond with ONLY a JSON object: { "name": "rule_name", "category": "communication", "content": "specific instruction" }`;

    try {
      const geminiResponse = await this.geminiService.processAnalysis(
        prompt,
        'You are a conversion optimization specialist. Respond with valid JSON only.',
      );
      if (!geminiResponse) return proposals;
      const jsonMatch = geminiResponse.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return proposals;

      const suggestion = JSON.parse(jsonMatch[0]);
      if (suggestion.name && suggestion.content) {
        proposals.push({
          analyzer: AnalyzerType.CONVERSION,
          changeType: ChangeType.RULE_ADD,
          targetEntity: `rule:${suggestion.category || 'communication'}:${suggestion.name}`,
          description: `Improve ${worstDropOff.from}→${worstDropOff.to} conversion (${(worstDropOff.dropRate * 100).toFixed(0)}% drop)`,
          changePayload: {
            before: null,
            after: { category: suggestion.category || 'communication', name: suggestion.name, content: suggestion.content, priority: 50 },
            metadata: { dropRate: worstDropOff.dropRate, fromStage: worstDropOff.from, toStage: worstDropOff.to },
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Conversion analysis AI call failed: ${err.message}`);
    }

    return proposals;
  }
}
