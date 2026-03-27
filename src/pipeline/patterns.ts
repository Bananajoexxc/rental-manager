/**
 * Shared regex patterns used by both FILTER and CONTRACT layers.
 * Single source of truth — prevents duplicate pattern definitions.
 */

// Qualify question patterns — detect "what kind of shoot?" style questions
// Used by: filter.ts (strip from non-greeting responses), contract.ts (block as QUESTION_PATTERNS)
export const QUALIFY_PATTERNS: RegExp[] = [
  /(?:what|which)(?:'s| is| kind of| type of)?\s*(?:the |your )?\s*(?:shoot|project|production|film|video|gig)\s*(?:for|about|type|going to be)?\??/i,
  /(?:what|which) (?:kind|type|sort) of (?:shoot|project|production|film|video|gig|work)\b/i,
  /(?:what|which) are you (?:shooting|filming|working on|planning|using (?:it|them|the gear) for)\??/i,
  /what(?:'s| is) (?:it|this|the shoot|the project) for\??/i,
  /that way I can (?:suggest|recommend|help|advise)/i,
];

// "what's the shoot for" — exact match used in contract mustNot checks
export const SHOOT_QUESTION_PATTERN = /\bwhat(?:'s| is) the shoot for\b/i;
