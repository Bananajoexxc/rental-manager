import { getMarketingListingItems } from './assemble';
import { QUALIFY_PATTERNS } from './patterns';

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
  type: 'PHYSICAL_PRESENCE' | 'FABRICATED_QUOTE' | 'INTERNAL_ACTION' | 'PLATFORM_LEAK' | 'TIME_LOGIC' | 'SELF_CONTRADICTION' | 'TIMESTAMP' | 'FORMATTING' | 'MARKETING_ITEM_AVAILABLE' | 'INVALID_TIME_ACCEPTED' | 'PROACTIVE_DELIVERY' | 'QUALIFY_QUESTION_SPAM' | 'CHAIN_OF_THOUGHT' | 'EQUIPMENT_SUBSTITUTION' | 'TIMING_CAPITULATION' | 'NON_INVENTORY_ADDON' | 'MISSED_ARRIVAL' | 'PROACTIVE_EXTRA_DAY_WARNING' | 'VAGUE_CONFIRMED_LOCATION' | 'PRICE_HALLUCINATION' | 'ACCESSORY_CHARGED_SEPARATELY' | 'PREMATURE_CONFIRMATION' | 'FALSE_ACTION_CLAIM' | 'LOW_VALUE_BLOCK';
  detail: string;
  action: 'stripped' | 'rewritten' | 'flagged' | 'block';
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
  factPack?: any,
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
  // "Daniel" must not appear in Leo account responses (Leo claims to BE the owner)
  if (account === 'leo' && /\bDaniel\b/.test(text)) {
    // Object position (after prepositions): "with Daniel" → "with me", "to Daniel" → "to me"
    text = text.replace(/\b(with|to|from|for|by|contact|notify|notifying|ask|tell|reach)\s+Daniel\b/gi, '$1 me');
    // Possessive: "Daniel's" → "my"
    text = text.replace(/\bDaniel's\b/g, 'my');
    // Subject position and remaining: "Daniel" → "I"
    text = text.replace(/\bDaniel\b/g, 'I');
    issues.push({ type: 'INTERNAL_ACTION', detail: 'Replaced "Daniel" with first-person pronouns on Leo account', action: 'rewritten' });
  }

  // --- 1d. LEO ACCOUNT: "WE/OUR" → "I/MY" ---
  // Leo Adams uses first person singular ONLY. GPT often defaults to "we have" / "our gear".
  if (account === 'leo') {
    const hadWeOur = /\b(we|our)\b/i.test(text);
    if (hadWeOur) {
      // "we have" → "I have", "we've" → "I've", "we can" → "I can", "we do" → "I do"
      text = text.replace(/\bwe'?ve\b/gi, "I've");
      // "we're [adjective]" → "they're [adjective]" (e.g. "we're separate" → "they're separate")
      text = text.replace(/\bwe'?re (separate|different|independent|distinct|two|not the same|not related)\b/gi, "they're $1");
      text = text.replace(/\bwe'?re\b/gi, "I'm");
      text = text.replace(/\bwe'?ll\b/gi, "I'll");
      text = text.replace(/\bwe (have|can|do|offer|provide|also|stock|carry|include|don'?t|did|are|get|will|should|could|would|need)\b/gi, 'I $1');
      text = text.replace(/\bour (gear|kit|equipment|stock|inventory|items|prices?|rates?|rental|business|location|shop|studio|place|selection)\b/gi, 'my $1');
      text = text.replace(/\bour\b/gi, 'my');
      // Handle remaining standalone "we" at sentence start
      text = text.replace(/\bWe\b/g, 'I');
      text = text.replace(/\bwe\b/g, 'I');
      // Fix stutter from cascading replacements: "I'm I", "I I have", etc.
      text = text.replace(/\bI'm I\b/g, "I'm");
      text = text.replace(/\bI I\b/g, 'I');
      // Fix dangling "I'm." from "we're [word]" where [word] got eaten: "I'm." → remove sentence
      text = text.replace(/\bI'm\.\s*/g, '');
      // Fix "I'm separate" → "they're separate" (already caught above, but as safety net)
      text = text.replace(/\bI'm (separate|different|independent|distinct)\b/gi, "they're $1");
      issues.push({ type: 'INTERNAL_ACTION', detail: 'Replaced "we/our" with "I/my" on Leo account', action: 'rewritten' });
    }
  }


  // --- 1e. CHAIN-OF-THOUGHT LEAK DETECTION ---
  // Sonnet sometimes writes raw reasoning into the response body instead of using
  // the think tool / extended thinking. Catches internal monologue before it reaches the renter.
  // Incident: rental:9dc8d2c3 -- 1500 words of inventory counts, other renters' names, owner schedule leaked.
  const cotResult = detectAndStripChainOfThought(text);
  if (cotResult.stripped) {
    text = cotResult.cleanText;
    for (const detail of cotResult.details) {
      issues.push({
        type: 'CHAIN_OF_THOUGHT',
        detail,
        action: 'stripped',
      });
    }
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
  // Fix double-word stuttering from Hygglo replacement (e.g. "the the platform platform fee")
  text = text.replace(/\bthe the platform\b/gi, 'the platform');
  text = text.replace(/\bthe platform platform\b/gi, 'the platform');
  text = text.replace(/\bthe platform the platform\b/gi, 'the platform');

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

  // --- 9. INVALID TIME SLOT ACCEPTANCE ---
  // GPT often accepts invalid times (anything outside 10am-12pm or 7pm-9pm).
  // Detect when the bot confirms/accepts a time that falls outside valid slots.
  const renterTimeMatch = message.match(/\b(\d{1,2})(?:[:.:](\d{2}))?\s*(am|pm)\b/i);
  if (renterTimeMatch) {
    let rHours = parseInt(renterTimeMatch[1]);
    const rMinutes = renterTimeMatch[2] ? parseInt(renterTimeMatch[2]) : 0;
    const rMeridiem = renterTimeMatch[3]?.toLowerCase();
    if (rMeridiem === 'pm' && rHours < 12) rHours += 12;
    if (rMeridiem === 'am' && rHours === 12) rHours = 0;
    const rTime = rHours * 60 + rMinutes;

    // Valid slots: 10:00am-12:00pm (600-720) and 7:00pm-9:00pm (1140-1260)
    const isMorningSlot = rTime >= 600 && rTime <= 720;
    const isEveningSlot = rTime >= 1140 && rTime <= 1260;
    const isValidTime = isMorningSlot || isEveningSlot;

    if (!isValidTime) {
      // Check if the bot already rejected and offered valid slots
      const alreadyRejected = /\b(only|slots?\s+are|available)\s+(?:between\s+)?10(?:am|-?\s*12)/i.test(text)
        || /\b(10am.?12pm|7pm.?9pm)\b/i.test(text);

      // Check if the bot accepted/confirmed this invalid time instead
      const acceptPatterns = /\b(works|sounds good|perfect|great|confirmed|booked|see you|arranged|sorted|no problem|can do|that'?s fine|sure|ok|okay|delivery at|pickup at|collect at)\b/i;
      const botAccepted = acceptPatterns.test(text) && !alreadyRejected;

      if (botAccepted) {
        // Rewrite: strip the accepting sentence, add correction
        const sentences = text.split(/(?<=[.!?])\s+/);
        const timeStr = renterTimeMatch[0];
        const cleaned = sentences.filter(s => {
          // Remove sentences that accept the invalid time
          const mentionsTime = new RegExp(`\\b${rHours > 12 ? rHours - 12 : rHours}\\b`).test(s) || s.includes(timeStr);
          const accepts = acceptPatterns.test(s);
          return !(mentionsTime && accepts);
        });
        const correction = `Pickups and returns are only available 10am-12pm or 7pm-9pm. Would either of those work for you? I'd suggest the morning slot (10am-12pm) if that's convenient.`;
        text = cleaned.length > 0 ? cleaned.join(' ').trim() + ' ' + correction : correction;
        issues.push({
          type: 'INVALID_TIME_ACCEPTED',
          detail: `Bot accepted invalid time ${timeStr} — rewritten to offer valid slots`,
          action: 'rewritten',
        });
      }
    }
  }

  // --- 9b. BOT-INVENTED INVALID TIMES ---
  // GPT sometimes invents times outside valid slots (e.g. "earliest I can do is 4:30pm").
  // Catch any time the bot mentions that falls outside 10am-12pm or 7pm-9pm.
  const botTimePattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
  let botTimeMatch: RegExpExecArray | null;
  const botInvalidTimes: string[] = [];
  while ((botTimeMatch = botTimePattern.exec(text)) !== null) {
    let bHours = parseInt(botTimeMatch[1]);
    const bMinutes = botTimeMatch[2] ? parseInt(botTimeMatch[2]) : 0;
    const bMeridiem = botTimeMatch[3].toLowerCase();
    if (bMeridiem === 'pm' && bHours < 12) bHours += 12;
    if (bMeridiem === 'am' && bHours === 12) bHours = 0;
    const bTime = bHours * 60 + bMinutes;
    const bValid = (bTime >= 600 && bTime <= 720) || (bTime >= 1140 && bTime <= 1260);
    if (!bValid) {
      // Check if this time is being offered/suggested (not just mentioned as "not available")
      const timeStr = botTimeMatch[0];
      const nearbyText = text.substring(Math.max(0, botTimeMatch.index - 40), Math.min(text.length, botTimeMatch.index + timeStr.length + 40));
      const isBeingOffered = /\b(can do|pickup at|earliest|come at|drop.?off at|arrive at|available at|delivery at)\b/i.test(nearbyText);
      if (isBeingOffered) {
        botInvalidTimes.push(timeStr);
      }
    }
  }
  if (botInvalidTimes.length > 0) {
    // Strip sentences containing the invalid time offers
    const sentences = text.split(/(?<=[.!?])\s+/);
    const cleaned = sentences.filter(s => !botInvalidTimes.some(t => s.includes(t)));
    if (cleaned.length > 0 && cleaned.length < sentences.length) {
      text = cleaned.join(' ').trim();
      issues.push({
        type: 'INVALID_TIME_ACCEPTED',
        detail: `Bot offered invalid time(s): ${botInvalidTimes.join(', ')} — stripped`,
        action: 'stripped',
      });
    }
  }

  // --- 9c. TIME RANGE ACCEPTED INSTEAD OF EXACT TIME ---
  // Renter gives a range like "10-12pm" or "between 10 and 12" — this is NOT an exact time.
  // The bot must ask for one specific time (e.g. "10am" or "11:30am"), not confirm the range.
  const timeRangePattern = /\b(\d{1,2})\s*(?:-|to|and)\s*(\d{1,2})\s*(am|pm)\b/i;
  const renterTimeRange = message.match(timeRangePattern)
    || message.match(/\bbetween\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:and|-|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)/i);
  if (renterTimeRange) {
    // Renter gave a range — check if the bot accepted/confirmed it without asking for an exact time
    const botAcceptedRange = /\b(works|perfect|great|sounds good|confirmed|booked|see you|sorted|no problem|can do|that'?s fine|ok|okay)\b/i.test(text);
    const botAskedExact = /\b(exact(?:ly)?|specific|one time|what time exactly|precise)\b/i.test(text)
      || /\b(e\.?g\.?|example|such as|like "?\d)\b/i.test(text);
    if (botAcceptedRange && !botAskedExact) {
      const rangeStr = renterTimeRange[0];
      const correction = `Just need one exact time — e.g. 10am or 11am — and I'll lock that in for you.`;
      // Strip acceptance sentences that echo the range, append correction
      const sentences = text.split(/(?<=[.!?])\s+/);
      const cleaned = sentences.filter(s => {
        const echoesRange = s.includes(rangeStr) || /\b(10.?12|10am.?12)\b/i.test(s);
        const accepts = /\b(works|perfect|great|sounds good|confirmed|booked|sorted|no problem|can do|that'?s fine)\b/i.test(s);
        return !(echoesRange && accepts);
      });
      text = (cleaned.length > 0 ? cleaned.join(' ').trim() + ' ' : '') + correction;
      issues.push({
        type: 'INVALID_TIME_ACCEPTED',
        detail: `Bot accepted time range "${rangeStr}" — rewritten to ask for exact time`,
        action: 'rewritten',
      });
    }
  }

  // --- 10. PROACTIVE DELIVERY OFFER ---
  // Bot must NOT proactively offer delivery unless the renter specifically asked about it.
  const renterAskedDelivery = /\b(deliver|delivery|courier|drop.?off|send it|bring it|ship)\b/i.test(message);
  if (!renterAskedDelivery) {
    const botOffersDelivery = /\b(we (also |can )?offer delivery|delivery is available|I can (arrange|organise) delivery|want me to deliver|I can drop|we do delivery|delivery option)\b/i;
    if (botOffersDelivery.test(text)) {
      const sentences = text.split(/(?<=[.!?])\s+/);
      const cleaned = sentences.filter(s => !botOffersDelivery.test(s));
      if (cleaned.length > 0 && cleaned.length < sentences.length) {
        text = cleaned.join(' ').trim();
        issues.push({
          type: 'PROACTIVE_DELIVERY',
          detail: 'Stripped proactive delivery offer — renter did not ask about delivery',
          action: 'stripped',
        });
      }
    }
  }

  // --- 11. QUALIFY QUESTION SPAM ---
  // GPT appends "What kind of shoot/project are you planning?" to nearly every response.
  // Only allow on GREETING intent (first message). Strip it elsewhere.
  // Check if this looks like a non-greeting context (renter asked about logistics, pricing, negotiation, etc.)
  const isLogisticsOrPricingMsg = /\b(price|cost|how much|£|deliver|pickup|return|time|slot|available|cancel|refund|discount|cheaper|expensive|address|where|when)\b/i.test(message);
  if (isLogisticsOrPricingMsg) {
    for (const qp of QUALIFY_PATTERNS) {
      if (qp.test(text)) {
        const sentences = text.split(/(?<=[.!?])\s+/);
        const cleaned = sentences.filter(s => !QUALIFY_PATTERNS.some(p => p.test(s)));
        // Only strip if meaningful content remains. Safety checks:
        // 1. Result must be >80 chars (no fragments)
        // 2. Must keep at least half the original sentences (no gutting)
        // 3. Remaining text must not just be a trailing filler sentence
        const cleanedText = cleaned.join(' ').trim();
        const keptRatio = cleaned.length / sentences.length;
        if (cleaned.length > 0 && cleaned.length < sentences.length && cleanedText.length > 80 && keptRatio >= 0.5) {
          text = cleaned.join(' ').trim();
          issues.push({
            type: 'QUALIFY_QUESTION_SPAM',
            detail: 'Stripped "what are you shooting?" from non-greeting response',
            action: 'stripped',
          });
        } else if (cleaned.length < sentences.length) {
          issues.push({
            type: 'QUALIFY_QUESTION_SPAM',
            detail: 'Detected qualify question but kept response (stripping would leave <60 chars)',
            action: 'flagged',
          });
        }
      }
    }
  }

  // --- 12. EQUIPMENT SUBSTITUTION CONFIRMATION ---
  // INSURANCE RULE: Never tell a renter they'll receive a DIFFERENT item/model than what was
  // listed or what they asked for — even framed as "an upgrade" or "a step up".
  // Hygglo insurance covers only the LISTED item. A substitution claim creates an insurance
  // mismatch and must never appear in a bot response. Applies to ALL gear (cameras, lenses,
  // gimbals, mics, lights, drones, etc.).
  //
  // Patterns caught:
  //   "— a step up from the A7 IV"        "an upgrade from the RS3"
  //   "step up from what you asked"        "instead of the gimbal you mentioned"
  //   "better than the [model] you asked"  "rather than the [model you requested]"
  const substitutionPatterns: RegExp[] = [
    // "a step up from" / "an upgrade from" with any preceding dash or inline
    /\b(?:step[\s-]+up|upgrade)\s+from\b/i,
    // "instead of the [model]" or "rather than the [model]"
    /\b(?:instead|rather\s+than)\s+(?:of\s+)?the\b/i,
    // "— a step up" / "— an upgrade" (dash + comparison)
    /[—–-]\s*(?:an?\s+)?(?:step[\s-]+up|upgrade|improvement|better\s+version)\b/i,
    // "as opposed to the [model]" / "compared to the [model] you asked"
    /\bas\s+opposed\s+to\b/i,
  ];
  for (const subPat of substitutionPatterns) {
    if (subPat.test(text)) {
      issues.push({
        type: 'EQUIPMENT_SUBSTITUTION',
        detail: `Substitution comparison detected: "${text.match(subPat)?.[0] || 'pattern match'}" — bot implied renter receives a different item than listed`,
        action: 'flagged',
      });
      break; // one flag is enough per response
    }
  }

  // --- 13. TIMING OBJECTION CAPITULATION ---
  // When a renter says "timing doesn't work" / "times won't work" etc., the bot MUST fight
  // for the rental by offering day-before pickup / day-after drop-off / alternative slots.
  // A simple "no worries, hope you find what works" on a timing objection = lost sale.
  // The "Day Before and Day After Flexibility" DB rule (priority 90) triggers on this, but
  // AI sometimes ignores it when "thank you" appears at end of message.
  //
  // Detected renter timing objection + bot capitulation = TIMING_CAPITULATION flag.
  const timingObjectionInMsg = message
    ? /\b(?:timing|time)s?\s*(?:don'?t|won'?t|doesn'?t|can'?t|not)\s*(?:work|fit|suit|line\s+up|match)\b|\b(?:can'?t|cannot)\s+make\s+(?:it|the|a)\s*(?:time|slot|window|pickup|drop)\b|\btimes?\s+(?:are\s+)?(?:wrong|off|bad|tricky|difficult)\b|\bschedule\s+(?:doesn'?t|won'?t)\s+work\b|\bwon'?t\s+work\s+(?:for|with)\s+us\b/i.test(message)
    : false;

  if (timingObjectionInMsg) {
    // Check if bot response capitulated WITHOUT offering alternatives
    const offeredAlternative = /\b(?:evening|day|morning|night)\s+(?:before|after)\b|\bpick\s*up\s+(?:the\s+)?(?:evening|night|day)\s+before\b|\bdrop\s*(?:off)?\s+(?:the\s+)?(?:morning|day)\s+after\b|\balternative\s+(?:time|slot|day)\b|\b(?:10am|7pm|morning|evening)\s+slot\b/i.test(text);
    const capitulated = /\bno\s+worries\b|\bhope\s+you\s+find\b|\bfeel\s+free\s+to\s+come\s+back\b|\bhope\s+(?:it|something|things?)\s+works?\s+out\b|\bmaybe\s+another\s+time\b|\bif\s+(?:things?|timing)\s+(?:changes?|lines?\s+up)\b/i.test(text);
    if (capitulated && !offeredAlternative) {
      issues.push({
        type: 'TIMING_CAPITULATION',
        detail: 'Bot gave up on timing objection without offering day-before pickup / day-after drop-off alternatives — lost sale',
        action: 'flagged',
      });
    }
  }

  // --- 14. NON-INVENTORY ADDON OFFER ---
  // Catches bot offering to "add extra" accessories/batteries that are either not in inventory
  // or are misidentified (e.g. DJI gimbal battery ≠ DJI Osmo Action battery).
  // "we can look at adding" / "we could add extra" for consumables = false capability.
  // Patterns caught:
  //   "if you need an extra set we can look at adding that"
  //   "we can look at adding extra batteries"
  //   "we could throw in additional batteries"
  //   "we can try to include extra [batteries/memory/accessories]"
  const nonInventoryAddonPatterns: RegExp[] = [
    /\bwe\s+can\s+(?:look\s+at|try\s+to|see\s+about)\s+(?:look\s+at\s+)?add(?:ing)?\b.*\b(?:batter(?:y|ies)|extra\s+set|additional\s+set|memory|card|sd\b|accessory|accessories)\b/i,
    /\b(?:extra|additional|more)\s+(?:set\s+of\s+)?batter(?:y|ies)\b.*\bwe\s+(?:can|could|might)\s+(?:look\s+at\s+)?(?:add|include|throw\s+in|sort)\b/i,
    /\bwe\s+(?:can|could)\s+(?:look\s+at\s+)?(?:throw\s+in|include|add)\s+(?:extra|additional|more|an?\s+extra)\s+(?:batter(?:y|ies)|set)\b/i,
  ];
  for (const addonPat of nonInventoryAddonPatterns) {
    if (addonPat.test(text)) {
      issues.push({
        type: 'NON_INVENTORY_ADDON',
        detail: `Bot offered to add accessories/batteries that may not be in inventory: "${text.match(addonPat)?.[0]?.substring(0, 80) || 'pattern match'}"`,
        action: 'flagged',
      });
      break;
    }
  }

  // --- 15. MISSED ARRIVAL DETECTION ---
  // Catches bot telling renter to go to a location when renter already said they're waiting there.
  // Root cause (Mar 9 2026 — Serena Betti): renter said "I'm waiting here" and bot replied
  // "head to Central London at Trafalgar Square now and message here when you arrive" — she was already there.
  // Trigger: incoming message contains arrival/waiting phrases AND bot response tells them to head/go to location.
  if (message) {
    const renterAlreadyThere = /\b(?:i'?m here|i am here|we'?re here|we are here|i'?ve arrived|i have arrived|we'?ve arrived|just arrived|here now|waiting here|i'?m waiting|been waiting|standing here|stood here|i'?m standing|we'?re waiting|i'?m here waiting|already (?:here|there|arrived)|i am waiting|still (?:here|waiting)|i'?m outside|we'?re outside|i'?m at the|we'?re at the)\b/i.test(message);
    if (renterAlreadyThere) {
      const botDirectsToLocation = /\b(?:head(?:ing)?\s+(?:to|over)|make your way|go\s+(?:to|over)|come\s+(?:to|over)|message (?:here|us|me) when you arrive|text (?:us|me|here) when you(?:'re| are) (?:here|there|arrived)|let (?:us|me) know when you arrive|when you(?:'re| are) (?:here|there)|message (?:here|us) when (?:you'?re|you are) (?:there|here|at))\b/i.test(text);
      if (botDirectsToLocation) {
        issues.push({
          type: 'MISSED_ARRIVAL',
          detail: `Renter said they are waiting/here but bot is directing them to go to location: "${text.substring(0, 100)}"`,
          action: 'flagged',
        });
      }
    }
  }


  // --- 17. PRICE FACT-CHECK (deterministic, not AI) ---
  // Extracts every £ figure from the bot response and validates against
  // the pricing data that was injected into the prompt. If any stated price
  // is outside the catalog range, BLOCK the response.
  // Root cause: Sonnet hallucinates prices (e.g. £26 when catalog says £30-45).
  if (factPack?.pricing?.itemPrices && text) {
    const statedPrices = [...text.matchAll(/£\s*(\d+(?:\.\d{2})?)/g)].map(m => parseFloat(m[1]));
    if (statedPrices.length > 0) {
      const allKnownPrices = [
        ...factPack.pricing.itemPrices.map((p: any) => ({ name: p.itemName, min: p.dailyMin, max: p.dailyMax })),
        ...(factPack.pricing.bundlePrices || []).map((p: any) => ({ name: p.itemName, min: p.dailyMin, max: p.dailyMax })),
      ];

      if (allKnownPrices.length > 0) {
        // Build valid price set: all individual prices, reasonable multi-day totals, and delivery quotes
        const validPrices = new Set<number>();
        for (const p of allKnownPrices) {
          // Daily prices
          for (let v = Math.floor(p.min * 0.9); v <= Math.ceil(p.max * 1.1); v++) {
            validPrices.add(v);
          }
          // Multi-day: 2d, 3d (2.5x), 4d, 5d, 6d, 7d (5x)
          for (const mult of [2, 2.5, 3, 4, 5, 6, 7]) {
            for (let v = Math.floor(p.min * mult * 0.9); v <= Math.ceil(p.max * mult * 1.1); v++) {
              validPrices.add(v);
            }
          }
        }
        // Delivery prices (£10-100 range)
        for (let v = 10; v <= 100; v++) validPrices.add(v);
        // Deposits (£50-500)
        for (let v = 50; v <= 500; v += 10) validPrices.add(v);
        // Small add-ons (SD cards etc: £5-15)
        for (let v = 5; v <= 15; v++) validPrices.add(v);

        const wrongPrices = statedPrices.filter(p => !validPrices.has(Math.round(p)));
        if (wrongPrices.length > 0) {
          const knownStr = allKnownPrices.map((p: any) => `${p.name}: £${p.min}-${p.max}`).join(', ');
          issues.push({
            type: 'PRICE_HALLUCINATION',
            detail: `Bot stated price(s) £${wrongPrices.join(', £')} which don't match catalog [${knownStr}]. Prices must come from the provided pricing data, not be invented.`,
            action: 'flagged',
          });
        }
      }
    }
  }

  // --- 18. INCLUDED ACCESSORIES CHARGED SEPARATELY ---
  // SD cards, batteries, straps, cables, lens caps are INCLUDED free in camera/lens rentals.
  // Bot must NEVER quote these as separate line items with their own price.
  if (text) {
    const accessoryPattern = /(?:SD|memory)\s*card|batter(?:y|ies)|lens\s*cap|body\s*cap|camera\s*strap|charger|USB\s*cable|cleaning\s*cloth|lens\s*hood/i;
    const pricedAccessory = /(?:(?:SD|memory)\s*card|batter(?:y|ies)|lens\s*cap|body\s*cap|camera\s*strap|charger|USB\s*cable|cleaning\s*cloth|lens\s*hood)\s*(?:is|for|at|=|:)?\s*\u00a3\d+|\u00a3\d+\s*(?:for|to add|extra)\s*(?:an?\s+)?(?:SD|memory|batter|strap|charger|cable|cap)/i;
    if (pricedAccessory.test(text)) {
      issues.push({
        type: 'ACCESSORY_CHARGED_SEPARATELY',
        detail: 'Bot is charging for an included accessory separately. SD cards, batteries, straps, chargers, lens caps, and cables are INCLUDED in all rentals at no extra cost.',
        action: 'flagged',
      });
    }
  }

  // --- 19. MODEL NAME CONFUSION ---
  // Bot confuses similar models (FX30/FX3, RS4/RS3, X100V/X100VI, A7III/A7IV, etc).
  // The listing title is the source of truth — bot must use that exact model.
  if (text && factPack?.verifiedListingItem) {
    const listing = factPack.verifiedListingItem.toLowerCase();
    const responseLower = text.toLowerCase();
    const confusions: [string, string][] = [
      ['x100vi', 'x100v'], ['x100v', 'x100vi'],
      ['fx3', 'fx30'], ['fx30', 'fx3'],
      ['a7iv', 'a7iii'], ['a7iii', 'a7iv'],
      ['a7v', 'a7iv'], ['a7rv', 'a7riv'],
      ['rs3 pro', 'rs4 pro'], ['rs4 pro', 'rs3 pro'],
      ['r5c', 'r5 '], ['bmpcc 4k', 'bmpcc 6k'], ['bmpcc 6k', 'bmpcc 4k'],
      ['6k pro', '6k g2'], ['6k g2', '6k pro'],
    ];
    for (const [correct, wrong] of confusions) {
      if (listing.includes(correct) && responseLower.includes(wrong) && !responseLower.includes(correct)) {
        issues.push({
          type: 'EQUIPMENT_SUBSTITUTION',
          detail: `Bot used wrong model "${wrong}" when listing is "${correct}". Model names must match the listing exactly.`,
          action: 'flagged',
        });
        break;
      }
    }
  }

  // --- 16. PROACTIVE EXTRA DAY WARNING ---
  // Catches bot volunteering "extra rental day" warnings when renter didn't ask about
  // day-before pickup or morning-after return. Renter stating their booking dates normally
  // should NOT trigger alarm about extra charges — it scares renters away.
  // Root cause (Mar 10 2026): scheduling_rules said "ALWAYS proactively offer" day-before/after
  // which caused bot to warn about extra days even when renter just stated normal dates.
  if (message) {
    const renterAskedAboutExtension = /\b(evening before|day before|night before|morning after|pick up.*(?:early|before|friday|thursday|wednesday|monday|tuesday)|return.*(?:late|after|next day)|extra day|is there.*extra|an extra charge|extend)\b/i.test(message);
    if (!renterAskedAboutExtension) {
      const botWarnsExtraDay = /\b(counts as an extra (?:rental )?day|that(?:'s| is| would be) an extra (?:rental )?day|would add (?:an )?extra (?:rental )?day|picking up.*(?:day|evening) before.*(?:extra|additional) (?:rental )?day|morning after.*(?:extra|additional) (?:rental )?day)\b/i.test(text);
      if (botWarnsExtraDay) {
        issues.push({
          type: 'PROACTIVE_EXTRA_DAY_WARNING',
          detail: `Bot warned about extra day charge when renter didn't ask about day-before/morning-after: "${text.substring(0, 120)}"`,
          action: 'flagged',
        });
      }
    }
  }

  // --- 17. VAGUE CONFIRMED LOCATION ---
  // Once booking is confirmed, bot must give the FULL EXACT ADDRESS, not abbreviations.
  // Root cause (Mar 10 2026 — Oliver Willis / Leo): Booking confirmed, Oliver replied with times.
  // Bot said "Meet me outside the Pret at Central London, near Charing Cross" instead of
  // "5 Pall Mall East, London SW1Y 5BF — meet outside by the Pret".
  // The AI had the full address in context but paraphrased it to a vague form.
  const postBookingStages = ['confirmed', 'completed', 'booked', 'ongoing', 'upcoming', 'active'];
  if (rentalStage && postBookingStages.includes(rentalStage.toLowerCase())) {
    const leoVagueLocation =
      account === 'leo' &&
      /\b(pret|charing cross|pall mall)\b/i.test(text) &&
      !/5 pall mall east/i.test(text);
    const dbVagueLocation =
      account !== 'leo' &&
      /\b(pret a manger|national gallery|the gallery|the statue|trafalgar square|by the statue)\b/i.test(text) &&
      !/11 trafalgar square|statue of james/i.test(text);
    if (leoVagueLocation || dbVagueLocation) {
      // Rewrite: inject full address after the vague reference
      const fullAddress =
        account === 'leo'
          ? '5 Pall Mall East, London SW1Y 5BF — meet outside by the Pret'
          : 'Statue of James II, 11 Trafalgar Square, London WC2N 5DN';
      if (leoVagueLocation) {
        // Replace any abbreviated Pret/Charing Cross reference with full address
        text = text.replace(
          /(?:outside\s+)?the\s+pret(?:\s+(?:at|in|on|near)[\w\s,]+)?(?:\s*,\s*near\s+charing\s+cross[\w\s]*)?/gi,
          '5 Pall Mall East, London SW1Y 5BF (meet outside by the Pret)',
        );
      }
      if (dbVagueLocation) {
        // Replace "Trafalgar Square" alone with full landmark address
        text = text.replace(
          /(?:at\s+|by\s+|to\s+)?trafalgar\s+square(?!\s*,\s*(?:London|WC2N))/gi,
          'Statue of James II, 11 Trafalgar Square, London WC2N 5DN',
        );
      }
      issues.push({
        type: 'VAGUE_CONFIRMED_LOCATION',
        detail: `Post-confirmed response gave abbreviated location — rewrote to full address: "${fullAddress}"`,
        action: 'rewritten',
      });
    }
  }

  // --- 18. FORMATTING CLEANUP ---
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

  // --- 21. PREMATURE BOOKING CONFIRMATION ---
  // When rental is in BOOKED stage (verification pending), bot must NOT claim
  // the booking is accepted/confirmed/gone through. Misleads the renter.
  if (text && rentalStage === 'booked') {
    const claimsConfirmed = /\b(?:gone through|it'?s? (?:been |now )?(?:confirmed|accepted|approved|verified|sorted|done|processed|all good|locked in|secured)|booking (?:is |has been )?(?:confirmed|accepted|approved|live|active)|you'?re (?:all )?(?:confirmed|booked|sorted|good to go|locked in|set))\b/i.test(text);
    if (claimsConfirmed) {
      issues.push({
        type: 'PREMATURE_CONFIRMATION',
        detail: 'Bot claimed booking is confirmed but rental is still in BOOKED stage (verification pending). Must wait for platform verification to complete.',
        action: 'flagged',
      });
    }
  }

  // --- 22. FALSE ACTION CLAIMS ---
  // Bot must NEVER claim it is performing admin actions it cannot do.
  if (text) {
    const falseActions = /\b(?:I'?ll (?:get it|have it) (?:accepted|confirmed|approved|sorted)|I'?ve (?:just |now )?(?:accepted|confirmed|approved) (?:it|the|your)|I'?m (?:accepting|confirming|approving) (?:it|the|your)|let me (?:accept|confirm|approve) (?:it|that|the|your))\b/i.test(text);
    if (falseActions) {
      issues.push({
        type: 'FALSE_ACTION_CLAIM',
        detail: 'Bot claimed it can perform admin actions (accept bookings, verify documents). The bot is a chat interface only.',
        action: 'flagged',
      });
    }
  }



  // --- 23. LOW-VALUE RENTAL: Block acceptance without upsell ---
  if (factPack?.lowValueInstruction) {
    const acceptsLowValue = /\b(available|free for|sorted|confirmed|all set|booked for you|good to go|locked in|reserved for you)\b/i.test(text);
    const hasUpsellOrMinimum = /\b(also|add|pair|bundle|minimum|booking total|complement|together with|suggest|recommend)\b/i.test(text);
    if (acceptsLowValue && !hasUpsellOrMinimum) {
      const minMatch = factPack.lowValueInstruction.match(/Minimum: £(\d+)/);
      const minimum = minMatch ? minMatch[1] : '25';
      // Rewrite the acceptance into an upsell nudge
      text = text.replace(
        /^(Hey|Hi|Hello)?[^.!?]*?(available|free|sorted|confirmed)[^.!?]*[.!?]/i,
        "I'd love to help with that! Before confirming, most people pair this with a complementary item for their shoot. What are you working on? Our minimum booking is £" + minimum + '.'
      );
      issues.push({
        type: 'LOW_VALUE_BLOCK',
        detail: 'Blocked acceptance of sub-minimum rental. Rewrote to upsell/minimum notice (GBP ' + minimum + ').',
        action: 'rewritten',
      });
    }
  }

  // --- 23. LOW-VALUE RENTAL: Block acceptance without upsell ---
  if (factPack?.lowValueInstruction) {
    const acceptsLowValue = /(available|free for|sorted|confirmed|all set|good to go|booked for you|locked in|reserved for you)/i.test(text);
    const hasUpsellOrMinimum = /(what are you shooting|what.{0,5}the shoot|pair|complement|also.{0,5}(grab|add|consider)|most people|bundle|add.{0,30}for|minimum|booking total|together with)/i.test(text);
    if (acceptsLowValue && !hasUpsellOrMinimum) {
      const minMatch = (factPack.lowValueInstruction as string).match(/Minimum:.{0,3}(\d+)/);
      const minimum = minMatch ? minMatch[1] : '25';
      text = "That's available for those dates! What are you shooting? Most people pair this with a complementary item - happy to suggest something. Our minimum booking is £" + minimum + ".";
      issues.push({ type: 'LOW_VALUE_BLOCK' as any, detail: 'Response confirmed sub-minimum rental without upsell. Rewritten.', action: 'rewritten' });
    }
  }

  // --- 24. TIME WITHOUT LOCATION: Always pair time slots with pickup location ---
  if (/(10\s*am|10am|7\s*-?\s*9\s*pm|7pm|morning.{0,10}slot|evening.{0,10}slot)/i.test(text) &&
      !/(trafalgar|charing cross|pall mall|central london|meeting point|address|5BF|WC2N)/i.test(text)) {
    const acct = factPack?.rental?.account || account || 'dbcinema';
    const locationArea = acct === 'leo'
      ? 'near Charing Cross Road in Central London'
      : 'at Trafalgar Square, Central London';
    text = text.replace(/((?:10am[- ]?12pm|7[- ]?9pm)[^.?!]*?)([.?!])/i, '$1 ' + locationArea + '$2');
    issues.push({ type: 'TIME_WITHOUT_LOCATION' as any, detail: 'Injected pickup location with time slots.', action: 'rewritten' });
  }

  return {
    response: text,
    issues,
    modified: text !== response,
  };
}


// --- Chain-of-Thought Leak Detection ---

interface CotDetectionResult {
  stripped: boolean;
  cleanText: string;
  details: string[];
}

/**
 * Detect and strip chain-of-thought (CoT) reasoning that leaked into the response body.
 *
 * The AI model sometimes writes internal reasoning directly into its text output
 * instead of using the think tool or extended thinking blocks. This function catches
 * patterns like:
 * - Reasoning openers: "Wait. I need to", "Let me think", "Let me check"
 * - Inventory internals: "x3", "0 units available", "booked out to [Name]"
 * - Owner schedule leaks: "owner is unavailable", "manual approval"
 * - Decision planning: "I need to:", "So I should:", numbered reasoning steps
 * - Other renters' data: names followed by booking dates
 *
 * Strategy:
 * 1. Score each line for CoT markers
 * 2. If >50% of lines are CoT, the entire response is internal reasoning -> return fallback
 * 3. Otherwise, strip contiguous CoT blocks while preserving customer-facing text
 */
function detectAndStripChainOfThought(text: string): CotDetectionResult {
  const details: string[] = [];
  const lines = text.split('\n');

  // Patterns that strongly indicate internal reasoning (not customer-facing text)
  const cotPatterns: { pattern: RegExp; weight: number; label: string }[] = [
    // Reasoning openers -- the AI "talking to itself"
    { pattern: /^(Wait\.|Actually wait|Actually,? (?:wait|let me)|Hold on|Hmm|OK so|OK,? so|Alright,? so)/i, weight: 3, label: 'reasoning opener' },
    { pattern: /^(Let me (?:think|check|re-read|re-check|look|reason|consider|figure|work))/i, weight: 3, label: 'reasoning opener' },
    { pattern: /^(I need to (?:think|check|consider|figure|let|decline|tell|address))/i, weight: 3, label: 'internal planning' },
    { pattern: /^(So (?:I (?:need|should|can|cannot|must)|this|the|for|given))/i, weight: 2, label: 'reasoning continuation' },
    { pattern: /^(Given (?:it's|that|the|this))/i, weight: 2, label: 'reasoning premise' },

    // Inventory/stock internals -- NEVER shown to renters (stock secrecy rule)
    { pattern: /\b\d+\s*(?:units?|items?|sets?|pieces?)\s*(?:available|remaining|left|in stock|booked|out)\b/i, weight: 3, label: 'inventory count' },
    { pattern: /[×x]\s*\d+\b.*\b(?:available|booked|unavailable|in stock)\b/i, weight: 3, label: 'stock count' },
    { pattern: /\bALL\s+\d+\s+(?:are|were)\s+(?:booked|rented|out)\b/i, weight: 3, label: 'stock exhaustion' },
    { pattern: /\b(?:booked|rented)\s+(?:out\s+)?(?:to|by)\s+[A-Z][a-z]+\s+[A-Z]/i, weight: 3, label: 'renter name leak' },
    { pattern: /\b(?:inventory|stock)\s+(?:shows?|says?|indicates?|has|level)/i, weight: 2, label: 'inventory reference' },

    // Other renters' names + booking details
    { pattern: /\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:from|has|booked|rented|booking|rental)\b/, weight: 2, label: 'other renter reference' },
    { pattern: /\b(?:booked|reserved|rented)\s+(?:from\s+)?\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}\b/i, weight: 2, label: 'booking date range' },

    // Owner/scheduling internals
    { pattern: /\b(?:the\s+)?owner\s+is\s+(?:unavailable|away|busy|on vacation|not available)/i, weight: 3, label: 'owner schedule leak' },
    { pattern: /\bmanual\s+approval\b/i, weight: 2, label: 'internal process leak' },
    { pattern: /\bpending_review\b/i, weight: 3, label: 'internal status leak' },
    { pattern: /\bowner(?:'s)?\s+(?:schedule|availability|calendar)\b/i, weight: 2, label: 'owner schedule reference' },

    // Decision planning / numbered steps
    { pattern: /^\d+\.\s+(?:Tell|Let|Suggest|Decline|Address|Check|The |I (?:need|should|can|must))/i, weight: 2, label: 'planning step' },
    { pattern: /^(?:But|Also|And)\s+(?:wait|critically|importantly|the|I need)/i, weight: 2, label: 'reasoning transition' },

    // Self-referential reasoning
    { pattern: /\bwhat (?:lighting|items?|gear|alternatives?) do I have\b/i, weight: 3, label: 'self-query' },
    { pattern: /\bI (?:cannot|can't) fulfill\b/i, weight: 2, label: 'internal assessment' },
    { pattern: /\blet me re-read\b/i, weight: 3, label: 'self-correction' },
    { pattern: /\bI should suggest\b/i, weight: 2, label: 'internal planning' },
  ];

  // Score each line
  const lineScores: number[] = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return 0; // blank lines are neutral

    let score = 0;
    for (const { pattern, weight } of cotPatterns) {
      if (pattern.test(trimmed)) {
        score += weight;
      }
    }
    return score;
  });

  // Count how many non-empty lines scored as CoT
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);
  const cotLineCount = lineScores.filter(s => s >= 2).length;
  const cotRatio = nonEmptyLines.length > 0 ? cotLineCount / nonEmptyLines.length : 0;

  const FALLBACK = 'Thanks for your patience \u2014 let me get back to you on this shortly.';

  // CASE 1: Entire response is CoT (>50% of non-empty lines flagged)
  if (cotRatio > 0.5 && nonEmptyLines.length >= 3) {
    details.push(
      `Full CoT leak detected: ${cotLineCount}/${nonEmptyLines.length} lines (${Math.round(cotRatio * 100)}%) are internal reasoning. Entire response stripped.`
    );
    return {
      stripped: true,
      cleanText: FALLBACK,
      details,
    };
  }

  // CASE 2: Response starts with CoT but may have customer-facing text after
  const firstNonEmpty = findFirstNonEmptyIndex(lines);
  if (lineScores.length > 0 && firstNonEmpty >= 0 && lineScores[firstNonEmpty] >= 2) {
    // Response opens with CoT. Find where CoT ends.
    let cotEndIndex = firstNonEmpty;
    let inCotBlock = true;
    let blankLineRun = 0;

    for (let i = firstNonEmpty; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.length === 0) {
        blankLineRun++;
        continue;
      }

      if (inCotBlock) {
        if (lineScores[i] >= 2) {
          cotEndIndex = i;
          blankLineRun = 0;
        } else if (blankLineRun >= 1 && lineScores[i] === 0) {
          // Found a clean line after a blank gap -- CoT block ended
          inCotBlock = false;
        } else {
          cotEndIndex = i; // Ambiguous line within CoT block -- include it
          blankLineRun = 0;
        }
      }
    }

    if (inCotBlock) {
      // Entire response is CoT
      details.push('Full CoT leak: all lines are internal reasoning. Response replaced with safe fallback.');
      return {
        stripped: true,
        cleanText: FALLBACK,
        details,
      };
    }

    // Strip the leading CoT block, keep the customer-facing remainder
    const cleanLines = lines.slice(cotEndIndex + 1);
    const cleanText = cleanLines.join('\n').replace(/^\n+/, '').trim();

    if (cleanText.length > 30) {
      details.push(
        `Leading CoT block stripped (${cotEndIndex + 1} lines). Preserved ${cleanLines.length} lines of customer-facing text.`
      );
      return { stripped: true, cleanText, details };
    } else {
      details.push(`Leading CoT stripped but remainder too short (${cleanText.length} chars). Using fallback.`);
      return {
        stripped: true,
        cleanText: FALLBACK,
        details,
      };
    }
  }

  // CASE 3: Scattered CoT lines within an otherwise clean response
  if (cotLineCount > 0) {
    const cleanLines = lines.filter((_, i) => lineScores[i] < 3);
    const cleanText = cleanLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    if (cleanText !== text.trim() && cleanText.length > 30) {
      const removed = lines.length - cleanLines.length;
      details.push(`Stripped ${removed} scattered CoT line(s) from response.`);
      return { stripped: true, cleanText, details };
    }
  }


  return { stripped: false, cleanText: text, details };
}

/** Find index of first non-empty line */
function findFirstNonEmptyIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) return i;
  }
  return -1;
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
