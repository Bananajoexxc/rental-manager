/**
 * INTERNAL PRICING REFERENCE - DO NOT EXPOSE TO RENTERS
 *
 * This is a separate file from MASTER_INVENTORY (item-matcher.ts).
 * MASTER_INVENTORY is the sole source of truth for actual physical stock and quantities.
 *
 * This file contains:
 * - Listed prices for individual items (from Hygglo listings)
 * - Bundle prices (combinations of inventory items at bundle rates)
 * - Marketing-only listings (items listed for data/visibility but not physically available)
 *
 * Bundles do NOT add inventory -- they are pricing tiers for combinations of
 * items that already exist in MASTER_INVENTORY.
 *
 * Some items here may be marketing-only (not in MASTER_INVENTORY).
 * Always validate availability against MASTER_INVENTORY before confirming to renters.
 */

export interface PricingEntry {
  item_name: string;
  category: string;
  daily_price_min: number;
  daily_price_max: number; // This is the ONE-DAY reference price (highest listed)
  is_bundle: boolean;
  bundle_items?: string[]; // Items from MASTER_INVENTORY included in this bundle
  multi_day_notes: string;
  marketing_only?: boolean; // true = listed for data/visibility, not actually available
}

export const PRICING_CATALOG: PricingEntry[] = [
  // ──────────────────────────────────────────
  // CAMERAS (individual)
  // ──────────────────────────────────────────
  { item_name: 'Sony FX3', category: 'camera', daily_price_min: 34, daily_price_max: 40, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Sony A7 III', category: 'camera', daily_price_min: 20, daily_price_max: 30, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Sony A7 II', category: 'camera', daily_price_min: 16, daily_price_max: 28, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Fujifilm X100 VI', category: 'camera', daily_price_min: 30, daily_price_max: 45, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'BMPCC 6K Pro', category: 'camera', daily_price_min: 35, daily_price_max: 50, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'BMPCC 6K Full Frame', category: 'camera', daily_price_min: 35, daily_price_max: 50, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'DJI Osmo Action Pro 5', category: 'camera', daily_price_min: 26, daily_price_max: 33, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'GoPro 12 Hero', category: 'camera', daily_price_min: 16, daily_price_max: 18, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },

  // ──────────────────────────────────────────
  // LENSES (individual)
  // ──────────────────────────────────────────
  { item_name: 'Sony GM 24-70mm f2.8', category: 'lens', daily_price_min: 14, daily_price_max: 20, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Sony GM 70-200mm f2.8', category: 'lens', daily_price_min: 16, daily_price_max: 22, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Sony GM 16-35mm f2.8', category: 'lens', daily_price_min: 14, daily_price_max: 20, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Sony GM 90mm f2.8', category: 'lens', daily_price_min: 10, daily_price_max: 15, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Sony 28-70mm', category: 'lens', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Canon EF 24-105mm f4', category: 'lens', daily_price_min: 8, daily_price_max: 12, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Canon EF 16-35mm f2.8', category: 'lens', daily_price_min: 12, daily_price_max: 18, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Sony 11mm f2.8 fisheye', category: 'lens', daily_price_min: 8, daily_price_max: 12, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Anamorphic Blazar Remus 33mm', category: 'lens', daily_price_min: 26, daily_price_max: 30, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Anamorphic Blazar Remus 45mm', category: 'lens', daily_price_min: 26, daily_price_max: 30, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Anamorphic Blazar Remus 65mm', category: 'lens', daily_price_min: 26, daily_price_max: 30, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Anamorphic Blazar Remus 100mm', category: 'lens', daily_price_min: 26, daily_price_max: 30, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Anamorphic Great Joy 35mm', category: 'lens', daily_price_min: 20, daily_price_max: 33, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Anamorphic Great Joy 50mm', category: 'lens', daily_price_min: 20, daily_price_max: 33, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'Anamorphic Great Joy 85mm', category: 'lens', daily_price_min: 20, daily_price_max: 33, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },

  // ──────────────────────────────────────────
  // MOUNT ADAPTERS
  // ──────────────────────────────────────────
  { item_name: 'PL to Sony E mount', category: 'accessory', daily_price_min: 8, daily_price_max: 12, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'PL to EF mount', category: 'accessory', daily_price_min: 8, daily_price_max: 10, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'PL to RF mount', category: 'accessory', daily_price_min: 8, daily_price_max: 10, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'PL to L mount', category: 'accessory', daily_price_min: 8, daily_price_max: 10, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },

  // ──────────────────────────────────────────
  // DRONES
  // ──────────────────────────────────────────
  { item_name: 'DJI Mavic 3 Pro', category: 'drone', daily_price_min: 36, daily_price_max: 37, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },
  { item_name: 'DJI Mini 4 Pro', category: 'drone', daily_price_min: 18, daily_price_max: 22, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks' },

  // ──────────────────────────────────────────
  // GIMBALS & MOTION
  // ──────────────────────────────────────────
  { item_name: 'DJI RS3 Pro gimbal', category: 'stabilizer', daily_price_min: 18, daily_price_max: 25, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Tilta Nucleus Nano 2 follow focus', category: 'accessory', daily_price_min: 10, daily_price_max: 15, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Motorized slider', category: 'motion', daily_price_min: 21, daily_price_max: 26, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Tilta shoulder rig', category: 'support', daily_price_min: 14, daily_price_max: 20, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },

  // ──────────────────────────────────────────
  // AUDIO
  // ──────────────────────────────────────────
  { item_name: 'Rode Wireless Mic Pro set', category: 'audio', daily_price_min: 17, daily_price_max: 26, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Audio boom mic Sennheiser', category: 'audio', daily_price_min: 17, daily_price_max: 27, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'DJI Wireless Mics', category: 'audio', daily_price_min: 14, daily_price_max: 15, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'DJI Mic 2 wireless', category: 'audio', daily_price_min: 15, daily_price_max: 18, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Rode Video Mic Go', category: 'audio', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Rode Video Mic Pro Plus', category: 'audio', daily_price_min: 8, daily_price_max: 12, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'JBL wireless microphones', category: 'audio', daily_price_min: 10, daily_price_max: 15, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },

  // ──────────────────────────────────────────
  // LIGHTING & EFFECTS
  // ──────────────────────────────────────────
  { item_name: 'Nanlite 500B', category: 'lighting', daily_price_min: 19, daily_price_max: 30, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Nanlite Forza 300', category: 'lighting', daily_price_min: 20, daily_price_max: 30, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Nanlite Pavotube 30x II', category: 'lighting', daily_price_min: 12, daily_price_max: 18, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'LED light panels RGB', category: 'lighting', daily_price_min: 15, daily_price_max: 25, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Ambitful RGB light tubes 2x set', category: 'lighting', daily_price_min: 4, daily_price_max: 18, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Softbox 85cm', category: 'lighting', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'C-stand', category: 'support', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Camera flash', category: 'lighting', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: '5-in-1 reflector panel', category: 'lighting', daily_price_min: 5, daily_price_max: 7, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Smoke machine fogger', category: 'effects', daily_price_min: 21, daily_price_max: 27, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Smoke Ninja Pro hazer', category: 'effects', daily_price_min: 25, daily_price_max: 35, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Smoke Ninja', category: 'effects', daily_price_min: 15, daily_price_max: 22, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },

  // ──────────────────────────────────────────
  // MONITORS & TRANSMITTERS
  // ──────────────────────────────────────────
  { item_name: 'Atomos Ninja V', category: 'monitor', daily_price_min: 15, daily_price_max: 20, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Hollyland 7-inch monitor', category: 'monitor', daily_price_min: 15, daily_price_max: 20, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Hollyland Mars 4K transmitter', category: 'video', daily_price_min: 13, daily_price_max: 25, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Hollyland Pyro S transmitter', category: 'video', daily_price_min: 15, daily_price_max: 20, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },

  // ──────────────────────────────────────────
  // POWER
  // ──────────────────────────────────────────
  { item_name: 'V-mount 95mAh', category: 'power', daily_price_min: 11, daily_price_max: 15, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'V-mount 150mAh', category: 'power', daily_price_min: 20, daily_price_max: 28, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Anker Power Station F2000', category: 'power', daily_price_min: 25, daily_price_max: 35, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Sony NPF 970 batteries 2x sets', category: 'power', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'DJI gimbal battery', category: 'power', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },

  // ──────────────────────────────────────────
  // SUPPORT & ACCESSORIES
  // ──────────────────────────────────────────
  { item_name: 'Small rig tripod', category: 'support', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Sirui tripod', category: 'support', daily_price_min: 8, daily_price_max: 12, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Monopod arm support', category: 'support', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: '256GB card', category: 'accessory', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'CF Express Type A card', category: 'accessory', daily_price_min: 8, daily_price_max: 12, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'ND filter', category: 'accessory', daily_price_min: 5, daily_price_max: 8, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Cinebloom filter mist', category: 'accessory', daily_price_min: 5, daily_price_max: 7, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'Suction cups', category: 'accessory', daily_price_min: 5, daily_price_max: 10, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },

  // ──────────────────────────────────────────
  // SPEAKERS & DJ
  // ──────────────────────────────────────────
  { item_name: 'JBL Club 120 speaker', category: 'dj', daily_price_min: 39, daily_price_max: 49, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },
  { item_name: 'DJ RX3 Pioneer controller', category: 'dj', daily_price_min: 40, daily_price_max: 55, is_bundle: false, multi_day_notes: '3 days ~2.5x, 7 days ~5x' },

  // ══════════════════════════════════════════
  // BUNDLES (combinations of MASTER_INVENTORY items at bundle pricing)
  // These do NOT add to stock -- they are pricing tiers
  // ══════════════════════════════════════════

  // Camera bundles
  {
    item_name: 'Sony FX3 + 24-70mm GM Kit',
    category: 'bundle', daily_price_min: 41, daily_price_max: 60, is_bundle: true,
    bundle_items: ['Sony FX3', 'Sony GM 24-70mm f2.8'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks',
  },
  {
    item_name: 'Sony FX3 + 24-70mm GM + RS Gimbal Kit',
    category: 'bundle', daily_price_min: 40, daily_price_max: 70, is_bundle: true,
    bundle_items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks',
  },
  {
    item_name: 'Sony FX3 Full Production Kit',
    category: 'bundle', daily_price_min: 100, daily_price_max: 120, is_bundle: true,
    bundle_items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal', 'Rode Wireless Mic Pro set', 'Atomos Ninja V', 'ND filter'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks',
  },
  {
    item_name: '2x Sony FX3 Set',
    category: 'bundle', daily_price_min: 57, daily_price_max: 90, is_bundle: true,
    bundle_items: ['Sony FX3', 'Sony FX3'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },
  {
    item_name: 'BMPCC 6K Pro Cinema Kit',
    category: 'bundle', daily_price_min: 79, daily_price_max: 140, is_bundle: true,
    bundle_items: ['BMPCC 6K Pro', 'Canon EF 24-105mm f4', 'DJI RS3 Pro gimbal', 'Atomos Ninja V'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x, 1 month ~2.5 weeks',
  },
  {
    item_name: 'BMPCC 6K Pro Interview Kit',
    category: 'bundle', daily_price_min: 57, daily_price_max: 75, is_bundle: true,
    bundle_items: ['BMPCC 6K Pro', 'Canon EF 24-105mm f4', 'Nanlite Pavotube 30x II', 'Rode Wireless Mic Pro set'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },

  // Lens bundles
  {
    item_name: 'Sony GM Triple Lens Set',
    category: 'bundle', daily_price_min: 35, daily_price_max: 55, is_bundle: true,
    bundle_items: ['Sony GM 16-35mm f2.8', 'Sony GM 24-70mm f2.8', 'Sony GM 70-200mm f2.8'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },
  {
    item_name: 'Great Joy Anamorphic Set (35+50+85mm)',
    category: 'bundle', daily_price_min: 50, daily_price_max: 99, is_bundle: true,
    bundle_items: ['Anamorphic Great Joy 35mm', 'Anamorphic Great Joy 50mm', 'Anamorphic Great Joy 85mm'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },
  {
    item_name: 'Blazar Remus 4-Lens Anamorphic Set',
    category: 'bundle', daily_price_min: 80, daily_price_max: 120, is_bundle: true,
    bundle_items: ['Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm', 'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },

  // DJ & speaker bundle (delivery mandatory)
  {
    item_name: 'JBL Speakers + Pioneer DJ RX3 Set',
    category: 'bundle', daily_price_min: 79, daily_price_max: 100, is_bundle: true,
    bundle_items: ['JBL Club 120 speaker', 'JBL Club 120 speaker', 'DJ RX3 Pioneer controller'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x. DELIVERY MANDATORY for this bundle.',
  },

  // Lighting bundles
  {
    item_name: 'Interview Lighting Kit',
    category: 'bundle', daily_price_min: 25, daily_price_max: 40, is_bundle: true,
    bundle_items: ['LED light panels RGB', 'LED light panels RGB', 'Softbox 85cm'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },
  {
    item_name: 'Full Lighting Kit',
    category: 'bundle', daily_price_min: 50, daily_price_max: 70, is_bundle: true,
    bundle_items: ['Nanlite Forza 300', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'C-stand'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },
  {
    item_name: '2x Nanlite Pavotube 30x II Set',
    category: 'bundle', daily_price_min: 20, daily_price_max: 30, is_bundle: true,
    bundle_items: ['Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },
  {
    item_name: '4x Nanlite Pavotube 30x II Set',
    category: 'bundle', daily_price_min: 35, daily_price_max: 50, is_bundle: true,
    bundle_items: ['Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },
  {
    item_name: '3x GoPro Hero 12 Set',
    category: 'bundle', daily_price_min: 30, daily_price_max: 40, is_bundle: true,
    bundle_items: ['GoPro 12 Hero', 'GoPro 12 Hero', 'GoPro 12 Hero'],
    multi_day_notes: '3 days ~2.5x, 7 days ~5x',
  },
];

// ──────────────────────────────────────────
// Helper functions
// ──────────────────────────────────────────

/** Look up individual item price (non-bundle) */
export function getItemPrice(itemName: string): PricingEntry | undefined {
  const lower = itemName.toLowerCase();
  return PRICING_CATALOG.find(
    (p) => p.item_name.toLowerCase() === lower && !p.is_bundle,
  );
}

/** Find all bundles containing a given item */
export function getBundlesContaining(itemName: string): PricingEntry[] {
  const lower = itemName.toLowerCase();
  return PRICING_CATALOG.filter(
    (p) =>
      p.is_bundle &&
      p.bundle_items?.some((bi) => bi.toLowerCase() === lower),
  );
}

/** Get the one-day reference price (daily_price_max) */
export function getOneDayPrice(itemName: string): number | null {
  const entry = getItemPrice(itemName);
  return entry ? entry.daily_price_max : null;
}

/** Format full catalog as text for AI context */
export function formatPricingCatalogForAI(): string {
  const categories = new Map<string, PricingEntry[]>();
  for (const entry of PRICING_CATALOG) {
    if (entry.marketing_only) continue; // skip marketing-only items
    const cat = entry.is_bundle ? 'BUNDLES' : entry.category.toUpperCase();
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(entry);
  }

  const parts: string[] = ['=== COMPLETE PRICING CATALOG (INTERNAL - prices are estimates) ==='];
  for (const [cat, entries] of categories) {
    parts.push(`\n[${cat}]`);
    for (const e of entries) {
      const bundleTag = e.is_bundle && e.bundle_items ? ` (includes: ${e.bundle_items.join(' + ')})` : '';
      parts.push(`- ${e.item_name}: £${e.daily_price_max}/day (range £${e.daily_price_min}-${e.daily_price_max})${bundleTag}`);
    }
  }
  parts.push(
    '\nPRICING RULES: One-day price = highest listed price shown above. ' +
    'Multi-day discounts auto-applied: 3 days ~2.5x daily, 7 days ~5x daily, 1 month ~2.5 weeks. ' +
    'Hygglo adds ~15% service fee at checkout. ' +
    'Always validate item availability against master inventory before confirming.',
  );
  return parts.join('\n');
}
