/**
 * TEST SUITE: 7 Bot Behavior Fixes
 * Validates all changes from the seven-fixes plan:
 *   A) V-mount accessories included
 *   B) No downselling
 *   C) Contextual recommendations
 *   D) No possessive "my gear" language
 *   E) 10am pickup priority
 *   F) Half-day extension / return timing
 *   G) Location lock
 *   H) Modular prompt path coverage (rules reach the live bot)
 *   I) Simulation mode coverage (rules reach Telegram simulation)
 *   J) Database staleness patch (prompt-manager updates stale components)
 *
 * 42 tests total.
 */

const fs = require('fs');
const path = require('path');
const readSource = (relPath: string) => fs.readFileSync(path.join(__dirname, relPath), 'utf8');

const compatibilitySrc = readSource('data/item-compatibility.ts');
const aiSrc = readSource('ai/ai.service.ts');
const rulesSrc = readSource('rules/rules.service.ts');
const memorySrc = readSource('memory/memory.service.ts');
const promptManagerSrc = readSource('prompts/prompt-manager.service.ts');
const conversationStageSrc = readSource('conversation-tree/conversation-stage.service.ts');
const upsellSrc = readSource('upsell/upsell.service.ts');
const telegramSrc = readSource('telegram/telegram.service.ts');

// ═══════════════════════════════════════════════════════════════
// ISSUE A: V-mount accessories included in sets (3 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue A: V-mount accessories included in sets', () => {
  test('A1: FX3 notes say "V-mount battery rental includes" not "via plate"', () => {
    // The old text "V-mount for external power via plate" implied renters need separate plate
    expect(compatibilitySrc).toContain('V-mount battery rental includes all necessary plates, adapters, and cables for external power');
    expect(compatibilitySrc).not.toContain('V-mount for external power via plate');
  });

  test('A2: BMPCC notes mention V-mount battery rental includes all accessories', () => {
    // Both BMPCC 6K Pro and BMPCC 6K Full Frame should mention this
    const bmpccMatches = compatibilitySrc.match(/V-mount battery rental includes all necessary plates, adapters, and cables/g);
    // At least 2 BMPCC cameras + FX3 = 3 total matches
    expect(bmpccMatches).not.toBeNull();
    expect(bmpccMatches!.length).toBeGreaterThanOrEqual(3);
  });

  test('A3: ai.service has V-MOUNT ACCESSORIES INCLUDED rule', () => {
    expect(aiSrc).toContain('V-MOUNT ACCESSORIES INCLUDED');
    expect(aiSrc).toContain('Do NOT tell renters they need to get separate plates or adapters');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE B: No downselling (3 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue B: No downselling — never say "enough"', () => {
  test('B1: rules has anti-downselling on batteries', () => {
    expect(rulesSrc).toContain('NEVER tell a renter they have "enough" batteries');
    expect(rulesSrc).toContain('discourage additional battery purchases');
    // Should also distinguish Sony (3x) vs BMPCC (5x) battery counts
    expect(rulesSrc).toContain('Sony cameras come with 3x batteries');
    expect(rulesSrc).toContain('Blackmagic cameras (BMPCC 6K Pro, BMPCC 6K Full Frame) come with 5x LP-E6NH');
  });

  test('B2: memory RULE 13 forbids discouraging purchases', () => {
    expect(memorySrc).toContain('Do NOT use included batteries as a reason to discourage additional battery or power accessory purchases');
  });

  test('B3: ai.service has NO-DOWNSELLING RULE', () => {
    expect(aiSrc).toContain('NO-DOWNSELLING RULE (CRITICAL)');
    expect(aiSrc).toContain('never to downsell');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE C: Contextual recommendations (3 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue C: Contextual recommendations — ask what they\'re shooting', () => {
  test('C1: INQUIRY stage mentions asking what the project is', () => {
    expect(conversationStageSrc).toContain('what the project is');
    expect(conversationStageSrc).toContain('recommend the right gear');
  });

  test('C2: ai.service has CONTEXTUAL RECOMMENDATIONS', () => {
    expect(aiSrc).toContain('CONTEXTUAL RECOMMENDATIONS');
    expect(aiSrc).toContain('What is the shoot for');
  });

  test('C3: upsell condition no longer requires recommendations.length === 0', () => {
    // The old condition was: if (!useCase && recommendations.length === 0 && !hasAudio)
    // The new condition should be: if (!useCase && !hasAudio)
    expect(upsellSrc).not.toContain('recommendations.length === 0 && !hasAudio');
    expect(upsellSrc).toContain('if (!useCase && !hasAudio)');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE D: No possessive "my gear" language (8 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue D: No possessive "my gear" language', () => {
  test('D1: ai.service forbids "my gear"', () => {
    expect(aiSrc).toContain('"my gear"');
    expect(aiSrc).toContain('Never say');
  });

  test('D2: ai.service forbids "my items"', () => {
    expect(aiSrc).toContain('"my items"');
  });

  test('D3: ai.service forbids "my equipment"', () => {
    expect(aiSrc).toContain('"my equipment"');
  });

  test('D4: ai.service forbids "my stuff"', () => {
    expect(aiSrc).toContain('"my stuff"');
  });

  test('D5: prompt-manager seed identity uses "The business has" not "You\'ve got"', () => {
    // The seed content for the identity component should use "The business has"
    // (staleFragment reference in ensureUpdatedComponents is expected — it patches old DB records)
    const identityContentMatch = promptManagerSrc.match(/name:\s*'identity'[\s\S]*?content:\s*`([^`]+)`/);
    expect(identityContentMatch).not.toBeNull();
    expect(identityContentMatch![1]).toContain('The business has 63+');
    expect(identityContentMatch![1]).not.toContain("You've got 63+");
  });

  test('D6: prompt-manager has "The business has 63+"', () => {
    expect(promptManagerSrc).toContain('The business has 63+');
  });

  test('D7: prompt-manager seed location_rules uses "we have it available" not "I have it here"', () => {
    // The seed location_rules component should use "we have it available"
    // (staleFragment reference in ensureUpdatedComponents is expected — it patches old DB records)
    const locationContentMatch = promptManagerSrc.match(/name:\s*'location_rules'[\s\S]*?content:\s*`([\s\S]*?)`/);
    expect(locationContentMatch).not.toBeNull();
    expect(locationContentMatch![1]).toContain('we have it available');
    expect(locationContentMatch![1]).not.toContain('I have it here');
  });

  test('D8: prompt-manager has "we have it available"', () => {
    expect(promptManagerSrc).toContain('we have it available');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE E: Vacation pickup — offer 10am first (3 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue E: Vacation pickup — offer 10am first', () => {
  test('E1: ai.service has "PICKUP SLOT PRIORITY" and "10am" first', () => {
    expect(aiSrc).toContain('PICKUP SLOT PRIORITY');
    expect(aiSrc).toContain('10am pickup slot FIRST');
  });

  test('E2: day-before pickup has tiered pricing (free over £40, +30% under £40)', () => {
    expect(aiSrc).toContain('FREE for rentals over £40');
    expect(aiSrc).toContain('+30% surcharge');
  });

  test('E3: rules Working Hours has "morning slot first" and DJ delivery mandatory', () => {
    expect(rulesSrc).toContain('morning slot (10am-12pm) first');
    expect(rulesSrc).toContain('DJ deck + speakers together = delivery is MANDATORY');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE F: Return timing — half-day extension rule (5 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue F: Return timing — get gear back ASAP, half-day rule', () => {
  test('F1: ai.service RETURN PRIORITY with "earliest possible return slot"', () => {
    expect(aiSrc).toContain('RETURN PRIORITY (CRITICAL)');
    expect(aiSrc).toContain('earliest possible return slot');
  });

  test('F2: ai.service mentions half-day grace only for 1-day rentals', () => {
    expect(aiSrc).toContain('Half-day grace ONLY applies to 1-day rentals');
  });

  test('F3: rules has "Return Timing Priority"', () => {
    expect(rulesSrc).toContain('Return Timing Priority');
    expect(rulesSrc).toContain('EARLIEST possible return slot');
  });

  test('F4: rules has half-day grace only for 1-day rentals', () => {
    expect(rulesSrc).toContain('Half-day grace applies ONLY to 1-day rentals');
    expect(rulesSrc).toContain('extension');
  });

  test('F5: memory RULE 19 has "HALF-DAY RULE" scoped to 1-day rentals', () => {
    expect(memorySrc).toContain('HALF-DAY RULE (1-DAY RENTALS ONLY)');
    expect(memorySrc).toContain('earliest return slot first');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE G: Location lock — first location is authoritative (3 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue G: Location lock — first mentioned location is authoritative', () => {
  test('G1: ai.service LOCATION LOCK + "START of the conversation"', () => {
    expect(aiSrc).toContain('LOCATION LOCK');
    expect(aiSrc).toContain('START of the conversation');
  });

  test('G2: ai.service says "do NOT update your assumption"', () => {
    expect(aiSrc).toContain('do NOT update your assumption');
  });

  test('G3: rules has "Renter Location Lock" + "authoritative location"', () => {
    expect(rulesSrc).toContain('Renter Location Lock');
    expect(rulesSrc).toContain('authoritative location');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE H: Modular prompt path — rules reach the live bot (7 tests)
// USE_MODULAR_PROMPTS=true means buildModularPrompt() is the LIVE path
// ═══════════════════════════════════════════════════════════════
describe('Issue H: Modular prompt path — behavioral rules reach live bot', () => {
  // Extract just the buildModularPrompt method body
  const modularMatch = aiSrc.match(/buildModularPrompt[\s\S]*?return parts\.join/);
  const modularPromptSrc = modularMatch ? modularMatch[0] : '';

  test('H1: buildModularPrompt includes V-MOUNT ACCESSORIES INCLUDED', () => {
    expect(modularPromptSrc).toContain('V-MOUNT ACCESSORIES INCLUDED');
  });

  test('H2: buildModularPrompt includes NO-DOWNSELLING RULE', () => {
    expect(modularPromptSrc).toContain('NO-DOWNSELLING RULE');
  });

  test('H3: buildModularPrompt includes LANGUAGE RULE forbidding "my gear"', () => {
    expect(modularPromptSrc).toContain('"my gear"');
    expect(modularPromptSrc).toContain('"my items"');
  });

  test('H4: buildModularPrompt includes PICKUP SLOT PRIORITY', () => {
    expect(modularPromptSrc).toContain('PICKUP SLOT PRIORITY');
  });

  test('H5: buildModularPrompt includes RETURN PRIORITY', () => {
    expect(modularPromptSrc).toContain('RETURN PRIORITY');
  });

  test('H6: buildModularPrompt includes LOCATION LOCK', () => {
    expect(modularPromptSrc).toContain('LOCATION LOCK');
  });

  test('H7: buildModularPrompt includes CONTEXTUAL RECOMMENDATIONS', () => {
    expect(modularPromptSrc).toContain('CONTEXTUAL RECOMMENDATIONS');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE I: Simulation mode — rules reach Telegram simulation (4 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue I: Simulation mode — behavioral rules in Telegram simulation', () => {
  test('I1: Telegram simulation forbids "my gear" / "my items" / "my equipment" / "my stuff"', () => {
    expect(telegramSrc).toContain('"my gear"');
    expect(telegramSrc).toContain('"my items"');
    expect(telegramSrc).toContain('"my equipment"');
    expect(telegramSrc).toContain('"my stuff"');
  });

  test('I2: Telegram simulation has no-downselling rule', () => {
    expect(telegramSrc).toContain('NO DOWNSELLING');
    expect(telegramSrc).toContain('never downsell');
  });

  test('I3: Telegram simulation has pickup priority and return priority with tiered fees', () => {
    expect(telegramSrc).toContain('PICKUP PRIORITY');
    expect(telegramSrc).toContain('10am pickup slot FIRST');
    expect(telegramSrc).toContain('RETURN PRIORITY');
    expect(telegramSrc).toContain('earliest possible return slot');
    expect(telegramSrc).toContain('Half-day grace ONLY for 1-day rentals');
  });

  test('I4: Telegram simulation has location lock and V-mount and contextual rules', () => {
    expect(telegramSrc).toContain('LOCATION LOCK');
    expect(telegramSrc).toContain('V-MOUNT');
    expect(telegramSrc).toContain('CONTEXTUAL');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE J: Database staleness — prompt-manager patches old components (3 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue J: Database staleness — prompt-manager patches stale components', () => {
  test('J1: prompt-manager has ensureUpdatedComponents method', () => {
    expect(promptManagerSrc).toContain('ensureUpdatedComponents');
  });

  test('J2: ensureUpdatedComponents patches stale "You\'ve got 63+" in identity', () => {
    expect(promptManagerSrc).toContain("staleFragment: \"You've got 63+\"");
  });

  test('J3: ensureUpdatedComponents patches stale "I have it here in Central London" in location_rules', () => {
    expect(promptManagerSrc).toContain("staleFragment: 'I have it here in Central London'");
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE K: Final enforcement block — rules at end of prompt (5 tests)
// Last position in the prompt has highest AI weight
// ═══════════════════════════════════════════════════════════════
describe('Issue K: Final enforcement block at end of prompt', () => {
  test('K1: buildModularPrompt has FINAL ENFORCEMENT section', () => {
    expect(aiSrc).toContain('FINAL ENFORCEMENT (HIGHEST PRIORITY)');
  });

  test('K2: Final enforcement includes NEVER DOWNSELL with "enough" keyword', () => {
    expect(aiSrc).toContain('NEVER DOWNSELL');
    expect(aiSrc).toContain('Do NOT say a renter has "enough"');
  });

  test('K3: Final enforcement has day-before/morning-after fee rules', () => {
    expect(aiSrc).toContain('DAY-BEFORE/MORNING-AFTER FEES');
    expect(aiSrc).toContain('For larger orders');
    expect(aiSrc).toContain('small fee applies');
  });

  test('K4: Final enforcement includes V-mount and BMPCC battery rules', () => {
    const modularMatch = aiSrc.match(/FINAL ENFORCEMENT[\s\S]*?V-MOUNT ACCESSORIES/);
    expect(modularMatch).not.toBeNull();
    expect(aiSrc).toContain('BMPCC BATTERY COUNT (CRITICAL)');
    expect(aiSrc).toContain('5x LP-E6NH batteries');
    expect(aiSrc).toContain('NEVER say 2x or 3x');
  });

  test('K5: Final enforcement includes DJ delivery mandatory and same-day rules', () => {
    expect(aiSrc).toContain('DJ + SPEAKERS: Delivery is MANDATORY');
    expect(aiSrc).toContain('SAME-DAY RENTALS: NEVER auto-approve');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE L: BMPCC battery count = 5x LP-E6NH (5 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue L: BMPCC battery count — 5x LP-E6NH', () => {
  test('L1: item-compatibility has 5x LP-E6NH for BMPCC 6K Pro', () => {
    expect(compatibilitySrc).toContain("'5x LP-E6NH batteries'");
  });

  test('L2: item-compatibility has 5x LP-E6NH for BMPCC 6K Full Frame', () => {
    const matches = compatibilitySrc.match(/5x LP-E6NH batteries/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  test('L3: rules has 5x LP-E6NH for Blackmagic cameras', () => {
    expect(rulesSrc).toContain('5x LP-E6NH batteries');
  });

  test('L4: memory has 5x LP-E6NH for BMPCC cameras', () => {
    expect(memorySrc).toContain('5x LP-E6NH batteries');
  });

  test('L5: Telegram simulation has BMPCC 5x LP-E6NH rule', () => {
    expect(telegramSrc).toContain('5x LP-E6NH');
    expect(telegramSrc).toContain('NEVER say 2x or 3x');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE M: Tiered fee structure (5 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue M: Tiered fee — free over £40, +30% under £40', () => {
  test('M1: ai.service has tiered fee rule in VACATION section', () => {
    expect(aiSrc).toContain('OVER £40, day-before evening pickup and morning-after return are BOTH FREE');
    expect(aiSrc).toContain('UNDER £40, a small fee applies');
  });

  test('M2: rules Day Before/After has tiered pricing', () => {
    expect(rulesSrc).toContain('FREE for rentals totalling over £40');
    expect(rulesSrc).toContain('+30% surcharge');
  });

  test('M3: memory General Exceptions has tiered pricing', () => {
    expect(memorySrc).toContain('FREE for larger orders');
    expect(memorySrc).toContain('small fee for smaller orders');
  });

  test('M4: Telegram simulation has tiered day-before/morning-after rules', () => {
    expect(telegramSrc).toContain('FREE for larger orders');
    expect(telegramSrc).toContain('small fee for smaller orders');
  });

  test('M5: Evening next day = always full extra day', () => {
    expect(aiSrc).toContain('Evening next day');
    expect(aiSrc).toContain('full extra day');
    expect(rulesSrc).toContain('Evening NEXT day');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE N: DJ delivery mandatory + same-day rules (4 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue N: DJ delivery mandatory + same-day approval', () => {
  test('N1: ai.service has DJ delivery mandatory rule', () => {
    expect(aiSrc).toContain('DJ DECK + SPEAKERS: Delivery is MANDATORY');
  });

  test('N2: ai.service has same-day rental approval rule', () => {
    expect(aiSrc).toContain('SAME-DAY RENTALS: NEVER auto-approve');
  });

  test('N3: Telegram simulation has DJ delivery rule', () => {
    expect(telegramSrc).toContain('DJ + SPEAKERS');
    expect(telegramSrc).toContain('MANDATORY');
  });

  test('N4: Telegram simulation has same-day rental rule', () => {
    expect(telegramSrc).toContain('SAME-DAY RENTALS');
    expect(telegramSrc).toContain('NEVER auto-approve');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE O: Timing optimization — correlate with calendar (2 tests)
// ═══════════════════════════════════════════════════════════════
describe('Issue O: Timing optimization — correlate with other bookings', () => {
  test('O1: ai.service has timing optimization rule', () => {
    expect(aiSrc).toContain('TIMING OPTIMIZATION');
    expect(aiSrc).toContain('align with other existing bookings');
  });

  test('O2: Telegram simulation has timing rule', () => {
    expect(telegramSrc).toContain('TIMING');
    expect(telegramSrc).toContain('minimize');
  });
});
