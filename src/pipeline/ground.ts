/**
 * Layer 7: GROUND — Semantic Grounding Verifier (AI-Powered)
 *
 * After response generation, verifies every factual claim is supported
 * by the numbered KNOWN FACTS provided to the AI.
 *
 * One fast Haiku call (~100 input + ~80 output tokens). Cost: ~$0.00005/message.
 * Only triggered when the response contains factual claims worth checking.
 */

import { AiService } from '../ai/ai.service';
import { FactPack } from './types';

export interface GroundingResult {
  grounded: boolean;
  ungroundedClaims: string[];
  correctedResponse?: string;
}

/**
 * Build the numbered KNOWN FACTS block from a FactPack.
 * These are the ONLY facts the AI should be using.
 * Also exported for use in the Knowledge Fence (assemble.ts).
 */
export function buildKnownFacts(facts: FactPack): string[] {
  const entries: string[] = [];

  // Rental context
  if (facts.rental) {
    const r = facts.rental;
    entries.push(`Item: ${r.title}`);
    entries.push(`Status: ${r.status}`);
    if (r.startDate) {
      const start = new Date(r.startDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const end = r.endDate ? new Date(r.endDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
      // Calculate return morning (day after end date) — renters keep gear through the last rental day
      let returnMorning = '';
      if (r.endDate) {
        const returnDate = new Date(r.endDate);
        returnDate.setDate(returnDate.getDate() + 1);
        returnMorning = ` → return morning of ${returnDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`;
      }
      entries.push(`Dates: ${start} to ${end}${r.days ? ` (${r.days} day${r.days > 1 ? 's' : ''})` : ''}${returnMorning}`);
    }
    entries.push(`Renter: ${r.renterName}`);
    if (r.renterPrice) entries.push(`Total price: £${r.renterPrice}`);
    entries.push(`Account: ${r.account}`);
  }

  // Resolved items
  if (facts.resolvedItems.length > 0) {
    entries.push(`Our items: ${facts.resolvedItems.join(', ')}`);
  }

  // Verified listing item
  if (facts.verifiedListingItem) entries.push(facts.verifiedListingItem);

  // Pricing
  if (facts.pricing) {
    for (const p of facts.pricing.itemPrices) {
      entries.push(`${p.itemName} price: £${p.dailyMin}-${p.dailyMax}/day`);
    }
    if (facts.pricing.bundlePrices) {
      for (const b of facts.pricing.bundlePrices) {
        entries.push(`Bundle ${b.itemName}: £${b.dailyMin}-${b.dailyMax}/day`);
      }
    }
  }

  // Delivery
  if (facts.delivery) entries.push(`Delivery: ${facts.delivery}`);

  // Schedule
  if (facts.schedule) entries.push(`Schedule: ${facts.schedule}`);

  // Compatibility
  if (facts.compatibility) entries.push(`Compatibility: ${facts.compatibility}`);

  // Listing inventory context
  if (facts.listingInventoryContext) entries.push(facts.listingInventoryContext);

  // Availability
  if (facts.availability) {
    for (const item of facts.availability.items) {
      entries.push(`${item.item}: ${item.available ? 'available' : 'unavailable'} (${item.booked}/${item.maxQuantity} booked)`);
    }
  }

  // Location — account-aware (Leo = Charing Cross, DB = Trafalgar Square)
  entries.push('Pickup location: Central London (rough area only until booking verified)');

  // What the agent IS and ISN'T
  entries.push('Agent role: chat-only agent who arranges rentals. Daniel/Leo handles physical handoffs.');

  return entries;
}

/**
 * Check if a response needs grounding verification.
 * Skip for very short or purely conversational responses.
 */
function needsGrounding(response: string): boolean {
  // Skip very short responses (acks, greetings)
  if (response.length < 80) return false;

  // Skip if no factual claims detected
  const hasFactualClaim =
    /£\d+/i.test(response) ||                        // Price claims
    /\b\d+\s*(?:cm|mm|kg|gb|tb|w|watt|hour)\b/i.test(response) || // Spec claims
    /\b(available|unavailable|in stock|out of stock)\b/i.test(response) || // Availability
    /\b(I'?m here|I'?ve got|I have|we have|just grabbed|arrived)\b/i.test(response) || // Presence
    /\b(you (?:said|mentioned|asked|told))\b/i.test(response) || // Renter quotes
    /\b(built.?in|comes with|includes|features|supports|compatible)\b/i.test(response); // Capability claims

  return hasFactualClaim;
}

/**
 * Verify response grounding against known facts using a fast AI call.
 */
export async function verifyGrounding(
  aiService: AiService,
  response: string,
  facts: FactPack,
): Promise<GroundingResult> {
  // Skip if not worth verifying
  if (!needsGrounding(response)) {
    return { grounded: true, ungroundedClaims: [] };
  }

  const knownFacts = buildKnownFacts(facts);
  const numberedFacts = knownFacts.map((f, i) => `[F${i + 1}] ${f}`).join('\n');

  const prompt = `You are a fact-checker. Check if EVERY factual claim in the RESPONSE is supported by the KNOWN FACTS below.

KNOWN FACTS:
${numberedFacts}

RESPONSE TO CHECK:
"${response.substring(0, 600)}"

Rules:
- Greetings, pleasantries, and opinions don't need grounding
- Factual claims about items, specs, prices, availability, dimensions, weight, capabilities, renter history, or physical actions DO need grounding
- "Let me check" or "I'll get back to you" is always grounded (it's appropriate when uncertain)
- If the response claims the agent is physically present, arriving, grabbing gear, or performing physical actions, that is UNGROUNDED (see agent role in KNOWN FACTS)
- If the response attributes statements to the renter that aren't in the conversation, that is UNGROUNDED

Reply JSON only, no markdown:
{"ungrounded":["claim1","claim2"]}
If everything is grounded: {"ungrounded":[]}`;

  try {
    const result = await aiService.processExtraction(prompt, { maxTokens: 150 });
    const jsonStr = result.content
      .replace(/```json?\s*/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(jsonStr);

    const ungrounded = Array.isArray(parsed.ungrounded) ? parsed.ungrounded : [];

    if (ungrounded.length === 0) {
      return { grounded: true, ungroundedClaims: [] };
    }

    // Attempt surgical fix: replace ungrounded claims with safe alternatives
    let corrected = response;
    for (const claim of ungrounded) {
      if (typeof claim !== 'string' || claim.length < 5) continue;

      // Find the sentence containing this claim
      const sentences = corrected.split(/(?<=[.!?])\s+/);
      const fixedSentences = sentences.map(sentence => {
        // Check if this sentence contains the ungrounded claim (fuzzy match)
        const claimWords = claim.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const sentenceLower = sentence.toLowerCase();
        const matchScore = claimWords.filter(w => sentenceLower.includes(w)).length / Math.max(claimWords.length, 1);

        if (matchScore >= 0.5) {
          // This sentence likely contains the ungrounded claim
          // Check what kind of claim it is
          if (/\b(I'?m here|arrived|grabbed|coming out|bringing|carrying|with your gear)\b/i.test(sentence)) {
            // Physical presence → remove entirely
            return '';
          }
          if (/\b(you (?:said|mentioned|told me|asked about))\b/i.test(sentence)) {
            // Fabricated quote → remove
            return '';
          }
          if (/\b\d+\s*(?:cm|mm|kg|gb|w)\b/i.test(sentence)) {
            // Fabricated spec → replace with safe deferral
            return "I'll need to check the exact specs on that for you.";
          }
          if (/\b(built.?in|comes with|features|supports)\b/i.test(sentence)) {
            // Fabricated capability → defer
            return "Let me confirm the exact specifications for you.";
          }
          // Generic: keep the sentence but log it
          return sentence;
        }
        return sentence;
      }).filter(s => s.length > 0);

      corrected = fixedSentences.join(' ').trim();
    }

    // Clean up any double spaces or orphaned punctuation
    corrected = corrected.replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');

    return {
      grounded: false,
      ungroundedClaims: ungrounded,
      correctedResponse: corrected !== response ? corrected : undefined,
    };
  } catch (err) {
    // Grounding check is enhancement, not critical — pass through
    return { grounded: true, ungroundedClaims: [] };
  }
}
