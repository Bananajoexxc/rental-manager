/**
 * Layer 5: CHECK — Code-Enforced Fact Verification
 *
 * Not a prompt instruction. Not AI-based. Actual TypeScript validation.
 * Runs AFTER response generation, checks against FactPack.
 */

import { FactPack, VerificationResult, VerificationIssue } from './types';
import { getInventoryItemNames } from '../utils/item-matcher';

export function verifyResponse(response: string, facts: FactPack): VerificationResult {
  const issues: VerificationIssue[] = [];

  // 1. PRICE VERIFICATION
  // Extract all numbers followed by currency markers from response
  const pricePattern = /(?:£|GBP\s?)(\d[\d\s]*)\s*(?:\/day|per day|a day)?/gi;
  const mentionedPrices = [...response.matchAll(pricePattern)].map(m => parseInt(m[1].replace(/\s/g, '')));

  if (facts.pricing && mentionedPrices.length > 0) {
    const knownPrices: number[] = [];
    for (const p of facts.pricing.itemPrices) {
      knownPrices.push(p.dailyMin, p.dailyMax);
      if (p.renterPays) knownPrices.push(p.renterPays);
    }
    if (facts.pricing.bundlePrices) {
      for (const b of facts.pricing.bundlePrices) {
        knownPrices.push(b.dailyMin, b.dailyMax);
        if (b.renterPays) knownPrices.push(b.renterPays);
      }
    }
    // Add rental-level renter price only (not owner earnings)
    if (facts.rental?.renterPrice) knownPrices.push(Math.round(facts.rental.renterPrice));

    // Also add multi-day computed prices (±15 tolerance for rounding)
    const dailyMaxes = facts.pricing.itemPrices.map(p => p.dailyMax);
    for (const dm of dailyMaxes) {
      // 3-day, 7-day approximations
      knownPrices.push(Math.round(dm * 2.5), Math.round(dm * 5));
    }

    for (const price of mentionedPrices) {
      if (price < 5) continue; // Skip tiny numbers that aren't prices
      const matchesAny = knownPrices.some(kp => Math.abs(kp - price) <= 15);
      if (!matchesAny) {
        issues.push({
          type: 'PRICE_MISMATCH',
          detail: `Response mentions £${price} but known prices are [${[...new Set(knownPrices)].sort((a, b) => a - b).join(', ')}]`,
        });
      }
    }
  }

  // 2. ITEM IDENTITY CHECK
  // If response mentions items NOT in resolvedItems, flag it
  if (facts.resolvedItems.length > 0) {
    const inventoryNames = getInventoryItemNames();
    const responseLower = response.toLowerCase();
    const mentionedItemNames = inventoryNames.filter(item => {
      // Check if the key part of the item name is in the response
      const parts = item.toLowerCase().split(' ');
      // Need at least the first 2 significant words to match
      const significantParts = parts.filter(p => p.length > 2);
      return significantParts.length >= 2
        ? significantParts.slice(0, 2).every(p => responseLower.includes(p))
        : responseLower.includes(item.toLowerCase());
    });

    const unknownItems = mentionedItemNames.filter(item =>
      !facts.resolvedItems.some(ri =>
        ri.toLowerCase().includes(item.toLowerCase().split(' ').slice(0, 2).join(' '))
        || item.toLowerCase().includes(ri.toLowerCase().split(' ').slice(0, 2).join(' '))
      ),
    );

    if (unknownItems.length > 0) {
      issues.push({
        type: 'ITEM_MISMATCH',
        detail: `Response mentions ${unknownItems.join(', ')} but rental items are ${facts.resolvedItems.join(', ')}`,
      });
    }
  }

  // 3. AVAILABILITY CLAIM CHECK
  const claimsUnavailable = /\b(not available|unavailable|out of stock|booked out|fully booked|already booked|currently rented|not in stock)\b/i.test(response);
  const claimsAvailable = /\b(available|free|open|no conflicts?)\b/i.test(response);
  const claimsPartialAvailability = /\b(available\s+from|available\s+after|free\s+from|free\s+after)\b/i.test(response);

  if (facts.availability) {
    for (const item of facts.availability.items) {
      const hasTimeWindow = !!(item.availableFrom || item.unavailableAfter);

      if (claimsAvailable && !item.available) {
        if (hasTimeWindow && claimsPartialAvailability) continue;
        issues.push({
          type: 'AVAILABILITY_LIE',
          detail: `Claims available but ${item.item} has conflicts (${item.booked}/${item.maxQuantity} booked)`,
        });
      }
      if (claimsUnavailable && item.available) {
        issues.push({
          type: 'AVAILABILITY_LIE',
          detail: `Claims unavailable but ${item.item} IS available (${item.booked}/${item.maxQuantity} booked)`,
        });
      }
    }
  } else if (claimsUnavailable) {
    // SAFETY NET: No formal availability data was gathered, but bot claims something
    // is unavailable. Flag as unverified — this is the #1 source of false stock-out errors.
    // The AI is guessing from the compact booking list without real availability checks.
    issues.push({
      type: 'UNVERIFIED_UNAVAILABILITY',
      detail: 'Response claims item is unavailable/booked but no formal availability check was performed. This claim may be wrong — the AI is guessing from the booking list.',
    });
  }

  // 4. UPSELL VIOLATION CHECK
  if (facts.suppressUpsell) {
    const upsellPatterns = /\b(also (consider|recommend|suggest)|pair.*(with|nicely)|complement|add(ing)?|upgrade|bundle|you might|have you thought|worth (adding|considering))\b/i;
    if (upsellPatterns.test(response)) {
      issues.push({
        type: 'UPSELL_VIOLATION',
        detail: 'Upselling detected but should be suppressed at this conversation stage',
      });
    }
  }

  // 5. REPETITION CHECK
  if (facts.conversationState.questionsAsked?.length) {
    for (const asked of facts.conversationState.questionsAsked) {
      // Only flag if the exact question phrase appears (not partial word matches)
      if (asked.length > 10 && response.toLowerCase().includes(asked.toLowerCase())) {
        issues.push({
          type: 'REPETITION',
          detail: `Re-asking "${asked}" which was already discussed`,
        });
      }
    }
  }


  // 6. LOW-VALUE ACCEPTANCE CHECK
  if (facts.lowValueInstruction) {
    const acceptancePatterns = /\b(available|free|sorted|confirmed|all set|booked|good to go|locked in|reserved|that works|sounds good|happy to confirm)\b/i;
    const upsellPatterns = /\b(also|add|pair|bundle|complement|suggest|recommend|together with|minimum|booking total)\b/i;
    if (acceptancePatterns.test(response) && !upsellPatterns.test(response)) {
      issues.push({
        type: 'LOW_VALUE_ACCEPTANCE',
        detail: 'Response confirms a sub-minimum rental without upselling or stating minimum',
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

/**
 * Build a corrective prompt when verification fails.
 * One retry — not re-generating from scratch.
 */
export function buildCorrectionPrompt(
  originalResponse: string,
  issues: VerificationIssue[],
): string {
  const issueLines = issues.map(i => `- ${i.type}: ${i.detail}`).join('\n');
  return `Your response had these factual errors:
${issueLines}

Fix ONLY the errors. Keep everything else the same. Reply with the corrected message only.

Original response:
${originalResponse}`;
}
