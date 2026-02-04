import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface QualityScore {
  pricingAccuracy?: number; // 0-1
  ruleCompliance: number; // 0-1
  conciseness: number; // 0-1
  toneMatch: number; // 0-1
  overallQuality: number; // weighted average
  computedConfidence: number; // replaces hardcoded 0.8
}

export interface ScoringContext {
  account?: string; // 'dbcinema' or 'leo'
  messageType?: string; // 'welcome', 'booking_confirmed', 'message', 'pricing', 'delivery'
  responseLength?: number;
  hasPricing?: boolean;
  validationResult?: any;
}

@Injectable()
export class QualityScorerService {
  private readonly logger = new Logger(QualityScorerService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Compute multi-dimensional quality score for an AI response
   */
  async scoreResponse(
    responseText: string,
    context: ScoringContext,
    validationResult?: any,
  ): Promise<QualityScore> {
    // Score each dimension
    const pricingAccuracy = context.hasPricing
      ? await this.scorePricingAccuracy(responseText, validationResult)
      : undefined;

    const ruleCompliance = this.scoreRuleCompliance(responseText, validationResult);
    const conciseness = this.scoreConciseness(responseText, context);
    const toneMatch = this.scoreToneMatch(responseText, context);

    // Weighted average for overall quality
    const weights = {
      pricing: 0.3,
      compliance: 0.35,
      conciseness: 0.2,
      tone: 0.15,
    };

    let overallQuality: number;
    if (pricingAccuracy !== undefined) {
      // Include pricing in calculation
      overallQuality =
        pricingAccuracy * weights.pricing +
        ruleCompliance * weights.compliance +
        conciseness * weights.conciseness +
        toneMatch * weights.tone;
    } else {
      // No pricing, redistribute weights
      const adjustedWeights = {
        compliance: 0.50,
        conciseness: 0.30,
        tone: 0.20,
      };
      overallQuality =
        ruleCompliance * adjustedWeights.compliance +
        conciseness * adjustedWeights.conciseness +
        toneMatch * adjustedWeights.tone;
    }

    // Computed confidence based on quality scores
    const computedConfidence = this.computeConfidence(
      overallQuality,
      ruleCompliance,
      validationResult,
    );

    return {
      pricingAccuracy,
      ruleCompliance,
      conciseness,
      toneMatch,
      overallQuality,
      computedConfidence,
    };
  }

  /**
   * Score pricing accuracy (0-1)
   * Based on validation results and price reasonableness
   */
  private async scorePricingAccuracy(
    text: string,
    validationResult?: any,
  ): Promise<number> {
    let score = 1.0;

    // Check validation for pricing violations
    if (validationResult && validationResult.violations) {
      const pricingViolations = validationResult.violations.filter((v: string) =>
        v.toLowerCase().includes('pricing') || v.toLowerCase().includes('price')
      );

      // Deduct for each pricing violation
      score -= pricingViolations.length * 0.3;
    }

    // Ensure score stays in [0, 1]
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Score rule compliance (0-1)
   * Based on validation pass/fail
   */
  private scoreRuleCompliance(text: string, validationResult?: any): number {
    if (!validationResult) {
      // No validation run, assume compliant
      return 0.8; // Default moderate score
    }

    if (validationResult.passed) {
      return 1.0; // Perfect compliance
    }

    // Calculate based on severity and number of violations
    const severityWeights: Record<string, number> = {
      critical: 0.5,
      high: 0.15,
      medium: 0.08,
      low: 0.03,
    };

    const deduction = severityWeights[validationResult.severity] || 0.1;
    const violationCount = validationResult.violations?.length || 1;

    const score = 1.0 - (deduction * Math.min(violationCount, 3)); // Cap at 3 violations
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Score conciseness (0-1)
   * Appropriate length for message type
   */
  private scoreConciseness(text: string, context: ScoringContext): number {
    const wordCount = text.split(/\s+/).length;
    const paragraphCount = text.split(/\n\n+/).length;

    // Ideal ranges by message type
    const idealRanges: Record<string, { min: number; max: number; ideal: number }> = {
      welcome: { min: 80, max: 200, ideal: 120 },
      booking_confirmed: { min: 60, max: 150, ideal: 90 },
      message: { min: 20, max: 100, ideal: 50 },
      pricing: { min: 30, max: 120, ideal: 60 },
      delivery: { min: 40, max: 130, ideal: 70 },
    };

    const messageType = context.messageType || 'message';
    const range = idealRanges[messageType] || idealRanges.message;

    // Score based on distance from ideal
    let score = 1.0;
    if (wordCount < range.min) {
      // Too short
      const shortness = (range.min - wordCount) / range.min;
      score -= shortness * 0.4;
    } else if (wordCount > range.max) {
      // Too long
      const excess = (wordCount - range.max) / range.max;
      score -= Math.min(excess * 0.5, 0.6); // Cap penalty
    } else {
      // In acceptable range, score based on proximity to ideal
      const distance = Math.abs(wordCount - range.ideal) / range.ideal;
      score = 1.0 - (distance * 0.2); // Small penalty for deviation from ideal
    }

    // Bonus for good paragraph structure (not wall of text)
    if (wordCount > 60 && paragraphCount >= 2 && wordCount / paragraphCount < 50) {
      score += 0.05; // Small bonus for readability
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Score tone match (0-1)
   * Does the response match the account's communication style?
   */
  private scoreToneMatch(text: string, context: ScoringContext): number {
    const account = context.account || 'dbcinema';

    if (account === 'dbcinema') {
      return this.scoreDBCinemaTone(text);
    } else {
      return this.scoreLeoAdamsTone(text);
    }
  }

  /**
   * Score DB Cinema tone: Professional, concise, human
   */
  private scoreDBCinemaTone(text: string): number {
    let score = 0.7; // Base score

    // Professional markers (positive)
    const professionalMarkers = [
      /\b(confirmed|verified|booking|available|location|address)\b/i,
      /\bhttps?:\/\//i, // Links
      /\d{1,2}(am|pm|-\d{1,2}(am|pm))/i, // Times
    ];

    for (const marker of professionalMarkers) {
      if (marker.test(text)) {
        score += 0.05;
      }
    }

    // Conciseness (positive)
    const wordCount = text.split(/\s+/).length;
    if (wordCount >= 30 && wordCount <= 120) {
      score += 0.1;
    }

    // Avoid overly casual (negative)
    const tooChillMarkers = /\b(cool|awesome|dude|mate|gonna|wanna|btw)\b/i;
    if (tooChillMarkers.test(text)) {
      score -= 0.15;
    }

    // Avoid being too robotic (negative)
    const roboticMarkers = /\b(as per|kindly note|hereby|furthermore|moreover)\b/i;
    if (roboticMarkers.test(text)) {
      score -= 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Score Leo Adams tone: Human, kind, slightly chill
   */
  private scoreLeoAdamsTone(text: string): number {
    let score = 0.7; // Base score

    // Friendly markers (positive)
    const friendlyMarkers = [
      /\b(hey|thanks|thx|cheers|sounds good|no worries|let me know)\b/i,
      /\b(I'll|I'm|I'd)\b/, // First person
    ];

    for (const marker of friendlyMarkers) {
      if (marker.test(text)) {
        score += 0.07;
      }
    }

    // Appropriate casualness (positive)
    const casualMarkers = /\b(cool|great|perfect|nice|awesome)\b/i;
    if (casualMarkers.test(text)) {
      score += 0.08;
    }

    // Avoid being too formal (negative)
    const tooFormalMarkers = /\b(kindly|hereby|as per|furthermore|please be advised)\b/i;
    if (tooFormalMarkers.test(text)) {
      score -= 0.15;
    }

    // Maintain professionalism (negative if too casual)
    const unprofessionalMarkers = /\b(lol|lmao|bruh|dude|innit)\b/i;
    if (unprofessionalMarkers.test(text)) {
      score -= 0.2;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Compute overall confidence score (0-1)
   * Replaces hardcoded 0.75/0.8 values
   */
  private computeConfidence(
    overallQuality: number,
    ruleCompliance: number,
    validationResult?: any,
  ): number {
    // Start with overall quality
    let confidence = overallQuality;

    // Boost confidence if validation passed
    if (validationResult && validationResult.passed) {
      confidence = Math.min(confidence + 0.1, 1.0);
    }

    // Reduce confidence if critical violations
    if (validationResult && validationResult.severity === 'critical') {
      confidence *= 0.5; // Halve confidence
    } else if (validationResult && validationResult.severity === 'high') {
      confidence *= 0.7;
    }

    // Ensure rule compliance heavily influences confidence
    confidence = (confidence * 0.6) + (ruleCompliance * 0.4);

    return Math.max(0.1, Math.min(1, confidence)); // Keep in [0.1, 1.0]
  }

  /**
   * Store quality score to database
   */
  async storeQualityScore(
    aiDecisionId: string,
    score: QualityScore,
  ): Promise<void> {
    try {
      await this.prisma.response_quality.create({
        data: {
          ai_decision_id: aiDecisionId,
          pricing_accuracy: score.pricingAccuracy,
          rule_compliance: score.ruleCompliance,
          conciseness: score.conciseness,
          tone_match: score.toneMatch,
          overall_quality: score.overallQuality,
          computed_confidence: score.computedConfidence,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to store quality score: ${error.message}`);
    }
  }

  /**
   * Get quality statistics
   */
  async getQualityStats(days: number = 7): Promise<{
    averageOverallQuality: number;
    averageConfidence: number;
    lowQualityCount: number;
    dimensionAverages: {
      pricingAccuracy?: number;
      ruleCompliance: number;
      conciseness: number;
      toneMatch: number;
    };
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const scores = await this.prisma.response_quality.findMany({
      where: { created_at: { gte: since } },
    });

    if (scores.length === 0) {
      return {
        averageOverallQuality: 0,
        averageConfidence: 0,
        lowQualityCount: 0,
        dimensionAverages: {
          ruleCompliance: 0,
          conciseness: 0,
          toneMatch: 0,
        },
      };
    }

    const sum = scores.reduce(
      (acc, s) => ({
        overall: acc.overall + s.overall_quality,
        confidence: acc.confidence + s.computed_confidence,
        pricing: acc.pricing + (s.pricing_accuracy || 0),
        compliance: acc.compliance + s.rule_compliance,
        conciseness: acc.conciseness + s.conciseness,
        tone: acc.tone + s.tone_match,
      }),
      { overall: 0, confidence: 0, pricing: 0, compliance: 0, conciseness: 0, tone: 0 },
    );

    const pricingScores = scores.filter(s => s.pricing_accuracy !== null);

    return {
      averageOverallQuality: sum.overall / scores.length,
      averageConfidence: sum.confidence / scores.length,
      lowQualityCount: scores.filter(s => s.overall_quality < 0.7).length,
      dimensionAverages: {
        pricingAccuracy: pricingScores.length > 0 ? sum.pricing / pricingScores.length : undefined,
        ruleCompliance: sum.compliance / scores.length,
        conciseness: sum.conciseness / scores.length,
        toneMatch: sum.tone / scores.length,
      },
    };
  }
}
