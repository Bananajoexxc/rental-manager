/**
 * BUNDLE SUGGESTION ENGINE
 *
 * Defines bundles with trigger keywords and use cases so the bot can
 * proactively suggest relevant bundles based on what the renter says.
 *
 * Bundles are combinations of items from MASTER_INVENTORY.
 * They do NOT add to stock -- they are pricing tiers.
 */

export interface BundleDefinition {
  bundle_name: string;
  items: string[];
  daily_price_min: number;
  daily_price_max: number;
  use_cases: string[];
  trigger_keywords: string[];
  savings_note: string;
  delivery_note?: string; // e.g. "delivery mandatory"
}

export const BUNDLE_DEFINITIONS: BundleDefinition[] = [
  // ── Camera Production Bundles ──
  {
    bundle_name: 'Sony FX3 + 24-70mm GM Kit',
    items: ['Sony FX3', 'Sony GM 24-70mm f2.8'],
    daily_price_min: 41, daily_price_max: 55,
    use_cases: ['film', 'video', 'run-and-gun', 'wedding', 'event'],
    trigger_keywords: ['fx3', 'sony', 'camera and lens', 'video camera', 'cinema camera', 'filming'],
    savings_note: 'Save vs renting camera + lens separately (~£54-60 individual vs ~£50 bundle)',
  },
  {
    bundle_name: 'Sony FX3 + 24-70mm GM + RS3 Gimbal Kit',
    items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal'],
    daily_price_min: 50, daily_price_max: 70,
    use_cases: ['film', 'documentary', 'music video', 'commercial', 'run-and-gun'],
    trigger_keywords: ['stabilized', 'smooth', 'gimbal', 'handheld', 'music video', 'run and gun'],
    savings_note: 'Save vs renting all 3 separately (~£72-85 individual vs ~£55-70 bundle)',
  },
  {
    bundle_name: 'Sony FX3 Full Production Kit',
    items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal', 'Rode Wireless Mic Pro set', 'Atomos Ninja V', 'ND filter'],
    daily_price_min: 100, daily_price_max: 120,
    use_cases: ['film production', 'documentary', 'commercial', 'short film', 'music video'],
    trigger_keywords: ['production', 'full kit', 'complete setup', 'everything', 'professional', 'shoot', 'short film', 'commercial shoot'],
    savings_note: 'Save ~25% vs renting each item separately (~£150+ individual vs ~£110 bundle). NOTE: Does NOT include CF Express cards or suction cups.',
  },
  {
    bundle_name: 'Sony FX3 Full Production Kit + V-Mount 95mAh',
    items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal', 'Rode Wireless Mic Pro set', 'Atomos Ninja V', 'ND filter', 'V-mount 95mAh'],
    daily_price_min: 108, daily_price_max: 130,
    use_cases: ['film production', 'documentary', 'commercial', 'short film', 'music video'],
    trigger_keywords: ['production kit v-mount', 'full kit v-mount', 'production kit battery', 'v-mount production'],
    savings_note: 'Save ~27% vs renting production kit + V-mount separately. Better value than adding V-mount as standalone.',
  },
  {
    bundle_name: 'Sony FX3 Full Production Kit + V-Mount 150mAh',
    items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal', 'Rode Wireless Mic Pro set', 'Atomos Ninja V', 'ND filter', 'V-mount 150mAh'],
    daily_price_min: 115, daily_price_max: 140,
    use_cases: ['film production', 'documentary', 'commercial', 'short film', 'music video', 'long shoot'],
    trigger_keywords: ['production kit v-mount 150', 'full kit big battery', 'production kit large battery'],
    savings_note: 'Save ~28% vs renting production kit + V-mount 150mAh separately. Larger battery for longer shoots.',
  },
  {
    bundle_name: '2x Sony FX3 Set',
    items: ['Sony FX3', 'Sony FX3'],
    daily_price_min: 57, daily_price_max: 75,
    use_cases: ['multi-camera', 'interview', 'event', 'wedding', 'concert'],
    trigger_keywords: ['two cameras', '2 cameras', 'multicam', 'multi-cam', 'two angles', 'a cam b cam'],
    savings_note: 'Save vs renting 2 cameras individually (~£68-80 individual vs ~£57-90 bundle)',
  },

  // ── Blackmagic Bundles ──
  {
    bundle_name: 'BMPCC 6K Pro Cinema Kit',
    items: ['BMPCC 6K Pro', 'Canon EF 24-105mm f4', 'DJI RS3 Pro gimbal', 'Atomos Ninja V'],
    daily_price_min: 79, daily_price_max: 120,
    use_cases: ['cinema', 'film', 'narrative', 'short film', 'music video', 'commercial'],
    trigger_keywords: ['blackmagic', 'bmpcc', 'cinema camera', 'raw', 'prores', 'cinematic', 'film look'],
    savings_note: 'Save vs individual (~£88-115 individual vs ~£79-140 bundle)',
  },
  {
    bundle_name: 'BMPCC 6K Pro Interview Kit',
    items: ['BMPCC 6K Pro', 'Canon EF 24-105mm f4', 'Nanlite Pavotube 30x II', 'Rode Wireless Mic Pro set'],
    daily_price_min: 57, daily_price_max: 75,
    use_cases: ['interview', 'corporate', 'talking head', 'podcast', 'youtube'],
    trigger_keywords: ['interview', 'talking head', 'corporate video', 'podcast', 'youtube', 'sit down'],
    savings_note: 'Save vs individual (~£82-114 individual vs ~£57-75 bundle)',
  },
  {
    bundle_name: 'BMPCC 6K Pro + Canon Dual Lens Set',
    items: ['BMPCC 6K Pro', 'Canon EF 16-35mm f2.8', 'Canon EF 24-105mm f4'],
    daily_price_min: 50, daily_price_max: 80,
    use_cases: ['cinema', 'film', 'narrative', 'short film', 'commercial'],
    trigger_keywords: ['bmpcc lens set', 'blackmagic canon', 'bmpcc two lenses', 'bmpcc wide and zoom'],
    savings_note: 'Save vs individual (~£63-85 individual vs ~£50-80 bundle). Wide + zoom Canon EF glass.',
  },
  {
    bundle_name: 'BMPCC 6K Full Frame + Canon 24-105mm Kit',
    items: ['BMPCC 6K Full Frame', 'Canon EF 24-105mm f4'],
    daily_price_min: 45, daily_price_max: 65,
    use_cases: ['cinema', 'film', 'narrative', 'commercial'],
    trigger_keywords: ['bmpcc full frame lens', 'bmpcc 6k ff kit', 'blackmagic full frame canon'],
    savings_note: 'Save vs renting separately. Full frame cinema body + versatile Canon zoom.',
  },
  {
    bundle_name: 'BMPCC 6K Full Frame + Canon 24-105mm + Gimbal Kit',
    items: ['BMPCC 6K Full Frame', 'Canon EF 24-105mm f4', 'DJI RS3 Pro gimbal'],
    daily_price_min: 55, daily_price_max: 80,
    use_cases: ['cinema', 'film', 'run-and-gun', 'documentary', 'commercial'],
    trigger_keywords: ['bmpcc full frame gimbal', 'blackmagic full frame stabilized'],
    savings_note: 'Save vs renting separately. Stabilized full frame cinema rig.',
  },
  {
    bundle_name: 'BMPCC Explorer Set (6K Pro + Full Frame + Canon 16-35mm)',
    items: ['BMPCC 6K Pro', 'BMPCC 6K Full Frame', 'Canon EF 16-35mm f2.8', 'DJI RS3 Pro gimbal'],
    daily_price_min: 80, daily_price_max: 120,
    use_cases: ['cinema', 'film production', 'short film', 'narrative'],
    trigger_keywords: ['bmpcc explorer', 'two blackmagic', 'bmpcc dual', 'blackmagic set'],
    savings_note: 'Save vs renting separately. Two cinema bodies (S35 + FF) with wide Canon glass + gimbal.',
  },
  {
    bundle_name: 'BMPCC 6K Pro Ultimate Short Film Set',
    items: ['BMPCC 6K Pro', 'Canon EF 24-105mm f4', 'DJI RS3 Pro gimbal', 'Atomos Ninja V', 'Rode Wireless Mic Pro set'],
    daily_price_min: 100, daily_price_max: 140,
    use_cases: ['short film', 'cinema', 'narrative', 'music video', 'commercial'],
    trigger_keywords: ['bmpcc ultimate', 'blackmagic full kit', 'bmpcc short film'],
    savings_note: 'Save vs renting separately. Complete Blackmagic cinema production kit.',
  },

  // ── Lens Bundles ──
  {
    bundle_name: 'Sony GM Triple Lens Set (16-35 + 24-70 + 70-200)',
    items: ['Sony GM 16-35mm f2.8', 'Sony GM 24-70mm f2.8', 'Sony GM 70-200mm f2.8'],
    daily_price_min: 35, daily_price_max: 55,
    use_cases: ['event', 'wedding', 'documentary', 'versatile', 'travel'],
    trigger_keywords: ['lens set', 'all lenses', 'wide to tele', 'multiple lenses', 'gm set', 'three lenses', 'full range'],
    savings_note: 'Save ~25% vs renting 3 lenses separately (~£44-62 individual vs ~£35-55 bundle)',
  },

  // ── Anamorphic Bundles ──
  {
    bundle_name: 'Great Joy Anamorphic Set (35+50+85mm)',
    items: ['Anamorphic Great Joy lens 35mm', 'Anamorphic Great Joy lens 50mm', 'Anamorphic Great Joy lens 85mm'],
    daily_price_min: 50, daily_price_max: 90,
    use_cases: ['anamorphic', 'cinematic', 'film', 'music video', 'widescreen'],
    trigger_keywords: ['anamorphic', 'great joy', 'widescreen', 'cinemascope', 'film look', 'oval bokeh'],
    savings_note: 'Save vs renting 3 primes separately (~£60-99 individual vs ~£50-99 bundle)',
  },
  {
    bundle_name: 'Blazar Remus 4-Lens Anamorphic Set (33+45+65+100)',
    items: ['Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm', 'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm'],
    daily_price_min: 80, daily_price_max: 110,
    use_cases: ['anamorphic', 'cinematic', 'film', 'music video', 'narrative'],
    trigger_keywords: ['blazar', 'remus', 'anamorphic set', '4 lens', 'full anamorphic'],
    savings_note: 'Save vs renting 4 primes separately (~£104-120 individual vs ~£80-120 bundle)',
  },

  // ── DJ & Party ──
  {
    bundle_name: 'JBL Speakers + Pioneer DJ RX3 Set',
    items: ['JBL Club 120 speaker', 'JBL Club 120 speaker', 'DJ RX3 Pioneer controller'],
    daily_price_min: 79, daily_price_max: 100,
    use_cases: ['dj', 'party', 'event', 'wedding', 'club'],
    trigger_keywords: ['dj', 'speakers', 'party', 'music', 'sound system', 'club', 'dance', 'wedding music'],
    savings_note: 'Save vs renting separately (~£118-153 individual vs ~£79-100 bundle)',
    delivery_note: 'DELIVERY MANDATORY for this bundle',
  },

  // ── Lighting Bundles ──
  {
    bundle_name: 'Interview Lighting Kit (2x LED + Softbox)',
    items: ['LED light panels RGB', 'LED light panels RGB', 'Softbox 85cm'],
    daily_price_min: 25, daily_price_max: 40,
    use_cases: ['interview', 'portrait', 'corporate', 'youtube', 'product'],
    trigger_keywords: ['interview light', 'lighting setup', 'key light', 'studio light', 'portrait lighting'],
    savings_note: 'Save vs renting 3 items individually (~£35-58 individual vs ~£25-40 bundle)',
  },
  {
    bundle_name: 'Full Lighting Kit (Forza + 2x Pavotube + C-stand)',
    items: ['Nanlite Forza 300', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'C-stand'],
    daily_price_min: 50, daily_price_max: 70,
    use_cases: ['film', 'commercial', 'music video', 'studio', 'professional lighting'],
    trigger_keywords: ['full lighting', 'professional lights', 'nanlite', 'studio setup', 'big lights', 'powerful light'],
    savings_note: 'Save vs renting separately (~£49-74 individual vs ~£50-70 bundle). Pavotubes are only available in sets of 2 or 4, never individually.',
  },
  {
    bundle_name: '2x Nanlite Pavotube 30x II Set',
    items: ['Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II'],
    daily_price_min: 20, daily_price_max: 30,
    use_cases: ['accent lighting', 'rgb', 'music video', 'creative', 'background'],
    trigger_keywords: ['pavotube', 'tube lights', 'rgb tubes', 'neon', 'accent light', 'pavotube 30', 'nanlite tube', 'tube light'],
    savings_note: 'MINIMUM order: 2x set. Save vs renting 2 individually (~£24-36 individual vs ~£20-30 bundle). Pavotubes are only available in sets of 2 or 4, never individually.',
  },
  {
    bundle_name: '4x Nanlite Pavotube 30x II Set',
    items: ['Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II'],
    daily_price_min: 35, daily_price_max: 50,
    use_cases: ['rgb', 'music video', 'creative', 'studio', 'event', 'stage'],
    trigger_keywords: ['4 tubes', 'lots of tubes', 'full tube set', 'stage lighting', '4 pavotube', '4x pavotube'],
    savings_note: 'Save vs renting 4 individually (~£48-72 individual vs ~£35-50 bundle). Pavotubes are only available in sets of 2 or 4, never individually.',
  },

  // ── Action Camera Bundles ──
  {
    bundle_name: '3x GoPro Hero 12 Set',
    items: ['GoPro 12 Hero', 'GoPro 12 Hero', 'GoPro 12 Hero'],
    daily_price_min: 30, daily_price_max: 40,
    use_cases: ['multi-angle', 'action', 'sport', 'event', 'pov'],
    trigger_keywords: ['gopro set', 'multiple gopro', 'action cameras', 'pov cameras', 'multi angle action'],
    savings_note: 'Save vs renting 3 individually (~£48-54 individual vs ~£30-40 bundle)',
  },
  {
    bundle_name: 'Action Cam Duo (GoPro + DJI Osmo)',
    items: ['GoPro 12 Hero', 'DJI Osmo Action Pro 5'],
    daily_price_min: 32, daily_price_max: 44,
    use_cases: ['action', 'sport', 'bts', 'multi-angle', 'vlog'],
    trigger_keywords: ['action cam', 'gopro and osmo', 'osmo', 'dji action', 'bts camera', 'behind the scenes'],
    savings_note: 'Save vs renting separately (~£44-51 individual vs ~£32-44 bundle)',
  },
  {
    bundle_name: 'Car Mount Kit (3x Suction Cups + GoPro)',
    items: ['Suction cups', 'Suction cups', 'Suction cups', 'GoPro 12 Hero'],
    daily_price_min: 18, daily_price_max: 38,
    use_cases: ['car', 'vehicle', 'driving', 'automotive', 'chase'],
    trigger_keywords: ['car mount', 'suction', 'vehicle shoot', 'car rig', 'driving footage', 'automotive'],
    savings_note: 'Save vs renting separately (~£48 individual vs ~£18-38 bundle)',
  },

  // ── Drone Bundles ──
  {
    bundle_name: 'Dual Drone Kit (Mavic 3 Pro + Mini 4 Pro)',
    items: ['DJI Mavic 3 Pro', 'DJI Mini 4 Pro'],
    daily_price_min: 40, daily_price_max: 55,
    use_cases: ['aerial', 'real estate', 'event', 'travel', 'documentary'],
    trigger_keywords: ['drone', 'aerial', 'mavic', 'dji drone', 'fly', 'overhead', 'bird eye'],
    savings_note: 'Save vs renting separately (~£55-59 individual vs ~£40-55 bundle). Mavic for cinematic, Mini for tight spaces (sub-250g).',
  },
  {
    bundle_name: 'Aerial + Ground Kit (Mavic 3 + FX3 + 16-35mm)',
    items: ['DJI Mavic 3 Pro', 'Sony FX3', 'Sony GM 16-35mm f2.8'],
    daily_price_min: 65, daily_price_max: 85,
    use_cases: ['real estate', 'travel', 'documentary', 'property', 'commercial'],
    trigger_keywords: ['aerial and ground', 'real estate', 'property video', 'drone and camera', 'estate agent'],
    savings_note: 'Save vs renting separately (~£77-97 individual vs ~£65-85 bundle). Wide lens for interiors, drone for exteriors.',
  },

  // ── Audio Bundles ──
  {
    bundle_name: 'Full Audio Kit (Rode Wireless + Boom + VideoMic Pro)',
    items: ['Rode Wireless Mic Pro set', 'Audio boom mic Sennheiser', 'Rode Video Mic Pro Plus'],
    daily_price_min: 35, daily_price_max: 50,
    use_cases: ['documentary', 'interview', 'film', 'narrative', 'corporate'],
    trigger_keywords: ['audio kit', 'sound kit', 'full audio', 'microphone set', 'boom and wireless', 'professional audio'],
    savings_note: 'Save vs renting separately (~£42-65 individual vs ~£35-50 bundle). Wireless for on-camera talent, boom for off-camera dialogue, VideoMic for ambient.',
  },
  {
    bundle_name: 'Interview Audio Kit (Rode Wireless + Boom)',
    items: ['Rode Wireless Mic Pro set', 'Audio boom mic Sennheiser'],
    daily_price_min: 30, daily_price_max: 42,
    use_cases: ['interview', 'documentary', 'corporate', 'podcast'],
    trigger_keywords: ['interview mic', 'interview audio', 'boom mic', 'wireless and boom', 'documentary audio'],
    savings_note: 'Save vs renting separately (~£34-53 individual vs ~£30-42 bundle). Wireless for talent, boom for room tone.',
  },
  {
    bundle_name: 'Dual Wireless Mic Kit (2x Rode)',
    items: ['Rode Wireless Mic Pro set', 'Rode Wireless Mic Pro set'],
    daily_price_min: 25, daily_price_max: 40,
    use_cases: ['interview', 'podcast', 'two-person', 'dialogue', 'corporate'],
    trigger_keywords: ['two mics', '2 wireless', 'dual mic', 'two people', 'dialogue', '2 person interview'],
    savings_note: 'Save vs renting 2 separately (~£34-52 individual vs ~£25-40 bundle). One per talent for 2-person setups.',
  },

  // ── Smoke / Atmosphere Bundles ──
  {
    bundle_name: 'Smoke Duo (Ninja + Ninja Pro)',
    items: ['Smoke Ninja', 'Smoke Ninja Pro hazer'],
    daily_price_min: 30, daily_price_max: 45,
    use_cases: ['music video', 'film', 'atmosphere', 'creative', 'portrait'],
    trigger_keywords: ['smoke', 'haze', 'fog', 'atmosphere', 'hazer', 'smoky', 'misty'],
    savings_note: 'Save vs renting separately (~£40-57 individual vs ~£30-45 bundle). Compact + Pro for layered haze.',
  },
  {
    bundle_name: 'Music Video Atmosphere Kit (Smoke Ninja Pro + 2x Pavotube)',
    items: ['Smoke Ninja Pro hazer', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II'],
    daily_price_min: 40, daily_price_max: 60,
    use_cases: ['music video', 'creative', 'fashion', 'portrait', 'mood'],
    trigger_keywords: ['music video atmosphere', 'smoke and lights', 'haze and tubes', 'mood lighting', 'creative atmosphere'],
    savings_note: 'Save vs renting separately (~£49-71 individual vs ~£40-60 bundle). Haze catches RGB tube light beautifully.',
  },

  // ── Monitoring Bundles ──
  {
    bundle_name: 'Wireless Monitor Kit (Hollyland 7" + Mars 4K)',
    items: ['Hollyland 7-inch monitor', 'Hollyland Mars 4K transmitter'],
    daily_price_min: 25, daily_price_max: 38,
    use_cases: ['director', 'client monitoring', 'wireless', 'on-set'],
    trigger_keywords: ['wireless monitor', 'director monitor', 'client monitor', 'video village', 'wireless feed', 'remote monitor'],
    savings_note: 'Save vs renting separately (~£28-45 individual vs ~£25-38 bundle). Wireless video feed to director/client.',
  },

  // ── Wedding / Event Bundles ──
  {
    bundle_name: 'Wedding Dual Camera Kit',
    items: ['Sony FX3', 'Sony FX3', 'Sony GM 24-70mm f2.8', 'Sony GM 70-200mm f2.8'],
    daily_price_min: 75, daily_price_max: 100,
    use_cases: ['wedding', 'event', 'ceremony', 'reception'],
    trigger_keywords: ['wedding', 'ceremony', 'reception', 'bride', 'groom', 'two camera event'],
    savings_note: 'Save vs renting separately (~£122-162 individual vs ~£75-100 bundle). Wide + tele zoom covers all ceremony angles.',
  },

  // ── Documentary / Corporate ──
  {
    bundle_name: 'Documentary Filmmaker Kit',
    items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'Rode Wireless Mic Pro set', 'Audio boom mic Sennheiser'],
    daily_price_min: 60, daily_price_max: 85,
    use_cases: ['documentary', 'corporate', 'short doc', 'journalistic'],
    trigger_keywords: ['documentary', 'doc', 'corporate video', 'journalistic', 'news style'],
    savings_note: 'Save vs renting separately (~£81-113 individual vs ~£60-85 bundle). Camera + versatile lens + dual audio coverage.',
  },
];

// ──────────────────────────────────────────
// Suggestion helpers
// ──────────────────────────────────────────

/** Suggest bundles based on keywords in the renter's message */
export function suggestBundles(messageText: string): BundleDefinition[] {
  const lower = messageText.toLowerCase();
  return BUNDLE_DEFINITIONS.filter((b) =>
    b.trigger_keywords.some((kw) => lower.includes(kw)) ||
    b.use_cases.some((uc) => lower.includes(uc)),
  );
}

/** Suggest bundles when renter is ordering 2+ items from a bundle */
export function suggestBundlesForItems(itemNames: string[]): BundleDefinition[] {
  const lowerItems = itemNames.map((n) => n.toLowerCase());
  return BUNDLE_DEFINITIONS.filter((b) => {
    const matchCount = b.items.filter((bi) =>
      lowerItems.some((li) => li.includes(bi.toLowerCase()) || bi.toLowerCase().includes(li)),
    ).length;
    return matchCount >= 2 && matchCount < b.items.length;
  });
}

/** Format bundle suggestions as AI context */
export function formatBundleSuggestionsForAI(messageText: string, mentionedItems: string[]): string {
  const keywordBundles = suggestBundles(messageText);
  const itemBundles = suggestBundlesForItems(mentionedItems);

  const allBundles = new Map<string, BundleDefinition>();
  for (const b of [...keywordBundles, ...itemBundles]) {
    allBundles.set(b.bundle_name, b);
  }

  if (allBundles.size === 0) return '';

  const lines = Array.from(allBundles.values()).map((b) =>
    `BUNDLE: ${b.bundle_name} -- £${b.daily_price_min}-${b.daily_price_max}/day\n` +
    `  Items: ${b.items.join(' + ')}\n` +
    `  Good for: ${b.use_cases.join(', ')}\n` +
    `  ${b.savings_note}` +
    (b.delivery_note ? `\n  ${b.delivery_note}` : ''),
  );

  return `=== RELEVANT BUNDLE SUGGESTIONS ===\nSuggest these if they match what the renter needs. Frame as helpful, not pushy.\n\n${lines.join('\n\n')}`;
}
