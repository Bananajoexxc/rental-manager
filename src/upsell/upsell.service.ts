import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface UpsellRecommendation {
  items: string[];
  reasoning: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  questionsToAsk?: string[];
}

interface RevenueContext {
  currentTotal: number;
  isUnderMinimum: boolean; // Under £25
  nearDiscount: boolean; // Close to £250 or £500
  discountTier?: 'none' | '10_percent' | '17_percent';
  discountMessage?: string;
  upsellUrgency: 'critical' | 'aggressive' | 'moderate' | 'gentle';
}

interface ItemCategory {
  name: string;
  category: 'camera' | 'lens' | 'audio' | 'lighting' | 'gimbal' | 'monitor' | 'drone' | 'other';
  averagePrice: number;
}

@Injectable()
export class UpsellService {
  private readonly logger = new Logger(UpsellService.name);

  // Complementary item mappings
  private readonly complementaryItems = {
    camera: {
      essential: ['ND filter', 'Cinebloom filter mist', 'Rode Wireless Mic Pro set'],
      recommended: ['DJI RS3 Pro gimbal', 'Atomos Ninja V', 'Tilta Nucleus Nano 2 follow focus'],
      reasoning: {
        filters: "ND filter lets you shoot wide open in daylight - essential for cinema work. Cinebloom adds that cinematic glow",
        audio: "Most shoots need clean audio - wireless mic pairs perfectly with this camera",
        stabilization: "Want smooth footage? A gimbal would work great with this setup",
        monitoring: "External monitor helps nail focus and exposure on set",
      }
    },
    lens: {
      essential: ['ND filter', 'Cinebloom filter mist'],
      recommended: ['Tilta Nucleus Nano 2 follow focus', 'camera'],
      reasoning: {
        filters: "ND filter is a must for shooting wide open outdoors. Cinebloom mist gives you that dreamy cinematic look",
        support: "Follow focus completes the cinema setup",
      }
    },
    audio: {
      essential: ['Audio boom mic Sennheiser', 'DJI Wireless Mics'],
      recommended: [],
      reasoning: {
        boom: "Need a boom mic for overhead placement",
        recorder: "Dedicated boom mic gives you backup audio + better quality",
      }
    },
    gimbal: {
      essential: ['camera', 'lens'],
      recommended: ['Rode Wireless Mic Pro set', 'Atomos Ninja V'],
      reasoning: {
        complete: "Gimbal works best with a balanced camera + lens combo",
        audio: "Wireless mic keeps audio clean while moving on the gimbal",
      }
    },
    lighting: {
      essential: ['C-stand', 'LED light panels RGB'],
      recommended: ['5-in-1 reflector panel'],
      reasoning: {
        support: "Need stands and modifiers to shape the light properly",
        multi: "3-point lighting setup makes a huge difference - consider adding another light",
      }
    },
    drone: {
      essential: ['Sony NPF 970 batteries 2x sets', 'ND filter'],
      recommended: [],
      reasoning: {
        batteries: "Drone batteries run out fast - extras are essential",
        filters: "ND filters are crucial for cinematic drone footage",
      }
    },
  };

  // Use case detection patterns
  private readonly useCasePatterns = {
    interview: {
      keywords: /\b(interview|podcast|talking head|sit down|conversation)\b/i,
      recommendations: ['Rode Wireless Mic Pro set', 'LED light panels RGB', 'Softbox 85cm'],
      reasoning: "For interviews you'll want clean audio (wireless mics) and flattering lighting (LED panels/softbox)"
    },
    wedding: {
      keywords: /\b(wedding|bride|groom|ceremony|reception|marriage)\b/i,
      recommendations: ['Rode Wireless Mic Pro set', 'DJI RS3 Pro gimbal', 'Sony GM 70-200mm f2.8'],
      reasoning: "Wedding shoots need wireless mics for vows, gimbal for smooth movement, and versatile zoom lenses"
    },
    music_video: {
      keywords: /\b(music video|mv|artist|performance|band)\b/i,
      recommendations: ['DJI RS3 Pro gimbal', 'Anamorphic Great Joy 50mm', 'LED light panels RGB', 'Smoke machine fogger', 'Motorized slider'],
      reasoning: "Music videos benefit from cinematic movement (gimbal/slider), creative lighting (RGB), and shallow depth (anamorphic lenses)"
    },
    corporate: {
      keywords: /\b(corporate|business|promo|commercial|brand)\b/i,
      recommendations: ['Rode Wireless Mic Pro set', 'LED light panels RGB', 'Motorized slider'],
      reasoning: "Corporate shoots typically need clean audio, professional lighting, and smooth slider moves"
    },
    documentary: {
      keywords: /\b(documentary|doc|film|shoot|run and gun|handheld)\b/i,
      recommendations: ['Rode Wireless Mic Pro set', 'Rode Video Mic Pro Plus', 'Tilta shoulder rig', 'ND filter'],
      reasoning: "Doc work needs versatile audio (wireless + shotgun), shoulder rig for mobility, and ND filters for outdoor"
    },
    product: {
      keywords: /\b(product|commercial|tabletop|macro|ecommerce)\b/i,
      recommendations: ['LED light panels RGB', 'Softbox 85cm', '5-in-1 reflector panel'],
      reasoning: "Product shoots need controlled lighting (LED/softbox) and light shaping tools"
    },
  };

  constructor(private prisma: PrismaService) {}

  /**
   * Analyze items and conversation to generate smart upsell recommendations
   */
  async generateUpsellRecommendations(
    requestedItems: string[],
    conversationText: string,
    currentTotal: number,
  ): Promise<{
    recommendations: UpsellRecommendation;
    revenueContext: RevenueContext;
  }> {
    // Categorize requested items
    const itemCategories = this.categorizeItems(requestedItems);

    // Detect use case from conversation
    const useCase = this.detectUseCase(conversationText);

    // Calculate revenue context
    const revenueContext = this.analyzeRevenueContext(currentTotal);

    // Generate recommendations based on all factors
    const recommendations = this.buildRecommendations(
      itemCategories,
      useCase,
      revenueContext,
      conversationText,
    );

    return { recommendations, revenueContext };
  }

  /**
   * Categorize items by type
   */
  private categorizeItems(items: string[]): ItemCategory[] {
    const categories: ItemCategory[] = [];

    for (const item of items) {
      const normalized = item.toLowerCase();

      let category: ItemCategory['category'] = 'other';
      let averagePrice = 50;

      if (/\b(fx3|camera|bmpcc|a7|fujifilm|x100|gopro|osmo)\b/i.test(item)) {
        category = 'camera';
        averagePrice = 80;
      } else if (/\b(lens|mm|prime|zoom|sony|canon|blazar|remus|great joy|anamorphic)\b/i.test(item)) {
        category = 'lens';
        averagePrice = 40;
      } else if (/\b(mic|microphone|audio|wireless|rode|sennheiser)\b/i.test(item)) {
        category = 'audio';
        averagePrice = 30;
      } else if (/\b(light|led|panel|softbox|nanlite|forza|pavotube|ambitful)\b/i.test(item)) {
        category = 'lighting';
        averagePrice = 35;
      } else if (/\b(gimbal|rs3|stabilizer)\b/i.test(item)) {
        category = 'gimbal';
        averagePrice = 60;
      } else if (/\b(monitor|screen|atomos|hollyland)\b/i.test(item)) {
        category = 'monitor';
        averagePrice = 45;
      } else if (/\b(drone|mavic|dji|fpv|quadcopter)\b/i.test(item)) {
        category = 'drone';
        averagePrice = 70;
      }

      categories.push({ name: item, category, averagePrice });
    }

    return categories;
  }

  /**
   * Detect what they're shooting from conversation
   */
  private detectUseCase(conversationText: string): {
    useCase: string | null;
    confidence: number;
    recommendations: string[];
    reasoning: string;
  } | null {
    for (const [useCase, pattern] of Object.entries(this.useCasePatterns)) {
      if (pattern.keywords.test(conversationText)) {
        return {
          useCase,
          confidence: 0.8,
          recommendations: pattern.recommendations,
          reasoning: pattern.reasoning,
        };
      }
    }
    return null;
  }

  /**
   * Analyze revenue and determine discount tiers
   */
  private analyzeRevenueContext(currentTotal: number): RevenueContext {
    const isUnderMinimum = currentTotal < 25;

    let discountTier: RevenueContext['discountTier'] = 'none';
    let discountMessage: string | undefined;
    let nearDiscount = false;
    let upsellUrgency: RevenueContext['upsellUrgency'] = 'gentle';

    if (isUnderMinimum) {
      // CRITICAL: Under £25 minimum
      upsellUrgency = 'critical';
      discountMessage = `Quick heads up - minimum rental is £25. Let me suggest some items to get you there`;
    } else if (currentTotal >= 500) {
      // At or above 17% discount tier
      discountTier = '17_percent';
      discountMessage = `Nice! You're at £${currentTotal} so you get 17% off the total`;
    } else if (currentTotal >= 250 && currentTotal < 500) {
      // Between 10% and 17% tier - upsell to 17%
      discountTier = '10_percent';
      nearDiscount = true;
      upsellUrgency = 'aggressive';
      const needed = 500 - currentTotal;
      discountMessage = `You're at £${currentTotal} (10% off). Add £${needed.toFixed(0)} more to unlock 17% off - that's an extra £${((currentTotal + needed) * 0.07).toFixed(0)} saved`;
    } else if (currentTotal >= 225 && currentTotal < 250) {
      // Close to 10% discount
      nearDiscount = true;
      upsellUrgency = 'aggressive';
      const needed = 250 - currentTotal;
      discountMessage = `You're at £${currentTotal}. Just £${needed.toFixed(0)} more gets you 10% off everything - save £${(250 * 0.1).toFixed(0)}`;
    } else if (currentTotal >= 25 && currentTotal < 225) {
      // Safe zone, gentle upselling
      upsellUrgency = 'moderate';
    }

    return {
      currentTotal,
      isUnderMinimum,
      nearDiscount,
      discountTier,
      discountMessage,
      upsellUrgency,
    };
  }

  /**
   * Build comprehensive recommendations
   */
  private buildRecommendations(
    itemCategories: ItemCategory[],
    useCase: ReturnType<typeof this.detectUseCase>,
    revenueContext: RevenueContext,
    conversationText: string,
  ): UpsellRecommendation {
    const recommendations: string[] = [];
    let reasoning = '';
    let priority: UpsellRecommendation['priority'] = 'medium';
    const questionsToAsk: string[] = [];

    // CRITICAL: Under minimum - aggressive upsell
    if (revenueContext.isUnderMinimum) {
      priority = 'critical';
      const needed = 25 - revenueContext.currentTotal;
      reasoning = `Current total is £${revenueContext.currentTotal.toFixed(0)}, need £${needed.toFixed(0)} more to hit the £25 minimum. `;

      // Suggest contextual essentials - filters first for camera/lens rentals
      if (itemCategories.some(i => i.category === 'camera')) {
        recommendations.push('ND filter', 'Cinebloom filter mist', 'Rode Wireless Mic Pro set');
        reasoning += 'ND filter and mist filter are essential for cinema work - plus a wireless mic for clean audio';
      } else if (itemCategories.some(i => i.category === 'lens')) {
        recommendations.push('ND filter', 'Cinebloom filter mist', 'Tilta Nucleus Nano 2 follow focus');
        reasoning += 'ND filter and mist filter are must-haves for cinema lenses';
      } else {
        recommendations.push('Rode Wireless Mic Pro set', 'ND filter', 'Cinebloom filter mist');
        reasoning += 'Consider adding a wireless mic - essential for most shoots and hits the minimum';
      }
    }

    // Use case-based recommendations (if detected)
    else if (useCase) {
      priority = 'high';
      reasoning = `Detected ${useCase.useCase} shoot. ${useCase.reasoning}. `;
      recommendations.push(...useCase.recommendations);
    }

    // Category-based complementary items
    else {
      const hasCamera = itemCategories.some(i => i.category === 'camera');
      const hasLens = itemCategories.some(i => i.category === 'lens');
      const hasAudio = itemCategories.some(i => i.category === 'audio');
      const hasGimbal = itemCategories.some(i => i.category === 'gimbal');

      // Camera or lens rentals: always suggest ND filter + mist filter first (most contextual)
      if (hasCamera || hasLens) {
        priority = 'high';
        recommendations.push('ND filter', 'Cinebloom filter mist');
        reasoning += this.complementaryItems.camera.reasoning.filters + '. ';
      }

      if (hasCamera && !hasAudio) {
        recommendations.push('Rode Wireless Mic Pro set');
        reasoning += this.complementaryItems.camera.reasoning.audio + '. ';
      }

      if ((hasCamera || hasLens) && !hasGimbal && !/\b(static|locked off|tripod only)\b/i.test(conversationText)) {
        recommendations.push('DJI RS3 Pro gimbal');
        reasoning += this.complementaryItems.camera.reasoning.stabilization + '. ';
      }

      if (hasLens && itemCategories.filter(i => i.category === 'lens').length >= 2) {
        recommendations.push('Tilta Nucleus Nano 2 follow focus');
        reasoning += this.complementaryItems.lens.reasoning.support + '. ';
      }

      // If we still don't know what they're shooting, ask
      if (!useCase && !hasAudio) {
        questionsToAsk.push(
          "What are you planning to shoot?",
          "Need any audio gear? Most shoots need at least a wireless mic",
          "Want to add stabilization like a gimbal?",
        );
        reasoning = "Could recommend more if I knew what you're shooting. ";
      }
    }

    // Discount tier upselling
    if (revenueContext.nearDiscount) {
      priority = priority === 'critical' ? 'critical' : 'high';
      if (revenueContext.discountTier === '10_percent') {
        // At 10%, push to 17%
        const needed = 500 - revenueContext.currentTotal;
        const avgItemPrice = 40; // Conservative estimate
        const itemsNeeded = Math.ceil(needed / avgItemPrice);
        reasoning += `Add ${itemsNeeded} more item${itemsNeeded > 1 ? 's' : ''} to hit 17% off (save an extra £${((revenueContext.currentTotal + needed) * 0.07).toFixed(0)}). `;

        if (!recommendations.includes('Rode Wireless Mic Pro set') && !itemCategories.some(i => i.category === 'audio')) {
          recommendations.unshift('Rode Wireless Mic Pro set');
        }
        if (!recommendations.includes('ND filter')) {
          recommendations.push('ND filter', 'Cinebloom filter mist');
        }
      } else {
        // Close to 10%
        const needed = 250 - revenueContext.currentTotal;
        reasoning += `Just £${needed.toFixed(0)} more to unlock 10% off. `;
        recommendations.push('Rode Wireless Mic Pro set', 'ND filter', 'Sony GM 24-70mm f2.8');
      }
    }

    return {
      items: recommendations.slice(0, 5), // Top 5 recommendations
      reasoning: reasoning.trim(),
      priority,
      questionsToAsk: questionsToAsk.length > 0 ? questionsToAsk : undefined,
    };
  }

  /**
   * Generate upsell message for AI to include in response
   */
  async generateUpsellMessage(
    requestedItems: string[],
    conversationText: string,
    currentTotal: number,
  ): Promise<string> {
    const { recommendations, revenueContext } = await this.generateUpsellRecommendations(
      requestedItems,
      conversationText,
      currentTotal,
    );

    let message = '';

    // Revenue context message (discounts)
    if (revenueContext.discountMessage) {
      message += revenueContext.discountMessage + '\n\n';
    }

    // Recommendations
    if (recommendations.items.length > 0) {
      if (revenueContext.upsellUrgency === 'critical') {
        message += `🎯 To hit the minimum:\n`;
      } else if (revenueContext.upsellUrgency === 'aggressive') {
        message += `💡 Worth considering:\n`;
      } else {
        message += `Might also want:\n`;
      }

      message += recommendations.items.slice(0, 3).map(item => `• ${item}`).join('\n');

      if (recommendations.reasoning) {
        message += `\n\n${recommendations.reasoning}`;
      }
    }

    // Questions to ask if uncertain
    if (recommendations.questionsToAsk && recommendations.questionsToAsk.length > 0) {
      message += '\n\n' + recommendations.questionsToAsk[0];
    }

    return message.trim();
  }

  /**
   * Quick check if upselling is needed
   */
  shouldUpsell(currentTotal: number, itemCount: number): boolean {
    // Always upsell if under minimum
    if (currentTotal < 25) return true;

    // Upsell if close to discount tiers
    if ((currentTotal >= 225 && currentTotal < 250) ||
        (currentTotal >= 250 && currentTotal < 500)) {
      return true;
    }

    // Upsell if only 1-2 items (incomplete setup)
    if (itemCount <= 2) return true;

    return false;
  }
}
