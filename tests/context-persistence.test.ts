/**
 * End-to-end test: Context persistence across multiple requests.
 * Simulates the follow-up service's structured state merging
 * as it would happen across multiple real conversation turns.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ConversationState {
  confirmedItems?: string[];
  agreedPickupTime?: string;
  agreedReturnTime?: string;
  renterShootType?: string;
  questionsAsked?: string[];
  upsellAttempted?: boolean;
  upsellItems?: string[];
  priceQuoted?: number;
  deliveryDiscussed?: boolean;
}

/** Replicates FollowUpService.mergeStructuredState logic */
function mergeState(current: ConversationState, changes: Partial<ConversationState>): ConversationState {
  const merged = { ...current, ...changes };
  const arrayFields: (keyof ConversationState)[] = ['confirmedItems', 'questionsAsked', 'upsellItems'];
  for (const field of arrayFields) {
    const currentArr = current[field] as string[] | undefined;
    const changesArr = changes[field] as string[] | undefined;
    if (changesArr && currentArr) {
      (merged as any)[field] = [...new Set([...currentArr, ...changesArr])];
    }
  }
  return merged;
}

async function runTest() {
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

  // Find an active rental with follow_up_state for testing
  const testState = await prisma.follow_up_state.findFirst({
    where: { status: 'active' },
    select: { id: true, rental_id: true, structured_state: true },
    orderBy: { updated_at: 'desc' },
  });

  if (!testState) {
    console.log('No active follow_up_state found — cannot run context persistence test');
    await prisma.$disconnect();
    return;
  }

  const originalState = testState.structured_state;
  const rentalId = testState.rental_id;
  console.log(`\nUsing rental ${rentalId} for context persistence test\n`);

  // ── SIMULATE 5 CONVERSATION TURNS ──

  console.log('=== TURN 1: Renter asks about FX3 availability ===');
  // AI extracts: confirmed interest in FX3, asked about shoot type
  let state: ConversationState = {};
  state = mergeState(state, {
    confirmedItems: ['Sony FX3'],
    questionsAsked: ['what the shoot is for'],
  });
  await prisma.follow_up_state.update({
    where: { id: testState.id },
    data: { structured_state: state as any },
  });
  let dbState = (await prisma.follow_up_state.findUnique({
    where: { id: testState.id },
    select: { structured_state: true },
  }))?.structured_state as ConversationState;
  assert('Turn 1: confirmedItems = [Sony FX3]', JSON.stringify(dbState?.confirmedItems) === '["Sony FX3"]');
  assert('Turn 1: questionsAsked = [shoot type]', dbState?.questionsAsked?.length === 1);

  console.log('\n=== TURN 2: Renter says "wedding shoot, need a lens too" ===');
  // AI extracts: shoot type, added lens interest, asked about dates
  state = mergeState(state, {
    renterShootType: 'wedding',
    confirmedItems: ['Sony GM 24-70mm f2.8'],
    questionsAsked: ['preferred dates'],
  });
  await prisma.follow_up_state.update({
    where: { id: testState.id },
    data: { structured_state: state as any },
  });
  dbState = (await prisma.follow_up_state.findUnique({
    where: { id: testState.id },
    select: { structured_state: true },
  }))?.structured_state as ConversationState;
  assert('Turn 2: confirmedItems accumulated to 2', dbState?.confirmedItems?.length === 2);
  assert('Turn 2: questionsAsked accumulated to 2', dbState?.questionsAsked?.length === 2);
  assert('Turn 2: renterShootType = wedding', dbState?.renterShootType === 'wedding');
  assert('Turn 2: FX3 still in confirmedItems', dbState?.confirmedItems?.includes('Sony FX3') === true);

  console.log('\n=== TURN 3: Bot quotes price, suggests wireless mic (upsell) ===');
  state = mergeState(state, {
    priceQuoted: 275,
    upsellAttempted: true,
    upsellItems: ['Rode Wireless GO II'],
  });
  await prisma.follow_up_state.update({
    where: { id: testState.id },
    data: { structured_state: state as any },
  });
  dbState = (await prisma.follow_up_state.findUnique({
    where: { id: testState.id },
    select: { structured_state: true },
  }))?.structured_state as ConversationState;
  assert('Turn 3: priceQuoted = 275', dbState?.priceQuoted === 275);
  assert('Turn 3: upsellAttempted = true', dbState?.upsellAttempted === true);
  assert('Turn 3: upsellItems = [Rode Wireless GO II]', dbState?.upsellItems?.length === 1);
  assert('Turn 3: all previous state preserved', dbState?.renterShootType === 'wedding' && dbState?.confirmedItems?.length === 2);

  console.log('\n=== TURN 4: Renter agrees on pickup time, asks about delivery ===');
  state = mergeState(state, {
    agreedPickupTime: 'Friday 10am',
    deliveryDiscussed: true,
    questionsAsked: ['delivery options'],
  });
  await prisma.follow_up_state.update({
    where: { id: testState.id },
    data: { structured_state: state as any },
  });
  dbState = (await prisma.follow_up_state.findUnique({
    where: { id: testState.id },
    select: { structured_state: true },
  }))?.structured_state as ConversationState;
  assert('Turn 4: agreedPickupTime = Friday 10am', dbState?.agreedPickupTime === 'Friday 10am');
  assert('Turn 4: deliveryDiscussed = true', dbState?.deliveryDiscussed === true);
  assert('Turn 4: questionsAsked accumulated to 3', dbState?.questionsAsked?.length === 3);
  assert('Turn 4: no duplicate in questionsAsked', new Set(dbState?.questionsAsked).size === dbState?.questionsAsked?.length);

  console.log('\n=== TURN 5: Renter confirms return time ===');
  state = mergeState(state, {
    agreedReturnTime: 'Monday 6pm',
    confirmedItems: ['Sony FX3'], // Duplicate — should NOT create duplicate entry
  });
  await prisma.follow_up_state.update({
    where: { id: testState.id },
    data: { structured_state: state as any },
  });
  dbState = (await prisma.follow_up_state.findUnique({
    where: { id: testState.id },
    select: { structured_state: true },
  }))?.structured_state as ConversationState;
  assert('Turn 5: agreedReturnTime = Monday 6pm', dbState?.agreedReturnTime === 'Monday 6pm');
  assert('Turn 5: confirmedItems still 2 (no duplicate)', dbState?.confirmedItems?.length === 2);

  // ── VERIFY FULL STATE INTEGRITY AFTER 5 TURNS ──
  console.log('\n=== FINAL STATE INTEGRITY CHECK ===');
  assert('Final: confirmedItems = [Sony FX3, Sony GM 24-70mm f2.8]',
    dbState?.confirmedItems?.includes('Sony FX3') === true &&
    dbState?.confirmedItems?.includes('Sony GM 24-70mm f2.8') === true);
  assert('Final: renterShootType = wedding', dbState?.renterShootType === 'wedding');
  assert('Final: agreedPickupTime = Friday 10am', dbState?.agreedPickupTime === 'Friday 10am');
  assert('Final: agreedReturnTime = Monday 6pm', dbState?.agreedReturnTime === 'Monday 6pm');
  assert('Final: priceQuoted = 275', dbState?.priceQuoted === 275);
  assert('Final: upsellAttempted = true', dbState?.upsellAttempted === true);
  assert('Final: deliveryDiscussed = true', dbState?.deliveryDiscussed === true);
  assert('Final: 3 unique questions tracked', dbState?.questionsAsked?.length === 3);

  // ── VERIFY PROMPT GENERATION WOULD USE THIS STATE ──
  console.log('\n=== PROMPT GENERATION CHECK ===');
  // Simulate what autonomous.service.ts does with the state
  const convState = dbState!;
  const parts: string[] = [];
  if (convState.confirmedItems?.length) parts.push(`Confirmed items: ${convState.confirmedItems.join(', ')}`);
  if (convState.agreedPickupTime) parts.push(`Agreed pickup: ${convState.agreedPickupTime}`);
  if (convState.agreedReturnTime) parts.push(`Agreed return: ${convState.agreedReturnTime}`);
  if (convState.renterShootType) parts.push(`Shoot type: ${convState.renterShootType}`);
  if (convState.questionsAsked?.length) parts.push(`Already asked: ${convState.questionsAsked.join(', ')}`);
  if (convState.upsellAttempted) parts.push('Upselling already attempted — do NOT upsell again');
  if (convState.priceQuoted) parts.push(`Last price quoted: £${convState.priceQuoted}`);
  if (convState.deliveryDiscussed) parts.push('Delivery already discussed');

  const contextBlock = `\n--- CONVERSATION STATE ---\n${parts.join('\n')}\nDo NOT re-ask questions listed above. Do NOT repeat information already established.\n`;

  assert('Context block mentions confirmed items', contextBlock.includes('Sony FX3') && contextBlock.includes('Sony GM 24-70mm'));
  assert('Context block has pickup time', contextBlock.includes('Friday 10am'));
  assert('Context block has return time', contextBlock.includes('Monday 6pm'));
  assert('Context block has shoot type', contextBlock.includes('wedding'));
  assert('Context block has anti-upsell', contextBlock.includes('do NOT upsell again'));
  assert('Context block has price quoted', contextBlock.includes('£275'));
  assert('Context block has anti-repeat instruction', contextBlock.includes('Do NOT re-ask'));
  assert('Context block has already-asked questions', contextBlock.includes('delivery options'));

  console.log('\nGenerated context block:');
  console.log(contextBlock);

  // ── CLEANUP: Restore original state ──
  await prisma.follow_up_state.update({
    where: { id: testState.id },
    data: { structured_state: (originalState as any) || undefined },
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log(`${'='.repeat(50)}\n`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runTest().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
