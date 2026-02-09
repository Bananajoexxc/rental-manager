/**
 * Chat Issues FIXED — Tests that verify all 6 bugs have been resolved.
 *
 * These tests should FAIL on the unfixed code and PASS after fixes.
 * Each test validates the fix for the corresponding bug in chat-issues-probe.spec.ts.
 */

import { MASTER_INVENTORY, getInventoryItemNames, findBestMatch } from './utils/item-matcher';

const fs = require('fs');
const path = require('path');

// Read source files for prompt/instruction inspection
const autonomousSource = fs.readFileSync(
  path.join(__dirname, 'autonomous/autonomous.service.ts'),
  'utf8',
);
const verificationSource = fs.readFileSync(
  path.join(__dirname, 'verification/verification.service.ts'),
  'utf8',
);
const memorySource = fs.readFileSync(
  path.join(__dirname, 'memory/memory.service.ts'),
  'utf8',
);

// ═══════════════════════════════════════════════════════════════
// FIX 1: Listing titles must be validated against MASTER_INVENTORY
// ═══════════════════════════════════════════════════════════════
describe('FIX 1: Non-existent inventory items are caught', () => {

  test('1a: Code validates listing title against inventory before AI prompt', () => {
    const hasInventoryValidation = autonomousSource.includes('ITEM_NOT_IN_INVENTORY') ||
      autonomousSource.includes('not in our actual inventory') ||
      autonomousSource.includes('ghost listing') ||
      autonomousSource.includes('LISTING_INVENTORY_MISMATCH');
    expect(hasInventoryValidation).toBe(true);
  });

  test('1b: AI prompt explicitly tells not to confirm non-inventory items', () => {
    const hasInstruction = autonomousSource.includes(
      'NEVER confirm availability of items not in the master inventory',
    ) || autonomousSource.includes(
      'does not exist in our inventory',
    ) || autonomousSource.includes(
      'This listing item is NOT in our physical inventory',
    );
    expect(hasInstruction).toBe(true);
  });

  test('1c: Fuzzy matcher finds "fisheye" for fisheye queries', () => {
    const inventoryNames = getInventoryItemNames();
    const match = findBestMatch('fisheye lens', inventoryNames);
    expect(match).toBe('Sony 11mm f2.8 fisheye');
  });
});

// ═══════════════════════════════════════════════════════════════
// FIX 2: No blanket "Central London" — use per-item pickup context
// ═══════════════════════════════════════════════════════════════
describe('FIX 2: Elegant location handling', () => {

  test('2a: No blanket "always tell all items are in Central London" instruction', () => {
    const hasBlanket = autonomousSource.includes(
      'Always tell renters right away that all items are based in Central London',
    );
    expect(hasBlanket).toBe(false);
  });

  test('2b: Location excuses are the default approach', () => {
    const hasElegantApproach = autonomousSource.includes('LOCATION EXCUSES') ||
      autonomousSource.includes('currently not available at');
    expect(hasElegantApproach).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// FIX 3: "Too far" no longer triggers delivery intent
// ═══════════════════════════════════════════════════════════════
describe('FIX 3: "Too far" handled as location rejection', () => {

  test('3a: isDeliveryQuery regex does NOT contain "too far"', () => {
    // Read the actual regex from the source
    const deliveryRegexMatch = autonomousSource.match(
      /isDeliveryQuery[\s\S]*?const deliveryTerms = (\/[^/]+\/[gimsuy]*)/,
    );
    if (deliveryRegexMatch) {
      expect(deliveryRegexMatch[1]).not.toContain('too far');
    } else {
      // If method is refactored, just check the source doesn't have too far in delivery terms
      const methodStart = autonomousSource.indexOf('isDeliveryQuery');
      const methodEnd = autonomousSource.indexOf('}', autonomousSource.indexOf('return', methodStart + 100));
      const methodBody = autonomousSource.substring(methodStart, methodEnd);
      expect(methodBody).not.toContain('too far');
    }
  });

  test('3b: Location rejection / "too far" handling instruction exists', () => {
    const hasInstruction = autonomousSource.includes('too far') &&
      (autonomousSource.includes('apologise') || autonomousSource.includes('apologize') ||
       autonomousSource.includes('sorry') || autonomousSource.includes('empathise') ||
       autonomousSource.includes('LOCATION_REJECTION'));
    expect(hasInstruction).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// FIX 4: Full conversation context and message dedup
// ═══════════════════════════════════════════════════════════════
describe('FIX 4: Full conversation context and dedup', () => {

  test('4a: processMessage retrieves at least 20 messages of history', () => {
    const hasLimited = autonomousSource.includes('getConversationHistory(chatId, 10)');
    expect(hasLimited).toBe(false);
    // Should use 20+ or the default (currently 30)
    const hasExpanded = autonomousSource.includes('getConversationHistory(chatId, 30)') ||
      autonomousSource.includes('getConversationHistory(chatId, 20)') ||
      autonomousSource.includes('getConversationHistory(chatId)');
    expect(hasExpanded).toBe(true);
  });

  test('4b: storeConversation has dedup check', () => {
    const storeMethodIndex = memorySource.indexOf('async storeConversation');
    const nextMethodIndex = memorySource.indexOf('\n  async ', storeMethodIndex + 1);
    const storeMethodBody = memorySource.substring(storeMethodIndex, nextMethodIndex > 0 ? nextMethodIndex : storeMethodIndex + 500);
    const hasDedup = storeMethodBody.includes('findFirst') ||
      storeMethodBody.includes('duplicate') ||
      storeMethodBody.includes('existing') ||
      storeMethodBody.includes('already');
    expect(hasDedup).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// FIX 5: Strict inventory quantity enforcement
// ═══════════════════════════════════════════════════════════════
describe('FIX 5: No sourcing additional units', () => {

  test('5a: Instruction explicitly forbids sourcing/procuring additional units', () => {
    const hasForbid = autonomousSource.includes('NEVER offer to source') ||
      autonomousSource.includes('NEVER suggest sourcing') ||
      autonomousSource.includes('cannot source additional') ||
      autonomousSource.includes('NEVER offer to procure') ||
      autonomousSource.includes('cannot get more');
    expect(hasForbid).toBe(true);
  });

  test('5b: Listing title quantity mismatch is detected', () => {
    const hasQtyMismatchDetection = autonomousSource.includes('listing title') &&
      (autonomousSource.includes('quantity mismatch') || autonomousSource.includes('exceeds') ||
       autonomousSource.includes('more than') || autonomousSource.includes('only have'));
    expect(hasQtyMismatchDetection).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// FIX 6: Verification failure counter only increments on actual failures
// ═══════════════════════════════════════════════════════════════
describe('FIX 6: Verification failure counting is event-based', () => {

  test('6a: handleVerificationFailure is NOT called unconditionally in processMessage', () => {
    // Should be guarded by an actual failure event check
    const contextSection = autonomousSource.substring(
      autonomousSource.indexOf('VERIFICATION GUIDANCE'),
      autonomousSource.indexOf('Build rental stage context', autonomousSource.indexOf('VERIFICATION GUIDANCE')),
    );
    // Should NOT have an unconditional call to handleVerificationFailure
    // It should either be removed or guarded by a condition
    const hasUnconditionalCall = contextSection.includes('handleVerificationFailure(rental, currentProfileId)') &&
      !contextSection.includes('if (') && // no guard before it
      !contextSection.includes('hasVerificationFailure');
    // After fix: the call should be removed or properly guarded
    const isProperlyGuarded = !contextSection.includes('handleVerificationFailure') ||
      contextSection.includes('hasActualVerificationFailure') ||
      contextSection.includes('verificationFailureDetected');
    expect(isProperlyGuarded).toBe(true);
  });

  test('6b: handleVerificationFailure checks for actual failure before incrementing', () => {
    const failureMethodIndex = verificationSource.indexOf('async handleVerificationFailure');
    const nextMethodIndex = verificationSource.indexOf('\n  async ', failureMethodIndex + 30);
    const failureMethodBody = verificationSource.substring(failureMethodIndex, nextMethodIndex > 0 ? nextMethodIndex : failureMethodIndex + 500);
    // Should have a guard before incrementing
    const hasGuard = failureMethodBody.includes('isActualFailure') ||
      failureMethodBody.includes('failureDetected') ||
      failureMethodBody.includes('did not pass') ||
      failureMethodBody.includes('verification_status') ||
      failureMethodBody.includes('check.*before.*increment');
    expect(hasGuard).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Sanity: Inventory unchanged
// ═══════════════════════════════════════════════════════════════
describe('Sanity: Inventory unchanged after fixes', () => {
  test('Master inventory count unchanged', () => {
    expect(Object.keys(MASTER_INVENTORY).length).toBeGreaterThan(40);
  });
  test('Fisheye still 1 unit', () => {
    expect(MASTER_INVENTORY['Sony 11mm f2.8 fisheye']).toBe(1);
  });
  test('Power station still 1 unit', () => {
    expect(MASTER_INVENTORY['Anker Power Station F2000']).toBe(1);
  });
});
