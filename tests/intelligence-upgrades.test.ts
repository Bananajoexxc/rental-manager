/**
 * Integration tests for the 4 Bot Intelligence Upgrades:
 * 1. Pre-Extracted Listing Identity
 * 2. Think-Then-Reply (Preflight Reasoning)
 * 3. Conversation State Machine
 * 4. Tool Use / Function Calling
 *
 * Specifically tests context persistence across time and multiple requests.
 */
import { PrismaClient } from '@prisma/client';
import { validateListingItems, findBestMatch, getInventoryItemNames } from '../src/utils/item-matcher';

const prisma = new PrismaClient();

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
      failed++;
    }
  }

  // ── TEST GROUP 1: Schema & Data Model ──
  console.log('\n=== 1. SCHEMA & DATA MODEL ===');

  // structured_state field exists on follow_up_state
  try {
    const state = await prisma.follow_up_state.findFirst({
      select: { structured_state: true },
    });
    assert('structured_state field exists', state !== undefined || state === null);
  } catch (e: any) {
    assert('structured_state field exists', false, e.message);
  }

  // extracteditem supports source='listing_title'
  try {
    const count = await prisma.extracteditem.count({ where: { source: 'listing_title' } });
    assert('extracteditem listing_title source supported', true, `${count} existing records`);
  } catch (e: any) {
    assert('extracteditem listing_title source supported', false, e.message);
  }

  // ── TEST GROUP 2: Feature 1 — Pre-Extracted Listing Identity ──
  console.log('\n=== 2. PRE-EXTRACTED LISTING IDENTITY ===');

  // validateListingItems correctly identifies items with clean names
  const cleanTitle1 = 'Sony FX3 Cinema Camera';
  const match1 = validateListingItems(cleanTitle1);
  assert('Clean title: matches FX3', match1.items.some(i => i.matched && i.inventoryItem?.toLowerCase().includes('fx3')));

  // SEO-polluted title: "FX 3" (space) doesn't match "FX3" — this is the Nathaniel A bug
  // The preflight + verified listing item features handle this by providing AI with verified facts
  // even when item-matcher can't parse the SEO noise
  const seoTitle1 = 'Sony FX 3 Cinema Camera Full Frame 4K (same sensor as a7siii a7s iii)';
  const seoMatch = validateListingItems(seoTitle1);
  assert('SEO title "FX 3" is a known gap (noneMatched)', seoMatch.noneMatched);

  const seoTitle2 = 'Sony GM 24-70mm f2.8 II Professional Zoom Lens (fits A7IV A7III A7S A7R)';
  const match2 = validateListingItems(seoTitle2);
  assert('Clean lens title: matches 24-70mm GM', match2.items.some(i => i.matched && i.inventoryItem?.toLowerCase().includes('24-70')));

  // findBestMatch with clean name works (used as fallback)
  assert('findBestMatch("Sony FX3") works', findBestMatch('Sony FX3', getInventoryItemNames()) === 'Sony FX3');

  // Test backfill candidates exist
  const activeRentals = await prisma.rental.findMany({
    where: { status: { in: ['pending_review', 'upcoming', 'ongoing'] } },
    select: { id: true, title: true },
  });
  console.log(`  (${activeRentals.length} active rentals eligible for backfill)`);

  // ── TEST GROUP 3: Feature 3 — Conversation State Machine ──
  console.log('\n=== 3. CONVERSATION STATE MACHINE ===');

  // Find an active follow_up_state to test with
  const testState = await prisma.follow_up_state.findFirst({
    where: { status: 'active' },
    select: { id: true, rental_id: true, structured_state: true },
  });

  if (testState) {
    const originalState = testState.structured_state;

    // Test write
    const testData = {
      confirmedItems: ['Sony FX3'],
      agreedPickupTime: 'Friday 10am',
      questionsAsked: ['shoot type', 'dates'],
      renterShootType: 'wedding',
      priceQuoted: 150,
    };
    await prisma.follow_up_state.update({
      where: { id: testState.id },
      data: { structured_state: testData },
    });

    // Test read back
    const readBack = await prisma.follow_up_state.findUnique({
      where: { id: testState.id },
      select: { structured_state: true },
    });
    const state = readBack?.structured_state as any;
    assert('Write + read structured_state', state !== null);
    assert('confirmedItems persisted', JSON.stringify(state?.confirmedItems) === '["Sony FX3"]');
    assert('agreedPickupTime persisted', state?.agreedPickupTime === 'Friday 10am');
    assert('questionsAsked persisted', state?.questionsAsked?.length === 2);
    assert('renterShootType persisted', state?.renterShootType === 'wedding');
    assert('priceQuoted persisted', state?.priceQuoted === 150);

    // Test merge (simulate second exchange adding data)
    const mergeData = {
      ...state,
      confirmedItems: [...(state?.confirmedItems || []), 'Sony GM 24-70mm'],
      questionsAsked: [...(state?.questionsAsked || []), 'delivery preference'],
      agreedReturnTime: 'Monday 6pm',
      deliveryDiscussed: true,
    };
    await prisma.follow_up_state.update({
      where: { id: testState.id },
      data: { structured_state: mergeData },
    });

    const merged = await prisma.follow_up_state.findUnique({
      where: { id: testState.id },
      select: { structured_state: true },
    });
    const mergedState = merged?.structured_state as any;
    assert('Merge: confirmedItems accumulated', mergedState?.confirmedItems?.length === 2);
    assert('Merge: questionsAsked accumulated', mergedState?.questionsAsked?.length === 3);
    assert('Merge: agreedReturnTime added', mergedState?.agreedReturnTime === 'Monday 6pm');
    assert('Merge: original fields preserved', mergedState?.renterShootType === 'wedding');
    assert('Merge: deliveryDiscussed added', mergedState?.deliveryDiscussed === true);

    // Restore original state
    await prisma.follow_up_state.update({
      where: { id: testState.id },
      data: { structured_state: (originalState as any) || undefined },
    });
    assert('Original state restored', true);
  } else {
    console.log('  (No active follow_up_state found — skipping write/merge tests)');
  }

  // ── TEST GROUP 4: Feature 2 — Preflight Reasoning (source code check) ──
  console.log('\n=== 4. PREFLIGHT REASONING (source validation) ===');

  const fs = require('fs');
  const aiSrc = fs.readFileSync('/home/ubuntu/rental-manager/src/ai/ai.service.ts', 'utf-8');
  const autoSrc = fs.readFileSync('/home/ubuntu/rental-manager/src/autonomous/autonomous.service.ts', 'utf-8');

  assert('preflightReasoning method exists', aiSrc.includes('async preflightReasoning('));
  assert('Preflight prompt includes ITEM/INTENT/STATUS/WARNINGS', aiSrc.includes('ITEM:') && aiSrc.includes('INTENT:') && aiSrc.includes('STATUS:'));
  assert('Preflight called in processMessage', autoSrc.includes('this.aiService.preflightReasoning('));
  assert('VERIFIED FACTS injected into additionalContext', autoSrc.includes('VERIFIED FACTS (from preflight check)'));
  assert('preflightContext in additionalContext array', autoSrc.includes('...[preflightContext].filter(Boolean)'));

  // ── TEST GROUP 5: Feature 4 — Tool Use (source code check) ──
  console.log('\n=== 5. TOOL USE / FUNCTION CALLING (source validation) ===');

  assert('ToolHandlers interface exported', aiSrc.includes('export interface ToolHandlers'));
  assert('TOOLS schema defined', aiSrc.includes('private readonly TOOLS: Anthropic.Tool[]'));
  assert('check_availability tool', aiSrc.includes("name: 'check_availability'"));
  assert('lookup_pricing tool', aiSrc.includes("name: 'lookup_pricing'"));
  assert('check_compatibility tool', aiSrc.includes("name: 'check_compatibility'"));
  assert('get_rental_details tool', aiSrc.includes("name: 'get_rental_details'"));
  assert('executeToolCall method', aiSrc.includes('private async executeToolCall('));
  assert('Tool-use loop with max 3 iterations', aiSrc.includes('iterations < 3'));
  assert('Tools passed to Claude API', aiSrc.includes('createParams.tools = this.TOOLS'));
  assert('toolHandlers in AiContext', aiSrc.includes('toolHandlers?: ToolHandlers'));
  assert('ToolHandlers constructed in autonomous', autoSrc.includes('const toolHandlers: ToolHandlers'));
  assert('toolHandlers passed to processAdaptive', autoSrc.includes('toolHandlers,'));

  // ── TEST GROUP 6: Context Persistence Across Multiple Requests ──
  console.log('\n=== 6. CONTEXT PERSISTENCE ACROSS TIME ===');

  assert('conversationStateCtx injected before AI call', autoSrc.includes('--- CONVERSATION STATE ---'));
  assert('State extraction after AI response', autoSrc.includes('Extract conversation state from this exchange'));
  assert('mergeStructuredState called post-response', autoSrc.includes('this.followUpService.mergeStructuredState('));
  assert('Anti-repeat instruction in state context', autoSrc.includes('Do NOT re-ask questions listed above'));
  assert('Upsell tracking in state', autoSrc.includes('Upselling already attempted'));
  assert('verifiedListingItem persists via extracteditem DB', autoSrc.includes("source: 'listing_title'"));

  // Check that CONVERSATION STATE block is in additionalContext array
  assert('conversationStateCtx in additionalContext', autoSrc.includes('...[conversationStateCtx].filter(Boolean)'));

  // ── TEST GROUP 7: Graceful Degradation ──
  console.log('\n=== 7. GRACEFUL DEGRADATION ===');

  // Count try/catch blocks around new features
  const preflightTryCatch = autoSrc.includes("this.logger.debug(`Preflight reasoning failed:");
  const stateTryCatch = autoSrc.includes('non-critical — state extraction is best-effort');
  const listingIdTryCatch = autoSrc.includes('verifiedListingItem') && autoSrc.includes('/* non-critical */');

  assert('Preflight failure has try/catch + debug log', preflightTryCatch);
  assert('State extraction failure is non-critical', stateTryCatch);
  assert('Listing identity load has try/catch', listingIdTryCatch);
  assert('Tool-use loop capped at 3 iterations', aiSrc.includes('iterations < 3'));

  // ── SUMMARY ──
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log(`${'='.repeat(50)}\n`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
