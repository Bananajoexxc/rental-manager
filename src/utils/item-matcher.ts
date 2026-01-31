/**
 * Shared utility for fuzzy item name matching across services.
 */

export function normalizeItemName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findBestMatch(input: string, inventory: string[]): string | null {
  const normalized = normalizeItemName(input);
  if (!normalized) return null;

  // Exact match first
  for (const item of inventory) {
    if (normalizeItemName(item) === normalized) return item;
  }

  // Contains match
  for (const item of inventory) {
    const normItem = normalizeItemName(item);
    if (normItem.includes(normalized) || normalized.includes(normItem)) return item;
  }

  // Token overlap scoring
  const inputTokens = normalized.split(' ');
  let bestScore = 0;
  let bestItem: string | null = null;

  for (const item of inventory) {
    const itemTokens = normalizeItemName(item).split(' ');
    let score = 0;
    for (const token of inputTokens) {
      if (itemTokens.some((t) => t.includes(token) || token.includes(t))) {
        score++;
      }
    }
    const ratio = score / Math.max(inputTokens.length, itemTokens.length);
    if (ratio > bestScore && ratio >= 0.4) {
      bestScore = ratio;
      bestItem = item;
    }
  }

  return bestItem;
}

/** Master inventory list with max quantities */
export const MASTER_INVENTORY: Record<string, number> = {
  'Anamorphic Blazar Remus 33mm': 1,
  'Anamorphic Blazar Remus 45mm': 1,
  'Anamorphic Blazar Remus 65mm': 1,
  'Anamorphic Blazar Remus 100mm': 1,
  'Anamorphic Great Joy 35mm': 1,
  'Anamorphic Great Joy 50mm': 1,
  'Anamorphic Great Joy 85mm': 1,
  'Sony GM 24-70mm f2.8': 4,
  'Sony GM 16-35mm f2.8': 1,
  'Sony GM 70-200mm f2.8': 2,
  'Sony GM 90mm f2.8': 1,
  'Sony 28-70mm': 2,
  'Canon EF 24-105mm f4': 1,
  'Canon EF 16-35mm f2.8': 1,
  'Sony 11mm f2.8 fisheye': 1,
  'Sony FX3': 3,
  'Sony A7 III': 1,
  'Sony A7 II': 1,
  'Fujifilm X100 VI': 1,
  'BMPCC 6K Pro': 1,
  'BMPCC 6K Full Frame': 1,
  'Softbox 85cm': 2,
  'V-mount 95mAh': 2,
  'V-mount 150mAh': 4,
  'C-stand': 1,
  'DJI Osmo Action Pro 5': 3,
  'DJI Mavic 3 Pro': 1,
  'LED light panels RGB': 3,
  'DJI gimbal battery': 3,
  'Hollyland Mars 4K transmitter': 1,
  'GoPro 12 Hero': 3,
  'Suction cups': 6,
  'Nanlite Forza 300': 1,
  'Rode Video Mic Go': 1,
  'Camera flash': 1,
  'Rode Wireless Mic Pro set': 2,
  'Audio boom mic Sennheiser': 1,
  'DJI Wireless Mics': 1,
  'Smoke machine fogger': 1,
  'Motorized slider': 1,
  'ND filter': 3,
  '256GB card': 3,
  'Atomos Ninja V': 1,
  'DJI Mini 4 Pro': 1,
  'Cinebloom filter mist': 1,
  'Rode Video Mic Pro Plus': 1,
  'Nanlite Pavotube 30x II': 4,
  'Small rig tripod': 3,
  'Nanlite 500B': 1,
  'JBL wireless microphones': 1,
  'Smoke Ninja Pro hazer': 1,
  'DJ RX3 Pioneer controller': 1,
  'PL to Sony E mount': 2,
  'Anker Power Station F2000': 1,
  'Hollyland Pyro S transmitter': 1,
  'Hollyland 7-inch monitor': 1,
  'PL to EF mount': 1,
  'PL to RF mount': 1,
  'PL to L mount': 1,
  'DJI Mic 2 wireless': 1,
  'Sirui tripod': 1,
  'CF Express Type A card': 1,
  'JBL Club 120 speaker': 2,
  'Ambitful RGB light tubes 2x set': 2,
  'Smoke Ninja': 1,
  'Tilta Nucleus Nano 2 follow focus': 1,
  'Sony NPF 970 batteries 2x sets': 4,
  'Monopod arm support': 1,
  '5-in-1 reflector panel': 1,
  'Tilta shoulder rig': 1,
  'DJI RS3 Pro gimbal': 2,
};

export function getInventoryItemNames(): string[] {
  return Object.keys(MASTER_INVENTORY);
}
