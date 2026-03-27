/**
 * UK retail replacement costs for insurance cap calculations.
 * ONLY items from MASTER_INVENTORY. No phantom items.
 * Camera kit totals include body + batteries + storage + reader.
 */
export const REPLACEMENT_COSTS: Record<string, number> = {
  "Sony FX3": 3899,
  "Sony A7 V": 2699,
  "Sony A7 III": 1399,
  "Sony A7 II": 800,
  "Fujifilm X100 VI": 1599,
  "BMPCC 6K Pro": 1849,
  "BMPCC 6K Full Frame": 2535,
  "DJI Osmo Action Pro 5": 349,
  "GoPro 12 Hero": 349,
  "Sony GM 24-70mm f2.8": 2099,
  "Sony GM 16-35mm f2.8": 2099,
  "Sony GM 70-200mm f2.8": 2399,
  "Sony GM 90mm f2.8": 1099,
  "Sony 28-70mm": 299,
  "Sony 11mm f2.8 fisheye": 549,
  "Canon EF 24-105mm f4": 699,
  "Canon EF 16-35mm f2.8": 999,
  "DJI Mavic 3 Pro": 1749,
  "DJI Mini 4 Pro": 899,
  "DJI RS3 Pro gimbal": 729,
  "Atomos Ninja V": 599,
  "Anker Power Station F2000": 1299,
  "Anamorphic Blazar Remus 33mm": 999,
  "Anamorphic Blazar Remus 45mm": 999,
  "Anamorphic Blazar Remus 65mm": 999,
  "Anamorphic Blazar Remus 100mm": 999,
  "Tilta shoulder rig": 249,
  "Small rig tripod": 179,
  "Sirui tripod": 249,
  "Nanlite Forza 300": 549,
  "Nanlite 500B": 899,
  "Hollyland Mars 4K transmitter": 399,
  "Hollyland Pyro S transmitter": 499,
  "Rode Wireless Mic Pro set": 349,
  "DJI Wireless Mics": 279,
    "Audio boom mic Sennheiser": 777
};

export const CAMERA_KIT_TOTALS: Record<string, number> = {
  "Sony FX3": 4377,
  "Sony A7 V": 2958,
  "Sony A7 III": 1548,
  "Sony A7 II": 909,
  "Fujifilm X100 VI": 1708,
  "BMPCC 6K Pro": 2287,
  "BMPCC 6K Full Frame": 3033,
  "DJI Osmo Action Pro 5": 448,
  "GoPro 12 Hero": 428
};

export function getTotalReplacementCost(items: string[]): number {
  let total = 0;
  for (const item of items) {
    const lower = item.toLowerCase();
    for (const [name, cost] of Object.entries(CAMERA_KIT_TOTALS)) {
      if (lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower)) {
        total += cost;
        break;
      }
    }
  }
  return total;
}

export function getItemsUnderCap(cap: number): string[] {
  return Object.entries(CAMERA_KIT_TOTALS)
    .filter(([_, cost]) => cost <= cap)
    .sort((a, b) => b[1] - a[1])
    .map(([name, cost]) => `${name} kit (£${cost})`);
}
