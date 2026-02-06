/**
 * DELIVERY ITEM SPECIFICATIONS
 *
 * Packed dimensions, weights, and courier suitability for every item AND bundle.
 * Used to determine courier type (motorcycle / small car / large van)
 * and communicate courier requirements to renters.
 *
 * Rating system:
 * - size_score 1 (XS): Fits in backpack/messenger bag -> Motorcycle OK
 * - size_score 2 (S): Small case, fits in courier bag -> Motorcycle OK
 * - size_score 3 (M): Medium case/bag -> Small car needed
 * - size_score 4 (L): Large/heavy item -> Small car minimum, van if multiple
 * - size_score 5 (XL): Bulky/very heavy -> Van territory
 *
 * is_heavy_large = true when item needs special handling (size_score >= 4 OR weight >= 5kg)
 *
 * Bundle weights = sum of individual item weights.
 * Bundle dimensions = estimated packed size (items packed together or in multiple bags).
 * Bundle size_score = max(individual scores) + adjustment for quantity/total weight.
 */

export interface DeliverySpec {
  item_name: string;
  weight_kg: number;
  packed_length_cm: number;
  packed_width_cm: number;
  packed_height_cm: number;
  size_score: number;
  is_heavy_large: boolean;
  courier_note: string;
  category: string;
}

export const DELIVERY_SPECS: DeliverySpec[] = [
  // ══════════════════════════════════════════════════════════════
  // INDIVIDUAL ITEMS
  // ══════════════════════════════════════════════════════════════

  // ── XS (score 1) - Motorcycle OK ──
  { item_name: 'Rode Wireless Mic Pro set', weight_kg: 0.5, packed_length_cm: 22, packed_width_cm: 18, packed_height_cm: 8, size_score: 1, is_heavy_large: false, courier_note: 'Small case, fits in backpack', category: 'audio' },
  { item_name: 'DJI Wireless Mics', weight_kg: 0.4, packed_length_cm: 20, packed_width_cm: 15, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: 'Small case, fits in backpack', category: 'audio' },
  { item_name: 'DJI Mic 2 wireless', weight_kg: 0.4, packed_length_cm: 20, packed_width_cm: 15, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: 'Small case, fits in backpack', category: 'audio' },
  { item_name: 'JBL wireless microphones', weight_kg: 0.5, packed_length_cm: 20, packed_width_cm: 16, packed_height_cm: 8, size_score: 1, is_heavy_large: false, courier_note: 'Small case, fits in backpack', category: 'audio' },
  { item_name: 'ND filter', weight_kg: 0.1, packed_length_cm: 12, packed_width_cm: 12, packed_height_cm: 4, size_score: 1, is_heavy_large: false, courier_note: 'Filter pouch, tiny', category: 'accessory' },
  { item_name: 'Cinebloom filter mist', weight_kg: 0.1, packed_length_cm: 12, packed_width_cm: 12, packed_height_cm: 4, size_score: 1, is_heavy_large: false, courier_note: 'Filter pouch, tiny', category: 'accessory' },
  { item_name: '256GB card', weight_kg: 0.01, packed_length_cm: 8, packed_width_cm: 6, packed_height_cm: 2, size_score: 1, is_heavy_large: false, courier_note: 'SD card in case, pocket-sized', category: 'accessory' },
  { item_name: 'CF Express Type A card', weight_kg: 0.01, packed_length_cm: 8, packed_width_cm: 6, packed_height_cm: 2, size_score: 1, is_heavy_large: false, courier_note: 'Card in case, pocket-sized', category: 'accessory' },
  { item_name: 'Camera flash', weight_kg: 0.3, packed_length_cm: 15, packed_width_cm: 10, packed_height_cm: 8, size_score: 1, is_heavy_large: false, courier_note: 'Small pouch, fits in backpack', category: 'lighting' },
  { item_name: 'Tilta Nucleus Nano 2 follow focus', weight_kg: 0.3, packed_length_cm: 18, packed_width_cm: 12, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: 'Small case, fits in backpack', category: 'accessory' },
  { item_name: 'Sony NPF 970 batteries 2x sets', weight_kg: 0.4, packed_length_cm: 16, packed_width_cm: 10, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: 'Battery case, fits in pocket', category: 'power' },
  { item_name: '5-in-1 reflector panel', weight_kg: 0.5, packed_length_cm: 35, packed_width_cm: 35, packed_height_cm: 3, size_score: 1, is_heavy_large: false, courier_note: 'Folds flat, fits in bag', category: 'lighting' },
  { item_name: 'PL to Sony E mount', weight_kg: 0.2, packed_length_cm: 12, packed_width_cm: 12, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: 'Small adapter in pouch', category: 'accessory' },
  { item_name: 'PL to EF mount', weight_kg: 0.2, packed_length_cm: 12, packed_width_cm: 12, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: 'Small adapter in pouch', category: 'accessory' },
  { item_name: 'PL to RF mount', weight_kg: 0.2, packed_length_cm: 12, packed_width_cm: 12, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: 'Small adapter in pouch', category: 'accessory' },
  { item_name: 'PL to L mount', weight_kg: 0.2, packed_length_cm: 12, packed_width_cm: 12, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: 'Small adapter in pouch', category: 'accessory' },

  // ── S (score 2) - Motorcycle OK ──
  { item_name: 'Sony FX3', weight_kg: 0.7, packed_length_cm: 25, packed_width_cm: 18, packed_height_cm: 15, size_score: 2, is_heavy_large: false, courier_note: 'Camera body in padded case', category: 'camera' },
  { item_name: 'Sony A7 III', weight_kg: 0.7, packed_length_cm: 25, packed_width_cm: 18, packed_height_cm: 15, size_score: 2, is_heavy_large: false, courier_note: 'Camera body in padded case', category: 'camera' },
  { item_name: 'Sony A7 II', weight_kg: 0.6, packed_length_cm: 24, packed_width_cm: 17, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: 'Camera body in padded case', category: 'camera' },
  { item_name: 'Fujifilm X100 VI', weight_kg: 0.5, packed_length_cm: 20, packed_width_cm: 15, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Compact camera in padded case', category: 'camera' },
  { item_name: 'BMPCC 6K Pro', weight_kg: 0.9, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera body in padded case', category: 'camera' },
  { item_name: 'BMPCC 6K Full Frame', weight_kg: 0.9, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera body in padded case', category: 'camera' },
  { item_name: 'Sony GM 24-70mm f2.8', weight_kg: 0.9, packed_length_cm: 22, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Lens in padded pouch', category: 'lens' },
  { item_name: 'Sony GM 16-35mm f2.8', weight_kg: 0.7, packed_length_cm: 20, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Lens in padded pouch', category: 'lens' },
  { item_name: 'Sony GM 90mm f2.8', weight_kg: 0.6, packed_length_cm: 18, packed_width_cm: 10, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: 'Lens in padded pouch', category: 'lens' },
  { item_name: 'Sony 28-70mm', weight_kg: 0.3, packed_length_cm: 16, packed_width_cm: 10, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: 'Small lens in pouch', category: 'lens' },
  { item_name: 'Canon EF 24-105mm f4', weight_kg: 0.8, packed_length_cm: 22, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Lens in padded pouch', category: 'lens' },
  { item_name: 'Canon EF 16-35mm f2.8', weight_kg: 0.8, packed_length_cm: 20, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Lens in padded pouch', category: 'lens' },
  { item_name: 'Sony 11mm f2.8 fisheye', weight_kg: 0.2, packed_length_cm: 14, packed_width_cm: 10, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: 'Small lens in pouch', category: 'lens' },
  { item_name: 'Anamorphic Blazar Remus 33mm', weight_kg: 0.9, packed_length_cm: 22, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Anamorphic lens in case', category: 'lens' },
  { item_name: 'Anamorphic Blazar Remus 45mm', weight_kg: 0.9, packed_length_cm: 22, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Anamorphic lens in case', category: 'lens' },
  { item_name: 'Anamorphic Blazar Remus 65mm', weight_kg: 0.9, packed_length_cm: 22, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Anamorphic lens in case', category: 'lens' },
  { item_name: 'Anamorphic Blazar Remus 100mm', weight_kg: 1.0, packed_length_cm: 24, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Anamorphic lens in case', category: 'lens' },
  { item_name: 'Anamorphic Great Joy 35mm', weight_kg: 1.0, packed_length_cm: 24, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Anamorphic lens in case', category: 'lens' },
  { item_name: 'Anamorphic Great Joy 50mm', weight_kg: 1.0, packed_length_cm: 24, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Anamorphic lens in case', category: 'lens' },
  { item_name: 'Anamorphic Great Joy 85mm', weight_kg: 1.0, packed_length_cm: 24, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Anamorphic lens in case', category: 'lens' },
  { item_name: 'DJI Mini 4 Pro', weight_kg: 0.3, packed_length_cm: 25, packed_width_cm: 20, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: 'Compact drone in carry case', category: 'drone' },
  { item_name: 'DJI Osmo Action Pro 5', weight_kg: 0.2, packed_length_cm: 15, packed_width_cm: 10, packed_height_cm: 8, size_score: 2, is_heavy_large: false, courier_note: 'Tiny action cam in case', category: 'camera' },
  { item_name: 'GoPro 12 Hero', weight_kg: 0.2, packed_length_cm: 15, packed_width_cm: 10, packed_height_cm: 8, size_score: 2, is_heavy_large: false, courier_note: 'Tiny action cam in case', category: 'camera' },
  { item_name: 'Atomos Ninja V', weight_kg: 0.4, packed_length_cm: 20, packed_width_cm: 15, packed_height_cm: 6, size_score: 2, is_heavy_large: false, courier_note: '5" monitor in padded sleeve', category: 'monitor' },
  { item_name: 'Hollyland 7-inch monitor', weight_kg: 0.5, packed_length_cm: 25, packed_width_cm: 18, packed_height_cm: 6, size_score: 2, is_heavy_large: false, courier_note: '7" monitor in padded sleeve', category: 'monitor' },
  { item_name: 'Hollyland Mars 4K transmitter', weight_kg: 0.3, packed_length_cm: 18, packed_width_cm: 12, packed_height_cm: 6, size_score: 2, is_heavy_large: false, courier_note: 'Small transmitter in case', category: 'video' },
  { item_name: 'Hollyland Pyro S transmitter', weight_kg: 0.3, packed_length_cm: 18, packed_width_cm: 12, packed_height_cm: 6, size_score: 2, is_heavy_large: false, courier_note: 'Small transmitter in case', category: 'video' },
  { item_name: 'Rode Video Mic Go', weight_kg: 0.1, packed_length_cm: 20, packed_width_cm: 6, packed_height_cm: 6, size_score: 2, is_heavy_large: false, courier_note: 'Small on-camera mic', category: 'audio' },
  { item_name: 'Rode Video Mic Pro Plus', weight_kg: 0.2, packed_length_cm: 22, packed_width_cm: 8, packed_height_cm: 8, size_score: 2, is_heavy_large: false, courier_note: 'On-camera mic in case', category: 'audio' },
  { item_name: 'V-mount 95mAh', weight_kg: 0.7, packed_length_cm: 18, packed_width_cm: 10, packed_height_cm: 8, size_score: 2, is_heavy_large: false, courier_note: 'Battery in case', category: 'power' },
  { item_name: 'V-mount 150mAh', weight_kg: 1.0, packed_length_cm: 20, packed_width_cm: 12, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: 'Battery set in case', category: 'power' },
  { item_name: 'DJI gimbal battery', weight_kg: 0.2, packed_length_cm: 14, packed_width_cm: 6, packed_height_cm: 6, size_score: 2, is_heavy_large: false, courier_note: 'Small battery in pouch', category: 'power' },
  { item_name: 'Suction cups', weight_kg: 0.5, packed_length_cm: 20, packed_width_cm: 15, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: 'Suction mount in bag', category: 'accessory' },

  // ── S (score 2) - Motorcycle OK (fits in bike carrier when packed) ──
  { item_name: 'DJI RS3 Pro gimbal', weight_kg: 1.5, packed_length_cm: 27, packed_width_cm: 27, packed_height_cm: 7, size_score: 2, is_heavy_large: false, courier_note: 'Gimbal folds compact, fits bike carrier', category: 'stabilizer' },
  { item_name: 'LED light panels RGB', weight_kg: 1.5, packed_length_cm: 28, packed_width_cm: 24, packed_height_cm: 6, size_score: 2, is_heavy_large: false, courier_note: 'Single LED panel in padded pouch, fits bike carrier', category: 'lighting' },

  // ── M (score 3) - Small Car ──
  { item_name: 'Sony GM 70-200mm f2.8', weight_kg: 1.5, packed_length_cm: 27, packed_width_cm: 12, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Telephoto in padded case, fits bike carrier', category: 'lens' },
  { item_name: 'DJI Mavic 3 Pro', weight_kg: 1.0, packed_length_cm: 33, packed_width_cm: 18, packed_height_cm: 28, size_score: 2, is_heavy_large: false, courier_note: 'Fly More case fits in bike carrier bag', category: 'drone' },
  { item_name: 'Audio boom mic Sennheiser', weight_kg: 0.8, packed_length_cm: 55, packed_width_cm: 10, packed_height_cm: 10, size_score: 3, is_heavy_large: false, courier_note: 'Long boom tube, needs car', category: 'audio' },
  { item_name: 'Softbox 85cm', weight_kg: 1.0, packed_length_cm: 55, packed_width_cm: 15, packed_height_cm: 15, size_score: 3, is_heavy_large: false, courier_note: 'Folded softbox in tube bag', category: 'lighting' },
  { item_name: 'Small rig tripod', weight_kg: 1.5, packed_length_cm: 55, packed_width_cm: 12, packed_height_cm: 12, size_score: 3, is_heavy_large: false, courier_note: 'Tripod in bag, needs car', category: 'support' },
  { item_name: 'Sirui tripod', weight_kg: 2.0, packed_length_cm: 60, packed_width_cm: 14, packed_height_cm: 14, size_score: 3, is_heavy_large: false, courier_note: 'Tripod in bag, needs car', category: 'support' },
  { item_name: 'Motorized slider', weight_kg: 3.0, packed_length_cm: 65, packed_width_cm: 18, packed_height_cm: 15, size_score: 3, is_heavy_large: false, courier_note: 'Slider in padded case, needs car', category: 'motion' },
  { item_name: 'Monopod arm support', weight_kg: 1.0, packed_length_cm: 50, packed_width_cm: 10, packed_height_cm: 10, size_score: 3, is_heavy_large: false, courier_note: 'Monopod in tube, needs car', category: 'support' },
  { item_name: 'Tilta shoulder rig', weight_kg: 1.5, packed_length_cm: 40, packed_width_cm: 25, packed_height_cm: 15, size_score: 3, is_heavy_large: false, courier_note: 'Rig in case, needs car', category: 'support' },
  { item_name: 'Ambitful RGB light tubes 2x set', weight_kg: 1.5, packed_length_cm: 55, packed_width_cm: 15, packed_height_cm: 15, size_score: 2, is_heavy_large: false, courier_note: 'Light tubes fit in bike carrier', category: 'lighting' },

  // ── L (score 4) - Car / Van if multiple - HEAVY/LARGE ──
  { item_name: 'Nanlite Forza 300', weight_kg: 3.5, packed_length_cm: 45, packed_width_cm: 35, packed_height_cm: 25, size_score: 4, is_heavy_large: true, courier_note: 'Heavy light + power unit, requires car boot', category: 'lighting' },
  { item_name: 'Nanlite 500B', weight_kg: 5.0, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 30, size_score: 4, is_heavy_large: true, courier_note: 'Heavy light (5kg), requires car minimum', category: 'lighting' },
  { item_name: 'Nanlite Pavotube 30x II', weight_kg: 1.5, packed_length_cm: 85, packed_width_cm: 10, packed_height_cm: 10, size_score: 4, is_heavy_large: true, courier_note: 'Long tube light (85cm), needs car for length', category: 'lighting' },
  { item_name: 'C-stand', weight_kg: 5.0, packed_length_cm: 100, packed_width_cm: 15, packed_height_cm: 15, size_score: 4, is_heavy_large: true, courier_note: 'Heavy stand (5kg), very long, requires car', category: 'support' },
  { item_name: 'Anker Power Station F2000', weight_kg: 20.0, packed_length_cm: 50, packed_width_cm: 30, packed_height_cm: 30, size_score: 4, is_heavy_large: true, courier_note: 'Very heavy (20kg), requires car minimum', category: 'power' },
  { item_name: 'JBL Club 120 speaker', weight_kg: 12.0, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 35, size_score: 4, is_heavy_large: true, courier_note: 'Heavy speaker (12kg each), requires car/van', category: 'audio' },

  // ── XL (score 5) - Van territory ──
  { item_name: 'DJ RX3 Pioneer controller', weight_kg: 5.5, packed_length_cm: 70, packed_width_cm: 45, packed_height_cm: 20, size_score: 5, is_heavy_large: true, courier_note: 'Large DJ controller in flight case, van if with speakers', category: 'dj' },
  { item_name: 'Smoke machine fogger', weight_kg: 4.0, packed_length_cm: 40, packed_width_cm: 30, packed_height_cm: 25, size_score: 2, is_heavy_large: false, courier_note: 'Fogger fits in bike carrier bag', category: 'effects' },
  { item_name: 'Smoke Ninja Pro hazer', weight_kg: 3.0, packed_length_cm: 35, packed_width_cm: 25, packed_height_cm: 20, size_score: 2, is_heavy_large: false, courier_note: 'Compact hazer fits in bike carrier', category: 'effects' },
  { item_name: 'Smoke Ninja', weight_kg: 1.5, packed_length_cm: 25, packed_width_cm: 15, packed_height_cm: 15, size_score: 2, is_heavy_large: false, courier_note: 'Compact hazer fits easily in bike carrier', category: 'effects' },

  // ══════════════════════════════════════════════════════════════
  // BUNDLE / COMBO DELIVERY SPECS
  // Weight = sum of items. Dimensions = estimated packed together.
  // Score = max item score, raised if total weight/count is high.
  // ══════════════════════════════════════════════════════════════

  // ── Camera multi-quantity bundles ──
  { item_name: '2x Sony FX3 Set', weight_kg: 1.4, packed_length_cm: 30, packed_width_cm: 25, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: '2 cameras in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: '3x Sony FX3 Set', weight_kg: 2.1, packed_length_cm: 35, packed_width_cm: 28, packed_height_cm: 22, size_score: 2, is_heavy_large: false, courier_note: '3 cameras in carry bag, motorcycle OK', category: 'bundle' },
  { item_name: '2x DJI Osmo Action Pro 5 Set', weight_kg: 0.4, packed_length_cm: 20, packed_width_cm: 15, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: '2 action cams, fits in backpack', category: 'bundle' },
  { item_name: '3x DJI Osmo Action Pro 5 Set', weight_kg: 0.6, packed_length_cm: 22, packed_width_cm: 18, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: '3 action cams, fits in backpack', category: 'bundle' },
  { item_name: '2x GoPro Hero 12 Set', weight_kg: 0.4, packed_length_cm: 20, packed_width_cm: 15, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: '2 GoPros in small case', category: 'bundle' },
  { item_name: '3x GoPro Hero 12 Set', weight_kg: 0.6, packed_length_cm: 22, packed_width_cm: 18, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: '3 GoPros in small case', category: 'bundle' },

  // ── Lens multi-quantity bundles ──
  { item_name: '2x Sony GM 24-70mm f2.8 Set', weight_kg: 1.8, packed_length_cm: 28, packed_width_cm: 18, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: '2 lenses in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: '3x Sony GM 24-70mm f2.8 Set', weight_kg: 2.7, packed_length_cm: 32, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: '3 lenses in carry bag, motorcycle OK', category: 'bundle' },
  { item_name: '4x Sony GM 24-70mm f2.8 Set', weight_kg: 3.6, packed_length_cm: 35, packed_width_cm: 25, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: '4 lenses in carry bag, motorcycle OK', category: 'bundle' },
  { item_name: '2x Sony GM 70-200mm f2.8 Set', weight_kg: 3.0, packed_length_cm: 35, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: '2 large telephotos, motorcycle OK', category: 'bundle' },
  { item_name: '2x Sony 28-70mm Set', weight_kg: 0.6, packed_length_cm: 22, packed_width_cm: 14, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: '2 small lenses in bag, motorcycle OK', category: 'bundle' },

  // ── Lighting multi-quantity bundles ──
  { item_name: '2x Nanlite Pavotube 30x II Set', weight_kg: 3.0, packed_length_cm: 90, packed_width_cm: 15, packed_height_cm: 15, size_score: 4, is_heavy_large: true, courier_note: '2 long tube lights (90cm), needs car for length', category: 'bundle' },
  { item_name: '3x Nanlite Pavotube 30x II Set', weight_kg: 4.5, packed_length_cm: 90, packed_width_cm: 20, packed_height_cm: 18, size_score: 4, is_heavy_large: true, courier_note: '3 tube lights (90cm), needs car', category: 'bundle' },
  { item_name: '4x Nanlite Pavotube 30x II Set', weight_kg: 6.0, packed_length_cm: 90, packed_width_cm: 25, packed_height_cm: 20, size_score: 4, is_heavy_large: true, courier_note: '4 tube lights (90cm, 6kg total), car minimum', category: 'bundle' },
  { item_name: '2x LED Light Panels RGB Set', weight_kg: 3.0, packed_length_cm: 40, packed_width_cm: 35, packed_height_cm: 16, size_score: 3, is_heavy_large: false, courier_note: '2 LED panels stacked in bag, needs car', category: 'bundle' },
  { item_name: '3x LED Light Panels RGB Set', weight_kg: 4.5, packed_length_cm: 40, packed_width_cm: 35, packed_height_cm: 24, size_score: 3, is_heavy_large: false, courier_note: '3 LED panels, needs car', category: 'bundle' },
  { item_name: '2x Softbox 85cm Set', weight_kg: 2.0, packed_length_cm: 60, packed_width_cm: 18, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: '2 folded softboxes in tube bag, needs car', category: 'bundle' },
  { item_name: '2x Ambitful RGB Light Tubes Set', weight_kg: 3.0, packed_length_cm: 58, packed_width_cm: 18, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: '4 tubes total in carry tubes, needs car', category: 'bundle' },

  // ── Support multi-quantity bundles ──
  { item_name: '2x Small Rig Tripod Set', weight_kg: 3.0, packed_length_cm: 58, packed_width_cm: 16, packed_height_cm: 16, size_score: 3, is_heavy_large: false, courier_note: '2 tripods in bags, needs car', category: 'bundle' },
  { item_name: '3x Small Rig Tripod Set', weight_kg: 4.5, packed_length_cm: 58, packed_width_cm: 22, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: '3 tripods in bags, needs car', category: 'bundle' },

  // ── Power multi-quantity bundles ──
  { item_name: '2x V-mount 95mAh Set', weight_kg: 1.4, packed_length_cm: 22, packed_width_cm: 14, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: '2 batteries in case, motorcycle OK', category: 'bundle' },
  { item_name: '2x V-mount 150mAh Set', weight_kg: 2.0, packed_length_cm: 24, packed_width_cm: 16, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: '2 batteries in case, motorcycle OK', category: 'bundle' },
  { item_name: '3x V-mount 150mAh Set', weight_kg: 3.0, packed_length_cm: 28, packed_width_cm: 18, packed_height_cm: 14, size_score: 3, is_heavy_large: false, courier_note: '3 batteries in case, needs car', category: 'bundle' },
  { item_name: '4x V-mount 150mAh Set', weight_kg: 4.0, packed_length_cm: 30, packed_width_cm: 20, packed_height_cm: 16, size_score: 3, is_heavy_large: false, courier_note: '4 batteries in case, needs car', category: 'bundle' },
  { item_name: '2x Sony NPF 970 Batteries Set', weight_kg: 0.8, packed_length_cm: 20, packed_width_cm: 14, packed_height_cm: 8, size_score: 1, is_heavy_large: false, courier_note: 'Battery cases, fits in backpack', category: 'bundle' },
  { item_name: '3x Sony NPF 970 Batteries Set', weight_kg: 1.2, packed_length_cm: 22, packed_width_cm: 16, packed_height_cm: 10, size_score: 1, is_heavy_large: false, courier_note: 'Battery cases, fits in backpack', category: 'bundle' },
  { item_name: '4x Sony NPF 970 Batteries Set', weight_kg: 1.6, packed_length_cm: 24, packed_width_cm: 18, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Battery cases, fits in courier bag', category: 'bundle' },
  { item_name: '2x DJI Gimbal Battery Set', weight_kg: 0.4, packed_length_cm: 18, packed_width_cm: 10, packed_height_cm: 8, size_score: 1, is_heavy_large: false, courier_note: 'Small batteries, fits in backpack', category: 'bundle' },
  { item_name: '3x DJI Gimbal Battery Set', weight_kg: 0.6, packed_length_cm: 20, packed_width_cm: 12, packed_height_cm: 8, size_score: 1, is_heavy_large: false, courier_note: 'Small batteries, fits in backpack', category: 'bundle' },

  // ── Accessory multi-quantity bundles ──
  { item_name: '2x ND Filter Set', weight_kg: 0.2, packed_length_cm: 15, packed_width_cm: 14, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: 'Filter pouches, tiny', category: 'bundle' },
  { item_name: '3x ND Filter Set', weight_kg: 0.3, packed_length_cm: 16, packed_width_cm: 14, packed_height_cm: 8, size_score: 1, is_heavy_large: false, courier_note: 'Filter pouches, tiny', category: 'bundle' },
  { item_name: '2x 256GB Memory Card Set', weight_kg: 0.02, packed_length_cm: 10, packed_width_cm: 8, packed_height_cm: 3, size_score: 1, is_heavy_large: false, courier_note: 'Card case, pocket-sized', category: 'bundle' },
  { item_name: '3x 256GB Memory Card Set', weight_kg: 0.03, packed_length_cm: 10, packed_width_cm: 8, packed_height_cm: 4, size_score: 1, is_heavy_large: false, courier_note: 'Card case, pocket-sized', category: 'bundle' },
  { item_name: '2x Suction Cup Mount Set', weight_kg: 1.0, packed_length_cm: 25, packed_width_cm: 18, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: 'Suction mounts in bag, motorcycle OK', category: 'bundle' },
  { item_name: '3x Suction Cup Mount Set', weight_kg: 1.5, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Suction mounts in bag, motorcycle OK', category: 'bundle' },
  { item_name: '4x Suction Cup Mount Set', weight_kg: 2.0, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: '4 suction mounts, needs car', category: 'bundle' },
  { item_name: '6x Suction Cup Mount Set', weight_kg: 3.0, packed_length_cm: 35, packed_width_cm: 25, packed_height_cm: 20, size_score: 3, is_heavy_large: false, courier_note: '6 suction mounts, needs car', category: 'bundle' },
  { item_name: '2x Rode Wireless Mic Pro Set', weight_kg: 1.0, packed_length_cm: 26, packed_width_cm: 22, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: '2 mic sets in bag, motorcycle OK', category: 'bundle' },
  { item_name: '2x PL to Sony E Mount Adapter Set', weight_kg: 0.4, packed_length_cm: 16, packed_width_cm: 14, packed_height_cm: 8, size_score: 1, is_heavy_large: false, courier_note: '2 adapters in pouch, tiny', category: 'bundle' },
  { item_name: '2x DJI RS3 Pro Gimbal Set', weight_kg: 3.0, packed_length_cm: 45, packed_width_cm: 25, packed_height_cm: 22, size_score: 3, is_heavy_large: false, courier_note: '2 gimbals in cases, needs car', category: 'bundle' },
  { item_name: '2x JBL Club 120 Speaker Set', weight_kg: 24.0, packed_length_cm: 55, packed_width_cm: 40, packed_height_cm: 40, size_score: 5, is_heavy_large: true, courier_note: '2 speakers (24kg total), van required', category: 'bundle' },

  // ── Camera + Lens combo bundles ──
  { item_name: 'Sony FX3 + 24-70mm GM Kit', weight_kg: 1.6, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + 16-35mm GM Kit', weight_kg: 1.4, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + 70-200mm GM Kit', weight_kg: 2.2, packed_length_cm: 35, packed_width_cm: 22, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: 'Camera + telephoto in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + 90mm GM Macro Kit', weight_kg: 1.3, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + GM Triple Lens Kit', weight_kg: 3.8, packed_length_cm: 40, packed_width_cm: 30, packed_height_cm: 20, size_score: 2, is_heavy_large: false, courier_note: 'Camera + 3 lenses in carry bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + 28-70mm Starter Kit', weight_kg: 1.0, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + 11mm Fisheye Kit', weight_kg: 0.9, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + small lens, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + Great Joy 35mm Anamorphic', weight_kg: 1.7, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + anamorphic lens, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + Great Joy 50mm Anamorphic', weight_kg: 1.7, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + anamorphic lens, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + Great Joy 85mm Anamorphic', weight_kg: 1.7, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + anamorphic lens, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + Blazar Remus 33mm Anamorphic', weight_kg: 1.6, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + anamorphic lens, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + Blazar Remus 45mm Anamorphic', weight_kg: 1.6, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + anamorphic lens, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + Blazar Remus 65mm Anamorphic', weight_kg: 1.6, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + anamorphic lens, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony A7 III + 24-70mm GM Kit', weight_kg: 1.6, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony A7 III + 16-35mm GM Kit', weight_kg: 1.4, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony A7 III + 70-200mm GM Kit', weight_kg: 2.2, packed_length_cm: 35, packed_width_cm: 22, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: 'Camera + telephoto in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony A7 III + GM Triple Lens Kit', weight_kg: 3.8, packed_length_cm: 40, packed_width_cm: 30, packed_height_cm: 20, size_score: 2, is_heavy_large: false, courier_note: 'Camera + 3 lenses in carry bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony A7 II + 28-70mm Kit', weight_kg: 0.9, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony A7 II + 24-70mm GM Kit', weight_kg: 1.5, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens, motorcycle OK', category: 'bundle' },
  { item_name: 'BMPCC 6K Pro + Canon 24-105mm Kit', weight_kg: 1.7, packed_length_cm: 32, packed_width_cm: 22, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'BMPCC 6K Pro + Canon 16-35mm f2.8 Kit', weight_kg: 1.7, packed_length_cm: 32, packed_width_cm: 22, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'BMPCC 6K FF + Canon 24-105mm Kit', weight_kg: 1.7, packed_length_cm: 32, packed_width_cm: 22, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens in padded bag, motorcycle OK', category: 'bundle' },

  // ── Camera + Gimbal combo bundles ──
  { item_name: 'Sony FX3 + RS3 Pro Gimbal Kit', weight_kg: 2.2, packed_length_cm: 42, packed_width_cm: 25, packed_height_cm: 20, size_score: 2, is_heavy_large: false, courier_note: 'Camera + gimbal, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + 24-70mm GM + RS3 Gimbal Kit', weight_kg: 3.1, packed_length_cm: 42, packed_width_cm: 28, packed_height_cm: 22, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens + gimbal, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony A7 III + RS3 Pro Gimbal Kit', weight_kg: 2.2, packed_length_cm: 42, packed_width_cm: 25, packed_height_cm: 20, size_score: 2, is_heavy_large: false, courier_note: 'Camera + gimbal, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony A7 III + 24-70mm + RS3 Gimbal Kit', weight_kg: 3.1, packed_length_cm: 42, packed_width_cm: 28, packed_height_cm: 22, size_score: 2, is_heavy_large: false, courier_note: 'Camera + lens + gimbal, motorcycle OK', category: 'bundle' },
  { item_name: 'BMPCC 6K Pro + RS3 Pro Gimbal Kit', weight_kg: 2.4, packed_length_cm: 42, packed_width_cm: 25, packed_height_cm: 20, size_score: 2, is_heavy_large: false, courier_note: 'Camera + gimbal, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + 24-70mm + Tilta Shoulder Rig Kit', weight_kg: 3.1, packed_length_cm: 42, packed_width_cm: 28, packed_height_cm: 20, size_score: 3, is_heavy_large: false, courier_note: 'Camera + lens + shoulder rig, needs car', category: 'bundle' },
  { item_name: 'Sony FX3 + Motorized Slider Kit', weight_kg: 3.7, packed_length_cm: 68, packed_width_cm: 22, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: 'Camera + slider (65cm long), needs car', category: 'bundle' },

  // ── Camera + Audio combo bundles ──
  { item_name: 'Sony FX3 + Rode Wireless Mic Kit', weight_kg: 1.2, packed_length_cm: 28, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + wireless mic, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + DJI Mic 2 Kit', weight_kg: 1.1, packed_length_cm: 28, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + wireless mic, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony A7 III + Rode Wireless Mic Kit', weight_kg: 1.2, packed_length_cm: 28, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + wireless mic, motorcycle OK', category: 'bundle' },

  // ── Camera + Monitor combo bundles ──
  { item_name: 'Sony FX3 + Atomos Ninja V Kit', weight_kg: 1.1, packed_length_cm: 28, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + monitor, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony FX3 + Hollyland 7-inch Monitor Kit', weight_kg: 1.2, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: 'Camera + monitor, motorcycle OK', category: 'bundle' },
  { item_name: 'BMPCC 6K Pro + Atomos Ninja V Kit', weight_kg: 1.3, packed_length_cm: 30, packed_width_cm: 22, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: 'Camera + monitor, motorcycle OK', category: 'bundle' },

  // ── Lens set bundles ──
  { item_name: 'Sony GM Triple Lens Set (16-35 + 24-70 + 70-200)', weight_kg: 3.1, packed_length_cm: 35, packed_width_cm: 25, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: '3 GM lenses in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony GM Duo (24-70 + 70-200)', weight_kg: 2.4, packed_length_cm: 32, packed_width_cm: 20, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: '2 GM lenses in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Sony GM Duo (16-35 + 24-70)', weight_kg: 1.6, packed_length_cm: 26, packed_width_cm: 18, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: '2 GM lenses in padded bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Canon EF Dual Lens Set (24-105 + 16-35)', weight_kg: 1.6, packed_length_cm: 26, packed_width_cm: 18, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: '2 Canon lenses in bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Great Joy Anamorphic Set (35+50+85mm)', weight_kg: 3.0, packed_length_cm: 35, packed_width_cm: 22, packed_height_cm: 16, size_score: 3, is_heavy_large: false, courier_note: '3 anamorphic lenses in padded bag, needs car', category: 'bundle' },
  { item_name: 'Blazar Remus 4-Lens Anamorphic Set (33+45+65+100)', weight_kg: 3.7, packed_length_cm: 38, packed_width_cm: 25, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: '4 anamorphic lenses in padded case, needs car', category: 'bundle' },
  { item_name: 'Blazar Remus 2-Lens Anamorphic Set (33+65)', weight_kg: 1.8, packed_length_cm: 28, packed_width_cm: 18, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: '2 anamorphic lenses in bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Blazar Remus 3-Lens Anamorphic Set (33+45+65)', weight_kg: 2.7, packed_length_cm: 32, packed_width_cm: 22, packed_height_cm: 16, size_score: 3, is_heavy_large: false, courier_note: '3 anamorphic lenses in bag, needs car', category: 'bundle' },
  { item_name: 'Great Joy Anamorphic Duo (35+50)', weight_kg: 2.0, packed_length_cm: 28, packed_width_cm: 18, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: '2 anamorphic lenses, motorcycle OK', category: 'bundle' },

  // ── Production / Scenario kit bundles ──
  { item_name: 'Sony FX3 Full Production Kit', weight_kg: 4.5, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 25, size_score: 3, is_heavy_large: false, courier_note: '6 items: camera, lens, gimbal, mic, monitor, filter. Needs car', category: 'bundle' },
  { item_name: 'Sony FX3 Full Production Kit + V-Mount 95mAh', weight_kg: 5.2, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 28, size_score: 3, is_heavy_large: true, courier_note: '7 items: production kit + V-mount battery (5.2kg). Needs car', category: 'bundle' },
  { item_name: 'Sony FX3 Full Production Kit + V-Mount 150mAh', weight_kg: 5.5, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 28, size_score: 3, is_heavy_large: true, courier_note: '7 items: production kit + large V-mount battery (5.5kg). Needs car', category: 'bundle' },
  { item_name: 'Documentary Filmmaker Kit', weight_kg: 2.9, packed_length_cm: 58, packed_width_cm: 25, packed_height_cm: 20, size_score: 3, is_heavy_large: false, courier_note: 'Camera, lens, wireless mic, boom. Needs car for boom length', category: 'bundle' },
  { item_name: 'Wedding Dual Camera Kit', weight_kg: 3.2, packed_length_cm: 35, packed_width_cm: 28, packed_height_cm: 22, size_score: 3, is_heavy_large: false, courier_note: '2 cameras + 2 lenses in carry bag, needs car', category: 'bundle' },
  { item_name: 'Wedding Full Kit', weight_kg: 5.8, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 28, size_score: 4, is_heavy_large: true, courier_note: '6 items (5.8kg): 2 cameras, 2 lenses, mic, gimbal. Car minimum', category: 'bundle' },
  { item_name: 'Corporate Interview Kit', weight_kg: 5.2, packed_length_cm: 45, packed_width_cm: 38, packed_height_cm: 25, size_score: 3, is_heavy_large: true, courier_note: 'Camera, lens, 2 LED panels, mic (5.2kg). Car minimum', category: 'bundle' },
  { item_name: 'Music Video Kit', weight_kg: 5.2, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 28, size_score: 4, is_heavy_large: true, courier_note: 'Camera, anamorphic, gimbal, hazer, tube light (5.2kg). Car minimum', category: 'bundle' },
  { item_name: 'Run & Gun Kit', weight_kg: 3.5, packed_length_cm: 42, packed_width_cm: 28, packed_height_cm: 22, size_score: 2, is_heavy_large: false, courier_note: 'Camera, lens, gimbal, wireless mic. Motorcycle OK', category: 'bundle' },
  { item_name: 'Talking Head / Vlog Kit', weight_kg: 3.4, packed_length_cm: 38, packed_width_cm: 32, packed_height_cm: 20, size_score: 3, is_heavy_large: false, courier_note: 'Camera, lens, LED panel, mic. Needs car', category: 'bundle' },
  { item_name: 'Real Estate Kit', weight_kg: 3.0, packed_length_cm: 42, packed_width_cm: 28, packed_height_cm: 22, size_score: 3, is_heavy_large: false, courier_note: 'Camera, wide lens, gimbal, drone. Needs car', category: 'bundle' },
  { item_name: 'Event Coverage Kit', weight_kg: 4.3, packed_length_cm: 45, packed_width_cm: 30, packed_height_cm: 25, size_score: 3, is_heavy_large: false, courier_note: '2 cameras, 2 lenses, mic. Needs car', category: 'bundle' },
  { item_name: 'Podcast / Talking Heads Kit', weight_kg: 4.3, packed_length_cm: 45, packed_width_cm: 35, packed_height_cm: 22, size_score: 3, is_heavy_large: false, courier_note: '2 LED panels, 2 wireless mics, boom. Needs car', category: 'bundle' },
  { item_name: 'Short Film Kit', weight_kg: 6.2, packed_length_cm: 55, packed_width_cm: 38, packed_height_cm: 30, size_score: 4, is_heavy_large: true, courier_note: '7 items (6.2kg): camera, 3 lenses, gimbal, monitor, mic. Car minimum', category: 'bundle' },
  { item_name: 'Anamorphic Film Kit (FX3 + Great Joy Set + RS3)', weight_kg: 5.2, packed_length_cm: 50, packed_width_cm: 30, packed_height_cm: 25, size_score: 3, is_heavy_large: true, courier_note: 'Camera, 3 anamorphic lenses, gimbal (5.2kg). Car minimum', category: 'bundle' },
  { item_name: 'Blazar Anamorphic Film Kit (FX3 + Blazar Set + RS3)', weight_kg: 5.9, packed_length_cm: 50, packed_width_cm: 32, packed_height_cm: 28, size_score: 4, is_heavy_large: true, courier_note: 'Camera, 4 anamorphic lenses, gimbal (5.9kg). Car minimum', category: 'bundle' },
  { item_name: 'BMPCC 6K Pro Cinema Kit', weight_kg: 4.6, packed_length_cm: 50, packed_width_cm: 30, packed_height_cm: 25, size_score: 3, is_heavy_large: false, courier_note: 'Camera, lens, gimbal, monitor in carry bag. Needs car', category: 'bundle' },
  { item_name: 'BMPCC 6K Pro Interview Kit', weight_kg: 4.4, packed_length_cm: 90, packed_width_cm: 25, packed_height_cm: 22, size_score: 4, is_heavy_large: true, courier_note: 'Camera, lens, tube light (85cm), mic. Car for tube length', category: 'bundle' },
  { item_name: 'FX3 Vlog Kit', weight_kg: 2.0, packed_length_cm: 30, packed_width_cm: 24, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: 'Camera, lens, wireless mic. Motorcycle OK', category: 'bundle' },
  { item_name: 'Steadicam Kit (FX3 + Shoulder Rig + Follow Focus)', weight_kg: 2.5, packed_length_cm: 42, packed_width_cm: 28, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: 'Camera, shoulder rig, follow focus. Needs car', category: 'bundle' },
  { item_name: 'Multi-Cam Interview Kit (3x FX3 + 3x Lenses)', weight_kg: 5.6, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 28, size_score: 4, is_heavy_large: true, courier_note: '3 cameras, 3 lenses (5.6kg). Car minimum', category: 'bundle' },

  // ── Audio bundles ──
  { item_name: 'Dual Wireless Mic Kit (2x Rode)', weight_kg: 1.0, packed_length_cm: 26, packed_width_cm: 22, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: '2 mic sets in bag, motorcycle OK', category: 'bundle' },
  { item_name: 'Full Audio Kit (Rode Wireless + Boom + VideoMic Pro)', weight_kg: 1.5, packed_length_cm: 58, packed_width_cm: 18, packed_height_cm: 12, size_score: 3, is_heavy_large: false, courier_note: 'Wireless mic, boom (55cm), video mic. Needs car for boom length', category: 'bundle' },
  { item_name: 'Interview Audio Kit (Rode Wireless + Boom)', weight_kg: 1.3, packed_length_cm: 58, packed_width_cm: 15, packed_height_cm: 12, size_score: 3, is_heavy_large: false, courier_note: 'Wireless mic + boom (55cm). Needs car for boom length', category: 'bundle' },
  { item_name: 'On-Camera Audio Kit (VideoMic Go + DJI Mic 2)', weight_kg: 0.5, packed_length_cm: 24, packed_width_cm: 16, packed_height_cm: 8, size_score: 2, is_heavy_large: false, courier_note: 'Small mics in case, motorcycle OK', category: 'bundle' },
  { item_name: 'Wireless Mic Duo (Rode + DJI)', weight_kg: 0.9, packed_length_cm: 26, packed_width_cm: 20, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: '2 wireless mic sets, motorcycle OK', category: 'bundle' },

  // ── Lighting bundles ──
  { item_name: 'Interview Lighting Kit (2x LED + Softbox)', weight_kg: 4.0, packed_length_cm: 58, packed_width_cm: 35, packed_height_cm: 20, size_score: 3, is_heavy_large: false, courier_note: '2 LED panels + softbox, needs car', category: 'bundle' },
  { item_name: 'Full Lighting Kit (Forza + 2x Pavotube + C-stand)', weight_kg: 11.5, packed_length_cm: 100, packed_width_cm: 40, packed_height_cm: 30, size_score: 5, is_heavy_large: true, courier_note: 'Heavy kit (11.5kg) with C-stand (100cm). Van recommended', category: 'bundle' },
  { item_name: 'Nanlite Studio Kit (Forza 300 + 500B)', weight_kg: 8.5, packed_length_cm: 55, packed_width_cm: 40, packed_height_cm: 35, size_score: 4, is_heavy_large: true, courier_note: '2 heavy lights (8.5kg). Car minimum, van if more items', category: 'bundle' },
  { item_name: 'Nanlite Key + Fill Kit (Forza 300 + Pavotube)', weight_kg: 5.0, packed_length_cm: 88, packed_width_cm: 38, packed_height_cm: 28, size_score: 4, is_heavy_large: true, courier_note: 'Forza + tube light (5kg, 85cm length). Car minimum', category: 'bundle' },
  { item_name: 'Tube Light Full Set (4x Pavotube + 2x Ambitful)', weight_kg: 9.0, packed_length_cm: 90, packed_width_cm: 30, packed_height_cm: 28, size_score: 4, is_heavy_large: true, courier_note: '6 tube lights (9kg, 85cm length). Car minimum, van preferred', category: 'bundle' },
  { item_name: 'Studio Lighting + Stands (2x LED + 2x Softbox)', weight_kg: 5.0, packed_length_cm: 60, packed_width_cm: 38, packed_height_cm: 22, size_score: 3, is_heavy_large: true, courier_note: '2 LED panels + 2 softboxes (5kg). Car minimum', category: 'bundle' },
  { item_name: 'Forza 300 + Softbox Kit', weight_kg: 4.5, packed_length_cm: 58, packed_width_cm: 38, packed_height_cm: 28, size_score: 4, is_heavy_large: true, courier_note: 'Heavy Forza light + softbox. Car minimum', category: 'bundle' },
  { item_name: 'Nanlite 500B + C-stand Kit', weight_kg: 10.0, packed_length_cm: 100, packed_width_cm: 38, packed_height_cm: 32, size_score: 5, is_heavy_large: true, courier_note: 'Heavy light + C-stand (10kg, 100cm). Van recommended', category: 'bundle' },
  { item_name: '3-Point LED Lighting Kit (3x LED panels)', weight_kg: 4.5, packed_length_cm: 40, packed_width_cm: 35, packed_height_cm: 24, size_score: 3, is_heavy_large: false, courier_note: '3 LED panels stacked, needs car', category: 'bundle' },
  { item_name: 'Ambient RGB Lighting Kit (2x Ambitful + 2x Pavotube)', weight_kg: 6.0, packed_length_cm: 88, packed_width_cm: 22, packed_height_cm: 20, size_score: 4, is_heavy_large: true, courier_note: '4 tube lights (6kg, 85cm length). Car minimum', category: 'bundle' },
  { item_name: 'Nanlite 500B + Softbox + C-stand Kit', weight_kg: 11.0, packed_length_cm: 100, packed_width_cm: 40, packed_height_cm: 35, size_score: 5, is_heavy_large: true, courier_note: 'Very heavy kit (11kg) with C-stand. Van recommended', category: 'bundle' },

  // ── Effects bundles ──
  { item_name: 'Full Smoke Kit (Fogger + Ninja Pro + Ninja)', weight_kg: 8.5, packed_length_cm: 45, packed_width_cm: 35, packed_height_cm: 30, size_score: 3, is_heavy_large: true, courier_note: '3 smoke machines (8.5kg). Needs car', category: 'bundle' },
  { item_name: 'Atmosphere Kit (Smoke Ninja + 2x Ambitful Tubes)', weight_kg: 3.0, packed_length_cm: 58, packed_width_cm: 18, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: 'Hazer + light tubes, needs car', category: 'bundle' },
  { item_name: 'Smoke Duo (Ninja + Ninja Pro)', weight_kg: 4.5, packed_length_cm: 38, packed_width_cm: 28, packed_height_cm: 22, size_score: 2, is_heavy_large: false, courier_note: '2 compact hazers, motorcycle OK', category: 'bundle' },
  { item_name: 'Music Video Atmosphere Kit (Smoke Ninja Pro + 2x Pavotube)', weight_kg: 6.0, packed_length_cm: 88, packed_width_cm: 28, packed_height_cm: 22, size_score: 4, is_heavy_large: true, courier_note: 'Hazer + 2 tube lights (6kg, 85cm). Car minimum', category: 'bundle' },

  // ── Drone bundles ──
  { item_name: 'Dual Drone Kit (Mavic 3 Pro + Mini 4 Pro)', weight_kg: 1.3, packed_length_cm: 38, packed_width_cm: 28, packed_height_cm: 18, size_score: 2, is_heavy_large: false, courier_note: '2 drone cases, motorcycle OK', category: 'bundle' },
  { item_name: 'Aerial + Ground Kit (Mavic 3 + FX3 + 16-35mm)', weight_kg: 2.4, packed_length_cm: 40, packed_width_cm: 30, packed_height_cm: 20, size_score: 2, is_heavy_large: false, courier_note: 'Drone + camera + wide lens, motorcycle OK', category: 'bundle' },

  // ── Monitor / Transmitter bundles ──
  { item_name: 'Wireless Monitor Kit (Hollyland 7" + Mars 4K)', weight_kg: 0.8, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: 'Monitor + transmitter, motorcycle OK', category: 'bundle' },
  { item_name: 'Wireless Director Kit (Hollyland 7" + Pyro S)', weight_kg: 0.8, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: 'Monitor + transmitter, motorcycle OK', category: 'bundle' },
  { item_name: 'Dual Monitor Kit (Atomos Ninja V + Hollyland 7")', weight_kg: 0.9, packed_length_cm: 28, packed_width_cm: 22, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: '2 monitors, motorcycle OK', category: 'bundle' },
  { item_name: 'Full Wireless Monitoring Kit (Atomos + Hollyland 7" + Mars 4K)', weight_kg: 1.2, packed_length_cm: 30, packed_width_cm: 24, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: '2 monitors + transmitter, motorcycle OK', category: 'bundle' },

  // ── Power bundles ──
  { item_name: 'V-Mount Power Pack (2x 95mAh + 2x 150mAh)', weight_kg: 3.4, packed_length_cm: 28, packed_width_cm: 20, packed_height_cm: 14, size_score: 2, is_heavy_large: false, courier_note: '4 batteries in case, motorcycle OK', category: 'bundle' },
  { item_name: 'Full Power Kit (Anker Station + 2x V-mount 150mAh)', weight_kg: 22.0, packed_length_cm: 55, packed_width_cm: 35, packed_height_cm: 35, size_score: 5, is_heavy_large: true, courier_note: 'Very heavy (22kg) power station + batteries. Van recommended', category: 'bundle' },
  { item_name: 'Camera Power Pack (2x NPF 970 + 2x V-mount 95mAh)', weight_kg: 2.2, packed_length_cm: 24, packed_width_cm: 18, packed_height_cm: 12, size_score: 2, is_heavy_large: false, courier_note: 'Battery pack in case, motorcycle OK', category: 'bundle' },
  { item_name: 'Anker Power Station + Cable Kit', weight_kg: 20.0, packed_length_cm: 55, packed_width_cm: 32, packed_height_cm: 32, size_score: 4, is_heavy_large: true, courier_note: 'Very heavy power station (20kg). Car minimum', category: 'bundle' },

  // ── DJ & Party bundles ──
  { item_name: 'JBL Speakers + Pioneer DJ RX3 Set', weight_kg: 29.5, packed_length_cm: 75, packed_width_cm: 50, packed_height_cm: 45, size_score: 5, is_heavy_large: true, courier_note: '2 speakers + DJ controller (29.5kg). VAN REQUIRED', category: 'bundle' },
  { item_name: 'Full Party Kit (DJ + Speakers + Smoke)', weight_kg: 33.5, packed_length_cm: 80, packed_width_cm: 55, packed_height_cm: 50, size_score: 5, is_heavy_large: true, courier_note: 'Speakers, DJ, fogger (33.5kg). VAN REQUIRED', category: 'bundle' },
  { item_name: 'DJ + Lights Party Kit', weight_kg: 32.5, packed_length_cm: 80, packed_width_cm: 55, packed_height_cm: 50, size_score: 5, is_heavy_large: true, courier_note: 'Speakers, DJ, LED panels (32.5kg). VAN REQUIRED', category: 'bundle' },
  { item_name: 'Ultimate Party Kit (DJ + Speakers + Smoke + Lights)', weight_kg: 35.5, packed_length_cm: 85, packed_width_cm: 60, packed_height_cm: 55, size_score: 5, is_heavy_large: true, courier_note: 'Full party setup (35.5kg). LARGE VAN REQUIRED', category: 'bundle' },

  // ── Accessory / Filter / Support bundles ──
  { item_name: 'Filter Kit (ND + Cinebloom)', weight_kg: 0.2, packed_length_cm: 15, packed_width_cm: 14, packed_height_cm: 6, size_score: 1, is_heavy_large: false, courier_note: '2 filter pouches, tiny', category: 'bundle' },
  { item_name: 'Memory Card Pack (3x 256GB)', weight_kg: 0.03, packed_length_cm: 12, packed_width_cm: 8, packed_height_cm: 4, size_score: 1, is_heavy_large: false, courier_note: 'Card case, pocket-sized', category: 'bundle' },
  { item_name: 'Memory Card + CFexpress Kit', weight_kg: 0.02, packed_length_cm: 12, packed_width_cm: 8, packed_height_cm: 4, size_score: 1, is_heavy_large: false, courier_note: 'Card case, pocket-sized', category: 'bundle' },
  { item_name: 'Support Kit (Tripod + Monopod)', weight_kg: 2.5, packed_length_cm: 58, packed_width_cm: 16, packed_height_cm: 14, size_score: 3, is_heavy_large: false, courier_note: 'Tripod + monopod in bags, needs car', category: 'bundle' },
  { item_name: 'Dual Tripod Kit (SmallRig + Sirui)', weight_kg: 3.5, packed_length_cm: 62, packed_width_cm: 18, packed_height_cm: 16, size_score: 3, is_heavy_large: false, courier_note: '2 tripods in bags, needs car', category: 'bundle' },
  { item_name: 'Camera Cage Kit (Shoulder Rig + Follow Focus)', weight_kg: 1.8, packed_length_cm: 42, packed_width_cm: 28, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: 'Shoulder rig + follow focus, needs car', category: 'bundle' },
  { item_name: 'Car Mount Kit (3x Suction Cups + GoPro)', weight_kg: 1.7, packed_length_cm: 28, packed_width_cm: 22, packed_height_cm: 16, size_score: 2, is_heavy_large: false, courier_note: '3 suction mounts + GoPro, motorcycle OK', category: 'bundle' },
  { item_name: 'GoPro Multi-Angle Kit (3x GoPro + 3x Suction Cups)', weight_kg: 2.1, packed_length_cm: 32, packed_width_cm: 25, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: '3 GoPros + 3 suction mounts, needs car', category: 'bundle' },
  { item_name: 'Action Cam Duo (GoPro + DJI Osmo)', weight_kg: 0.4, packed_length_cm: 20, packed_width_cm: 15, packed_height_cm: 10, size_score: 2, is_heavy_large: false, courier_note: '2 action cams, motorcycle OK', category: 'bundle' },
  { item_name: 'PL Mount Adapter Set (E + EF + RF + L)', weight_kg: 0.8, packed_length_cm: 18, packed_width_cm: 16, packed_height_cm: 10, size_score: 1, is_heavy_large: false, courier_note: '4 adapters in pouch, fits in backpack', category: 'bundle' },
];

/** Get delivery spec for a specific item (exact match, then fuzzy containment) */
export function getDeliverySpec(itemName: string): DeliverySpec | undefined {
  const lower = itemName.toLowerCase();
  // 1. Exact match
  const exact = DELIVERY_SPECS.find((s) => s.item_name.toLowerCase() === lower);
  if (exact) return exact;
  // 2. Fuzzy: spec name contains item name or vice versa
  return DELIVERY_SPECS.find(
    (s) =>
      s.category !== 'bundle' &&
      (s.item_name.toLowerCase().includes(lower) ||
        lower.includes(s.item_name.toLowerCase())),
  );
}

/** Format all delivery specs as text for AI context */
export function formatDeliverySpecsForAI(): string {
  const lines = DELIVERY_SPECS.map((s) => {
    const tag = s.is_heavy_large ? ' [HEAVY/LARGE]' : '';
    return `- ${s.item_name}: ${s.weight_kg}kg, ${s.packed_length_cm}x${s.packed_width_cm}x${s.packed_height_cm}cm, score ${s.size_score}/5${tag} -- ${s.courier_note}`;
  });
  return `=== DELIVERY ITEM SPECS ===\n${lines.join('\n')}`;
}
