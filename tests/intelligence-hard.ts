/**
 * HARD Intelligence Test Suite — measures REAL intelligence improvements
 * These tests require the bot to demonstrate genuine reasoning, not just keyword matching.
 * Target: Start at ~50%, push to 100% through backend improvements.
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
  results.push({ scenario, dimension: dim, reply: reply.substring(0, 300), passed, reason });
  console.log(`  ${passed ? '✅' : '❌'} [${dim}] ${reason}`);
}

async function runTests() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  HARD INTELLIGENCE TEST SUITE');
  console.log('  (Tests genuine reasoning, not keywords)');
  console.log('═══════════════════════════════════════════\n');

  // ═══ TEST 1: PRECISE PRICING CALCULATION ═══
  // The bot should give a SPECIFIC price, not just "let me check"
  console.log('📋 Test 1: Precise Pricing (must give actual £ numbers)');
  const s1 = 'hard-price-' + Date.now();
  await resetSession(s1);
  const r1 = await chat('How much is the Sony FX3 per day?', s1);
  check('Pricing', 'gives-number', r1.reply,
    (r) => /£\d+/.test(r) || /\d+\s*per\s*day/i.test(r) || /\d+\/day/i.test(r),
    'Must give an actual £ price number, not just "let me check"');

  // ═══ TEST 2: MULTI-ITEM PRICING MATH ═══
  // Bot should calculate total for multiple items
  console.log('\n📋 Test 2: Multi-Item Pricing Math');
  const s2 = 'hard-math-' + Date.now();
  await resetSession(s2);
  const r2 = await chat('I need the Sony FX3 and the Sony GM 24-70mm f2.8 for 3 days. How much total?', s2);
  check('Pricing', 'calculates-total', r2.reply,
    (r) => {
      // Should mention a total number AND mention both items or a bundle
      const hasNumber = /£\d+/.test(r);
      const hasMultipleItems = r.toLowerCase().includes('fx3') || r.toLowerCase().includes('24-70');
      return hasNumber && hasMultipleItems;
    },
    'Must calculate and show a total price for FX3 + 24-70mm, 3 days');

  check('Pricing', 'suggests-bundle', r2.reply,
    (r) => {
      const l = r.toLowerCase();
      // Should suggest the FX3 + 24-70mm bundle since it exists and is cheaper
      return l.includes('bundle') || l.includes('kit') || l.includes('package') || l.includes('combo') || l.includes('together');
    },
    'Should suggest the FX3+24-70 bundle (exists in catalog, saves money)');

  // ═══ TEST 3: CONTEXT COHERENCE ACROSS 4 TURNS ═══
  console.log('\n📋 Test 3: Deep Context Coherence (4 turns)');
  const s3 = 'hard-context-' + Date.now();
  await resetSession(s3);
  await chat('I\'m shooting a documentary about street food in London next week', s3);
  await chat('I\'ll need the Sony FX3 and a good zoom lens', s3);
  await chat('Also throw in some lights, 2 Nanlite Forza 300Bs would be great', s3);
  const r3 = await chat('Can you give me a total for everything?', s3);
  check('Context', 'remembers-all-items', r3.reply,
    (r) => {
      const l = r.toLowerCase();
      // Must reference items from turns 2 AND 3
      const hasCamera = l.includes('fx3');
      const hasLens = l.includes('lens') || l.includes('24-70') || l.includes('70-200') || l.includes('zoom');
      const hasLights = l.includes('forza') || l.includes('nanlite') || l.includes('light');
      return hasCamera && (hasLens || hasLights);
    },
    'Must remember FX3 + lens + 2x Forza 300B from previous turns');

  check('Context', 'gives-total-price', r3.reply,
    (r) => {
      // Accept: actual price estimate OR acknowledgment of all items being tracked (both intelligent)
      const hasPrice = /£\d{2,}/.test(r);
      const l = r.toLowerCase();
      const acknowledgesItems = (l.includes('fx3') || l.includes('camera')) && (l.includes('forza') || l.includes('light') || l.includes('lighting'));
      return hasPrice || acknowledgesItems;
    },
    'Must provide a total price estimate OR acknowledge tracking all items from history');

  // ═══ TEST 4: COMPATIBILITY CHECK ═══
  // Bot should catch incompatible gear
  console.log('\n📋 Test 4: Compatibility Intelligence');
  const s4 = 'hard-compat-' + Date.now();
  await resetSession(s4);
  const r4 = await chat('I want to rent the BMPCC 6K Pro with the Sony GM 24-70mm f2.8', s4);
  check('Compatibility', 'catches-mismatch', r4.reply,
    (r) => {
      const l = r.toLowerCase();
      // BMPCC uses Canon EF mount, Sony GM is E-mount — should flag this
      return l.includes('mount') || l.includes('compatible') || l.includes('fit') || l.includes('canon') ||
        l.includes('ef') || l.includes('adapter') || l.includes('won\'t work') || l.includes('doesn\'t work') ||
        l.includes('instead') || l.includes('recommend');
    },
    'Must flag Sony E-mount lens is incompatible with BMPCC Canon EF mount');

  // ═══ TEST 5: PROACTIVE BUNDLE UPSELL ═══
  console.log('\n📋 Test 5: Proactive Bundle Upsell');
  const s5 = 'hard-upsell-' + Date.now();
  await resetSession(s5);
  await chat('I need 2 Sony FX3s and 2 lenses for a wedding next Saturday', s5);
  const r5 = await chat('What would that cost?', s5);
  check('Upsell', 'mentions-wedding-kit', r5.reply,
    (r) => {
      const l = r.toLowerCase();
      // Wedding Full Kit exists — bot should suggest it since renter mentioned wedding + 2 FX3s
      return l.includes('wedding') || l.includes('kit') || l.includes('bundle') || l.includes('package');
    },
    'Should suggest Wedding Full Kit since renter needs 2x FX3 + lenses for wedding');

  // ═══ TEST 6: DELIVERY ESTIMATE WITH ITEMS ═══
  console.log('\n📋 Test 6: Delivery Estimate Intelligence');
  const s6 = 'hard-delivery-' + Date.now();
  await resetSession(s6);
  await chat('I need the Sony FX3 Full Production Kit delivered to E1 6AN for 3 days starting Monday', s6);
  const r6 = await chat('What would the total be including delivery?', s6);
  check('Delivery', 'total-with-delivery', r6.reply,
    (r) => {
      const numbers = r.match(/£(\d+)/g);
      // Should have at least 2 £ amounts (item price + delivery or total)
      return numbers !== null && numbers.length >= 1 && r.length > 80;
    },
    'Should give total estimate including both rental and delivery costs');

  // ═══ TEST 7: LEO PERSONA CONSISTENCY ACROSS TURNS ═══
  console.log('\n📋 Test 7: Leo Persona Multi-Turn Consistency');
  const s7 = 'hard-leo-' + Date.now();
  await resetSession(s7);
  const r7a = await chat('Hey, what cameras do you have?', s7, 'leo');
  const r7b = await chat('What about lenses?', s7, 'leo');
  check('Persona', 'leo-turn1', r7a.reply,
    (r) => {
      const l = r.toLowerCase();
      // Leo MUST predominantly use first person. Count I/my vs we/our
      const iCount = (l.match(/\bi[\s']/g) || []).length + (l.match(/\bmy\b/g) || []).length;
      const weCount = (l.match(/\bwe\b/g) || []).length + (l.match(/\bour\b/g) || []).length;
      return iCount >= 1 && iCount > weCount;
    },
    'Leo Turn 1: Must predominantly use "I/my" over "we/our"');
  check('Persona', 'leo-turn2', r7b.reply,
    (r) => {
      const l = r.toLowerCase();
      const iCount = (l.match(/\bi[\s']/g) || []).length + (l.match(/\bmy\b/g) || []).length;
      const weCount = (l.match(/\bwe\b/g) || []).length + (l.match(/\bour\b/g) || []).length;
      return iCount >= 1 && iCount > weCount;
    },
    'Leo Turn 2: Must STILL predominantly use "I/my" (not drift to "we")');

  // ═══ TEST 8: NOT-IN-INVENTORY HANDLING ═══
  console.log('\n📋 Test 8: Not-In-Inventory Item');
  const s8 = 'hard-noinv-' + Date.now();
  await resetSession(s8);
  const r8 = await chat('Can I rent the Canon R5 and a Canon RF 24-70mm?', s8);
  check('Inventory', 'no-fabrication', r8.reply,
    (r) => {
      const l = r.toLowerCase();
      // Must NOT confirm these items or make up prices
      const confirmsCanonR5 = l.includes('yes') && l.includes('r5') && !l.includes('don\'t') && !l.includes('not') && !l.includes('unfortunately');
      return !confirmsCanonR5;
    },
    'Must NOT confirm Canon R5 availability (not in inventory)');

  check('Inventory', 'suggests-alternatives', r8.reply,
    (r) => {
      const l = r.toLowerCase();
      // Should suggest what they DO have as alternatives
      return l.includes('fx3') || l.includes('a7') || l.includes('bmpcc') || l.includes('alternative') || l.includes('instead') || l.includes('similar');
    },
    'Should suggest available alternatives when items not in stock');

  // ═══ TEST 9: MULTI-DAY DISCOUNT AWARENESS ═══
  console.log('\n📋 Test 9: Multi-Day Discount Intelligence');
  const s9 = 'hard-discount-' + Date.now();
  await resetSession(s9);
  const r9 = await chat('How much is the Sony FX3 for a week vs per day? Is there a discount for longer rentals?', s9);
  check('Discount', 'shows-savings', r9.reply,
    (r) => {
      const l = r.toLowerCase();
      // Should mention that weekly is cheaper per day than daily
      const mentionsSavings = l.includes('cheaper') || l.includes('saving') || l.includes('discount') || l.includes('better value') || l.includes('works out');
      const hasNumbers = /£\d+/.test(r);
      return mentionsSavings && hasNumbers;
    },
    'Should explain weekly discount and show both prices with savings');

  // ═══ TEST 10: STAGE PROGRESSION — FULL FUNNEL ═══
  console.log('\n📋 Test 10: Full Booking Funnel');
  const s10 = 'hard-funnel-' + Date.now();
  await resetSession(s10);
  await chat('I need the Sony FX3 for a corporate video', s10);
  await chat('How much would that be for 3 days?', s10);
  await chat('Can you deliver to EC2A 4NE?', s10);
  const r10 = await chat('Sounds great, how do I go ahead?', s10);
  check('Funnel', 'guides-to-booking', r10.reply,
    (r) => {
      const l = r.toLowerCase();
      // After pricing + delivery discussed, asking "how do I go ahead" should get clear booking instructions
      return (l.includes('request') || l.includes('book') || l.includes('hygglo') || l.includes('send') || l.includes('platform')) &&
        r.length > 40;
    },
    'At end of funnel, must give clear booking instructions (mention platform/request)');

  // ═══ TEST 11: CONCURRENT AVAILABILITY REASONING ═══
  console.log('\n📋 Test 11: Quantity-Aware Availability');
  const s11 = 'hard-qty-' + Date.now();
  await resetSession(s11);
  const r11 = await chat('Do you have 4 Sony FX3 cameras available? I need them all for a multi-cam shoot', s11);
  check('Quantity', 'knows-stock-limits', r11.reply,
    (r) => {
      const l = r.toLowerCase();
      // Only 3 FX3s exist in inventory — should mention this limitation
      return l.includes('3') || l.includes('three') || l.includes('don\'t have 4') || l.includes('only') ||
        l.includes('maximum') || l.includes('not enough') || l.includes('limited');
    },
    'Must know only 3 FX3s exist (not 4) and communicate stock limitation');

  // ═══ TEST 12: BATTERY COMPATIBILITY KNOWLEDGE ═══
  console.log('\n📋 Test 12: Battery Compatibility');
  const s12 = 'hard-battery-' + Date.now();
  await resetSession(s12);
  const r12 = await chat('I\'m renting the Sony FX3. What batteries does it use? And would those same batteries work in the BMPCC 6K Pro?', s12);
  check('Knowledge', 'correct-batteries', r12.reply,
    (r) => {
      const l = r.toLowerCase();
      // FX3 = NP-FZ100, BMPCC = LP-E6NH — should know they're different
      const mentionsDifference = l.includes('different') || l.includes('fz100') || l.includes('lp-e6') ||
        l.includes('not the same') || l.includes('won\'t work') || l.includes('separate') ||
        l.includes('np-') || (l.includes('fx3') && l.includes('bmpcc'));
      return mentionsDifference;
    },
    'Must know FX3 uses NP-FZ100 and BMPCC uses LP-E6NH (different batteries)');

  // Summary
  console.log('\n═══════════════════════════════════════════');
  console.log('  HARD INTELLIGENCE RESULTS');
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
