import { getMarketingListingItems } from './assemble';

/**
 * Layer 8: FILTER — Expanded Hard Filters (Code-Enforced, <1ms)
 *
 * Catches error categories that regex CAN reliably detect:
 * - Physical presence claims (AI pretending to be physically there)
 * - Fabricated renter quotes (AI making up what renter said)
 * - Internal action leaks (*Immediately informs Daniel...*)
 * - Platform name leaks (Hygglo)
 * - Time slot logic errors (8:30pm rejected as outside 7-9pm)
 * - Self-contradictions (available → then unavailable)
 * - Timestamp prefixes
 *
 * Returns: cleaned response + list of issues found (for logging).
 */

export interface FilterIssue {
  type: 'PHYSICAL_PRESENCE' | 'FABRICATED_QUOTE' | 'INTERNAL_ACTION' | 'PLATFORM_LEAK' | 'TIME_LOGIC' | 'SELF_CONTRADICTION' | 'TIMESTAMP' | 'FORMATTING' | 'MARKETING_ITEM_AVAILABLE';
  detail: string;
  action: 'stripped' | 'rewritten' | 'flagged';
}

export interface FilterResult {
  response: string;
  issues: FilterIssue[];
  modified: boolean;
}

/**
 * Run all hard filters on a response. Modifies response in-place where possible.
 */
export function filterResponse(
  response: string,
  conversationHistory: { role: string; content: string }[],
  message: string,
  account?: string,
  rentalStage?: string,
): FilterResult {
  const issues: FilterIssue[] = [];
  let text = response;

  // --- 1. INTERNAL ACTION LEAK ---
  // AI sometimes wraps internal thoughts in *asterisks* like "*Immediately informs Daniel*"
  const internalActionPattern = /\*[^*]*(?:Daniel|Telegram|escalat|internal|notify|alert|inform|immediately|owner|urgent)[^*]*\*/gi;
  const internalMatches = text.match(internalActionPattern);
  if (internalMatches) {
    for (const match of internalMatches) {
      text = text.replace(match, '');
      issues.push({
        type: 'INTERNAL_ACTION',
        detail: `Stripped internal action: "${match.substring(0, 80)}"`,
        action: 'stripped',
      });
    }
  }

  // Also catch any remaining asterisk-wrapped action-like text
  const anyAsteriskAction = /\*[^*]{10,}\*/g;
  const asteriskMatches = text.match(anyAsteriskAction);
  if (asteriskMatches) {
    for (const match of asteriskMatches) {
      // Only strip if it looks like an action (contains verbs)
      if (/\b(inform|send|notify|check|update|contact|call|text|message|alert|escalat|forward)\b/i.test(match)) {
        text = text.replace(match, '');
        issues.push({
          type: 'INTERNAL_ACTION',
          detail: `Stripped asterisk action: "${match.substring(0, 80)}"`,
          action: 'stripped',
        });
      }
    }
  }

  // --- 1b. PLAIN-TEXT INTERNAL LEAKS ---
  // Catch CRITICAL/SECURITY/ALERT patterns not wrapped in asterisks
  const internalPlainPatterns = [
    /CRITICAL\s*(?:SECURITY\s*)?ALERT[^.!?\n]*/gi,
    /INTERNAL\s*(?:NOTE|MEMO|ACTION)[^.!?\n]*/gi,
    /MANDATORY\s*DELIVERY\s*(?:RULE|POLICY)[^.!?\n]*/gi,
    /\[INTERNAL\][^.!?\n]*/gi,
    /\[ESCALATION\][^.!?\n]*/gi,
    /DRAFT\s*REPLY\s*:/gi,
  ];
  for (const pattern of internalPlainPatterns) {
    if (pattern.test(text)) {
      text = text.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim();
      issues.push({ type: 'INTERNAL_ACTION', detail: 'Stripped plain-text internal leak', action: 'stripped' });
    }
  }

  // --- 1c. CROSS-ACCOUNT NAME LEAK ---
  // "Daniel" must not appear in Leo account responses
  if (account === 'leo' && /\bDaniel\b/.test(text)) {
    text = text.replace(/\bDaniel\b/g, 'I');
    issues.push({ type: 'INTERNAL_ACTION', detail: 'Replaced "Daniel" with "I" on Leo account', action: 'rewritten' });
  }

  // --- 2. PLATFORM NAME LEAK ---
  if (/\bHygglo\b/gi.test(text)) {
    text = text.replace(/\bHygglo\b/gi, 'the platform');
    issues.push({
      type: 'PLATFORM_LEAK',
      detail: 'Replaced "Hygglo" with "the platform"',
      action: 'rewritten',
    });
  }

  // --- 3. PHYSICAL PRESENCE CLAIMS ---
  // The AI is a chat agent. It CANNOT physically arrive, move, grab gear, be at locations, etc.
  // This applies to ALL stages including confirmed/pickup — the AI arranges handoffs, Daniel/Leo do them.
  const physicalPresencePatterns = [
    // Gear-specific physical claims
    /\bI'?m here with your (gear|kit|equipment|lens|camera)\b/i,
    /\bjust (grabbed|picked up|got) (the|your) (gear|kit|lens|camera|equipment)\b/i,
    /\b(arriving|arrived) with (the|your) (gear|kit|equipment)\b/i,
    /\bI'?ll (come|bring|carry|hand) (it |the gear |your gear |everything )?(out|over|to you|down)\b/i,
    /\bcoming out to (you|meet you) (now|with)\b/i,
    /\bjust arrived with your\b/i,
    /\bI'?ve got (the|your) (gear|kit|equipment|lens|camera) (here|ready|with me)\b/i,
    /\bdon'?t have a phone with me\b/i,
    /\bI'?m (bringing|carrying) (the|your|it)\b/i,
    // General mobility/presence claims — the AI cannot move or be at places
    /\b(on my way|heading (to |over|there)|coming over|coming (to|now))\b/i,
    /\bbe with you in\b/i,
    /\bI'?ll (be there|meet you|wait for you|come to you)\b/i,
    /\bI'?m (at|by|near|outside|waiting|here)\b/i,
    /\bspotted you\b/i,
    /\bsee you (in|shortly|soon|there)\b/i,
    /\bjust (parking|arrived|pulled up|getting out)\b/i,
    /\bI'?ll wait (for you |here )/i,
  ];

  for (const pattern of physicalPresencePatterns) {
    if (pattern.test(text)) {
      // Strip the sentence containing the physical presence claim
      const sentences = text.split(/(?<=[.!?])\s+/);
      const cleaned = sentences.filter(s => !pattern.test(s));
      if (cleaned.length < sentences.length) {
        text = cleaned.join(' ').replace(/\n{3,}/g, '\n\n').trim();
        issues.push({
          type: 'PHYSICAL_PRESENCE',
          detail: `Physical presence claim stripped: "${text.match(pattern)?.[0] || 'removed'}"`,
          action: 'stripped',
        });
      } else {
        issues.push({
          type: 'PHYSICAL_PRESENCE',
          detail: `Physical presence claim detected: "${text.match(pattern)?.[0]}"`,
          action: 'flagged',
        });
      }
    }
  }

  // --- 4. FABRICATED RENTER QUOTES ---
  // Detect "you said X" / "you mentioned X" and cross-check against actual history
  const quotePatterns = [
    /you (?:said|mentioned|told me|asked about|indicated|noted|specified) (?:that )?(?:the |your |a )?(.{5,60}?)(?:\.|,|!|\?|$)/gi,
    /earlier (?:you|in our chat) (?:said|mentioned|asked|told|indicated) (.{5,60}?)(?:\.|,|!|\?|$)/gi,
  ];

  const renterMessages = conversationHistory
    .filter(m => m.role === 'user')
    .map(m => m.content.toLowerCase())
    .join(' ');

  for (const pattern of quotePatterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const claimedContent = match[1]?.trim().toLowerCase();
      if (!claimedContent || claimedContent.length < 5) continue;

      // Extract key words from the claimed content
      const claimWords = claimedContent.split(/\s+/).filter(w => w.length > 3);
      const anyWordInHistory = claimWords.some(w => renterMessages.includes(w));

      if (!anyWordInHistory && renterMessages.length > 0) {
        issues.push({
          type: 'FABRICATED_QUOTE',
          detail: `AI claims renter said "${match[1]?.trim()}" but no matching content in history`,
          action: 'flagged',
        });
      }
    }
  }

  // --- 5. TIME SLOT LOGIC ---
  // Detect when the AI rejects a time that's actually within the stated window
  const timeSlotRejection = /(?:my|our|the) slots? (?:are|is) (\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i;
  const rejectionMatch = text.match(timeSlotRejection);
  if (rejectionMatch) {
    const slotStart = parseTimeToMinutes(rejectionMatch[1]);
    const slotEnd = parseTimeToMinutes(rejectionMatch[2]);

    // Check if the renter's proposed time was rejected
    const renterTimeMatch = message.match(/(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\b/i);
    if (renterTimeMatch && slotStart !== null && slotEnd !== null) {
      const proposedTime = parseTimeToMinutes(renterTimeMatch[1]);
      if (proposedTime !== null && proposedTime >= slotStart && proposedTime <= slotEnd) {
        // AI is rejecting a time that IS within its own stated window
        if (/\b(outside|can'?t|not available|doesn'?t work|won'?t work|not within|instead)\b/i.test(text)) {
          issues.push({
            type: 'TIME_LOGIC',
            detail: `AI rejected ${renterTimeMatch[1]} as outside ${rejectionMatch[1]}-${rejectionMatch[2]} but it's within range`,
            action: 'flagged',
          });
        }
      }
    }
  }

  // --- 6. SELF-CONTRADICTION ---
  // Check if the current response contradicts the AI's previous messages
  const assistantMessages = conversationHistory
    .filter(m => m.role === 'assistant')
    .map(m => m.content.toLowerCase());

  if (assistantMessages.length > 0) {
    const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];

    // Available → unavailable contradiction
    const claimsAvailable = /\b(available|in stock|I'?ve got|we'?ve got|I have|we have)\b/i.test(text);
    const claimsUnavailable = /\b(out of stock|unavailable|not available|don'?t have|can'?t get)\b/i.test(text);
    const prevClaimedAvailable = /\b(available|in stock|i'?ve got|we'?ve got|i have|we have)\b/i.test(lastAssistantMsg);
    const prevClaimedUnavailable = /\b(out of stock|unavailable|not available|don'?t have)\b/i.test(lastAssistantMsg);

    if (claimsUnavailable && prevClaimedAvailable && !claimsAvailable) {
      issues.push({
        type: 'SELF_CONTRADICTION',
        detail: 'Previously said item was available, now claiming unavailable',
        action: 'flagged',
      });
    }
    if (claimsAvailable && prevClaimedUnavailable && !claimsUnavailable) {
      issues.push({
        type: 'SELF_CONTRADICTION',
        detail: 'Previously said item was unavailable, now claiming available',
        action: 'flagged',
      });
    }
  }

  // --- 7. TIMESTAMPS ---
  // Strip any timestamp prefixes the AI generates
  text = text.replace(/^\s*\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\d{1,2}\s+\w+\s+\d{1,2}:\d{2}\]\s*/gi, '');
  // Strip multiple timestamps (the triple-timestamp bug)
  const timestampPattern = /\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\d{1,2}\s+\w+\s+\d{1,2}:\d{2}\]\s*/gi;
  if (timestampPattern.test(text)) {
    text = text.replace(timestampPattern, '');
    issues.push({
      type: 'TIMESTAMP',
      detail: 'Stripped embedded timestamps',
      action: 'stripped',
    });
  }

  // --- 8. MARKETING ITEM AVAILABILITY ---
  // If the bot claims a marketing-only item is available, flag it
  const marketingItems = getMarketingListingItems();
  if (marketingItems.length > 0) {
    const availablePattern = /\b(available|in stock|I'?ve got|we'?ve got|I have|we have|can get|ready for)\b/i;
    if (availablePattern.test(text)) {
      const textLower = text.toLowerCase();
      for (const item of marketingItems) {
        if (textLower.includes(item.toLowerCase())) {
          issues.push({
            type: 'MARKETING_ITEM_AVAILABLE',
            detail: `Bot claims marketing-only item "${item}" is available — this item is NOT in inventory`,
            action: 'flagged',
          });
        }
      }
    }
  }

  // --- 9. FORMATTING CLEANUP ---
  const originalLength = text.length;
  text = text
    .replace(/\]\]+/g, '')           // stray brackets
    .replace(/\n{3,}/g, '\n\n')      // triple+ newlines
    .replace(/(\*{2,}|_{2,}|#{1,})/g, '') // markdown formatting
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links
    .replace(/^\s+|\s+$/g, '')       // trim
    .replace(/  +/g, ' ');           // double spaces

  if (text.length !== originalLength) {
    issues.push({
      type: 'FORMATTING',
      detail: 'Cleaned formatting artifacts',
      action: 'stripped',
    });
  }

  return {
    response: text,
    issues,
    modified: text !== response,
  };
}

// --- Helpers ---

function parseTimeToMinutes(timeStr: string): number | null {
  const cleaned = timeStr.trim().toLowerCase();
  const match = cleaned.match(/^(\d{1,2})(?:[:.:](\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hours = parseInt(match[1]);
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const meridiem = match[3];

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  // If no meridiem and hours <= 12, assume context (7-9 likely means 7pm-9pm for evening slots)
  // This is handled by the caller comparing against the full slot string

  return hours * 60 + minutes;
}
