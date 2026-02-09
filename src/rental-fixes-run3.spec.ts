/**
 * Comprehensive test suite for rental manager fixes.
 * Run 3 of 3: Final fresh set of test scenarios to validate robustness.
 */

import { MASTER_INVENTORY, getInventoryItemNames, findBestMatch } from './utils/item-matcher';
import { PRICING_CATALOG } from './data/pricing-catalog';
import { BUNDLE_DEFINITIONS, suggestBundles, suggestBundlesForItems, formatBundleSuggestionsForAI } from './data/bundle-suggestions';
import { DELIVERY_SPECS, getDeliverySpec } from './data/delivery-specs';

const fs = require('fs');
const path = require('path');
const readSource = (relPath: string) => fs.readFileSync(path.join(__dirname, relPath), 'utf8');

const aiSrc = readSource('ai/ai.service.ts');
const autoSrc = readSource('autonomous/autonomous.service.ts');
const deliverySrc = readSource('delivery/delivery.service.ts');
const bundleIntSrc = readSource('bundles/bundle-intelligence.service.ts');

// ═══════════════════════════════════════════════════════════════
// ISSUE 1: Vacation Mode - Run 3 Edge Cases
// ═══════════════════════════════════════════════════════════════
describe('Issue 1 (Run 3): Vacation Edge Cases', () => {
  test('Edge Case 1: Prompt distinguishes between declining vs suggesting alternatives', () => {
    // Should NOT just say "doesn't work" — should offer alternatives
    expect(aiSrc).toContain('workable alternatives rather than just declining');
  });

  test('Edge Case 2: Free morning return policy is tied to owner scheduling fault', () => {
    // The free return is justified because the limitation is on our side
    const freeReturnSection = aiSrc.substring(
      aiSrc.indexOf('FREE next-morning return'),
      aiSrc.indexOf('FREE next-morning return') + 200,
    );
    expect(freeReturnSection).toContain('scheduling limitation');
  });

  test('Edge Case 3: Evening return is explicitly marked as an extra charged day', () => {
    const eveningSection = aiSrc.substring(
      aiSrc.indexOf('next-EVENING return'),
      aiSrc.indexOf('next-EVENING return') + 200,
    );
    expect(eveningSection).toContain('extra rental day');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 2: Inventory Limits - Run 3 Cross-Checks
// ═══════════════════════════════════════════════════════════════
describe('Issue 2 (Run 3): Inventory Cross-Validation', () => {
  test('Cross-check 1: Every item listed in delivery specs exists in inventory or is a bundle', () => {
    const inventoryNames = getInventoryItemNames();
    const missingItems: string[] = [];
    for (const spec of DELIVERY_SPECS) {
      if (spec.category !== 'bundle') {
        if (!inventoryNames.includes(spec.item_name)) {
          missingItems.push(spec.item_name);
        }
      }
    }
    expect(missingItems).toEqual([]);
  });

  test('Cross-check 2: DJI Osmo Action Pro 5 max is 3, matching bundle max of 3x', () => {
    expect(MASTER_INVENTORY['DJI Osmo Action Pro 5']).toBe(3);
    const max3xSet = PRICING_CATALOG.find((p) => p.item_name === '3x DJI Osmo Action Pro 5 Set');
    expect(max3xSet).toBeDefined();
    const has4xSet = PRICING_CATALOG.some((p) => p.item_name.includes('4x DJI Osmo Action Pro 5'));
    expect(has4xSet).toBe(false);
  });

  test('Cross-check 3: GoPro 12 Hero max is 3, matching bundle max of 3x', () => {
    expect(MASTER_INVENTORY['GoPro 12 Hero']).toBe(3);
    const max3xSet = PRICING_CATALOG.find((p) => p.item_name === '3x GoPro Hero 12 Set');
    expect(max3xSet).toBeDefined();
    const has4xSet = PRICING_CATALOG.some((p) => p.item_name.includes('4x GoPro'));
    expect(has4xSet).toBe(false);
  });

  test('Cross-check 4: V-mount 150mAh max is 4, matching bundle max of 4x', () => {
    expect(MASTER_INVENTORY['V-mount 150mAh']).toBe(4);
    const max4xSet = PRICING_CATALOG.find((p) => p.item_name === '4x V-mount 150mAh Set');
    expect(max4xSet).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 3: Travel Discount - Run 3 Negative Tests
// ═══════════════════════════════════════════════════════════════
describe('Issue 3 (Run 3): Travel Discount Negative Validation', () => {
  test('Negative 1: Old proactive travel discount phrasing is removed', () => {
    // The old version said "proactively mention" - should NOT be there
    expect(aiSrc).not.toMatch(/proactively mention the 10% travel distance discount/);
  });

  test('Negative 2: Discount section does not say "always" mention travel discount', () => {
    const travelSection = aiSrc.substring(
      aiSrc.indexOf('TRAVEL DISCOUNT'),
      aiSrc.indexOf('TRAVEL DISCOUNT') + 500,
    );
    expect(travelSection).not.toMatch(/always mention/i);
  });

  test('Negative 3: Discount rules explicitly forbid stacking', () => {
    expect(aiSrc).toContain('do NOT stack');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 4: Bundle Accuracy - Run 3 Comprehensive Verification
// ═══════════════════════════════════════════════════════════════
describe('Issue 4 (Run 3): Full Bundle Catalog Verification', () => {
  test('Comprehensive 1: No bundle in pricing catalog contains items not in MASTER_INVENTORY', () => {
    const inventoryNames = getInventoryItemNames();
    const violators: string[] = [];
    for (const entry of PRICING_CATALOG) {
      if (entry.is_bundle && entry.bundle_items) {
        for (const item of entry.bundle_items) {
          if (!inventoryNames.includes(item)) {
            violators.push(`${entry.item_name}: "${item}" not in MASTER_INVENTORY`);
          }
        }
      }
    }
    expect(violators).toEqual([]);
  });

  test('Comprehensive 2: No bundle in BUNDLE_DEFINITIONS has phantom items', () => {
    const inventoryNames = getInventoryItemNames();
    const violators: string[] = [];
    for (const bundle of BUNDLE_DEFINITIONS) {
      for (const item of bundle.items) {
        if (!inventoryNames.includes(item)) {
          violators.push(`${bundle.bundle_name}: "${item}" not in inventory`);
        }
      }
    }
    expect(violators).toEqual([]);
  });

  test('Comprehensive 3: Bundle-intelligence service only references real inventory item names', () => {
    // These items were in the old incorrect definitions
    expect(bundleIntSrc).not.toContain("'NP-FZ100'");
    expect(bundleIntSrc).not.toContain("'CFexpress'");
    expect(bundleIntSrc).not.toContain("'LP-E6NH'");
    expect(bundleIntSrc).not.toContain("'CFast'");
    expect(bundleIntSrc).not.toContain("'DZO ");
    expect(bundleIntSrc).not.toContain("'Sennheiser MKE");
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 5: V-Mount - Run 3 Pricing Math Validation
// ═══════════════════════════════════════════════════════════════
describe('Issue 5 (Run 3): V-Mount Pricing Math', () => {
  test('Math 1: Production Kit + V-Mount 95mAh price > base Production Kit price', () => {
    const base = PRICING_CATALOG.find((p) => p.item_name === 'Sony FX3 Full Production Kit');
    const withV95 = PRICING_CATALOG.find((p) => p.item_name === 'Sony FX3 Full Production Kit + V-Mount 95mAh');
    expect(withV95!.daily_price_min).toBeGreaterThan(base!.daily_price_min);
    expect(withV95!.daily_price_max).toBeGreaterThan(base!.daily_price_max);
  });

  test('Math 2: Price increase from base to V-mount bundle is less than standalone V-mount price (bundle savings)', () => {
    const base = PRICING_CATALOG.find((p) => p.item_name === 'Sony FX3 Full Production Kit');
    const withV95 = PRICING_CATALOG.find((p) => p.item_name === 'Sony FX3 Full Production Kit + V-Mount 95mAh');
    const standalone95 = PRICING_CATALOG.find((p) => p.item_name === 'V-mount 95mAh');
    const bundleIncrement = withV95!.daily_price_min - base!.daily_price_min;
    // Bundle increment should be less than standalone price (that's the savings)
    expect(bundleIncrement).toBeLessThan(standalone95!.daily_price_max);
  });

  test('Math 3: V-mount 150mAh individual is more expensive than 95mAh individual', () => {
    const v95 = PRICING_CATALOG.find((p) => p.item_name === 'V-mount 95mAh');
    const v150 = PRICING_CATALOG.find((p) => p.item_name === 'V-mount 150mAh');
    expect(v150!.daily_price_min).toBeGreaterThan(v95!.daily_price_min);
    expect(v150!.daily_price_max).toBeGreaterThan(v95!.daily_price_max);
    // 150mAh should be meaningfully more expensive (not just £1 different)
    expect(v150!.daily_price_min - v95!.daily_price_min).toBeGreaterThanOrEqual(5);
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 6: Pavotube - Run 3 Natural Language Triggers
// ═══════════════════════════════════════════════════════════════
describe('Issue 6 (Run 3): Pavotube Natural Language Matching', () => {
  test('NLP 1: "I want tube lights for my music video" triggers Pavotube 2x suggestion', () => {
    const results = suggestBundles('I want tube lights for my music video');
    const pavotube = results.find((r) => r.bundle_name.includes('Pavotube'));
    expect(pavotube).toBeDefined();
    expect(pavotube!.items.length).toBeGreaterThanOrEqual(2);
  });

  test('NLP 2: "accent light" triggers Pavotube suggestion (not single unit)', () => {
    const results = suggestBundles('need some accent light for the set');
    const pavotube = results.find((r) => r.bundle_name.includes('Pavotube'));
    expect(pavotube).toBeDefined();
    expect(pavotube!.items.length).toBeGreaterThanOrEqual(2);
  });

  test('NLP 3: "rgb tubes" triggers Pavotube suggestion', () => {
    const results = suggestBundles('looking for rgb tubes');
    const pavotube = results.find((r) => r.bundle_name.includes('Pavotube'));
    expect(pavotube).toBeDefined();
  });

  test('NLP 4: formatBundleSuggestionsForAI includes pavotube context for tube light queries', () => {
    const context = formatBundleSuggestionsForAI('need tube lights', []);
    expect(context).toContain('Pavotube');
    expect(context).toContain('BUNDLE');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 7: Delivery Pricing - Run 3 Exact Number Validation
// ═══════════════════════════════════════════════════════════════
describe('Issue 7 (Run 3): Delivery Exact Pricing Verification', () => {
  function extractAllPricing(): Record<string, Record<string, { min: number; max: number }>> {
    const result: Record<string, Record<string, { min: number; max: number }>> = {};
    const vehicles = ['motorcycle', 'small_car', 'large_van'];
    const zones = ['core', 'central', 'inner', 'mid', 'outer', 'greater'];

    for (const vehicle of vehicles) {
      result[vehicle] = {};
      for (const zone of zones) {
        const regex = new RegExp(
          `${vehicle}:\\s*\\{[\\s\\S]*?${zone}:\\s*\\{\\s*min:\\s*(\\d+),\\s*max:\\s*(\\d+)\\s*\\}`,
        );
        const match = deliverySrc.match(regex);
        if (match) {
          result[vehicle][zone] = { min: parseInt(match[1]), max: parseInt(match[2]) };
        }
      }
    }
    return result;
  }

  const pricing = extractAllPricing();

  test('Exact 1: Motorcycle core = £15-20', () => {
    expect(pricing.motorcycle.core).toEqual({ min: 15, max: 20 });
  });

  test('Exact 2: Small car core = £21-28 (40% over motorcycle)', () => {
    expect(pricing.small_car.core).toEqual({ min: 21, max: 28 });
    const minRatio = pricing.small_car.core.min / pricing.motorcycle.core.min;
    expect(minRatio).toBeCloseTo(1.4, 1);
    const maxRatio = pricing.small_car.core.max / pricing.motorcycle.core.max;
    expect(maxRatio).toBeCloseTo(1.4, 1);
  });

  test('Exact 3: All 6 zones maintain ~40% car over motorcycle consistency', () => {
    const zones = ['core', 'central', 'inner', 'mid', 'outer', 'greater'];
    for (const zone of zones) {
      const moto = pricing.motorcycle[zone];
      const car = pricing.small_car[zone];
      const minPct = ((car.min - moto.min) / moto.min) * 100;
      const maxPct = ((car.max - moto.max) / moto.max) * 100;
      expect(minPct).toBeGreaterThanOrEqual(38);
      expect(minPct).toBeLessThanOrEqual(42);
      expect(maxPct).toBeGreaterThanOrEqual(38);
      expect(maxPct).toBeLessThanOrEqual(42);
    }
  });

  test('Exact 4: Van pricing is significantly higher than car (not just 40%)', () => {
    const zones = ['core', 'central', 'inner', 'mid', 'outer', 'greater'];
    for (const zone of zones) {
      const car = pricing.small_car[zone];
      const van = pricing.large_van[zone];
      // Van should be at least 50% more than car (significantly higher)
      const vanPctOverCar = ((van.min - car.min) / car.min) * 100;
      expect(vanPctOverCar).toBeGreaterThanOrEqual(50);
    }
  });

  test('Exact 5: Delivery specs exist for both Production Kit + V-Mount variants', () => {
    const spec1 = getDeliverySpec('Sony FX3 Full Production Kit + V-Mount 95mAh');
    const spec2 = getDeliverySpec('Sony FX3 Full Production Kit + V-Mount 150mAh');
    expect(spec1).toBeDefined();
    expect(spec2).toBeDefined();
    expect(spec1!.courier_note).toContain('Needs car');
    expect(spec2!.courier_note).toContain('Needs car');
  });
});
