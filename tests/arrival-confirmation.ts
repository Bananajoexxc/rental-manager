/**
 * Test: Arrival Confirmation System
 * Verifies:
 * 1. Arrival detection regex catches all expected phrases
 * 2. Detection does NOT false-positive on normal messages
 * 3. State machine: pickup → return → done (permanent)
 * 4. No spam: messages only sent once per phase
 */

// --- Test 1: Arrival detection patterns ---
const arrivalPatterns = /\b(arrived|i'?m here|im here|i am here|here now|outside|at the door|downstairs|at the spot|at the location|at the pickup|at the meeting|i'?ve arrived|just arrived|just got here|waiting outside|i'?m at|we'?re here|at trafalgar|by the statue)\b/i;

const SHOULD_MATCH = [
  'arrived',
  'I arrived',
  "I'm here",
  'im here',
  'I am here',
  'here now',
  'outside',
  'I am outside',
  'at the door',
  'downstairs',
  'at the spot',
  'at the location',
  "I've arrived",
  'just arrived',
  'just got here',
  'waiting outside',
  "we're here",
  'at trafalgar',
  'by the statue',
  'Hey I just arrived!',
  'We just got here, where are you?',
  "I'm at trafalgar square",
  'Arrived, waiting by the statue',
  'im here where do i go',
];

const SHOULD_NOT_MATCH = [
  'what time should I arrive?',
  'when did you arrive?',
  'can I arrive early?',
  'Hi, I want to rent a camera',
  'Is the Sony FX3 available?',
  'Sounds good, booking sent',
  'How much per day?',
  'Can you deliver?',
  'Thanks for the rental',
  'Great service!',
  "I'll be there at 10am",
  'See you tomorrow',
  'What gear do you have?',
];

let passed = 0;
let failed = 0;

console.log('\n=== TEST 1: Arrival Detection Patterns ===\n');

console.log('--- Should MATCH ---');
for (const phrase of SHOULD_MATCH) {
  const matches = arrivalPatterns.test(phrase.toLowerCase().trim());
  if (matches) {
    passed++;
    console.log(`  ✅ "${phrase}"`);
  } else {
    failed++;
    console.log(`  ❌ MISS: "${phrase}"`);
  }
}

console.log('\n--- Should NOT match ---');
for (const phrase of SHOULD_NOT_MATCH) {
  const matches = arrivalPatterns.test(phrase.toLowerCase().trim());
  if (!matches) {
    passed++;
    console.log(`  ✅ No match: "${phrase}"`);
  } else {
    failed++;
    console.log(`  ❌ FALSE POSITIVE: "${phrase}"`);
  }
}

// --- Test 2: State machine logic ---
console.log('\n=== TEST 2: State Machine Logic ===\n');

interface BookingState {
  pickup_arrival_confirmed: boolean;
  return_arrival_confirmed: boolean;
  pickup_arrival_sent_at: Date | null;
  pickup_arrival_followup_sent: boolean;
  return_arrival_sent_at: Date | null;
  return_arrival_followup_sent: boolean;
}

function simulatePhaseDetection(state: BookingState): 'pickup' | 'return' | null {
  if (state.pickup_arrival_confirmed && !state.return_arrival_confirmed) return 'return';
  if (!state.pickup_arrival_confirmed) return 'pickup';
  return null; // Both confirmed — permanently done
}

// Initial state: nothing confirmed
const state: BookingState = {
  pickup_arrival_confirmed: false,
  return_arrival_confirmed: false,
  pickup_arrival_sent_at: null,
  pickup_arrival_followup_sent: false,
  return_arrival_sent_at: null,
  return_arrival_followup_sent: false,
};

let phase = simulatePhaseDetection(state);
if (phase === 'pickup') { passed++; console.log('  ✅ Initial state → pickup phase'); }
else { failed++; console.log(`  ❌ Expected pickup, got ${phase}`); }

// After pickup confirmed
state.pickup_arrival_confirmed = true;
phase = simulatePhaseDetection(state);
if (phase === 'return') { passed++; console.log('  ✅ After pickup confirmed → return phase'); }
else { failed++; console.log(`  ❌ Expected return, got ${phase}`); }

// After return confirmed
state.return_arrival_confirmed = true;
phase = simulatePhaseDetection(state);
if (phase === null) { passed++; console.log('  ✅ After return confirmed → permanently done (null)'); }
else { failed++; console.log(`  ❌ Expected null (done), got ${phase}`); }

// --- Test 3: No-spam timing logic ---
console.log('\n=== TEST 3: No-Spam Timing Logic ===\n');

function shouldSendArrivalCheck(
  minutesSinceTime: number,
  sentAt: Date | null,
  followupSent: boolean,
  confirmed: boolean,
): { send: boolean; messageNum: 1 | 2 | null } {
  if (confirmed) return { send: false, messageNum: null };
  if (minutesSinceTime >= 5 && !sentAt) return { send: true, messageNum: 1 };
  if (minutesSinceTime >= 15 && sentAt && !followupSent) return { send: true, messageNum: 2 };
  return { send: false, messageNum: null };
}

// Before 5 min: no message
let result = shouldSendArrivalCheck(3, null, false, false);
if (!result.send) { passed++; console.log('  ✅ T+3 min: no message sent'); }
else { failed++; console.log('  ❌ T+3 min should NOT send'); }

// At 5 min: first message
result = shouldSendArrivalCheck(5, null, false, false);
if (result.send && result.messageNum === 1) { passed++; console.log('  ✅ T+5 min: first message sent'); }
else { failed++; console.log('  ❌ T+5 min should send message 1'); }

// At 10 min: no second message yet (only 5 min after first, need 10)
result = shouldSendArrivalCheck(10, new Date(), false, false);
if (!result.send) { passed++; console.log('  ✅ T+10 min: no second message yet (too early)'); }
else { failed++; console.log('  ❌ T+10 min should NOT send second message'); }

// At 15 min: second message
result = shouldSendArrivalCheck(15, new Date(), false, false);
if (result.send && result.messageNum === 2) { passed++; console.log('  ✅ T+15 min: second message sent'); }
else { failed++; console.log('  ❌ T+15 min should send message 2'); }

// After both sent: no more messages
result = shouldSendArrivalCheck(30, new Date(), true, false);
if (!result.send) { passed++; console.log('  ✅ T+30 min: no more messages (both sent)'); }
else { failed++; console.log('  ❌ T+30 min should NOT send any more'); }

// After confirmed: permanent stop
result = shouldSendArrivalCheck(5, null, false, true);
if (!result.send) { passed++; console.log('  ✅ Confirmed: permanently stopped'); }
else { failed++; console.log('  ❌ Confirmed should permanently stop'); }

// Already sent + confirmed: still stopped
result = shouldSendArrivalCheck(20, new Date(), false, true);
if (!result.send) { passed++; console.log('  ✅ Confirmed (after msg 1): still stopped'); }
else { failed++; console.log('  ❌ Confirmed should stop regardless'); }

// --- Summary ---
console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
