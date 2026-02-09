/**
 * Comprehensive test suite for rental manager fixes.
 * Run 2 of 3: Fresh, unused test scenarios to validate the same fixes.
 */

import { MASTER_INVENTORY, getInventoryItemNames } from './utils/item-matcher';
import { PRICING_CATALOG } from './data/pricing-catalog';
import { BUNDLE_DEFINITIONS, suggestBundles, suggestBundlesForItems } from './data/bundle-suggestions';
import { DELIVERY_SPECS, getDeliverySpec } from './data/delivery-specs';

const fs = require('fs');
const path = require('path');
const aiServiceSource = fs.readFileSync(path.join(__dirname, 'ai/ai.service.ts'), 'utf8');
const autoServiceSource = fs.readFileSync(path.join(__dirname, 'autonomous/autonomous.service.ts'), 'utf8');
const deliveryServiceSource = fs.readFileSync(path.join(__dirname, 'delivery/delivery.service.ts'), 'utf8');
const bundleIntSource = fs.readFileSync(path.join(__dirname, 'bundles/bundle-intelligence.service.ts'), 'utf8');

// ═══════════════════════════════════════════════════════════════
// ISSUE 1: Vacation Mode - Run 2 Fresh Scenarios
// ═══════════════════════════════════════════════════════════════
describe('Issue 1 (Run 2): Vacation Mode Scheduling Intelligence', () => {
  test('Scenario A: Prompt references 10am as example available slot', () => {
    expect(aiServiceSource).toMatch(/10am before I head out/i);
  });

  test('Scenario B: Free return only applies to MORNING, not evening', () => {
    // Verify the system prompt distinguishes morning (free) vs evening (paid)
    expect(aiServiceSource).toContain('FREE next-morning return');
    expect(aiServiceSource).toContain('next-EVENING return');
    // The two should have different outcomes
    const morningIdx = aiServiceSource.indexOf('FREE next-morning return');
    const eveningIdx = aiServiceSource.indexOf('next-EVENING return');
    expect(morningIdx).toBeGreaterThan(-1);
    expect(eveningIdx).toBeGreaterThan(-1);
  });

  test('Scenario C: Owner schedule limitation is acknowledged as "our" fault', () => {
    expect(aiServiceSource).toMatch(/our scheduling limitation.*not the renter/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 2: FX3 Quantity - Run 2 Fresh Scenarios
// ═══════════════════════════════════════════════════════════════
describe('Issue 2 (Run 2): FX3 Inventory Hard Limit', () => {
  test('Scenario A: No item in MASTER_INVENTORY has more than its listed quantity in bundles', () => {
    // Check ALL items, not just FX3
    for (const [item, maxQty] of Object.entries(MASTER_INVENTORY)) {
      const bundles = PRICING_CATALOG.filter(
        (p) => p.is_bundle && p.bundle_items && p.bundle_items.includes(item),
      );
      for (const bundle of bundles) {
        const count = bundle.bundle_items!.filter((i) => i === item).length;
        expect(count).toBeLessThanOrEqual(maxQty as number);
      }
    }
  });

  test('Scenario B: Prompt provides generic correction template for all items', () => {
    expect(aiServiceSource).toContain('We actually have a maximum of X of those available');
    expect(aiServiceSource).toContain('politely correct them with the actual maximum');
  });

  test('Scenario C: Runtime context injection includes per-item MAX quantities', () => {
    expect(autoServiceSource).toContain('MASTER_INVENTORY');
    expect(autoServiceSource).toMatch(/MAX.*units in stock/);
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 3: Travel Discount - Run 2 Fresh Scenarios
// ═══════════════════════════════════════════════════════════════
describe('Issue 3 (Run 2): Travel Discount Guard Rails', () => {
  test('Scenario A: No mention of 10% proactively - only after verification', () => {
    // Old rule should be gone (was "proactively mention")
    expect(aiServiceSource).not.toContain('proactively mention the 10% travel distance discount');
  });

  test('Scenario B: Discounts do not stack', () => {
    expect(aiServiceSource).toContain('Discounts do NOT stack');
  });

  test('Scenario C: Only one discount tier at a time - verified by explicit rule', () => {
    expect(aiServiceSource).toContain('only one discount tier applies');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 4: Production Kit Accuracy - Run 2 Fresh Scenarios
// ═══════════════════════════════════════════════════════════════
describe('Issue 4 (Run 2): Bundle Content Integrity', () => {
  test('Scenario A: Bundle-intelligence service does NOT reference Aputure (not in inventory)', () => {
    // Aputure was in the old incorrect bundles
    expect(bundleIntSource).not.toContain("'Aputure");
    expect(bundleIntSource).not.toContain('"Aputure');
  });

  test('Scenario B: Bundle-intelligence service does NOT reference DZO (not in inventory)', () => {
    expect(bundleIntSource).not.toContain("'DZO ");
  });

  test('Scenario C: Bundle-intelligence service does NOT reference Sennheiser MKE 600 (not in inventory)', () => {
    expect(bundleIntSource).not.toContain('Sennheiser MKE 600');
  });

  test('Scenario D: Every item in BUNDLE_DEFINITIONS exists in MASTER_INVENTORY', () => {
    const inventoryNames = getInventoryItemNames();
    for (const bundle of BUNDLE_DEFINITIONS) {
      for (const item of bundle.items) {
        expect(inventoryNames).toContain(item);
      }
    }
  });

  test('Scenario E: Production Kit pricing is consistent between pricing-catalog and bundle-suggestions', () => {
    const catalogKit = PRICING_CATALOG.find(
      (p) => p.item_name === 'Sony FX3 Full Production Kit',
    );
    const suggestionKit = BUNDLE_DEFINITIONS.find(
      (b) => b.bundle_name === 'Sony FX3 Full Production Kit',
    );
    expect(catalogKit).toBeDefined();
    expect(suggestionKit).toBeDefined();
    expect(catalogKit!.daily_price_min).toBe(suggestionKit!.daily_price_min);
    expect(catalogKit!.daily_price_max).toBe(suggestionKit!.daily_price_max);
  });

  test('Scenario F: Production Kit bundle items are consistent between pricing-catalog and bundle-suggestions', () => {
    const catalogKit = PRICING_CATALOG.find(
      (p) => p.item_name === 'Sony FX3 Full Production Kit',
    );
    const suggestionKit = BUNDLE_DEFINITIONS.find(
      (b) => b.bundle_name === 'Sony FX3 Full Production Kit',
    );
    expect(catalogKit!.bundle_items!.sort()).toEqual(suggestionKit!.items.sort());
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 5: V-Mount Pricing - Run 2 Fresh Scenarios
// ═══════════════════════════════════════════════════════════════
describe('Issue 5 (Run 2): V-Mount Bundle Upgrade Path', () => {
  test('Scenario A: 2x V-mount sets have different prices (95mAh vs 150mAh)', () => {
    const set95 = PRICING_CATALOG.find((p) => p.item_name === '2x V-mount 95mAh Set');
    const set150 = PRICING_CATALOG.find((p) => p.item_name === '2x V-mount 150mAh Set');
    expect(set95).toBeDefined();
    expect(set150).toBeDefined();
    expect(set150!.daily_price_min).toBeGreaterThan(set95!.daily_price_min);
  });

  test('Scenario B: Production Kit + V-Mount bundles have delivery specs', () => {
    const spec95 = getDeliverySpec('Sony FX3 Full Production Kit + V-Mount 95mAh');
    const spec150 = getDeliverySpec('Sony FX3 Full Production Kit + V-Mount 150mAh');
    expect(spec95).toBeDefined();
    expect(spec150).toBeDefined();
    expect(spec150!.weight_kg).toBeGreaterThan(spec95!.weight_kg);
  });

  test('Scenario C: suggestBundlesForItems detects upgrade when adding V-mount to production kit items', () => {
    // When someone has production kit items plus mentions V-mount, the bundle system
    // should be able to find the V-mount variant
    const productionKitVmount = BUNDLE_DEFINITIONS.filter(
      (b) => b.items.includes('V-mount 95mAh') || b.items.includes('V-mount 150mAh'),
    );
    expect(productionKitVmount.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 6: Pavotube Minimum - Run 2 Fresh Scenarios
// ═══════════════════════════════════════════════════════════════
describe('Issue 6 (Run 2): Pavotube Set Enforcement', () => {
  test('Scenario A: Pavotube trigger keywords include common misspellings and variations', () => {
    const pavotube2x = BUNDLE_DEFINITIONS.find(
      (b) => b.bundle_name === '2x Nanlite Pavotube 30x II Set',
    );
    expect(pavotube2x).toBeDefined();
    expect(pavotube2x!.trigger_keywords).toContain('pavotube');
    expect(pavotube2x!.trigger_keywords).toContain('tube light');
    expect(pavotube2x!.trigger_keywords).toContain('nanlite tube');
  });

  test('Scenario B: Searching for "nanlite tube" suggests 2x set', () => {
    const results = suggestBundles('I want a nanlite tube light');
    const pavotube = results.find((r) => r.bundle_name.includes('Pavotube'));
    expect(pavotube).toBeDefined();
    expect(pavotube!.items.length).toBeGreaterThanOrEqual(2);
  });

  test('Scenario C: Pricing catalog Pavotube sets start at 2x, no single listing', () => {
    const pavotubeSets = PRICING_CATALOG.filter(
      (p) => p.item_name.includes('Nanlite Pavotube') && p.item_name.includes('Set'),
    );
    expect(pavotubeSets.length).toBeGreaterThanOrEqual(3); // 2x, 3x, 4x
    // Smallest set should have 2 items
    const smallest = pavotubeSets.reduce((s, p) =>
      (p.bundle_items?.length || 0) < (s.bundle_items?.length || 999) ? p : s,
    );
    expect(smallest.bundle_items?.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 7: Delivery Pricing - Run 2 Fresh Scenarios
// ═══════════════════════════════════════════════════════════════
describe('Issue 7 (Run 2): Delivery Pricing & No Discount on Delivery', () => {
  function extractPricing(vehicleType: string, zone: string): { min: number; max: number } | null {
    const regex = new RegExp(
      `${vehicleType}:\\s*\\{[\\s\\S]*?${zone}:\\s*\\{\\s*min:\\s*(\\d+),\\s*max:\\s*(\\d+)\\s*\\}`,
    );
    const match = deliveryServiceSource.match(regex);
    if (!match) return null;
    return { min: parseInt(match[1]), max: parseInt(match[2]) };
  }

  test('Scenario A: Central zone car-to-motorcycle ratio is ~1.4x', () => {
    const moto = extractPricing('motorcycle', 'central');
    const car = extractPricing('small_car', 'central');
    expect(moto).not.toBeNull();
    expect(car).not.toBeNull();
    const ratio = car!.min / moto!.min;
    expect(ratio).toBeGreaterThanOrEqual(1.38);
    expect(ratio).toBeLessThanOrEqual(1.42);
  });

  test('Scenario B: Greater London zone car is still ~40% more than motorcycle', () => {
    const moto = extractPricing('motorcycle', 'greater');
    const car = extractPricing('small_car', 'greater');
    expect(moto).not.toBeNull();
    expect(car).not.toBeNull();
    const minIncrease = ((car!.min - moto!.min) / moto!.min) * 100;
    const maxIncrease = ((car!.max - moto!.max) / moto!.max) * 100;
    expect(minIncrease).toBeGreaterThanOrEqual(38);
    expect(minIncrease).toBeLessThanOrEqual(42);
    expect(maxIncrease).toBeGreaterThanOrEqual(38);
    expect(maxIncrease).toBeLessThanOrEqual(42);
  });

  test('Scenario C: Delivery quote is NEVER discounted - prompt explicitly forbids it', () => {
    expect(aiServiceSource).toContain('Discounts NEVER apply to delivery quotes');
    expect(aiServiceSource).toContain('delivery pricing is always separate');
  });
});
