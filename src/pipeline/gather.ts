/**
 * Layer 3: GATHER — Tool-First FactPack Assembly
 *
 * Instead of pre-loading 80+ context sections, loads ONLY what the
 * inner monologue and intent classification say is needed.
 * Estimated token reduction: ~9,650 → ~1,500-3,000 tokens (70-85%).
 */

import { Logger } from '@nestjs/common';
import { FactPack, MessageClassification, InnerMonologue, Intent, ItemPricing } from './types';
import { formatFilteredPricingForAI, getItemPrice, PRICING_CATALOG } from '../data/pricing-catalog';
import { checkCompatibilityConflicts, detectMissingEssentials, formatCompatibilityForAI } from '../data/item-compatibility';
import { findBestMatch, getInventoryItemNames, validateListingItems, extractListingQuantity, MASTER_INVENTORY } from '../utils/item-matcher';

const logger = new Logger('PipelineGather');

/** Services needed by the gather layer — injected from pipeline.service */
export interface GatherServices {
  rulesService: { getFormattedRules(): Promise<string>; getCompactRules(): Promise<string> };
  memoryService: {
    getRelevantMemories(keywords: string[], limit: number): Promise<string>;
    getPricingMemories(): Promise<string>;
    getMinimalMemories(keywords: string[], limit: number): Promise<string>;
    getCompatibilityContext(items: string[]): string;
    getItemSpecsContext(items: string[]): string;
    getAccountTemplates(account: 'dbcinema' | 'leo'): Promise<string | null>;
    getBundleSuggestionContext(message: string, items: string[]): string;
    getPricingCatalogContext(): string;
    getCachedSummary(rentalId: string): Promise<string | null>;
  };
  calendarService: {
    getCompactInventoryContext(): Promise<string>;
    getFormattedSchedule(date: Date): Promise<string | null>;
    checkAvailability(item: string, start: Date, end: Date): Promise<any>;
  };
  deliveryService: {
    calculateQuote(postcode: string, items: string[]): Promise<any>;
    determineVehicle(items: string[]): Promise<any>;
  };
  recommendationService: {
    generateRecommendations(params: any): Promise<{ bundleContext?: string; upsellContext?: string }>;
  };
  demandService: {
    getTopRequestedItems(days: number): Promise<[string, number][]>;
  };
  conversationStageService: {
    getConversationState(rentalId: string): Promise<any>;
    getStagePromptFromState(state: any): string;
  };
  followUpService: {
    getStructuredState(rentalId: string): Promise<Record<string, any>>;
  };
  contentionService?: {
    getActiveContentionsForRental(rentalId: string): Promise<any[]>;
  };
  prisma: any;
}

/**
 * Deterministic structured summary — extracts key facts from dropped messages via regex.
 * Zero latency cost (no AI call).
 */
function buildStructuredSummary(
  droppedMessages: { role: string; content: string }[],
  relevantItems: string[],
): string {
  const allText = droppedMessages.map(m => m.content).join(' ');
  const parts: string[] = [`[${droppedMessages.length} earlier messages summarized]`];

  // Items discussed
  if (relevantItems.length > 0) {
    parts.push(`Items: ${relevantItems.slice(0, 6).join(', ')}`);
  }

  // Prices mentioned
  const prices = allText.match(/£\d+[\d,.]*/g);
  if (prices && prices.length > 0) {
    const unique = [...new Set(prices)];
    parts.push(`Prices quoted: ${unique.slice(0, 4).join(', ')}`);
  }

  // Dates mentioned
  const dates = allText.match(/\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*|\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+\d{1,2}(?:st|nd|rd|th)?)\b/gi);
  if (dates && dates.length > 0) {
    const unique = [...new Set(dates)];
    parts.push(`Dates: ${unique.slice(0, 3).join(', ')}`);
  }

  // Project/shoot type
  const shootMatch = allText.match(/\b(wedding|corporate|music video|documentary|short film|commercial|event|interview|youtube|content|shoot|production|film)\b/i);
  if (shootMatch) {
    parts.push(`Project: ${shootMatch[1]}`);
  }

  // Concerns/hesitations
  const concerns: string[] = [];
  if (/\b(too expensive|over budget|cheaper|tight budget)\b/i.test(allText)) concerns.push('price sensitivity');
  if (/\b(not sure|maybe|let me think|need to check)\b/i.test(allText)) concerns.push('undecided');
  if (/\b(damage|insurance|deposit|security)\b/i.test(allText)) concerns.push('damage/insurance');
  if (concerns.length > 0) {
    parts.push(`Concerns: ${concerns.join(', ')}`);
  }

  // Decisions made
  const decisions: string[] = [];
  if (/\b(sounds good|let'?s go|i'?ll take|perfect|confirmed?|agreed)\b/i.test(allText)) decisions.push('positive agreement');
  if (/\b(deliver|pickup|collect)\b/i.test(allText)) decisions.push('logistics discussed');
  if (decisions.length > 0) {
    parts.push(`Decided: ${decisions.join(', ')}`);
  }

  return parts.join(' | ');
}

export async function gatherFacts(
  classification: MessageClassification,
  monologue: InnerMonologue,
  services: GatherServices,
  input: {
    message: string;
    account: 'dbcinema' | 'leo';
    conversationHistory: { role: 'user' | 'assistant'; content: string }[];
    rental?: any;
    isSimulation: boolean;
  },
): Promise<FactPack> {
  const { message, account, conversationHistory, rental } = input;
  const historyLength = conversationHistory.length;
  const isFirstMessage = historyLength === 0;
  const missingLower = (monologue.missing || '').toLowerCase();

  // --- Mandatory Facts (always loaded, ~300 tokens) ---

  // Resolve items from rental extracteditem records or classification
  let resolvedItems = classification.mentionedItems;
  if (rental) {
    try {
      const extracted = await services.prisma.extracteditem.findMany({
        where: { rental_id: rental.id, source: 'listing_title' },
        select: { item_name: true },
      });
      if (extracted.length > 0) {
        const dbItems = extracted.map((e: any) => e.item_name);
        resolvedItems = [...new Set([...dbItems, ...classification.mentionedItems])];
      }
    } catch { /* non-critical */ }
  }

  // Also scan history for previously mentioned items
  const historyItems: string[] = [];
  const inventoryNames = getInventoryItemNames();
  for (const msg of conversationHistory.slice(-6)) {
    const words = msg.content.split(/[\s,.\-!?;:()]+/).filter(w => w.length > 2);
    for (const w of words) {
      const match = findBestMatch(w, inventoryNames);
      if (match && !resolvedItems.includes(match) && !historyItems.includes(match)) {
        historyItems.push(match);
      }
    }
  }
  const allRelevantItems = [...resolvedItems, ...historyItems];

  // Conversation state from DB
  let conversationState: Record<string, any> = {};
  if (rental) {
    try {
      conversationState = await services.followUpService.getStructuredState(rental.id);
    } catch { /* non-critical */ }
  }

  // Initialize FactPack
  const facts: FactPack = {
    resolvedItems: allRelevantItems,
    conversationState,
    renterDNA: classification.renterDNA,
    suppressUpsell: classification.suppressUpsell,
  };

  // Rental context
  if (rental) {
    const days = rental.start_date && rental.end_date
      ? Math.max(1, Math.round((new Date(rental.end_date).getTime() - new Date(rental.start_date).getTime()) / (1000 * 60 * 60 * 24)) + 1)
      : undefined;
    facts.rental = {
      id: rental.id,
      title: rental.title,
      status: rental.status,
      startDate: rental.start_date,
      endDate: rental.end_date,
      renterName: rental.renter_info || 'Unknown',
      isFirstTime: false,
      platform: 'hygglo',
      account: rental.account || account,
      rentalPrice: rental.rental_price,
      renterPrice: rental.renter_price,
      days,
    };
  }

  // --- Determine what on-demand facts are needed ---

  const needsPrice = classification.hasPricingIntent
    || classification.intent === Intent.PRICING_INQUIRY
    || missingLower.includes('price')
    || missingLower.includes('cost')
    || missingLower.includes('rate');

  const needsAvailability = classification.intent === Intent.AVAILABILITY_CHECK
    || missingLower.includes('availab')
    || missingLower.includes('date');

  const needsDelivery = classification.hasDeliveryIntent
    || missingLower.includes('deliver')
    || missingLower.includes('postcode');

  const needsSchedule = classification.hasSchedulingIntent
    || classification.isLogisticsMessage
    || missingLower.includes('pickup')
    || missingLower.includes('time')
    || missingLower.includes('schedule');

  const needsCompatibility = allRelevantItems.length >= 2;

  const isEarlyStage = isFirstMessage || historyLength <= 6;

  // --- Parallel Fetches ---

  const fetchPromises: Promise<void>[] = [];

  // Rules (always needed, but compact for simple messages)
  fetchPromises.push(
    (async () => {
      try {
        facts.rules = classification.contextLevel === 'minimal'
          ? await services.rulesService.getCompactRules()
          : await services.rulesService.getFormattedRules();
      } catch { facts.rules = ''; }
    })(),
  );

  // Inventory context (always needed for accurate item awareness)
  fetchPromises.push(
    (async () => {
      try {
        facts.inventoryContext = await services.calendarService.getCompactInventoryContext();
      } catch { /* non-critical */ }
    })(),
  );

  // Pricing (on-demand)
  if (needsPrice && allRelevantItems.length > 0) {
    fetchPromises.push(
      (async () => {
        try {
          const itemPrices: ItemPricing[] = [];
          for (const item of allRelevantItems) {
            const entry = getItemPrice(item);
            if (entry) {
              itemPrices.push({
                itemName: entry.item_name,
                dailyMin: entry.daily_price_min,
                dailyMax: entry.daily_price_max,
                renterPays: entry.daily_price_max,
                ownerEarns: Math.round(entry.daily_price_max * 0.64),
              });
            }
          }
          // Also get bundle prices
          const bundlePrices: ItemPricing[] = [];
          for (const entry of PRICING_CATALOG) {
            if (entry.is_bundle && entry.bundle_items?.some((bi: string) =>
              allRelevantItems.some(ai => bi.toLowerCase().includes(ai.toLowerCase()) || ai.toLowerCase().includes(bi.toLowerCase()))
            )) {
              bundlePrices.push({
                itemName: entry.item_name,
                dailyMin: entry.daily_price_min,
                dailyMax: entry.daily_price_max,
                renterPays: entry.daily_price_max,
                ownerEarns: Math.round(entry.daily_price_max * 0.64),
              });
            }
          }
          facts.pricing = {
            itemPrices,
            bundlePrices: bundlePrices.length > 0 ? bundlePrices : undefined,
            multiDayNote: 'Multi-day: 3d ~2.5x, 7d ~5x daily rate.',
          };
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Delivery (on-demand)
  if (needsDelivery) {
    fetchPromises.push(
      (async () => {
        try {
          const postcodeMatch = message.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
          const historyText = conversationHistory.map(m => m.content).join(' ');
          const historyPostcodeMatch = !postcodeMatch ? historyText.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i) : null;
          const postcode = postcodeMatch?.[1] || historyPostcodeMatch?.[1];

          const deliveryItems = allRelevantItems.length > 0 ? allRelevantItems : ['camera'];

          if (postcode) {
            const quote = await services.deliveryService.calculateQuote(postcode, deliveryItems);
            if (quote) {
              let ctx = `Postcode: ${postcode.toUpperCase()}, Distance: ${quote.distance_km}km, Zone: ${quote.zone}, `;
              ctx += `Courier: ${quote.vehicle_display} (${quote.courier_explanation})`;
              if (quote.price_min > 0) {
                ctx += `, One-way: £${quote.price_min}-${quote.price_max}, Round-trip: £${Math.round(quote.price_min * 1.8)}-${Math.round(quote.price_max * 1.8)}`;
              }
              facts.delivery = ctx;
            }
          } else {
            const vehicleInfo = await services.deliveryService.determineVehicle(deliveryItems);
            facts.delivery = `Courier needed: ${vehicleInfo.vehicle_display} (${vehicleInfo.courier_explanation}). Ask for postcode.`;
          }
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Schedule (on-demand)
  if (needsSchedule) {
    fetchPromises.push(
      (async () => {
        try {
          const schedule = await services.calendarService.getFormattedSchedule(new Date());
          if (schedule) facts.schedule = schedule;
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Compatibility (on-demand, when multiple items)
  if (needsCompatibility) {
    fetchPromises.push(
      (async () => {
        try {
          const compat = services.memoryService.getCompatibilityContext(allRelevantItems);
          const specs = services.memoryService.getItemSpecsContext(allRelevantItems);
          const { conflicts } = checkCompatibilityConflicts(allRelevantItems);
          const parts: string[] = [];
          if (conflicts.length > 0) {
            parts.push('CONFLICTS: ' + conflicts.map(c => `${c.camera} incompatible with ${c.item}: ${c.reason}`).join('; '));
          }
          if (compat) parts.push(compat);
          if (specs) parts.push(specs);
          facts.compatibility = parts.join('\n');
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Recommendations + upsell (early stage only, not suppressed)
  if (isEarlyStage && !classification.suppressUpsell) {
    fetchPromises.push(
      (async () => {
        try {
          const recs = await services.recommendationService.generateRecommendations({
            message,
            mentionedItems: classification.mentionedItems,
            conversationText: message,
            estimatedTotal: allRelevantItems.reduce((sum, item) => {
              const entry = PRICING_CATALOG.find(p => p.item_name.toLowerCase() === item.toLowerCase());
              return sum + (entry ? entry.daily_price_max : 25);
            }, 0) || 25,
            hasPricingIntent: classification.hasPricingIntent,
          });
          if (recs.bundleContext) facts.bundleContext = recs.bundleContext;
          if (recs.upsellContext) facts.upsellContext = recs.upsellContext;
        } catch { /* non-critical */ }
      })(),
    );

    // Demand data for trending items
    fetchPromises.push(
      (async () => {
        try {
          const topItems = await services.demandService.getTopRequestedItems(30);
          if (topItems.length > 0 && isFirstMessage) {
            const trendLines = topItems.slice(0, 3).map(([item, count]) => `${item}: ${count}`).join(', ');
            facts.upsellContext = (facts.upsellContext || '') + `\nTrending: ${trendLines}`;
          }
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Account templates (first 3 messages only)
  if (historyLength <= 4) {
    fetchPromises.push(
      (async () => {
        try {
          facts.accountTemplates = await services.memoryService.getAccountTemplates(account) || undefined;
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Stage guidance (production only)
  if (rental) {
    fetchPromises.push(
      (async () => {
        try {
          const convState = await services.conversationStageService.getConversationState(rental.id);
          if (convState) {
            facts.stageGuidance = services.conversationStageService.getStagePromptFromState(convState);
          }
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Contention urgency context (production only, favored rental)
  if (rental && services.contentionService) {
    fetchPromises.push(
      (async () => {
        try {
          const contentions = await services.contentionService!.getActiveContentionsForRental(rental.id);
          if (contentions.length > 0) {
            const items = contentions.map(c => c.item_name).join(', ');
            facts.urgency = `HIGH DEMAND: The ${items} is in high demand for these dates. ` +
              `Other renters are also interested. Subtly convey scarcity and encourage the renter to confirm soon, ` +
              `but do NOT be pushy or mention specific competitors.`;
          }
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Listing inventory validation (production only, pre-accepted rentals)
  if (rental) {
    fetchPromises.push(
      (async () => {
        try {
          const statusLower = (rental.status || '').toLowerCase();
          const isAccepted = ['upcoming', 'ongoing', 'completed'].some(s => statusLower.includes(s));
          if (!isAccepted) {
            const validation = validateListingItems(rental.title);
            const listingQty = extractListingQuantity(rental.title);

            if (validation.noneMatched) {
              const alt = findBestMatch(rental.title, inventoryNames);
              facts.listingInventoryContext = alt
                ? `"${rental.title}" unavailable. Closest: "${alt}" (${MASTER_INVENTORY[alt]} units). Offer alternative.`
                : `"${rental.title}" unavailable, no similar alternative.`;
            } else if (validation.someMatched && validation.isComboListing) {
              const matched = validation.items.filter(i => i.matched).map(i => `"${i.inventoryItem}"`).join(', ');
              const unmatched = validation.items.filter(i => !i.matched).map(i => `"${i.name}"`).join(', ');
              facts.listingInventoryContext = `Combo listing. In stock: ${matched}. Not available: ${unmatched}.`;
            } else if (validation.allMatched && !validation.isComboListing) {
              const singleItem = validation.items[0];
              if (listingQty > singleItem.maxQuantity) {
                facts.listingInventoryContext = `Listing says "${listingQty}x" but only ${singleItem.maxQuantity} in stock.`;
              }
            }
          }
        } catch { /* non-critical */ }
      })(),
    );

    // Verified listing item context
    fetchPromises.push(
      (async () => {
        try {
          const extracted = await services.prisma.extracteditem.findMany({
            where: { rental_id: rental.id, source: 'listing_title' },
            select: { item_name: true },
          });
          if (extracted.length > 0) {
            const names = extracted.map((e: any) => e.item_name).join(', ');
            facts.verifiedListingItem = `Actual item(s): ${names}. Ignore SEO keywords in listing title.`;
          }
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Conversation history — smart truncation with structured summary
  if (conversationHistory.length > 0) {
    if (conversationHistory.length <= 10) {
      facts.conversationHistory = conversationHistory;
    } else {
      const first2 = conversationHistory.slice(0, 2);
      const last8 = conversationHistory.slice(-8);
      const droppedMessages = conversationHistory.slice(2, -8);
      const structuredSummary = buildStructuredSummary(droppedMessages, allRelevantItems);
      const summaryMsg = {
        role: 'assistant' as const,
        content: structuredSummary,
      };
      facts.conversationHistory = [...first2, summaryMsg, ...last8];
      facts.conversationSummary = structuredSummary;
    }
  }

  // Execute all parallel fetches
  await Promise.all(fetchPromises);

  return facts;
}
