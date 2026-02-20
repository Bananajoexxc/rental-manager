import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarService } from '../calendar/calendar.service';
import { getSpecHighlight, findItemsByFeature, FEATURE_KEYWORD_MAP } from '../data/item-specs';
import { ITEM_COMPATIBILITY, CompatibilityEntry } from '../data/item-compatibility';

interface UpsellRecommendation {
  items: string[];
  reasoning: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  questionsToAsk?: string[];
}

interface RevenueContext {
  currentTotal: number;
  isUnderMinimum: boolean; // Under ~£47 listing (£30 profit)
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

interface CoOccurrence {
  itemName: string;
  coCount: number;
  avgRevenue: number;
  conversionRate: number;
  compositeScore: number;
}

@Injectable()
export class UpsellService {
  private readonly logger = new Logger(UpsellService.name);

  // Co-occurrence cache (24h TTL)
  private coOccurrenceCache: Map<string, { data: CoOccurrence[]; cachedAt: number }> = new Map();
  private readonly CO_OCCURRENCE_TTL = 24 * 60 * 60 * 1000; // 24h

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
      essential: ['256GB card'],
      recommended: [],
      reasoning: {
        storage: "Extra memory card is useful for longer flights and higher quality recording",
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
      recommendations: ['DJI RS3 Pro gimbal', 'Anamorphic Great Joy lens 50mm', 'LED light panels RGB', 'Smoke machine fogger', 'Motorized slider'],
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

  // Configurable thresholds (overridable via env)
  private readonly MINIMUM_ORDER: number;
  private readonly DISCOUNT_TIER_1: number;
  private readonly DISCOUNT_TIER_1_PCT: number;
  private readonly DISCOUNT_TIER_2: number;
  private readonly DISCOUNT_TIER_2_PCT: number;
  private readonly PLATFORM_FEE_RATE: number;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private calendarService: CalendarService,
  ) {
    this.MINIMUM_ORDER = Number(this.configService.get('UPSELL_MIN_ORDER', '47')); // ~£30 profit after ~36% platform fees
    this.DISCOUNT_TIER_1 = Number(this.configService.get('UPSELL_DISCOUNT_TIER_1', '250'));
    this.DISCOUNT_TIER_1_PCT = Number(this.configService.get('UPSELL_DISCOUNT_TIER_1_PCT', '10'));
    this.DISCOUNT_TIER_2 = Number(this.configService.get('UPSELL_DISCOUNT_TIER_2', '500'));
    this.DISCOUNT_TIER_2_PCT = Number(this.configService.get('UPSELL_DISCOUNT_TIER_2_PCT', '17'));
    this.PLATFORM_FEE_RATE = Number(this.configService.get('PLATFORM_FEE_RATE', '0.15'));
  }

  /**
   * Get items frequently rented together, scored by co-occurrence + conversion.
   */
  async getCoOccurrenceData(itemNames: string[]): Promise<CoOccurrence[]> {
    if (itemNames.length === 0) return [];

    const cacheKey = itemNames.sort().join('|');
    const cached = this.coOccurrenceCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.CO_OCCURRENCE_TTL) {
      return cached.data;
    }

    try {
      // Find items that appear in the same rental as the requested items
      const coRows: { item_name: string; co_count: string; avg_revenue: string }[] =
        await this.prisma.$queryRaw`
          SELECT b2.item_name, COUNT(DISTINCT b1.rental_id)::text AS co_count,
                 COALESCE(AVG(b2.revenue), 0)::text AS avg_revenue
          FROM booking b1
          JOIN booking b2 ON b1.rental_id = b2.rental_id
            AND b1.item_name != b2.item_name
            AND b2.status != 'cancelled'
          WHERE b1.item_name = ANY(${itemNames})
            AND b1.status != 'cancelled'
            AND b2.item_name != ALL(${itemNames})
          GROUP BY b2.item_name
          HAVING COUNT(DISTINCT b1.rental_id) >= 2
          ORDER BY COUNT(DISTINCT b1.rental_id) DESC
          LIMIT 20
        `;

      if (coRows.length === 0) {
        this.coOccurrenceCache.set(cacheKey, { data: [], cachedAt: Date.now() });
        return [];
      }

      // Get conversion rates from upsell_log
      const coItemNames = coRows.map(r => r.item_name);
      const conversionRows: { item_name: string; total: string; accepted: string }[] =
        await this.prisma.$queryRaw`
          SELECT unnest(items_suggested) AS item_name,
                 COUNT(*)::text AS total,
                 COUNT(*) FILTER (WHERE outcome IN ('accepted', 'partial'))::text AS accepted
          FROM upsell_log
          WHERE outcome != 'pending'
          GROUP BY unnest(items_suggested)
          HAVING unnest(items_suggested) = ANY(${coItemNames})
        `;

      const conversionMap = new Map<string, number>();
      for (const row of conversionRows) {
        const total = parseInt(row.total, 10);
        if (total > 0) {
          conversionMap.set(row.item_name, parseInt(row.accepted, 10) / total);
        }
      }

      // Normalize and compute composite scores
      const maxCount = Math.max(...coRows.map(r => parseInt(r.co_count, 10)));
      const maxRevenue = Math.max(...coRows.map(r => parseFloat(r.avg_revenue)), 1);

      const results: CoOccurrence[] = coRows.map(row => {
        const coCount = parseInt(row.co_count, 10);
        const avgRevenue = parseFloat(row.avg_revenue);
        const conversionRate = conversionMap.get(row.item_name) || 0;

        const compositeScore =
          (coCount / maxCount) * 0.4 +
          (avgRevenue / maxRevenue) * 0.3 +
          conversionRate * 0.3;

        return {
          itemName: row.item_name,
          coCount,
          avgRevenue,
          conversionRate,
          compositeScore,
        };
      });

      results.sort((a, b) => b.compositeScore - a.compositeScore);

      this.coOccurrenceCache.set(cacheKey, { data: results, cachedAt: Date.now() });
      return results;
    } catch (err) {
      this.logger.warn(`Co-occurrence query failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Analyze items and conversation to generate smart upsell recommendations
   */
  async generateUpsellRecommendations(
    requestedItems: string[],
    conversationText: string,
    currentTotal: number,
    startDate?: Date,
    endDate?: Date,
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
    const recommendations = await this.buildRecommendations(
      itemCategories,
      useCase,
      revenueContext,
      conversationText,
    );

    // Filter out items that aren't available for the requested dates
    if (startDate && endDate && recommendations.items.length > 0) {
      const availableItems: string[] = [];
      for (const item of recommendations.items) {
        try {
          const availability = await this.calendarService.checkAvailability(
            item,
            startDate,
            endDate,
          );
          if (availability.available) {
            availableItems.push(item);
          } else {
            this.logger.debug(
              `Filtered out upsell recommendation "${item}": not available for ${startDate.toISOString().split('T')[0]} - ${endDate.toISOString().split('T')[0]} (${availability.booked}/${availability.maxQuantity} booked)`,
            );
          }
        } catch (err) {
          // If availability check fails, keep the item in recommendations
          // rather than silently dropping it
          this.logger.warn(
            `Availability check failed for upsell item "${item}": ${err.message}`,
          );
          availableItems.push(item);
        }
      }
      recommendations.items = availableItems;
    }

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
    const isUnderMinimum = currentTotal < this.MINIMUM_ORDER;
    const nearTier1Threshold = this.DISCOUNT_TIER_1 - 25; // e.g. £225

    let discountTier: RevenueContext['discountTier'] = 'none';
    let discountMessage: string | undefined;
    let nearDiscount = false;
    let upsellUrgency: RevenueContext['upsellUrgency'] = 'gentle';

    if (isUnderMinimum) {
      upsellUrgency = 'critical';
      discountMessage = `This is a small order - suggest some relevant add-ons to increase the value`;
    } else if (currentTotal >= this.DISCOUNT_TIER_2) {
      discountTier = '17_percent';
      discountMessage = `INTERNAL: Customer qualifies for top-tier discount (applied automatically at checkout)`;
    } else if (currentTotal >= this.DISCOUNT_TIER_1 && currentTotal < this.DISCOUNT_TIER_2) {
      discountTier = '10_percent';
      nearDiscount = true;
      upsellUrgency = 'aggressive';
      discountMessage = `INTERNAL: Customer qualifies for a discount and is close to a bigger one — suggest adding items naturally`;
    } else if (currentTotal >= nearTier1Threshold && currentTotal < this.DISCOUNT_TIER_1) {
      nearDiscount = true;
      upsellUrgency = 'aggressive';
      discountMessage = `INTERNAL: Customer is close to qualifying for a discount — suggest adding items naturally`;
    } else if (currentTotal >= this.MINIMUM_ORDER && currentTotal < nearTier1Threshold) {
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
   * Extract feature needs from conversation text and find spec-matched items.
   * Only returns items NOT already in the renter's list.
   */
  private extractFeatureRecommendations(
    conversationText: string,
    requestedItems: string[],
  ): { item_name: string; reason: string }[] {
    const textLower = conversationText.toLowerCase();
    const matchedKeywords: string[] = [];

    for (const [trigger, searchTerms] of Object.entries(FEATURE_KEYWORD_MAP)) {
      if (textLower.includes(trigger)) {
        matchedKeywords.push(...searchTerms);
      }
    }

    if (matchedKeywords.length === 0) return [];

    const deduped = [...new Set(matchedKeywords)];
    const matches = findItemsByFeature(deduped, requestedItems);

    return matches.map(m => ({
      item_name: m.item_name,
      reason: m.highlight ? `${m.matchedFeature} — ${m.highlight}` : m.matchedFeature,
    }));
  }

  /**
   * Filter recommendations through ITEM_COMPATIBILITY data.
   * Removes items that are NOT in the compatible_accessories/batteries/cards/lenses
   * of any requested item. Only filters when at least one requested item has
   * compatibility data; items with no compat entry pass through unfiltered.
   */
  private filterIncompatibleRecommendations(
    recommendations: string[],
    requestedItemNames: string[],
  ): string[] {
    // Find compatibility entries for requested items (fuzzy lowercase match)
    const compatEntries: CompatibilityEntry[] = [];
    for (const name of requestedItemNames) {
      const nameLower = name.toLowerCase();
      const entry = ITEM_COMPATIBILITY.find(c => {
        const cLower = c.item_name.toLowerCase();
        return cLower === nameLower || cLower.includes(nameLower) || nameLower.includes(cLower);
      });
      if (entry) compatEntries.push(entry);
    }

    // If no requested items have compatibility data, can't filter
    if (compatEntries.length === 0) return recommendations;

    // Build union of all compatible items (lowercased for matching)
    const allowedSet = new Set<string>();
    for (const entry of compatEntries) {
      for (const item of [
        ...entry.compatible_batteries,
        ...entry.compatible_cards,
        ...entry.compatible_accessories,
        ...entry.compatible_lenses,
      ]) {
        allowedSet.add(item.toLowerCase());
      }
    }

    return recommendations.filter(rec => {
      const recLower = rec.toLowerCase();

      // Keep if compatible with any requested item
      for (const allowed of allowedSet) {
        if (allowed === recLower || allowed.includes(recLower) || recLower.includes(allowed)) {
          return true;
        }
      }

      this.logger.debug(
        `Filtered incompatible upsell "${rec}" for [${requestedItemNames.join(', ')}]`,
      );
      return false;
    });
  }

  /**
   * Build comprehensive recommendations
   */
  private async buildRecommendations(
    itemCategories: ItemCategory[],
    useCase: ReturnType<typeof this.detectUseCase>,
    revenueContext: RevenueContext,
    conversationText: string,
  ): Promise<UpsellRecommendation> {
    const recommendations: string[] = [];
    let reasoning = '';
    let priority: UpsellRecommendation['priority'] = 'medium';
    const questionsToAsk: string[] = [];

    // Data-driven: co-occurrence recommendations take priority
    const requestedNames = itemCategories.map(i => i.name);
    const coData = await this.getCoOccurrenceData(requestedNames);
    if (coData.length >= 2) {
      // Use co-occurrence data as primary source
      for (const co of coData.slice(0, 4)) {
        if (!requestedNames.some(n => n.toLowerCase() === co.itemName.toLowerCase())) {
          recommendations.push(co.itemName);
          reasoning += `Renters who booked ${requestedNames[0]} also booked ${co.itemName} (${co.coCount} times). `;
        }
      }
      if (recommendations.length > 0) {
        priority = 'high';
      }
    }

    // Fall through to hard-coded logic only when co-occurrence data is insufficient
    const hasCoData = recommendations.length >= 2;

    // CRITICAL: Under minimum - aggressive upsell (always applies regardless of co-data)
    if (revenueContext.isUnderMinimum) {
      priority = 'critical';
      reasoning = `INTERNAL: Order value is low — suggest relevant add-ons naturally. NEVER mention minimums or thresholds to the renter. ` + reasoning;

      if (!hasCoData) {
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
    }

    // Use case-based recommendations (if detected) — fallback if no co-data
    else if (!hasCoData && useCase) {
      priority = 'high';
      reasoning = `Detected ${useCase.useCase} shoot. ${useCase.reasoning}. `;
      recommendations.push(...useCase.recommendations);
    }

    // Category-based complementary items — fallback if no co-data
    else if (!hasCoData) {
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
        const needed = this.DISCOUNT_TIER_2 - revenueContext.currentTotal;
        const avgItemPrice = 40; // Conservative estimate
        const itemsNeeded = Math.ceil(needed / avgItemPrice);
        reasoning += `INTERNAL: Adding ${itemsNeeded} more item${itemsNeeded > 1 ? 's' : ''} would unlock a bigger discount for the customer. Suggest items naturally. `;

        if (!recommendations.includes('Rode Wireless Mic Pro set') && !itemCategories.some(i => i.category === 'audio')) {
          recommendations.unshift('Rode Wireless Mic Pro set');
        }
        if (!recommendations.includes('ND filter')) {
          recommendations.push('ND filter', 'Cinebloom filter mist');
        }
      } else {
        // Close to discount threshold
        reasoning += `INTERNAL: Customer is close to qualifying for a discount. Suggest adding items naturally — NEVER mention specific thresholds. `;
        recommendations.push('Rode Wireless Mic Pro set', 'ND filter', 'Sony GM 24-70mm f2.8');
      }
    }

    // Feature-aware recommendations: if renter mentions specific needs, find items that match
    const featureMatches = this.extractFeatureRecommendations(conversationText, requestedNames);
    if (featureMatches.length > 0) {
      for (const match of featureMatches) {
        if (!recommendations.includes(match.item_name) && recommendations.length < 5) {
          recommendations.push(match.item_name);
          reasoning += `${match.item_name} matches their needs (${match.reason}). `;
        }
      }
    }

    // Filter out items incompatible with the requested equipment
    const filteredItems = this.filterIncompatibleRecommendations(
      recommendations,
      itemCategories.map(i => i.name),
    );

    return {
      items: filteredItems.slice(0, 5),
      reasoning: reasoning.trim(),
      priority,
      questionsToAsk: questionsToAsk.length > 0 ? questionsToAsk : undefined,
    };
  }

  /**
   * Resolve item names to their best Hygglo listing URL.
   * Prefers standalone (fewest-item) listings so the link goes to the specific item page.
   */
  async resolveItemListingUrls(itemNames: string[]): Promise<Map<string, string>> {
    const urlMap = new Map<string, string>();
    if (itemNames.length === 0) return urlMap;

    try {
      // Find rentals that contain these items in parsed_items, with listing URLs
      const rentals = await this.prisma.rental.findMany({
        where: {
          listing_url: { not: '' },
          parsed_items: { not: Prisma.JsonNull },
        },
        select: { listing_url: true, parsed_items: true },
        orderBy: { created_at: 'desc' },
      });

      for (const itemName of itemNames) {
        const itemLower = itemName.toLowerCase();
        let bestUrl = '';
        let fewestItems = Infinity;

        for (const r of rentals) {
          const items = r.parsed_items as any[];
          if (!items || !Array.isArray(items)) continue;

          const match = items.some((i: any) =>
            (i.item || '').toLowerCase() === itemLower,
          );
          if (match && r.listing_url && items.length < fewestItems) {
            bestUrl = r.listing_url;
            fewestItems = items.length;
          }
        }

        if (bestUrl) urlMap.set(itemName, bestUrl);
      }
    } catch (err) {
      this.logger.debug(`Item URL resolution failed: ${err.message}`);
    }

    return urlMap;
  }

  /**
   * Generate upsell message for AI to include in response
   */
  async generateUpsellMessage(
    requestedItems: string[],
    conversationText: string,
    currentTotal: number,
    startDate?: Date,
    endDate?: Date,
  ): Promise<string> {
    const { recommendations, revenueContext } = await this.generateUpsellRecommendations(
      requestedItems,
      conversationText,
      currentTotal,
      startDate,
      endDate,
    );

    // Fetch co-occurrence data for enriching the message
    const coData = await this.getCoOccurrenceData(requestedItems);
    const coMap = new Map(coData.map(c => [c.itemName, c]));

    // Resolve listing URLs for recommended items
    const topItems = recommendations.items.slice(0, 3);
    const itemUrls = await this.resolveItemListingUrls(topItems);

    let message = '';

    // Revenue context message (discounts)
    if (revenueContext.discountMessage) {
      message += revenueContext.discountMessage + '\n\n';
    }

    // Recommendations
    if (topItems.length > 0) {
      if (revenueContext.upsellUrgency === 'critical') {
        message += `🎯 To hit the minimum:\n`;
      } else if (revenueContext.upsellUrgency === 'aggressive') {
        message += `💡 Worth considering:\n`;
      } else {
        message += `Might also want:\n`;
      }

      message += topItems.map(item => {
        const co = coMap.get(item);
        const url = itemUrls.get(item);
        let line: string;
        if (co && co.coCount >= 2) {
          line = `• ${item} — rented together ${co.coCount} times by other customers`;
        } else {
          const highlight = getSpecHighlight(item);
          line = highlight ? `• ${item} — ${highlight}` : `• ${item}`;
        }
        if (url) line += ` [link: ${url}]`;
        return line;
      }).join('\n');

      if (recommendations.reasoning) {
        message += `\n\n${recommendations.reasoning}`;
      }

      // Item link instruction
      if (itemUrls.size > 0) {
        message += `\n\nITEM LINKS: Only share an item's link if the renter asks about it, asks for more details, or says they'll think about it / are considering it. Do NOT send links proactively — only when the renter shows interest or hesitates on a specific item.`;
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
    if (currentTotal < this.MINIMUM_ORDER) return true;

    // Upsell if close to discount tiers
    const nearTier1 = this.DISCOUNT_TIER_1 - 25;
    if ((currentTotal >= nearTier1 && currentTotal < this.DISCOUNT_TIER_1) ||
        (currentTotal >= this.DISCOUNT_TIER_1 && currentTotal < this.DISCOUNT_TIER_2)) {
      return true;
    }

    // Upsell if only 1-2 items (incomplete setup)
    if (itemCount <= 2) return true;

    return false;
  }

  /**
   * Log an upsell attempt for tracking and autolearn analysis.
   */
  async logUpsellAttempt(data: {
    rentalId: string;
    itemsSuggested: string[];
    revenueBefore: number;
    priority: string;
    useCaseDetected?: string;
  }): Promise<string> {
    const log = await this.prisma.upsell_log.create({
      data: {
        rental_id: data.rentalId,
        items_suggested: data.itemsSuggested,
        items_accepted: [],
        revenue_before: data.revenueBefore,
        upsell_priority: data.priority,
        use_case_detected: data.useCaseDetected,
        outcome: 'pending',
      },
    });
    this.logger.debug(`Upsell logged for rental ${data.rentalId}: ${data.itemsSuggested.join(', ')}`);
    return log.id;
  }

  /**
   * Update an upsell log with the outcome.
   */
  async updateUpsellOutcome(
    rentalId: string,
    itemsAccepted: string[],
    revenueAfter: number,
  ): Promise<void> {
    const latestLog = await this.prisma.upsell_log.findFirst({
      where: { rental_id: rentalId, outcome: 'pending' },
      orderBy: { created_at: 'desc' },
    });
    if (!latestLog) return;

    const outcome = itemsAccepted.length === 0
      ? 'ignored'
      : itemsAccepted.length >= latestLog.items_suggested.length
        ? 'accepted'
        : 'partial';

    await this.prisma.upsell_log.update({
      where: { id: latestLog.id },
      data: {
        items_accepted: itemsAccepted,
        revenue_after: revenueAfter,
        outcome,
      },
    });
    this.logger.log(`Upsell outcome: ${outcome} (${itemsAccepted.length}/${latestLog.items_suggested.length} items)`);
  }

  /**
   * Get upsell conversion stats for the autolearn engine.
   */
  async getUpsellStats(days: number = 30): Promise<{
    totalAttempts: number;
    accepted: number;
    partial: number;
    ignored: number;
    conversionRate: number;
    avgRevenueIncrease: number;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const logs = await this.prisma.upsell_log.findMany({
      where: {
        created_at: { gte: since },
        outcome: { not: 'pending' },
      },
    });

    const accepted = logs.filter(l => l.outcome === 'accepted').length;
    const partial = logs.filter(l => l.outcome === 'partial').length;
    const ignored = logs.filter(l => l.outcome === 'ignored' || l.outcome === 'rejected').length;

    const revenueIncreases = logs
      .filter(l => l.revenue_after != null && l.revenue_after > l.revenue_before)
      .map(l => l.revenue_after! - l.revenue_before);
    const avgRevenueIncrease = revenueIncreases.length > 0
      ? revenueIncreases.reduce((a, b) => a + b, 0) / revenueIncreases.length
      : 0;

    return {
      totalAttempts: logs.length,
      accepted,
      partial,
      ignored,
      conversionRate: logs.length > 0 ? ((accepted + partial) / logs.length) * 100 : 0,
      avgRevenueIncrease: Math.round(avgRevenueIncrease * 100) / 100,
    };
  }
}
