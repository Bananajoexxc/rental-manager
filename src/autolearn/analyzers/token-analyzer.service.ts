import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GeminiService } from '../../ai/gemini.service';
import { PromptManagerService } from '../../prompts/prompt-manager.service';
import { AnalyzerType, ChangeType, ProposalDraft, SAFETY } from '../autolearn.types';

@Injectable()
export class TokenAnalyzerService {
  private readonly logger = new Logger(TokenAnalyzerService.name);

  constructor(
    private prisma: PrismaService,
    private geminiService: GeminiService,
    private promptManager: PromptManagerService,
  ) {}

  async analyze(since: Date): Promise<ProposalDraft[]> {
    const proposals: ProposalDraft[] = [];

    // Query ai_decision for token counts
    const decisions = await this.prisma.ai_decision.findMany({
      where: { created_at: { gte: since } },
      select: { id: true, input_summary: true, output_summary: true, created_at: true },
      orderBy: { created_at: 'desc' },
      take: 100,
    });

    if (decisions.length < 10) return proposals; // Need minimum sample

    // Estimate tokens from text length (rough: 1 token ≈ 4 chars)
    const tokenEstimates = decisions.map(d => ({
      id: d.id,
      inputTokens: Math.ceil((d.input_summary?.length || 0) / 4),
      outputTokens: Math.ceil((d.output_summary?.length || 0) / 4),
    }));

    const avgOutputTokens = tokenEstimates.reduce((s, t) => s + t.outputTokens, 0) / tokenEstimates.length;

    // Find verbose prompt components (long relative to pass_rate)
    const components = await this.prisma.prompt_component.findMany({
      where: { active: true },
    });

    const bloatedComponents = components
      .filter(c => !SAFETY.PROTECTED_COMPONENTS.includes(c.name))
      .filter(c => {
        const words = c.content.split(/\s+/).length;
        const passRate = c.pass_rate ?? 1;
        // Flag components that are >200 words with pass_rate < 0.8
        return words > 200 && passRate < 0.8;
      })
      .sort((a, b) => b.content.split(/\s+/).length - a.content.split(/\s+/).length)
      .slice(0, 2);

    for (const component of bloatedComponents) {
      const wordCount = component.content.split(/\s+/).length;

      const prompt =
        `This prompt component "${component.name}" is ${wordCount} words with a ${((component.pass_rate ?? 1) * 100).toFixed(0)}% pass rate.\n` +
        `Average response is ${avgOutputTokens.toFixed(0)} tokens. We need to reduce token usage.\n\n` +
        `Current content:\n${component.content}\n\n` +
        `Compress this to under ${Math.ceil(wordCount * 0.7)} words while preserving ALL rules and instructions. ` +
        `Remove redundancy, use shorter phrasing, eliminate examples that don't add value.\n` +
        `Respond with ONLY the compressed content.`;

      try {
        const geminiResponse = await this.geminiService.processAnalysis(
          prompt,
          'You are a prompt compression specialist. Respond with only the compressed content.',
        );
        if (!geminiResponse) continue;
        const compressed = geminiResponse.content.trim();
        const newWordCount = compressed.split(/\s+/).length;

        if (newWordCount < wordCount * 0.85 && compressed.length > 50) {
          proposals.push({
            analyzer: AnalyzerType.TOKEN,
            changeType: ChangeType.PROMPT_EDIT,
            targetEntity: `prompt:${component.name}`,
            description: `Compress ${component.name}: ${wordCount}→${newWordCount} words (${((1 - newWordCount / wordCount) * 100).toFixed(0)}% reduction)`,
            changePayload: {
              before: component.content,
              after: compressed,
              metadata: { originalWords: wordCount, compressedWords: newWordCount, passRate: component.pass_rate },
            },
          });
        }
      } catch (err) {
        this.logger.warn(`Token compression AI call failed for ${component.name}: ${err.message}`);
      }
    }

    return proposals;
  }
}
