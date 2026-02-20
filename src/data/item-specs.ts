/**
 * ITEM SPECS — In-depth product knowledge for every inventory item.
 *
 * Loaded contextually: only specs for items mentioned in conversation are injected into AI context.
 * This gives the AI deep product knowledge to answer usage questions, recommend gear,
 * and compare alternatives without hallucinating specs.
 *
 * Each spec string is 2-4 lines of dense, factual info a renter would want to know.
 */

export interface ItemSpec {
  item_name: string;
  specs: string;
}

export const ITEM_SPECS: ItemSpec[] = [
  // ──────────────────────────────────────────
  // CAMERAS
  // ──────────────────────────────────────────
  {
    item_name: 'Sony FX3',
    specs: 'Full-frame 12.1MP Exmor R CMOS (same sensor as A7S III). 4K120p 10-bit 4:2:2 internal, S-Cinetone color science. 15+ stops dynamic range, dual native ISO 800/12800. Active SteadyShot IBIS, S-Log3/S-Gamut3.Cine. CFexpress Type A + SD dual slot. 5-pin XLR with phantom power. Compact cinema body (715g with grip). Best for: narrative film, commercial, doc — the go-to affordable cinema camera.',
  },
  {
    item_name: 'Sony A7 III',
    specs: 'Full-frame 24.2MP Exmor R CMOS, BIONZ X processor. 4K30p (with 1.2x crop) and 1080p120. 15-stop dynamic range, ISO 100-204800 (expandable). 693 phase-detect AF points + 425 contrast AF, Eye AF. 5-axis IBIS (5 stops). Dual SD card slots. 710 shots per charge (LCD). Best for: versatile photo/video hybrid — great all-rounder for events, doc, and content creation.',
  },
  {
    item_name: 'Sony A7 II',
    specs: 'Full-frame 24.3MP Exmor CMOS, BIONZ X. 1080p60 max video (no 4K without crop workaround). 5-axis IBIS (4.5 stops). 117 phase-detect AF + 25 contrast AF. ISO 100-25600. Single SD slot. Battery: NP-FW50 (350 shots — shorter life than newer models). Best for: budget photo with stabilization, light video work. Older AF system — not ideal for fast action or pro video.',
  },
  {
    item_name: 'Fujifilm X100 VI',
    specs: 'APS-C 40.2MP X-Trans CMOS 5 HR, X-Processor 5. Fixed 23mm f/2 lens (35mm equivalent). 6.2K/30p and 4K/60p video, F-Log2. 20 film simulation recipes (including Reala Ace). 5-axis IBIS (6 stops). OVF/EVF hybrid viewfinder. Subject-detect AF. 450 shots per charge. Compact retro body. Best for: street photography, travel, social content — the most sought-after compact camera. Fixed lens, NOT interchangeable.',
  },
  {
    item_name: 'BMPCC 6K Pro',
    specs: 'Super 35 6144x3456 sensor, 13 stops dynamic range, dual native ISO 400/3200. Canon EF mount. Records 6K BRAW + ProRes internally to CFast 2.0 or SD. Built-in 5" 1500-nit HDR touchscreen, 2x mini XLR audio. Built-in ND filters (2/4/6 stops). LP-E6NH powered (5x included, drains fast — V-mount recommended). Best for: cinematic narrative with Blackmagic color science and DaVinci Resolve workflow.',
  },
  {
    item_name: 'BMPCC 6K Full Frame',
    specs: 'Full-frame 6048x4032 sensor, 13 stops dynamic range, dual native ISO 400/3200. Native L-mount (Canon EF via included adapter). Records 6K BRAW up to 36fps full-sensor, 120fps windowed. Built-in 5" HDR touchscreen, 2x mini XLR. LP-E6NH powered (5x included). CFexpress media. Bluetooth camera control. Best for: full-frame cinematic shooting with L-mount glass ecosystem and Blackmagic RAW workflow.',
  },
  {
    item_name: 'DJI Osmo Action Pro 5',
    specs: '1/1.3" CMOS sensor, 4K120p, 40MP photos. 155deg ultra-wide lens. RockSteady 3.0 + HorizonSteady stabilization. 10m waterproof (no case). Dual touchscreens (front + rear). Magnetic quick-mount system. 2160mAh battery (~2.5hr at 4K30). USB-C, microSD. D-Log M for color grading. -20°C cold resistant. Best for: action/sports POV, BTS footage, underwater, vlog. Magnetic mount is faster than GoPro clip system.',
  },
  {
    item_name: 'GoPro 12 Hero',
    specs: '1/1.9" CMOS, 5.3K60 / 4K120 / 2.7K240 video, 27MP photos. HyperSmooth 6.0 stabilization + 360° Horizon Lock. 10m waterproof. Max Lens Mod 2.0 support (177° FOV). HDR video + photo. Bluetooth + Wi-Fi. 1720mAh Enduro battery (~1.5hr at 5.3K). GP-Log for color grading. Best for: action sports, POV, timelapse, underwater — the industry standard action camera with widest accessory ecosystem.',
  },

  // ──────────────────────────────────────────
  // DRONES
  // ──────────────────────────────────────────
  {
    item_name: 'DJI Mavic 3 Pro',
    specs: 'Tri-camera system: 4/3 Hasselblad main (20MP, f/2.8-11) + 70mm tele (12MP, f/2.8) + 166mm supertele (12MP, f/3.4). 5.1K/50p + 4K/120p on main cam. 46min flight time, 15km video range (O3+). APAS 5.0 omnidirectional obstacle avoidance. D-Log M / HLG / 10-bit. Fly More Combo: 3x batteries + charging hub + ND filters. Best for: pro aerial cinematography — triple focal lengths without swapping drones.',
  },
  {
    item_name: 'DJI Mini 4 Pro',
    specs: 'Under 249g (no registration needed in most cases). 1/1.3" CMOS, 4K100 / 4K60 HDR, 48MP photos. Tri-directional obstacle sensing (forward/backward/downward). 34min flight time, 20km range (O4). D-Log M, 10-bit, SlowMotion 4K. ActiveTrack 360° subject tracking. Vertical shooting for social content. Best for: travel, real estate, social content — pro features at sub-250g weight. Lightweight enough to fly in more restricted areas.',
  },

  // ──────────────────────────────────────────
  // SONY LENSES
  // ──────────────────────────────────────────
  {
    item_name: 'Sony GM 24-70mm f2.8',
    specs: 'G Master II (SEL2470GM2). 18 elements/14 groups, XD Linear motors x4. 695g (30% lighter than Mk I). Close focus 0.21m wide, 0.3m tele. Nano AR Coating II, 11-blade circular aperture. Dust/moisture sealed. Best-in-class sharpness corner-to-corner even wide open. Filter: 82mm. Best for: the desert-island zoom — covers portrait, reportage, product, event. The benchmark standard zoom for Sony E-mount.',
  },
  {
    item_name: 'Sony GM 16-35mm f2.8',
    specs: 'G Master II (SEL1635GM2). 15 elements/10 groups, XD Linear motors x2. 547g (lightweight for f/2.8 ultra-wide). Close focus 0.22m at 16mm. Nano AR Coating II, 11-blade aperture. Dust/moisture sealed. Minimal distortion and vignetting even at 16mm. Filter: 82mm. Best for: landscapes, architecture, interiors, real estate, event wide-shots. Pairs with 24-70 for a complete 2-lens kit.',
  },
  {
    item_name: 'Sony GM 70-200mm f2.8',
    specs: 'G Master II (SEL70200GM2). 17 elements/14 groups, XD Linear motors x4. 1045g (significantly lighter than Mk I). Close focus 0.4m-0.82m (0.2x magnification). Nano AR Coating II, 11-blade aperture. Teleconverter compatible (1.4x/2x). Dust/moisture sealed. Best for: sports, events, portraits, wildlife, ceremonies — the premier telephoto zoom. Tack-sharp across frame at f/2.8.',
  },
  {
    item_name: 'Sony GM 90mm f2.8',
    specs: 'G Master Macro (SEL90M28G). 15 elements/11 groups. 1:1 macro reproduction ratio. Nano AR Coating, 9-blade circular aperture. ED + Super ED elements for chromatic aberration control. Built-in optical stabilization (OSS). Focus limiter switch. 602g. Filter: 67mm. Best for: macro photography (jewelry, food, product), portraiture with beautiful bokeh, close-up detail shots. True 1:1 life-size magnification.',
  },
  {
    item_name: 'Sony 28-70mm',
    specs: 'Kit zoom (SEL2870). 9 elements/8 groups. f/3.5-5.6 variable aperture. 295g (ultra-light). Close focus 0.3m-0.45m. No OSS (relies on camera IBIS). 7-blade aperture. Filter: 55mm. Budget glass — soft corners wide open, improves stopped down. Best for: casual shooting, travel light. Significantly outperformed by GM 24-70mm in sharpness, AF speed, and build quality.',
  },
  {
    item_name: 'Sony 11mm f2.8 fisheye',
    specs: 'APS-C ultrawide fisheye (SEL11F18). 12 elements/11 groups. 181° diagonal angle of view on APS-C. 16.5mm equivalent. 157g (tiny). Close focus 0.12m. No filter thread (bulbous front). 7-blade aperture. Linear motor AF. Best for: creative distortion, skateboard/action POV, 360° look, VR. On full frame: extreme circular fisheye. Most creative/specialty lens in the lineup.',
  },

  // ──────────────────────────────────────────
  // CANON LENSES
  // ──────────────────────────────────────────
  {
    item_name: 'Canon EF 24-105mm f4',
    specs: 'L-series II (EF 24-105mm f/4L IS II USM). 17 elements/12 groups with ASC coating. 4-stop Image Stabilization. f/4 constant aperture. Ring USM AF. 10-blade aperture. Dust/moisture sealed. 795g. Filter: 77mm. Versatile range covering wide to short tele. Best for: BMPCC + Canon EF setup — great all-purpose cinema/doc lens. Slightly softer than modern mirrorless designs but very versatile range.',
  },
  {
    item_name: 'Canon EF 16-35mm f2.8',
    specs: 'L-series III (EF 16-35mm f/2.8L III USM). 16 elements/11 groups, 2x large aspherical + 1x ground asph + 2x UD. SWC + ASC coatings for extreme flare resistance. 9-blade aperture. Ring USM. Dust/moisture sealed. 790g. Filter: 82mm. Best for: wide-angle work on BMPCC 6K Pro — landscapes, interiors, establishing shots. Excellent edge-to-edge sharpness even at f/2.8.',
  },

  // ──────────────────────────────────────────
  // ANAMORPHIC LENSES — GREAT JOY
  // ──────────────────────────────────────────
  {
    item_name: 'Anamorphic Great Joy lens 35mm',
    specs: '1.8x squeeze, T2.9 max aperture. 18 elements/14 groups, 11 aperture blades. BLUE FLARE variant — produces subtle blue horizontal streaks with direct light sources, more restrained than the 50mm. Slightly warm/neutral color tone. Oval bokeh. Covers 33x24mm full-frame. 1.19kg. Min focus 70cm. NATIVE MOUNT: Canon EF — mounts directly on EF cameras (BMPCC 6K Pro). For Sony E-mount (FX3/A7) use EF-to-E adapter. Best for: cinematic widescreen look with classic blue anamorphic character. The 35mm flare is more subtle/controlled than the 50mm — less streak, cleaner highlight handling.',
  },
  {
    item_name: 'Anamorphic Great Joy lens 50mm',
    specs: '1.8x squeeze, T2.9 max aperture. 11 aperture blades. BLUE FLARE variant — produces beautiful soft blue horizontal streaks, the most pronounced anamorphic flare of the set. Oval bokeh with soft fall-off. Covers full-frame. Min focus 85cm. ~1.1kg. NATIVE MOUNT: Canon EF — for Sony E-mount use EF-to-E adapter. Stepless aperture T2.9-T22. Best for: the hero anamorphic lens — strongest blue flare character, ideal for music videos, narrative, fashion. 50mm is the most "classic anamorphic" of the three.',
  },
  {
    item_name: 'Anamorphic Great Joy lens 85mm',
    specs: '1.8x squeeze, T2.9 max aperture. 11 aperture blades. BLUE FLARE variant — blue horizontal streaks similar to the 50mm. Beautiful compressed oval bokeh for portrait work. Covers full-frame. Min focus ~100cm. ~1.2kg. NATIVE MOUNT: Canon EF — for Sony E-mount use EF-to-E adapter. Stepless aperture T2.9-T22. Best for: anamorphic portrait/close-up work, interview shots with cinematic scope. Tightest framing + strongest background separation of the set.',
  },

  // ──────────────────────────────────────────
  // ANAMORPHIC LENSES — BLAZAR REMUS
  // ──────────────────────────────────────────
  {
    item_name: 'Anamorphic Blazar Remus 33mm',
    specs: '1.5x squeeze, T1.6 max aperture (fastest in its class). 15 elements/11 groups, 11 aperture blades. AMBER FLARE — warm golden horizontal streaks. 0.9m min focus. Covers S35+ (up to 33.5mm image circle). 780g compact body. Common 77mm front. NATIVE MOUNT: PL — requires PL-to-E adapter for Sony (FX3/A7), PL-to-EF for Canon/BMPCC, PL-to-RF for Canon RF. Best for: low-light anamorphic + warm cinematic character. 1.5x desqueeze = wider FOV than 1.8x at same focal length. T1.6 is exceptional for anamorphic.',
  },
  {
    item_name: 'Anamorphic Blazar Remus 45mm',
    specs: '1.5x squeeze, T1.6 max aperture. 15 elements/11 groups, 11 aperture blades. AMBER FLARE — warm golden horizontal streaks matching the set. 0.75m min focus (closest in the set). 33.5mm image circle. 750g. Common 77mm front. NATIVE MOUNT: PL — requires PL adapter for other mounts. Best for: standard/interview anamorphic with exceptional low-light capability. The everyday workhorse of the Remus set.',
  },
  {
    item_name: 'Anamorphic Blazar Remus 65mm',
    specs: '1.5x squeeze, T1.6 max aperture. 15 elements/11 groups, 11 aperture blades. AMBER FLARE. 0.9m min focus. 33.5mm image circle. ~800g. Common 77mm front. NATIVE MOUNT: PL — requires PL adapter for other mounts. Best for: portrait and medium-tele anamorphic with shallow DOF. Pairs with 33mm for a versatile 2-lens anamorphic kit.',
  },
  {
    item_name: 'Anamorphic Blazar Remus 100mm',
    specs: '1.5x squeeze, T2.8 max aperture (slower than rest of set). 11 aperture blades. AMBER FLARE. 1.1m min focus. 33.5mm image circle. ~900g. Common 77mm front. NATIVE MOUNT: PL — requires PL adapter for other mounts. Best for: tight anamorphic shots, compressed backgrounds, interviews from distance. The telephoto of the set — pairs with 33+65 for a complete 3-lens anamorphic package.',
  },

  // ──────────────────────────────────────────
  // AUDIO
  // ──────────────────────────────────────────
  {
    item_name: 'Rode Wireless Mic Pro set',
    specs: 'Dual-channel 2.4GHz wireless, 32-bit float on-board recording (40hrs per TX on 32GB internal). Series IV transmission, 128-bit encryption, 260m range. Timecode sync, 2x clip-on TX with built-in mics, smart charge case. 48kHz/32-bit float means zero clipping — impossible to distort. Best for: pro interview/film audio with never-clip safety recording.',
  },
  {
    item_name: 'Audio boom mic Sennheiser',
    specs: 'Sennheiser MKE 600 supercardioid/lobar shotgun. 40Hz-20kHz, max 132dB SPL. Runs on 48V phantom or single AA (150hrs). Switchable low-cut filter, very low self-noise. XLR output, includes foam windshield + shock mount. 10" length. Best for: boom-mounted dialogue capture — industry standard mid-range shotgun for narrative and documentary.',
  },
  {
    item_name: 'DJI Mic 2 wireless',
    specs: 'Dual-channel 2.4GHz, 32-bit float internal recording, 8GB per TX (14hrs). Intelligent noise cancelling, 250m range, 6hr TX battery (18hr with charge case). OLED touchscreen receiver. Bluetooth + USB-C/Lightning connect. Best for: run-and-gun interviews, vlog, content creation with 32-bit float safety track.',
  },
  {
    item_name: 'DJI Wireless Mics',
    specs: 'DJI Mic (original). Dual-channel 2.4GHz, 250m range, 8GB per TX (14hrs at 48kHz/24-bit). 5.5hr TX / 5hr RX battery, 15hr with charge case. Mono/Stereo modes, -6dB safety track. Touchscreen receiver. Compatible with cameras, phones, computers. Best for: budget wireless audio — 24-bit only (no 32-bit float like Mic 2), no noise cancelling.',
  },
  {
    item_name: 'Rode Video Mic Go',
    specs: 'Ultra-lightweight (73g) on-camera supercardioid condenser. Powered directly by camera mic input — no batteries needed. Integrated Rycote Lyre shock mount. 3.5mm TRS output. No controls — pure plug-and-play. Best for: quick on-camera audio upgrade for DSLR/mirrorless. Entry-level but significant step up from built-in mics.',
  },
  {
    item_name: 'Rode Video Mic Pro Plus',
    specs: 'Premium on-camera supercardioid, 20Hz-20kHz, 134dB max SPL, 120dB dynamic range. 3-stage high-pass (flat/75Hz/150Hz), 3-stage gain (+20dB boost + safety channel). LB-1 Li-ion rechargeable (100hrs). Rycote Lyre mount, auto power on/off with camera. Best for: serious on-camera audio for DSLR/mirrorless filmmaking.',
  },
  {
    item_name: 'JBL wireless microphones',
    specs: 'JBL PartyBox Mic — wireless 2.4GHz karaoke/PA mic pair via dongle, 30m range. Cardioid pattern, 20hr battery. Compatible with JBL PartyBox speakers via 6.35mm dongle. Best for: events, karaoke, presentations. NOTE: designed for PA speakers, NOT for film production audio recording.',
  },

  // ──────────────────────────────────────────
  // LIGHTING
  // ──────────────────────────────────────────
  {
    item_name: 'Nanlite Forza 300',
    specs: '300W DAYLIGHT ONLY (5600K fixed — NOT bi-color) COB LED monolight, 29,440 lumens, up to 108,679 lux @1m with optional Fresnel. CRI 98 / TLCI 95. Bowens mount. 0-100% dimming, DMX. Built-in effects (lightning, TV, fire). AC-powered, 5.5 lbs. Comparable to 1000W tungsten. Best for: key/fill light on film sets, interviews, product shoots. For bi-color use Nanlite 500B instead.',
  },
  {
    item_name: 'Nanlite 500B',
    specs: 'Forza 500B II — 580W bi-color COB LED, 2700-6500K, up to 67,320 lux @1m. CRI 96 / TLCI 97, green-magenta shift +/-80. Bowens mount, 0-100% dimming (0.1% steps). DMX/RDM, Bluetooth, 2.4GHz app control. AC or V-mount battery. Best for: high-output bi-color key light for film/commercial — massive output with full warm-to-cool range.',
  },
  {
    item_name: 'Nanlite Pavotube 30x II',
    specs: '4ft RGBWW pixel tube, 2700-12000K + full RGB. 746 lux @1m (5600K). CRI 97 / TLCI 98. 15 practical effects + 10 pixel-based effects (chase, rainbow, scroll). 1.5hr internal battery at full. DMX + app control. T12 compatible mount. Best for: creative RGB accents, practical set lighting, music videos, atmospheric effects.',
  },
  {
    item_name: 'LED light panels RGB',
    specs: 'GVM 800D — 40W bi-color + RGB LED panel, 3200-5600K + full RGB (168 white + 84 RGB beads). 5000 lux @0.5m, CRI 97+. 120° beam, barndoors included. App control, 0-100% dimming. NP-F or AC power. 10.6x10.3" panel. Best for: budget studio/YouTube panel with color effects — good entry-level, limited output for larger sets.',
  },
  {
    item_name: 'Ambitful RGB light tubes 2x set',
    specs: 'Ambitful A2 — 11" compact RGB LED tube wand, 2500-8500K + HSI (36,000 colors). CRI 95 / TLCI 97. 2500mAh internal battery (60min at full), USB-C PD charge. 29 built-in effects. Magnetic mount on 3 sides + 1/4"-20. Bluetooth app. 0.55 lbs each. Best for: portable accent/fill, creative RGB effects, BTS content.',
  },
  {
    item_name: 'Softbox 85cm',
    specs: '85cm (33") collapsible softbox, octagonal/rectangular. Bowens mount (universal). Creates soft, even light by diffusing any compatible strobe or LED monolight. Inner + outer diffusion layers. Best for: portrait, interview, and product lighting. Pairs with Forza 300/500B. Essential modifier — controls spill and softens shadows.',
  },
  {
    item_name: 'Camera flash',
    specs: 'Yongnuo YN560 IV manual speedlight. GN58 @ISO100/105mm. 1/1 to 1/128 power (1/3 EV). Built-in 2.4GHz TX+RX (328ft range). Zoom 24-105mm, tilt -7 to 90°, rotation 270°. 4xAA, ~3s recycle. Manual only (no TTL). Best for: budget off-camera flash setups, strobist photography. Universal hot shoe.',
  },
  {
    item_name: '5-in-1 reflector panel',
    specs: '5 interchangeable surfaces: silver (high-contrast fill), gold (warm fill), white (soft fill), black (negative fill/flag), translucent (overhead diffusion). 42" diameter, folds to 1/3 size. Best for: outdoor portrait fill, interview lighting, bouncing/flagging light. Essential no-power lighting tool.',
  },

  // ──────────────────────────────────────────
  // SMOKE/HAZE
  // ──────────────────────────────────────────
  {
    item_name: 'Smoke machine fogger',
    specs: '400-500W mains-powered fog machine with wireless remote. 2000-3000 CFM output. 3-5 min warm-up, 20-37s burst cycles, 30s reheat. 0.5L tank, water-based fluid. Creates thick fog clouds (NOT fine haze). Best for: atmospheric fog effects, events, stage. Can trigger fire alarms. For cinematic haze, use Smoke Ninja instead.',
  },
  {
    item_name: 'Smoke Ninja',
    specs: 'PMI SmokeNINJA — pocket-sized battery-powered hazer, 14cm tall. 3 modes: fog, steam, dry ice. 60-second burst fills 500 sq ft. 45min total per charge (USB-C). 0.5mL/min of proprietary liquid. Odorless, actor-safe. Best for: portable atmospheric haze on location without mains power. Limited output vs Pro.',
  },
  {
    item_name: 'Smoke Ninja Pro hazer',
    specs: 'PMI SmokeNINJA PRO — upgraded battery-powered hazer. 3x output of original, 3-min continuous burst, fills 1000-2000 sq ft. 3x faster recovery. Bluetooth + USB-C control. Replaceable battery, 1/4"-20 + magnetic mount. Includes precision nozzles, 100mL fluid (200min of use). Best for: professional cinematic haze on location and studio. The portable hazer standard for indie/commercial film.',
  },
  {
    item_name: 'Cinebloom filter mist',
    specs: 'Moment Cinebloom 20% diffusion filter, 82mm thread. NanoBlack particulates fused between Japanese optical glass. Blooms highlights, softens skin/digital sharpness. 20% = moderate visible glow, especially with direct light sources. Thin frame, stackable with ND/VND. Best for: cinematic halation and organic softness in-camera. The 20% is noticeably dreamier than 10%.',
  },

  // ──────────────────────────────────────────
  // MONITORS & TRANSMITTERS
  // ──────────────────────────────────────────
  {
    item_name: 'Atomos Ninja V',
    specs: '5.2" 1920x1080 HDR touchscreen, 1000 nits. Records up to 4Kp60 10-bit via HDMI 2.0 to AtomX SSD. ProRes, ProRes RAW, DNxHR, H.265 codecs. 10+ stops HDR display. Tools: focus peaking, false color, zebras, waveform, LUTs. 320g aluminum. NP-F powered. Best for: external recording bypassing camera compression + accurate on-set monitoring.',
  },
  {
    item_name: 'Hollyland Mars 4K transmitter',
    specs: '4K30 wireless video TX/RX set via HDMI + 1080p via SDI. 450ft (150m) range, 66ms latency. 5GHz with smart channel scanning. Supports 2 receivers + 4 mobile app monitors. HDMI + SDI I/O on both TX/RX. NP-F or USB-C power. Best for: wireless director/client monitoring on set.',
  },
  {
    item_name: 'Hollyland Pyro S transmitter',
    specs: '4Kp30 HDMI + 1080p60 SDI wireless video set. 1300ft (400m) range, 50ms latency. Auto Dual-Band (2.4GHz + 5GHz). Up to 4 receivers simultaneously. UVC output for direct computer streaming. HDMI + SDI I/O. Best for: long-range wireless video for multi-monitor setups and live streaming. Major range upgrade over Mars 4K.',
  },
  {
    item_name: 'Hollyland 7-inch monitor',
    specs: 'Hollyland Pyro 7 — 7" 1920x1200 touch wireless transceiver monitor, 1500 nits. 2.4/5GHz dual-band, 1300ft range, 60ms latency. HDMI + SDI I/O. Records MP4 to SD card. Waveform, vectorscope, LUT, false color. RTMP/RTSP streaming. Best for: wireless director monitor — monitoring + transmission + recording in one unit.',
  },

  // ──────────────────────────────────────────
  // STABILIZATION & MOTION
  // ──────────────────────────────────────────
  {
    item_name: 'DJI RS3 Pro gimbal',
    specs: '3-axis gimbal, 4.5kg payload, 1.5kg body (with grip). Carbon fiber arms. 1.8" OLED touchscreen. 3rd-gen SuperSmooth stabilization. Automated axis locks. LiDAR focusing support. Bluetooth shutter. 12hr battery. Best for: cinema cameras + heavy lens combos (FX3 + cinema lens, BMPCC + cage). Pro-grade handheld stabilization.',
  },
  {
    item_name: 'Motorized slider',
    specs: 'Neewer 100cm (39.4") carbon fiber motorized slider. 5kg horizontal / 2.5kg at 45°. App + 2.4GHz remote (8m range). Video, timelapse, 120° panoramic modes. NP-F550 or USB-C power. 4 balanced roller bearings. 5.9 lbs. Best for: smooth motorized tracking shots, timelapses, product videos. Budget motorized option with wireless control.',
  },

  // ──────────────────────────────────────────
  // SUPPORT
  // ──────────────────────────────────────────
  {
    item_name: 'Small rig tripod',
    specs: 'SmallRig AP-01 lightweight aluminum travel tripod, 1.09kg, 15kg load. 4-section legs, non-center-column. Max 55", folded 15-20". Arca-type QR plate, 1/4" + 3/8" top threads. 3x 1/4" accessory holes on leg joints (monitor, mic, TX). Hidden spiked feet. Best for: lightweight field tripod for mirrorless/small cinema — impressive 15kg payload for 1kg weight.',
  },
  {
    item_name: 'Sirui tripod',
    specs: 'Sirui AM-25S aluminum video tripod with fluid head, 4.0kg, 10kg payload. 75mm bowl mount, 3-section legs, 91.6-190cm height. 360° pan, -75 to +90° tilt with adjustable fluid damping. Double-tube legs. Best for: dedicated video tripod — fluid head provides smooth pan/tilt for interviews, doc, and talking heads.',
  },
  {
    item_name: 'C-stand',
    specs: 'Chrome steel century stand, 40" base extending to ~10.5ft. Includes grip head and gobo arm. Nested leg design for tight grouping. 1-1/8" receiver. 20-22 lbs load capacity. Heavy steel base (15-20 lbs) for stability. Best for: positioning lights, flags, diffusion, bounce, and grip equipment. The backbone of professional lighting setups.',
  },
  {
    item_name: 'Tilta shoulder rig',
    specs: 'Tilta TA-LSR-B foldable lightweight shoulder rig, 3.5kg. Dual Manfrotto + Arca-type QR plate. Dual ARRI-standard rosette handgrips, 360° rotating bridge. 15mm LWS rod mount, NATO rail, multiple 1/4"-20 threads. Includes shoulder pad + case. ~15 lbs max. Best for: handheld run-and-gun with cinema cameras (FX3, BMPCC). Distributes weight to shoulder for extended takes.',
  },
  {
    item_name: 'Monopod arm support',
    specs: 'Standard aluminum telescoping monopod, 4-5 sections, extends to ~65". 1/4"-20 top mount. Twist-lock leg sections. ~1 lb, 10-15 lb load. Best for: telephoto lens stabilization, quick support for events/sports, video panning with fluid base. Faster to deploy than tripod.',
  },

  // ──────────────────────────────────────────
  // POWER & BATTERIES
  // ──────────────────────────────────────────
  {
    item_name: 'V-mount 95mAh',
    specs: '14.8V / 6600mAh (95Wh) V-mount lithium-ion. D-Tap + USB outputs. 4-stage LED gauge. AIRLINE SAFE (<100Wh carry-on). Powers cinema cameras 3-5hrs, LED panels 6-8hrs. ~1.5 lbs. Best for: powering cinema cameras (BMPCC, FX3), monitors, and LED lights on location. The smaller/lighter V-mount option.',
  },
  {
    item_name: 'V-mount 150mAh',
    specs: '14.4V / 10,400mAh (150Wh) V-mount lithium-ion. D-Tap + USB-C + USB-A outputs. Powers cameras 5-8hrs, LED panels 10-12hrs. ~1.5 lbs. NOT airline carry-on safe (>100Wh, needs airline approval, max 2 per passenger). Best for: extended shoots, powering Forza 500B on location. Maximum V-mount runtime.',
  },
  {
    item_name: 'Sony NPF 970 batteries 2x sets',
    specs: 'Sony NP-F970 — 7.2V / 6600mAh / 47.4Wh L-series lithium-ion. InfoLITHIUM chip for remaining time display. 225g. Powers monitors (Atomos, Hollyland), LED panels (GVM 800D), wireless video TX, audio recorders. Best for: the universal film world battery — always have spares. Powers everything except cameras.',
  },
  {
    item_name: 'DJI gimbal battery',
    specs: 'DJI RS BG30 grip battery for RS3 Pro gimbal. Extends runtime significantly beyond the built-in battery. Provides additional grip surface for two-handed operation. Hot-swappable for uninterrupted use. Best for: all-day gimbal shoots where built-in battery alone is insufficient.',
  },
  {
    item_name: 'Anker Power Station F2000',
    specs: 'Anker SOLIX F2000 (PowerHouse 767). 2048Wh LiFePO4, 2400W AC output (3600W surge). 4 AC + 3 USB-C (100W) + 2 USB-A + 2 car + RV port. 0-80% in 1.4hr charge. 3000 cycle lifespan (~10 years). Expandable to 4096Wh. Wheels + retractable handle. Best for: powering entire lighting setups off-grid — multiple Forza units, monitors, charging stations for full-day location shoots.',
  },

  // ──────────────────────────────────────────
  // MOUNT ADAPTERS
  // ──────────────────────────────────────────
  {
    item_name: 'PL to Sony E mount',
    specs: 'Adapts ARRI PL cinema lenses to Sony E-mount (FX3, A7S III, etc.). Manual focus/iris only. PL 52mm flange → E 18mm flange = ample clearance. Infinity focus maintained. Best for: using cinema PL glass (Cooke, ARRI, Zeiss) on Sony cinema/mirrorless bodies.',
  },
  {
    item_name: 'PL to EF mount',
    specs: 'Adapts PL cinema lenses to Canon EF-mount. PL 52mm → EF 44mm = only 8mm clearance — check lens rear element clearance before use, not universal. Manual only. Best for: mounting select PL cinema lenses on Canon bodies or BMPCC 6K Pro.',
  },
  {
    item_name: 'PL to RF mount',
    specs: 'Adapts PL cinema lenses to Canon RF-mount (C70, R5, R5C, etc.). Shim-adjustable back focus on most models. Manual focus/iris. RF 20mm flange = wider PL compatibility than EF adapter. Best for: PL cinema glass on Canon RF cinema cameras.',
  },
  {
    item_name: 'PL to L mount',
    specs: 'Adapts PL cinema lenses to L-mount (Panasonic S-series, Sigma fp, BMPCC 6K Full Frame). Manual only. Some models offer shim-adjustable back focus. L 20mm flange = good clearance. Best for: PL cinema glass on BMPCC 6K Full Frame or Panasonic cinema bodies.',
  },

  // ──────────────────────────────────────────
  // ACCESSORIES
  // ──────────────────────────────────────────
  {
    item_name: 'Tilta Nucleus Nano 2 follow focus',
    specs: 'Wireless follow focus, 2.4GHz Wi-Fi + Bluetooth, 300ft range. 1.6" touchscreen handwheel, 20hr battery (USB-C PD). 5x more torque than original Nano with auto-adjustable torque + cooling. 0.8 MOD cinema gear + photo lens adapter rings. Controls focus/iris/zoom. Bluetooth camera control (BMPCC). Best for: precise wireless focus pulling on cinema + photo lenses.',
  },
  {
    item_name: 'ND filter',
    specs: 'Variable ND 82mm (ND2-400, 1-8.6 stops). Rotate front ring to dial density. Multi-coated optical glass, minimal color cast. Eliminates need for multiple fixed NDs. Cross-pattern artifacts near max density — stay below ND256 for clean results. Best for: controlling exposure in bright conditions, enabling wide apertures outdoors. Essential for cinematic shallow DOF in daylight.',
  },
  {
    item_name: '256GB card',
    specs: '256GB SDXC card. UHS-II V60/V90 rated (up to 300MB/s read). Compatible with virtually all cameras, recorders, drones, monitors. V30 min for 4K, V60 for high-bitrate 4K, V90 for 8K/RAW. Best for: universal backup/secondary storage. Ensure UHS-II rating for serious video.',
  },
  {
    item_name: 'CF Express Type A card',
    specs: 'Sony CFexpress Type A — smallest CFexpress format (20x28mm). PCIe single-lane, ~800MB/s read / ~700MB/s write. Essential for Sony cameras with Type A slot (FX3, A7S III, A7R V, A1). Supports 4K120, 8K recording. Best for: high-bitrate recording on Sony Alpha/FX cameras. Significantly faster than SD.',
  },
  {
    item_name: 'Suction cups',
    specs: 'Heavy-duty vacuum suction cup car mount for vehicle shots. 1/4"-20 mounting, articulating arm. Single cup holds ~7 lbs. Attaches to any smooth non-porous surface (car hood, door, roof, glass). Best for: car POV, driving footage, exterior vehicle tracking. ALWAYS use safety straps as backup.',
  },
  {
    item_name: 'JBL Club 120 speaker',
    specs: 'JBL Club 120 — 160W portable Bluetooth party speaker, dual 5.25" woofers + 2.25" tweeters. 12hr battery, IPX4 splash-proof. Dual mic + guitar 6.35mm inputs. AI Sound Boost, built-in lightshow. JBL Auracast multi-speaker linking. Best for: on-set music playback, wrap parties, events. Consumer-grade party speaker, not a studio monitor.',
  },
  {
    item_name: 'DJ RX3 Pioneer controller',
    specs: 'Pioneer XDJ-RX3 — 2-channel all-in-one DJ system. 10.1" touchscreen (largest on any Pioneer all-in-one). Club-grade 24-bit audio, 110dB SNR, <0.003% distortion. 14 Beat FX (Echo, Ping Pong, Filter) + 6 Sound Color FX (Space, Crush). 2x phono/line inputs, 2x mic (combo XLR/6.35mm), 3.5mm aux. Dual USB-A for thumb drives + USB-B for rekordbox/Serato. 72.9x11.8x47cm, 9.3kg. Works standalone (no laptop needed) or with rekordbox/Serato DJ Pro. Best for: house parties, events, weddings — professional standalone DJ setup without needing separate mixer/CDJs.',
  },
];

// ──────────────────────────────────────────
// Helper functions
// ──────────────────────────────────────────

/** Get specs for a specific item by name */
export function getItemSpecs(itemName: string): string | undefined {
  const lower = itemName.toLowerCase();
  const entry = ITEM_SPECS.find(s => s.item_name.toLowerCase() === lower);
  return entry?.specs;
}

/**
 * Format specs for AI context — only for mentioned items (contextual loading).
 * Returns empty string if no matches, keeping token budget lean.
 */
export function formatSpecsForAI(itemNames: string[]): string {
  const parts: string[] = [];
  for (const name of itemNames) {
    const specs = getItemSpecs(name);
    if (specs) {
      parts.push(`${name}: ${specs}`);
    }
  }
  if (parts.length === 0) return '';
  return `=== PRODUCT SPECS (use for answering usage questions & recommendations) ===\n${parts.join('\n\n')}`;
}

/**
 * Extract a short spec highlight (first sentence or "Best for" line) for upsell context.
 * Keeps token budget minimal — just enough for the AI to sell it.
 */
export function getSpecHighlight(itemName: string): string | undefined {
  const specs = getItemSpecs(itemName);
  if (!specs) return undefined;
  const bestFor = specs.match(/Best for:\s*([^.]+\.)/);
  if (bestFor) return bestFor[1].trim();
  // Fallback: first sentence
  const first = specs.match(/^([^.]+\.)/);
  return first ? first[1].trim() : undefined;
}

/**
 * Find inventory items whose specs match renter-stated feature needs.
 * Scans ALL specs but only returns items not already in the renter's list.
 * Used by upsell logic to make feature-aware recommendations.
 */
export function findItemsByFeature(
  featureKeywords: string[],
  excludeItems: string[] = [],
): { item_name: string; matchedFeature: string; highlight: string }[] {
  if (featureKeywords.length === 0) return [];

  const excludeLower = new Set(excludeItems.map(i => i.toLowerCase()));
  const results: { item_name: string; matchedFeature: string; highlight: string; score: number }[] = [];

  for (const entry of ITEM_SPECS) {
    if (excludeLower.has(entry.item_name.toLowerCase())) continue;

    const specsLower = entry.specs.toLowerCase();
    for (const keyword of featureKeywords) {
      if (specsLower.includes(keyword.toLowerCase())) {
        const highlight = getSpecHighlight(entry.item_name) || '';
        results.push({
          item_name: entry.item_name,
          matchedFeature: keyword,
          highlight,
          score: featureKeywords.filter(k => specsLower.includes(k.toLowerCase())).length,
        });
        break; // One match per item is enough
      }
    }
  }

  // Sort by number of feature matches (most relevant first)
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ item_name, matchedFeature, highlight }) => ({ item_name, matchedFeature, highlight }));
}

// Common feature keywords renters mention mapped to search terms
export const FEATURE_KEYWORD_MAP: Record<string, string[]> = {
  // Video capabilities
  '4k': ['4K'], '4k120': ['4K120', '4K/120'], '6k': ['6K'], '8k': ['8K'],
  'slow motion': ['120fps', '240fps', 'slow-motion', 'slow motion'],
  'slow mo': ['120fps', '240fps', 'slow-motion'],
  'high frame rate': ['120fps', '240fps'],
  // Audio
  'wireless audio': ['wireless', '2.4GHz'], 'clean audio': ['32-bit float', 'wireless'],
  '32 bit': ['32-bit float'], '32-bit': ['32-bit float'],
  // Stabilization
  'stabilization': ['IBIS', 'stabilization', 'gimbal', 'SteadyShot'],
  'handheld': ['IBIS', 'shoulder rig', 'stabilization'],
  'smooth footage': ['gimbal', 'stabilization', 'slider'],
  // Low light
  'low light': ['dual native ISO', 'f/1.', 'f1.', 'ISO 12800', 'ISO 800/12800'],
  'dark': ['dual native ISO', 'f/1.', 'ISO 12800'],
  // Anamorphic
  'anamorphic': ['anamorphic', 'squeeze', 'oval bokeh'],
  'cinematic': ['anamorphic', 'S-Cinetone', 'cinema', 'Cinebloom'],
  'flare': ['flare', 'streak'],
  // Specific needs
  'macro': ['macro', '1:1'], 'underwater': ['waterproof', 'waterproof'],
  'aerial': ['drone', 'flight time'], 'drone': ['drone', 'flight'],
  'haze': ['haze', 'fog', 'smoke'], 'fog': ['fog', 'haze', 'smoke'],
  'wireless video': ['wireless video', 'Mars 4K', 'Pyro'],
  'monitoring': ['monitor', 'HDR touchscreen', 'waveform'],
  'follow focus': ['follow focus', 'Nucleus'],
  'diffusion': ['diffusion', 'Cinebloom', 'bloom'],
  'portrait': ['portrait', '85mm', '90mm', 'bokeh'],
};
