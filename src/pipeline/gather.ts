/**
 * Layer 3: GATHER — Tool-First FactPack Assembly
 *
 * Instead of pre-loading 80+ context sections, loads ONLY what the
 * inner monologue and intent classification say is needed.
 * Estimated token reduction: ~9,650 → ~1,500-3,000 tokens (70-85%).
 */

import { Logger } from '@nestjs/common';
import { FactPack, MessageClassification, InnerMonologue, Intent, ItemPricing } from './types';
import { getItemPrice, PRICING_CATALOG, getPricesWithDbPreference } from '../data/pricing-catalog';
import { checkCompatibilityConflicts, detectMissingEssentials, formatCompatibilityForAI } from '../data/item-compatibility';
import { findBestMatch, getInventoryItemNames, validateListingItems, extractListingQuantity, MASTER_INVENTORY, detectBrandMismatch } from '../utils/item-matcher';

const logger = new Logger('PipelineGather');

/** Services needed by the gather layer — injected from pipeline.service */
export interface GatherServices {
  rulesService: { getFormattedRules(): Promise<string>; getCompactRules(): Promise<string>; getFormattedRulesForIntent(intent: string): Promise<string> };
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
    checkAvailability(item: string, start: Date, end: Date, excludeRentalId?: string): Promise<any>;
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
  renterProfileService?: {
    getProfileForRental(rentalId: string): Promise<any>;
    buildCompactCrossRentalSummary(profileId: string, currentRentalId: string): Promise<string | null>;
    isReturningRenter(renterName: string, currentRentalId: string): Promise<{
      isReturning: boolean;
      previousRentalCount: number;
      profileId?: string;
    }>;
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
    // Pre-loaded context from pipeline orchestrator (eliminates redundant DB calls)
    preloadedState?: Record<string, any>;
    preloadedStage?: string;
    preloadedConvState?: any; // Full conversation stage state object
    preloadedExtractedItems?: string[];
  },
): Promise<FactPack> {
  const { message, account, conversationHistory, rental } = input;
  const historyLength = conversationHistory.length;
  const isFirstMessage = historyLength === 0;
  const missingLower = (monologue.missing || '').toLowerCase();

  // --- Mandatory Facts (always loaded, ~300 tokens) ---

  // Resolve items from rental extracteditem records or classification
  // Use pre-loaded items from pipeline orchestrator when available (saves 1 DB call)
  let resolvedItems = classification.mentionedItems;
  let brandMismatchWarning: string | undefined;
  if (input.preloadedExtractedItems && input.preloadedExtractedItems.length > 0) {
    resolvedItems = [...new Set([...input.preloadedExtractedItems, ...classification.mentionedItems])];
  } else if (rental) {
    try {
      const extracted = await services.prisma.extracteditem.findMany({
        where: { rental_id: rental.id },
        select: { item_name: true, source: true },
      });
      if (extracted.length > 0) {
        const seen = new Map<string, string>();
        for (const e of extracted) {
          const existing = seen.get(e.item_name);
          if (!existing || e.source === 'photo_reference') {
            seen.set(e.item_name, e.source);
          }
        }
        const dbItems = [...seen.keys()];
        resolvedItems = [...new Set([...dbItems, ...classification.mentionedItems])];
      }
    } catch { /* non-critical */ }
  }

  // BRAND INTEGRITY CHECK: detect cross-brand mismatches between listing title and resolved items
  if (rental?.title && resolvedItems.length > 0) {
    const mismatches: string[] = [];
    for (const item of resolvedItems) {
      const brandCheck = detectBrandMismatch(rental.title, item);
      if (brandCheck.isMismatch) {
        mismatches.push(brandCheck.explanation);
      }
    }
    if (mismatches.length > 0) {
      brandMismatchWarning = mismatches.join('\n');
      logger.warn(`Brand mismatch detected for rental "${rental.title}": ${mismatches.length} item(s)`);
    }
  }

  // Also scan history for previously mentioned items (n-gram matching)
  const historyItems: string[] = [];
  const inventoryNames = getInventoryItemNames();
  for (const msg of conversationHistory.slice(-6)) {
    const msgLower = msg.content.toLowerCase();
    // Direct substring match for full inventory names
    for (const itemName of inventoryNames) {
      if (msgLower.includes(itemName.toLowerCase()) && !resolvedItems.includes(itemName) && !historyItems.includes(itemName)) {
        historyItems.push(itemName);
      }
    }
    // N-gram matching (2-4 word combos) for partial references
    const words = msg.content.split(/[\s,.\-!?;:()]+/).filter(w => w.length > 1);
    for (let n = Math.min(4, words.length); n >= 1; n--) {
      for (let i = 0; i <= words.length - n; i++) {
        const phrase = n === 1 ? words[i] : words.slice(i, i + n).join(' ');
        if (n === 1 && phrase.length < 3) continue;
        const match = findBestMatch(phrase, inventoryNames);
        if (match && !resolvedItems.includes(match) && !historyItems.includes(match)) {
          historyItems.push(match);
        }
      }
    }
  }
  const allRelevantItems = [...resolvedItems, ...historyItems];

  // Conversation state — use pre-loaded from pipeline orchestrator (saves 1 DB call)
  let conversationState: Record<string, any> = input.preloadedState || {};
  if (!input.preloadedState && rental) {
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
    // LOW-VALUE RENTAL DETECTION
    const ACCOUNT_MIN: Record<string, number> = { dbcinema: 20, leo: 25 };
    const accountMinimum = ACCOUNT_MIN[facts.rental.account] || 20;
    const estimatedEarnings = facts.rental.rentalPrice || (facts.rental.renterPrice ? Math.round(facts.rental.renterPrice * 0.64) : null);
    if (estimatedEarnings && estimatedEarnings < accountMinimum) {
      facts.lowValueInstruction =
        '\n=== LOW VALUE RENTAL — HARD BLOCK ===\n' +
        'Owner earnings: ~£' + estimatedEarnings + '. Minimum: £' + accountMinimum + '.\n' +
        'DO NOT confirm this rental at current price. DO NOT say "available", "sorted", "confirmed", or "all set".\n' +
        'Instead: (1) Suggest complementary add-on items, (2) If declined, state minimum booking total of £' + accountMinimum + '.\n' +
        '=== END LOW VALUE BLOCK ===\n';
    }
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

  const needsCompatibility = allRelevantItems.length >= 2 || classification.intent === 'equipment_question';

  const isEarlyStage = isFirstMessage || historyLength <= 6;

  // --- Parallel Fetches ---

  const fetchPromises: Promise<void>[] = [];

  // Rules (always needed, but compact for simple messages)
  fetchPromises.push(
    (async () => {
      try {
        facts.rules = (classification.contextLevel === 'minimal' || classification.complexity === 'low')
          ? await services.rulesService.getCompactRules()
          : await services.rulesService.getFormattedRulesForIntent(classification.intent);
      } catch { facts.rules = ''; }
    })(),
  );

  // Inventory context — only when items/pricing/availability are relevant (saves DB call on ~40% of messages)
  const needsInventory = classification.hasPricingIntent
    || classification.mentionedItems.length > 0
    || classification.intent === Intent.AVAILABILITY_CHECK
    || classification.intent === Intent.EQUIPMENT_QUESTION
    || classification.intent === Intent.PRICING_INQUIRY;
  if (needsInventory) {
    fetchPromises.push(
      (async () => {
        try {
          facts.inventoryContext = await services.calendarService.getCompactInventoryContext();
        } catch { /* non-critical */ }
      })(),
    );
  }

  // Availability — populate facts.availability so GROUND + CHECK can verify AI claims
  // Pass rental.id to exclude the renter's own bookings from the count (prevents self-blocking)
  if (needsInventory && allRelevantItems.length > 0 && rental?.start_date && rental?.end_date) {
    fetchPromises.push(
      (async () => {
        try {
          const items: import('./types').ItemAvailability[] = [];
          for (const itemName of allRelevantItems) {
            const result = await services.calendarService.checkAvailability(
              itemName, new Date(rental.start_date!), new Date(rental.end_date!), rental?.id,
            );
            if (result.matchedItem) {
              items.push({
                item: result.matchedItem,
                available: result.available,
                booked: result.booked,
                maxQuantity: result.maxQuantity,
                availableFrom: result.availableFrom,
                unavailableAfter: result.unavailableAfter,
              });
            }
          }
          if (items.length > 0) facts.availability = { items };
        } catch (e) {
          logger.warn('Availability check failed: ' + e);
        }
      })(),
    );
  }

  // Pricing (on-demand) - prefer database prices over catalog
  if (needsPrice && allRelevantItems.length > 0) {
    fetchPromises.push(
      (async () => {
        try {
          const itemPrices: ItemPricing[] = [];
          
          // First try to get prices from database (actual Hygglo listing prices)
          const dbPrices = await getPricesWithDbPreference(services.prisma, allRelevantItems);
          
          for (const item of allRelevantItems) {
            const dbPrice = dbPrices.get(item);
            if (dbPrice) {
              // Use database price
              itemPrices.push({
                itemName: item,
                dailyMin: dbPrice.daily_price,
                dailyMax: dbPrice.daily_price,
                renterPays: dbPrice.daily_price,
                source: dbPrice.source,
              });
            } else {
              // Fall back to catalog price
              const entry = getItemPrice(item);
              if (entry) {
                itemPrices.push({
                  itemName: entry.item_name,
                  dailyMin: entry.daily_price_min,
                  dailyMax: entry.daily_price_max,
                  renterPays: entry.daily_price_max,
                  source: 'catalog' as const,
                });
              }
            }
          }
          
          // Also get bundle prices from catalog (bundles aren't in DB as single items)
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
                source: 'catalog' as const,
              });
            }
          }
          
          facts.pricing = {
            itemPrices,
            bundlePrices: bundlePrices.length > 0 ? bundlePrices : undefined,
            multiDayNote: 'Multi-day discounts: 3 days = 2.5x daily rate, 7+ days = 5x daily rate. All other durations (1,2,4,5,6 days) = full daily rate × days. Database prices preferred over catalog.',
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

  // Stage guidance (production only) — use pre-loaded convState when available (saves 1 DB call)
  if (rental) {
    if (input.preloadedConvState) {
      facts.stageGuidance = services.conversationStageService.getStagePromptFromState(input.preloadedConvState);
      facts.conversationStage = input.preloadedConvState.currentStage;
    } else {
      fetchPromises.push(
        (async () => {
          try {
            const convState = await services.conversationStageService.getConversationState(rental.id);
            if (convState) {
              facts.stageGuidance = services.conversationStageService.getStagePromptFromState(convState);
              facts.conversationStage = convState.currentStage;
            }
          } catch { /* non-critical */ }
        })(),
      );
    }
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
          const isAccepted = ['pending', 'upcoming', 'ongoing', 'completed'].some(s => statusLower.includes(s));
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

    // Verified listing item context — reuse resolvedItems (already fetched above, no extra DB call)
    if (resolvedItems.length > 0) {
      if (brandMismatchWarning) {
        // Cross-brand mismatch: override listing context with strong warning
        facts.verifiedListingItem = brandMismatchWarning;
        // Also override listingInventoryContext if not already set
        if (!facts.listingInventoryContext) {
          facts.listingInventoryContext = brandMismatchWarning;
        }
      } else {
        facts.verifiedListingItem = `Actual item(s): ${resolvedItems.join(', ')}. Ignore SEO keywords in listing title.`;
      }
    }

    // Renter profile — cross-rental memory for returning renters
    if (services.renterProfileService) {
      fetchPromises.push(
        (async () => {
          try {
            const profile = await services.renterProfileService!.getProfileForRental(rental.id);
            if (profile) {
              const compactSummary = await services.renterProfileService!.buildCompactCrossRentalSummary(profile.id, rental.id);
              if (compactSummary) {
                facts.renterProfile = compactSummary;
                facts.welcomeBack = true;
              }
            }
          } catch { /* non-critical */ }
        })(),
      );
    }
  }

  // Conversation history — smart truncation with AI summary (preferred) or regex fallback
  if (conversationHistory.length > 0) {
    // Compress long assistant messages to key-fact summaries before truncation.
    // A 400-token bot response becomes ~80 tokens of key facts, fitting more turns in fewer tokens.
    const compressedHistory = conversationHistory.map(m => {
      if (m.role === 'assistant' && m.content.length > 300) {
        const kf: string[] = [];
        const prices = m.content.match(/\u00a3\d[\d,]*(?:\.\d{2})?/g);
        if (prices) kf.push(prices.join(', '));
        const avail = m.content.match(/[^.!?]*\b(?:available|unavailable|out of stock|not available|booked)\b[^.!?]*/i);
        if (avail) kf.push(avail[0].trim().substring(0, 80));
        const logistics = m.content.match(/[^.!?]*\b(?:pickup|deliver|collect|return|morning|evening|\d{1,2}(?:am|pm))\b[^.!?]*/i);
        if (logistics) kf.push(logistics[0].trim().substring(0, 80));
        const firstLine = m.content.split(/[.!?\n]/)[0]?.trim() || '';
        return { role: m.role, content: '[' + firstLine.substring(0, 60) + (kf.length ? '. ' + kf.join('. ') : '') + ']' };
      }
      return m;
    });

    // Token budget: keep messages within ~1250 tokens (5000 chars).
    // Compressed history + first/last preservation + summary fallback ensure context is retained.
    const HISTORY_CHAR_BUDGET = 5000;
    let charCount = 0;
    const budgeted: typeof compressedHistory = [];
    if (compressedHistory.length >= 2) {
      budgeted.push(compressedHistory[0], compressedHistory[1]);
      charCount = compressedHistory[0].content.length + compressedHistory[1].content.length;
    }
    for (let i = compressedHistory.length - 1; i >= 2; i--) {
      if (charCount + compressedHistory[i].content.length > HISTORY_CHAR_BUDGET) break;
      budgeted.splice(2, 0, compressedHistory[i]);
      charCount += compressedHistory[i].content.length;
    }

    if (budgeted.length <= 8) {
      facts.conversationHistory = budgeted;
    } else {
      const first2 = budgeted.slice(0, 2);
      const last8 = budgeted.slice(-4);
      const droppedMessages = budgeted.slice(2, -4);

      // Prefer AI-built summary from DB (zero extra AI cost, better quality)
      let summaryText: string | null = null;
      if (rental) {
        try {
          summaryText = await services.memoryService.getCachedSummary(rental.id);
        } catch { /* non-critical */ }
      }
      // Fall back to regex summary if no AI summary available
      if (!summaryText) {
        summaryText = buildStructuredSummary(droppedMessages, allRelevantItems);
      }

      // Fix role alternation: ensure summary doesn't create consecutive same-role turns
      const summaryRole = last8[0]?.role === 'assistant' ? 'user' as const : 'assistant' as const;
      const summaryMsg = {
        role: summaryRole,
        content: summaryRole === 'user' ? `[System summary] ${summaryText}` : summaryText,
      };
      facts.conversationHistory = [...first2, summaryMsg, ...last8];
      facts.conversationSummary = summaryText;
    }
  }

  // Execute all parallel fetches
  await Promise.all(fetchPromises);

  return facts;
}
