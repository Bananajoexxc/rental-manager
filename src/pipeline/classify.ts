/**
 * Layer 1: CLASSIFY + Renter DNA Profiling
 *
 * Deterministic classification (no AI, <1ms).
 * - Intent classification from message patterns
 * - Renter DNA profiling from message style/vocabulary
 * - Context level determination
 */

import { findBestMatch, getInventoryItemNames } from '../utils/item-matcher';
import {
  Intent,
  RenterDNA,
  DEFAULT_RENTER_DNA,
  MessageClassification,
} from './types';

// --- Intent Classification ---

const INTENT_PATTERNS: { intent: Intent; patterns: RegExp[]; weight: number }[] = [
  {
    intent: Intent.PRICING_INQUIRY,
    patterns: [
      /\b(price|pricing|cost|how much|rate|rates|quote|charge|fee|fees|per day|daily|weekly|budget|afford|expensive|cheap|discount|deal|what'?s the damage)\b/i,
    ],
    weight: 1,
  },
  {
    intent: Intent.AVAILABILITY_CHECK,
    patterns: [
      /\b(available|availability|free|book|reserve|open|dates?)\b/i,
    ],
    weight: 1,
  },
  {
    intent: Intent.LOGISTICS,
    patterns: [
      /\b(pickup|pick up|collect|return|drop.?off|deliver|delivery|courier|time|slot|morning|evening|address|location|postcode|on my way|omw|i'?m here|arrived|outside|waiting|heading|be there|minutes away)\b/i,
    ],
    weight: 1,
  },
  {
    intent: Intent.EQUIPMENT_QUESTION,
    patterns: [
      /\b(specs?|compatible|compatibility|work with|battery|batteries|mount|lens|sensor|resolution|codec|sdi|xlr|runtime|weight|what do you (have|stock|carry))\b/i,
    ],
    weight: 1,
  },
  {
    intent: Intent.BOOKING_ACTION,
    patterns: [
      /\b(book|confirm|reserve|go ahead|let'?s do it|i'?ve booked|just booked|send a request)\b/i,
    ],
    weight: 1,
  },
  {
    intent: Intent.NEGOTIATION,
    patterns: [
      /\b(too expensive|lower price|better deal|best price|negotiate|can you do .* for|feels? steep|saw.*cheaper|over.?priced|rip.?off)\b/i,
    ],
    weight: 2,
  },
  {
    intent: Intent.COMPLAINT,
    patterns: [
      /\b(complain|disappointed|frustrated|unacceptable|terrible|awful|refund|compensat|escalat|annoying|ridiculous)\b/i,
    ],
    weight: 2,
  },
  {
    intent: Intent.CANCELLATION,
    patterns: [
      /\b(cancel|cancellation|don'?t need it|won'?t need|no longer need|plans changed|something came up|not going ahead|pull out|back out)\b/i,
    ],
    weight: 2,
  },
  {
    intent: Intent.DAMAGE_REPORT,
    patterns: [
      /\b(scratched|broke|broken|cracked|dropped|damaged|dent|bent|won'?t turn on|not working|stopped working|fell|smashed|chipped)\b/i,
    ],
    weight: 3,
  },
  {
    intent: Intent.RETURN_CONFIRMATION,
    patterns: [
      /\b(returned|left it|dropped it off|left at|put it back|gave it back|it'?s back|brought it back|left the|returned the)\b/i,
    ],
    weight: 1,
  },
  {
    intent: Intent.GOODBYE,
    patterns: [
      /^(thanks?|cheers|bye|see you|ta|sorted|brilliant|lovely|perfect|great|cool)\b/i,
    ],
    weight: 0,
  },
  {
    intent: Intent.ACKNOWLEDGMENT,
    patterns: [
      /^(ok|okay|sure|yes|yeah|yep|no|nah|confirmed?|done|sent|here|ready|got it|will do|understood|sounds good|noted)\b/i,
    ],
    weight: 0,
  },
  {
    intent: Intent.GREETING,
    patterns: [
      /^(hi|hey|hello|good (morning|afternoon|evening)|howdy)\b/i,
    ],
    weight: 0,
  },
];

function classifyIntent(message: string, historyLength: number): Intent {
  const trimmed = message.trim();
  const wordCount = trimmed.split(/\s+/).length;

  // Short messages: check ack/goodbye first
  if (wordCount <= 5) {
    if (INTENT_PATTERNS.find(p => p.intent === Intent.ACKNOWLEDGMENT)!.patterns.some(r => r.test(trimmed))) {
      return Intent.ACKNOWLEDGMENT;
    }
    if (INTENT_PATTERNS.find(p => p.intent === Intent.GOODBYE)!.patterns.some(r => r.test(trimmed)) && trimmed.length < 80) {
      return Intent.GOODBYE;
    }
  }

  // Greeting on first message
  if (historyLength === 0 && INTENT_PATTERNS.find(p => p.intent === Intent.GREETING)!.patterns.some(r => r.test(trimmed))) {
    return Intent.GREETING;
  }

  // Score remaining intents by weight
  let bestIntent = Intent.GENERAL;
  let bestWeight = -1;

  for (const { intent, patterns, weight } of INTENT_PATTERNS) {
    if (intent === Intent.ACKNOWLEDGMENT || intent === Intent.GOODBYE || intent === Intent.GREETING) continue;
    if (patterns.some(r => r.test(message))) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIntent = intent;
      }
    }
  }

  return bestIntent;
}

// --- Complexity Assessment ---

function assessComplexity(message: string, historyLength: number): 'low' | 'medium' | 'high' {
  let signals = 0;

  if (/\b(complain|disappointed|frustrated|unacceptable|terrible|awful|refund|compensat)\b/i.test(message)) signals += 2;
  if (/\b(too expensive|lower price|better deal|best price|negotiate|can you do .* for)\b/i.test(message)) signals += 2;
  // Sarcasm/frustration signals — boost complexity to trigger Sonnet escalation
  if (/\b(oh great|oh wonderful|oh fantastic|oh perfect|oh brilliant|really professional|wow.*service|sure.*take your time|not like I need)\b/i.test(message)) signals += 2;
  if (/🙄|😒|😤/.test(message)) signals += 1;
  // Cancellation/damage — always high complexity
  if (/\b(cancel|scratched|broke|broken|dropped|damaged|won'?t turn on|not working)\b/i.test(message)) signals += 2;

  const hasPricing = /\b(price|cost|how much|quote|rate|£\d)\b/i.test(message);
  const hasDelivery = /\b(deliver|delivery|courier|postcode|address|collect)\b/i.test(message);
  if (hasPricing && hasDelivery) signals += 2;

  const itemMentions = (message.match(/\b(fx3|fx6|a7|bmpcc|pocket|gimbal|lens|camera|drone|light|mic|monitor|slider|tripod|nanlite|atomos|rode|dji|sony|blackmagic|wireless|v.?mount|battery|batteries)\b/gi) || []).length;
  if (itemMentions >= 3) signals += 2;
  else if (itemMentions >= 2) signals += 1;

  const questionMarks = (message.match(/\?/g) || []).length;
  if (questionMarks >= 2) signals += 1;

  if (message.length > 600) signals += 2;
  else if (message.length > 350) signals += 1;

  if (historyLength > 6) signals += 1;

  if (/\b(cancel|reschedul|change date|postpone)\b/i.test(message)) signals += 2;

  if (signals >= 3) return 'high';
  if (signals >= 2) return 'medium';
  return 'low';
}

// --- Renter DNA Profiling ---

export function profileRenter(
  message: string,
  history: { role: string; content: string }[],
  currentDNA: RenterDNA,
): RenterDNA {
  const words = message.split(/\s+/).length;

  // Style: short messages + slang = casual, longer + proper = formal
  const style: RenterDNA['style'] =
    words < 8 && /\b(hey|yeah|yep|cool|cheers|ta|mate|wicked|sick|lol|haha)\b/i.test(message) ? 'casual'
    : words < 4 ? 'terse'
    : words > 30 && !/\b(hey|yeah|cool|mate)\b/i.test(message) ? 'formal'
    : currentDNA.style;

  // Expertise: technical terms = pro, basic questions = beginner
  const techTerms = /\b(f\/?2\.?8|e-?mount|s-?log|raw|codec|v-?mount|xlr|sdi|timecode|lut|iso|dynamic range|anamorphic|braw|prores|c-?log|rec\.?709|davinci|nle)\b/i;
  const expertise: RenterDNA['expertise'] =
    techTerms.test(message) ? 'pro'
    : /\b(good camera|nice one|what do you recommend|beginner|first time|simple|easy to use|just need)\b/i.test(message) ? 'beginner'
    : currentDNA.expertise;

  // Driver: what they keep asking about
  const priceSignals = /\b(price|cost|how much|expensive|cheap|budget|afford|worth|value|deal)\b/i.test(message);
  const qualitySignals = /\b(best|quality|professional|specs|resolution|4k|6k|cinema|premium|top.?end)\b/i.test(message);
  const convenienceSignals = /\b(deliver|pickup|easy|quick|available|ready|when|time|flexible|asap)\b/i.test(message);
  const driver: RenterDNA['driver'] =
    priceSignals ? 'price' : qualitySignals ? 'quality' : convenienceSignals ? 'convenience' : currentDNA.driver;

  // Energy: punctuation + word choice
  const energy: RenterDNA['energy'] =
    /[!]{1,}|can't wait|perfect|amazing|excited|great|brilliant|awesome|love/i.test(message) ? 'enthusiastic'
    : /\b(hmm|maybe|not sure|possibly|might|think about|let me|need to check)\b/i.test(message) ? 'hesitant'
    : 'neutral';

  // Decision speed: fast if they're already committing
  const decisionSpeed: RenterDNA['decisionSpeed'] =
    /\b(book it|go ahead|let'?s do it|confirmed?|done|i'll take|send the request)\b/i.test(message) ? 'fast'
    : currentDNA.decisionSpeed;

  return { style, expertise, driver, energy, decisionSpeed };
}

// --- Upsell Suppression ---

export function shouldSuppressUpsell(
  message: string,
  conversationState?: Record<string, any>,
  rentalStage?: string,
): boolean {
  const isLogisticsMessage = /\b(i'?m here|on my way|waiting|arrived|outside|coming|here now|at the|be there|minutes away|just (got|arrived|walking)|heading over|pickup|drop.?off|return|collecting)\b/i.test(message);
  const isPaymentMessage = /\b(payment|pay|paying|verif|document|id.?check|not accepted|trying|submit)\b/i.test(message);
  const isGoodbyeMessage = /^(thanks?|cheers|ok|okay|no worries|perfect|great|cool|lovely|brilliant|sorted|bye|see you|ta|noted|got it|will do|understood|sounds good|amazing)\b/i.test(message.trim()) && message.trim().length < 80;
  const isSimpleAck = message.trim().split(/\s+/).length <= 5 && /^(yes|yeah|yep|ok|okay|sure|no|nah|confirmed?|done|sent|here|ready)\b/i.test(message.trim());

  // Post-booking stages: no upsell once deal is closed
  const postBookingStages = ['booked', 'confirmed', 'completed'];
  const isPostBooking = rentalStage ? postBookingStages.includes(rentalStage) : false;

  // Renter explicitly declined upsell previously
  const upsellDeclined = conversationState?.upsellDeclined === true;

  return isLogisticsMessage || isPaymentMessage || isGoodbyeMessage || isSimpleAck || isPostBooking || upsellDeclined;
}

// --- Momentum Detection ---

export function detectMomentum(
  message: string,
  conversationHistory: { role: string; content: string }[],
): 'accelerating' | 'steady' | 'decelerating' {
  let score = 0;

  // Positive language (interest signals)
  if (/\b(sounds good|perfect|what about|interested|let'?s|i'?ll|great|love|amazing|exactly|yes|yeah)\b/i.test(message)) score += 1;

  // Decisive language (weighted 2x)
  if (/\b(book|confirm|go ahead|let'?s do it|i'?ll take|reserve|send.*request|deal)\b/i.test(message)) score += 2;

  // Hesitant language
  if (/\b(hmm|maybe|not sure|let me think|possibly|might|need to check|i'?ll think|hold on)\b/i.test(message)) score -= 2;

  // Message length trend: compare last 3 user messages
  const userMsgs = conversationHistory.filter(m => m.role === 'user');
  if (userMsgs.length >= 2) {
    const recent = userMsgs.slice(-2).map(m => m.content.length);
    const currentLen = message.length;
    // Growing messages = more engagement
    if (currentLen > recent[recent.length - 1] * 1.3) score += 1;
    // Shrinking messages = losing interest
    if (currentLen < recent[recent.length - 1] * 0.5) score -= 1;
  }

  if (score >= 2) return 'accelerating';
  if (score <= -1) return 'decelerating';
  return 'steady';
}

// --- Context Level ---

function determineContextLevel(message: string): 'minimal' | 'standard' | 'comprehensive' {
  const trimmed = message.trim();

  if (/^(hi|hey|hello|thanks|thank you|ok|okay|sounds good|perfect|great|yes|no|sure)$/i.test(trimmed)) return 'minimal';
  if (/^(thanks?|thx|cheers|cool)\s*!*$/i.test(trimmed)) return 'minimal';

  if (/\b(price|cost|how much|pricing|quote|estimate)\b/i.test(message)) return 'comprehensive';
  if (/\b(deliver|delivery|courier|postcode|address)\b/i.test(message)) return 'comprehensive';
  if (/\b(bundle|package|together|combo)\b/i.test(message)) return 'comprehensive';
  if (/\b(available|availability|dates|booking)\b/i.test(message)) return 'comprehensive';

  return 'standard';
}

// --- Extract mentioned items ---

function extractMentionedItems(message: string): string[] {
  const inventoryNames = getInventoryItemNames();
  const words = message.split(/[\s,.\-!?;:()]+/).filter(w => w.length > 2);
  const items: string[] = [];

  for (const word of words) {
    const match = findBestMatch(word, inventoryNames);
    if (match && !items.includes(match)) {
      items.push(match);
    }
  }

  return items;
}

// --- Main Classification Function ---

export function classifyMessage(
  message: string,
  conversationHistory: { role: string; content: string }[],
  currentDNA?: RenterDNA,
  conversationState?: Record<string, any>,
  rentalStage?: string,
): MessageClassification {
  const historyLength = conversationHistory.length;
  const dna = currentDNA || DEFAULT_RENTER_DNA;

  const intent = classifyIntent(message, historyLength);
  const complexity = assessComplexity(message, historyLength);
  const suppressUpsell = shouldSuppressUpsell(message, conversationState, rentalStage);
  const renterDNA = profileRenter(message, conversationHistory, dna);
  const mentionedItems = extractMentionedItems(message);
  const contextLevel = determineContextLevel(message);
  const momentum = detectMomentum(message, conversationHistory);

  const hasPricingIntent = /\b(price|pricing|cost|how much|rate|rates|quote|charge|fee|fees|per day|daily|weekly|budget|afford|expensive|cheap|discount|deal)\b/i.test(message);
  const hasDeliveryIntent = /\b(deliver|delivery|courier|ship|shipping|post|postcode|send it|drop off|dropoff|bring it|transport|how far|distance|collect from|too far|can you bring|come to me)\b/i.test(message);
  const hasSchedulingIntent = /\b(pickup|pick up|collect|return|drop off|time|slot|morning|evening|tomorrow|today|weekend|schedule|when can)\b/i.test(message);
  const isLogisticsMessage = /\b(i'?m here|on my way|waiting|arrived|outside|coming|here now|at the|be there|minutes away)\b/i.test(message);
  const isGoodbyeMessage = /^(thanks?|cheers|ok|okay|no worries|perfect|great|cool|lovely|brilliant|sorted|bye|see you|ta)\b/i.test(message.trim()) && message.trim().length < 80;
  const isSimpleAck = message.trim().split(/\s+/).length <= 5 && /^(yes|yeah|yep|ok|okay|sure|no|nah|confirmed?|done|sent|here|ready)\b/i.test(message.trim());

  return {
    intent,
    complexity,
    suppressUpsell,
    renterDNA,
    mentionedItems,
    hasPricingIntent,
    hasDeliveryIntent,
    hasSchedulingIntent,
    isLogisticsMessage,
    isGoodbyeMessage,
    isSimpleAck,
    contextLevel,
    momentum,
  };
}
