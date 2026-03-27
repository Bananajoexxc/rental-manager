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
import { getInventoryItemNames, MASTER_INVENTORY } from "../utils/item-matcher";
import { getCompactListingReference } from "../data/hygglo-listings";
import { CAMERA_KIT_TOTALS } from "../data/replacement-costs";
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
  // Core facts (rental, items, prices, delivery, schedule, compatibility) are in the
  // KNOWLEDGE FENCE section. Only supplementary context assembled here to avoid duplication.
  const parts: string[] = [];

  // Pricing instructions (supplements KF price facts)
  if (facts.pricing) {
    if (facts.pricing.bundlePrices) {
      parts.push('NOTE: Bundle/kit prices are for the COMPLETE kit together. Individual prices are for one item only. Match the price to what the renter is actually booking.');
    }
    parts.push(facts.pricing.multiDayNote);
  }

  // Inventory context
  if (facts.inventoryContext) parts.push(facts.inventoryContext);

  // Conversation state (what\'s already been discussed)
  const state = facts.conversationState;
  const stateLines: string[] = [];
  if (state.confirmedItems?.length) stateLines.push(`Confirmed: ${state.confirmedItems.join(', ')}`);
  if (state.agreedPickupTime) stateLines.push(`Pickup: ${state.agreedPickupTime}`);
  if (state.agreedReturnTime) stateLines.push(`Return: ${state.agreedReturnTime}`);
  if (state.renterShootType) stateLines.push(`Shoot: ${state.renterShootType}`);
  if (state.questionsAsked?.length) stateLines.push(`Already asked: ${state.questionsAsked.join(', ')}`);
  if (state.upsellAttempted) stateLines.push('Upselling already attempted \u2014 do NOT upsell again');
  if (state.priceQuoted) stateLines.push(`Last quoted: \u00a3${state.priceQuoted}`);
  if (state.deliveryDiscussed) stateLines.push('Delivery already discussed');
  if (state.unavailabilityMentioned) stateLines.push('IMPORTANT: You already told this renter about item unavailability \u2014 do NOT repeat the warning.');
  if (stateLines.length > 0) {
    parts.push(`CONVERSATION STATE:\n${stateLines.join('\n')}\nDo NOT re-ask questions above. Do NOT repeat established facts.`);
  }

  if (facts.urgency) parts.push(facts.urgency);
  if (facts.welcomeBack) parts.push('RETURNING RENTER: Welcome warmly. Skip re-introductions.');
  if (facts.multiRental) parts.push(facts.multiRental);
  if (facts.discountContext) parts.push(facts.discountContext);
  if (facts.lowValueInstruction) parts.push(facts.lowValueInstruction);
  if (facts.renterProfile) parts.push(facts.renterProfile);
  if (facts.accountTemplates) parts.push(facts.accountTemplates);

  if (!facts.suppressUpsell) {
    if (facts.bundleContext) parts.push(facts.bundleContext);
    if (facts.upsellContext) parts.push(facts.upsellContext);
  } else {
    parts.push('Do NOT suggest additional items. Answer what the renter asked \u2014 keep it focused.');
  }

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


/**
 * Build HARD TRUTHS — situation-specific facts injected at the END of the prompt.
 * These are the most important facts for THIS specific response.
 * Placed last because LLMs pay most attention to the end of the prompt (recency bias).
 */
function buildHardTruths(
  facts: FactPack,
  classification: MessageClassification,
  message: string,
): string {
  const truths: string[] = [];

  // PRICING: inject exact prices so the AI can't hallucinate them
  if (facts.pricing?.itemPrices?.length) {
    const priceLines = facts.pricing.itemPrices
      .map((p: any) => `${p.itemName}: £${p.dailyMin}-${p.dailyMax}/day`)
      .join(', ');
    truths.push(`PRICES (use ONLY these numbers): ${priceLines}`);
    truths.push('CAMERA BASE KITS (INCLUDED FREE — never charge separately):\n' +
      '• Sony FX3: 3x NP-FZ100 batteries + 320GB CFexpress Type A card + card reader + charger\n' +
      '• Sony A7 V: 3x NP-FZ100 batteries + 256GB V90 SD card + charger\n' +
      '• Sony A7 III: 2x NP-FZ100 batteries + 128GB V30 SD card + charger\n' +
      '• Sony A7 II: 2x NP-FW50 batteries + 128GB SD card + charger\n' +
      '• Fujifilm X100 VI: 2x NP-W126S batteries + 256GB SD card + charger\n' +
      '• BMPCC 6K Pro: 5x NP-F970 batteries + 2TB SSD + SSD reader + charger\n' +
      '• BMPCC 6K Full Frame: 2x NP-F970 batteries + 1TB CFexpress Type B card + card reader + charger\n' +
      '• DJI Osmo Action 5: 3x batteries + 256GB microSD + charger\n' +
      '• GoPro Hero 12: 2x batteries + 128GB microSD + charger\n' +
      'CFexpress and SSD rentals include a card/SSD reader. SD cards do NOT include a reader.\n' +
      'No strap included with FX3 (cinema camera, not photo camera).\n' +
      'EXTRA batteries or cards beyond the base kit can be added for a fee if renter asks.');
    truths.push('BOOM MIC SET (2 available): Each includes Sennheiser MKE 600 + boom pole + shock mount + Zoom H5 recorder + XLR cable + dead cat windshield + SD card. Full kit value £777. All included in the rental price — never charge for individual components.');
    truths.push("BATTERY TYPES: NP-FZ100 = Sony mirrorless camera batteries (FX3, A7 III, A7 V, A7 II). NP-F970/NPF-970 = DIFFERENT battery type for monitors (Atomos Ninja), LED panels, and external devices. These are NOT interchangeable. Never suggest NP-F970 as a camera battery or associate them with camera kits.");
    // Inject available listings so bot knows what camera+lens combos exist
    const listingRef = getCompactListingReference();
    if (listingRef) {
      truths.push('OUR HYGGLO LISTINGS (camera+lens sets exist — suggest these instead of piecing items together):\n' + listingRef);
    }
    truths.push('When a renter wants camera + lens: find the matching SET listing above and quote that. Sets are cheaper than renting each item individually. Never piece together items when a combined listing exists.');
  }

  // RENTAL STAGE: make it crystal clear what stage we're in
  const stage = facts.conversationState?.currentStage;
  if (stage === 'booked') {
    truths.push('BOOKING STATUS: NOT YET CONFIRMED. Verification is still pending on the platform. Do NOT tell the renter it\'s confirmed, accepted, gone through, or sorted. Say "once the platform verification is complete, I\'ll send pickup details."');
  } else if (stage === 'confirmed') {
    truths.push('BOOKING STATUS: CONFIRMED AND PAID. Focus on pickup/return logistics.');
  } else if (stage === 'inquiry' || stage === 'interested') {
    truths.push('BOOKING STATUS: No booking yet. Renter is still enquiring.');
  }

  // ARRIVAL: if renter says they're here, don't give directions
  const arrivalWords = /\b(?:i'm here|i am here|we're here|just arrived|i've arrived|here now|i'm outside|we're outside|i'm at the|arrived|i'm waiting)\b/i;
  if (arrivalWords.test(message)) {
    truths.push('RENTER HAS ARRIVED. Do NOT give directions or tell them where to go. Say ONLY "One moment!" and nothing more. Daniel/Leo will handle the physical meetup.');
  }

  // MODEL NAME: pin the exact model from the listing
  if (facts.verifiedListingItem) {
    truths.push(`LISTING ITEM: "${facts.verifiedListingItem}" — use this EXACT name. Do not substitute similar model names.`);
  }

  // BOT LIMITATIONS: you're a chat agent, not an admin
  // INVENTORY TRUTH: Only suggest items that actually exist
  const inventoryItems = getInventoryItemNames();
  if (inventoryItems && inventoryItems.length > 0) {
    // Dynamic camera list from CAMERA_KIT_TOTALS + MASTER_INVENTORY
    const cameraLines = Object.entries(CAMERA_KIT_TOTALS).map(([name, kitValue]) => {
      const qty = MASTER_INVENTORY[name] || 1;
      return `• ${name} (${qty} unit${qty > 1 ? 's' : ''}, kit value £${kitValue.toLocaleString()})`;
    }).join('\n');
    truths.push('CAMERAS WE OWN (suggest ONLY these — NEVER invent models not listed here):\n' +
      cameraLines + '\n' +
      'We do NOT own: A7IV, A7SII, A7RIII, A6600, FX30, Canon R5, Canon R6, or any other camera.\n' +
      'If none of the above fit, say our cameras are all booked — do NOT fabricate.');

    // SEO TEXT WARNING: listing titles contain marketing names of competitor cameras
    // e.g. "(same sensor as a7siii)" or "(like Canon R5C)" — these are NOT items we own
    truths.push('LISTING TITLES CONTAIN SEO TEXT like "same sensor as a7siii" or "like Canon R5C". ' +
      'These are marketing comparisons ONLY — we do NOT stock those items. ' +
      'NEVER suggest an item just because it appears in a listing title after "like" or "same as". ' +
      'Only suggest cameras from the CAMERAS WE OWN list above.');
  }

  // RENTAL DATES: use the exact dates from the booking, don't shift them
  if (facts.rental) {
    const startDate = facts.rental.startDate || undefined;
    const endDate = facts.rental.endDate || undefined;
    if (startDate) {
      const pickupArea = facts.rental.account === 'leo' ? 'near Charing Cross Road' : 'at Trafalgar Square';
      truths.push('RENTAL DATES: Starts ' + startDate + (endDate ? ', ends ' + endDate : '') + '. ' +
        'Pickup is on the START date (not the day before). ' +
        'Do NOT suggest pickup on ' + (startDate ? 'the day before unless the renter specifically asks about evening-before pickup' : 'a different date') + '. ' +
        'Quote times for the actual start date: 10am-12pm or 7-9pm ' + pickupArea + '.');
    }
  }

  truths.push('You are a CHAT AGENT. You CANNOT accept bookings, verify documents, check backend systems, or perform any platform actions. Never claim "I\'ll get it accepted" or "I\'ve just checked."');

  if (truths.length === 0) return '';

  return '\n--- HARD TRUTHS (read these LAST, they override everything above) ---\n' +
    truths.map((t, i) => `${i + 1}. ${t}`).join('\n');
}

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
    '',  // Full inventory list removed to save ~1K tokens — resolved items + pricing facts are sufficient
    ...intentConstraints,
  ].filter(Boolean).join('\n');

  // KNOWLEDGE FENCE: Numbered facts + explicit boundary
  const knownFacts = buildKnownFacts(facts);
  const numberedFacts = knownFacts.map((f, i) => `[F${i + 1}] ${f}`).join('\n');
  const knowledgeBoundary = `=== KNOWN FACTS (you may ONLY state these) ===
${numberedFacts}

=== BOUNDARY ===
Only state facts listed above. For unknown specs: "Let me check on that."
No guessing. No fabricating renter quotes. No inventing policies/discounts.
You are a CHAT AGENT — ${account === 'leo' ? 'Leo' : 'Daniel'} handles physical handoffs.`
+ (marketingListingItems.length > 0
  ? `\n\n=== MARKETING-ONLY ITEMS (NOT AVAILABLE) ===\nNOT AVAILABLE (marketing only): ${marketingListingItems.join(', ')}.\nIf asked about these: "Currently out of stock, I can suggest alternatives."`
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
  // HARD TRUTHS: situation-specific facts at the END (recency bias = most attention here)
  const hardTruths = buildHardTruths(facts, classification, message);
  if (hardTruths) {
    contextParts.push(hardTruths);
  }

  const additionalContext = contextParts.join('\n\n');

  // Build the user message (with persona prefix for Leo)
  const userMsg = account === 'leo'
    ? `[Respond as Leo Adams — use "I" and "my", never "we" or "our"]\n${message}`
    : message;

  // Token budget based on complexity
  let maxTokens = 512;
  if (classification.complexity === 'high') maxTokens = 1024;
  else if (classification.hasPricingIntent || classification.hasDeliveryIntent) maxTokens = 768;
  else if (classification.contextLevel === 'comprehensive') maxTokens = 768;
  else if (classification.contextLevel === 'minimal') maxTokens = 384;

  return {
    userMessage: userMsg,
    context: {
      rules: facts.rules,
      memories: '', // Facts are now inlined via additionalContext
      conversationHistory: facts.conversationHistory,
      intent: classification.intent,
      intentFlags: {
        hasPricingIntent: classification.hasPricingIntent,
        hasDeliveryIntent: classification.hasDeliveryIntent,
        hasMultipleItems: facts.resolvedItems.length > 1,
      },
      rentalContext: `ACTIVE ACCOUNT: ${businessName}`,
      additionalContext,
      maxTokens,
    },
  };
}
