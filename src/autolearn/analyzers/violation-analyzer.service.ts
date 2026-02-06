import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GeminiService } from '../../ai/gemini.service';
import { RulesService } from '../../rules/rules.service';
import { AnalyzerType, ChangeType, ProposalDraft, SAFETY } from '../autolearn.types';

@Injectable()
export class ViolationAnalyzerService {
  private readonly logger = new Logger(ViolationAnalyzerService.name);

  constructor(
    private prisma: PrismaService,
    private geminiService: GeminiService,
    private rulesService: RulesService,
  ) {}

  async analyze(since: Date): Promise<ProposalDraft[]> {
    const proposals: ProposalDraft[] = [];

    // Query validation_log for last hour
    const validationLogs = await this.prisma.validation_log.findMany({
      where: { created_at: { gte: since } },
      orderBy: { created_at: 'desc' },
      take: 200,
    });

    if (validationLogs.length === 0) return proposals;

    // Group recurring violations (3+ occurrences)
    const violationCounts: Record<string, { count: number; samples: string[] }> = {};
    for (const log of validationLogs) {
      for (const violation of log.violations) {
        const key = this.normalizeViolation(violation);
        if (!violationCounts[key]) {
          violationCounts[key] = { count: 0, samples: [] };
        }
        violationCounts[key].count++;
        if (violationCounts[key].samples.length < 3) {
          violationCounts[key].samples.push(log.response_text.substring(0, 150));
        }
      }
    }

    // Filter to recurring violations only
    const recurring = Object.entries(violationCounts)
      .filter(([, v]) => v.count >= SAFETY.MIN_VIOLATIONS_FOR_RULE)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 5);

    if (recurring.length === 0) return proposals;

    // Fetch existing rules for dedup
    const existingRules = await this.rulesService.getAllActive();
    const existingRuleNames = new Set(existingRules.map(r => r.name.toLowerCase()));
    const existingRuleContents = existingRules.map(r => r.content.toLowerCase());

    // Use Sonnet to generate corrective rules
    const prompt =
      `You are a quality control system for a rental equipment chatbot. Analyze these recurring validation failures and generate corrective rules.\n\n` +
      `EXISTING RULES (do NOT duplicate):\n${existingRules.map(r => `- [${r.category}] ${r.name}: ${r.content.substring(0, 80)}`).join('\n')}\n\n` +
      `RECURRING VIOLATIONS:\n${recurring.map(([pattern, data]) => `- "${pattern}" (${data.count}x)\n  Samples: ${data.samples.map(s => `"${s}"`).join(', ')}`).join('\n')}\n\n` +
      `For each violation pattern, generate a corrective rule. Respond with ONLY a JSON array:\n` +
      `[{ "name": "short_rule_name", "category": "communication|disclosure|security|policy|pricing", "content": "specific actionable instruction", "pattern": "which violation this fixes" }]\n` +
      `If no new rules needed, respond with []. Do NOT suggest rules that already exist or are too vague.`;

    try {
      const geminiResponse = await this.geminiService.processAnalysis(
        prompt,
        'You are a quality control system for a rental chatbot. Respond with valid JSON arrays only.',
      );
      if (!geminiResponse) return proposals;
      const jsonMatch = geminiResponse.content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return proposals;

      const suggestions = JSON.parse(jsonMatch[0]);

      for (const rule of suggestions) {
        if (!rule.name || !rule.content || !rule.category) continue;
        if (existingRuleNames.has(rule.name.toLowerCase())) continue;
        if (this.isDuplicate(rule.content, existingRuleContents)) continue;

        proposals.push({
          analyzer: AnalyzerType.VIOLATION,
          changeType: ChangeType.RULE_ADD,
          targetEntity: `rule:${rule.category}:${rule.name}`,
          description: `Add rule to prevent: ${rule.pattern || rule.name}`,
          changePayload: {
            before: null,
            after: { category: rule.category, name: rule.name, content: rule.content, priority: 50 },
            metadata: { violationCount: violationCounts[rule.pattern]?.count || 0, pattern: rule.pattern },
          },
        });
      }
    } catch (err) {
      this.logger.warn(`AI analysis failed: ${err.message}`);
    }

    return proposals;
  }

  private normalizeViolation(violation: string): string {
    // Normalize to category level for grouping
    return violation.split(':')[0].trim().toLowerCase();
  }

  private isDuplicate(content: string, existingContents: string[]): boolean {
    const words = new Set(content.toLowerCase().split(/\s+/));
    return existingContents.some(existing => {
      const existingWords = new Set(existing.split(/\s+/));
      const intersection = [...words].filter(w => existingWords.has(w));
      return intersection.length / Math.min(words.size, existingWords.size) > 0.6;
    });
  }
}
