import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeminiService } from '../ai/gemini.service';
import { AnalyzerType, ChangeType, ProposalDraft, LogEventType } from './autolearn.types';

@Injectable()
export class CorrectionDetectorService {
  private readonly logger = new Logger(CorrectionDetectorService.name);

  // Teaching signal patterns — detect when Daniel is correcting the bot
  private readonly teachingPatterns = [
    /\bdon'?t\s+say\b/i,
    /\bnever\s+(?:say|tell|mention|reveal|share)\b/i,
    /\balways\s+(?:say|mention|include|add|use)\b/i,
    /\bwrong\b/i,
    /\bshould\s+be\b/i,
    /\bfix\s+this\b/i,
    /\bfrom\s+now\s+on\b/i,
    /\bthat\s+response\s+was\s+bad\b/i,
    /\bmake\s+sure\s+to\b/i,
    /\bremember\s+to\b/i,
    /\bstop\s+(?:saying|doing|mentioning)\b/i,
    /\binstead\s+(?:say|use|do)\b/i,
    /\bnot\s+like\s+that\b/i,
    /\bthat'?s\s+not\s+(?:right|correct|how)\b/i,
    /\bchange\s+(?:it|this|that)\s+to\b/i,
  ];

  constructor(
    private prisma: PrismaService,
    private geminiService: GeminiService,
  ) {}

  /**
   * Check if a message contains teaching signals from Daniel
   * @param text The message text
   * @param isExplicit If true, this came from /improve mode (skip veto)
   * @returns ProposalDraft if teaching signal detected, null otherwise
   */
  async processMessage(text: string, isExplicit: boolean): Promise<ProposalDraft | null> {
    // Skip very short messages
    if (text.length < 10) return null;

    // Check for teaching patterns
    const matchedPatterns = this.teachingPatterns.filter(p => p.test(text));
    if (matchedPatterns.length === 0) return null;

    this.logger.log(`Teaching signal detected (${matchedPatterns.length} patterns): "${text.substring(0, 80)}"`);

    // Log detection in autolearn_log
    await this.prisma.autolearn_log.create({
      data: {
        event_type: isExplicit ? LogEventType.APPLIED : 'correction_detected',
        details: {
          text: text.substring(0, 500),
          patterns: matchedPatterns.length,
          isExplicit,
        },
      },
    });

    // For explicit /improve mode, don't create a proposal (handled by existing flow)
    if (isExplicit) return null;

    // Use Sonnet to classify and generate a rule
    try {
      const prompt =
        `Daniel (the owner) sent this message as a correction/teaching signal:\n"${text}"\n\n` +
        `Generate a business rule from this instruction.\n` +
        `Respond with ONLY a JSON object:\n` +
        `{ "name": "short_rule_name", "category": "communication|pricing|policy|disclosure|scheduling|general", "content": "clear actionable rule text" }`;

      const geminiResponse = await this.geminiService.processAnalysis(
        prompt,
        'You are a business rules analyst. Respond with valid JSON only.',
      );
      if (!geminiResponse) return null;
      const jsonMatch = geminiResponse.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const suggestion = JSON.parse(jsonMatch[0]);
      if (!suggestion.name || !suggestion.content) return null;

      return {
        analyzer: AnalyzerType.CORRECTION,
        changeType: ChangeType.RULE_ADD,
        targetEntity: `rule:${suggestion.category || 'general'}:${suggestion.name}`,
        description: `Daniel's correction: ${text.substring(0, 100)}`,
        changePayload: {
          before: null,
          after: { category: suggestion.category || 'general', name: suggestion.name, content: suggestion.content, priority: 8 },
          metadata: { source: 'daniel_correction', originalText: text },
        },
      };
    } catch (err) {
      this.logger.warn(`Correction detection AI call failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Get unprocessed corrections from recent conversations
   */
  async getRecentCorrections(since: Date): Promise<ProposalDraft[]> {
    // Query recent owner conversations that match teaching patterns
    const ownerMessages = await this.prisma.conversation.findMany({
      where: {
        role: 'user',
        created_at: { gte: since },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });

    const proposals: ProposalDraft[] = [];
    for (const msg of ownerMessages) {
      const result = await this.processMessage(msg.content, false);
      if (result) {
        proposals.push(result);
      }
    }

    return proposals;
  }
}
