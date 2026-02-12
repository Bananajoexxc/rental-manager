/**
 * ACQUISITION COST CHART — Internal reference for evaluating rental opportunity ROI.
 *
 * Used by the "acquisition opportunity" rule: if a renter requests an item NOT in inventory,
 * and the rental value exceeds 30% of the acquisition cost, alert Daniel immediately.
 *
 * Prices are approximate NEW UK retail (or used-good where noted).
 * Categories help the AI match renter requests to likely items even with fuzzy naming.
 */

export interface AcquisitionEntry {
  name: string;           // Common name (how renters ask for it)
  aliases: string[];      // Alternative names renters might use
  category: string;
  cost_gbp: number;       // Approximate acquisition cost in GBP
}

export const ACQUISITION_COSTS: AcquisitionEntry[] = [
  // ═══════════════════════════════════════
  // CAMERAS
  // ═══════════════════════════════════════
  { name: 'Sony FX6', aliases: ['fx6'], category: 'camera', cost_gbp: 5200 },
  { name: 'Sony FX30', aliases: ['fx30'], category: 'camera', cost_gbp: 1800 },
  { name: 'Sony A7S III', aliases: ['a7s3', 'a7s iii', 'a7siii'], category: 'camera', cost_gbp: 3200 },
  { name: 'Sony A7 IV', aliases: ['a7iv', 'a74', 'a7 iv'], category: 'camera', cost_gbp: 2100 },
  { name: 'Sony A7R V', aliases: ['a7rv', 'a7r5', 'a7r v'], category: 'camera', cost_gbp: 3500 },
  { name: 'Sony A7C II', aliases: ['a7c2', 'a7c ii'], category: 'camera', cost_gbp: 1900 },
  { name: 'Sony A1', aliases: ['a1', 'alpha 1'], category: 'camera', cost_gbp: 5800 },
  { name: 'Canon R5', aliases: ['r5', 'eos r5'], category: 'camera', cost_gbp: 3800 },
  { name: 'Canon R5 II', aliases: ['r5 ii', 'r5 mark ii', 'r5ii'], category: 'camera', cost_gbp: 4300 },
  { name: 'Canon R6 II', aliases: ['r6 ii', 'r6 mark ii', 'r6ii'], category: 'camera', cost_gbp: 2300 },
  { name: 'Canon R3', aliases: ['r3', 'eos r3'], category: 'camera', cost_gbp: 5200 },
  { name: 'Canon C70', aliases: ['c70', 'eos c70'], category: 'camera', cost_gbp: 4800 },
  { name: 'Canon C300 III', aliases: ['c300', 'c300 iii', 'c300 mark iii'], category: 'camera', cost_gbp: 9500 },
  { name: 'RED Komodo', aliases: ['komodo', 'red komodo'], category: 'camera', cost_gbp: 5500 },
  { name: 'RED Komodo-X', aliases: ['komodo x', 'red komodo x'], category: 'camera', cost_gbp: 14000 },
  { name: 'RED V-Raptor', aliases: ['v-raptor', 'raptor'], category: 'camera', cost_gbp: 20000 },
  { name: 'Blackmagic Pocket 4K', aliases: ['bmpcc 4k', 'pocket 4k', 'bmpcc4k'], category: 'camera', cost_gbp: 1100 },
  { name: 'Blackmagic URSA Mini Pro 12K', aliases: ['ursa 12k', 'ursa mini pro'], category: 'camera', cost_gbp: 5500 },
  { name: 'Panasonic S5 II', aliases: ['s5 ii', 's5ii', 'lumix s5 ii'], category: 'camera', cost_gbp: 1700 },
  { name: 'Panasonic S1H', aliases: ['s1h', 'lumix s1h'], category: 'camera', cost_gbp: 3000 },
  { name: 'Panasonic GH7', aliases: ['gh7', 'lumix gh7'], category: 'camera', cost_gbp: 2100 },
  { name: 'Nikon Z8', aliases: ['z8'], category: 'camera', cost_gbp: 3600 },
  { name: 'Nikon Z6 III', aliases: ['z6 iii', 'z6iii', 'z6 3'], category: 'camera', cost_gbp: 2400 },
  { name: 'Fujifilm X-T5', aliases: ['xt5', 'x-t5'], category: 'camera', cost_gbp: 1500 },
  { name: 'Fujifilm X-H2S', aliases: ['xh2s', 'x-h2s'], category: 'camera', cost_gbp: 2100 },
  { name: 'GoPro Hero 13', aliases: ['gopro 13', 'hero 13'], category: 'camera', cost_gbp: 350 },
  { name: 'DJI Pocket 3', aliases: ['pocket 3', 'osmo pocket 3'], category: 'camera', cost_gbp: 450 },

  // ═══════════════════════════════════════
  // LENSES
  // ═══════════════════════════════════════
  { name: 'Sony GM 50mm f1.2', aliases: ['50mm 1.2', 'gm 50 1.2'], category: 'lens', cost_gbp: 1800 },
  { name: 'Sony GM 35mm f1.4', aliases: ['35mm 1.4', 'gm 35 1.4'], category: 'lens', cost_gbp: 1300 },
  { name: 'Sony GM 85mm f1.4', aliases: ['85mm 1.4', 'gm 85 1.4'], category: 'lens', cost_gbp: 1600 },
  { name: 'Sony GM 135mm f1.8', aliases: ['135mm 1.8', 'gm 135'], category: 'lens', cost_gbp: 1600 },
  { name: 'Sony GM 14mm f1.8', aliases: ['14mm 1.8', 'gm 14'], category: 'lens', cost_gbp: 1300 },
  { name: 'Sony GM 24mm f1.4', aliases: ['24mm 1.4', 'gm 24 1.4'], category: 'lens', cost_gbp: 1200 },
  { name: 'Sony GM 100-400mm', aliases: ['100-400', 'gm 100-400'], category: 'lens', cost_gbp: 2200 },
  { name: 'Sony GM 200-600mm', aliases: ['200-600', 'gm 200-600'], category: 'lens', cost_gbp: 1800 },
  { name: 'Canon RF 24-70mm f2.8', aliases: ['rf 24-70', 'canon 24-70 2.8'], category: 'lens', cost_gbp: 2200 },
  { name: 'Canon RF 70-200mm f2.8', aliases: ['rf 70-200', 'canon 70-200 2.8'], category: 'lens', cost_gbp: 2500 },
  { name: 'Canon RF 15-35mm f2.8', aliases: ['rf 15-35'], category: 'lens', cost_gbp: 2100 },
  { name: 'Canon RF 50mm f1.2', aliases: ['rf 50 1.2'], category: 'lens', cost_gbp: 2000 },
  { name: 'Canon RF 85mm f1.2', aliases: ['rf 85 1.2'], category: 'lens', cost_gbp: 2500 },
  { name: 'Sigma 24-70mm f2.8 Art', aliases: ['sigma 24-70', 'sigma art 24-70'], category: 'lens', cost_gbp: 900 },
  { name: 'Sigma 14-24mm f2.8 Art', aliases: ['sigma 14-24'], category: 'lens', cost_gbp: 1100 },
  { name: 'Sigma 70-200mm f2.8 Art', aliases: ['sigma 70-200'], category: 'lens', cost_gbp: 1200 },
  { name: 'Sigma 35mm f1.4 Art', aliases: ['sigma 35 1.4'], category: 'lens', cost_gbp: 600 },
  { name: 'Sigma 85mm f1.4 Art', aliases: ['sigma 85 1.4'], category: 'lens', cost_gbp: 700 },
  { name: 'Sigma 105mm f2.8 Macro', aliases: ['sigma macro', 'sigma 105 macro'], category: 'lens', cost_gbp: 550 },
  { name: 'Laowa 24mm Probe', aliases: ['probe lens', 'laowa probe', 'macro probe'], category: 'lens', cost_gbp: 1400 },
  { name: 'Anamorphic Blazar Remus 25mm', aliases: ['remus 25mm', 'blazar 25'], category: 'lens', cost_gbp: 1200 },
  { name: 'Anamorphic Blazar Remus 75mm', aliases: ['remus 75mm', 'blazar 75'], category: 'lens', cost_gbp: 1200 },
  { name: 'Anamorphic Atlas Orion set', aliases: ['atlas orion', 'orion anamorphic'], category: 'lens', cost_gbp: 15000 },

  // ═══════════════════════════════════════
  // LIGHTING
  // ═══════════════════════════════════════
  { name: 'Aputure 600D Pro', aliases: ['600d', 'aputure 600d', 'ls 600d'], category: 'lighting', cost_gbp: 1600 },
  { name: 'Aputure 600X Pro', aliases: ['600x', 'aputure 600x'], category: 'lighting', cost_gbp: 2200 },
  { name: 'Aputure 300D II', aliases: ['300d', 'aputure 300d'], category: 'lighting', cost_gbp: 900 },
  { name: 'Aputure 300X', aliases: ['300x', 'aputure 300x'], category: 'lighting', cost_gbp: 1200 },
  { name: 'Aputure 1200D Pro', aliases: ['1200d', 'aputure 1200d'], category: 'lighting', cost_gbp: 3500 },
  { name: 'Aputure Nova P600C', aliases: ['nova p600c', 'aputure nova'], category: 'lighting', cost_gbp: 3000 },
  { name: 'Nanlite Forza 500 II', aliases: ['forza 500', 'nanlite 500'], category: 'lighting', cost_gbp: 900 },
  { name: 'Nanlite Forza 720', aliases: ['forza 720', 'nanlite 720'], category: 'lighting', cost_gbp: 1500 },
  { name: 'Nanlite Pavotube 60x II', aliases: ['pavotube 60', 'nanlite 60'], category: 'lighting', cost_gbp: 500 },
  { name: 'Nanlite Pavotube 15x II', aliases: ['pavotube 15', 'nanlite 15'], category: 'lighting', cost_gbp: 200 },
  { name: 'Godox SL200 III', aliases: ['sl200', 'godox 200'], category: 'lighting', cost_gbp: 350 },
  { name: 'ARRI SkyPanel S60-C', aliases: ['skypanel', 'arri skypanel', 's60'], category: 'lighting', cost_gbp: 5000 },
  { name: 'Kino Flo Celeb 450', aliases: ['kino flo', 'celeb 450'], category: 'lighting', cost_gbp: 3500 },
  { name: 'Astera Titan Tube set', aliases: ['astera titan', 'titan tubes', 'astera'], category: 'lighting', cost_gbp: 4000 },

  // ═══════════════════════════════════════
  // AUDIO
  // ═══════════════════════════════════════
  { name: 'Rode NTG5', aliases: ['ntg5', 'rode ntg5', 'rode shotgun'], category: 'audio', cost_gbp: 450 },
  { name: 'Sennheiser MKH 416', aliases: ['mkh 416', 'sennheiser 416'], category: 'audio', cost_gbp: 900 },
  { name: 'Zoom F6 recorder', aliases: ['zoom f6', 'f6 recorder'], category: 'audio', cost_gbp: 550 },
  { name: 'Zoom F8n Pro', aliases: ['f8n', 'zoom f8n'], category: 'audio', cost_gbp: 900 },
  { name: 'Sound Devices MixPre-6 II', aliases: ['mixpre', 'sound devices', 'mixpre 6'], category: 'audio', cost_gbp: 750 },
  { name: 'Sennheiser EW 112P G4', aliases: ['ew 112', 'sennheiser wireless', 'g4 wireless'], category: 'audio', cost_gbp: 450 },
  { name: 'Tentacle Sync E set', aliases: ['tentacle sync', 'timecode sync'], category: 'audio', cost_gbp: 500 },

  // ═══════════════════════════════════════
  // DRONES
  // ═══════════════════════════════════════
  { name: 'DJI Inspire 3', aliases: ['inspire 3'], category: 'drone', cost_gbp: 13000 },
  { name: 'DJI Mavic 3 Cine', aliases: ['mavic 3 cine', 'mavic cine'], category: 'drone', cost_gbp: 4000 },
  { name: 'DJI Air 3', aliases: ['air 3', 'dji air 3'], category: 'drone', cost_gbp: 900 },
  { name: 'DJI Avata 2', aliases: ['avata 2', 'avata', 'fpv drone'], category: 'drone', cost_gbp: 600 },
  { name: 'FPV custom build', aliases: ['fpv', 'fpv drone', 'racing drone'], category: 'drone', cost_gbp: 1500 },

  // ═══════════════════════════════════════
  // STABILISATION / SUPPORT
  // ═══════════════════════════════════════
  { name: 'DJI RS4 Pro', aliases: ['rs4', 'rs4 pro', 'ronin rs4'], category: 'stabilisation', cost_gbp: 800 },
  { name: 'DJI Ronin 4D', aliases: ['ronin 4d', '4d gimbal'], category: 'stabilisation', cost_gbp: 6500 },
  { name: 'Easyrig Minimax', aliases: ['easyrig', 'easy rig', 'minimax'], category: 'stabilisation', cost_gbp: 2200 },
  { name: 'Sachtler Video 18 tripod', aliases: ['sachtler', 'video 18', 'sachtler tripod'], category: 'stabilisation', cost_gbp: 2500 },
  { name: 'Manfrotto 504X tripod', aliases: ['504x', 'manfrotto 504'], category: 'stabilisation', cost_gbp: 600 },
  { name: 'Dana Dolly', aliases: ['dana dolly', 'dolly'], category: 'stabilisation', cost_gbp: 1200 },
  { name: 'Slider 120cm', aliases: ['slider', 'camera slider', '120cm slider'], category: 'stabilisation', cost_gbp: 400 },

  // ═══════════════════════════════════════
  // MONITORS / TRANSMISSION
  // ═══════════════════════════════════════
  { name: 'SmallHD Cine 7', aliases: ['cine 7', 'smallhd 7'], category: 'monitor', cost_gbp: 2000 },
  { name: 'SmallHD 702 Touch', aliases: ['702 touch', 'smallhd 702'], category: 'monitor', cost_gbp: 1100 },
  { name: 'Atomos Shogun 7', aliases: ['shogun 7', 'atomos shogun'], category: 'monitor', cost_gbp: 1200 },
  { name: 'Teradek Bolt 4K', aliases: ['teradek bolt', 'bolt 4k', 'teradek'], category: 'monitor', cost_gbp: 4000 },
  { name: 'Hollyland Mars 400S Pro', aliases: ['mars 400s', 'hollyland 400'], category: 'monitor', cost_gbp: 350 },

  // ═══════════════════════════════════════
  // GRIP / MISC
  // ═══════════════════════════════════════
  { name: 'Blackout curtain / butterfly frame', aliases: ['butterfly frame', 'blackout', 'neg fill'], category: 'grip', cost_gbp: 500 },
  { name: 'Green screen kit', aliases: ['green screen', 'chroma key', 'chromakey'], category: 'grip', cost_gbp: 200 },
  { name: 'Teleprompter', aliases: ['teleprompter', 'autocue'], category: 'grip', cost_gbp: 400 },
  { name: 'ViewSonic Projector', aliases: ['projector', 'viewsonic'], category: 'misc', cost_gbp: 600 },
  { name: 'Portable generator', aliases: ['generator', 'power generator'], category: 'misc', cost_gbp: 800 },
];

/**
 * Find a matching acquisition entry for a renter's request.
 * Uses fuzzy name + alias matching.
 */
export function findAcquisitionMatch(query: string): AcquisitionEntry | null {
  const q = query.toLowerCase().trim();
  if (q.length < 3) return null;

  // Exact name match
  for (const entry of ACQUISITION_COSTS) {
    if (entry.name.toLowerCase() === q) return entry;
  }

  // Alias match
  for (const entry of ACQUISITION_COSTS) {
    for (const alias of entry.aliases) {
      if (q.includes(alias) || alias.includes(q)) return entry;
    }
  }

  // Fuzzy: check if query tokens overlap with entry name tokens
  const qTokens = q.split(/[\s\-\/]+/).filter(t => t.length > 1);
  let bestMatch: AcquisitionEntry | null = null;
  let bestScore = 0;

  for (const entry of ACQUISITION_COSTS) {
    const nameTokens = entry.name.toLowerCase().split(/[\s\-\/]+/).filter(t => t.length > 1);
    const allTokens = [...nameTokens, ...entry.aliases.flatMap(a => a.split(/[\s\-\/]+/))];

    let matches = 0;
    for (const qt of qTokens) {
      if (allTokens.some(t => t.includes(qt) || qt.includes(t))) {
        matches++;
      }
    }

    const score = qTokens.length > 0 ? matches / qTokens.length : 0;
    if (score > bestScore && score >= 0.5 && matches >= 2) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  return bestMatch;
}

// ════════════════════════════════════════════════════════════
// OWNED ITEM COSTS — Purchase prices for Daniel's ACTUAL inventory
// Used by sell recommender to calculate purchase cost ROI.
// ════════════════════════════════════════════════════════════

export const OWNED_ITEM_COSTS: Record<string, number> = {
  // Anamorphic lenses
  'Anamorphic Blazar Remus 33mm': 650,
  'Anamorphic Blazar Remus 45mm': 650,
  'Anamorphic Blazar Remus 65mm': 650,
  'Anamorphic Blazar Remus 100mm': 650,
  'Anamorphic Great Joy lens 35mm': 350,
  'Anamorphic Great Joy lens 50mm': 350,
  'Anamorphic Great Joy lens 85mm': 350,
  // Sony lenses
  'Sony GM 24-70mm f2.8': 1800,
  'Sony GM 16-35mm f2.8': 1600,
  'Sony GM 70-200mm f2.8': 1800,
  'Sony GM 90mm f2.8': 600,
  'Sony 28-70mm': 200,
  'Sony 11mm f2.8 fisheye': 280,
  // Canon lenses
  'Canon EF 24-105mm f4': 400,
  'Canon EF 16-35mm f2.8': 600,
  // Camera bodies
  'Sony FX3': 3300,
  'Sony A7 III': 1200,
  'Sony A7 II': 600,
  'Fujifilm X100 VI': 1400,
  'BMPCC 6K Pro': 1800,
  'BMPCC 6K Full Frame': 2000,
  // Lights & modifiers
  'Softbox 85cm': 30,
  'LED light panels RGB': 80,
  'Nanlite Forza 300': 500,
  'Nanlite Pavotube 30x II': 350,
  'Nanlite 500B': 650,
  'Ambitful RGB light tubes 2x set': 180,
  '5-in-1 reflector panel': 25,
  'Camera flash': 60,
  // Power
  'Anker Power Station F2000': 1200,
  // Support & gimbals
  'C-stand': 80,
  'Small rig tripod': 60,
  'Sirui tripod': 250,
  'DJI RS3 Pro gimbal': 700,
  'Motorized slider': 350,
  'Tilta Nucleus Nano 2 follow focus': 250,
  'Tilta shoulder rig': 150,
  'Monopod arm support': 40,
  // Monitors & transmitters
  'Atomos Ninja V': 500,
  'Hollyland Mars 4K transmitter': 350,
  'Hollyland Pyro S transmitter': 250,
  'Hollyland 7-inch monitor': 400,
  // Audio
  'Rode Video Mic Go': 50,
  'Rode Wireless Mic Pro set': 250,
  'Rode Video Mic Pro Plus': 200,
  'Audio boom mic Sennheiser': 300,
  'DJI Wireless Mics': 250,
  'DJI Mic 2 wireless': 280,
  'JBL wireless microphones': 100,
  // Drones & action cams
  'DJI Mavic 3 Pro': 1800,
  'DJI Mini 4 Pro': 700,
  'DJI Osmo Action Pro 5': 350,
  'GoPro 12 Hero': 350,
  // DJ & speakers
  'DJ RX3 Pioneer controller': 900,
  'JBL Club 120 speaker': 250,
  // Smoke & effects
  'Smoke machine fogger': 50,
  'Smoke Ninja Pro hazer': 180,
  'Smoke Ninja': 130,
};

/**
 * Get the purchase cost for an owned inventory item.
 * Direct lookup first, then fuzzy fallback via findAcquisitionMatch().
 */
export function getOwnedItemCost(itemName: string): number | null {
  // Direct lookup
  if (OWNED_ITEM_COSTS[itemName] !== undefined) {
    return OWNED_ITEM_COSTS[itemName];
  }

  // Fuzzy fallback: try acquisition costs table
  const match = findAcquisitionMatch(itemName);
  if (match) {
    return match.cost_gbp;
  }

  return null;
}

/**
 * Check if a rental request for a non-inventory item is a potential acquisition opportunity.
 * Returns the opportunity details if rental value >= 30% of acquisition cost, null otherwise.
 */
export function checkAcquisitionOpportunity(
  itemQuery: string,
  rentalDays: number,
  estimatedDailyRate?: number,
): {
  item: AcquisitionEntry;
  estimatedRentalValue: number;
  acquisitionCost: number;
  roiPercent: number;
} | null {
  const match = findAcquisitionMatch(itemQuery);
  if (!match) return null;

  // Estimate daily rental rate: ~2-3% of acquisition cost is typical
  const dailyRate = estimatedDailyRate || Math.round(match.cost_gbp * 0.025);

  // Multi-day pricing: 3 days ~2.5x, 7 days ~5x (same as existing catalog)
  let rentalValue: number;
  if (rentalDays <= 1) {
    rentalValue = dailyRate;
  } else if (rentalDays <= 3) {
    rentalValue = dailyRate * rentalDays * 0.85;
  } else if (rentalDays <= 7) {
    rentalValue = dailyRate * 5; // week rate
  } else {
    rentalValue = dailyRate * 5 * (rentalDays / 7); // weekly rate extrapolated
  }

  rentalValue = Math.round(rentalValue);
  const roiPercent = Math.round((rentalValue / match.cost_gbp) * 100);

  if (roiPercent >= 30) {
    return {
      item: match,
      estimatedRentalValue: rentalValue,
      acquisitionCost: match.cost_gbp,
      roiPercent,
    };
  }

  return null;
}
