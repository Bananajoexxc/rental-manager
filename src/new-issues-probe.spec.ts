/**
 * PROBING TEST SUITE: New issues discovered beyond the original 7.
 * Run 1 of 3: Primary detection tests.
 *
 * These tests probe areas NOT covered by the original rental-fixes tests:
 * - Issue 8: Validation service stale inventory list
 * - Issue 9: Upsell service references non-inventory items
 * - Issue 10: Price mismatches between bundle-suggestions and pricing-catalog
 * - Issue 11: Upsell service stale brand references in category matching
 * - Issue 12: Autonomous service fallback price estimate accuracy
 */

import { MASTER_INVENTORY, getInventoryItemNames } from './utils/item-matcher';
import { PRICING_CATALOG } from './data/pricing-catalog';
import { BUNDLE_DEFINITIONS } from './data/bundle-suggestions';

const fs = require('fs');
const path = require('path');
const readSource = (relPath: string) => fs.readFileSync(path.join(__dirname, relPath), 'utf8');

const validationSrc = readSource('validation/validation.service.ts');
const upsellSrc = readSource('upsell/upsell.service.ts');
const autoSrc = readSource('autonomous/autonomous.service.ts');

// ═══════════════════════════════════════════════════════════════
// ISSUE 8: Validation Service Stale Inventory List
// ═══════════════════════════════════════════════════════════════
describe('Issue 8: Validation Service Inventory Integrity', () => {
  // Extract the hardcoded masterInventory array from validation source
  function extractValidationInventory(): string[] {
    const match = validationSrc.match(/const masterInventory\s*=\s*\[([\s\S]*?)\];/);
    if (!match) return [];
    const items = match[1].match(/'([^']+)'/g) || [];
    return items.map((i: string) => i.replace(/'/g, ''));
  }

  const validationItems = extractValidationInventory();
  const realInventoryNames = getInventoryItemNames();

  test('8A: Validation service should NOT reference Aputure items (not in inventory)', () => {
    expect(validationSrc).not.toContain("'Aputure 300D'");
    expect(validationSrc).not.toContain("'Aputure 120D'");
  });

  test('8B: Validation service should NOT reference BMPCC 4K (not in inventory)', () => {
    // Actual inventory has BMPCC 6K Pro and BMPCC 6K Full Frame
    expect(validationSrc).not.toContain("'BMPCC 4K'");
  });

  test('8C: Validation service should NOT reference Sennheiser MKE 600 (not in inventory)', () => {
    // Actual item is "Audio boom mic Sennheiser"
    expect(validationSrc).not.toContain("'Sennheiser MKE 600'");
  });

  test('8D: Validation service should NOT reference Ronin-S or DJI RS2 (not in inventory)', () => {
    expect(validationSrc).not.toContain("'Ronin-S'");
    expect(validationSrc).not.toContain("'DJI RS2'");
  });

  test('8E: Validation service should reference actual items like BMPCC 6K Pro', () => {
    // At least some real inventory items should be in the validation list
    const hasRealItems =
      validationSrc.includes("'BMPCC 6K Pro'") ||
      validationSrc.includes("'BMPCC 6K Full Frame'") ||
      validationSrc.includes("'Nanlite Pavotube'") ||
      validationSrc.includes('getInventoryItemNames') ||
      validationSrc.includes('MASTER_INVENTORY');
    expect(hasRealItems).toBe(true);
  });

  test('8F: Every item in validation masterInventory should exist in MASTER_INVENTORY or be a known alias', () => {
    const knownAliases: Record<string, string> = {
      'Sony GM 24-70mm': 'Sony GM 24-70mm f2.8',
      'Sony GM 70-200mm': 'Sony GM 70-200mm f2.8',
      'DJI RS3': 'DJI RS3 Pro gimbal',
      'DJI Mavic': 'DJI Mavic 3 Pro',
      'DJI Mini': 'DJI Mini 4 Pro',
      'CFexpress': 'CF Express Type A card',
      'Rode VideoMic': 'Rode Video Mic Go',
      'Nanlite 500B': 'Nanlite Forza 500B II',
    };

    const phantomItems: string[] = [];
    for (const item of validationItems) {
      const isInInventory = realInventoryNames.some(
        (inv) => inv.toLowerCase().includes(item.toLowerCase()) || item.toLowerCase().includes(inv.toLowerCase()),
      );
      const isKnownAlias = item in knownAliases;
      if (!isInInventory && !isKnownAlias) {
        phantomItems.push(item);
      }
    }
    // Should have ZERO phantom items
    expect(phantomItems).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 9: Upsell Service Non-Inventory Items
// ═══════════════════════════════════════════════════════════════
describe('Issue 9: Upsell Service Inventory Alignment', () => {
  test('9A: Upsell should NOT recommend teleprompter (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'teleprompter'");
  });

  test('9B: Upsell should NOT recommend boom pole (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'boom pole'");
  });

  test('9C: Upsell should NOT recommend headphones (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'headphones'");
  });

  test('9D: Upsell should NOT recommend landing pad (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'landing pad'");
  });

  test('9E: Upsell should NOT recommend turntable (not in inventory)', () => {
    expect(upsellSrc).not.toContain("'turntable'");
  });

  test('9F: Upsell should NOT reference cage (not in inventory)', () => {
    // Inventory has no generic "cage" — only Tilta shoulder rig
    expect(upsellSrc).not.toContain("'cage'");
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 10: Price Mismatches Between Data Sources
// ═══════════════════════════════════════════════════════════════
describe('Issue 10: Price Consistency Between bundle-suggestions and pricing-catalog', () => {
  test('10A: Sony FX3 + 24-70mm GM Kit prices must match between both sources', () => {
    const catalog = PRICING_CATALOG.find((p) => p.item_name === 'Sony FX3 + 24-70mm GM Kit');
    const bundle = BUNDLE_DEFINITIONS.find((b) => b.bundle_name === 'Sony FX3 + 24-70mm GM Kit');
    expect(catalog).toBeDefined();
    expect(bundle).toBeDefined();
    expect(catalog!.daily_price_min).toBe(bundle!.daily_price_min);
    expect(catalog!.daily_price_max).toBe(bundle!.daily_price_max);
  });

  test('10B: Sony FX3 + RS3 Gimbal Kit prices must match between both sources', () => {
    const catalogName = 'Sony FX3 + 24-70mm GM + RS3 Gimbal Kit';
    const bundleName = 'Sony FX3 + 24-70mm GM + RS3 Gimbal Kit';
    const catalog = PRICING_CATALOG.find((p) => p.item_name === catalogName);
    const bundle = BUNDLE_DEFINITIONS.find((b) => b.bundle_name === bundleName);
    expect(catalog).toBeDefined();
    expect(bundle).toBeDefined();
    expect(catalog!.daily_price_min).toBe(bundle!.daily_price_min);
    expect(catalog!.daily_price_max).toBe(bundle!.daily_price_max);
  });

  test('10C: 2x Sony FX3 Set prices must match between both sources', () => {
    const catalog = PRICING_CATALOG.find((p) => p.item_name === '2x Sony FX3 Set');
    const bundle = BUNDLE_DEFINITIONS.find((b) => b.bundle_name === '2x Sony FX3 Set');
    expect(catalog).toBeDefined();
    expect(bundle).toBeDefined();
    expect(catalog!.daily_price_min).toBe(bundle!.daily_price_min);
    expect(catalog!.daily_price_max).toBe(bundle!.daily_price_max);
  });

  test('10D: BMPCC 6K Pro Cinema Kit prices must match between both sources', () => {
    const catalog = PRICING_CATALOG.find((p) => p.item_name === 'BMPCC 6K Pro Cinema Kit');
    const bundle = BUNDLE_DEFINITIONS.find((b) => b.bundle_name === 'BMPCC 6K Pro Cinema Kit');
    expect(catalog).toBeDefined();
    expect(bundle).toBeDefined();
    expect(catalog!.daily_price_min).toBe(bundle!.daily_price_min);
    expect(catalog!.daily_price_max).toBe(bundle!.daily_price_max);
  });

  test('10E: ALL bundles in both sources must have matching prices', () => {
    const mismatches: string[] = [];
    for (const bundle of BUNDLE_DEFINITIONS) {
      const catalogEntry = PRICING_CATALOG.find(
        (p) => p.item_name === bundle.bundle_name,
      );
      if (catalogEntry) {
        if (catalogEntry.daily_price_min !== bundle.daily_price_min) {
          mismatches.push(
            `${bundle.bundle_name}: min price ${catalogEntry.daily_price_min} (catalog) vs ${bundle.daily_price_min} (bundle-suggestions)`,
          );
        }
        if (catalogEntry.daily_price_max !== bundle.daily_price_max) {
          mismatches.push(
            `${bundle.bundle_name}: max price ${catalogEntry.daily_price_max} (catalog) vs ${bundle.daily_price_max} (bundle-suggestions)`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 11: Upsell Service Stale Brand References
// ═══════════════════════════════════════════════════════════════
describe('Issue 11: Upsell Service Brand Reference Accuracy', () => {
  test('11A: Category matching should NOT reference Aputure (not in inventory)', () => {
    // Regex patterns in categorizeItems() should not match brands not in inventory
    expect(upsellSrc).not.toMatch(/aputure/i);
  });

  test('11B: Category matching should NOT reference Godox (not in inventory)', () => {
    expect(upsellSrc).not.toMatch(/godox/i);
  });

  test('11C: Category matching should NOT reference Ronin (not in inventory)', () => {
    // Actual item: DJI RS3 Pro gimbal
    expect(upsellSrc).not.toMatch(/\bronin\b/i);
  });

  test('11D: Category matching should NOT reference Weebill (not in inventory)', () => {
    expect(upsellSrc).not.toMatch(/weebill/i);
  });

  test('11E: Category matching should NOT reference DZO (not in inventory)', () => {
    expect(upsellSrc).not.toMatch(/\bdzo\b/i);
  });

  test('11F: Category matching should NOT reference haze machine (actual: Smoke machine fogger)', () => {
    expect(upsellSrc).not.toContain("'haze machine'");
  });
});

// ═══════════════════════════════════════════════════════════════
// ISSUE 12: Autonomous Service Price Estimate Accuracy
// ═══════════════════════════════════════════════════════════════
describe('Issue 12: Autonomous Service Price Estimate', () => {
  test('12A: Fallback price estimate should use pricing catalog, not hardcoded £40', () => {
    // The £40 hardcoded estimate is wildly inaccurate for items like Softbox (£5-8),
    // Pavotube (£12-18), GoPro (£16-18), etc.
    // It should either reference PRICING_CATALOG or use a more accurate median
    expect(autoSrc).not.toMatch(/return\s+itemCount\s*\*\s*40/);
  });

  test('12B: Estimate function should reference pricing catalog or actual prices', () => {
    const usesCatalog =
      autoSrc.includes('PRICING_CATALOG') ||
      autoSrc.includes('pricing_catalog') ||
      autoSrc.includes('pricingCatalog');
    // If not using catalog, at least the estimate should be more than just £40
    expect(usesCatalog).toBe(true);
  });

  test('12C: Minimum quantity items map should include all set-only items', () => {
    // Currently only Pavotube is listed. Check it exists.
    expect(autoSrc).toContain("'Nanlite Pavotube 30x II'");
    // Verify the structure has min and sets
    expect(autoSrc).toMatch(/Nanlite Pavotube 30x II.*min:\s*2/s);
  });
});
