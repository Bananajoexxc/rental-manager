import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarService } from '../calendar/calendar.service';
import { PRICING_CATALOG } from '../data/pricing-catalog';
import { getSpecHighlight } from '../data/item-specs';

export interface BundleDefinition {
  name: string;
  description: string;
  items: string[]; // Item names in the bundle
  category: 'camera_kit' | 'lens_set' | 'lighting' | 'audio' | 'drone' | 'fake' | 'other';
  dailyPrice: number;
  account: 'dbcinema' | 'leo' | 'both';
  savings: number; // Percentage savings vs individual
  isFake: boolean; // If bundle doesn't actually exist (fake listing)
}

export interface BundleRecommendation {
  bundle: BundleDefinition;
  reason: string;
  savings: string;
  matchedItems: string[];
  missingItems: string[];
  substitutions?: Array<{ original: string; substitute: string; difference: string }>;
  confidence: number;
}

export interface ItemIntent {
  items: string[];
  category: string;
  quantity: number;
  suggestBundle: boolean;
  reasoning: string;
}

@Injectable()
export class BundleIntelligenceService {
  private readonly logger = new Logger(BundleIntelligenceService.name);
  private bundles: BundleDefinition[] = [];

  constructor(
    private prisma: PrismaService,
    private calendarService: CalendarService,
  ) {
    this.initializeBundles();
  }

  /**
   * Initialize bundle definitions
   * TODO: Move to database for easier maintenance
   */
  private initializeBundles() {
    this.bundles = [
      // Cinema Camera Kits (matching actual MASTER_INVENTORY items)
      {
        name: 'Sony FX3 + 24-70mm GM Kit',
        description: 'FX3 body + Sony GM 24-70mm f2.8 lens',
        items: ['Sony FX3', 'Sony GM 24-70mm f2.8'],
        category: 'camera_kit',
        dailyPrice: 55,
        account: 'both',
        savings: 15,
        isFake: false,
      },
      {
        name: 'Sony FX3 Full Production Kit',
        description: 'FX3 + 24-70mm GM + RS3 gimbal + Rode wireless mic + Atomos Ninja V + ND filter. Does NOT include CF Express cards or suction cups.',
        items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal', 'Rode Wireless Mic Pro set', 'Atomos Ninja V', 'ND filter'],
        category: 'camera_kit',
        dailyPrice: 120,
        account: 'both',
        savings: 25,
        isFake: false,
      },
      {
        name: 'Sony FX3 Full Production Kit + V-Mount 95mAh',
        description: 'Full Production Kit with V-mount 95mAh battery included',
        items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal', 'Rode Wireless Mic Pro set', 'Atomos Ninja V', 'ND filter', 'V-mount 95mAh'],
        category: 'camera_kit',
        dailyPrice: 130,
        account: 'both',
        savings: 27,
        isFake: false,
      },
      {
        name: 'Sony FX3 Full Production Kit + V-Mount 150mAh',
        description: 'Full Production Kit with V-mount 150mAh battery included',
        items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal', 'Rode Wireless Mic Pro set', 'Atomos Ninja V', 'ND filter', 'V-mount 150mAh'],
        category: 'camera_kit',
        dailyPrice: 140,
        account: 'both',
        savings: 28,
        isFake: false,
      },
      {
        name: 'BMPCC 6K Pro Cinema Kit',
        description: 'BMPCC 6K Pro + Canon EF 24-105mm + RS3 gimbal + Atomos Ninja V',
        items: ['BMPCC 6K Pro', 'Canon EF 24-105mm f4', 'DJI RS3 Pro gimbal', 'Atomos Ninja V'],
        category: 'camera_kit',
        dailyPrice: 120,
        account: 'both',
        savings: 18,
        isFake: false,
      },

      // Lens Sets (matching actual inventory items)
      {
        name: 'Sony GM Triple Lens Set',
        description: '16-35mm + 24-70mm + 70-200mm GM lenses',
        items: ['Sony GM 16-35mm f2.8', 'Sony GM 24-70mm f2.8', 'Sony GM 70-200mm f2.8'],
        category: 'lens_set',
        dailyPrice: 55,
        account: 'both',
        savings: 22,
        isFake: false,
      },
      {
        name: 'Blazar Remus 4-Lens Anamorphic Set',
        description: '33mm + 45mm + 65mm + 100mm Blazar Remus anamorphic lenses',
        items: ['Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm', 'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm'],
        category: 'lens_set',
        dailyPrice: 120,
        account: 'both',
        savings: 25,
        isFake: false,
      },
      {
        name: 'Great Joy Anamorphic Set',
        description: '35mm + 50mm + 85mm Great Joy anamorphic lenses',
        items: ['Anamorphic Great Joy lens 35mm', 'Anamorphic Great Joy lens 50mm', 'Anamorphic Great Joy lens 85mm'],
        category: 'lens_set',
        dailyPrice: 99,
        account: 'both',
        savings: 20,
        isFake: false,
      },

      // Lighting Packages (matching actual inventory items)
      {
        name: 'Interview Lighting Kit',
        description: '2x LED panels + softbox',
        items: ['LED light panels RGB', 'LED light panels RGB', 'Softbox 85cm'],
        category: 'lighting',
        dailyPrice: 40,
        account: 'both',
        savings: 20,
        isFake: false,
      },
      {
        name: 'Full Lighting Kit',
        description: 'Nanlite Forza 300 + 2x Pavotube 30x II + C-stand',
        items: ['Nanlite Forza 300', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'C-stand'],
        category: 'lighting',
        dailyPrice: 70,
        account: 'both',
        savings: 22,
        isFake: false,
      },

      // Gimbal + Camera Combos
      {
        name: 'Sony FX3 + RS3 Pro Gimbal Kit',
        description: 'Sony FX3 + DJI RS3 Pro gimbal',
        items: ['Sony FX3', 'DJI RS3 Pro gimbal'],
        category: 'camera_kit',
        dailyPrice: 58,
        account: 'both',
        savings: 15,
        isFake: false,
      },

      // Fake bundles (location-based listings that don't actually exist)
      {
        name: 'West London Cinema Package',
        description: 'FX3 kit supposedly in West London',
        items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'Atomos Ninja V'],
        category: 'fake',
        dailyPrice: 130,
        account: 'dbcinema',
        savings: 0,
        isFake: true,
      },
    ];

    this.logger.log(`Initialized ${this.bundles.length} bundle definitions`);
  }

  /**
   * Detect item intent from message - are they asking for multiple related items?
   */
  async detectItemIntent(message: string, mentionedItems: string[]): Promise<ItemIntent> {
    const itemCount = mentionedItems.length;

    // Single item = probably don't need bundle
    if (itemCount === 1) {
      return {
        items: mentionedItems,
        category: 'single_item',
        quantity: 1,
        suggestBundle: false,
        reasoning: 'Single item request',
      };
    }

    // Detect lens set requests
    const lensTerms = /\b(lens|lenses|prime|zoom|glass|optics|anamorphic|blazar|remus|great joy)\b/gi;
    const lensCount = (message.match(lensTerms) || []).length;
    const mentionedLenses = mentionedItems.filter(item =>
      /lens|mm|prime|zoom|24-70|70-200|50mm|35mm|85mm/i.test(item)
    );

    if (mentionedLenses.length >= 3 || (lensCount >= 3 && mentionedLenses.length >= 2)) {
      return {
        items: mentionedLenses,
        category: 'lens_set',
        quantity: mentionedLenses.length,
        suggestBundle: true,
        reasoning: `Multiple lenses mentioned (${mentionedLenses.length}) - likely needs lens set`,
      };
    }

    // Detect camera kit requests (camera + accessories)
    const hasCameraBody = mentionedItems.some(item => /FX3|A7|BMPCC|camera body/i.test(item));
    const hasLens = mentionedItems.some(item => /lens|mm|24-70|70-200|50mm/i.test(item));
    const hasAccessory = mentionedItems.some(item => /battery|card|gimbal|mic|light/i.test(item));

    if (hasCameraBody && (hasLens || hasAccessory)) {
      return {
        items: mentionedItems,
        category: 'camera_kit',
        quantity: itemCount,
        suggestBundle: true,
        reasoning: 'Camera + accessories mentioned - kit may be cheaper',
      };
    }

    // Detect lighting setup
    const lightCount = mentionedItems.filter(item => /light|nanlite|LED|panel|pavotube|forza|softbox/i.test(item)).length;
    if (lightCount >= 2) {
      return {
        items: mentionedItems,
        category: 'lighting',
        quantity: lightCount,
        suggestBundle: true,
        reasoning: `Multiple lights (${lightCount}) - lighting package available`,
      };
    }

    // Multiple unrelated items
    if (itemCount >= 3) {
      return {
        items: mentionedItems,
        category: 'multi_item',
        quantity: itemCount,
        suggestBundle: true,
        reasoning: 'Multiple items - check if any bundles match',
      };
    }

    // Default: 2 items, check bundles but don't force
    return {
      items: mentionedItems,
      category: 'unknown',
      quantity: itemCount,
      suggestBundle: false,
      reasoning: 'Two items - may or may not need bundle',
    };
  }

  /**
   * Find matching bundles for requested items
   */
  findMatchingBundles(
    requestedItems: string[],
    intent: ItemIntent,
  ): BundleRecommendation[] {
    const recommendations: BundleRecommendation[] = [];

    // Filter to real bundles (skip fakes) and relevant category
    const relevantBundles = this.bundles.filter(
      bundle => !bundle.isFake && (bundle.category === intent.category || intent.category === 'multi_item' || intent.category === 'unknown')
    );

    for (const bundle of relevantBundles) {
      // Fuzzy match requested items to bundle items
      const matchedItems: string[] = [];
      const missingItems: string[] = [];

      for (const bundleItem of bundle.items) {
        const isMatched = requestedItems.some(requestedItem =>
          this.fuzzyMatch(requestedItem, bundleItem)
        );

        if (isMatched) {
          matchedItems.push(bundleItem);
        } else {
          missingItems.push(bundleItem);
        }
      }

      // Calculate match confidence
      const matchRatio = matchedItems.length / bundle.items.length;
      const requestCoverage = matchedItems.length / requestedItems.length;

      // Require at least 50% match to recommend
      if (matchRatio >= 0.5) {
        const confidence = (matchRatio * 0.6) + (requestCoverage * 0.4);

        // Generate recommendation reason
        let reason = '';
        if (matchRatio === 1.0) {
          reason = `Perfect match - this bundle has everything you asked for`;
        } else if (matchRatio >= 0.75) {
          reason = `Great match - includes ${matchedItems.length} of the ${requestedItems.length} items you need`;
        } else {
          reason = `Partial match - covers ${matchedItems.length} items`;
        }

        // Calculate savings
        const savingsText = `${bundle.savings}% cheaper than renting separately`;

        recommendations.push({
          bundle,
          reason,
          savings: savingsText,
          matchedItems,
          missingItems,
          confidence,
        });
      }
    }

    // Sort by confidence (best matches first)
    return recommendations.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Handle substitutions when exact bundle item unavailable
   */
  async findSubstitutions(
    bundle: BundleDefinition,
    unavailableItems: string[],
  ): Promise<Array<{ original: string; substitute: string; difference: string; originalPrice?: number; substitutePrice?: number; offerPrice?: number; maxPrice?: number }>> {
    const substitutions: Array<{ original: string; substitute: string; difference: string; originalPrice?: number; substitutePrice?: number; offerPrice?: number; maxPrice?: number }> = [];

    // Substitution mappings (original -> substitute)
    const substitutionMap: Record<string, { substitute: string; difference: string }> = {
      'Atomos Ninja V': {
        substitute: 'Hollyland Pyro 7"',
        difference: 'Pyro is monitor-only (no recording like the Ninja V)',
      },
      'Sony GM 70-200mm': {
        substitute: 'Sony 70-200mm f/4',
        difference: 'f/4 version (slightly slower aperture than GM f/2.8)',
      },
      'DJI RS3': {
        substitute: 'DJI RS2',
        difference: 'RS2 is previous gen (slightly heavier but same stabilization)',
      },
      'Nanlite 500B': {
        substitute: 'Nanlite Forza 300',
        difference: 'Forza 300 is daylight-only (5600K fixed, NOT bi-color) and less powerful (300W vs 500W). Only substitute if renter does NOT need bi-color/tungsten',
      },
      'Sony FX3': {
        substitute: 'Sony A7 III',
        difference: 'A7 III is a hybrid photo/video body (no pro video features like XLR/timecode, but excellent image quality)',
      },
      'Sony A7 III': {
        substitute: 'Sony FX3',
        difference: 'FX3 is a dedicated cinema camera (S-Cinetone, XLR audio, no photo mode)',
      },
      'BMPCC 6K Pro': {
        substitute: 'BMPCC 6K Full Frame',
        difference: 'Full Frame has a larger sensor (Super 35 vs Full Frame)',
      },
      'BMPCC 6K Full Frame': {
        substitute: 'BMPCC 6K Pro',
        difference: 'Pro has a Super 35 sensor and built-in ND filters',
      },
    };

    for (const unavailableItem of unavailableItems) {
      // Check if we have a known substitution
      const substitution = substitutionMap[unavailableItem];

      if (substitution) {
        // Look up pricing for both original and substitute
        const originalEntry = PRICING_CATALOG.find(
          p => p.item_name.toLowerCase() === unavailableItem.toLowerCase() && !p.is_bundle,
        );
        const substituteEntry = PRICING_CATALOG.find(
          p => p.item_name.toLowerCase() === substitution.substitute.toLowerCase() && !p.is_bundle,
        );

        const originalPrice = originalEntry?.daily_price_max;
        const substitutePrice = substituteEntry?.daily_price_max;
        // Offer at same price as original; max allowed is 15% above original (only if renter asks)
        const offerPrice = originalPrice;
        const maxPrice = originalPrice ? Math.round(originalPrice * 1.15) : undefined;

        // Enrich difference with spec highlight if available
        const subHighlight = getSpecHighlight(substitution.substitute);
        const enrichedDiff = subHighlight
          ? `${substitution.difference}. ${subHighlight}`
          : substitution.difference;

        substitutions.push({
          original: unavailableItem,
          substitute: substitution.substitute,
          difference: enrichedDiff,
          originalPrice,
          substitutePrice,
          offerPrice,
          maxPrice,
        });
      } else {
        // Try to find a same-category substitute from inventory
        const categoryMatch = this.findCategorySubstitute(unavailableItem);
        if (categoryMatch) {
          const substituteEntry = PRICING_CATALOG.find(
            p => p.item_name.toLowerCase() === categoryMatch.name.toLowerCase() && !p.is_bundle,
          );
          const originalEntry = PRICING_CATALOG.find(
            p => p.item_name.toLowerCase() === unavailableItem.toLowerCase() && !p.is_bundle,
          );
          // Enrich with spec highlight
          const catHighlight = getSpecHighlight(categoryMatch.name);
          const enrichedReason = catHighlight
            ? `${categoryMatch.reason}. ${catHighlight}`
            : categoryMatch.reason;
          substitutions.push({
            original: unavailableItem,
            substitute: categoryMatch.name,
            difference: enrichedReason,
            originalPrice: originalEntry?.daily_price_max,
            substitutePrice: substituteEntry?.daily_price_max,
            offerPrice: originalEntry?.daily_price_max,
            maxPrice: originalEntry?.daily_price_max ? Math.round(originalEntry.daily_price_max * 1.15) : undefined,
          });
        } else {
          this.logger.debug(`No substitution found for: ${unavailableItem}`);
        }
      }
    }

    return substitutions;
  }

  /**
   * Find a same-category substitute from inventory when no explicit mapping exists.
   * Uses item categorization to suggest the closest alternative.
   */
  private findCategorySubstitute(itemName: string): { name: string; reason: string } | null {
    const lower = itemName.toLowerCase();
    const categoryAlternatives: Record<string, { items: string[]; reason: string }> = {
      camera: {
        items: ['Sony FX3', 'Sony A7 III', 'BMPCC 6K Pro'],
        reason: 'Alternative camera body from our inventory',
      },
      lens: {
        items: ['Sony GM 24-70mm f2.8', 'Sony GM 16-35mm f2.8', 'Sony GM 70-200mm f2.8'],
        reason: 'Alternative lens with similar focal range',
      },
      audio: {
        items: ['Rode Wireless Mic Pro set', 'DJI Wireless Mics', 'Rode Video Mic Pro Plus', 'Rode Video Mic Go', 'DJI Mic 2 wireless'],
        reason: 'Alternative audio solution from our inventory',
      },
      lighting: {
        items: ['LED light panels RGB', 'Nanlite Forza 300', 'Nanlite 500B', 'Nanlite Pavotube 30x II'],
        reason: 'Alternative lighting option from our inventory',
      },
      gimbal: {
        items: ['DJI RS3 Pro gimbal'],
        reason: 'Our available gimbal/stabilizer',
      },
      monitor: {
        items: ['Atomos Ninja V', 'Hollyland 7-inch monitor'],
        reason: 'Alternative monitor option from our inventory',
      },
    };

    // Determine item category
    let category: string | null = null;
    if (/\b(camera|fx3|a7|bmpcc|fuji)\b/i.test(lower)) category = 'camera';
    else if (/\b(lens|mm|prime|zoom|anamorphic)\b/i.test(lower)) category = 'lens';
    else if (/\b(mic|audio|wireless|rode|sennheiser)\b/i.test(lower)) category = 'audio';
    else if (/\b(light|led|forza|pavotube|nanlite|softbox)\b/i.test(lower)) category = 'lighting';
    else if (/\b(gimbal|stabilizer|rs3)\b/i.test(lower)) category = 'gimbal';
    else if (/\b(monitor|screen|atomos|hollyland)\b/i.test(lower)) category = 'monitor';

    if (!category || !categoryAlternatives[category]) return null;

    const { items, reason } = categoryAlternatives[category];
    // Find first item that isn't the unavailable one
    const substitute = items.find(i => i.toLowerCase() !== lower);
    if (!substitute) return null;

    return { name: substitute, reason };
  }

  /**
   * Find substitutions for standalone items (not necessarily in a bundle).
   * Used when individual items are unavailable in processMessage availability checks.
   */
  async findItemSubstitutions(
    unavailableItemNames: string[],
  ): Promise<Array<{ original: string; substitute: string; difference: string; originalPrice?: number; substitutePrice?: number; offerPrice?: number; maxPrice?: number }>> {
    // Re-use the same substitution logic with a dummy bundle
    const dummyBundle: BundleDefinition = {
      name: 'dummy',
      description: '',
      items: [],
      category: 'other',
      dailyPrice: 0,
      account: 'both',
      savings: 0,
      isFake: false,
    };
    return this.findSubstitutions(dummyBundle, unavailableItemNames);
  }

  /**
   * Check availability for all items in a bundle.
   * Returns a map of item name -> availability result.
   */
  private async checkBundleItemAvailability(
    bundle: BundleDefinition,
    startDate: Date,
    endDate: Date,
  ): Promise<Map<string, { available: boolean; booked: number; maxQuantity: number }>> {
    const availabilityMap = new Map<string, { available: boolean; booked: number; maxQuantity: number }>();

    // Deduplicate items (some bundles list the same item multiple times, e.g. 2x LED panels)
    const uniqueItems = [...new Set(bundle.items)];

    const checks = await Promise.all(
      uniqueItems.map(item => this.calendarService.checkAvailability(item, startDate, endDate)),
    );

    for (let i = 0; i < uniqueItems.length; i++) {
      availabilityMap.set(uniqueItems[i], {
        available: checks[i].available,
        booked: checks[i].booked,
        maxQuantity: checks[i].maxQuantity,
      });
    }

    return availabilityMap;
  }

  /**
   * Generate bundle recommendation text for AI prompt
   */
  async generateBundleContext(
    message: string,
    mentionedItems: string[],
    startDate?: Date,
    endDate?: Date,
  ): Promise<string> {
    if (mentionedItems.length === 0) {
      return '';
    }

    // Detect intent
    const intent = await this.detectItemIntent(message, mentionedItems);

    // If not suggesting bundle, return empty
    if (!intent.suggestBundle) {
      return '';
    }

    // Find matching bundles
    const recommendations = this.findMatchingBundles(mentionedItems, intent);

    if (recommendations.length === 0) {
      return '';
    }

    // Filter by availability if dates are provided
    let availableRecommendations = recommendations;
    if (startDate && endDate) {
      const filtered: BundleRecommendation[] = [];

      for (const rec of recommendations) {
        const availabilityMap = await this.checkBundleItemAvailability(rec.bundle, startDate, endDate);

        // Identify which of the matched (requested) items are unavailable
        const unavailableMatchedItems = rec.matchedItems.filter(item => {
          const avail = availabilityMap.get(item);
          return avail && !avail.available;
        });

        // If any of the key items the renter asked for are unavailable, skip this bundle
        if (unavailableMatchedItems.length > 0) {
          this.logger.debug(
            `Skipping bundle "${rec.bundle.name}": unavailable items [${unavailableMatchedItems.join(', ')}] for ${startDate.toISOString().split('T')[0]} - ${endDate.toISOString().split('T')[0]}`,
          );
          continue;
        }

        // Also check if any bundle-only (bonus) items are unavailable -- note but don't disqualify
        const unavailableBonusItems = rec.missingItems.filter(item => {
          const avail = availabilityMap.get(item);
          return avail && !avail.available;
        });

        if (unavailableBonusItems.length > 0) {
          rec.reason += ` (note: ${unavailableBonusItems.join(', ')} may be unavailable for these dates)`;
        }

        filtered.push(rec);
      }

      availableRecommendations = filtered;
    }

    if (availableRecommendations.length === 0) {
      return '';
    }

    // Build context string
    let context = '\n\n--- BUNDLE RECOMMENDATIONS ---\n';
    context += `Renter mentioned: ${mentionedItems.join(', ')}\n`;
    context += `Intent: ${intent.reasoning}\n`;
    if (startDate && endDate) {
      context += `Availability checked for: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`;
    }
    context += '\n';

    // Include top 2-3 recommendations
    const topRecommendations = availableRecommendations.slice(0, 3);

    for (const rec of topRecommendations) {
      context += `📦 ${rec.bundle.name} (£${rec.bundle.dailyPrice}/day)\n`;
      context += `   Includes: ${rec.bundle.items.join(', ')}\n`;
      context += `   ${rec.reason}\n`;
      context += `   Savings: ${rec.savings}\n`;

      if (rec.missingItems.length > 0) {
        context += `   Note: Bundle also includes ${rec.missingItems.join(', ')} (bonus items)\n`;
      }

      context += `   Confidence: ${Math.round(rec.confidence * 100)}%\n\n`;
    }

    context += 'INSTRUCTIONS: If the bundle is a good fit, mention it naturally. Frame it as a money-saving option, not a hard sell. Example: "The FX3 Cinema Kit has all that for £120/day - works out about 20% cheaper than renting it all separate."';

    return context;
  }

  /**
   * Fuzzy match two item names
   */
  private fuzzyMatch(item1: string, item2: string): boolean {
    const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    const norm1 = normalize(item1);
    const norm2 = normalize(item2);

    // Exact match after normalization
    if (norm1 === norm2) return true;

    // Check if one contains the other
    if (norm1.includes(norm2) || norm2.includes(norm1)) return true;

    // Check for key identifiers (camera models, lens specs)
    const extractKey = (str: string) => {
      const match = str.match(/FX3|A7III|A7II|BMPCC|24-70|70-200|16-35|90mm|RS3|Forza|Pavotube|Nanlite|Blazar|Remus/i);
      return match ? match[0].toLowerCase() : null;
    };

    const key1 = extractKey(item1);
    const key2 = extractKey(item2);

    return key1 !== null && key1 === key2;
  }

  /**
   * Get all bundles (for admin/inspection)
   */
  getAllBundles(): BundleDefinition[] {
    return this.bundles;
  }

  /**
   * Get bundles by category
   */
  getBundlesByCategory(category: string): BundleDefinition[] {
    return this.bundles.filter(b => b.category === category && !b.isFake);
  }
}
