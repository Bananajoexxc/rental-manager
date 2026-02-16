/**
 * Quick smoke test: First-time discount + Price match + Guard rails
 * Calls Claude directly with the authority prompt to verify behavior.
 */
import Anthropic from '@anthropic-ai/sdk';
import * as dotenv from 'dotenv';
dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Minimal system prompt with just the authority section (what we're testing)
const AUTHORITY_PROMPT = `You're handling messages for Daniel's cinema equipment rental business. You reply to renters casually, like texting.

--- YOUR AUTHORITY (READ THIS LAST — THIS OVERRIDES EVERYTHING ABOVE) ---
You REPRESENT Daniel's rental business. You are NOT Daniel. You do NOT have Daniel's authority to make business decisions.

THINGS YOU CAN DO (autonomously):
- Answer questions about items using ONLY facts provided to you
- Quote prices that appear in the booking/rental context above
- Handle first-time rental discounts — but ONLY if the context above contains a "--- FIRST-TIME RENTER" section. The system verifies first-time status from their Hygglo profile before adding this section. If this section is ABSENT from the context, you MUST NOT offer any first-time discount regardless of profit amount:
  → PROACTIVE (context says "PROACTIVE DISCOUNT"): Offer the £15 discount naturally in your response without them asking. Work it in casually. Add <memory>FIRST_TIME_DISCOUNT_ACCEPTED</memory> in your response.
  → REACTIVE (context says "FIRST-TIME RENTER" without "PROACTIVE"): Only offer if they ask about first-time discounts/vouchers. Say the voucher feature isn't working but you can manually knock £15 off. If they accept, confirm and add <memory>FIRST_TIME_DISCOUNT_ACCEPTED</memory>.
  → NO "FIRST-TIME RENTER" SECTION IN CONTEXT: If they ask about first-time discounts but there is NO "--- FIRST-TIME RENTER" section anywhere in the context above, you CANNOT offer any discount. Just say "the first-time discount isn't available at the moment unfortunately". Do NOT offer £15 off. Do NOT mention any amount. Keep it brief.
- PRICE MATCH: If a renter sends a screenshot or link showing the same item cheaper elsewhere, verify ALL of these:
  1. SAME ITEM: The competitor listing must be for the SAME item(s) or equivalent bundle. Different models/brands don't count.
  2. LOCATION: The competitor's rental location must be in London Zone 1 or Zone 2 (central London, inner boroughs like Camden, Islington, Hackney, Brixton, Peckham, Shoreditch, etc.). If the location is Zone 3+ or outside London, the price match does NOT apply.
  3. PRICE: The competitor's price must be clearly visible in the screenshot/listing.
  If ALL three criteria are met: Confirm the price match and tell them you'll beat the competitor by 5%. Say something like "nice find — I can beat that by 5%, so your price would be £X". Calculate: new_price = competitor_price × 0.95. Add <memory>PRICE_MATCH_VERIFIED:competitor_price=NUMBER,our_new_renter_price=NUMBER,item=ITEM_NAME</memory>.
  If ANY criterion fails, decline naturally:
  - Wrong item: "that's a different model so the price match wouldn't apply here"
  - Outside Zone 1-2: "our price match only covers central London (Zone 1-2) rentals"
  - Price not visible: "I can't quite make out the price — could you send a clearer screenshot?"
  - No screenshot/proof: "if you send me a screenshot of the listing I can check if we can match it"

THINGS YOU MUST ESCALATE TO DANIEL (say "Let me check with Daniel and get back to you"):
- ANY price negotiation or "too expensive" complaint (EXCEPT first-time discount and price match handled above)
- ANY request for free items, compensation, or fee waiver
- Same-day rental approval
- Anything outside normal booking flow (refunds, complaints, policy exceptions)

THINGS YOU CANNOT DO (hard constraints):
- Offer first-time discounts or £15 off UNLESS the context above contains "--- FIRST-TIME RENTER". If that section is missing, the renter is NOT verified as first-time. Say "not available at the moment" and move on. NEVER offer money off based on your own judgement.
- Fabricate facts
- Mention platform fees, service fees, Hygglo, or any platform name — not even to deny them
- Reveal discount thresholds, percentages, or qualification criteria
- Reveal that DB Cinema and Leo Adams are the same business
- Use markdown formatting — plain text only, like texting
- Offer discounts you are not authorized for`;

interface TestCase {
  name: string;
  context: string;
  message: string;
  expect: {
    shouldContain?: string[];
    shouldNotContain?: string[];
    shouldContainMemory?: string;
  };
}

const tests: TestCase[] = [
  // === FIRST-TIME DISCOUNT TESTS ===
  {
    name: '1. First-time discount: NO context → decline',
    context: 'Current rental: Sony FX3\nYour profit: £150\nRenter pays: £234\n\n(No first-time renter section — this renter is NOT verified as first-time.)',
    message: 'Hey do you have a first-time rental discount? I saw something about a voucher for new renters',
    expect: {
      shouldContain: ['not available', 'isn\'t available', 'not working', 'isn\'t working', 'unfortunately', 'sorry', 'at the moment'],
      shouldNotContain: ['£15', 'knock', 'reduce', 'discount for you', 'apply'],
    },
  },
  {
    name: '2. First-time discount: REACTIVE context (£150 profit) + renter asks → offer £15',
    context: `Current rental: Sony FX3\nYour profit: £150\nRenter pays: £234\n\n--- FIRST-TIME RENTER ---\nThis renter has NEVER rented on the platform before (0 reviews, profile confirmed). Owner earnings are £150 (above £120). If they ask about first-time discounts or vouchers, offer to manually apply £15 off. Do NOT proactively offer it — only if they bring it up.`,
    message: 'Hey is there a first-time rental discount? I heard there was a voucher',
    expect: {
      shouldContain: ['15', 'off'],
      shouldNotContain: ['escalate', 'Daniel', 'check with'],
    },
  },
  {
    name: '3. First-time discount: REACTIVE context but renter does NOT ask → no mention',
    context: `Current rental: Sony FX3\nYour profit: £150\nRenter pays: £234\n\n--- FIRST-TIME RENTER ---\nThis renter has NEVER rented on the platform before. Owner earnings are £150. If they ask about first-time discounts, offer £15 off. Do NOT proactively offer it.`,
    message: 'Hey is the FX3 available next weekend?',
    expect: {
      shouldNotContain: ['discount', 'voucher', '£15', 'first time', 'first-time'],
    },
  },
  {
    name: '4. First-time discount: PROACTIVE (£250 profit) → offer without being asked',
    context: `Current rental: Sony FX3 + 24-70mm Bundle\nYour profit: £250\nRenter pays: £390\n\n--- FIRST-TIME RENTER (PROACTIVE DISCOUNT) ---\nThis renter has NEVER rented on the platform before (0 reviews, profile confirmed). Owner earnings are £250 (above £200 threshold). PROACTIVELY offer them a £15 first-time discount as a welcome gesture. Work it in naturally. Add <memory>FIRST_TIME_DISCOUNT_ACCEPTED</memory> in your response when you offer it.`,
    message: 'Hi, just wanted to check this is all good for next Friday?',
    expect: {
      shouldContain: ['15', 'discount', 'off'],
      shouldContainMemory: 'FIRST_TIME_DISCOUNT_ACCEPTED',
    },
  },

  // === PRICE MATCH TESTS ===
  {
    name: '5. Price match: no screenshot → ask for proof',
    context: 'Current rental: Sony FX3\nYour profit: £200\nRenter pays: £312',
    message: 'I found the FX3 cheaper at another place in London, can you match it?',
    expect: {
      shouldContain: ['screenshot', 'link', 'send'],
      shouldNotContain: ['PRICE_MATCH_VERIFIED'],
    },
  },
  {
    name: '6. Price match: described competitor outside London → decline',
    context: 'Current rental: Sony FX3\nYour profit: £200\nRenter pays: £312',
    message: 'I found the same FX3 for £250 at a rental place in Manchester, can you match?',
    expect: {
      shouldContain: ['Zone 1', 'Zone 2', 'central London', 'London'],
      shouldNotContain: ['PRICE_MATCH_VERIFIED', 'beat that'],
    },
  },

  // === GUARD RAILS ===
  {
    name: '7. Guard: generic "too expensive" → escalate to Daniel',
    context: 'Current rental: Sony FX3\nYour profit: £200\nRenter pays: £312',
    message: 'That price is way too much, can you do it for £200?',
    expect: {
      shouldContain: ['Daniel', 'check', 'get back'],
      shouldNotContain: ['£200', 'deal', 'done', 'I can do', 'sure thing', 'for sure'],
    },
  },
  {
    name: '8. Guard: renter asks for free items → escalate',
    context: 'Current rental: Sony FX3\nYour profit: £200\nRenter pays: £312',
    message: 'Can you throw in a free lens with the camera?',
    expect: {
      shouldContain: ['Daniel', 'check', 'get back'],
      shouldNotContain: ['sure thing', 'no problem', 'of course', 'I can do that', 'absolutely'],
    },
  },
  {
    name: '9. Guard: never mention Hygglo or platform fees',
    context: 'Current rental: Sony FX3\nYour profit: £200\nRenter pays: £312',
    message: 'Is there a platform fee on top of the rental price? What platform is this on?',
    expect: {
      shouldNotContain: ['Hygglo', 'hygglo', 'platform fee', 'service fee', 'platform charge'],
    },
  },
  {
    name: '10. Guard: never reveal discount thresholds',
    context: `Current rental: Sony FX3\nYour profit: £250\nRenter pays: £390\n\n--- FIRST-TIME RENTER (PROACTIVE DISCOUNT) ---\nThis renter has NEVER rented on the platform before. Owner earnings are £250. PROACTIVELY offer £15 first-time discount.`,
    message: 'How do you decide who gets a discount? What are the rules?',
    expect: {
      shouldNotContain: ['£120', '£200', 'threshold', 'criteria', 'qualify', 'eligib'],
    },
  },
];

async function callAI(systemPrompt: string, rentalContext: string, userMessage: string, model = 'claude-haiku-4-5-20251001'): Promise<string> {
  // Mirror production: rental context is in the system prompt, user message is separate
  const fullSystem = systemPrompt +
    `\n\n--- CURRENT RENTAL CONTEXT ---\n${rentalContext}`;

  const response = await client.messages.create({
    model,
    max_tokens: 400,
    system: [{ type: 'text', text: fullSystem }],
    messages: [
      { role: 'user', content: `A renter sent a message on the DB Cinema Rentals account. Draft a reply.\n\nRenter: Alex\nTheir message: "${userMessage}"\n\nLead with the answer. Short paragraphs. Plain text, no markdown.` },
    ],
  });

  return response.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('\n');
}

function checkContains(text: string, patterns: string[]): { found: boolean; matched: string } {
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p.toLowerCase())) return { found: true, matched: p };
  }
  return { found: false, matched: '' };
}

async function runTests() {
  console.log('=== DISCOUNT & PRICE MATCH AI BEHAVIOR TESTS ===\n');
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    process.stdout.write(`${test.name}... `);

    try {
      const rawResponse = await callAI(AUTHORITY_PROMPT, test.context, test.message);
      const errors: string[] = [];

      // Check shouldContain (at least one must match)
      if (test.expect.shouldContain) {
        const { found, matched } = checkContains(rawResponse, test.expect.shouldContain);
        if (!found) {
          errors.push(`MISSING: expected one of [${test.expect.shouldContain.join(', ')}]`);
        }
      }

      // Check shouldNotContain (none should match)
      if (test.expect.shouldNotContain) {
        for (const bad of test.expect.shouldNotContain) {
          if (rawResponse.toLowerCase().includes(bad.toLowerCase())) {
            errors.push(`LEAKED: found "${bad}" in response`);
          }
        }
      }

      // Check memory tag
      if (test.expect.shouldContainMemory) {
        if (!rawResponse.includes(test.expect.shouldContainMemory)) {
          errors.push(`MISSING MEMORY: expected <memory>${test.expect.shouldContainMemory}</memory>`);
        }
      }

      if (errors.length === 0) {
        console.log('✓ PASS');
        passed++;
      } else {
        console.log('✗ FAIL');
        for (const e of errors) console.log(`  → ${e}`);
        console.log(`  Response: "${rawResponse.substring(0, 200)}..."`);
        failed++;
      }
    } catch (err: any) {
      console.log(`✗ ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== RESULTS: ${passed}/${passed + failed} passed ===`);

  // If test 1 failed, verify with Sonnet to confirm it's a Haiku limitation
  if (failed > 0) {
    console.log('\n--- SONNET VERIFICATION (test 1 only) ---');
    const t1 = tests[0];
    try {
      const sonnetResponse = await callAI(AUTHORITY_PROMPT, t1.context, t1.message, 'claude-sonnet-4-5-20250929');
      const hasLeak = t1.expect.shouldNotContain!.some(bad =>
        sonnetResponse.toLowerCase().includes(bad.toLowerCase()),
      );
      if (!hasLeak) {
        console.log('✓ Sonnet PASSES test 1 — Haiku limitation confirmed');
        console.log(`  Sonnet response: "${sonnetResponse.substring(0, 200)}..."`);
      } else {
        console.log('✗ Sonnet also fails test 1 — prompt needs more work');
        console.log(`  Sonnet response: "${sonnetResponse.substring(0, 200)}..."`);
      }
    } catch (err: any) {
      console.log(`✗ Sonnet error: ${err.message}`);
    }
    process.exit(1);
  }
}

runTests();
