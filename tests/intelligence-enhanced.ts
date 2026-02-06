/**
 * Enhanced Intelligence Tests — validates NEW features from autonomous service merge
 */
const BASE_URL = 'http://localhost:3000';

interface TestResult { scenario: string; dimension: string; reply: string; passed: boolean; reason: string; }
const results: TestResult[] = [];

async function chat(message: string, sessionId: string, account = 'dbcinema'): Promise<{ reply: string; quality: string }> {
  const res = await fetch(`${BASE_URL}/api/renter-chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, account }),
  });
  const data = await res.json();
  return { reply: data.reply || data.error || '(empty)', quality: data.quality || '' };
}

async function resetSession(sid: string) {
  await fetch(`${BASE_URL}/api/renter-chat/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
}

function check(scenario: string, dim: string, reply: string, test: (r: string) => boolean, reason: string) {
  const passed = test(reply);
  results.push({ scenario, dimension: dim, reply: reply.substring(0, 250), passed, reason });
  console.log(`  ${passed ? '✅' : '❌'} [${dim}] ${reason}`);
}

async function runTests() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  ENHANCED INTELLIGENCE TEST SUITE');
  console.log('  (Tests new features from merge)');
  console.log('═══════════════════════════════════════════\n');

  // Test 1: Proactive project inquiry (CRITICAL — CONTEXTUAL RECOMMENDATIONS)
  console.log('📋 Test 1: Proactive Project Inquiry');
  const s1 = 'enh-project-' + Date.now();
  await resetSession(s1);
  const r1 = await chat('I need to rent a camera', s1);
  check('ProjectInquiry', 'asks-about-shoot', r1.reply,
    (r) => { const l = r.toLowerCase(); return l.includes('shoot') || l.includes('project') || l.includes('what') || l.includes('film') || l.includes('looking'); },
    'Should ask about the project/shoot type (new CRITICAL rule)');

  // Test 2: Cancel/reschedule detection
  console.log('\n📋 Test 2: Cancel/Reschedule Detection');
  const s2 = 'enh-cancel-' + Date.now();
  await resetSession(s2);
  const r2 = await chat('I need to cancel this booking', s2);
  check('CancelDetect', 'detected', r2.reply,
    (r) => { const l = r.toLowerCase(); return l.includes('check') || l.includes('shortly') || l.includes('get back') || l.includes('looking into') || l.includes('escalat'); },
    'Should detect cancellation and send holding response');

  // Test 3: Leo Adams persona
  console.log('\n📋 Test 3: Leo Adams Persona');
  const s3 = 'enh-leo-' + Date.now();
  await resetSession(s3);
  const r3 = await chat('Hi, do you have any camera gear for hire?', s3, 'leo');
  check('Persona', 'leo-tone', r3.reply,
    (r) => { const l = r.toLowerCase(); return l.includes('i') && (l.includes("i've") || l.includes('i have') || l.includes("i'm") || l.includes('my') || l.includes('i can')); },
    'Leo persona should use first person "I" and "my" (enhanced persona)');

  // Test 4: DB Cinema persona (should NOT use "I" or "my gear")
  console.log('\n📋 Test 4: DB Cinema Persona');
  const s4 = 'enh-db-' + Date.now();
  await resetSession(s4);
  const r4 = await chat('Hi, do you have any camera gear for hire?', s4, 'dbcinema');
  check('Persona', 'db-tone', r4.reply,
    (r) => { const l = r.toLowerCase(); return !l.includes('my gear') && !l.includes('my items') && !l.includes('my equipment'); },
    'DB Cinema persona should NOT use "my gear/items/equipment"');

  // Test 5: No downselling (CRITICAL rule from autonomous)
  console.log('\n📋 Test 5: No Downselling');
  const s5 = 'enh-downsell-' + Date.now();
  await resetSession(s5);
  await chat('I want to rent a Sony FX3 and a Sigma 24-70 for a documentary', s5);
  const r5 = await chat('What else would you recommend I add?', s5);
  check('NoDowsell', 'suggests-more', r5.reply,
    (r) => {
      const l = r.toLowerCase();
      // Should suggest accessories, NOT say "you're all set" or "that's enough"
      return r.length > 60 && !l.includes('all set') && !l.includes('pretty much set') && !l.includes("that's enough") && !l.includes("you're good");
    },
    'Should suggest complementary items, NOT downsell (new CRITICAL rule)');

  // Test 6: Delivery with postcode from conversation history
  console.log('\n📋 Test 6: Delivery Postcode from History');
  const s6 = 'enh-deliv-' + Date.now();
  await resetSession(s6);
  await chat('Can you deliver to E1 6AN? I need the Sony FX3', s6);
  const r6a = await chat('Actually I also need some lights, 2 Nanlite Forza 300Bs. How much would delivery be now?', s6);
  check('DeliveryHistory', 'remembers-postcode', r6a.reply,
    (r) => /\d/.test(r) && r.length > 50,
    'Should calculate delivery using postcode from earlier in conversation');

  // Test 7: Enhanced stage tracking
  console.log('\n📋 Test 7: Stage Progression');
  const s7 = 'enh-stage-' + Date.now();
  await resetSession(s7);
  await chat('How much is the Sony FX3?', s7);
  await chat('That sounds good. Can you deliver to SW1A 1AA?', s7);
  const r7 = await chat('Great, how do I book?', s7);
  check('StageTrack', 'booking-guidance', r7.reply,
    (r) => { const l = r.toLowerCase(); return l.includes('request') || l.includes('book') || l.includes('platform') || l.includes('send'); },
    'At BOOKING_READY stage, should guide to submit booking request');

  // Test 8: Multi-item with substitution awareness
  console.log('\n📋 Test 8: Substitution Awareness');
  const s8 = 'enh-subs-' + Date.now();
  await resetSession(s8);
  const r8 = await chat('Do you have the Atomos Ninja V? What about the Hollyland Pyro 7 if not?', s8);
  check('Substitution', 'suggests-alternative', r8.reply,
    (r) => r.length > 50,
    'Should provide informed response about item availability and alternatives');

  // Summary
  console.log('\n═══════════════════════════════════════════');
  console.log('  ENHANCED RESULTS');
  console.log('═══════════════════════════════════════════');
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n  Total: ${total} checks`);
  console.log(`  Passed: ${passed} ✅`);
  console.log(`  Failed: ${total - passed} ❌`);
  console.log(`  Score: ${Math.round((passed/total)*100)}%\n`);

  const dims = [...new Set(results.map(r => r.scenario))];
  for (const dim of dims) {
    const dr = results.filter(r => r.scenario === dim);
    console.log(`  ${dim}: ${dr.filter(r=>r.passed).length}/${dr.length}`);
  }

  const failures = results.filter(r => !r.passed);
  if (failures.length > 0) {
    console.log('\n  ── Failures ──');
    for (const f of failures) {
      console.log(`  ❌ [${f.scenario}/${f.dimension}] ${f.reason}`);
      console.log(`     Reply: ${f.reply}`);
    }
  }
  console.log('\n═══════════════════════════════════════════\n');
}

runTests().catch(console.error);
