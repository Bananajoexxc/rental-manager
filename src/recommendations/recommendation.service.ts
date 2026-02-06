import { Injectable, Logger } from '@nestjs/common';
import { BundleIntelligenceService } from '../bundles/bundle-intelligence.service';
import { UpsellService } from '../upsell/upsell.service';

/**
 * Unified recommendation facade.
 * Consolidates bundle intelligence and upsell logic into a single entry point
 * so callers don't need to orchestrate two services separately.
 */
@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(
    private readonly bundleIntelligenceService: BundleIntelligenceService,
    private readonly upsellService: UpsellService,
  ) {}

  /**
   * Generate all recommendations (bundles + upsells) in a single call.
   * Returns combined context string ready to inject into AI prompt.
   */
  async generateRecommendations(params: {
    message: string;
    mentionedItems: string[];
    conversationText: string;
    estimatedTotal: number;
    hasPricingIntent?: boolean;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{ bundleContext: string; upsellContext: string }> {
    const { message, mentionedItems, conversationText, estimatedTotal, hasPricingIntent, startDate, endDate } = params;

    // 1. Bundle intelligence — item-based matching
    let bundleContext = '';
    try {
      bundleContext = await this.bundleIntelligenceService.generateBundleContext(
        message,
        mentionedItems,
        startDate,
        endDate,
      );
    } catch (err) {
      this.logger.debug(`Bundle intelligence failed: ${err.message}`);
    }

    // 2. Upsell recommendations — revenue-aware, use-case-based
    let upsellContext = '';
    const shouldUpsell = this.upsellService.shouldUpsell(estimatedTotal, mentionedItems.length);
    if (shouldUpsell || hasPricingIntent) {
      try {
        const upsellMessage = await this.upsellService.generateUpsellMessage(
          mentionedItems,
          conversationText,
          estimatedTotal,
          startDate,
          endDate,
        );
        if (upsellMessage) {
          upsellContext = `\n\n--- UPSELLING GUIDANCE ---\n${upsellMessage}\n\nIncorporate these recommendations naturally into your response. Be helpful, not pushy.`;
        }
      } catch (err) {
        this.logger.debug(`Upsell generation failed: ${err.message}`);
      }
    }

    return { bundleContext, upsellContext };
  }

  /**
   * Find substitutions for unavailable items.
   */
  findItemSubstitutions(itemNames: string[]) {
    return this.bundleIntelligenceService.findItemSubstitutions(itemNames);
  }

  /**
   * Quick check: should we generate upsell recommendations?
   */
  shouldUpsell(estimatedTotal: number, itemCount: number): boolean {
    return this.upsellService.shouldUpsell(estimatedTotal, itemCount);
  }

  /**
   * Log an upsell attempt for analytics.
   */
  async logUpsellAttempt(data: {
    rentalId: string;
    itemsSuggested: string[];
    revenueBefore: number;
    priority: string;
    useCaseDetected?: string;
  }) {
    return this.upsellService.logUpsellAttempt(data);
  }

  /**
   * Update upsell outcome for analytics.
   */
  async updateUpsellOutcome(rentalId: string, itemsAccepted: string[], revenueAfter: number) {
    return this.upsellService.updateUpsellOutcome(rentalId, itemsAccepted, revenueAfter);
  }
}
