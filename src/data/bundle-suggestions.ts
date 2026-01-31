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
    daily_price_min: 41, daily_price_max: 60,
    use_cases: ['film', 'video', 'run-and-gun', 'wedding', 'event'],
    trigger_keywords: ['fx3', 'sony', 'camera and lens', 'video camera', 'cinema camera', 'filming'],
    savings_note: 'Save vs renting camera + lens separately (~£54-60 individual vs ~£50 bundle)',
  },
  {
    bundle_name: 'Sony FX3 + 24-70mm GM + RS Gimbal Kit',
    items: ['Sony FX3', 'Sony GM 24-70mm f2.8', 'DJI RS3 Pro gimbal'],
    daily_price_min: 40, daily_price_max: 70,
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
    savings_note: 'Save ~25% vs renting each item separately (~£150+ individual vs ~£110 bundle)',
  },
  {
    bundle_name: '2x Sony FX3 Set',
    items: ['Sony FX3', 'Sony FX3'],
    daily_price_min: 57, daily_price_max: 90,
    use_cases: ['multi-camera', 'interview', 'event', 'wedding', 'concert'],
    trigger_keywords: ['two cameras', '2 cameras', 'multicam', 'multi-cam', 'two angles', 'a cam b cam'],
    savings_note: 'Save vs renting 2 cameras individually (~£68-80 individual vs ~£57-90 bundle)',
  },

  // ── Blackmagic Bundles ──
  {
    bundle_name: 'BMPCC 6K Pro Cinema Kit',
    items: ['BMPCC 6K Pro', 'Canon EF 24-105mm f4', 'DJI RS3 Pro gimbal', 'Atomos Ninja V'],
    daily_price_min: 79, daily_price_max: 140,
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

  // ── Lens Bundles ──
  {
    bundle_name: 'Sony GM Triple Lens Set',
    items: ['Sony GM 16-35mm f2.8', 'Sony GM 24-70mm f2.8', 'Sony GM 70-200mm f2.8'],
    daily_price_min: 35, daily_price_max: 55,
    use_cases: ['event', 'wedding', 'documentary', 'versatile', 'travel'],
    trigger_keywords: ['lens set', 'all lenses', 'wide to tele', 'multiple lenses', 'gm set', 'three lenses', 'full range'],
    savings_note: 'Save ~25% vs renting 3 lenses separately (~£44-62 individual vs ~£35-55 bundle)',
  },

  // ── Anamorphic Bundles ──
  {
    bundle_name: 'Great Joy Anamorphic Set (35+50+85mm)',
    items: ['Anamorphic Great Joy 35mm', 'Anamorphic Great Joy 50mm', 'Anamorphic Great Joy 85mm'],
    daily_price_min: 50, daily_price_max: 99,
    use_cases: ['anamorphic', 'cinematic', 'film', 'music video', 'widescreen'],
    trigger_keywords: ['anamorphic', 'great joy', 'widescreen', 'cinemascope', 'film look', 'oval bokeh'],
    savings_note: 'Save vs renting 3 primes separately (~£60-99 individual vs ~£50-99 bundle)',
  },
  {
    bundle_name: 'Blazar Remus 4-Lens Anamorphic Set',
    items: ['Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm', 'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm'],
    daily_price_min: 80, daily_price_max: 120,
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
    bundle_name: 'Interview Lighting Kit',
    items: ['LED light panels RGB', 'LED light panels RGB', 'Softbox 85cm'],
    daily_price_min: 25, daily_price_max: 40,
    use_cases: ['interview', 'portrait', 'corporate', 'youtube', 'product'],
    trigger_keywords: ['interview light', 'lighting setup', 'key light', 'studio light', 'portrait lighting'],
    savings_note: 'Save vs renting 3 items individually (~£35-58 individual vs ~£25-40 bundle)',
  },
  {
    bundle_name: 'Full Lighting Kit',
    items: ['Nanlite Forza 300', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'C-stand'],
    daily_price_min: 50, daily_price_max: 70,
    use_cases: ['film', 'commercial', 'music video', 'studio', 'professional lighting'],
    trigger_keywords: ['full lighting', 'professional lights', 'nanlite', 'studio setup', 'big lights', 'powerful light'],
    savings_note: 'Save vs renting separately (~£49-74 individual vs ~£50-70 bundle)',
  },
  {
    bundle_name: '2x Nanlite Pavotube 30x II Set',
    items: ['Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II'],
    daily_price_min: 20, daily_price_max: 30,
    use_cases: ['accent lighting', 'rgb', 'music video', 'creative', 'background'],
    trigger_keywords: ['pavotube', 'tube lights', 'rgb tubes', 'neon', 'accent light'],
    savings_note: 'Save vs renting 2 individually (~£24-36 individual vs ~£20-30 bundle)',
  },
  {
    bundle_name: '4x Nanlite Pavotube 30x II Set',
    items: ['Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II', 'Nanlite Pavotube 30x II'],
    daily_price_min: 35, daily_price_max: 50,
    use_cases: ['rgb', 'music video', 'creative', 'studio', 'event', 'stage'],
    trigger_keywords: ['4 tubes', 'lots of tubes', 'full tube set', 'stage lighting'],
    savings_note: 'Save vs renting 4 individually (~£48-72 individual vs ~£35-50 bundle)',
  },

  // ── Action Camera Bundle ──
  {
    bundle_name: '3x GoPro Hero 12 Set',
    items: ['GoPro 12 Hero', 'GoPro 12 Hero', 'GoPro 12 Hero'],
    daily_price_min: 30, daily_price_max: 40,
    use_cases: ['multi-angle', 'action', 'sport', 'event', 'pov'],
    trigger_keywords: ['gopro set', 'multiple gopro', 'action cameras', 'pov cameras', 'multi angle action'],
    savings_note: 'Save vs renting 3 individually (~£48-54 individual vs ~£30-40 bundle)',
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
