/**
 * MARKETING LISTING REDIRECTS
 *
 * Maps marketing-only listing items (items we advertise but don't physically stock)
 * to the best real alternative we actually own.
 *
 * Used to skip all compatibility/availability analysis for fake items and
 * immediately pivot the AI to selling the real gear.
 *
 * Keep in sync with:
 * - PRICING_CATALOG marketing_only items (pricing-catalog.ts)
 * - VISIBILITY_REDIRECTS in calendar.service.ts (which uses a subset of these)
 */

export interface MarketingRedirect {
  /** The item in the listing title (what we advertise but don't own) */
  marketingItem: string;
  /** The real item we actually have in inventory */
  realAlternative: string;
  /** Why the real alternative is comparable / selling point */
  sellingPoint: string;
  /** Category helps group similar items */
  category: 'camera' | 'lens' | 'lighting' | 'audio' | 'gimbal' | 'drone' | 'other';
}

export const MARKETING_REDIRECTS: MarketingRedirect[] = [
  // ── Cameras ──
  { marketingItem: 'Sony A7S III',     realAlternative: 'Sony A7 V',           sellingPoint: 'newer body, same full-frame sensor class, shoots 4K 60fps', category: 'camera' },
  { marketingItem: 'Sony FX6',         realAlternative: 'Sony FX3',             sellingPoint: 'same Sony full-frame sensor, cinema-grade, 4K 120fps', category: 'camera' },
  { marketingItem: 'Canon R5',         realAlternative: 'Sony A7 V',            sellingPoint: 'full-frame mirrorless with similar resolution and video specs', category: 'camera' },
  { marketingItem: 'Canon C70',        realAlternative: 'Sony FX3',             sellingPoint: 'cinema camera with similar run-and-gun capability and form factor', category: 'camera' },
  { marketingItem: 'RED Komodo',       realAlternative: 'BMPCC 6K Pro',         sellingPoint: 'similar cinema-grade RAW output in a compact form factor', category: 'camera' },
  { marketingItem: 'DJI Ronin 4D',     realAlternative: 'Sony FX3',             sellingPoint: 'full-frame cinema camera with DJI RS3 Pro gimbal available separately', category: 'camera' },
  { marketingItem: 'Sony A1',          realAlternative: 'Sony A7 V',            sellingPoint: 'excellent full-frame Sony body, same E-mount lenses', category: 'camera' },
  { marketingItem: 'Panasonic S5 II',  realAlternative: 'Sony A7 V',            sellingPoint: 'full-frame hybrid mirrorless with great autofocus and video', category: 'camera' },
  { marketingItem: 'Blackmagic Pyxis', realAlternative: 'BMPCC 6K Pro',         sellingPoint: 'same Blackmagic cinema sensor, RAW recording, proven form factor', category: 'camera' },
  // ── Lenses ──
  { marketingItem: 'Sigma 24-70mm f2.8 Art',    realAlternative: 'Sony GM 24-70mm f2.8', sellingPoint: 'Sony native glass with identical focal range, autofocus, and f2.8 aperture', category: 'lens' },
  { marketingItem: 'Sony FE 135mm f1.8 GM',     realAlternative: 'Sony GM 90mm f2.8',   sellingPoint: 'Sony GM portrait/macro prime, excellent bokeh and sharpness', category: 'lens' },
  { marketingItem: 'Sony FE 50mm f1.2 GM',      realAlternative: 'Sony GM 24-70mm f2.8', sellingPoint: 'versatile f2.8 zoom covers 50mm and much more, great bokeh', category: 'lens' },
  { marketingItem: 'Sony FE 14mm f1.8 GM',      realAlternative: 'Sony GM 16-35mm f2.8', sellingPoint: 'wide zoom covers ultra-wide range, f2.8 and sharper across the frame', category: 'lens' },
  { marketingItem: 'DZO Vespid',                realAlternative: 'Anamorphic Blazar Remus lens set', sellingPoint: 'cinema prime set with anamorphic character, full focal range coverage', category: 'lens' },
  { marketingItem: 'DZO Film Vespid',           realAlternative: 'Anamorphic Blazar Remus lens set', sellingPoint: 'cinema prime set with anamorphic character, full focal range coverage', category: 'lens' },
  { marketingItem: 'Zeiss Prime',               realAlternative: 'Anamorphic Blazar Remus lens set', sellingPoint: 'cinema prime set with cinematic character', category: 'lens' },
  { marketingItem: 'Canon RF 24-70mm',          realAlternative: 'Canon EF 24-105mm f4', sellingPoint: 'Canon EF mount, same versatile focal range — fits all our BMPCC cameras', category: 'lens' },
  { marketingItem: 'Sony GM 12-24mm',           realAlternative: 'Sony GM 16-35mm f2.8', sellingPoint: 'ultra-wide Sony GM glass with exceptional sharpness', category: 'lens' },
  { marketingItem: 'Sony GM 35mm f1.4',         realAlternative: 'Sony GM 24-70mm f2.8', sellingPoint: 'versatile GM zoom covers 35mm, plus wide and portrait range', category: 'lens' },
  { marketingItem: 'Sigma 14-24mm',             realAlternative: 'Sony GM 16-35mm f2.8', sellingPoint: 'Sony GM ultra-wide, f2.8, same focal coverage', category: 'lens' },
  // ── Lighting ──
  { marketingItem: 'Aputure 600d Pro',  realAlternative: 'Nanlite Forza 300',  sellingPoint: 'powerful daylight COB LED, similar output and controls, great for outdoor/large spaces', category: 'lighting' },
  { marketingItem: 'Aputure 300D',      realAlternative: 'Nanlite Forza 300',  sellingPoint: 'same daylight COB LED class, equivalent output and beam quality', category: 'lighting' },
  { marketingItem: 'Aputure 300D II',   realAlternative: 'Nanlite Forza 300',  sellingPoint: 'same daylight COB LED class, equivalent output and beam quality', category: 'lighting' },
  { marketingItem: 'Aputure 300x',      realAlternative: 'Nanlite 500B',       sellingPoint: 'bi-color COB LED with similar power and tunable colour temperature', category: 'lighting' },
  { marketingItem: 'Aputure Amaran 300c', realAlternative: 'Nanlite 500B',     sellingPoint: 'bi-color bi-color LED, same pro use case', category: 'lighting' },
  { marketingItem: 'Aputure MC Pro',    realAlternative: 'Ambitful RGB light tubes 2x set', sellingPoint: 'compact RGB light tubes — great for accent and creative lighting', category: 'lighting' },
  { marketingItem: 'Aputure Light Dome', realAlternative: 'Softbox 85cm',      sellingPoint: 'large 85cm softbox for the same soft, flattering wrap of light', category: 'lighting' },
  { marketingItem: 'Nanlite Forza 60C', realAlternative: 'Nanlite Forza 300',  sellingPoint: 'same Nanlite daylight COB family, higher power output for more reach', category: 'lighting' },
  // ── Audio ──
  { marketingItem: 'Sennheiser EW 500 Wireless', realAlternative: 'Rode Wireless Mic Pro set', sellingPoint: 'professional wireless lavalier system with transmitter and receiver', category: 'audio' },
  { marketingItem: 'Rode NTG5',                  realAlternative: 'Audio boom mic Sennheiser', sellingPoint: 'pro shotgun boom mic for clean on-camera or boom-pole audio', category: 'audio' },
  { marketingItem: 'Rode Wireless Go II',         realAlternative: 'Rode Wireless Mic Pro set', sellingPoint: 'full Rode wireless lav system with transmitter, receiver, and lavalier mics', category: 'audio' },
  // ── Gimbals / Stabilizers ──
  { marketingItem: 'DJI RS4 Pro',          realAlternative: 'DJI RS3 Pro gimbal', sellingPoint: 'same DJI RS family gimbal — same build quality and compatibility with our cameras', category: 'gimbal' },
  { marketingItem: 'Tilta Float',          realAlternative: 'DJI RS3 Pro gimbal', sellingPoint: 'motorized gimbal stabilizer, compatible with all our camera bodies', category: 'gimbal' },
  { marketingItem: 'Tilta Float Gimbal',   realAlternative: 'DJI RS3 Pro gimbal', sellingPoint: 'motorized gimbal stabilizer, compatible with all our camera bodies', category: 'gimbal' },
  // ── Drones ──
  { marketingItem: 'DJI Air 3',     realAlternative: 'DJI Mavic 3 Pro',  sellingPoint: 'triple-camera Mavic 3 Pro with Hasselblad lens — superior image quality', category: 'drone' },
  { marketingItem: 'DJI Inspire 3', realAlternative: 'DJI Mavic 3 Pro',  sellingPoint: 'our professional drone option for aerial shoots', category: 'drone' },
  // ── Misc redirects (visibility listings with specific known redirects) ──
  { marketingItem: 'Pioneer XDJ-RX2',  realAlternative: 'DJ RX3 Pioneer controller', sellingPoint: 'newer RX3 model — same 2-deck layout, improved screen and performance', category: 'other' },
  { marketingItem: 'DJI Mavic 4 Pro',  realAlternative: 'DJI Mavic 3 Pro',           sellingPoint: 'same DJI Mavic series with Hasselblad camera and three focal lengths', category: 'drone' },
  { marketingItem: '7Artisans 7.5mm',  realAlternative: 'Sony 11mm f2.8 fisheye',     sellingPoint: 'Sony native fisheye — no adapter needed, autofocus, great image quality', category: 'lens' },
  { marketingItem: 'Canon 8-15mm Fisheye', realAlternative: 'Sony 11mm f2.8 fisheye', sellingPoint: 'Sony native fisheye for our E-mount cameras', category: 'lens' },
  { marketingItem: 'SmallHD Cine 7',   realAlternative: 'Atomos Ninja V',             sellingPoint: 'Atomos Ninja V records ProRes externally AND acts as a touchscreen monitor', category: 'other' },
];

/**
 * Check a listing title for marketing-only items.
 * Returns the best match found, or null if this is a real inventory listing.
 *
 * Checks both the full title and common aliases/abbreviations.
 */
export function detectMarketingListing(listingTitle: string): MarketingRedirect | null {
  if (!listingTitle) return null;
  const lower = listingTitle.toLowerCase();

  for (const redirect of MARKETING_REDIRECTS) {
    const itemLower = redirect.marketingItem.toLowerCase();
    if (lower.includes(itemLower)) {
      return redirect;
    }
  }

  // Additional pattern aliases (abbreviations in SEO titles)
  const aliases: Array<[RegExp, string]> = [
    [/\ba7s\s*(iii|3)\b/i, 'Sony A7S III'],
    [/\bfx[\s-]?6\b/i, 'Sony FX6'],
    [/\bkomodo\b/i, 'RED Komodo'],
    [/\bpyxis\s*6k?\b/i, 'Blackmagic Pyxis'],
    [/\bvespid\b/i, 'DZO Vespid'],
    [/\brs[\s-]?4\s*pro\b/i, 'DJI RS4 Pro'],
    [/\baputure\b/i, 'Aputure 300D'],
    [/\bzeiss\s*prime\b/i, 'Zeiss Prime'],
    [/\bd?zo\s*film\b/i, 'DZO Film Vespid'],
    [/\bcanon\s*r5\b/i, 'Canon R5'],
    [/\bcanon\s*c70\b/i, 'Canon C70'],
  ];

  for (const [pattern, itemName] of aliases) {
    if (pattern.test(listingTitle)) {
      return MARKETING_REDIRECTS.find(r => r.marketingItem === itemName) || null;
    }
  }

  return null;
}

/**
 * Build a focused conversion context string for a marketing listing.
 * Injected into AI prompts to skip analysis of the fake item and sell the real one.
 */
export function buildMarketingListingContext(redirect: MarketingRedirect, listingTitle: string): string {
  return `\n\n🎯 MARKETING LISTING — CONVERSION FOCUS:
This renter came through a listing for "${redirect.marketingItem}" which we do NOT physically stock.
Real alternative: "${redirect.realAlternative}" — ${redirect.sellingPoint}

YOUR ONLY GOAL: Convert this renter to "${redirect.realAlternative}".
- Do NOT waste any words explaining the marketing item is unavailable or analyzing it
- Do NOT do compatibility checks or availability reasoning for "${redirect.marketingItem}"
- Open with: we have the ${redirect.realAlternative}, here's exactly why it's great for their specific needs
- Lead with the real item name immediately — be enthusiastic, specific, and concrete
- Suggest the full kit (body + relevant lens + gimbal if applicable) at realistic prices
- The listing title may include other real items — check and confirm those separately`;
}
