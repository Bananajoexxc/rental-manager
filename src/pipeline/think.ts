/**
 * Layer 2: THINK — Inner Monologue (Strategic Reasoning)
 *
 * Before generating any customer-facing text, the AI produces a private strategic plan.
 * One Haiku call (~200 input + ~100 output tokens). Cost: ~$0.00008/message.
 */

import { AiService } from '../ai/ai.service';
import { InnerMonologue, MessageClassification, RenterDNA } from './types';

/** Per-stage sales directives — what the agent should actively DO at each funnel stage */
const STAGE_SALES_DIRECTIVES: Record<string, { goal: string; action: string }> = {
  inquiry: {
    goal: 'Qualify the renter — find out what they need, suggest the right items',
    action: 'Ask about their shoot/project to recommend the best gear',
  },
  interested: {
    goal: 'Lock in dates and price — use assumptive language ("I\'ll hold that for you")',
    action: 'Confirm dates/items and quote a price to move toward booking',
  },
  ready_to_book: {
    goal: 'CLOSE THE DEAL — direct ask for booking, remove friction',
    action: 'Ask them to send the booking request on the platform NOW',
  },
  booked: {
    goal: 'Smooth verification — reassure, keep momentum',
    action: 'Confirm booking details and set expectations for next steps',
  },
  confirmed: {
    goal: 'Excellent service — confirm logistics, ensure great experience',
    action: 'Finalize pickup/return details and answer any last questions',
  },
  completed: {
    goal: 'Thank and retain — encourage future bookings',
    action: 'Thank them warmly and mention you\'re here for future rentals',
  },
};

const DEFAULT_MONOLOGUE: InnerMonologue = {
  want: 'general inquiry',
  know: 'basic rental info',
  missing: '',
  goal: 'help the renter',
  plan: ['Address their message directly'],
  avoid: ['being unhelpful'],
  tone: 'friendly and professional',
  salesAction: '',
};

export async function generateInnerMonologue(
  aiService: AiService,
  renterMessage: string,
  classification: MessageClassification,
  resolvedItems: string[],
  conversationState: Record<string, any>,
  rentalStage: string,
): Promise<InnerMonologue> {
  const dna = classification.renterDNA;

  const stageDirective = STAGE_SALES_DIRECTIVES[rentalStage] || STAGE_SALES_DIRECTIVES.inquiry;
  const momentumNote = classification.momentum === 'accelerating'
    ? 'Momentum is HIGH — lean into closing language.'
    : classification.momentum === 'decelerating'
    ? 'Momentum is DROPPING — address concerns, rebuild confidence.'
    : '';

  // Slim state — only the fields THINK needs (saves ~300-600 tokens per call)
  const slimState: Record<string, any> = {};
  if (conversationState.confirmedItems?.length) slimState.confirmed = conversationState.confirmedItems;
  if (conversationState.agreedPickupTime) slimState.pickup = conversationState.agreedPickupTime;
  if (conversationState.agreedReturnTime) slimState.return = conversationState.agreedReturnTime;
  if (conversationState.priceQuoted) slimState.quoted = `£${conversationState.priceQuoted}`;
  if (conversationState.upsellAttempted) slimState.upsellDone = true;
  if (conversationState.deliveryDiscussed) slimState.deliveryDone = true;
  if (conversationState.renterShootType) slimState.shoot = conversationState.renterShootType;
  if (conversationState.questionsAsked?.length) slimState.asked = conversationState.questionsAsked.slice(-3);
  if (conversationState.unavailabilityMentioned) slimState.unavailMentioned = true;

  // Correction feedback — inject if previous response was corrected
  const lastCorrections = conversationState.lastCorrections;
  const correctionNote = lastCorrections && Array.isArray(lastCorrections) && lastCorrections.length > 0
    ? `\nWARNING: Your previous response was corrected for: ${lastCorrections.join(', ')}. Avoid these patterns.`
    : '';

  const prompt = `You are the internal reasoning engine for a camera rental business chat agent.

SITUATION:
- Renter: ${dna.style} style, ${dna.expertise} expertise, ${dna.driver}-driven, ${dna.energy}
- Stage: ${rentalStage} | Items: ${resolvedItems.join(', ') || 'unknown'}
- Their message: "${renterMessage}"
- Intent: ${classification.intent}
- State: ${Object.keys(slimState).length > 0 ? JSON.stringify(slimState) : 'fresh conversation'}${correctionNote}

SALES DIRECTIVE for stage "${rentalStage}":
- Goal: ${stageDirective.goal}
- Action: ${stageDirective.action}
${momentumNote ? `- ${momentumNote}` : ''}

THINK STEP BY STEP:
1. WANT: What does the renter actually want right now? (not what they literally said — what they NEED)
2. KNOW: What facts do I have that answer this? What facts am I MISSING?
3. GOAL: What's my strategic goal for THIS response? (move to next stage, close deal, resolve concern, build rapport)
4. PLAN: Outline my response in 2-3 bullet points. What to say FIRST, what to say SECOND.
5. AVOID: What must I NOT do? (repeat questions, wrong item, upsell when inappropriate, be too pushy)
6. TONE: One-line description of the right tone for this specific renter and moment.
7. SALES_ACTION: The ONE specific action to advance this deal right now (e.g. "quote price", "ask for booking", "confirm dates").

Reply in this exact JSON format only — no markdown fences, no extra text:
{"want":"...","know":"...","missing":"...","goal":"...","plan":["...","..."],"avoid":["..."],"tone":"...","salesAction":"..."}`;

  try {
    const result = await aiService.processExtraction(prompt, { maxTokens: 200 });
    const jsonStr = result.content
      .replace(/```json?\s*/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(jsonStr);

    return {
      want: parsed.want || DEFAULT_MONOLOGUE.want,
      know: parsed.know || DEFAULT_MONOLOGUE.know,
      missing: parsed.missing || '',
      goal: parsed.goal || DEFAULT_MONOLOGUE.goal,
      plan: Array.isArray(parsed.plan) ? parsed.plan : DEFAULT_MONOLOGUE.plan,
      avoid: Array.isArray(parsed.avoid) ? parsed.avoid : DEFAULT_MONOLOGUE.avoid,
      tone: parsed.tone || DEFAULT_MONOLOGUE.tone,
      salesAction: parsed.salesAction || stageDirective.action,
    };
  } catch (err) {
    // Inner monologue is enhancement, not critical — fall back to defaults
    return {
      ...DEFAULT_MONOLOGUE,
      want: `Respond to: "${renterMessage.substring(0, 50)}"`,
      tone: dna.style === 'casual' ? 'casual and friendly' : 'professional and helpful',
      salesAction: stageDirective.action,
    };
  }
}

/**
 * For minimal context messages (acks, greetings), skip the AI call entirely.
 */
export function generateQuickMonologue(
  renterMessage: string,
  classification: MessageClassification,
): InnerMonologue {
  const dna = classification.renterDNA;

  switch (classification.intent) {
    case 'acknowledgment':
      return {
        want: 'Just acknowledging',
        know: 'They confirmed/acknowledged',
        missing: '',
        goal: 'Brief, warm confirmation',
        plan: ['Short acknowledgment', 'Keep conversation open if needed'],
        avoid: ['Over-explaining', 'Upselling', 'Repeating info'],
        tone: dna.style === 'casual' ? 'quick and chill' : 'brief and professional',
        salesAction: 'Acknowledge and keep momentum',
      };
    case 'greeting':
      return {
        want: 'Starting a conversation about renting gear',
        know: 'New conversation starting',
        missing: 'What they want to rent, dates, shoot type',
        goal: 'Warm welcome, find out what they need',
        plan: ['Welcome warmly', 'Ask what they are looking for or what the shoot is for'],
        avoid: ['Being too salesy on first message', 'Dumping info they did not ask for'],
        tone: dna.style === 'casual' ? 'warm and chill' : 'friendly and professional',
        salesAction: 'Ask about their shoot/project to recommend the best gear',
      };
    case 'goodbye':
      return {
        want: 'Wrapping up',
        know: 'They are done for now',
        missing: '',
        goal: 'Friendly sign-off',
        plan: ['Brief friendly goodbye'],
        avoid: ['Upselling', 'Asking more questions', 'Being clingy'],
        tone: 'warm and brief',
        salesAction: 'Warm sign-off, leave door open for future rentals',
      };
    case 'return_confirmation':
      return {
        want: 'Confirming they returned the gear',
        know: 'They say the gear is back',
        missing: '',
        goal: 'Acknowledge return, set expectations for inspection',
        plan: ['Thank them for returning', 'Explain inspection takes 24-72 hours'],
        avoid: ['Making promises about deposit/review timing', 'Being cold'],
        tone: dna.style === 'casual' ? 'warm and appreciative' : 'professional and grateful',
        salesAction: 'Thank and mention future rentals',
      };
    case 'damage_report':
      return {
        want: 'Reporting damage to equipment',
        know: 'Something is damaged',
        missing: 'Photos, extent of damage, which item',
        goal: 'Express concern, gather details, reassure',
        plan: ['Thank them for telling us', 'Ask for photos if not provided', 'Escalate to Daniel'],
        avoid: ['Blaming the renter', 'Making insurance promises', 'Minimizing damage'],
        tone: 'calm, empathetic, and professional',
        salesAction: 'Gather damage info and escalate',
      };
    case 'logistics':
      return {
        want: 'Logistics coordination',
        know: 'They want pickup/return info',
        missing: '',
        goal: 'Provide clear logistics info',
        plan: ['Address their logistics question directly', 'Confirm time/location details'],
        avoid: ['Upselling', 'Adding unnecessary info', 'Repeating known details'],
        tone: dna.style === 'casual' ? 'quick and helpful' : 'clear and professional',
        salesAction: 'Confirm logistics details',
      };
    default:
      return {
        ...DEFAULT_MONOLOGUE,
        tone: dna.style === 'casual' ? 'casual and friendly' : 'professional and helpful',
      };
  }
}
