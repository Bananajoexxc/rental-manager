/**
 * Shared utility for fuzzy item name matching across services.
 */

// Common aliases: normalize variant spellings AND brand abbreviations to canonical forms
const ALIASES: Record<string, string> = {
  microphones: 'mics',
  microphone: 'mic',
  stabiliser: 'stabilizer',
  colour: 'color',
  grey: 'gray',
  centre: 'center',
  // Brand/product abbreviations — Hygglo titles use long forms, inventory uses short
  gmaster: 'gm',
  'g master': 'gm',
  'cinema camera': 'camera',
  'full frame': 'ff',
  monolight: 'light',
  'led light': 'light',
  // Camera model aliases
  'a7v': 'a7 v',
  'a75': 'a7 v',
  'alpha 7 v': 'a7 v',
  'a7 5': 'a7 v',
  'xt5': 'x t5',
  // Aputure model aliases (600X and 600D are DIFFERENT products — no alias)
  '300d': '300d',
  '300d2': '300d ii',
  'amaran': 'amaran',
  // DZO aliases
  dzofilm: 'dzo',
  'dzo film': 'dzo',
  // DJ controller aliases
  'xdj rx2': 'rx2',
  'xdj rx3': 'rx3',
  // Rode aliases
  'wireless go': 'wireless go',
  'wireless go ii': 'wireless go ii',
  ntg5: 'ntg5',
  'ntg 5': 'ntg5',
  // Drone aliases
  'mavic 4': 'mavic 4',
  'mavic4': 'mavic 4',
};

export function normalizeItemName(input: string): string {
  let result = input
    .toLowerCase()
    // Replace hyphens with spaces BEFORE stripping special chars (so "g-master" → "g master" → alias match)
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Apply aliases (multi-word first, then single-word to avoid partial matches)
  const sortedAliases = Object.entries(ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of sortedAliases) {
    result = result.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }

  return result;
}

/**
 * Generate additional token variants for model number matching.
 * E.g., "a7iii" also checks "a7", "a7 iii"; "6k" stays "6k".
 * Only splits when there's an actual number involved (not "vmount" → "v"+"mount").
 */
function getTokenVariants(token: string): string[] {
  const variants = [token];
  if (/\d/.test(token) && /[a-z]/.test(token)) {
    // Try splitting at letter→digit and digit→letter boundaries
    const split = token.replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2');
    if (split !== token) {
      const parts = split.split(' ');
      // Add the joined alphanumeric prefix: "a7iii" → "a7" (useful model ID)
      // and any meaningful parts (≥2 chars)
      for (const part of parts) {
        if (part.length >= 2 && !variants.includes(part)) {
          variants.push(part);
        }
      }
      // Also add combined prefix forms: "a7iii" → "a7 iii" as a combined variant
      // by including contiguous subsets
      if (parts.length >= 2) {
        const prefix = parts[0] + parts[1]; // e.g., "a7"
        if (prefix.length >= 2 && !variants.includes(prefix)) {
          variants.push(prefix);
        }
      }
    }
  }
  return variants;
}

// Words too generic to match alone — must pair with a product-specific token
const GENERIC_TOKENS = new Set([
  'wireless', 'audio', 'mic', 'mics', 'video', 'pro', 'set', 'kit', 'light', 'lights',
  'camera', 'cameras', 'lens', 'lenses', 'battery', 'batteries', 'card', 'cards',
  'filter', 'filters', 'mount', 'plate', 'plates',
  'adapter', 'adapters', 'cable', 'cables', 'case', 'bag', 'charger', 'chargers',
  'holder', 'stand', 'stands', 'dome', 'softbox',
  'arm', 'arms', 'support', 'panel', 'panels', 'tube', 'tubes',
  'speaker', 'speakers', 'controller', 'dj',
  'dji', 'jbl', 'nanlite', 'hollyland', 'tilta',
  // NOTE: sony, canon, rode deliberately NOT generic — brand mismatch must block cross-brand matching
  'to', 'for', 'with', 'and', 'the', 'in', 'on', 'of', 'pl',
  'microphone', 'microphones', 'vmount',
  // Quantity markers — too generic to differentiate products
  '1x', '2x', '3x', '4x', '5x', '6x',
  // Noise words common in Hygglo listing titles (NOT model identifiers like gm, iii, ii)
  'zoom', 'tele', 'telephoto', 'wide', 'angle', 'prime', 'ff',
  '4k', 'full', 'frame', 'cinema', 'photo', 'photography', 'filming',
  'professional', 'rental', 'hire', 'rent', 'london', 'uk',
]);

export function findBestMatch(input: string, inventory: string[]): string | null {
  const normalized = normalizeItemName(input);
  if (!normalized) return null;

  // Exact match first
  for (const item of inventory) {
    if (normalizeItemName(item) === normalized) return item;
  }

  // Contains match — only if the shorter string is at least 3 tokens
  // AND shares a brand/product token (prevents cross-brand matches)
  let bestContains: string | null = null;
  let bestContainsLen = 0;
  for (const item of inventory) {
    const normItem = normalizeItemName(item);
    const shorter = normalized.length <= normItem.length ? normalized : normItem;
    if (shorter.split(' ').length >= 3) {
      if (normItem.includes(normalized) || normalized.includes(normItem)) {
        // Prefer the item with the longest overlap
        const overlap = Math.min(normalized.length, normItem.length);
        if (overlap > bestContainsLen) {
          bestContainsLen = overlap;
          bestContains = item;
        }
      }
    }
  }
  if (bestContains) return bestContains;

  // Category keyword matching — only shortcut when exactly ONE inventory item matches
  // (prevents "anamorphic" from returning first of 7 anamorphic lenses)
  const categoryKeywords: Record<string, string[]> = {
    fisheye: ['fisheye', 'fish eye'],
    anamorphic: ['anamorphic', 'blazar', 'great joy', 'remus'],
    gimbal: ['gimbal', 'rs3', 'stabiliser', 'stabilizer'],
    drone: ['drone', 'mavic', 'mini 4', 'avata'],
    tripod: ['tripod'],
    slider: ['slider'],
    monitor: ['monitor', 'atomos ninja', 'hollyland 7'],
    partybox: ['partybox', 'party box'],
    nanlite: ['nanlite', 'pavotube', 'forza'],
  };
  for (const [, keywords] of Object.entries(categoryKeywords)) {
    const matchesInput = keywords.some(kw => normalized.includes(kw));
    if (matchesInput) {
      const candidates = inventory.filter(item => {
        const normItem = normalizeItemName(item);
        return keywords.some(kw => normItem.includes(kw));
      });
      if (candidates.length === 1) {
        return candidates[0]; // unambiguous category match
      }
      // Multiple candidates — fall through to token scoring for disambiguation
    }
  }

  // Token overlap scoring — stricter rules to prevent false positives
  const inputTokens = normalized.split(' ');
  let bestScore = 0;
  let bestItem: string | null = null;

  // Brand detection for cross-brand blocking
  const BRANDS = ['sony', 'canon', 'blackmagic', 'bmpcc', 'fujifilm', 'panasonic', 'nikon', 'red',
    'aputure', 'nanlite', 'rode', 'dji', 'sennheiser', 'pioneer', 'viewsonic', 'anker', 'arri', 'dzo', 'sigma', '7artisans'];
  const inputBrands = BRANDS.filter(b => normalized.includes(b));

  for (const item of inventory) {
    const normItem = normalizeItemName(item);
    const itemTokens = normItem.split(' ');

    // Brand conflict check: if input specifies a brand not in this inventory item, skip
    if (inputBrands.length > 0) {
      const itemBrands = BRANDS.filter(b => normItem.includes(b));
      if (itemBrands.length > 0 && !inputBrands.some(ib => itemBrands.includes(ib))) {
        continue; // e.g., "Canon RF" input should never match "Sony" inventory item
      }
    }

    let score = 0;
    let specificMatches = 0; // non-generic token matches

    for (const token of inputTokens) {
      if (token.length < 2) continue; // skip tiny tokens like "a", "x"
      const isSubstringMatch = (a: string, b: string) => {
        const shorter = a.length <= b.length ? a : b;
        const longer = a.length > b.length ? a : b;
        return shorter.length >= 4 && longer.includes(shorter) && shorter.length / longer.length >= 0.6;
      };
      // Check token variants for model numbers (e.g., "a7iii" → "a7", "iii")
      // Only expand input tokens to variants; match against original item tokens
      // to prevent FX30's "fx" variant from matching FX3's "fx" variant
      const variants = getTokenVariants(token);
      if (itemTokens.some((t) => variants.some(v => t === v || isSubstringMatch(v, t)))) {
        score++;
        if (!GENERIC_TOKENS.has(token)) {
          specificMatches++;
        }
      }
    }

    // Require at least 1 specific (non-generic) matching token
    if (specificMatches === 0) continue;

    // Require at least 2 matching tokens total
    if (score < 2) continue;

    // Focal length conflict check: if both input and candidate have mm-tokens
    // (e.g., "24mm", "90mm", "200mm") and NONE overlap, these are different lenses.
    // Prevents "Sony 12-24mm f2.8 GM" from matching "Sony GM 90mm f2.8".
    const mmPattern = /^\d+mm$/;
    const inputMmTokens = inputTokens.filter(t => mmPattern.test(t));
    const itemMmTokens = itemTokens.filter(t => mmPattern.test(t));
    if (inputMmTokens.length > 0 && itemMmTokens.length > 0) {
      const hasFocalOverlap = inputMmTokens.some(imt => itemMmTokens.includes(imt));
      if (!hasFocalOverlap) continue; // Different focal lengths = different product
    }

    // Use coverage of the INVENTORY item (shorter side) as primary metric.
    // This handles long Hygglo titles matching short inventory names.
    // Secondary: require at least 30% of the longer string to prevent pure noise matches.
    const coverageRatio = score / Math.min(inputTokens.length, itemTokens.length);
    const overlapRatio = score / Math.max(inputTokens.length, itemTokens.length);
    if (coverageRatio > bestScore && coverageRatio >= 0.5 && overlapRatio >= 0.25) {
      bestScore = coverageRatio;
      bestItem = item;
    }
  }

  return bestItem;
}

/**
 * Items that are accessories — bundled with cameras but should never create standalone bookings.
 * Revenue should be attributed to the main equipment item, not split with accessories.
 */
export const ACCESSORY_ITEMS = new Set([
  'PL to Sony E mount',
  'PL to EF mount',
  'PL to RF mount',
  'PL to L mount',
  'CF Express Type A card',
  'ND filter',
  'Cinebloom filter mist',
  '256GB card',
  'DJI gimbal battery',
  'Sony NPF 970 batteries 2x sets',
  'V-mount 95mAh',
  'V-mount 150mAh',
  'Suction cups',
]);

export function isAccessoryItem(name: string): boolean {
  return ACCESSORY_ITEMS.has(name);
}

/**
 * DEFINITIVE MASTER INVENTORY — Daniel's authoritative list (Feb 9 2026).
 * DO NOT EDIT without Daniel's explicit written permission.
 * Everything not on this list is marketing-only (externally: "currently out of stock").
 */
export const MASTER_INVENTORY: Record<string, number> = {
  // Anamorphic lenses
  'Anamorphic Blazar Remus 33mm': 1,
  'Anamorphic Blazar Remus 45mm': 1,
  'Anamorphic Blazar Remus 65mm': 1,
  'Anamorphic Blazar Remus 100mm': 1,
  'Anamorphic Great Joy lens 35mm': 1,
  'Anamorphic Great Joy lens 50mm': 1,
  'Anamorphic Great Joy lens 85mm': 1,
  // Sony lenses
  'Sony GM 24-70mm f2.8': 4,
  'Sony GM 16-35mm f2.8': 1,
  'Sony GM 70-200mm f2.8': 2,
  'Sony GM 90mm f2.8': 1,
  'Sony 28-70mm': 2,
  'Sony 11mm f2.8 fisheye': 1,
  // Canon lenses
  'Canon EF 24-105mm f4': 1,
  'Canon EF 16-35mm f2.8': 1,
  // Camera bodies
  'Sony FX3': 3,
  'Sony A7 III': 1,
  'Sony A7 II': 1,
  'Fujifilm X100 VI': 1,
  'BMPCC 6K Pro': 1,
  'BMPCC 6K Full Frame': 1,
  // Lights & modifiers
  'Softbox 85cm': 2,
  'LED light panels RGB': 3,
  'Nanlite Forza 300': 1,
  'Nanlite Pavotube 30x II': 4,
  'Nanlite 500B': 1,
  'Ambitful RGB light tubes 2x set': 2,
  '5-in-1 reflector panel': 1,
  'Camera flash': 1,
  // Power
  'V-mount 95mAh': 2,
  'V-mount 150mAh': 4,
  'Sony NPF 970 batteries 2x sets': 4,
  'DJI gimbal battery': 3,
  'Anker Power Station F2000': 1,
  // Support & gimbals
  'C-stand': 1,
  'Small rig tripod': 3,
  'Sirui tripod': 1,
  'DJI RS3 Pro gimbal': 2,
  'Motorized slider': 1,
  'Tilta Nucleus Nano 2 follow focus': 1,
  'Tilta shoulder rig': 1,
  'Monopod arm support': 1,
  // Monitors & transmitters
  'Atomos Ninja V': 1,
  'Hollyland Mars 4K transmitter': 1,
  'Hollyland Pyro S transmitter': 1,
  'Hollyland 7-inch monitor': 1,
  // Audio
  'Rode Video Mic Go': 1,
  'Rode Wireless Mic Pro set': 2,
  'Rode Video Mic Pro Plus': 1,
  'Audio boom mic Sennheiser': 1,
  'DJI Wireless Mics': 1,
  'DJI Mic 2 wireless': 1,
  'JBL wireless microphones': 1,
  // Drones & action cams
  'DJI Mavic 3 Pro': 1,
  'DJI Mini 4 Pro': 1,
  'DJI Osmo Action Pro 5': 3,
  'GoPro 12 Hero': 3,
  'Suction cups': 6,
  // DJ & speakers
  'DJ RX3 Pioneer controller': 1,
  'JBL Club 120 speaker': 2,
  // Smoke & effects
  'Smoke machine fogger': 1,
  'Smoke Ninja Pro hazer': 1,
  'Smoke Ninja': 1,
  // Filters & cards
  'ND filter': 3,
  'Cinebloom filter mist': 1,
  '256GB card': 3,
  'CF Express Type A card': 1,
  // Mount adapters
  'PL to Sony E mount': 2,
  'PL to EF mount': 1,
  'PL to RF mount': 1,
  'PL to L mount': 1,
};

export function getInventoryItemNames(): string[] {
  return Object.keys(MASTER_INVENTORY);
}

/**
 * Check whether a listing title maps to a real inventory item.
 * Returns the matched inventory item name, or null if this is
 * a ghost / SEO listing with no physical stock.
 */
export function validateListingAgainstInventory(listingTitle: string): {
  matched: boolean;
  inventoryItem: string | null;
  maxQuantity: number;
} {
  const inventoryNames = getInventoryItemNames();
  const match = findBestMatch(listingTitle, inventoryNames);
  if (match) {
    return { matched: true, inventoryItem: match, maxQuantity: MASTER_INVENTORY[match] };
  }
  return { matched: false, inventoryItem: null, maxQuantity: 0 };
}

/**
 * Extract the requested quantity from a listing title (e.g. "4x Anker F2000" → 4).
 * Returns 1 if no quantity prefix is found.
 */
export function extractListingQuantity(listingTitle: string): number {
  const match = listingTitle.match(/^(\d+)\s*x\s+/i);
  return match ? parseInt(match[1], 10) : 1;
}
