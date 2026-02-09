/**
 * Comprehensive test suite for rental manager fixes.
 * Tests 7 issue areas with 3+ scenarios each.
 * Updated to check rules across modular prompt components + telegram service.
 */

import { MASTER_INVENTORY, getInventoryItemNames } from './utils/item-matcher';
import { PRICING_CATALOG } from './data/pricing-catalog';
import { BUNDLE_DEFINITIONS, suggestBundles, suggestBundlesForItems } from './data/bundle-suggestions';
import { DELIVERY_SPECS, getDeliverySpec } from './data/delivery-specs';

const fs = require('fs');
const path = require('path');

// Helper: read source files for rule verification
const readSrc = (relPath: string) => fs.readFileSync(path.join(__dirname, relPath), 'utf8');
const aiSource = readSrc('ai/ai.service.ts');
const promptSource = readSrc('prompts/prompt-manager.service.ts');
const telegramSource = readSrc('telegram/telegram.service.ts');
const deliverySource = readSrc('delivery/delivery.service.ts');

// Combined sources for checking rules across the system
const allPromptSources = aiSource + '\n' + promptSource + '\n' + telegramSource;

// ═══════════════════════════════════════════════════════════════
// ISSUE 1: Vacation Mode - Proactive Time Slot Suggestion
// ═══════════════════════════════════════════════════════════════
describe('Issue 1: Vacation Mode - Proactive Time Slot Suggestion', () => {
  test('Scenario 1: System instructs proactive time slot suggestion before vacation', () => {
    // Now in scheduling_rules component in prompt-manager
    expect(promptSource).toContain('Proactively suggest nearest available time before');
  });

  test('Scenario 2: System instructs free next-morning return for scheduling limitation', () => {
    expect(promptSource).toContain('FREE next-morning return');
  });

  test('Scenario 3: System charges extra day for evening next day', () => {
    expect(promptSource).toContain('Evening next day = always a full extra day');
  });

  test('Scenario 4: Vacation handling proactively suggests alternatives', () => {
    expect(promptSource).toContain('VACATION');
    expect(promptSource).toContain('Proactively suggest');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 1b: Pricing Estimates & Delivery 15% Disclaimer
// ═══════════════════════════════════════════════════════════════
describe('Issue 1b: Pricing Estimates & Delivery Accuracy Disclaimer', () => {
  test('Scenario 1: System mandates pricing is quoted upfront without requiring booking', () => {
    // In pricing_domain and delivery_domain components
    expect(promptSource).toContain("don't make them send a booking request first");
  });

  test('Scenario 2: Pricing framing is natural', () => {
    expect(promptSource).toContain('Frame it natural');
  });

  test('Scenario 3: Delivery estimates include ~15% accuracy disclaimer', () => {
    // In delivery_domain component
    expect(promptSource).toContain('±15%');
  });

  test('Scenario 4: Delivery service code also includes 15% accuracy note', () => {
    expect(deliverySource).toContain('Estimates accurate within ~15%');
    expect(deliverySource).toContain('actual price confirmed by courier');
  });

  test('Scenario 5: Inventory enforcement is generic, not hardcoded to specific items', () => {
    // Should NOT have hardcoded "Sony FX3 max = 3 units"
    expect(aiSource).not.toContain('Sony FX3 max = 3 units');
    // Should have generic inventory enforcement
    expect(allPromptSources).toContain('INVENTORY ENFORCEMENT');
  });

  test('Scenario 6: Inventory enforcement in decision_guidelines', () => {
    expect(promptSource).toContain('does NOT exist in our stock');
    expect(promptSource).toContain('NEVER confirm availability of items not explicitly listed');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 2: FX3 Max Quantity Enforcement (max 3, never 4)
// ═══════════════════════════════════════════════════════════════
describe('Issue 2: FX3 Max Quantity Enforcement', () => {
  test('Scenario 1: MASTER_INVENTORY has Sony FX3 at exactly 3', () => {
    expect(MASTER_INVENTORY['Sony FX3']).toBe(3);
  });

  test('Scenario 2: No 4x Sony FX3 Set exists in pricing catalog', () => {
    const fx3Sets = PRICING_CATALOG.filter(
      (p) => p.item_name.includes('Sony FX3') && p.item_name.includes('Set'),
    );
    const has4xSet = fx3Sets.some((p) => p.item_name.includes('4x'));
    expect(has4xSet).toBe(false);
    const has3xSet = fx3Sets.some((p) => p.item_name.includes('3x'));
    expect(has3xSet).toBe(true);
  });

  test('Scenario 3: Inventory quantity enforcement exists in prompt system', () => {
    // Now in decision_guidelines component and FINAL ENFORCEMENT
    expect(allPromptSources).toContain('INVENTORY ENFORCEMENT');
    expect(allPromptSources).toContain('HALLUCINATION BAN');
  });

  test('Scenario 4: Autonomous service injects MASTER_INVENTORY limits into context', () => {
    const autoSource = readSrc('autonomous/autonomous.service.ts');
    expect(autoSource).toContain('INVENTORY LIMITS');
    expect(autoSource).toContain('MAX');
    expect(autoSource).toContain('NEVER confirm more than these maximums');
  });

  test('Scenario 5: All multi-quantity bundle items do not exceed MASTER_INVENTORY', () => {
    const bundles = PRICING_CATALOG.filter((p) => p.is_bundle && p.bundle_items);
    for (const bundle of bundles) {
      const itemCounts: Record<string, number> = {};
      for (const item of bundle.bundle_items!) {
        itemCounts[item] = (itemCounts[item] || 0) + 1;
      }
      for (const [item, count] of Object.entries(itemCounts)) {
        const maxQty = MASTER_INVENTORY[item];
        if (maxQty !== undefined) {
          expect(count).toBeLessThanOrEqual(maxQty);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 3: Travel Discount Not Mentioned Randomly
// ═══════════════════════════════════════════════════════════════
describe('Issue 3: Travel Discount Timing', () => {
  test('Scenario 1: Travel discount only when location is 20km+', () => {
    // In location_rules component
    expect(promptSource).toContain('20km+');
    expect(promptSource).toContain('10% discount');
  });

  test('Scenario 2: Location rules prevent speculative discount mentions', () => {
    // Travel discount tied to confirmed location
    expect(promptSource).toContain('TRAVEL DISCOUNT');
    expect(promptSource).toContain('renter 20km+ away');
  });

  test('Scenario 3: Discount rules prevent stacking', () => {
    // In pricing_domain component
    expect(allPromptSources).toContain('Discounts');
    // Check DB rules still contain non-stacking rule
    const rulesSource = readSrc('rules/rules.service.ts');
    expect(rulesSource).toContain('Only ONE discount can be applied per booking');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 4: Production Kit Incorrect Items & Bundle Recheck
// ═══════════════════════════════════════════════════════════════
describe('Issue 4: Production Kit Accuracy & Bundle Recheck', () => {
  test('Scenario 1: Sony FX3 Full Production Kit does NOT contain CF Express card', () => {
    const productionKit = PRICING_CATALOG.find(
      (p) => p.item_name === 'Sony FX3 Full Production Kit',
    );
    expect(productionKit).toBeDefined();
    const items = productionKit!.bundle_items || [];
    expect(items.some((i) => i.toLowerCase().includes('cf express'))).toBe(false);
    expect(items.some((i) => i.toLowerCase().includes('cfexpress'))).toBe(false);
  });

  test('Scenario 2: Sony FX3 Full Production Kit does NOT contain suction cups', () => {
    const productionKit = PRICING_CATALOG.find(
      (p) => p.item_name === 'Sony FX3 Full Production Kit',
    );
    expect(productionKit).toBeDefined();
    const items = productionKit!.bundle_items || [];
    expect(items.some((i) => i.toLowerCase().includes('suction'))).toBe(false);
  });

  test('Scenario 3: Production Kit contains exactly the correct 6 items', () => {
    const productionKit = PRICING_CATALOG.find(
      (p) => p.item_name === 'Sony FX3 Full Production Kit',
    );
    expect(productionKit).toBeDefined();
    expect(productionKit!.bundle_items).toEqual([
      'Sony FX3',
      'Sony GM 24-70mm f2.8',
      'DJI RS3 Pro gimbal',
      'Rode Wireless Mic Pro set',
      'Atomos Ninja V',
      'ND filter',
    ]);
  });

  test('Scenario 4: Bundle-intelligence service Production Kit matches pricing catalog', () => {
    const bundleIntSource = readSrc('bundles/bundle-intelligence.service.ts');
    expect(bundleIntSource).not.toMatch(/items:.*CFexpress/);
    expect(bundleIntSource).not.toMatch(/items:.*NP-FZ100/);
    expect(bundleIntSource).toContain('Sony FX3 Full Production Kit');
    expect(bundleIntSource).toContain('Does NOT include CF Express cards or suction cups');
  });

  test('Scenario 5: All bundle items exist in MASTER_INVENTORY', () => {
    const inventoryNames = getInventoryItemNames();
    const bundlesWithItems = PRICING_CATALOG.filter((p) => p.is_bundle && p.bundle_items);
    const missingItems: string[] = [];
    for (const bundle of bundlesWithItems) {
      for (const item of bundle.bundle_items!) {
        if (!inventoryNames.includes(item)) {
          missingItems.push(`${bundle.item_name} -> ${item}`);
        }
      }
    }
    expect(missingItems).toEqual([]);
  });

  test('Scenario 6: Production Kit note explicitly excludes CF Express and suction cups', () => {
    const productionKit = PRICING_CATALOG.find(
      (p) => p.item_name === 'Sony FX3 Full Production Kit',
    );
    expect(productionKit!.multi_day_notes).toContain('Does NOT include CF Express cards or suction cups');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 5: V-Mount Pricing Consistency & Bundle Matching
// ═══════════════════════════════════════════════════════════════
describe('Issue 5: V-Mount Pricing Consistency & Bundle Matching', () => {
  test('Scenario 1: V-mount 95mAh and 150mAh have DIFFERENT prices', () => {
    const vmount95 = PRICING_CATALOG.find((p) => p.item_name === 'V-mount 95mAh');
    const vmount150 = PRICING_CATALOG.find((p) => p.item_name === 'V-mount 150mAh');
    expect(vmount95).toBeDefined();
    expect(vmount150).toBeDefined();
    expect(vmount150!.daily_price_max).toBeGreaterThan(vmount95!.daily_price_max);
    expect(vmount150!.daily_price_min).toBeGreaterThan(vmount95!.daily_price_min);
  });

  test('Scenario 2: Production Kit + V-Mount 95mAh bundle exists', () => {
    const bundle = PRICING_CATALOG.find(
      (p) => p.item_name === 'Sony FX3 Full Production Kit + V-Mount 95mAh',
    );
    expect(bundle).toBeDefined();
    expect(bundle!.bundle_items).toContain('V-mount 95mAh');
    expect(bundle!.daily_price_min).toBeGreaterThan(100);
  });

  test('Scenario 3: Production Kit + V-Mount 150mAh bundle exists and costs more than 95mAh variant', () => {
    const bundle95 = PRICING_CATALOG.find(
      (p) => p.item_name === 'Sony FX3 Full Production Kit + V-Mount 95mAh',
    );
    const bundle150 = PRICING_CATALOG.find(
      (p) => p.item_name === 'Sony FX3 Full Production Kit + V-Mount 150mAh',
    );
    expect(bundle95).toBeDefined();
    expect(bundle150).toBeDefined();
    expect(bundle150!.daily_price_min).toBeGreaterThan(bundle95!.daily_price_min);
    expect(bundle150!.daily_price_max).toBeGreaterThan(bundle95!.daily_price_max);
  });

  test('Scenario 4: V-mount pricing rules exist in compatibility component', () => {
    // Now in compatibility_rules component in prompt-manager
    expect(promptSource).toContain('V-MOUNT');
    expect(promptSource).toContain('DIFFERENT prices');
  });

  test('Scenario 5: Bundle suggestions include V-mount variants for production kit', () => {
    const vmountBundles = BUNDLE_DEFINITIONS.filter(
      (b) => b.bundle_name.includes('Production Kit') && b.bundle_name.includes('V-Mount'),
    );
    expect(vmountBundles.length).toBeGreaterThanOrEqual(2);
  });

  test('Scenario 6: V-mount bundle variant checking exists in compatibility rules', () => {
    // In compatibility_rules component
    expect(promptSource).toContain('check if a bundle variant already includes them');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 6: Nanlite Pavotube Minimum Quantity (2 minimum)
// ═══════════════════════════════════════════════════════════════
describe('Issue 6: Nanlite Pavotube Minimum Quantity', () => {
  test('Scenario 1: Minimum quantity enforcement exists in telegram service', () => {
    // Now in processRenterConversation
    expect(telegramSource).toContain('Nanlite Pavotube 30x II');
    expect(telegramSource).toContain('min: 2');
    expect(telegramSource).toContain('NEVER offer single unit');
  });

  test('Scenario 2: Bundle suggestions for Pavotube start at 2x minimum', () => {
    const pavotubeBundles = BUNDLE_DEFINITIONS.filter(
      (b) => b.bundle_name.toLowerCase().includes('pavotube'),
    );
    expect(pavotubeBundles.length).toBeGreaterThanOrEqual(2);
    const smallestBundle = pavotubeBundles.reduce((smallest, b) =>
      b.items.length < smallest.items.length ? b : smallest,
    );
    expect(smallestBundle.items.length).toBe(2);
    expect(smallestBundle.bundle_name).toContain('2x');
  });

  test('Scenario 3: No single Pavotube listing exists in bundle suggestions', () => {
    const singlePavotube = BUNDLE_DEFINITIONS.filter(
      (b) =>
        b.bundle_name.toLowerCase().includes('pavotube') && b.items.length === 1,
    );
    expect(singlePavotube.length).toBe(0);
  });

  test('Scenario 4: suggestBundles for "pavotube" returns 2x set as minimum', () => {
    const suggestions = suggestBundles('I need a pavotube for my shoot');
    const pavotubeSuggestions = suggestions.filter((s) =>
      s.bundle_name.toLowerCase().includes('pavotube'),
    );
    expect(pavotubeSuggestions.length).toBeGreaterThan(0);
    expect(pavotubeSuggestions[0].items.length).toBeGreaterThanOrEqual(2);
  });

  test('Scenario 5: Pavotube bundle savings notes mention minimum order of 2', () => {
    const pavotubeBundles = BUNDLE_DEFINITIONS.filter(
      (b) => b.bundle_name.toLowerCase().includes('pavotube'),
    );
    for (const bundle of pavotubeBundles) {
      expect(bundle.savings_note.toLowerCase()).toContain('never individually');
    }
  });

  test('Scenario 6: Autonomous service has minimum quantity enforcement for Pavotubes', () => {
    const autoSource = readSrc('autonomous/autonomous.service.ts');
    expect(autoSource).toContain('MINIMUM QUANTITY RULES');
    expect(autoSource).toContain('Nanlite Pavotube 30x II');
    expect(autoSource).toContain('min: 2');
    expect(autoSource).toContain('NEVER offer a single unit');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 7: Delivery Pricing (~40% van/car over motorbike)
//          & Discount Stacking Rules
// ═══════════════════════════════════════════════════════════════
describe('Issue 7: Delivery Pricing & Discount Rules', () => {
  function extractPricing(vehicleType: string, zone: string): { min: number; max: number } | null {
    const regex = new RegExp(
      `${vehicleType}:\\s*\\{[\\s\\S]*?${zone}:\\s*\\{\\s*min:\\s*(\\d+),\\s*max:\\s*(\\d+)\\s*\\}`,
    );
    const match = deliverySource.match(regex);
    if (!match) return null;
    return { min: parseInt(match[1]), max: parseInt(match[2]) };
  }

  const zones = ['core', 'central', 'inner', 'mid', 'outer', 'greater'];

  test('Scenario 1: Small car is ~40% more than motorcycle in core zone', () => {
    const motoPricing = extractPricing('motorcycle', 'core');
    const carPricing = extractPricing('small_car', 'core');
    expect(motoPricing).not.toBeNull();
    expect(carPricing).not.toBeNull();
    const minIncrease = ((carPricing!.min - motoPricing!.min) / motoPricing!.min) * 100;
    const maxIncrease = ((carPricing!.max - motoPricing!.max) / motoPricing!.max) * 100;
    expect(minIncrease).toBeGreaterThanOrEqual(38);
    expect(minIncrease).toBeLessThanOrEqual(42);
    expect(maxIncrease).toBeGreaterThanOrEqual(38);
    expect(maxIncrease).toBeLessThanOrEqual(42);
  });

  test('Scenario 2: Small car is ~40% more than motorcycle across ALL zones', () => {
    for (const zone of zones) {
      const motoPricing = extractPricing('motorcycle', zone);
      const carPricing = extractPricing('small_car', zone);
      expect(motoPricing).not.toBeNull();
      expect(carPricing).not.toBeNull();
      const minIncrease = ((carPricing!.min - motoPricing!.min) / motoPricing!.min) * 100;
      const maxIncrease = ((carPricing!.max - motoPricing!.max) / motoPricing!.max) * 100;
      expect(minIncrease).toBeGreaterThanOrEqual(38);
      expect(minIncrease).toBeLessThanOrEqual(42);
      expect(maxIncrease).toBeGreaterThanOrEqual(38);
      expect(maxIncrease).toBeLessThanOrEqual(42);
    }
  });

  test('Scenario 3: Validation targets ~40% range (38-42%) for consistency', () => {
    expect(deliverySource).toContain('minIncrease < 38');
    expect(deliverySource).toContain('maxIncrease > 42');
    expect(deliverySource).toContain('target: ~40%');
  });

  test('Scenario 4: System instructs discounts never apply to delivery', () => {
    // In autonomous service (discount rules injected into context)
    const autoSource = readSrc('autonomous/autonomous.service.ts');
    expect(autoSource).toContain('Discounts NEVER apply to delivery quotes');
  });

  test('Scenario 5: System instructs discounts do not stack', () => {
    // In pricing_domain component and DB rules
    const rulesSource = readSrc('rules/rules.service.ts');
    expect(rulesSource).toContain('Only ONE discount can be applied per booking');
    expect(rulesSource).toContain('Do not stack discounts');
  });

  test('Scenario 6: Motorcycle pricing is cheapest, car is middle, van is most expensive in every zone', () => {
    for (const zone of zones) {
      const moto = extractPricing('motorcycle', zone);
      const car = extractPricing('small_car', zone);
      const van = extractPricing('large_van', zone);
      expect(moto).not.toBeNull();
      expect(car).not.toBeNull();
      expect(van).not.toBeNull();
      expect(car!.min).toBeGreaterThan(moto!.min);
      expect(van!.min).toBeGreaterThan(car!.min);
      expect(car!.max).toBeGreaterThan(moto!.max);
      expect(van!.max).toBeGreaterThan(car!.max);
    }
  });
});
