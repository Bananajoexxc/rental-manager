/**
 * Time Extraction Integration Test
 *
 * Sends realistic renter messages through the actual extraction pipeline,
 * watches what gets stored in the booking table, and reports results.
 *
 * Usage: npx ts-node --compiler-options '{"strict":false}' tests/time-extraction-test.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AutonomousService, HyggloMessage } from '../src/autonomous/autonomous.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Test rental: Greg Ratcliffe, confirmed, starts Feb 23, no times
const TEST_RENTAL_ID = 'd470f720-c0fe-47db-869d-63488959a9ed';
const TEST_LISTING_ID = '3747837';

interface TestCase {
  name: string;
  messages: { content: string; description: string }[];
  expected: {
    pickupTime?: string;
    returnTime?: string;
    pickupDate?: string; // YYYY-MM-DD
    returnDate?: string;
  };
}

const TEST_CASES: TestCase[] = [
  {
    name: '1. Vague times — morning/evening',
    messages: [
      { content: 'Hi! Can I collect morning on the 23rd and return evening on the 23rd?', description: 'Vague morning/evening' },
    ],
    expected: { pickupTime: '10:00', returnTime: '19:00' },
  },
  {
    name: '2. Exact times with AM/PM (within slots + DD/MM dates)',
    messages: [
      { content: 'I will pickup at 10am on 23/02 and return at 9pm on 23/02', description: 'Exact with DD/MM dates, slot-valid' },
    ],
    expected: { pickupTime: '10:00', returnTime: '21:00', pickupDate: '2026-02-23', returnDate: '2026-02-23' },
  },
  {
    name: '3. Self-correction in same message (critical test)',
    messages: [
      { content: 'I would love to pickup at 10AM on the 22/02.\nActually scratch that, I would love to pickup at 7PM on the 22/02.\nAnd return at 8PM on the 23/02', description: 'Renter corrects pickup time in same msg' },
    ],
    expected: { pickupTime: '19:00', returnTime: '20:00', pickupDate: '2026-02-22' },
  },
  {
    name: '4. Multi-message negotiation — first message',
    messages: [
      { content: 'Can I collect around 11am?', description: 'Partial — pickup only, no return' },
    ],
    expected: { pickupTime: '11:00' },
  },
  {
    name: '5. Multi-message follow-up — return time added',
    messages: [
      { content: 'And I will return at 8pm', description: 'Follow-up with return time only' },
    ],
    expected: { returnTime: '20:00' },
  },
  {
    name: '6. Evening-before pickup with DD/MM date',
    messages: [
      { content: 'Is it possible to pickup at 8pm on 22/02? My rental starts the 23rd but I need it the evening before. Return will be 7pm on 23/02', description: 'Evening before with explicit DD/MM' },
    ],
    expected: { pickupTime: '20:00', returnTime: '19:00', pickupDate: '2026-02-22', returnDate: '2026-02-23' },
  },
  {
    name: '7. No explicit AM/PM (bare numbers — AI fallback infers)',
    messages: [
      { content: 'pickup at 10, return at 7', description: 'Bare numbers — regex drops, AI infers' },
    ],
    expected: { pickupTime: '10:00', returnTime: '19:00' }, // AI correctly infers AM for 10, PM for 7
  },
  {
    name: '8. Arrival ETA should NOT change times',
    messages: [
      { content: 'On my way, be there at 11:32', description: 'ETA — not a time change' },
    ],
    expected: {}, // Should not change anything
  },
  {
    name: '9. Deferral rejection — "I will let you know later"',
    messages: [
      { content: 'I will let you know the times later', description: 'Deferral — should push back, not store' },
    ],
    expected: {}, // Should not store any time, should push back
  },
  {
    name: '10. Slot enforcement — 2pm rejected',
    messages: [
      { content: 'Can I pickup at 2pm on the 23rd?', description: 'Outside slot (2pm not in 10-12 or 7-9)' },
    ],
    expected: {}, // Should not store — outside slots
  },
  {
    name: '11. Valid slot — 10am pickup accepted',
    messages: [
      { content: 'I will pickup at 10am and return at 7pm', description: 'Both within slots' },
    ],
    expected: { pickupTime: '10:00', returnTime: '19:00' },
  },
];

async function main() {
  console.log('🔧 Bootstrapping NestJS app...');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const autonomousService = app.get(AutonomousService);
  const prisma = app.get(PrismaService);

  // Get test rental
  const rental = await prisma.rental.findUnique({
    where: { id: TEST_RENTAL_ID },
    include: { bookings: true },
  });
  if (!rental) {
    console.error('❌ Test rental not found:', TEST_RENTAL_ID);
    await app.close();
    return;
  }
  console.log(`📦 Test rental: ${rental.title}`);
  console.log(`👤 Renter: ${rental.renter_info}`);
  console.log(`📅 Period: ${rental.start_date?.toISOString().slice(0, 10)} to ${rental.end_date?.toISOString().slice(0, 10)}`);
  console.log(`📋 Bookings: ${rental.bookings.length}`);
  console.log('');

  // Save original booking state
  const originalBookings = await prisma.booking.findMany({
    where: { rental_id: TEST_RENTAL_ID },
    select: { id: true, pickup_time: true, return_time: true, pickup_date: true, return_date: true },
  });

  let passed = 0;
  let failed = 0;
  const results: string[] = [];

  for (const tc of TEST_CASES) {
    console.log(`\n═══ ${tc.name} ═══`);

    // Reset booking times before each test
    await prisma.booking.updateMany({
      where: { rental_id: TEST_RENTAL_ID },
      data: { pickup_time: null, return_time: null, pickup_date: null, return_date: null },
    });

    // Send each message through the extraction pipeline
    for (const msg of tc.messages) {
      console.log(`  📨 "${msg.content.substring(0, 80)}${msg.content.length > 80 ? '...' : ''}"`);
      console.log(`     (${msg.description})`);

      const hyggloMsg: HyggloMessage = {
        rentalId: TEST_LISTING_ID,
        sender: rental.renter_info || 'Test Renter',
        content: msg.content,
        timestamp: new Date().toISOString(),
        isNew: true,
      };

      try {
        await autonomousService.extractAndUpdateTimes(rental, hyggloMsg);
      } catch (err) {
        console.log(`  ⚠️ Extraction error: ${err.message}`);
      }

      // Small delay for async operations
      await new Promise(r => setTimeout(r, 500));
    }

    // Read back what got stored
    const booking = await prisma.booking.findFirst({
      where: { rental_id: TEST_RENTAL_ID },
      select: { pickup_time: true, return_time: true, pickup_date: true, return_date: true },
    });

    const actual = {
      pickupTime: booking?.pickup_time || undefined,
      returnTime: booking?.return_time || undefined,
      pickupDate: booking?.pickup_date?.toISOString().slice(0, 10) || undefined,
      returnDate: booking?.return_date?.toISOString().slice(0, 10) || undefined,
    };

    // Compare
    let testPassed = true;
    const checks: string[] = [];

    if (tc.expected.pickupTime !== undefined) {
      if (actual.pickupTime === tc.expected.pickupTime) {
        checks.push(`  ✅ pickupTime: ${actual.pickupTime}`);
      } else {
        checks.push(`  ❌ pickupTime: got ${actual.pickupTime || 'null'}, expected ${tc.expected.pickupTime}`);
        testPassed = false;
      }
    } else if (actual.pickupTime && Object.keys(tc.expected).length === 0) {
      checks.push(`  ❌ pickupTime: got ${actual.pickupTime}, expected null (should not change)`);
      testPassed = false;
    } else if (actual.pickupTime) {
      checks.push(`  ℹ️  pickupTime: ${actual.pickupTime} (not checked)`);
    }

    if (tc.expected.returnTime !== undefined) {
      if (actual.returnTime === tc.expected.returnTime) {
        checks.push(`  ✅ returnTime: ${actual.returnTime}`);
      } else {
        checks.push(`  ❌ returnTime: got ${actual.returnTime || 'null'}, expected ${tc.expected.returnTime}`);
        testPassed = false;
      }
    } else if (actual.returnTime && Object.keys(tc.expected).length === 0) {
      checks.push(`  ❌ returnTime: got ${actual.returnTime}, expected null (should not change)`);
      testPassed = false;
    } else if (actual.returnTime) {
      checks.push(`  ℹ️  returnTime: ${actual.returnTime} (not checked)`);
    }

    if (tc.expected.pickupDate !== undefined) {
      if (actual.pickupDate === tc.expected.pickupDate) {
        checks.push(`  ✅ pickupDate: ${actual.pickupDate}`);
      } else {
        checks.push(`  ❌ pickupDate: got ${actual.pickupDate || 'null'}, expected ${tc.expected.pickupDate}`);
        testPassed = false;
      }
    } else if (actual.pickupDate) {
      checks.push(`  ℹ️  pickupDate: ${actual.pickupDate} (not checked)`);
    }

    if (tc.expected.returnDate !== undefined) {
      if (actual.returnDate === tc.expected.returnDate) {
        checks.push(`  ✅ returnDate: ${actual.returnDate}`);
      } else {
        checks.push(`  ❌ returnDate: got ${actual.returnDate || 'null'}, expected ${tc.expected.returnDate}`);
        testPassed = false;
      }
    } else if (actual.returnDate) {
      checks.push(`  ℹ️  returnDate: ${actual.returnDate} (not checked)`);
    }

    for (const c of checks) console.log(c);

    if (testPassed) {
      console.log(`  ✅ PASSED`);
      passed++;
    } else {
      console.log(`  ❌ FAILED`);
      failed++;
    }
    results.push(`${testPassed ? '✅' : '❌'} ${tc.name}`);
  }

  // Restore original booking state
  for (const ob of originalBookings) {
    await prisma.booking.update({
      where: { id: ob.id },
      data: {
        pickup_time: ob.pickup_time,
        return_time: ob.return_time,
        pickup_date: ob.pickup_date,
        return_date: ob.return_date,
      },
    });
  }

  console.log('\n\n═══════════════════════════════');
  console.log('       TEST RESULTS SUMMARY');
  console.log('═══════════════════════════════');
  for (const r of results) console.log(r);
  console.log(`\n${passed} passed, ${failed} failed out of ${TEST_CASES.length} tests`);
  console.log('═══════════════════════════════');

  await app.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
