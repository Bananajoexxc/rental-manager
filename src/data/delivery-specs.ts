/**
 * DELIVERY ITEM SPECIFICATIONS
 *
 * Packed dimensions, weights, and courier suitability for every item.
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

  // ── M (score 3) - Small Car ──
  { item_name: 'Sony GM 70-200mm f2.8', weight_kg: 1.5, packed_length_cm: 30, packed_width_cm: 14, packed_height_cm: 14, size_score: 3, is_heavy_large: false, courier_note: 'Large telephoto in padded case, needs car', category: 'lens' },
  { item_name: 'DJI Mavic 3 Pro', weight_kg: 1.0, packed_length_cm: 35, packed_width_cm: 25, packed_height_cm: 15, size_score: 3, is_heavy_large: false, courier_note: 'Drone in Fly More case, needs car boot', category: 'drone' },
  { item_name: 'Audio boom mic Sennheiser', weight_kg: 0.8, packed_length_cm: 55, packed_width_cm: 10, packed_height_cm: 10, size_score: 3, is_heavy_large: false, courier_note: 'Long boom tube, needs car', category: 'audio' },
  { item_name: 'DJI RS3 Pro gimbal', weight_kg: 1.5, packed_length_cm: 40, packed_width_cm: 20, packed_height_cm: 18, size_score: 3, is_heavy_large: false, courier_note: 'Gimbal in hard case, needs car boot', category: 'stabilizer' },
  { item_name: 'LED light panels RGB', weight_kg: 1.5, packed_length_cm: 35, packed_width_cm: 30, packed_height_cm: 8, size_score: 3, is_heavy_large: false, courier_note: 'LED panel in padded bag', category: 'lighting' },
  { item_name: 'Softbox 85cm', weight_kg: 1.0, packed_length_cm: 55, packed_width_cm: 15, packed_height_cm: 15, size_score: 3, is_heavy_large: false, courier_note: 'Folded softbox in tube bag', category: 'lighting' },
  { item_name: 'Small rig tripod', weight_kg: 1.5, packed_length_cm: 55, packed_width_cm: 12, packed_height_cm: 12, size_score: 3, is_heavy_large: false, courier_note: 'Tripod in bag, needs car', category: 'support' },
  { item_name: 'Sirui tripod', weight_kg: 2.0, packed_length_cm: 60, packed_width_cm: 14, packed_height_cm: 14, size_score: 3, is_heavy_large: false, courier_note: 'Tripod in bag, needs car', category: 'support' },
  { item_name: 'Motorized slider', weight_kg: 3.0, packed_length_cm: 65, packed_width_cm: 18, packed_height_cm: 15, size_score: 3, is_heavy_large: false, courier_note: 'Slider in padded case, needs car', category: 'motion' },
  { item_name: 'Monopod arm support', weight_kg: 1.0, packed_length_cm: 50, packed_width_cm: 10, packed_height_cm: 10, size_score: 3, is_heavy_large: false, courier_note: 'Monopod in tube, needs car', category: 'support' },
  { item_name: 'Tilta shoulder rig', weight_kg: 1.5, packed_length_cm: 40, packed_width_cm: 25, packed_height_cm: 15, size_score: 3, is_heavy_large: false, courier_note: 'Rig in case, needs car', category: 'support' },
  { item_name: 'Ambitful RGB light tubes 2x set', weight_kg: 1.5, packed_length_cm: 55, packed_width_cm: 15, packed_height_cm: 15, size_score: 3, is_heavy_large: false, courier_note: 'Light tubes in carry tube, needs car', category: 'lighting' },

  // ── L (score 4) - Car / Van if multiple - HEAVY/LARGE ──
  { item_name: 'Nanlite Forza 300', weight_kg: 3.5, packed_length_cm: 45, packed_width_cm: 35, packed_height_cm: 25, size_score: 4, is_heavy_large: true, courier_note: 'Heavy light + power unit, requires car boot', category: 'lighting' },
  { item_name: 'Nanlite 500B', weight_kg: 5.0, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 30, size_score: 4, is_heavy_large: true, courier_note: 'Heavy light (5kg), requires car minimum', category: 'lighting' },
  { item_name: 'Nanlite Pavotube 30x II', weight_kg: 1.5, packed_length_cm: 85, packed_width_cm: 10, packed_height_cm: 10, size_score: 4, is_heavy_large: true, courier_note: 'Long tube light (85cm), needs car for length', category: 'lighting' },
  { item_name: 'C-stand', weight_kg: 5.0, packed_length_cm: 100, packed_width_cm: 15, packed_height_cm: 15, size_score: 4, is_heavy_large: true, courier_note: 'Heavy stand (5kg), very long, requires car', category: 'support' },
  { item_name: 'Anker Power Station F2000', weight_kg: 20.0, packed_length_cm: 50, packed_width_cm: 30, packed_height_cm: 30, size_score: 4, is_heavy_large: true, courier_note: 'Very heavy (20kg), requires car minimum', category: 'power' },
  { item_name: 'JBL Club 120 speaker', weight_kg: 12.0, packed_length_cm: 50, packed_width_cm: 35, packed_height_cm: 35, size_score: 4, is_heavy_large: true, courier_note: 'Heavy speaker (12kg each), requires car/van', category: 'audio' },

  // ── XL (score 5) - Van territory ──
  { item_name: 'DJ RX3 Pioneer controller', weight_kg: 5.5, packed_length_cm: 70, packed_width_cm: 45, packed_height_cm: 20, size_score: 5, is_heavy_large: true, courier_note: 'Large DJ controller in flight case, van if with speakers', category: 'dj' },
  { item_name: 'Smoke machine fogger', weight_kg: 4.0, packed_length_cm: 40, packed_width_cm: 30, packed_height_cm: 25, size_score: 5, is_heavy_large: true, courier_note: 'Heavy fogger with fluid tank, needs car/van', category: 'effects' },
  { item_name: 'Smoke Ninja Pro hazer', weight_kg: 3.0, packed_length_cm: 35, packed_width_cm: 25, packed_height_cm: 20, size_score: 5, is_heavy_large: true, courier_note: 'Professional hazer, needs car/van', category: 'effects' },
  { item_name: 'Smoke Ninja', weight_kg: 1.5, packed_length_cm: 25, packed_width_cm: 15, packed_height_cm: 15, size_score: 5, is_heavy_large: true, courier_note: 'Compact hazer, car sufficient', category: 'effects' },
];

/** Get delivery spec for a specific item */
export function getDeliverySpec(itemName: string): DeliverySpec | undefined {
  const lower = itemName.toLowerCase();
  return DELIVERY_SPECS.find((s) => s.item_name.toLowerCase() === lower);
}

/** Format all delivery specs as text for AI context */
export function formatDeliverySpecsForAI(): string {
  const lines = DELIVERY_SPECS.map((s) => {
    const tag = s.is_heavy_large ? ' [HEAVY/LARGE]' : '';
    return `- ${s.item_name}: ${s.weight_kg}kg, ${s.packed_length_cm}x${s.packed_width_cm}x${s.packed_height_cm}cm, score ${s.size_score}/5${tag} -- ${s.courier_note}`;
  });
  return `=== DELIVERY ITEM SPECS ===\n${lines.join('\n')}`;
}
