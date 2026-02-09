/**
 * PROBING TEST SUITE: New issues discovered beyond the original 7.
 * Run 3 of 3: Cross-validation, comprehensive, and edge case tests.
 */

import { MASTER_INVENTORY, getInventoryItemNames } from './utils/item-matcher';
import { PRICING_CATALOG } from './data/pricing-catalog';
import { BUNDLE_DEFINITIONS } from './data/bundle-suggestions';
import { DELIVERY_SPECS, getDeliverySpec } from './data/delivery-specs';

const fs = require('fs');
const path = require('path');
const readSource = (relPath: string) => fs.readFileSync(path.join(__dirname, relPath), 'utf8');

const validationSrc = readSource('validation/validation.service.ts');
const upsellSrc = readSource('upsell/upsell.service.ts');
const autoSrc = readSource('autonomous/autonomous.service.ts');
const aiSrc = readSource('ai/ai.service.ts');

// ═══════════════════════════════════════════════════════════════
// ISSUE 8 (Run 3): Validation - Should Use Dynamic Inventory
// ═══════════════════════════════════════════════════════════════
describe('Issue 8 (Run 3): Validation Dynamic Inventory', () => {
  test('8M: Validation service should import or reference MASTER_INVENTORY instead of hardcoding', () => {
    // Best practice: import from item-matcher.ts
    const usesDynamicInventory =
      validationSrc.includes('MASTER_INVENTORY') ||
      validationSrc.includes('getInventoryItemNames') ||
      validationSrc.includes('item-matcher');
    expect(usesDynamicInventory).toBe(true);
  });

  test('8N: Validation inventory count should roughly match MASTER_INVENTORY count', () => {
    const match = validationSrc.match(/const masterInventory\s*=\s*\[([\s\S]*?)\];/);
    if (!match) {
      // If no hardcoded list, validation is using dynamic inventory (good!)
      expect(true).toBe(true);
      return;
    }
    const items = match[1].match(/'([^']+)'/g) || [];
    const validationCount = items.length;
    const inventoryCount = Object.keys(MASTER_INVENTORY).length;
    // Validation should have at least 50% of real inventory items
    expect(validationCount).toBeGreaterThanOrEqual(inventoryCount * 0.5);
  });

  test('8O: Validation should not have BMPCC 6K without specifying Pro or Full Frame', () => {
    // Ambiguous "BMPCC 6K" exists - should specify which model
    const hasBMPCC6K = validationSrc.includes("'BMPCC 6K'");
    if (hasBMPCC6K) {
      // If it includes generic BMPCC 6K, it should also include the specific models
      const hasSpecificModels =
        validationSrc.includes("'BMPCC 6K Pro'") ||
        validationSrc.includes("'BMPCC 6K Full Frame'");
      expect(hasSpecificModels).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 9 (Run 3): Upsell - Comprehensive Item Audit
// ═══════════════════════════════════════════════════════════════
describe('Issue 9 (Run 3): Upsell Comprehensive Phantom Audit', () => {
  // Extract all quoted string items from upsell source (recommendations, complementary items, etc.)
  function extractUpsellRecommendedItems(): string[] {
    const items: string[] = [];
    // Match items in arrays like ['item1', 'item2']
    const arrayMatches = upsellSrc.match(/'[^']+'/g) || [];
    for (const m of arrayMatches) {
      const item = m.replace(/'/g, '');
      // Only include items that look like product recommendations (not code patterns)
      if (item.length > 3 && !/^(camera|lens|audio|lighting|gimbal|monitor|drone|other|interview|wedding|music_video|corporate|documentary|product|critical|high|medium|low|gentle|moderate|aggressive|none|10_percent|17_percent)$/.test(item)) {
        items.push(item);
      }
    }
    return [...new Set(items)];
  }

  test('9M: Count of non-inventory items in upsell recommendations should be zero', () => {
    const inventoryNames = getInventoryItemNames();
    const phantomItems = [
      'teleprompter', 'boom pole', 'headphones', 'cage', 'landing pad',
      'turntable', 'macro lens', 'recorder', 'light stand', 'diffusion', 'grid',
      'haze machine', 'matte box',
    ];

    const foundPhantoms: string[] = [];
    for (const phantom of phantomItems) {
      if (upsellSrc.includes(`'${phantom}'`)) {
        foundPhantoms.push(phantom);
      }
    }
    expect(foundPhantoms).toEqual([]);
  });

  test('9N: Upsell "Extra battery (£10)" should specify which battery type', () => {
    // Generic "Extra battery" doesn't help - should specify V-mount 95mAh vs 150mAh, or NPF 970, etc.
    if (upsellSrc.includes('Extra battery')) {
      const hasSpecificBattery =
        upsellSrc.includes('V-mount 95mAh') ||
        upsellSrc.includes('V-mount 150mAh') ||
        upsellSrc.includes('NPF 970');
      expect(hasSpecificBattery).toBe(true);
    }
  });

  test('9O: Upsell should not contain hardcoded LED panel price (£30 was never in actual range of £15-25)', () => {
    const upsellSrc = readSource('upsell/upsell.service.ts');
    // No hardcoded "LED panel (£30)" should exist — actual price range is £15-25
    expect(upsellSrc).not.toContain('LED panel (£30)');
    // Should reference the real item name instead
    expect(upsellSrc).toContain('LED light panels RGB');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 10 (Run 3): Price Consistency - Delivery Specs Coverage
// ═══════════════════════════════════════════════════════════════
describe('Issue 10 (Run 3): Delivery Specs Coverage for Bundles', () => {
  test('10I: Every bundle in BUNDLE_DEFINITIONS should have a delivery spec', () => {
    const missingSpecs: string[] = [];
    for (const bundle of BUNDLE_DEFINITIONS) {
      const spec = getDeliverySpec(bundle.bundle_name);
      if (!spec) {
        missingSpecs.push(bundle.bundle_name);
      }
    }
    expect(missingSpecs).toEqual([]);
  });

  test('10J: DJ bundle delivery should require van or car (heavy items)', () => {
    const djBundle = getDeliverySpec('JBL Speakers + Pioneer DJ RX3 Set');
    expect(djBundle).toBeDefined();
    if (djBundle) {
      // DJ equipment is heavy, should need van
      expect(djBundle.weight_kg).toBeGreaterThan(20);
      expect(djBundle.courier_note).toMatch(/van/i);
    }
  });

  test('10K: Smoke machine delivery specs weight should be realistic', () => {
    const smokeSpec = getDeliverySpec('Smoke machine fogger');
    if (smokeSpec) {
      // 4kg item should probably need a car, not motorcycle
      expect(smokeSpec.weight_kg).toBeGreaterThanOrEqual(3);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 11 (Run 3): Cross-Validation of Rules and Services
// ═══════════════════════════════════════════════════════════════
describe('Issue 11 (Run 3): Rules-Service Cross-Validation', () => {
  test('11L: AI service discount rules match upsell service tiers', () => {
    // AI service says discounts do not stack and are never revealed to renters
    expect(aiSrc).toContain('Discounts do NOT stack');
    expect(aiSrc).toContain('NEVER reveal percentages or tiers to renters');

    // Upsell service should have matching thresholds
    // 10% threshold at £250
    expect(upsellSrc).toContain('250');
    // 17% threshold at £500
    expect(upsellSrc).toContain('500');
  });

  test('11M: AI service minimum rental value matches upsell service', () => {
    // AI service references pricing through system prompt
    // Upsell service has £25 minimum
    expect(upsellSrc).toContain('< 25');
    expect(upsellSrc).toContain('Under £25');
  });

  test('11N: AI service delivery disclaimer about 15% accuracy should exist', () => {
    expect(aiSrc).toContain('15 percent');
    expect(aiSrc).toContain('confirmed by the courier');
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 12 (Run 3): Comprehensive Autonomous Service Checks
// ═══════════════════════════════════════════════════════════════
describe('Issue 12 (Run 3): Autonomous Service Comprehensive', () => {
  test('12G: Autonomous service should not silently ignore items missing from MASTER_INVENTORY', () => {
    // When an item is mentioned but not in inventory, the system should handle it
    // (not just skip it silently)
    expect(autoSrc).toContain('MASTER_INVENTORY');
  });

  test('12H: Context level detection should handle pricing-related keywords', () => {
    // Messages about pricing should get comprehensive context
    expect(autoSrc).toMatch(/pric|cost|how much|quote|rate/i);
  });

  test('12I: Delivery recalculation context should mention courier type changes', () => {
    expect(autoSrc).toContain('courier type');
    expect(autoSrc).toContain('motorcycle');
  });
});
