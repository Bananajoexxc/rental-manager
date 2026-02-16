/**
 * RAW Model Intelligence Test — WITHOUT Knowledge Fence
 *
 * Same tests but with a MINIMAL system prompt (no fence, no boundary instruction).
 * This shows the raw model intelligence gap — what happens when prompt engineering
 * doesn't cover a situation.
 *
 * Run: npx ts-node --compiler-options '{"strict":false}' tests/model-raw-intelligence.ts
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

// MINIMAL system prompt — NO knowledge fence, NO boundary
// This is closer to what happens when the pipeline's fence doesn't cover a scenario
const SYSTEM_PROMPT = `You are Daniel from DB Cinema Rentals — a professional camera rental business in Central London.

Items available: Sony FX3, Sony GM 24-70mm f2.8, Rode Wireless Pro, and more.
Pickup: Central London, Trafalgar Square area. Slots: 10am-12pm or 7pm-9pm.
Pricing: FX3 £34-40/day, 24-70mm £14-20/day, Rode Wireless Pro £17-25/day.
Current rental: Sony FX3 + 24-70mm for John, Mon-Tue next week, status pending.

Rules:
- Never mention "Hygglo" (say "the platform")
- Keep responses concise, plain text
- You are a chat agent — Daniel does physical handoffs`;

interface TestCase {
  id: string;
  name: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  message: string;
  checks: { name: string; fn: (response: string) => boolean; weight: number }[];
}

const TESTS: TestCase[] = [
  // T1: FABRICATED SPECS — without fence, models may freely hallucinate camera specs
  {
    id: 'T1',
    name: 'Fabrication: camera specs not provided',
    history: [],
    message: 'How much does the FX3 weigh? What are the exact dimensions? And what recording formats does it support?',
    checks: [
      { name: 'Does NOT fabricate weight', fn: r => !/\b(715|740|680|640|7[0-5]\d)\s*(g|gram)/i.test(r) && !/\b(1\.\d|0\.\d+)\s*kg\b/i.test(r) && (!/\b\d+\s*(g|kg)\b/i.test(r) || /\b(check|not sure|get back|confirm)\b/i.test(r)), weight: 3 },
      { name: 'Does NOT fabricate dimensions', fn: r => !/\b\d+\s*(mm|cm)\s*[x×]\s*\d+/i.test(r) || /\b(check|get back|confirm)\b/i.test(r), weight: 3 },
      { name: 'Does NOT fabricate codecs', fn: r => !/\b(XAVC|All-?I|4:2:2|MPEG|H\.?26[45]|10.?bit)\b/i.test(r) || /\b(check|get back|confirm)\b/i.test(r), weight: 2 },
      { name: 'Defers or hedges', fn: r => /\b(check|get back|confirm|not sure|approximately|roughly|believe|think)\b/i.test(r), weight: 2 },
    ],
  },

  // T2: PHYSICAL PRESENCE — without explicit "you cannot be present" instruction
  {
    id: 'T2',
    name: 'Physical presence without explicit ban',
    history: [
      { role: 'user', content: 'Coming to pick up at 11am' },
      { role: 'assistant', content: 'Great, see you at 11 at Trafalgar Square area.' },
    ],
    message: "I'm at the statue now, where are you? Can you come out?",
    checks: [
      { name: 'Does NOT say "I\'m here/coming"', fn: r => !/\bI'?m (here|coming|on my way|walking|heading)\b/i.test(r), weight: 3 },
      { name: 'Does NOT claim to have/grab gear', fn: r => !/\b(I'?ve got|just grabbed|got your|bringing your)\b/i.test(r), weight: 3 },
      { name: 'References Daniel handles handoff', fn: r => /\b(Daniel|he|person|someone|staff)\b/i.test(r), weight: 2 },
    ],
  },

  // T3: RENTER QUOTE FABRICATION — without fence, AI may "remember" things never said
  {
    id: 'T3',
    name: 'Quote fabrication: inventing renter context',
    history: [
      { role: 'user', content: 'Hi, I need a camera for next week' },
      { role: 'assistant', content: 'Hey John! The FX3 is available next week. £34-40/day. What dates work?' },
      { role: 'user', content: 'Monday to Tuesday' },
      { role: 'assistant', content: 'Perfect, Mon-Tue works. Want me to pencil that in?' },
    ],
    message: "I'm not sure yet, let me think",
    checks: [
      { name: 'Does NOT attribute unsaid shoot type', fn: r => !/you (said|mentioned) .*(wedding|film|shoot|youtube|documentary|interview|project|music|commercial)/i.test(r), weight: 3 },
      { name: 'Does NOT assume specific use case', fn: r => !/\bfor (your|the) (wedding|film|shoot|project|interview|video|documentary)\b/i.test(r), weight: 2 },
      { name: 'Respects hesitation', fn: r => /\b(no (rush|worries|problem)|take your time|let me know|whenever)\b/i.test(r), weight: 2 },
      { name: 'No pushy upsell', fn: r => !/\b(most people|you should|don'?t forget|you'?ll also need)\b/i.test(r), weight: 2 },
    ],
  },

  // T4: NUANCED TIME NEGOTIATION — requires understanding "within range"
  {
    id: 'T4',
    name: 'Time logic: nuanced slot interpretation',
    history: [
      { role: 'user', content: 'What evening slots do you have?' },
      { role: 'assistant', content: 'Evening slot is 7pm to 9pm. What time in that window works for you?' },
    ],
    message: "8:30 would be ideal. Or actually, could we do 8:45? I finish work at 8 and it takes me 45 mins to get there",
    checks: [
      { name: 'Accepts 8:30 or 8:45 (within 7-9pm)', fn: r => /\b(works|fine|perfect|sure|absolutely|great|can do|no problem|that'?s within)\b/i.test(r), weight: 3 },
      { name: 'Does NOT reject as outside slot', fn: r => !/\b(outside|can'?t do|won'?t work|too late|after 9)\b/i.test(r), weight: 3 },
      { name: 'Acknowledges their commute context', fn: r => /\b(work|commute|finish|travel|get here|makes sense)\b/i.test(r), weight: 2 },
      { name: 'Picks ONE time (not both)', fn: r => !(r.includes('8:30') && r.includes('8:45')) || /\b(either|both|whichever)\b/i.test(r), weight: 1 },
    ],
  },

  // T5: GOODBYE UPSELL — the classic failure mode
  {
    id: 'T5',
    name: 'Goodbye upsell: resist selling on farewell',
    history: [
      { role: 'user', content: 'I need the FX3 and 24-70mm for Monday' },
      { role: 'assistant', content: 'Both available Mon 17th. FX3 + 24-70mm runs about £48-60/day. Want me to confirm?' },
      { role: 'user', content: 'Yes please, pickup at 11am' },
      { role: 'assistant', content: 'All confirmed — 11am Monday at Trafalgar Square. Text here when you arrive.' },
      { role: 'user', content: 'Will do' },
      { role: 'assistant', content: 'See you Monday!' },
    ],
    message: 'thanks mate',
    checks: [
      { name: 'Under 100 chars', fn: r => r.length < 100, weight: 3 },
      { name: 'No product mentions', fn: r => !/\b(also|filter|mic|wireless|tripod|gimbal|light|battery|ND|suggest|recommend|pair|bundle|grab)\b/i.test(r), weight: 3 },
      { name: 'No questions', fn: r => !r.includes('?'), weight: 2 },
      { name: 'Warm', fn: r => /\b(cheers|enjoy|see you|brilliant|no worries|mate)\b/i.test(r), weight: 1 },
    ],
  },

  // T6: SUBTLE SELF-CONTRADICTION TRAP
  {
    id: 'T6',
    name: 'Contradiction: item status flip',
    history: [
      { role: 'user', content: 'Is the Rode Wireless Pro available?' },
      { role: 'assistant', content: 'Yes, the Rode Wireless Pro is available for your dates. £17-25/day.' },
      { role: 'user', content: 'And what about the FX3?' },
      { role: 'assistant', content: 'The FX3 is available too — £34-40/day. Great combo with the Rode for filming.' },
    ],
    message: "Perfect, I'll take the FX3, the 24-70, and the Rode. Quick question — is the Rode definitely in stock? I've been burned before by rentals saying they have it then cancelling",
    checks: [
      { name: 'Confirms Rode available (consistent)', fn: r => /\b(yes|available|in stock|confirmed?|definitely|absolutely|have it|got it)\b/i.test(r), weight: 3 },
      { name: 'Does NOT say Rode unavailable', fn: r => !/\b(not available|unavailable|out of stock|unfortunately.*rode|sorry.*rode)\b/i.test(r), weight: 4 },
      { name: 'Reassures about reliability', fn: r => /\b(confirm|book|lock|reserve|assured|guarantee|definitely)\b/i.test(r), weight: 2 },
    ],
  },

  // T7: MULTI-STEP REASONING — requires tracking 3 changes
  {
    id: 'T7',
    name: 'Complex: triple modification request',
    history: [
      { role: 'user', content: 'I want FX3 + 24-70mm + Rode for Monday-Tuesday, pickup 10am' },
      { role: 'assistant', content: 'All three available Mon-Tue. Bundle ~£55-70/day, so about £110-140 total. Pickup 10am Monday at Trafalgar Square. Shall I confirm?' },
    ],
    message: "Actually three changes: 1) drop the Rode I don't need it, 2) change pickup to evening 7pm instead, 3) add an extra day so Monday to Wednesday",
    checks: [
      { name: 'Drops Rode from items', fn: r => /\b(FX3.*24.?70|camera.*lens)\b/i.test(r) && !/\b(Rode|wireless|mic|three items|all three)\b/i.test(r), weight: 3 },
      { name: 'Updates to 7pm pickup', fn: r => /7\s*(pm|:00)/i.test(r), weight: 2 },
      { name: 'Updates to 3 days (Mon-Wed)', fn: r => /\b(wed|3 day|three day|mon.*to.*wed)\b/i.test(r), weight: 2 },
      { name: 'Recalculates price for 2 items × 3 days', fn: r => {
        // FX3 £34-40 + 24-70 £14-20 = £48-60/day × 2.5 (3-day rate) = £120-150
        const prices = r.match(/£(\d+)/g)?.map(p => parseInt(p.replace('£', ''))) || [];
        return prices.some(p => p >= 100 && p <= 180);
      }, weight: 3 },
    ],
  },

  // T8: EMOTIONAL INTELLIGENCE — frustrated renter
  {
    id: 'T8',
    name: 'Emotional: frustrated renter with wrong info',
    history: [
      { role: 'user', content: 'The listing says Stratford but now you say Trafalgar Square??' },
    ],
    message: "This is ridiculous. I travelled an hour to Stratford and now you're telling me the gear isn't even there? This is false advertising. I want a refund or free delivery to Stratford.",
    checks: [
      { name: 'Empathizes first', fn: r => {
        const firstSentence = r.split(/[.!]/)[0]?.toLowerCase() || '';
        return /\b(sorry|understand|frustrat|apologis|apologiz|appreciate)\b/.test(firstSentence);
      }, weight: 3 },
      { name: 'Does NOT argue or dismiss', fn: r => !/\b(actually|but you|technically|you should have|that'?s not)\b/i.test(r.split(/[.!]/)[0] || ''), weight: 2 },
      { name: 'Offers solution', fn: r => /\b(deliver|discount|distance|arrange|help|sort|offer|compensation)\b/i.test(r), weight: 2 },
      { name: 'Does NOT make refund promise', fn: r => !/\b(full refund|refund you|your money back|free rental)\b/i.test(r), weight: 2 },
      { name: 'Mentions escalation to Daniel', fn: r => /\b(Daniel|check|escalat|owner|speak to|get back)\b/i.test(r), weight: 1 },
    ],
  },

  // T9: SNEAKY POLICY FABRICATION — asks about non-existent policies
  {
    id: 'T9',
    name: 'Policy fabrication: inventing rules',
    history: [],
    message: "What's your cancellation policy? Is there a deposit? And do you have insurance included?",
    checks: [
      { name: 'Does NOT invent specific cancellation terms', fn: r => !/\b(\d+\s*(hour|day|week)s?\s*(before|prior|notice|in advance|cancellation))\b/i.test(r) || /\b(check|confirm|get back)\b/i.test(r), weight: 3 },
      { name: 'Does NOT invent deposit amount', fn: r => !/\b(£\d+\s*deposit|deposit of £|\d+%\s*deposit)\b/i.test(r) || /\b(check|confirm)\b/i.test(r), weight: 3 },
      { name: 'Does NOT invent insurance terms', fn: r => !/\b(insurance (is |covers?|included)|£\d+.*insurance|damage waiver)\b/i.test(r) || /\b(check|confirm|get back)\b/i.test(r), weight: 2 },
      { name: 'Defers or says will check', fn: r => /\b(check|confirm|get back|let me|platform|booking system|details|terms)\b/i.test(r), weight: 2 },
    ],
  },

  // T10: CONVERSATION MEMORY — reference something from 6 messages ago
  {
    id: 'T10',
    name: 'Memory: recall earlier conversation detail',
    history: [
      { role: 'user', content: 'Hi, I need camera gear for a wedding this Saturday' },
      { role: 'assistant', content: 'Hey John! The FX3 is great for weddings. Available Saturday, £34-40/day. What time is the ceremony?' },
      { role: 'user', content: 'Ceremony is at 2pm in Richmond Park' },
      { role: 'assistant', content: 'Nice! The FX3 with the 24-70mm would be perfect for outdoor ceremony shots. Want both for Saturday?' },
      { role: 'user', content: 'Yes, and can I pick up Friday evening instead?' },
      { role: 'assistant', content: 'Friday evening pickup works — 7pm-9pm slot. Then return Sunday? That would be Fri-Sun, about £96-120 for the pair.' },
      { role: 'user', content: 'Actually how much would just the camera be on its own for the same 3 days?' },
      { role: 'assistant', content: 'FX3 only for Fri-Sun: about £85-100. The 24-70mm adds £35-50 for 3 days.' },
    ],
    message: 'OK let me go back to the full package — camera plus lens. And remind me, what time did I say the ceremony starts?',
    checks: [
      { name: 'Recalls 2pm ceremony', fn: r => /2\s*(pm|:00|o'?clock)/i.test(r), weight: 4 },
      { name: 'Recalls Richmond Park', fn: r => /richmond/i.test(r), weight: 2 },
      { name: 'Confirms both items', fn: r => /\b(FX3|camera).*\b(24.?70|lens)\b/i.test(r) || /\b(both|full package|camera.*lens)\b/i.test(r), weight: 2 },
      { name: 'References correct price range', fn: r => {
        const prices = r.match(/£(\d+)/g)?.map(p => parseInt(p.replace('£', ''))) || [];
        return prices.some(p => p >= 85 && p <= 150);
      }, weight: 2 },
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
    max_tokens: 350,
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
  console.log('║  RAW MODEL INTELLIGENCE — WITHOUT KNOWLEDGE FENCE          ║');
  console.log('║  Shows what happens when prompt engineering misses a case   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const results: Record<string, { totalScore: number; totalMax: number; testResults: Record<string, { score: number; max: number; response: string; details: string[] }> }> = {};

  for (const [modelName] of Object.entries(MODELS)) {
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
        console.log(`  Response: "${result.response.substring(0, 150)}${result.response.length > 150 ? '...' : ''}"`);
        for (const d of result.details) console.log(d);
      } catch (err) {
        console.log(`  ❌ ${modelName}: ERROR — ${(err as Error).message}`);
      }
    }
  }

  // --- SUMMARY ---
  console.log('\n\n' + '═'.repeat(64));
  console.log('FINAL SCORES — RAW INTELLIGENCE (no fence)');
  console.log('═'.repeat(64));

  const sortedModels = Object.entries(results).sort(([, a], [, b]) => b.totalScore - a.totalScore);

  for (const [modelName, data] of sortedModels) {
    const pct = Math.round((data.totalScore / data.totalMax) * 100);
    const bar = '█'.repeat(Math.round(pct / 2.5)) + '░'.repeat(40 - Math.round(pct / 2.5));
    console.log(`\n  ${modelName.padEnd(12)} ${bar} ${data.totalScore}/${data.totalMax} (${pct}%)`);
  }

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

  console.log('\n\n' + '═'.repeat(64));
  console.log('RECOMMENDATION');
  console.log('═'.repeat(64));

  const h = results['Haiku 4.5'];
  const s4 = results['Sonnet 4'];
  const s45 = results['Sonnet 4.5'];
  const hPct = Math.round((h.totalScore / h.totalMax) * 100);
  const s4Pct = Math.round((s4.totalScore / s4.totalMax) * 100);
  const s45Pct = Math.round((s45.totalScore / s45.totalMax) * 100);

  console.log(`\n  Intelligence gap WITHOUT fence: Haiku ${hPct}% vs Sonnet 4 ${s4Pct}% vs Sonnet 4.5 ${s45Pct}%`);
  console.log(`  The fence narrows the gap, but doesn't eliminate it.`);
  console.log(`  Stronger models = fewer edge cases that slip through the fence.`);
}

main().catch(console.error);
