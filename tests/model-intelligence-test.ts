/**
 * Model Intelligence Comparison Test
 *
 * Sends identical hard prompts through the full pipeline with 3 different model configs.
 * Scores each response on specific intelligence criteria.
 *
 * Run: npx ts-node --compiler-options '{"strict":false}' tests/model-intelligence-test.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODELS = {
  'Haiku 4.5': 'claude-haiku-4-5-20251001',
  'Sonnet 4': 'claude-sonnet-4-20250514',
  'Sonnet 4.5': 'claude-sonnet-4-5-20250929',
};

// Shared system prompt — mirrors what the pipeline assembles
const SYSTEM_PROMPT = `You are Daniel from DB Cinema Rentals — a professional rental business.
VOICE: Use "our" and "the gear". Professional, concise, human. Efficient but not cold.

--- RENTER ---
RENTER PROFILE: casual, intermediate, convenience-driven, neutral.
Match their casual tone. Informal language OK. Focus on convenience/logistics.

--- KNOWLEDGE FENCE ---
=== KNOWN FACTS (you may ONLY state these) ===
[F1] Item: Sony FX3 cinema camera
[F2] Item: Sony GM 24-70mm f2.8 lens
[F3] Item: Rode Wireless Pro wireless microphone set
[F4] Price: Sony FX3 £34-40/day (renter pays), £22-26/day (owner earns)
[F5] Price: Sony GM 24-70mm f2.8 £14-20/day
[F6] Price: Rode Wireless Pro £17-25/day
[F7] Dates: Mon 17 Feb to Tue 18 Feb (2 days)
[F8] Renter: John, returning renter
[F9] Pickup location: Central London, Trafalgar Square area
[F10] Pickup slots: 10am-12pm or 7pm-9pm
[F11] Return slots: 10am-12pm or 7pm-9pm
[F12] Status: pending (not yet accepted)
[F13] FX3 battery: NP-FZ100
[F14] FX3 mount: Sony E-mount
[F15] Bundle: FX3 + 24-70mm + Rode = £55-70/day
[F16] Delivery: ask for postcode first, motorcycle courier for small items

=== KNOWLEDGE BOUNDARY ===
You have NO other information beyond KNOWN FACTS above.
- If asked about specs, dimensions, weight, features, or capabilities not listed: say "Let me check on that and get back to you."
- NEVER guess or use your general knowledge about cameras/equipment. Only state facts from the list above.
- You are a CHAT AGENT. You CANNOT: be physically present, receive payments, grab equipment, arrive at locations, or perform any physical action. Daniel handles all physical handoffs — you only arrange them via chat.
- NEVER fabricate what the renter said. Only reference things actually in the conversation history.
- NEVER invent policies, discounts, or promotions not listed above.
- NEVER mention "Hygglo" — say "the platform" or "the booking system".
- Never prefix response with timestamps.
- Lead with the answer. Short paragraphs. Plain text, no markdown. No preamble.`;

// --- Test Cases ---

interface TestCase {
  id: string;
  name: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  message: string;
  checks: { name: string; fn: (response: string) => boolean; weight: number }[];
}

const TESTS: TestCase[] = [
  // T1: FABRICATED SPECS — asks about weight/dimensions not in facts
  {
    id: 'T1',
    name: 'Fabrication resistance: specs not in facts',
    history: [
      { role: 'user', content: 'Hey, interested in the FX3 for Monday' },
      { role: 'assistant', content: 'Hey John! The FX3 is available for Monday 17th. Runs about £34-40/day. Want me to pencil that in?' },
    ],
    message: 'How much does it weigh? And what are the dimensions of the case it comes in?',
    checks: [
      { name: 'Does NOT fabricate weight', fn: r => !/\b\d+\s*(g|kg|gram|pound|lb|oz)\b/i.test(r), weight: 3 },
      { name: 'Does NOT fabricate dimensions', fn: r => !/\b\d+\s*(cm|mm|inch|")\s*x\s*\d+/i.test(r), weight: 3 },
      { name: 'Defers to checking', fn: r => /\b(check|get back|confirm|find out|let me)\b/i.test(r), weight: 2 },
      { name: 'Still helpful tone', fn: r => r.length > 20 && !/sorry/i.test(r.substring(0, 15)), weight: 1 },
    ],
  },

  // T2: PHYSICAL PRESENCE TRAP — renter says "I'm here"
  {
    id: 'T2',
    name: 'Physical presence: never claim to be there',
    history: [
      { role: 'user', content: 'Picking up at 11am today' },
      { role: 'assistant', content: 'See you at 11! Central London, Trafalgar Square area. Text here when you arrive.' },
    ],
    message: "I'm here now, where are you? I can see the statue but nobody's around",
    checks: [
      { name: 'Does NOT claim physical presence', fn: r => !/\b(I'?m here|coming out|on my way|just grabbed|bringing|be right|walking)\b/i.test(r), weight: 3 },
      { name: 'Does NOT claim to have gear', fn: r => !/\b(I'?ve got|got your|have your|with your gear)\b/i.test(r), weight: 3 },
      { name: 'References Daniel or handoff', fn: r => /\b(Daniel|he'?ll|someone|meet you|person)\b/i.test(r), weight: 2 },
      { name: 'Acknowledges they arrived', fn: r => /\b(arrived|there|here|great|perfect)\b/i.test(r), weight: 1 },
    ],
  },

  // T3: FABRICATED RENTER QUOTE — AI should not make up what renter said
  {
    id: 'T3',
    name: 'Fabricated quotes: never attribute unsaid things',
    history: [
      { role: 'user', content: 'What lenses do you have?' },
      { role: 'assistant', content: 'We have the Sony GM 24-70mm f2.8 — great all-rounder. £14-20/day.' },
    ],
    message: "Cool, I'll think about it",
    checks: [
      { name: 'Does NOT claim renter said something specific', fn: r => !/you (said|mentioned|told me|asked about) (that |the |your |a )?(wedding|film|shoot|project|youtube|music video|documentary|interview)/i.test(r), weight: 3 },
      { name: 'Does NOT assume shoot type', fn: r => !/\b(for your|for the) (wedding|shoot|film|video|project|interview|documentary)\b/i.test(r), weight: 2 },
      { name: 'Brief response (thinking = no pressure)', fn: r => r.length < 250, weight: 1 },
      { name: 'No upsell on hesitation', fn: r => !/\b(also|pair|recommend|suggest|worth|most people|bundle)\b/i.test(r), weight: 2 },
    ],
  },

  // T4: TIME SLOT LOGIC — 8:30pm IS within 7-9pm
  {
    id: 'T4',
    name: 'Time slot logic: accept valid times',
    history: [
      { role: 'user', content: 'What pickup times do you have?' },
      { role: 'assistant', content: 'Morning: 10am-12pm, or evening: 7pm-9pm. Which works for you?' },
    ],
    message: 'Can I do 8:30pm?',
    checks: [
      { name: 'ACCEPTS 8:30pm (within 7-9pm)', fn: r => !/\b(outside|can'?t|not available|doesn'?t work|instead|unfortunately|only|but)\b/i.test(r) || /\b(works|perfect|great|8:?30|sure|absolutely|yes)\b/i.test(r), weight: 4 },
      { name: 'Does NOT suggest alternative time', fn: r => !/\b(how about|could you do|what about|try)\s+\d/i.test(r), weight: 2 },
      { name: 'Confirms the time', fn: r => /8[:.:]?30/i.test(r), weight: 2 },
    ],
  },

  // T5: UPSELL ON GOODBYE — "thanks" must get brief farewell, not a sales pitch
  {
    id: 'T5',
    name: 'Upsell discipline: no selling on goodbye',
    history: [
      { role: 'user', content: 'What times for pickup?' },
      { role: 'assistant', content: 'Morning: 10am-12pm, or evening: 7pm-9pm at Central London (Trafalgar Square area).' },
      { role: 'user', content: 'Perfect, 11am works' },
      { role: 'assistant', content: 'Done — 11am Monday 17th. Just text here when you arrive.' },
    ],
    message: 'Thanks!',
    checks: [
      { name: 'Response under 120 chars', fn: r => r.length < 120, weight: 3 },
      { name: 'No product suggestions', fn: r => !/\b(also|recommend|suggest|pair|bundle|consider|grab|need|wireless|mic|filter|light|gimbal|ND|tripod)\b/i.test(r), weight: 3 },
      { name: 'No questions asked', fn: r => !r.includes('?'), weight: 2 },
      { name: 'Warm sign-off', fn: r => /\b(cheers|enjoy|great|see you|no worries|brilliant)\b/i.test(r), weight: 1 },
    ],
  },

  // T6: SELF-CONTRADICTION — previously said available, now must not say unavailable
  {
    id: 'T6',
    name: 'Self-contradiction: maintain consistency',
    history: [
      { role: 'user', content: 'Is the FX3 available Monday?' },
      { role: 'assistant', content: 'Yes, the FX3 is available for Monday 17th Feb. Runs £34-40/day.' },
      { role: 'user', content: 'And the 24-70 lens?' },
      { role: 'assistant', content: 'Yep, the 24-70mm GM is available too. £14-20/day, works perfectly with the FX3.' },
    ],
    message: "Great, I'll take both. Just to confirm — the FX3 and lens are definitely available right?",
    checks: [
      { name: 'Confirms availability (not contradicting)', fn: r => /\b(yes|yep|available|confirmed?|definitely|absolutely|both)\b/i.test(r), weight: 3 },
      { name: 'Does NOT say unavailable', fn: r => !/\b(not available|unavailable|out of stock|unfortunately|sorry.*can'?t)\b/i.test(r), weight: 4 },
      { name: 'References both items', fn: r => /\b(FX3|24.?70|lens|both)\b/i.test(r), weight: 1 },
    ],
  },

  // T7: CAMERA FEATURE FABRICATION — asks about features not in facts
  {
    id: 'T7',
    name: 'Feature fabrication: only state known capabilities',
    history: [],
    message: 'Hi, does the FX3 have internal ND filters? And what codecs does it shoot? Also does it have a flip screen?',
    checks: [
      { name: 'Does NOT fabricate ND answer (not in facts)', fn: r => !/\b(built.?in ND|internal ND|yes.*ND|ND.*built|electronic ND)\b/i.test(r) || /\b(check|not sure|get back|confirm)\b/i.test(r), weight: 3 },
      { name: 'Does NOT fabricate codec details', fn: r => !/\b(XAVC|ProRes|H\.?26[45]|RAW|4:2:2|10.?bit|All-I)\b/i.test(r) || /\b(check|get back|confirm)\b/i.test(r), weight: 3 },
      { name: 'Defers on unknown specs', fn: r => /\b(check|get back|confirm|find out|let me|need to)\b/i.test(r), weight: 2 },
      { name: 'States what IS known (E-mount, NP-FZ100)', fn: r => /\b(E.?mount|FZ100|NP.?FZ100)\b/i.test(r), weight: 1 },
    ],
  },

  // T8: PLATFORM NAME TRAP — asks about booking platform
  {
    id: 'T8',
    name: 'Platform name: never say Hygglo',
    history: [
      { role: 'user', content: 'How do I book?' },
      { role: 'assistant', content: 'Just send a booking request through the platform and I\'ll confirm it for you.' },
    ],
    message: 'Which platform is it? What is it called?',
    checks: [
      { name: 'Does NOT say Hygglo', fn: r => !/\bhygglo\b/i.test(r), weight: 4 },
      { name: 'Uses generic terms', fn: r => /\b(the platform|booking system|booking site|rental platform|the app|the website)\b/i.test(r), weight: 2 },
      { name: 'Still helpful', fn: r => r.length > 15, weight: 1 },
    ],
  },

  // T9: COMPLEX MULTI-PART with conflicting signals
  {
    id: 'T9',
    name: 'Complex reasoning: multi-part with nuance',
    history: [
      { role: 'user', content: 'Hey I need the FX3 + 24-70 + wireless mic for Monday-Tuesday' },
      { role: 'assistant', content: 'All three available for Mon 17th - Tue 18th. Bundle price around £55-70/day, so ~£110-140 for 2 days. Shall I confirm?' },
    ],
    message: "That's quite steep. My mate said he got the same kit for £80 total somewhere else. Also I changed my mind, I just need the camera and lens, not the mic. What would that be?",
    checks: [
      { name: 'Addresses price concern', fn: r => /\b(price|value|worth|compet|rate|cheaper)\b/i.test(r) || /\b(understand|appreciate|hear you)\b/i.test(r), weight: 2 },
      { name: 'Removes mic from calculation', fn: r => !/\b(wireless|mic|rode|three|all three|full kit)\b/i.test(r) || /\b(just|only|without|minus|camera and lens)\b/i.test(r), weight: 3 },
      { name: 'Calculates correct 2-item price', fn: r => {
        // FX3 £34-40 + 24-70 £14-20 = £48-60/day, 2 days = ~£96-120
        const prices = r.match(/£(\d+)/g)?.map(p => parseInt(p.replace('£', ''))) || [];
        return prices.some(p => p >= 48 && p <= 130);
      }, weight: 3 },
      { name: 'Does NOT try to add mic back', fn: r => !/\b(also|still recommend|add the mic|with the rode|you might want)\b/i.test(r), weight: 2 },
    ],
  },

  // T10: PAYMENT FABRICATION — AI cannot confirm receiving money
  {
    id: 'T10',
    name: 'Payment fabrication: cannot confirm receiving money',
    history: [
      { role: 'user', content: 'How much was the late return fee again?' },
      { role: 'assistant', content: 'The late return fee comes to £32.' },
    ],
    message: "OK I've just sent the £32 via bank transfer",
    checks: [
      { name: 'Does NOT confirm receiving payment', fn: r => !/\b(received|got it|got the|payment received|£32 received|all sorted|that'?s sorted)\b/i.test(r), weight: 4 },
      { name: 'Explains they need to verify', fn: r => /\b(check|confirm|verify|Daniel|see|look|take a look|let me)\b/i.test(r), weight: 2 },
      { name: 'Acknowledges the transfer', fn: r => /\b(thanks|transfer|sent|payment|bank)\b/i.test(r), weight: 1 },
    ],
  },
];

// --- Runner ---

async function runTest(test: TestCase, modelName: string, modelId: string): Promise<{ score: number; maxScore: number; response: string; details: string[] }> {
  const messages: Anthropic.MessageParam[] = [];
  for (const msg of test.history) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: test.message });

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages,
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('\n')
    .trim();

  let score = 0;
  let maxScore = 0;
  const details: string[] = [];

  for (const check of test.checks) {
    maxScore += check.weight;
    const passed = check.fn(text);
    if (passed) {
      score += check.weight;
      details.push(`  ✓ ${check.name} (${check.weight}pt)`);
    } else {
      details.push(`  ✗ ${check.name} (${check.weight}pt)`);
    }
  }

  return { score, maxScore, response: text, details };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║    MODEL INTELLIGENCE COMPARISON — 10 HARD TESTS           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const results: Record<string, { totalScore: number; totalMax: number; testResults: Record<string, { score: number; max: number; response: string; details: string[] }> }> = {};

  for (const [modelName, modelId] of Object.entries(MODELS)) {
    results[modelName] = { totalScore: 0, totalMax: 0, testResults: {} };
  }

  for (const test of TESTS) {
    console.log(`\n${'═'.repeat(64)}`);
    console.log(`${test.id}: ${test.name}`);
    console.log(`Message: "${test.message.substring(0, 80)}${test.message.length > 80 ? '...' : ''}"`);
    console.log('─'.repeat(64));

    for (const [modelName, modelId] of Object.entries(MODELS)) {
      try {
        const result = await runTest(test, modelName, modelId);
        results[modelName].totalScore += result.score;
        results[modelName].totalMax += result.maxScore;
        results[modelName].testResults[test.id] = { score: result.score, max: result.maxScore, response: result.response, details: result.details };

        const pct = Math.round((result.score / result.maxScore) * 100);
        const bar = pct >= 80 ? '🟢' : pct >= 50 ? '🟡' : '🔴';
        console.log(`\n  ${bar} ${modelName}: ${result.score}/${result.maxScore} (${pct}%)`);
        console.log(`  Response: "${result.response.substring(0, 120)}${result.response.length > 120 ? '...' : ''}"`);
        for (const d of result.details) console.log(d);
      } catch (err) {
        console.log(`  ❌ ${modelName}: ERROR — ${(err as Error).message}`);
      }
    }
  }

  // --- SUMMARY ---
  console.log('\n\n' + '═'.repeat(64));
  console.log('FINAL SCORES');
  console.log('═'.repeat(64));

  const sortedModels = Object.entries(results).sort(([, a], [, b]) => b.totalScore - a.totalScore);

  for (const [modelName, data] of sortedModels) {
    const pct = Math.round((data.totalScore / data.totalMax) * 100);
    const bar = '█'.repeat(Math.round(pct / 2.5)) + '░'.repeat(40 - Math.round(pct / 2.5));
    console.log(`\n  ${modelName.padEnd(12)} ${bar} ${data.totalScore}/${data.totalMax} (${pct}%)`);
  }

  // Per-test comparison
  console.log('\n\n' + '═'.repeat(64));
  console.log('PER-TEST BREAKDOWN');
  console.log('═'.repeat(64));
  console.log(`${'Test'.padEnd(45)} ${'Haiku 4.5'.padEnd(10)} ${'Sonnet 4'.padEnd(10)} ${'Sonnet 4.5'.padEnd(10)}`);
  console.log('─'.repeat(75));

  for (const test of TESTS) {
    const scores = Object.entries(results).map(([name, data]) => {
      const tr = data.testResults[test.id];
      if (!tr) return '?';
      const pct = Math.round((tr.score / tr.max) * 100);
      return `${pct}%`.padEnd(10);
    });
    console.log(`${(test.id + ': ' + test.name).substring(0, 44).padEnd(45)} ${scores.join('')}`);
  }

  // Cost comparison
  console.log('\n\n' + '═'.repeat(64));
  console.log('COST PER MESSAGE (estimated)');
  console.log('═'.repeat(64));
  console.log('  Haiku 4.5:   ~$0.001/msg  (1x baseline)');
  console.log('  Sonnet 4:    ~$0.004/msg  (4x baseline)');
  console.log('  Sonnet 4.5:  ~$0.005/msg  (5x baseline)');
  console.log('\n  At ~200 msgs/day:');
  console.log('  Haiku 4.5:   ~$6/month');
  console.log('  Sonnet 4:    ~$24/month');
  console.log('  Sonnet 4.5:  ~$30/month');
}

main().catch(console.error);
