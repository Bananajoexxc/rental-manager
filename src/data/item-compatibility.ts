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

import { normalizeItemName } from '../utils/item-matcher';

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
    item_name: 'Sony A7 V',
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
    compatible_accessories: [], // Mavic has its own ND kit — NOT our 82mm variable ND
    included_with_rental: ['3x flight batteries', 'charging hub', 'RC Pro controller', 'DJI ND filter set (8/16/32/64)'],
    notes: 'Fly More Combo included. Proprietary DJI batteries. Fixed cameras (Hasselblad + 70mm + 166mm). 46min max flight time per battery. ND FILTERS: The Mavic comes with its own DJI ND filter kit (ND8/16/32/64) designed for its lens — this is NOT our 82mm variable ND filter, which is for interchangeable lenses only.',
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

  // ──────────────────────────────────────────
  // SONY GM LENSES
  // ──────────────────────────────────────────
  {
    item_name: 'Sony GM 24-70mm f2.8',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'Sony E-mount (full frame)',
    compatible_lenses: [],
    compatible_accessories: ['ND filter', 'Cinebloom filter mist', 'Tilta Nucleus Nano 2 follow focus', 'DJI RS3 Pro gimbal'],
    included_with_rental: ['Front/rear lens caps', 'Lens pouch'],
    notes: 'Fits all our Sony cameras: FX3, A7 III, A7 II. 82mm filter thread for ND/mist filters. Versatile zoom, great all-rounder for video production. Works on DJI RS3 Pro gimbal with any Sony body.',
  },
  {
    item_name: 'Sony GM 16-35mm f2.8',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'Sony E-mount (full frame)',
    compatible_lenses: [],
    compatible_accessories: ['ND filter', 'Cinebloom filter mist', 'Tilta Nucleus Nano 2 follow focus', 'DJI RS3 Pro gimbal'],
    included_with_rental: ['Front/rear lens caps', 'Lens pouch'],
    notes: 'Fits all our Sony cameras: FX3, A7 III, A7 II. 82mm filter thread. Ultra-wide zoom for interiors, real estate, establishing shots, vlogs.',
  },
  {
    item_name: 'Sony GM 70-200mm f2.8',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'Sony E-mount (full frame)',
    compatible_lenses: [],
    compatible_accessories: ['ND filter', 'Cinebloom filter mist', 'Tilta Nucleus Nano 2 follow focus', 'Sirui tripod', 'Small rig tripod'],
    included_with_rental: ['Front/rear lens caps', 'Lens case', 'Tripod collar'],
    notes: 'Fits all our Sony cameras: FX3, A7 III, A7 II. 77mm filter thread — our 82mm ND and Cinebloom fit with the included 77-82mm step-up ring. Telephoto zoom for events, weddings, sports, interviews. Heavy lens — tripod with tripod collar recommended. Manageable on gimbal with lighter bodies.',
  },
  {
    item_name: 'Sony GM 90mm f2.8',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'Sony E-mount (full frame)',
    compatible_lenses: [],
    compatible_accessories: ['Tilta Nucleus Nano 2 follow focus', 'DJI RS3 Pro gimbal'],
    included_with_rental: ['Front/rear lens caps', 'Lens pouch'],
    notes: 'Fits all our Sony cameras: FX3, A7 III, A7 II. 67mm filter thread — our 82mm ND and Cinebloom filters do NOT fit (no step-up ring available for this size gap). Macro 1:1 + beautiful portrait bokeh. Lightweight, works great on gimbal.',
  },
  {
    item_name: 'Sony 28-70mm',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'Sony E-mount (full frame)',
    compatible_lenses: [],
    compatible_accessories: ['DJI RS3 Pro gimbal'],
    included_with_rental: ['Front/rear lens caps'],
    notes: 'Fits all our Sony cameras: FX3, A7 III, A7 II. 55mm filter thread — our 82mm ND and Cinebloom filters do NOT fit (no step-up ring available for this size gap). Compact budget zoom, lightweight and versatile. Great for gimbal work.',
  },
  {
    item_name: 'Sony 11mm f2.8 fisheye',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'Sony E-mount (APS-C, usable on full frame with crop)',
    compatible_lenses: [],
    compatible_accessories: ['DJI RS3 Pro gimbal'],
    included_with_rental: ['Front/rear lens caps'],
    notes: 'Fits all our Sony cameras: FX3, A7 III, A7 II (with crop). Ultra-wide fisheye, bulbous front element — NO filter thread, our ND and Cinebloom filters cannot be used. Great for skateboard, POV, creative angles.',
  },

  // ──────────────────────────────────────────
  // CANON EF LENSES
  // ──────────────────────────────────────────
  {
    item_name: 'Canon EF 16-35mm f2.8',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'Canon EF mount',
    compatible_lenses: [],
    compatible_accessories: ['ND filter', 'Cinebloom filter mist', 'Tilta Nucleus Nano 2 follow focus', 'DJI RS3 Pro gimbal'],
    included_with_rental: ['Front/rear lens caps', 'Lens pouch'],
    notes: 'Fits BMPCC 6K Pro (native EF mount). Fits BMPCC 6K Full Frame via L-mount to EF adapter (included with camera). Does NOT fit Sony cameras. 82mm filter thread. Ultra-wide zoom for interiors and establishing shots.',
  },
  {
    item_name: 'Canon EF 24-105mm f4',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'Canon EF mount',
    compatible_lenses: [],
    compatible_accessories: ['ND filter', 'Cinebloom filter mist', 'Tilta Nucleus Nano 2 follow focus', 'DJI RS3 Pro gimbal'],
    included_with_rental: ['Front/rear lens caps', 'Lens pouch'],
    notes: 'Fits BMPCC 6K Pro (native EF mount). Fits BMPCC 6K Full Frame via L-mount to EF adapter. Does NOT fit Sony cameras. 77mm filter thread — our 82mm ND and Cinebloom fit with the included 77-82mm step-up ring. Versatile all-purpose zoom, good for run-and-gun.',
  },

  // ──────────────────────────────────────────
  // ANAMORPHIC LENSES (PL mount — need adapter for all cameras)
  // ──────────────────────────────────────────
  {
    item_name: 'Anamorphic Blazar Remus 33mm',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'PL mount (requires adapter for all our cameras)',
    compatible_lenses: [],
    compatible_accessories: ['PL to Sony E mount', 'PL to EF mount', 'PL to L mount', 'PL to RF mount', 'Tilta Nucleus Nano 2 follow focus', 'ND filter', 'Cinebloom filter mist'],
    included_with_rental: ['Front/rear lens caps', 'Lens case'],
    notes: 'PL mount anamorphic — requires PL adapter: PL to Sony E for FX3/A7, PL to EF for BMPCC 6K Pro, PL to L for BMPCC 6K FF. 1.5x squeeze factor. 77mm front thread — our 82mm ND and Cinebloom fit with the included 77-82mm step-up ring. Dual-focus anamorphic. Cinematic oval bokeh and flares.',
  },
  {
    item_name: 'Anamorphic Blazar Remus 45mm',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'PL mount (requires adapter for all our cameras)',
    compatible_lenses: [],
    compatible_accessories: ['PL to Sony E mount', 'PL to EF mount', 'PL to L mount', 'PL to RF mount', 'Tilta Nucleus Nano 2 follow focus', 'ND filter', 'Cinebloom filter mist'],
    included_with_rental: ['Front/rear lens caps', 'Lens case'],
    notes: 'PL mount anamorphic — requires PL adapter. 1.5x squeeze. 77mm front thread — our 82mm ND and Cinebloom fit with the included 77-82mm step-up ring. Versatile mid-range focal length for anamorphic narratives, music videos.',
  },
  {
    item_name: 'Anamorphic Blazar Remus 65mm',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'PL mount (requires adapter for all our cameras)',
    compatible_lenses: [],
    compatible_accessories: ['PL to Sony E mount', 'PL to EF mount', 'PL to L mount', 'PL to RF mount', 'Tilta Nucleus Nano 2 follow focus', 'ND filter', 'Cinebloom filter mist'],
    included_with_rental: ['Front/rear lens caps', 'Lens case'],
    notes: 'PL mount anamorphic — requires PL adapter. 1.5x squeeze. 77mm front thread — our 82mm ND and Cinebloom fit with the included 77-82mm step-up ring. Medium telephoto for close-ups and dialogue scenes.',
  },
  {
    item_name: 'Anamorphic Blazar Remus 100mm',
    battery_type: 'N/A (lens)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'PL mount (requires adapter for all our cameras)',
    compatible_lenses: [],
    compatible_accessories: ['PL to Sony E mount', 'PL to EF mount', 'PL to L mount', 'PL to RF mount', 'Tilta Nucleus Nano 2 follow focus', 'Sirui tripod', 'ND filter', 'Cinebloom filter mist'],
    included_with_rental: ['Front/rear lens caps', 'Lens case'],
    notes: 'PL mount anamorphic — requires PL adapter. 1.5x squeeze. 77mm front thread — our 82mm ND and Cinebloom fit with the included 77-82mm step-up ring. Longest in the Remus set — great for compressed anamorphic portraits. Tripod recommended.',
  },

  // ──────────────────────────────────────────
  // MICROPHONES & AUDIO
  // ──────────────────────────────────────────
  {
    item_name: 'Rode Wireless Mic Pro set',
    battery_type: 'Built-in rechargeable (USB-C)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['2x transmitters', '1x receiver', 'USB-C cables', 'Windshields', 'Charging case'],
    notes: 'Dual-channel wireless mic system. Works with ALL our cameras via 3.5mm TRS output or USB-C. Plug into camera hot shoe or audio input. 32-bit float internal recording. Great for interviews, 2-person dialogue, run-and-gun.',
  },
  {
    item_name: 'Rode Video Mic Go',
    battery_type: 'Plug-in power (no battery needed)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['Windshield', 'Shoe mount'],
    notes: 'Compact on-camera shotgun mic. Works with ALL our cameras via 3.5mm TRS. No battery needed. Mounts on camera hot shoe. Good for vlogs, casual shoots, ambient audio.',
  },
  {
    item_name: 'Rode Video Mic Pro Plus',
    battery_type: 'LB-1 rechargeable (can also use plug-in power)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['Windshield', 'Rycote Lyre mount', 'LB-1 battery'],
    notes: 'Premium on-camera shotgun mic. Works with ALL our cameras via 3.5mm TRS. Includes high-pass filter and pad switch. Better audio quality than Mic Go. Mounts on camera hot shoe.',
  },
  {
    item_name: 'Audio boom mic Sennheiser',
    battery_type: 'AA battery or 48V phantom power',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Monopod arm support'], // Can use monopod as boom pole
    included_with_rental: ['Boom pole', 'Shock mount', 'Windshield/deadcat', 'XLR cable'],
    notes: 'Professional shotgun microphone on boom pole. XLR output — requires camera with XLR input (Sony FX3 has XLR via handle) or external recorder. Phantom power or AA battery. Best for film dialogue, interviews with dedicated sound operator.',
  },
  {
    item_name: 'DJI Wireless Mics',
    battery_type: 'Built-in rechargeable',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['2x transmitters', '1x receiver', 'Charging case', 'Windshields'],
    notes: 'DJI wireless mic system. Works with ALL our cameras via 3.5mm TRS or USB-C. Dual-channel. Internal recording as backup. Good for interviews and run-and-gun.',
  },
  {
    item_name: 'DJI Mic 2 wireless',
    battery_type: 'Built-in rechargeable',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['2x transmitters', '1x receiver', 'Charging case', 'Windshields'],
    notes: 'DJI Mic 2 — improved version with 32-bit float recording. Works with ALL our cameras and smartphones. Bluetooth + 2.4GHz. Great noise cancellation.',
  },
  {
    item_name: 'JBL wireless microphones',
    battery_type: 'Built-in rechargeable (USB-C)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['JBL Club 120 speaker'],
    included_with_rental: ['Wireless mic pair', 'USB dongle'],
    notes: 'JBL PartyBox wireless mic pair — designed for PA speakers and karaoke, NOT for film production audio. Connects to JBL speakers via 6.35mm dongle. 2.4GHz wireless, 30m range. Good for events, presentations, karaoke.',
  },

  // ──────────────────────────────────────────
  // WIRELESS VIDEO TRANSMITTERS
  // ──────────────────────────────────────────
  {
    item_name: 'Hollyland Mars 4K transmitter',
    battery_type: 'Built-in rechargeable + Sony NP-F compatible',
    compatible_batteries: ['Sony NPF 970 batteries 2x sets'],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Hollyland 7-inch monitor'],
    included_with_rental: ['TX + RX pair', 'HDMI cables', 'Mounting accessories'],
    notes: '4K wireless HDMI transmitter. TX mounts on camera, RX connects to director monitor. HDMI input/output. Up to 150m range. NPF battery extends runtime. Works with ALL our cameras.',
  },
  {
    item_name: 'Hollyland Pyro S transmitter',
    battery_type: 'Built-in rechargeable',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Hollyland 7-inch monitor'],
    included_with_rental: ['TX + RX pair', 'HDMI cables'],
    notes: 'Compact wireless HDMI transmitter. Smaller than Mars 4K. Good for gimbal work where size matters. HDMI only. Works with ALL our cameras.',
  },

  // ──────────────────────────────────────────
  // SUPPORT & RIGGING
  // ──────────────────────────────────────────
  {
    item_name: 'Sirui tripod',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['Fluid head', 'Quick release plate', 'Carry bag'],
    notes: 'Professional video tripod with fluid head. Supports ALL our cameras. 75mm bowl mount. Good for heavy setups (BMPCC + lens + follow focus). Quick release plate included.',
  },
  {
    item_name: 'Small rig tripod',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['Ball head', 'Quick release plate'],
    notes: 'Compact travel tripod. Supports ALL our cameras. Lighter than Sirui — better for travel/run-and-gun. Ball head (not fluid). Good for photography and light video.',
  },
  {
    item_name: 'C-stand',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Nanlite Forza 300', 'Nanlite 500B', 'Softbox 85cm', '5-in-1 reflector panel'],
    included_with_rental: ['C-stand with arm and knuckle', 'Sandbag'],
    notes: 'Heavy-duty grip stand for lights, modifiers, flags. Essential for studio lighting setups. Holds Nanlite Forza/500B lights, softboxes, reflectors. Heavy and bulky — van delivery recommended.',
  },
  {
    item_name: 'Monopod arm support',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Audio boom mic Sennheiser'],
    included_with_rental: ['Monopod'],
    notes: 'Camera monopod — can also double as a boom pole for audio. Supports all our cameras. Quick setup for run-and-gun situations where a tripod is too slow.',
  },
  {
    item_name: 'Motorized slider',
    battery_type: 'Built-in rechargeable / USB-C power',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Sirui tripod', 'Small rig tripod'],
    included_with_rental: ['Slider rail', 'Motor unit', 'Controller', 'USB-C cable'],
    notes: 'Motorized camera slider for smooth tracking shots. Supports ALL our cameras. Can mount on tripod legs. Programmable speed and direction. Great for product shots, timelapses, and interview B-roll.',
  },
  {
    item_name: 'Tilta Nucleus Nano 2 follow focus',
    battery_type: 'Built-in rechargeable (USB-C)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['DJI RS3 Pro gimbal', 'Tilta shoulder rig'],
    included_with_rental: ['Motor', 'Hand controller', 'Gear ring', 'Cables', 'Mounting rods'],
    notes: 'Wireless follow focus system. Mounts on any 15mm rod system or directly on DJI RS3 Pro gimbal. Compatible with ALL our lenses. Essential for anamorphic lenses (manual focus only). Hand controller for 1st AC or self-operate.',
  },
  {
    item_name: 'Tilta shoulder rig',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Tilta Nucleus Nano 2 follow focus', 'Atomos Ninja V', 'V-mount 95mAh', 'V-mount 150mAh'],
    included_with_rental: ['Shoulder pad', 'Baseplate', '15mm rods', 'Handle grips'],
    notes: 'Shoulder-mounted camera rig. 15mm rod system. Supports ALL our cameras. Great for handheld documentary/cinema work. Can mount follow focus, monitor, V-mount battery on the rig. Essential for BMPCC rigs.',
  },
  {
    item_name: 'Suction cups',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['GoPro 12 Hero', 'DJI Osmo Action Pro 5'],
    included_with_rental: ['Suction cup mount', 'GoPro adapter'],
    notes: 'Heavy-duty suction cup camera mount for cars, windows, smooth surfaces. Primary use: mounting action cameras (GoPro, DJI Osmo) on vehicles. Can also hold small cameras like A7 series with lightweight lens.',
  },

  // ──────────────────────────────────────────
  // LIGHTING ACCESSORIES
  // ──────────────────────────────────────────
  {
    item_name: 'LED light panels RGB',
    battery_type: 'Built-in rechargeable / AC power',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['C-stand', 'Small rig tripod'],
    included_with_rental: ['Light panel', 'AC adapter', 'Diffuser'],
    notes: 'Compact RGB LED panel. Full color + bi-color temperature control. Can mount on C-stand, light stand, or tabletop. Good for accent lighting, background colors, creative effects. We have multiple panels.',
  },
  {
    item_name: 'Ambitful RGB light tubes 2x set',
    battery_type: 'Built-in rechargeable',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['C-stand'],
    included_with_rental: ['2x RGB tubes', 'Mounting clips', 'Charging cables'],
    notes: 'Set of 2 RGB LED tube lights. Full color control. Can mount on C-stands, tape to walls, handheld. Great for practical lighting, background accents, music videos, creative effects.',
  },
  {
    item_name: 'Softbox 85cm',
    battery_type: 'N/A (modifier only)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Nanlite Forza 300', 'Nanlite 500B', 'C-stand'],
    included_with_rental: ['Softbox', 'Bowens mount adapter', 'Inner/outer diffusion'],
    notes: 'Bowens mount softbox — fits our Nanlite Forza 300 and 500B lights. 85cm octagonal. Produces soft, even lighting for interviews and beauty work. Mount on C-stand for stability.',
  },
  {
    item_name: '5-in-1 reflector panel',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['C-stand'],
    included_with_rental: ['Reflector with 5 surfaces'],
    notes: 'Collapsible reflector with 5 interchangeable surfaces: gold, silver, white, black, translucent. Use with C-stand or handheld. Essential for outdoor shoots to bounce/block natural light. ~80cm diameter.',
  },
  {
    item_name: 'Camera flash',
    battery_type: 'AA batteries',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Softbox 85cm'],
    included_with_rental: ['Flash unit', 'Diffuser', 'AA batteries'],
    notes: 'Speedlight flash. Multi-brand hot shoe mount — works with all our cameras. Manual and TTL modes. Can trigger wirelessly. Good for event photography and fill flash.',
  },

  // ──────────────────────────────────────────
  // SMOKE & HAZE
  // ──────────────────────────────────────────
  {
    item_name: 'Smoke machine fogger',
    battery_type: 'AC power (mains)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['Fog machine', 'Remote control', 'Fog fluid'],
    notes: 'Standard fog machine — needs mains power. Produces thick fog bursts. Good for dramatic scenes, music videos, events. Use with good ventilation. CANNOT be used battery-powered. Fog fluid included.',
  },
  {
    item_name: 'Smoke Ninja',
    battery_type: 'Built-in rechargeable (USB-C)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['Smoke Ninja unit', 'Fog cartridges', 'USB-C cable'],
    notes: 'Portable battery-powered haze machine. Compact, no mains power needed. Produces fine atmospheric haze (not thick fog). Great for light beams, mood, cinematic atmosphere on location. Uses proprietary fog cartridges.',
  },
  {
    item_name: 'Smoke Ninja Pro hazer',
    battery_type: 'Built-in rechargeable (USB-C)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['Smoke Ninja Pro unit', 'Fog cartridges', 'USB-C cable'],
    notes: 'Pro version of Smoke Ninja — larger capacity, longer runtime, more consistent haze output. Still battery-powered and portable. Best for all-day shoots needing sustained atmosphere. Uses proprietary fog cartridges.',
  },

  // ──────────────────────────────────────────
  // FILTERS
  // ──────────────────────────────────────────
  {
    item_name: 'ND filter',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['ND filter', 'Filter case'],
    notes: 'Variable ND filter (82mm thread). DIRECT FIT: Sony GM 24-70mm f2.8, Sony GM 16-35mm f2.8, Canon EF 16-35mm f2.8 (all 82mm). WITH 77-82mm STEP-UP RING (included): Canon EF 24-105mm f4, Sony GM 70-200mm f2.8, all Blazar Remus anamorphics (77mm front). DOES NOT FIT: Sony GM 90mm f2.8 (67mm), Sony 28-70mm (55mm), Sony 11mm fisheye (no thread/bulbous front). Essential for cinematic shallow depth of field outdoors.',
  },
  {
    item_name: 'Cinebloom filter mist',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['Cinebloom filter', 'Filter case'],
    notes: 'Moment CineBloom diffusion/mist filter (82mm thread). DIRECT FIT: Sony GM 24-70mm f2.8, Sony GM 16-35mm f2.8, Canon EF 16-35mm f2.8 (all 82mm). WITH 77-82mm STEP-UP RING (included): Canon EF 24-105mm f4, Sony GM 70-200mm f2.8, all Blazar Remus anamorphics (77mm front). DOES NOT FIT: Sony GM 90mm f2.8 (67mm), Sony 28-70mm (55mm), Sony 11mm fisheye (no thread/bulbous front). Softens highlights, creates halation and a dreamy cinematic look. Popular for music videos, weddings, and narrative work.',
  },

  // ──────────────────────────────────────────
  // POWER & BATTERIES
  // ──────────────────────────────────────────
  {
    item_name: 'V-mount 95mAh',
    battery_type: 'V-mount (95Wh)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Nanlite Forza 300', 'Nanlite 500B', 'Tilta shoulder rig'],
    included_with_rental: ['V-mount battery', 'D-tap cable', 'V-mount plate'],
    notes: '95Wh V-mount battery. Powers cameras (via D-tap/dummy battery), Nanlite lights, monitors. Airline-safe (under 100Wh). ALWAYS comes with plates, adapters, and cables needed for connection. ~2-3 hours runtime on FX3, less on Nanlite lights.',
  },
  {
    item_name: 'V-mount 150mAh',
    battery_type: 'V-mount (150Wh)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Nanlite Forza 300', 'Nanlite 500B', 'Tilta shoulder rig'],
    included_with_rental: ['V-mount battery', 'D-tap cable', 'V-mount plate'],
    notes: '150Wh V-mount battery. More capacity than 95Wh — better for power-hungry lights (Nanlite 500B). NOT airline-safe (over 100Wh). ALWAYS comes with plates, adapters, and cables. ~4-5 hours runtime on FX3.',
  },
  {
    item_name: 'Sony NPF 970 batteries 2x sets',
    battery_type: 'Sony NP-F970',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['Atomos Ninja V', 'Hollyland 7-inch monitor', 'Hollyland Mars 4K transmitter'],
    included_with_rental: ['2x NP-F970 batteries', 'Dual charger'],
    notes: 'Sony NP-F970 battery pair with charger. Powers Atomos Ninja V monitor, Hollyland monitors/transmitters. Does NOT power Sony cameras directly (FX3 uses NP-FZ100). Each battery ~6600mAh. Industry standard for monitors and accessories.',
  },
  {
    item_name: 'DJI gimbal battery',
    battery_type: 'DJI RS BG30 grip battery',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['DJI RS3 Pro gimbal'],
    included_with_rental: ['BG30 grip battery'],
    notes: 'Extra battery grip for DJI RS3 Pro gimbal. Extends runtime significantly for all-day shoots. Clips onto the bottom of the gimbal handle.',
  },
  {
    item_name: 'Anker Power Station F2000',
    battery_type: 'Built-in LFP battery (2048Wh)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['Power station', 'AC cable'],
    notes: 'Massive 2048Wh portable power station. Multiple AC outlets, USB-C, USB-A, 12V car outlet. Powers lights, chargers, laptops, fog machines — everything on set. Heavy (~28kg) — van delivery required. Good for off-grid locations where mains power is not available.',
  },

  // ──────────────────────────────────────────
  // STORAGE CARDS
  // ──────────────────────────────────────────
  {
    item_name: 'CF Express Type A card',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'CFexpress Type A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['CFexpress Type A card', 'Card case'],
    notes: 'CFexpress Type A card — fits Sony FX3 primary slot. Faster write speeds than SD. Required for 4K 120fps on FX3. NOT compatible with BMPCC cameras (different card format).',
  },
  {
    item_name: '256GB card',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'SD UHS-II 256GB',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: [],
    included_with_rental: ['256GB SD card', 'Card case'],
    notes: '256GB SD card — fits ALL our cameras (Sony FX3 secondary slot, A7 III, A7 II, BMPCC, Fujifilm, drones, action cameras). Universal backup card.',
  },

  // ──────────────────────────────────────────
  // PL MOUNT ADAPTERS
  // ──────────────────────────────────────────
  {
    item_name: 'PL to Sony E mount',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'PL to Sony E-mount adapter',
    compatible_lenses: [
      'Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm',
      'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm',
          ],
    compatible_accessories: [],
    included_with_rental: ['PL to E adapter'],
    notes: 'Allows PL mount lenses (all our anamorphic lenses) to be used on Sony cameras: FX3, A7 III, A7 II. Required for using Blazar Remus anamorphic lenses on Sony bodies.',
  },
  {
    item_name: 'PL to EF mount',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'PL to Canon EF-mount adapter',
    compatible_lenses: [
      'Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm',
      'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm',
          ],
    compatible_accessories: [],
    included_with_rental: ['PL to EF adapter'],
    notes: 'Allows PL mount lenses to be used on BMPCC 6K Pro (Canon EF mount). Required for anamorphic lenses on BMPCC 6K Pro.',
  },
  {
    item_name: 'PL to L mount',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'PL to L-mount adapter',
    compatible_lenses: [
      'Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm',
      'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm',
          ],
    compatible_accessories: [],
    included_with_rental: ['PL to L adapter'],
    notes: 'Allows PL mount lenses to be used on BMPCC 6K Full Frame (L-mount). Required for anamorphic lenses on BMPCC 6K FF.',
  },
  {
    item_name: 'PL to RF mount',
    battery_type: 'N/A',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'PL to Canon RF-mount adapter',
    compatible_lenses: [
      'Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm',
      'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm',
          ],
    compatible_accessories: [],
    included_with_rental: ['PL to RF adapter'],
    notes: 'PL to Canon RF mount adapter. We do NOT stock Canon RF cameras, but this adapter is available for renters who bring their own RF body and want to use our PL anamorphic lenses.',
  },

  // ──────────────────────────────────────────
  // DJ & SPEAKERS
  // ──────────────────────────────────────────
  {
    item_name: 'JBL Club 120 speaker',
    battery_type: 'Built-in rechargeable (12hr)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['DJ RX3 Pioneer controller', 'JBL wireless microphones'],
    included_with_rental: ['Speaker', 'Power cable', 'AUX cable'],
    notes: '160W portable Bluetooth party speaker. Can pair 2 speakers for stereo. Mic + guitar inputs. Great for events, wrap parties. Pairs with Pioneer DJ RX3. Heavy (12kg each) — self-pickup OK, but if delivery requested needs car/van. Delivery only MANDATORY when booked together with DJ deck.',
  },
  {
    item_name: 'DJ RX3 Pioneer controller',
    battery_type: 'AC power (mains)',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['JBL Club 120 speaker'],
    included_with_rental: ['Controller', 'Power cable', 'USB cable', 'RCA to 3.5mm cable'],
    notes: 'Pioneer DDJ-RX3 DJ controller. Works with Rekordbox/Serato. Connect to JBL speakers via RCA or 3.5mm. Renter needs laptop with DJ software. Heavy + bulky — self-pickup OK for controller alone. Delivery only MANDATORY when booked together with speakers.',
  },
  {
    item_name: 'Nanlite Pavotube 4x set',
    battery_type: 'Built-in rechargeable',
    compatible_batteries: [],
    card_type: 'N/A',
    compatible_cards: [],
    lens_mount: 'N/A',
    compatible_lenses: [],
    compatible_accessories: ['C-stand'],
    included_with_rental: ['4x Pavotube tubes', 'Charging hub', 'Mounting clips'],
    notes: 'Set of 4 Nanlite Pavotube RGB LED tubes. App-controlled color/effects. Great for practical lighting, music videos, creative backgrounds. Minimum rental is full 4-tube set.',
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

/** Find the best-matching compatibility entry for a given item name using fuzzy normalization */
function findCompatEntry(name: string): CompatibilityEntry | undefined {
  const norm = normalizeItemName(name);
  return ITEM_COMPATIBILITY.find((c) => {
    const cNorm = normalizeItemName(c.item_name);
    return cNorm === norm || cNorm.includes(norm) || norm.includes(cNorm);
  });
}

/** Check if a compatibility entry represents a camera (has a lens mount that accepts interchangeable lenses) */
function isCamera(entry: CompatibilityEntry): boolean {
  return entry.compatible_lenses.length > 0;
}

/** Check if a compatibility entry represents a lens */
function isLens(entry: CompatibilityEntry): boolean {
  return entry.battery_type === 'N/A (lens)';
}

/**
 * Check for compatibility conflicts between items mentioned together.
 * Detects lens mount mismatches and card type conflicts.
 */
export function checkCompatibilityConflicts(items: string[]): { conflicts: { camera: string; item: string; reason: string }[] } {
  const conflicts: { camera: string; item: string; reason: string }[] = [];
  if (items.length < 2) return { conflicts };

  // Resolve each mentioned item to its compatibility entry
  const resolved = items.map((name) => ({ name, entry: findCompatEntry(name) })).filter((r) => r.entry);

  const cameras = resolved.filter((r) => r.entry && isCamera(r.entry));
  const lenses = resolved.filter((r) => r.entry && isLens(r.entry));

  for (const cam of cameras) {
    const camEntry = cam.entry!;
    const compatibleLensNorms = camEntry.compatible_lenses.map((l) => normalizeItemName(l));

    for (const lens of lenses) {
      const lensNorm = normalizeItemName(lens.name);
      // Check if this lens is in the camera's compatible list
      const isCompatible = compatibleLensNorms.some(
        (cl) => cl === lensNorm || cl.includes(lensNorm) || lensNorm.includes(cl),
      );

      if (!isCompatible) {
        conflicts.push({
          camera: cam.name,
          item: lens.name,
          reason: `${cam.name} uses ${camEntry.lens_mount} — ${lens.name} uses ${lens.entry!.lens_mount}. These are NOT compatible.`,
        });
      }
    }

    // Check card type conflicts (e.g., CFexpress Type A card with a camera that only takes SD)
    const cards = resolved.filter((r) => r.entry && r.entry.card_type !== 'N/A' && !isCamera(r.entry) && !isLens(r.entry) && r.entry.card_type.includes('CFexpress'));
    for (const card of cards) {
      if (!camEntry.card_type.includes('CFexpress') && card.entry!.card_type.includes('CFexpress')) {
        conflicts.push({
          camera: cam.name,
          item: card.name,
          reason: `${cam.name} uses ${camEntry.card_type} — ${card.name} (${card.entry!.card_type}) may not be compatible.`,
        });
      }
    }
  }

  return { conflicts };
}

/**
 * Detect missing essential companion items (e.g., camera without a lens).
 * Returns suggestions from the compatibility matrix.
 */
export function detectMissingEssentials(items: string[]): { missing: { camera: string; category: string; suggestions: string[] }[] } {
  const missing: { camera: string; category: string; suggestions: string[] }[] = [];
  if (items.length === 0) return { missing };

  const resolved = items.map((name) => ({ name, entry: findCompatEntry(name) })).filter((r) => r.entry);

  const cameras = resolved.filter((r) => r.entry && isCamera(r.entry));
  const lenses = resolved.filter((r) => r.entry && isLens(r.entry));
  const allNorms = items.map((i) => normalizeItemName(i));

  for (const cam of cameras) {
    const camEntry = cam.entry!;

    // Check if any compatible lens is mentioned
    const hasLens = lenses.length > 0 || camEntry.compatible_lenses.some((cl) => {
      const clNorm = normalizeItemName(cl);
      return allNorms.some((n) => n === clNorm || n.includes(clNorm) || clNorm.includes(n));
    });

    if (!hasLens && camEntry.compatible_lenses.length > 0) {
      // Suggest top 3 most popular compatible lenses (prefer zoom lenses first)
      const suggestions = camEntry.compatible_lenses
        .filter((l) => !l.includes('Anamorphic')) // Prefer standard lenses as suggestions
        .slice(0, 3);
      missing.push({
        camera: cam.name,
        category: 'lens',
        suggestions: suggestions.length > 0 ? suggestions : camEntry.compatible_lenses.slice(0, 3),
      });
    }

    // Check if camera needs specific cards not included and not mentioned
    const includedStr = camEntry.included_with_rental.join(' ').toLowerCase();
    if (camEntry.card_type.includes('CFexpress') && !includedStr.includes('cfexpress')) {
      const hasCfCard = allNorms.some((n) => n.includes('cf express') || n.includes('cfexpress'));
      if (!hasCfCard && camEntry.compatible_cards.some((c) => c.includes('CF Express'))) {
        missing.push({
          camera: cam.name,
          category: 'card',
          suggestions: camEntry.compatible_cards.filter((c) => c.includes('CF Express')),
        });
      }
    }
  }

  return { missing };
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
  return `=== ITEM COMPATIBILITY (reference data — use ONLY to answer renter questions) ===\nIMPORTANT: This data is for YOUR reference. NEVER volunteer compatibility info the renter didn't ask about. NEVER assume or mention what camera/equipment the renter owns unless THEY explicitly said it. Only use this to answer direct questions (e.g. "is this compatible with my A7 IV?").\n${parts.join('\n\n')}`;
}
