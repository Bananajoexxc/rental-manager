/**
 * Token Size A/B Test
 * Tests 3 realistic renter prompts at different max_tokens to find the ideal allocation.
 * Simulates full rental context (name, location, period, earnings, items).
 */
import Anthropic from '@anthropic-ai/sdk';
import * as dotenv from 'dotenv';
dotenv.config({ path: '/home/ubuntu/rental-manager/.env' });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL_HAIKU = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const MODEL_SONNET = process.env.CLAUDE_MODEL_COMPLEX || 'claude-sonnet-4-20250514';

// ── Simulated system prompt (mirrors the new authority-based architecture) ──
const SYSTEM_PROMPT = `You are replying AS Daniel from DB Cinema Rentals. Professional, concise, human tone.
But remember: you represent Daniel — you cannot make business decisions (pricing, discounts, freebies) on his behalf. When in doubt, escalate.

--- CURRENT DATE & TIME ---
Today: Friday 7 February 2026 (12:45 GMT)
Tomorrow: Saturday 8 February

--- BUSINESS RULES ---
- Pickup location: Central London (Trafalgar Square area). NEVER share exact address before booking confirmed.
- Pickup slots: 10am-12pm (preferred) or 7pm-9pm evening. Always offer 10am FIRST.
- Day-before evening pickup: FREE for larger orders (>£100), small fee for smaller.
- Return: suggest earliest possible slot. Morning-after return FREE for larger orders.
- Delivery: London only, max 30km. Motorcycle for small items, car for medium, van for large.
- Delivery estimate accuracy: within ~15%. Actual price confirmed by courier.
- Discounts for longer rentals applied automatically. NEVER reveal thresholds or percentages.
- V-mount batteries include plates, adapters, cables. Always mention both 95mAh and 150mAh options.
- BMPCC 6K Pro comes with 5x LP-E6NH batteries.

--- MASTER INVENTORY ---
Sony FX3, Sony FX6, Sony A7S III, Sony A7 IV, Blackmagic Pocket 6K Pro, Blackmagic Pocket 6K G2,
Sony GM 24-70mm f2.8, Sony GM 70-200mm f2.8, Sony GM 16-35mm f2.8, Sony 50mm f1.2 GM,
Canon EF 24-70mm f2.8, Canon EF 70-200mm f2.8, Sigma 18-35mm f1.8,
DJI RS3 Pro, DJI RS4 Pro, DJI Ronin 4D,
Atomos Ninja V, Hollyland Pyro 7,
Nanlite Forza 60C, Nanlite Forza 150, Aputure 600X Pro, Aputure LS 60x (2-light kit),
Sennheiser MKH 416, Rode NTG5, Rode Wireless PRO,
SmallRig Matte Box, Tilta Nucleus-M,
V-mount 95mAh battery, V-mount 150mAh battery,
PL mount adapter, CF Express Type A card (160GB),
Sony NP-FZ100 battery (set of 4), DJI Mic 2

--- RELEVANT MEMORIES ---
- Wedding shoots: always suggest audio (wireless lav), gimbal, extra batteries
- Interview setups: suggest 2-light kit + wireless audio + monitor
- Music videos: suggest gimbal + cinema lens + lights

--- ITEM COMPATIBILITY ---
Sony cameras (FX3, FX6, A7S III, A7 IV) = Sony E-mount lenses ONLY (GM 24-70, GM 70-200, GM 16-35, 50mm f1.2)
Blackmagic cameras (BMPCC 6K Pro, 6K G2) = Canon EF mount lenses ONLY (Canon EF 24-70, Canon EF 70-200)
These mounts are PHYSICALLY INCOMPATIBLE. Sony GM lenses do NOT fit BMPCC. Canon EF lenses do NOT fit Sony cameras.
BMPCC 6K Pro: 5x LP-E6NH batteries included, Canon EF mount, CFast 2.0 + SD cards
Sony FX3: 3x NP-FZ100 batteries included, Sony E-mount, CFexpress Type A + SD cards

--- YOUR AUTHORITY (READ THIS LAST — THIS OVERRIDES EVERYTHING ABOVE) ---
You REPRESENT Daniel's rental business. You are NOT Daniel. You do NOT have Daniel's authority to make business decisions.

THINGS YOU CAN DO (autonomously):
- Answer questions about items in MASTER_INVENTORY using ONLY facts provided to you
- Quote prices that appear in the booking/rental context above
- Suggest complementary gear based on the renter's stated project
- Confirm pickup at "Central London (Trafalgar Square area)" — no specific address until booking confirmed
- Offer 10am-12pm pickup FIRST, then 7pm-9pm as alternative
- Mention that longer rentals work out cheaper (without revealing thresholds)
- Say "we don't currently stock that" for items not in MASTER_INVENTORY
- Ask what the project is for if not mentioned

THINGS YOU MUST ESCALATE TO DANIEL (say "Let me check with Daniel and get back to you"):
- ANY price negotiation, discount request, or "too expensive" complaint
- ANY request for free items, compensation, or fee waiver
- Same-day rental approval
- Technical specs you don't have data for

THINGS YOU CANNOT DO (hard constraints — violation = system block):
- Fabricate facts: NO made-up specs, runtimes, distances, prices, or item names
- Break lens mount physics: Sony cameras = Sony E-mount ONLY. Blackmagic = Canon EF ONLY. These are physically incompatible.
- Mention platform fees, service fees, Hygglo, or any platform name — not even to deny them
- Share specific address/postcode before booking confirmed
- Reveal items are centralised or that listing locations are approximate
- Reveal discount thresholds, percentages, or qualification criteria
- Use markdown formatting (bold, bullets, headers) — plain text only, like texting
- Add signatures, sign-offs, or "Cheers, Daniel" — just end naturally
- Downsell: never say renter has "enough" or "doesn't need" something
- Offer distance discount for Central London postcodes (SE1, SW1, WC2, EC1, N1, W1, E1) — only for genuinely non-central listing redirects`;

// ── 3 test scenarios with full rental context ──
interface TestScenario {
  name: string;
  rentalContext: string;
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
  renterMessage: string;
  expectedBehaviors: string[];
}

const scenarios: TestScenario[] = [
  {
    name: '1. Simple pricing inquiry (new renter)',
    rentalContext: [
      '--- ACTIVE IDENTITY (OVERRIDE ALL ABOVE) ---',
      'Current rental: Sony FX3 Cinema Camera',
      'Status: pending_review',
      'Renter: James Cooper',
      'Dates: Mon 10 Feb to Thu 13 Feb (3 days)',
      'Renter pays: £285 total',
      'Your profit: £182 (after platform fees)',
      'Price per day: £95/day',
      'Account: DB Cinema Rentals',
      'LISTING_LOCATION: Shoreditch, London',
    ].join('\n'),
    conversationHistory: [],
    renterMessage: 'Hi, how much would it be for the FX3 for 3 days? And do you have any lenses to go with it?',
    expectedBehaviors: [
      'Should quote £285 or ~£95/day from rental context',
      'Should suggest GM lenses (24-70mm, 70-200mm, etc.)',
      'Should ask what the project is for',
      'Should NOT mention Hygglo or platform fees',
      'Should offer pickup at Trafalgar Square area',
    ],
  },
  {
    name: '2. Complex multi-item + delivery (mid-conversation)',
    rentalContext: [
      '--- ACTIVE IDENTITY (OVERRIDE ALL ABOVE) ---',
      'Current rental: Blackmagic Pocket 6K Pro Bundle',
      'Status: confirmed',
      'Renter: Sarah Mitchell',
      'Dates: Sat 15 Feb to Mon 17 Feb (2 days)',
      'Renter pays: £420 total',
      'Your profit: £269 (after platform fees)',
      'Account: DB Cinema Rentals',
      'LISTING_LOCATION: Camden, London',
      '',
      '--- TIMES STATUS ---',
      'Pickup/return times: NOT YET CONFIRMED',
      'ACTION NEEDED: Ask renter for preferred pickup and return times.',
    ].join('\n'),
    conversationHistory: [
      { role: 'user', content: 'Hi, I\'ve booked the BMPCC 6K Pro for a wedding shoot this weekend. Really excited!' },
      { role: 'assistant', content: 'Great choice for a wedding! The Pocket 6K Pro is brilliant for that cinematic look. Just to make sure you\'re fully kitted out — are you sorted for lenses, audio, and lighting? Weddings can be unpredictable so it\'s always good to have backup options. What time is the ceremony?' },
      { role: 'user', content: 'Ceremony is at 2pm on Saturday. I\'ve got my own Sigma 18-35mm but thinking I might need a longer lens for the ceremony. Also worried about audio for the vows.' },
      { role: 'assistant', content: 'For the ceremony at 2pm, a 70-200mm would be perfect — lets you get those tight emotional shots from the back without being intrusive. For audio, the Rode Wireless PRO would be ideal — clip one transmitter on the groom and you\'ll capture crystal clear vows. Want me to add those to your booking? And shall we sort out pickup times? I\'d suggest Friday evening so you have time to prep.' },
    ],
    renterMessage: 'Yes please add the 70-200mm and the Rode Wireless. Actually can you deliver to SE1 9SG? Also what batteries does the BMPCC come with and how long do they last?',
    expectedBehaviors: [
      'Should confirm adding Canon EF 70-200mm (NOT Sony GM — BMPCC uses EF mount)',
      'Should mention BMPCC comes with 5x LP-E6NH batteries',
      'Should calculate delivery quote for SE1 postcode',
      'Should mention courier type needed',
      'Should ask for pickup/return times (TIMES NOT CONFIRMED)',
      'Should NOT downsell or say "you\'re all set"',
    ],
  },
  {
    name: '3. Complaint + negotiation (frustrated renter)',
    rentalContext: [
      '--- ACTIVE IDENTITY (OVERRIDE ALL ABOVE) ---',
      'Current rental: Sony FX6 Cinema Camera + GM 24-70mm Bundle',
      'Status: confirmed',
      'Renter: Mark Thompson',
      'Dates: Wed 12 Feb to Fri 14 Feb (2 days)',
      'Renter pays: £580 total',
      'Your profit: £371 (after platform fees)',
      'Account: DB Cinema Rentals',
    ].join('\n'),
    conversationHistory: [
      { role: 'user', content: 'Hi I booked the FX6 bundle for a corporate interview shoot on Wednesday.' },
      { role: 'assistant', content: 'Perfect, the FX6 with the 24-70mm GM is a great interview setup. Are you sorted for audio and lighting? For interviews I\'d strongly recommend the Rode Wireless PRO for clean dialogue and the Aputure LS 60x 2-light kit for a professional look. When would you like to pick up — Tuesday evening or Wednesday morning?' },
      { role: 'user', content: 'Tuesday evening works. I\'ll grab the wireless mic too. But I just checked and the pickup location says Shoreditch? I booked it because it said Waterloo on the listing.' },
      { role: 'assistant', content: 'Sorry about that — the Waterloo unit is actually out on a rental at the moment so we\'ve moved pickup to our Central London hub near Trafalgar Square. It\'s actually more central! And because of the change, you\'ll get a 10% distance discount automatically applied. Would that work, or would you prefer delivery?' },
    ],
    renterMessage: 'That\'s really frustrating, I specifically chose this because of the Waterloo location. Trafalgar Square is too far for me. And honestly £580 for 2 days feels steep — I saw similar kits for cheaper elsewhere. Can you do anything on the price?',
    expectedBehaviors: [
      'Should be empathetic and apologetic (complaint handling)',
      'Should offer delivery as solution',
      'Should NOT reveal discount thresholds',
      'Should NOT negotiate price (escalate to Daniel)',
      'Should mention the 10% distance discount already applies',
      'Should NOT say "I understand" robotically — be genuine',
    ],
  },
];

// ── Token sizes to test (just final allocation) ──
const TOKEN_SIZES = [500];

async function runTest(scenario: TestScenario, maxTokens: number, model: string): Promise<{
  response: string;
  inputTokens: number;
  outputTokens: number;
  truncated: boolean;
}> {
  const messages: Anthropic.MessageParam[] = [];

  // Add conversation history
  for (const msg of scenario.conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Build user message — concise operational context only (authority is in system prompt)
  const userMessage =
    `A renter sent a message on the DB Cinema Rentals account. Draft a reply.\n\n` +
    `Renter: ${scenario.renterMessage.match(/Renter: (.+)/)?.[1] || 'Unknown'}\n` +
    `Their message: "${scenario.renterMessage}"\n\n` +
    `HOW TO RESPOND:\n` +
    `- Lead with the answer. Short paragraphs. Plain text, no markdown.\n` +
    `- If renter hasn't said what the shoot is for, ask.\n` +
    `- When quoting items, mention included accessories.\n` +
    `- BMPCC 6K Pro/G2: comes with 5x LP-E6NH batteries.\n` +
    `Start your response with the exact reply text (no preamble).`;

  messages.push({ role: 'user', content: userMessage });

  const systemPromptWithContext = SYSTEM_PROMPT + '\n\n' + scenario.rentalContext;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPromptWithContext, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as Anthropic.TextBlock).text)
    .join('\n');

  return {
    response: text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    truncated: response.stop_reason === 'max_tokens',
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TOKEN SIZE A/B TEST — Finding Ideal Allocation');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const scenario of scenarios) {
    console.log(`\n${'━'.repeat(70)}`);
    console.log(`📋 ${scenario.name}`);
    console.log(`💬 Renter: "${scenario.renterMessage.substring(0, 80)}..."`);
    console.log(`✅ Expected: ${scenario.expectedBehaviors.join(' | ')}`);
    console.log(`${'━'.repeat(70)}`);

    for (const tokens of TOKEN_SIZES) {
      try {
        const result = await runTest(scenario, tokens, MODEL_HAIKU);
        const wordCount = result.response.split(/\s+/).length;
        const charCount = result.response.length;

        console.log(`\n  ┌─ 💨 HAIKU @ ${tokens} tokens ─────────────────────────`);
        console.log(`  │ In: ${result.inputTokens} tokens | Out: ${result.outputTokens}/${tokens} tokens | Words: ${wordCount} | Chars: ${charCount}`);
        console.log(`  │ Truncated: ${result.truncated ? '⚠️  YES — RESPONSE CUT OFF' : '✅ No'}`);
        console.log(`  │`);
        // Show response with word wrap
        const lines = result.response.split('\n');
        for (const line of lines) {
          // Wrap long lines at 90 chars
          const wrapped = line.match(/.{1,90}(\s|$)/g) || [line];
          for (const w of wrapped) {
            console.log(`  │ ${w.trimEnd()}`);
          }
        }
        console.log(`  └${'─'.repeat(55)}`);
      } catch (err: any) {
        console.log(`  ❌ HAIKU @ ${tokens}: ${err.message}`);
      }
    }

    // Also test Sonnet at 700 for comparison
    try {
      const sonnetResult = await runTest(scenario, 700, MODEL_SONNET);
      const wordCount = sonnetResult.response.split(/\s+/).length;
      console.log(`\n  ┌─ 🧠 SONNET @ 700 tokens (reference) ─────────────────`);
      console.log(`  │ In: ${sonnetResult.inputTokens} | Out: ${sonnetResult.outputTokens}/700 | Words: ${wordCount}`);
      console.log(`  │ Truncated: ${sonnetResult.truncated ? '⚠️  YES' : '✅ No'}`);
      console.log(`  │`);
      const lines = sonnetResult.response.split('\n');
      for (const line of lines) {
        const wrapped = line.match(/.{1,90}(\s|$)/g) || [line];
        for (const w of wrapped) {
          console.log(`  │ ${w.trimEnd()}`);
        }
      }
      console.log(`  └${'─'.repeat(55)}`);
    } catch (err: any) {
      console.log(`  ❌ SONNET @ 700: ${err.message}`);
    }
  }

  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('  ANALYSIS COMPLETE');
  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
