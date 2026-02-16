/**
 * Layer 6: CONTRACT — Intent-Based Response Validation (Code-Enforced, <1ms)
 *
 * Each message intent has a contract defining what the response:
 * - MUST contain
 * - MUST NOT contain
 * - Maximum length
 *
 * Not a prompt instruction. TypeScript enforcement.
 * Violations trigger targeted rewrites, not full regeneration.
 */

import { Intent, MessageClassification } from './types';

export interface ContractViolation {
  rule: string;
  detail: string;
  severity: 'block' | 'warn';
}

export interface ContractResult {
  passed: boolean;
  violations: ContractViolation[];
  correctionHints: string[];
}

interface ResponseContract {
  maxLength?: number;
  must?: { pattern: RegExp; label: string }[];
  mustNot?: { pattern: RegExp; label: string; severity: 'block' | 'warn' }[];
}

// Upsell language patterns — reused across contracts
const UPSELL_PATTERNS: { pattern: RegExp; label: string; severity: 'block' | 'warn' }[] = [
  { pattern: /\b(also (consider|recommend|suggest|grab|need|want)|pair.*(with|nicely)|complement|upgrade to)\b/i, label: 'upsell-language', severity: 'block' },
  { pattern: /\bmost (people|filmmakers|shooters|videographers|clients|renters) (also|grab|add|pair|get|use|find|need)\b/i, label: 'most-people-upsell', severity: 'block' },
  { pattern: /\bhave you (thought|considered) about\b/i, label: 'have-you-considered', severity: 'block' },
  { pattern: /\bworth (adding|considering|grabbing|getting)\b/i, label: 'worth-adding', severity: 'block' },
  { pattern: /\byou might (want|need|like|also)\b/i, label: 'you-might-want', severity: 'block' },
  { pattern: /\bwhat(?:'s| is) the shoot for\b/i, label: 'shoot-type-question', severity: 'block' },
];

// Question-asking patterns
const QUESTION_PATTERNS: { pattern: RegExp; label: string; severity: 'block' | 'warn' }[] = [
  { pattern: /\bwhat(?:'s| is) the shoot for\b/i, label: 'shoot-type-question', severity: 'block' },
  { pattern: /\bwhat (?:are you|kind of|type of) (?:shooting|filming|working on)\b/i, label: 'project-question', severity: 'block' },
  { pattern: /\bwhat dates?\b/i, label: 'dates-question', severity: 'block' },
];

const CONTRACTS: Record<string, ResponseContract> = {
  // GOODBYE: Renter is wrapping up. Brief farewell only.
  [Intent.GOODBYE]: {
    maxLength: 150,
    mustNot: [
      ...UPSELL_PATTERNS,
      ...QUESTION_PATTERNS,
      { pattern: /\bwhat dates\b/i, label: 'asking-dates-on-goodbye', severity: 'block' },
    ],
  },

  // ACKNOWLEDGMENT: "ok", "yes", "sure", "got it" — brief confirmation
  [Intent.ACKNOWLEDGMENT]: {
    maxLength: 200,
    mustNot: [
      ...UPSELL_PATTERNS,
    ],
  },

  // GREETING: First message. Welcome + ask what they need. No product dumps.
  [Intent.GREETING]: {
    maxLength: 350,
    mustNot: [
      { pattern: /£\d+.*£\d+.*£\d+/s, label: 'price-dump-on-greeting', severity: 'warn' },
    ],
  },

  // LOGISTICS: Pickup/return/delivery coordination. Stay focused on logistics.
  [Intent.LOGISTICS]: {
    maxLength: 300,
    mustNot: [
      ...UPSELL_PATTERNS,
      ...QUESTION_PATTERNS,
    ],
  },

  // PRICING: Must include actual price. Don't defer when data is available.
  [Intent.PRICING_INQUIRY]: {
    must: [
      { pattern: /£\d+/, label: 'price-figure' },
    ],
    mustNot: [],
  },

  // COMPLAINT: Empathize first. Don't upsell.
  [Intent.COMPLAINT]: {
    mustNot: [
      ...UPSELL_PATTERNS,
    ],
  },

  // NEGOTIATION: Address price concern directly. Don't deflect.
  [Intent.NEGOTIATION]: {
    mustNot: [
      ...UPSELL_PATTERNS.filter(p => p.label !== 'upsell-language'), // Bundle savings are OK in negotiation
    ],
  },
};

/**
 * Validate a response against its intent contract.
 */
export function enforceContract(
  response: string,
  classification: MessageClassification,
  hasFactPackPricing: boolean,
): ContractResult {
  const violations: ContractViolation[] = [];
  const correctionHints: string[] = [];

  const contract = CONTRACTS[classification.intent];
  if (!contract) {
    // No contract for this intent — pass through
    return { passed: true, violations: [], correctionHints: [] };
  }

  // --- Max Length ---
  if (contract.maxLength && response.length > contract.maxLength) {
    violations.push({
      rule: 'maxLength',
      detail: `Response is ${response.length} chars, max is ${contract.maxLength} for ${classification.intent}`,
      severity: 'warn',
    });
    correctionHints.push(`Shorten to under ${contract.maxLength} characters. Be brief.`);
  }

  // --- MUST contain ---
  if (contract.must) {
    for (const { pattern, label } of contract.must) {
      if (!pattern.test(response)) {
        // Only flag as violation if we actually have the data to include
        if (label === 'price-figure' && !hasFactPackPricing) continue; // No pricing data available
        violations.push({
          rule: `must:${label}`,
          detail: `Response missing required element: ${label}`,
          severity: 'warn',
        });
        correctionHints.push(`Include ${label} in the response.`);
      }
    }
  }

  // --- MUST NOT contain ---
  if (contract.mustNot) {
    for (const { pattern, label, severity } of contract.mustNot) {
      const match = response.match(pattern);
      if (match) {
        violations.push({
          rule: `mustNot:${label}`,
          detail: `Forbidden pattern "${label}" found: "${match[0]}"`,
          severity,
        });
        correctionHints.push(`Remove "${match[0]}" — ${label} not appropriate for ${classification.intent} messages.`);
      }
    }
  }

  // --- SUPPRESS UPSELL (cross-intent, from classification) ---
  // Even if the intent doesn't have a specific contract, suppressUpsell overrides
  if (classification.suppressUpsell && !contract.mustNot?.some(p => p.label === 'upsell-language')) {
    for (const { pattern, label } of UPSELL_PATTERNS) {
      const match = response.match(pattern);
      if (match) {
        violations.push({
          rule: `suppressUpsell:${label}`,
          detail: `Upsell suppressed but found: "${match[0]}"`,
          severity: 'block',
        });
        correctionHints.push(`Remove upsell: "${match[0]}". Answer only what was asked.`);
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    correctionHints,
  };
}

/**
 * Attempt to fix contract violations by surgically removing violating sentences.
 * Only for 'block' severity violations. Returns null if no surgical fix possible.
 */
export function surgicalContractFix(
  response: string,
  violations: ContractViolation[],
): string | null {
  const blockViolations = violations.filter(v => v.severity === 'block');
  if (blockViolations.length === 0) return null;

  // Split into sentences
  const sentences = response.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 1) return null; // Can't surgically fix a one-sentence response

  // For each block violation, find and remove the offending sentence(s)
  const violatingPatterns = blockViolations
    .map(v => {
      const rule = v.rule.split(':')[1];
      return UPSELL_PATTERNS.find(p => p.label === rule)?.pattern
        || QUESTION_PATTERNS.find(p => p.label === rule)?.pattern;
    })
    .filter(Boolean) as RegExp[];

  const cleanSentences = sentences.filter(sentence => {
    return !violatingPatterns.some(pattern => pattern.test(sentence));
  });

  if (cleanSentences.length === 0) return null; // Removed everything — need regeneration
  if (cleanSentences.length === sentences.length) return null; // Nothing removed

  return cleanSentences.join(' ').trim();
}
