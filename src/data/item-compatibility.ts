/**
 * ITEM COMPATIBILITY LIST - INTERNAL REFERENCE
 *
 * Maps each camera/device to its compatible batteries, cards, lenses, and accessories.
 * Used by the bot to recommend the CORRECT accessories when a renter asks for
 * spare batteries, cards, etc. for a specific camera.
 *
 * Example: Sony FX3 uses NP-FZ100 batteries -- do NOT recommend "just any battery".
 *          BMPCC 6K Pro uses LP-E6NH and Canon EF mount -- NOT Sony E-mount lenses.
 *
 * All items referenced must exist in MASTER_INVENTORY (item-matcher.ts) for availability.
 */

export interface CompatibilityEntry {
  item_name: string;
  battery_type: string;                // The actual battery model used
  compatible_batteries: string[];      // Battery items from our inventory
  card_type: string;                   // Card format info
  compatible_cards: string[];          // Card items from our inventory
  lens_mount: string;                  // Mount system
  compatible_lenses: string[];         // Lenses from our inventory that fit
  compatible_accessories: string[];    // Other accessories that work well
  included_with_rental: string[];      // What's included in the rental by default
  notes: string;
}

export const ITEM_COMPATIBILITY: CompatibilityEntry[] = [
  // ──────────────────────────────────────────
  // SONY CAMERAS
  // ──────────────────────────────────────────
  {
    item_name: 'Sony FX3',
    battery_type: 'Sony NP-FZ100',
    compatible_batteries: ['Sony NPF 970 batteries 2x sets'], // NPF for external monitors; FZ100 included
    card_type: 'CFexpress Type A + SD UHS-II',
    compatible_cards: ['CF Express Type A card', '256GB card'],
    lens_mount: 'Sony E-mount (full frame)',
    compatible_lenses: [
      'Sony GM 24-70mm f2.8', 'Sony GM 16-35mm f2.8', 'Sony GM 70-200mm f2.8',
      'Sony GM 90mm f2.8', 'Sony 28-70mm', 'Sony 11mm f2.8 fisheye',
      'Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm',
      'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm',
      'Anamorphic Great Joy 35mm', 'Anamorphic Great Joy 50mm', 'Anamorphic Great Joy 85mm',
    ],
    compatible_accessories: [
      'DJI RS3 Pro gimbal', 'Atomos Ninja V', 'Hollyland Mars 4K transmitter',
      'Hollyland Pyro S transmitter', 'Hollyland 7-inch monitor', 'ND filter',
      'Cinebloom filter mist', 'Tilta shoulder rig', 'Tilta Nucleus Nano 2 follow focus',
      'V-mount 95mAh', 'V-mount 150mAh', 'Small rig tripod', 'Sirui tripod',
      'Motorized slider', 'PL to Sony E mount',
    ],
    included_with_rental: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'Uses NP-FZ100 battery (NOT NP-FW50). Sony E-mount full frame. CFexpress Type A primary slot, SD secondary. V-mount battery rental includes all necessary plates, adapters, and cables for external power. NPF 970 batteries power the Atomos Ninja V monitor, not the FX3 directly.',
  },
  {
    item_name: 'Sony A7 III',
    battery_type: 'Sony NP-FZ100',
    compatible_batteries: ['Sony NPF 970 batteries 2x sets'],
    card_type: 'SD UHS-I/II dual slot',
    compatible_cards: ['256GB card'],
    lens_mount: 'Sony E-mount (full frame)',
    compatible_lenses: [
      'Sony GM 24-70mm f2.8', 'Sony GM 16-35mm f2.8', 'Sony GM 70-200mm f2.8',
      'Sony GM 90mm f2.8', 'Sony 28-70mm', 'Sony 11mm f2.8 fisheye',
      'Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm',
      'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm',
      'Anamorphic Great Joy 35mm', 'Anamorphic Great Joy 50mm', 'Anamorphic Great Joy 85mm',
    ],
    compatible_accessories: [
      'DJI RS3 Pro gimbal', 'ND filter', 'Cinebloom filter mist',
      'Tilta shoulder rig', 'Small rig tripod', 'Sirui tripod',
      'PL to Sony E mount',
    ],
    included_with_rental: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'Uses NP-FZ100 battery (same as FX3). Sony E-mount full frame. Dual SD card slots. Good hybrid photo/video body.',
  },
  {
    item_name: 'Sony A7 II',
    battery_type: 'Sony NP-FW50',
    compatible_batteries: [], // We don't stock NP-FW50 as a separate rental
    card_type: 'SD UHS-I single slot',
    compatible_cards: ['256GB card'],
    lens_mount: 'Sony E-mount (full frame)',
    compatible_lenses: [
      'Sony GM 24-70mm f2.8', 'Sony GM 16-35mm f2.8', 'Sony GM 70-200mm f2.8',
      'Sony GM 90mm f2.8', 'Sony 28-70mm', 'Sony 11mm f2.8 fisheye',
      'Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm',
      'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm',
      'Anamorphic Great Joy 35mm', 'Anamorphic Great Joy 50mm', 'Anamorphic Great Joy 85mm',
    ],
    compatible_accessories: [
      'DJI RS3 Pro gimbal', 'ND filter', 'Cinebloom filter mist',
      'Small rig tripod', 'Sirui tripod', 'PL to Sony E mount',
    ],
    included_with_rental: ['2x NP-FW50 batteries', '64GB SD card'],
    notes: 'IMPORTANT: Uses NP-FW50 battery -- this is DIFFERENT from the FX3/A7III which use NP-FZ100. Batteries are NOT interchangeable. E-mount full frame, single SD slot.',
  },

  // ──────────────────────────────────────────
  // FUJIFILM
  // ──────────────────────────────────────────
  {
    item_name: 'Fujifilm X100 VI',
    battery_type: 'Fujifilm NP-W126S',
    compatible_batteries: [], // We don't stock NP-W126S separately
    card_type: 'SD UHS-I/II single slot',
    compatible_cards: ['256GB card'],
    lens_mount: 'Fixed 23mm f/2 lens (not interchangeable)',
    compatible_lenses: [], // Fixed lens camera
    compatible_accessories: ['ND filter', 'Cinebloom filter mist', 'Small rig tripod'],
    included_with_rental: ['2x NP-W126S batteries', '64GB SD card'],
    notes: 'Fixed lens camera -- NO interchangeable lenses. Uses Fujifilm NP-W126S battery (not Sony). Great for street/travel photography.',
  },

  // ──────────────────────────────────────────
  // BLACKMAGIC CAMERAS
  // ──────────────────────────────────────────
  {
    item_name: 'BMPCC 6K Pro',
    battery_type: 'Canon LP-E6NH',
    compatible_batteries: ['Sony NPF 970 batteries 2x sets'], // NPF for external power via adapter plate
    card_type: 'CFast 2.0 + SD UHS-II',
    compatible_cards: ['256GB card'], // SD slot; CFast not separately stocked
    lens_mount: 'Canon EF mount',
    compatible_lenses: [
      'Canon EF 24-105mm f4', 'Canon EF 16-35mm f2.8',
    ],
    compatible_accessories: [
      'DJI RS3 Pro gimbal', 'Atomos Ninja V', 'Hollyland Mars 4K transmitter',
      'Hollyland Pyro S transmitter', 'Hollyland 7-inch monitor',
      'V-mount 95mAh', 'V-mount 150mAh', // V-mount external power recommended
      'Tilta shoulder rig', 'Tilta Nucleus Nano 2 follow focus',
      'Small rig tripod', 'Sirui tripod', 'ND filter',
      'PL to EF mount', // Can use PL lenses with adapter
    ],
    included_with_rental: ['5x LP-E6NH batteries', '128GB SD card'],
    notes: 'Uses Canon LP-E6NH batteries (NOT Sony NP-FZ100). Comes with 5x LP-E6NH batteries. Canon EF mount -- Sony E-mount lenses do NOT fit. V-mount external power strongly recommended for long shoots as LP-E6NH drains fast. V-mount battery rental includes all necessary plates, adapters, and cables. NPF 970 batteries work with the Atomos Ninja V monitor.',
  },
  {
    item_name: 'BMPCC 6K Full Frame',
    battery_type: 'Canon LP-E6NH',
    compatible_batteries: ['Sony NPF 970 batteries 2x sets'],
    card_type: 'CFast 2.0 + SD UHS-II',
    compatible_cards: ['256GB card'],
    lens_mount: 'Leica L-mount (native)',
    compatible_lenses: [
      'Canon EF 24-105mm f4', 'Canon EF 16-35mm f2.8', // Via L-mount to EF adapter
    ],
    compatible_accessories: [
      'DJI RS3 Pro gimbal', 'Atomos Ninja V', 'Hollyland Mars 4K transmitter',
      'V-mount 95mAh', 'V-mount 150mAh',
      'Tilta shoulder rig', 'Tilta Nucleus Nano 2 follow focus',
      'Small rig tripod', 'Sirui tripod', 'ND filter',
      'PL to L mount', // PL glass with adapter
    ],
    included_with_rental: ['5x LP-E6NH batteries', '128GB SD card'],
    notes: 'Native L-mount. Canon EF lenses work via adapter (included). Uses LP-E6NH like the 6K Pro. Comes with 5x LP-E6NH batteries. V-mount strongly recommended. V-mount battery rental includes all necessary plates, adapters, and cables. Sony lenses do NOT fit.',
  },

  // ──────────────────────────────────────────
  // ACTION CAMERAS
  // ──────────────────────────────────────────
  {
    item_name: 'DJI Osmo Action Pro 5',
    battery_type: 'DJI Osmo Action battery (proprietary)',
    compatible_batteries: [],
    card_type: 'microSD',
    compatible_cards: ['256GB card'],
    lens_mount: 'Fixed wide-angle lens',
    compatible_lenses: [],
    compatible_accessories: ['Suction cups'],
    included_with_rental: ['2x DJI batteries', 'microSD card', 'mounting kit'],
    notes: 'Proprietary DJI battery. Fixed wide-angle lens. Waterproof. Comes with mounting accessories.',
  },
  {
    item_name: 'GoPro 12 Hero',
    battery_type: 'GoPro Enduro battery (proprietary)',
    compatible_batteries: [],
    card_type: 'microSD',
    compatible_cards: ['256GB card'],
    lens_mount: 'Fixed wide-angle lens',
    compatible_lenses: [],
    compatible_accessories: ['Suction cups'],
    included_with_rental: ['2x GoPro batteries', 'microSD card', 'mounting kit'],
    notes: 'Proprietary GoPro battery. Fixed wide-angle lens. Waterproof. GoPro mount system.',
  },

  // ──────────────────────────────────────────
  // DRONES
  // ──────────────────────────────────────────
  {
    item_name: 'DJI Mavic 3 Pro',
    battery_type: 'DJI Intelligent Flight Battery (proprietary)',
    compatible_batteries: [],
    card_type: 'microSD + 8GB internal',
    compatible_cards: ['256GB card'],
    lens_mount: 'Fixed triple-camera system',
    compatible_lenses: [],
    compatible_accessories: ['ND filter'], // Mavic ND filter set
    included_with_rental: ['3x flight batteries', 'charging hub', 'RC Pro controller', 'ND filters'],
    notes: 'Fly More Combo included. Proprietary DJI batteries. Fixed cameras (Hasselblad + 70mm + 166mm). 46min max flight time per battery.',
  },
  {
    item_name: 'DJI Mini 4 Pro',
    battery_type: 'DJI Mini series Intelligent Flight Battery',
    compatible_batteries: [],
    card_type: 'microSD',
    compatible_cards: ['256GB card'],
    lens_mount: 'Fixed camera',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['3x flight batteries', 'charging hub', 'RC2 controller'],
    notes: 'Under 249g (no drone registration needed in most cases). Proprietary DJI Mini battery. Fixed 1/1.3" camera.',
  },

  // ──────────────────────────────────────────
  // GIMBALS
  // ──────────────────────────────────────────
  {
    item_name: 'DJI RS3 Pro gimbal',
    battery_type: 'DJI RS BG30 grip battery',
    compatible_batteries: ['DJI gimbal battery'],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'Quick-release plate (universal)',
    compatible_lenses: [], // Supports any camera, not lens-specific
    compatible_accessories: [
      'Tilta Nucleus Nano 2 follow focus', 'Small rig tripod',
    ],
    included_with_rental: ['BG30 grip battery', 'quick release plate', 'cables'],
    notes: 'Compatible with all our cameras (Sony FX3, A7 III, BMPCC, etc.) via quick release plate. Max payload ~4.5kg. DJI gimbal battery extends runtime. Tilta Nucleus Nano 2 can be mounted for remote focus control.',
  },

  // ──────────────────────────────────────────
  // MONITORS & RECORDERS
  // ──────────────────────────────────────────
  {
    item_name: 'Atomos Ninja V',
    battery_type: 'Sony NP-F (NPF 970 compatible)',
    compatible_batteries: ['Sony NPF 970 batteries 2x sets'],
    card_type: 'AtomOS SSD (SSD included)',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [
      'V-mount 95mAh', 'V-mount 150mAh', // For powering camera + monitor via D-tap
    ],
    included_with_rental: ['NPF 970 battery', 'SSD', 'HDMI cable', 'mounting arm'],
    notes: '5" HDR monitor/recorder. Powered by Sony NPF 970 batteries (our NPF battery sets work perfectly). HDMI input from any camera. Can record ProRes/DNx.',
  },
  {
    item_name: 'Hollyland 7-inch monitor',
    battery_type: 'Sony NP-F (NPF 970 compatible)',
    compatible_batteries: ['Sony NPF 970 batteries 2x sets'],
    card_type: 'N/A (monitoring only)',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['NPF 970 battery', 'HDMI cable'],
    notes: '7" monitor. Uses NPF 970 batteries. HDMI input.',
  },

  // ──────────────────────────────────────────
  // LIGHTING (V-mount compatible)
  // ──────────────────────────────────────────
  {
    item_name: 'Nanlite Forza 300',
    battery_type: 'AC power / V-mount battery',
    compatible_batteries: ['V-mount 95mAh', 'V-mount 150mAh'],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['C-stand', 'Softbox 85cm'],
    included_with_rental: ['AC power cable', 'reflector', 'carry bag'],
    notes: 'High-power LED. AC power standard, V-mount for portable use. V-mount 150mAh recommended for adequate runtime. C-stand recommended for support.',
  },
  {
    item_name: 'Nanlite 500B',
    battery_type: 'AC power / V-mount battery',
    compatible_batteries: ['V-mount 95mAh', 'V-mount 150mAh'],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['C-stand', 'Softbox 85cm'],
    included_with_rental: ['AC power cable', 'reflector'],
    notes: 'Powerful bi-color LED. V-mount for portable use. Very power-hungry -- V-mount 150mAh recommended. Heavy unit, C-stand essential.',
  },
];

// ──────────────────────────────────────────
// Helper functions
// ──────────────────────────────────────────

/** Get compatibility info for a specific item */
export function getCompatibility(itemName: string): CompatibilityEntry | undefined {
  const lower = itemName.toLowerCase();
  return ITEM_COMPATIBILITY.find(
    (c) => c.item_name.toLowerCase() === lower,
  );
}

/** Get recommended rentable accessories for an item (from our inventory only) */
export function getRecommendedAccessories(itemName: string): string[] {
  const compat = getCompatibility(itemName);
  if (!compat) return [];
  return [
    ...compat.compatible_batteries,
    ...compat.compatible_cards,
    ...compat.compatible_accessories,
  ];
}

/** Reverse lookup: given an accessory name, which main items is it compatible with? */
export function getCompatibleMainItems(accessoryName: string): string[] {
  const lower = accessoryName.toLowerCase();
  return ITEM_COMPATIBILITY
    .filter((c) =>
      c.compatible_batteries.some((b) => b.toLowerCase().includes(lower) || lower.includes(b.toLowerCase())) ||
      c.compatible_cards.some((b) => b.toLowerCase().includes(lower) || lower.includes(b.toLowerCase())) ||
      c.compatible_accessories.some((b) => b.toLowerCase().includes(lower) || lower.includes(b.toLowerCase())),
    )
    .map((c) => c.item_name);
}

/** Format compatibility info for AI context */
export function formatCompatibilityForAI(itemNames: string[]): string {
  const parts: string[] = [];
  for (const name of itemNames) {
    const compat = getCompatibility(name);
    if (!compat) continue;
    parts.push(
      `${name}:\n` +
      `  Battery: ${compat.battery_type}${compat.compatible_batteries.length ? ' | Rentable: ' + compat.compatible_batteries.join(', ') : ' (included, no separate rental)'}\n` +
      `  Cards: ${compat.card_type}${compat.compatible_cards.length ? ' | Rentable: ' + compat.compatible_cards.join(', ') : ''}\n` +
      `  Mount: ${compat.lens_mount}${compat.compatible_lenses.length ? '\n  Lenses: ' + compat.compatible_lenses.join(', ') : ''}\n` +
      `  Included: ${compat.included_with_rental.join(', ')}\n` +
      `  Note: ${compat.notes}`,
    );
  }
  if (parts.length === 0) return '';
  return `=== ITEM COMPATIBILITY (use this to recommend correct accessories) ===\n${parts.join('\n\n')}`;
}
