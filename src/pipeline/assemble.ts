/**
 * Layer 4: TALK — Persona-Adaptive Prompt Assembly
 *
 * Builds a compact, focused prompt from FactPack + InnerMonologue + RenterDNA.
 * Target: ~1,200-1,800 tokens (was ~9,650).
 *
 * Sections:
 * 1. Identity (~100 tokens) — persona
 * 2. This Renter (~50 tokens) — DNA-driven adaptation
 * 3. Your Plan (~100 tokens) — from inner monologue
 * 4. Verified Facts (~200-800 tokens) — from FactPack
 * 5. Rules (~300 tokens) — compact business rules
 * 6. History (~400 tokens) — last exchanges
 */

import { FactPack, InnerMonologue, MessageClassification, RenterDNA } from './types';
import { getInventoryItemNames } from '../utils/item-matcher';
import { AiContext } from '../ai/ai.service';
import { buildKnownFacts } from './ground';

// Marketing listing items — these are NOT real inventory.
// Loaded once at startup and refreshed periodically.
let marketingListingItems: string[] = [];
let marketingItemsLastLoaded = 0;

export function setMarketingListingItems(items: string[]): void {
  marketingListingItems = items;
  marketingItemsLastLoaded = Date.now();
}

export function getMarketingListingItems(): string[] {
  return marketingListingItems;
}

// Section 1: Identity — now handled by DB 'identity' + 'communication_style' prompt components.
// buildIdentitySection() removed to eliminate duplication (~150 tokens saved per message).

// --- Section 2: Renter Adaptation ---

function buildRenterSection(dna: RenterDNA): string {
  const parts: string[] = [];

  // Tone matching
  if (dna.style === 'casual') parts.push('Match their casual tone. Informal language OK.');
  else if (dna.style === 'formal') parts.push('Professional tone. Complete sentences.');
  else parts.push('Keep it brief and direct.');

  // Expertise adaptation
  if (dna.expertise === 'pro') parts.push('Technical details welcome. Skip basic explanations.');
  else if (dna.expertise === 'beginner') parts.push('Explain simply. No jargon.');

  // Driver-based framing
  if (dna.driver === 'price') parts.push('Lead with price/value. Mention multi-day savings when relevant.');
  else if (dna.driver === 'quality') parts.push('Emphasize quality/reliability. Technical specs welcome.');
  else parts.push('Focus on convenience/logistics.');

  // Energy matching
  if (dna.energy === 'enthusiastic') parts.push('Match their energy. Be upbeat.');
  else if (dna.energy === 'hesitant') parts.push('Be reassuring. Don\'t rush. Provide info to help them decide.');

  // Decision speed
  if (dna.decisionSpeed === 'fast') parts.push('They decide fast — be direct.');

  return `RENTER PROFILE: ${dna.style}, ${dna.expertise}, ${dna.driver}-driven, ${dna.energy}.\n${parts.join(' ')}`;
}

// --- Section 3: Strategic Plan ---

function buildPlanSection(monologue: InnerMonologue): string {
  const parts = [
    `GOAL: ${monologue.goal}`,
    `PLAN: ${monologue.plan.map((p, i) => `${i + 1}) ${p}`).join(' ')}`,
  ];
  if (monologue.avoid.length > 0) {
    parts.push(`AVOID: ${monologue.avoid.join('. ')}`);
  }
  parts.push(`TONE: ${monologue.tone}`);
  return parts.join('\n');
}

// --- Section 4: Verified Facts ---

function buildFactsSection(facts: FactPack, classification: MessageClassification): string {
  const parts: string[] = [];

  // Rental context
  if (facts.rental) {
    const r = facts.rental;
    const startStr = r.startDate ? new Date(r.startDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
    const endStr = r.endDate ? new Date(r.endDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
    // Calculate return morning (day after end date) — renters keep gear through the last rental day
    let returnMorningStr = '';
    if (r.endDate) {
      const returnDate = new Date(r.endDate);
      returnDate.setDate(returnDate.getDate() + 1);
      returnMorningStr = ` → return morning of ${returnDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`;
    }
    parts.push(`Rental: ${r.title} | Status: ${r.status} | Dates: ${startStr} to ${endStr}${r.days ? ` (${r.days} day${r.days > 1 ? 's' : ''})` : ''}${returnMorningStr}`);
    parts.push(`Renter: ${r.renterName}`);
    if (r.renterPrice) parts.push(`Total price: £${r.renterPrice}`);
  }

  // Resolved items
  if (facts.resolvedItems.length > 0) {
    parts.push(`Items: ${facts.resolvedItems.join(', ')}`);
  }

  // Verified listing item
  if (facts.verifiedListingItem) parts.push(facts.verifiedListingItem);

  // Listing inventory context
  if (facts.listingInventoryContext) parts.push(facts.listingInventoryContext);

  // Pricing — disambiguate standalone vs bundle/kit
  if (facts.pricing) {
    for (const p of facts.pricing.itemPrices) {
      parts.push(`${p.itemName} (standalone item): £${p.dailyMin}-${p.dailyMax}/day`);
    }
    if (facts.pricing.bundlePrices) {
      for (const b of facts.pricing.bundlePrices) {
        parts.push(`BUNDLE: ${b.itemName} (complete kit): £${b.dailyMin}-${b.dailyMax}/day`);
      }
      parts.push('NOTE: Bundle/kit prices are for the COMPLETE kit together. Individual prices are for one item only. Match the price to what the renter is actually booking.');
    }
    parts.push(facts.pricing.multiDayNote);
  }

  // Delivery
  if (facts.delivery) parts.push(`DELIVERY: ${facts.delivery}`);

  // Schedule
  if (facts.schedule) parts.push(`SCHEDULE: ${facts.schedule}`);

  // Compatibility
  if (facts.compatibility) parts.push(facts.compatibility);

  // Inventory context
  if (facts.inventoryContext) parts.push(facts.inventoryContext);

  // Conversation state (what's already been discussed)
  const state = facts.conversationState;
  const stateLines: string[] = [];
  if (state.confirmedItems?.length) stateLines.push(`Confirmed: ${state.confirmedItems.join(', ')}`);
  if (state.agreedPickupTime) stateLines.push(`Pickup: ${state.agreedPickupTime}`);
  if (state.agreedReturnTime) stateLines.push(`Return: ${state.agreedReturnTime}`);
  if (state.renterShootType) stateLines.push(`Shoot: ${state.renterShootType}`);
  if (state.questionsAsked?.length) stateLines.push(`Already asked: ${state.questionsAsked.join(', ')}`);
  if (state.upsellAttempted) stateLines.push('Upselling already attempted — do NOT upsell again');
  if (state.priceQuoted) stateLines.push(`Last quoted: £${state.priceQuoted}`);
  if (state.deliveryDiscussed) stateLines.push('Delivery already discussed');
  if (state.unavailabilityMentioned) stateLines.push('IMPORTANT: You already told this renter about item unavailability — do NOT repeat the warning. If they bring it up, acknowledge briefly and move forward (suggest alternatives or ask how else you can help).');
  if (stateLines.length > 0) {
    parts.push(`CONVERSATION STATE:\n${stateLines.join('\n')}\nDo NOT re-ask questions above. Do NOT repeat established facts.`);
  }

  // Urgency
  if (facts.urgency) parts.push(facts.urgency);

  // Welcome back
  if (facts.welcomeBack) {
    parts.push('RETURNING RENTER: Welcome warmly. Skip re-introductions. Get straight to helping.');
  }

  // Multi-rental coordination
  if (facts.multiRental) parts.push(facts.multiRental);

  // Discount context
  if (facts.discountContext) parts.push(facts.discountContext);

  // Low value instruction
  if (facts.lowValueInstruction) parts.push(facts.lowValueInstruction);

  // Stage guidance — now promoted to sales directive section (see buildSalesDirectiveSection)
  // Kept here ONLY as fallback if salesDirective section is empty
  // if (facts.stageGuidance) parts.push(facts.stageGuidance);

  // Renter profile
  if (facts.renterProfile) parts.push(facts.renterProfile);

  // Account templates
  if (facts.accountTemplates) parts.push(facts.accountTemplates);

  // Upsell + Bundle context (only when not suppressed)
  if (!facts.suppressUpsell) {
    if (facts.bundleContext) parts.push(facts.bundleContext);
    if (facts.upsellContext) parts.push(facts.upsellContext);
  } else {
    parts.push('Do NOT suggest additional items. Answer what the renter asked — keep it focused.');
  }

  // Conversation summary
  if (facts.conversationSummary) parts.push(`SUMMARY: ${facts.conversationSummary}`);

  return parts.join('\n');
}

// --- Section: Sales Directive (promoted from stageGuidance) ---

function buildSalesDirectiveSection(
  monologue: InnerMonologue,
  facts: FactPack,
  classification: MessageClassification,
): string {
  const parts: string[] = [];

  // Stage guidance (promoted from facts — now a directive, not a fact)
  if (facts.stageGuidance) {
    parts.push(facts.stageGuidance);
  }

  // Sales action from inner monologue
  if (monologue.salesAction) {
    parts.push(`YOUR NEXT MOVE: ${monologue.salesAction}`);
  }

  // Momentum-based adaptation
  if (classification.momentum === 'accelerating') {
    parts.push('MOMENTUM: High — use assumptive close language ("I\'ll hold that for you", "shall I confirm?"). Be direct.');
  } else if (classification.momentum === 'decelerating') {
    parts.push('MOMENTUM: Dropping — address any concerns, provide reassurance, don\'t push. Rebuild confidence first.');
  }

  return parts.length > 0 ? parts.join('\n') : '';
}

// --- Section: Negotiation Strategy ---

function buildNegotiationStrategy(facts: FactPack): string {
  const state = facts.conversationState;
  const objections = state.priceObjectionCount || 0;
  const competitor = state.competitorMentioned || false;
  if (objections === 0 && !competitor) return '';

  const parts = ['--- NEGOTIATION GUIDANCE ---'];

  if (competitor) {
    parts.push(
      'COMPETITOR MENTIONED: Acknowledge, don\'t dismiss. ' +
      '"I appreciate you sharing that — our prices reflect professional maintenance and support. Let me see what I can do."',
    );
  }

  if (objections === 1) {
    parts.push(
      'STANCE: HOLD FIRM. First pushback. Emphasize value: professional gear, flexible logistics, insurance coverage. ' +
      'Mention multi-day savings if relevant. Do NOT offer discounts yet.',
    );
  } else if (objections === 2) {
    parts.push(
      'STANCE: OFFER ALTERNATIVES. Second pushback. Suggest: (1) longer rental for better daily rate, (2) alternative gear at lower price point.' +
      (facts.discountContext ? ' A discount IS available — you may surface it now.' : ''),
    );
  } else if (objections >= 3) {
    parts.push(
      'STANCE: SOFT YIELD. Third+ pushback.' +
      (facts.discountContext ? ' Surface the available discount now.' : ' Offer to check with Daniel for a special rate.') +
      ' Never go below cost. If still unsatisfied, gracefully offer them time to compare options.',
    );
  }

  if (state.lastPriceOffered) {
    parts.push(`Last price quoted: £${state.lastPriceOffered}. Don't contradict unless offering a discount.`);
  }

  return parts.join('\n');
}

// --- Main Assembly ---

export function assemblePrompt(
  message: string,
  classification: MessageClassification,
  monologue: InnerMonologue,
  facts: FactPack,
): { userMessage: string; context: AiContext } {
  const account = facts.rental?.account || 'dbcinema';
  const businessName = account === 'leo' ? 'Leo Adams' : 'DB Cinema Rentals';

  // SECTION 1: Identity — now handled by DB 'identity' + 'communication_style' prompt components
  // buildIdentitySection() removed from here to avoid duplication (~150 tokens saved)

  // SECTION 2: Renter adaptation
  const renterSection = buildRenterSection(classification.renterDNA);

  // SECTION 3: Strategic plan from inner monologue
  const planSection = buildPlanSection(monologue);

  // SECTION 4: Verified facts from FactPack
  const factsSection = buildFactsSection(facts, classification);

  // Behavioral constraints — compact, unique items only (voice/location/timeslots/markdown/Hygglo covered by DB prompt components)
  // Contract-aware: inject intent-specific constraints pre-generation (prevents violations > corrects them)
  const intentConstraints: string[] = [];
  if (classification.intent === 'goodbye') {
    intentConstraints.push('Keep response under 100 chars. Do NOT ask questions or suggest items.');
  }
  if (classification.intent === 'acknowledgment') {
    intentConstraints.push('Brief confirmation only. No follow-up questions, no upsells, no lengthy explanations.');
  }
  if (facts.conversationState?.upsellAttempted || facts.suppressUpsell) {
    intentConstraints.push('Do NOT suggest additional items or bundles. Answer only what was asked.');
  }
  if (classification.hasPricingIntent && facts.pricing) {
    intentConstraints.push('Only state prices from the FACTS section above. Do NOT invent or estimate prices.');
  }
  const constraints = [
    'Never prefix response with timestamps.',
    'RETURN CLOSURE: If asked to mark rental returned, explain inspection takes 24-72 hours.',
    'EARLY ARRIVALS: If renter wants to come earlier than scheduled or on short notice — NEVER accept. Say "let me check I can make that work" and escalate.',
    facts.resolvedItems.length > 0 || classification.hasPricingIntent
      ? `INVENTORY: ${getInventoryItemNames().join(', ')}.`
      : '',
    ...intentConstraints,
  ].filter(Boolean).join('\n');

  // KNOWLEDGE FENCE: Numbered facts + explicit boundary
  const knownFacts = buildKnownFacts(facts);
  const numberedFacts = knownFacts.map((f, i) => `[F${i + 1}] ${f}`).join('\n');
  const knowledgeBoundary = `=== KNOWN FACTS (you may ONLY state these) ===
${numberedFacts}

=== KNOWLEDGE BOUNDARY ===
You have NO other information beyond KNOWN FACTS above.
- If asked about specs, dimensions, weight, features, or capabilities not listed: say "Let me check on that and get back to you."
- NEVER guess or use your general knowledge about cameras/equipment. Only state facts from the list above.
- You are a CHAT AGENT. You CANNOT: be physically present, receive payments, grab equipment, arrive at locations, or perform any physical action. ${account === 'leo' ? 'Leo' : 'Daniel'} handles all physical handoffs — you only arrange them via chat.
- NEVER fabricate what the renter said. Only reference things actually in the conversation history.
- NEVER invent policies, discounts, or promotions not listed above.`
+ (marketingListingItems.length > 0
  ? `\n\n=== MARKETING-ONLY ITEMS (NOT AVAILABLE) ===\nThe following items are marketing-only listings. They are NOT available for rental and NOT in our inventory: ${marketingListingItems.join(', ')}.\nIf a renter asks about any of these items, say: "That item is currently out of stock — I can suggest similar alternatives from what we have available." NEVER say these items are available or offer to book them.`
  : '');

  // SECTION: Sales directive (promoted stage guidance + momentum + salesAction)
  const salesDirective = buildSalesDirectiveSection(monologue, facts, classification);

  // SECTION: Negotiation strategy (price objection handling)
  const negotiationStrategy = buildNegotiationStrategy(facts);

  // Build additionalContext as a single string
  const contextParts = [
    `--- RENTER ---\n${renterSection}`,
    `--- YOUR PLAN ---\n${planSection}`,
  ];
  if (salesDirective) {
    contextParts.push(`--- SALES DIRECTIVE ---\n${salesDirective}`);
  }
  if (negotiationStrategy) {
    contextParts.push(negotiationStrategy);
  }
  contextParts.push(
    `--- FACTS ---\n${factsSection}`,
    `--- KNOWLEDGE FENCE ---\n${knowledgeBoundary}`,
    `--- CONSTRAINTS ---\n${constraints}`,
  );
  const additionalContext = contextParts.join('\n\n');

  // Build the user message (with persona prefix for Leo)
  const userMsg = account === 'leo'
    ? `[Respond as Leo Adams — use "I" and "my", never "we" or "our"]\n${message}`
    : message;

  // Token budget based on complexity
  let maxTokens = 256;
  if (classification.complexity === 'high') maxTokens = 448;
  else if (classification.hasPricingIntent || classification.hasDeliveryIntent) maxTokens = 320;
  else if (classification.contextLevel === 'comprehensive') maxTokens = 384;
  else if (classification.contextLevel === 'minimal') maxTokens = 200;

  return {
    userMessage: userMsg,
    context: {
      rules: facts.rules,
      memories: '', // Facts are now inlined via additionalContext
      conversationHistory: facts.conversationHistory,
      rentalContext: `ACTIVE ACCOUNT: ${businessName}`,
      additionalContext,
      maxTokens,
    },
  };
}
