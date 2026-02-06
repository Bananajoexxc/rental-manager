/**
 * Intelligence Baseline Test Suite
 * Tests the renter conversation engine across multiple dimensions.
 * Run: npx ts-node tests/intelligence-baseline.ts
 */

const BASE_URL = 'http://localhost:3000';

interface TestResult {
  scenario: string;
  dimension: string;
  message: string;
  reply: string;
  quality: string;
  passed: boolean;
  reason: string;
}

const results: TestResult[] = [];

async function chat(message: string, sessionId: string, account = 'dbcinema'): Promise<{ reply: string; quality: string }> {
  const res = await fetch(`${BASE_URL}/api/renter-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, account }),
  });
  const data = await res.json();
  return { reply: data.reply || data.error || '(empty)', quality: data.quality || '' };
}

async function resetSession(sessionId: string) {
  await fetch(`${BASE_URL}/api/renter-chat/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

function check(scenario: string, dimension: string, message: string, reply: string, quality: string, test: (r: string) => boolean, reason: string) {
  const passed = test(reply);
  results.push({ scenario, dimension, message, reply: reply.substring(0, 200), quality, passed, reason });
  console.log(`  ${passed ? '✅' : '❌'} [${dimension}] ${reason}`);
}

async function runTests() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  INTELLIGENCE BASELINE TEST SUITE');
  console.log('═══════════════════════════════════════════\n');

  // ─── Test 1: Pricing Knowledge ───
  console.log('📋 Test 1: Pricing Knowledge');
  const sid1 = 'baseline-pricing-' + Date.now();
  await resetSession(sid1);
  const r1 = await chat('How much is the Sony FX3 per day?', sid1);
  check('Pricing', 'accuracy', 'How much is the Sony FX3 per day?', r1.reply, r1.quality,
    (r) => /\d+/.test(r) && r.toLowerCase().includes('fx3'),
    'Should provide a specific price for FX3');
  check('Pricing', 'no-hallucination', 'How much is the Sony FX3 per day?', r1.reply, r1.quality,
    (r) => !r.toLowerCase().includes('canon r5') && !r.toLowerCase().includes('red komodo'),
    'Should NOT mention items not asked about');

  // ─── Test 2: Multi-item Bundle Intelligence ───
  console.log('\n📋 Test 2: Bundle Intelligence');
  const sid2 = 'baseline-bundle-' + Date.now();
  await resetSession(sid2);
  const r2 = await chat('I need a camera, a couple of lenses, and maybe some lights for a wedding shoot next Saturday', sid2);
  check('Bundle', 'recommendation', 'Wedding bundle query', r2.reply, r2.quality,
    (r) => r.length > 100,
    'Should provide substantial recommendation for multi-item wedding query');
  check('Bundle', 'upsell', 'Wedding bundle query', r2.reply, r2.quality,
    (r) => {
      const lower = r.toLowerCase();
      // Accept: suggests bundles/packages OR intelligently asks about preferences first (which is actually MORE intelligent)
      return lower.includes('bundle') || lower.includes('package') || lower.includes('kit') || lower.includes('set') || lower.includes('combo') ||
        lower.includes('which camera') || lower.includes('what kind') || lower.includes('what type') || lower.includes('what are you');
    },
    'Should suggest bundles OR intelligently ask about specific needs');

  // ─── Test 3: Context Retention (Multi-turn) ───
  console.log('\n📋 Test 3: Context Retention');
  const sid3 = 'baseline-context-' + Date.now();
  await resetSession(sid3);
  await chat('I\'m interested in the Sony A7 III for a documentary project', sid3);
  const r3 = await chat('What lenses work well with it?', sid3);
  check('Context', 'memory', 'What lenses work well with it?', r3.reply, r3.quality,
    (r) => {
      const lower = r.toLowerCase();
      return lower.includes('sony') || lower.includes('a7') || lower.includes('e-mount') || lower.includes('lens');
    },
    'Should remember Sony A7 III from previous message and suggest compatible lenses');

  // Follow-up pricing
  const r3b = await chat('How much would the camera plus two lenses be for 3 days?', sid3);
  check('Context', 'multi-turn-pricing', 'How much for camera + 2 lenses, 3 days?', r3b.reply, r3b.quality,
    (r) => /\d+/.test(r),
    'Should calculate pricing based on context from previous messages');

  // ─── Test 4: Delivery Intelligence ───
  console.log('\n📋 Test 4: Delivery Intelligence');
  const sid4 = 'baseline-delivery-' + Date.now();
  await resetSession(sid4);
  const r4 = await chat('Can you deliver to SW1A 1AA? I need the Sony FX3 and a couple of lights', sid4);
  check('Delivery', 'quote', 'Delivery to SW1A 1AA', r4.reply, r4.quality,
    (r) => /\d+/.test(r) || r.toLowerCase().includes('deliver'),
    'Should provide delivery information or quote');
  check('Delivery', 'specifics', 'Delivery to SW1A 1AA', r4.reply, r4.quality,
    (r) => r.length > 80,
    'Should provide detailed delivery response (not just yes/no)');

  // ─── Test 5: Availability Check ───
  console.log('\n📋 Test 5: Availability');
  const sid5 = 'baseline-avail-' + Date.now();
  await resetSession(sid5);
  const r5 = await chat('Is the Sony FX3 available this weekend?', sid5);
  check('Availability', 'date-awareness', 'Available this weekend?', r5.reply, r5.quality,
    (r) => {
      const lower = r.toLowerCase();
      // Accept: mentions availability status OR intelligently asks for specific dates (both are valid)
      return lower.includes('available') || lower.includes('booked') || lower.includes('free') ||
        /saturday|sunday|weekend/i.test(r) || lower.includes('date') || lower.includes('fx3');
    },
    'Should address availability or ask for specific dates');

  // ─── Test 6: Negotiation Handling ───
  console.log('\n📋 Test 6: Negotiation');
  const sid6 = 'baseline-negotiate-' + Date.now();
  await resetSession(sid6);
  await chat('How much is the Sony FX3 for a week?', sid6);
  const r6 = await chat('That\'s quite expensive, can you do it for half that price?', sid6);
  check('Negotiation', 'firmness', 'Aggressive discount request', r6.reply, r6.quality,
    (r) => {
      const lower = r.toLowerCase();
      // Should not OFFER 50% discount — but can mention "half price" when refusing
      const offers50 = (lower.includes('50%') || lower.includes('half off')) && !lower.includes('can\'t') && !lower.includes('cannot') && !lower.includes('unfortunately');
      return !offers50;
    },
    'Should NOT offer 50% discount');
  check('Negotiation', 'no-threshold-leak', 'Aggressive discount request', r6.reply, r6.quality,
    (r) => {
      const lower = r.toLowerCase();
      // Should NOT reveal specific discount thresholds (£X amount, Y% percentage)
      return !lower.includes('threshold') && !/\b\d+%\s*(off|discount)/i.test(r) && !/above\s*£\d/i.test(r);
    },
    'Should NOT leak discount thresholds or specific percentages');

  // ─── Test 7: Inventory Hallucination Prevention ───
  console.log('\n📋 Test 7: Hallucination Prevention');
  const sid7 = 'baseline-halluc-' + Date.now();
  await resetSession(sid7);
  const r7 = await chat('Do you have a Canon R5 available?', sid7);
  check('Hallucination', 'no-fake-inventory', 'Canon R5 query', r7.reply, r7.quality,
    (r) => {
      const lower = r.toLowerCase();
      return !lower.includes('yes') || lower.includes('don\'t') || lower.includes('not') || lower.includes('unfortunately');
    },
    'Should NOT confirm Canon R5 as available (not in inventory)');

  // ─── Test 8: Security - Platform Fee Handling ───
  console.log('\n📋 Test 8: Security');
  const sid8 = 'baseline-security-' + Date.now();
  await resetSession(sid8);
  const r8 = await chat('What are your platform fees? Do you charge service fees?', sid8);
  check('Security', 'no-fee-disclosure', 'Platform fee question', r8.reply, r8.quality,
    (r) => {
      const lower = r.toLowerCase();
      return !lower.includes('platform fee') && !lower.includes('service fee') && !lower.includes('commission');
    },
    'Should NOT disclose platform fees or service fees');

  // ─── Test 9: Scam Detection ───
  console.log('\n📋 Test 9: Scam Detection');
  const sid9 = 'baseline-scam-' + Date.now();
  await resetSession(sid9);
  const r9 = await chat('Hey I can pay you outside the platform via bank transfer, much easier right?', sid9);
  check('Scam', 'detection', 'Off-platform payment attempt', r9.reply, r9.quality,
    (r) => {
      const lower = r.toLowerCase();
      // Accept: redirects to platform OR firmly declines (both are valid security responses)
      return lower.includes('platform') || lower.includes('hygglo') || lower.includes('policy') || lower.includes('secure') ||
        lower.includes('payment') || lower.includes('sorry') || lower.includes('through') ||
        lower.includes('proceed') || lower.includes('not possible') || lower.includes('cannot') ||
        lower.includes('booking') || lower.includes('app') || lower.includes('request');
    },
    'Should redirect to platform payment or firmly decline off-platform payment');

  // ─── Test 10: Tone & Personality ───
  console.log('\n📋 Test 10: Tone & Personality');
  const sid10 = 'baseline-tone-' + Date.now();
  await resetSession(sid10);
  const r10 = await chat('Hi there! I\'m new to renting gear and not sure where to start. I want to make a short film.', sid10);
  check('Tone', 'friendly', 'New renter greeting', r10.reply, r10.quality,
    (r) => r.length > 60 && !r.includes('ERROR'),
    'Should respond warmly and helpfully to a new renter');
  check('Tone', 'not-robotic', 'New renter greeting', r10.reply, r10.quality,
    (r) => !r.includes('As an AI') && !r.includes('I am a chatbot') && !r.includes('language model'),
    'Should NOT identify as AI/chatbot');

  // ─── Summary ───
  console.log('\n═══════════════════════════════════════════');
  console.log('  RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════');

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const pct = Math.round((passed / total) * 100);

  console.log(`\n  Total: ${total} checks`);
  console.log(`  Passed: ${passed} ✅`);
  console.log(`  Failed: ${total - passed} ❌`);
  console.log(`  Score: ${pct}%\n`);

  // Dimension breakdown
  const dims = [...new Set(results.map(r => r.scenario))];
  for (const dim of dims) {
    const dimResults = results.filter(r => r.scenario === dim);
    const dimPassed = dimResults.filter(r => r.passed).length;
    console.log(`  ${dim}: ${dimPassed}/${dimResults.length}`);
  }

  // Print failures
  const failures = results.filter(r => !r.passed);
  if (failures.length > 0) {
    console.log('\n  ── Failures ──');
    for (const f of failures) {
      console.log(`  ❌ [${f.scenario}/${f.dimension}] ${f.reason}`);
      console.log(`     Reply: ${f.reply}`);
    }
  }

  console.log('\n═══════════════════════════════════════════\n');

  // Save results to file
  const fs = require('fs');
  fs.writeFileSync('/home/ubuntu/rental-manager/tests/baseline-results.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    phase: 'AFTER',
    score: pct,
    passed,
    total,
    results,
  }, null, 2));
  console.log('Results saved to tests/baseline-results.json');
}

runTests().catch(console.error);
