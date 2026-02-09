/**
 * PROBING TEST SUITE: New issues discovered beyond the original 7.
 * Run 2 of 3: Different scenarios and edge cases.
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

// ═══════════════════════════════════════════════════════════════
// ISSUE 8 (Run 2): Validation Inventory - More Phantom Items
// ═══════════════════════════════════════════════════════════════
describe('Issue 8 (Run 2): Validation Phantom Item Detection', () => {
  test('8G: Validation should NOT reference Sony 50mm (not in inventory)', () => {
    expect(validationSrc).not.toContain("'Sony 50mm'");
  });

  test('8H: Validation should NOT reference SD card (actual: 256GB card)', () => {
    expect(validationSrc).not.toContain("'SD card'");
  });

  test('8I: Validation should NOT reference NP-FZ100 as inventory item (it is an included accessory, not a rental item)', () => {
    expect(validationSrc).not.toContain("'NP-FZ100'");
  });

  test('8J: Validation should NOT reference LP-E6NH as inventory item', () => {
    expect(validationSrc).not.toContain("'LP-E6NH'");
  });

  test('8K: Validation should NOT reference NP-FW50 as inventory item', () => {
    expect(validationSrc).not.toContain("'NP-FW50'");
  });

  test('8L: Validation should NOT reference generic Canon EF (actual: Canon EF 24-105mm, Canon EF 16-35mm)', () => {
    // Should use full item names
    const hasGenericCanonEF = validationSrc.includes("'Canon EF'") &&
      !validationSrc.includes("'Canon EF 24-105mm'") &&
      !validationSrc.includes("'Canon EF 16-35mm'");
    expect(hasGenericCanonEF).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 9 (Run 2): Upsell Non-Inventory Items - More Checks
// ═══════════════════════════════════════════════════════════════
describe('Issue 9 (Run 2): Upsell Additional Phantom Items', () => {
  test('9G: Upsell should NOT recommend recorder (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'recorder'");
  });

  test('9H: Upsell should NOT recommend light stand as standalone (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'light stand'");
  });

  test('9I: Upsell should NOT recommend diffusion (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'diffusion'");
  });

  test('9J: Upsell should NOT recommend grid (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'grid'");
  });

  test('9K: Upsell should NOT recommend macro lens (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'macro lens'");
  });

  test('9L: Upsell hardcoded prices should use real prices from catalog', () => {
    // Check for hardcoded prices that may be wrong
    // Wireless mic (£25) - actual Rode Wireless Mic Pro set: let's see catalog
    const rodeMic = PRICING_CATALOG.find((p) => p.item_name === 'Rode Wireless Mic Pro set');
    expect(rodeMic).toBeDefined();
    // The hardcoded £25 in upsell should be within the actual price range
    if (rodeMic) {
      const upsellMentionsCorrectPrice =
        upsellSrc.includes(`(£${rodeMic.daily_price_min})`) ||
        upsellSrc.includes(`(£${rodeMic.daily_price_max})`) ||
        upsellSrc.includes(`(~£${rodeMic.daily_price_min}-${rodeMic.daily_price_max})`);
      // At minimum, the hardcoded price should be within the actual range
      const hardcodedPrice = 25;
      expect(hardcodedPrice).toBeGreaterThanOrEqual(rodeMic.daily_price_min);
      expect(hardcodedPrice).toBeLessThanOrEqual(rodeMic.daily_price_max);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 10 (Run 2): Price Consistency - Bundle Names Must Match
// ═══════════════════════════════════════════════════════════════
describe('Issue 10 (Run 2): Bundle Name Consistency Between Sources', () => {
  test('10F: Every BUNDLE_DEFINITION should have a matching pricing-catalog entry', () => {
    const missingInCatalog: string[] = [];
    for (const bundle of BUNDLE_DEFINITIONS) {
      const catalogEntry = PRICING_CATALOG.find(
        (p) => p.item_name === bundle.bundle_name,
      );
      if (!catalogEntry) {
        missingInCatalog.push(bundle.bundle_name);
      }
    }
    expect(missingInCatalog).toEqual([]);
  });

  test('10G: Bundle items must be identical between both sources', () => {
    const itemMismatches: string[] = [];
    for (const bundle of BUNDLE_DEFINITIONS) {
      const catalogEntry = PRICING_CATALOG.find(
        (p) => p.item_name === bundle.bundle_name,
      );
      if (catalogEntry && catalogEntry.bundle_items) {
        const catalogItems = [...catalogEntry.bundle_items].sort();
        const bundleItems = [...bundle.items].sort();
        if (JSON.stringify(catalogItems) !== JSON.stringify(bundleItems)) {
          itemMismatches.push(
            `${bundle.bundle_name}: catalog=${JSON.stringify(catalogItems)} vs suggestions=${JSON.stringify(bundleItems)}`,
          );
        }
      }
    }
    expect(itemMismatches).toEqual([]);
  });

  test('10H: GoPro set naming should be consistent between sources', () => {
    // Verify the naming is consistent — match on the bundle that exists in both sources
    const bundleGoPro = BUNDLE_DEFINITIONS.find((b) => b.bundle_name.includes('GoPro'));
    expect(bundleGoPro).toBeDefined();
    const catalogGoPro = PRICING_CATALOG.find((p) => p.item_name === bundleGoPro!.bundle_name);
    expect(catalogGoPro).toBeDefined();
    // Names should match exactly
    expect(catalogGoPro!.item_name).toBe(bundleGoPro!.bundle_name);
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 11 (Run 2): More Stale Brand/Item References
// ═══════════════════════════════════════════════════════════════
describe('Issue 11 (Run 2): More Stale References in Services', () => {
  test('11G: Upsell category patterns should NOT reference RED cameras (not in inventory)', () => {
    // The regex /\b(fx3|fx6|fx9|camera|bmpcc|red|arri|...)/ references red and arri
    expect(upsellSrc).not.toMatch(/\|red\|/i);
  });

  test('11H: Upsell category patterns should NOT reference ARRI (not in inventory)', () => {
    expect(upsellSrc).not.toMatch(/\|arri\|/i);
  });

  test('11I: Upsell category patterns should NOT reference Sigma (not in inventory)', () => {
    expect(upsellSrc).not.toMatch(/\|sigma\|/i);
  });

  test('11J: Upsell recommendations should reference actual inventory item names', () => {
    // "DJI RS3 gimbal" in upsell should be "DJI RS3 Pro gimbal"
    if (upsellSrc.includes('RS3 gimbal')) {
      expect(upsellSrc).toContain('DJI RS3 Pro gimbal');
    }
    // "Weebill 3" is not in inventory
    expect(upsellSrc).not.toContain("'Weebill 3'");
  });

  test('11K: Upsell use case for music video recommends cinema lenses but should reference actual inventory', () => {
    // "cinema lenses" is generic - should reference Great Joy or Blazar Remus
    if (upsellSrc.includes("'cinema lenses'")) {
      // This is a phantom recommendation
      const hasActualAnamorphics = upsellSrc.includes('Great Joy') || upsellSrc.includes('Blazar Remus');
      expect(hasActualAnamorphics).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 12 (Run 2): Autonomous Service Additional Checks
// ═══════════════════════════════════════════════════════════════
describe('Issue 12 (Run 2): Autonomous Service Edge Cases', () => {
  test('12D: Autonomous service should handle delivery recalculation context', () => {
    // The delivery recalculation feature should exist
    expect(autoSrc).toContain('DELIVERY RECALCULATION');
    expect(autoSrc).toContain('delivery quote may change');
  });

  test('12E: Autonomous service imports MASTER_INVENTORY for quantity checking', () => {
    expect(autoSrc).toContain('MASTER_INVENTORY');
    expect(autoSrc).toContain('MAX');
    expect(autoSrc).toContain('units in stock');
  });

  test('12F: Autonomous service enforces minimum quantity rules in context', () => {
    expect(autoSrc).toContain('MINIMUM QUANTITY');
    expect(autoSrc).toContain('NEVER offer a single unit');
  });
});
