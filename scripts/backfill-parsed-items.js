/**
 * One-time backfill script: Parse all rental titles and update parsed_items in DB.
 * Run with: node scripts/backfill-parsed-items.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Manual mapping of every unique rental title to inventory items
// Items MUST exactly match MASTER_INVENTORY keys
const TITLE_MAPPINGS = {
  // --- SD Cards / Accessories ---
  '128gb sd card memory v90 addon': [],

  // --- Non-inventory items ---
  '14mm ultrawide MF Lens Canon Mount ': [],
  'Aputure 600X PRO': [],
  'Aputure Amaran 300c RGB LED Video Light | 300c RGBWW Colour Studio Light + Light Stand + Power Supply (like "Aputure 300d / 300c")': [],
  'Aputure MC Pro RGB Light | Pocket RGBWW LED Mini Panel | Magnetic Pocket Light | USB‑C Rechargeable | (like "Aputure MC" Pocket Light)': [],
  'Blackmagic Pocket Cinema 4k + Speedbooster': [],
  'Bmpcc4k Ready Rig Cinema Full ': [],
  'Cannon 24-70mm rf f2.8 zoom lens ': [],
  'Fujifilm XT 100 Film 4k and Photography Camera Kit': [],
  'Fujifilm x-t5 mirrorless 4k camera Film + 18-55 f2.8-4 x mount lens ': [],
  'Lens wide angle Sony 16-35mm Zeiss F4': [],
  'Lens wide angle Sony 16-35mm Zeiss F4 and more': [],
  'M4/3 to Cannon EF Speedbooster ': [],
  'Monitor 7 inch Atomos Shinobi 2200nits Cinema 4k  ': [],
  'Pioneer XDJ-RX2 DJ Controller | 2-Channel Rekordbox / Serato Pro Deck + DJ Mixer + Standalone USB System (like Pioneer DDJ-1000 / RX3)': [],
  'Sigma 14–24mm f/2.8 DG DN Wide Zoom Lens (Sony E-Mount) | Ultra Wide Angle Full Frame Lens for Video & Photography (like "Sony 12–24mm GM")': [],
  'Slider 100cm carbon fiber smooth roll': [],
  'Sony 12-24mm f/2.8 GM G-Master Ultra-Wide Zoom Lens | Full-Frame E-Mount | GMaster Wide-Angle Zoom | (like "Sony G-Master 12-24mm 2.8")': [],
  'Sony a6600 4k apsc camera + 18-135mm Sony zoom lens ': [],
  'Sony a7 IV 4k mirrorless camera full frame body set Sony a74 a7iv cinema a7 + 128 gb sd card + 3x batteries ': [],
  'Sony a7 IV 4k mirrorless camera full frame body set Sony a74 a7iv cinema a7 + 128 gb sd card + 3x batteries  and more': [],
  'Sony a7 iv 4k mirrorless full frame camera + Zoom lens Sony a7iv a7 4 ': [],
  'Sony a7 iv camera 4k + 70-200mm macro zoom lens Sony g f4 mk II mirrorless full frame': [],
  'Sony a7 iv camera 4k full frame + Sony 24-70 mm G master zoom gm gmaster g-master Lens f2.8 Sony a7 a7iv a74 mirrorless cinema ': [],
  'Sony a7 iv  Sony a7iv a7 4 camera 4k full frame + 24-70 mm g master gm gmaster g-master zoom lens f2.8 + flash': [],
  'Sony a7 iv  Sony a7iv a7 4 camera 4k full frame + 24-70 mm g master gm gmaster g-master zoom lens f2.8 + flash and more': [],
  'Sony a7s iii 4k cinema camera + 24-70 G master lens + Tripod': [],
  'Sony a7s iii + Full Lens set Ultimate mirrorless Camera ': [],
  'Sony a7siii+ gimbal rs2 + mke600+ tubelights ': [],
  'Sony A7s iii + Great Joy 35,50,85mm Anamorphic Cine Lens Set': [],
  'Sony a7siii mirrorless Camera + 24-70 gmaster f2.8 lens': [],
  'Sony a7siii mirrorless Camera / 24-70 lens + dji mic lav Kit': [],
  'Sony A7s iii Mirrorless camera+ Lens + DJI Rs 2 gimbal Combo and more': [],
  'Sony A7 V Camera 4K + 24-70mm GM Lens | Sony a7V / a7 V / a7v / Alpha 7 V / 24-70 GM / G Master / Full-Frame Mirrorless / 4K Video Camera': [],
  'Sony a6600 camera 4k + zhiyun weebill 3 gimbal ': [],
  'Sony g master 14mm f1.8 prime lens ': [],
  'Sony RX ii Digital Pocket camera ': [],
  'Timecode sync box diety TC 1 set like tentacle or Arri': [],
  'Video Transmission transmitter 1km Accsoon wireless ': [],
  'Video Transmission transmitter 1km Accsoon wireless  and more': [],
  'ViewSonic 4K UHD 3500 Lumens Projector + 10m HDMI Cable | Home Cinema, Events, Business Presentations (like "Epson / BenQ Projector") ': [],
  'Wireless Lav Mic 2x Blink 900 pro kit ': [],
  'Zoom H5 Audio Recorder 2x XLR + 6m cable + 32gb sd card ': [],
  'Sony 70-200mm lens f4 OSS II Macro Tele  and more': [],
  'DJI Mavic 4 pro Drone + Fly more set + 512 gb sd card + nd filters': [],
  'RODE NTG 5 Boom mic Shotgun Film Set': [],

  // --- JBL Speakers ---
  '2× JBL PARTYBOX 110 SPEAKERS – BLUETOOTH SPEAKER – PARTY SPEAKER – DJ SPEAKER – PA SYSTEM – LOUD SPEAKER – WIRELESS SPEAKER – EVENT SOUND SYSTEM – MUSIC SPEAKERS': [
    { item: 'JBL Club 120 speaker', qty: 2 }
  ],
  'JBL PARTYBOX 110 SPEAKER – BLUETOOTH SPEAKER – PARTY SPEAKER – DJ SPEAKER – PA SPEAKER – LOUD SPEAKER – WIRELESS SPEAKER – EVENT SOUND SYSTEM – MUSIC SPEAKER – PORTABLE SPEAKER': [
    { item: 'JBL Club 120 speaker', qty: 1 }
  ],
  'JBL PartyBox Club 120 Speaker | Portable Bluetooth Party Speaker + Bass Boost + Stand + Charger (like JBL PartyBox 110 / PartyBox 310 / MACKIE thump ) ': [
    { item: 'JBL Club 120 speaker', qty: 1 }
  ],
  'Party speaker JBL Partybox 110 PA system battery powered bluetooth event wedding dj ': [
    { item: 'JBL Club 120 speaker', qty: 1 }
  ],

  // --- Tripods ---
  '2x smallrig tripod camera heavy duty set Fluid head and handle work with Sony , cannon ': [
    { item: 'Small rig tripod', qty: 2 }
  ],
  '3x Tripod stand heavy duty camera stable fluid head cinema ': [
    { item: 'Small rig tripod', qty: 3 }
  ],
  'Tripod heavy duty fluid Stand smallrig ': [
    { item: 'Small rig tripod', qty: 1 }
  ],
  'Tripod heavy duty fluid Stand smallrig  and more': [
    { item: 'Small rig tripod', qty: 1 }
  ],
  'Tripod Sirui stand with fluid head heavy duty 10kg capacity ': [
    { item: 'Sirui tripod', qty: 1 }
  ],

  // --- Sony FX3 combos ---
  '2x Sony FX3 + 2x 24-70mm Cinema Camera Set': [
    { item: 'Sony FX3', qty: 2 },
    { item: 'Sony GM 24-70mm f2.8', qty: 2 }
  ],
  '2x Sony FX3 + 2x 24-70mm Cinema Camera Set and more': [
    { item: 'Sony FX3', qty: 2 },
    { item: 'Sony GM 24-70mm f2.8', qty: 2 }
  ],
  '2x Sony fx3 fx 3 full frame camera + 2x tripods small + 2x Sony 24-70 mm zoom lens f2.8 gmaster g-master gm and more': [
    { item: 'Sony FX3', qty: 2 },
    { item: 'Sony GM 24-70mm f2.8', qty: 2 },
    { item: 'Small rig tripod', qty: 2 }
  ],
  '2x Sony FX3 FX 3 full frame mirrorless cinema camera  set': [
    { item: 'Sony FX3', qty: 2 }
  ],
  'SONY FX3 – 2× CAMERA SET – CINEMA CAMERA – FULL FRAME – 4K 120FPS – SONY FX-3 – FX3 BUNDLE – SONY A7S3 LEVEL – VIDEO CAMERA – MIRRORLESS – FILMING KIT – CINEMA RIG – CONTENT CREATION CAMERA – PROFESSIONAL VIDEO Fx 3  and more': [
    { item: 'Sony FX3', qty: 2 }
  ],
  'Sony FX 3 Cinema Camera Full Frame Mirrorless 4k Sony fx3 (same sensor as a7siii a7s iii )': [
    { item: 'Sony FX3', qty: 1 }
  ],
  'Sony FX3 digital cinema camera 4k mirrorless Full frame fx 3 + Sony 28-70mm Zoom Lens Sony FX 3 Mirrorless  camera cinema full frame 4k  fx3 + Sony 28-70mm zoom lens  (same sensor as a7siii a7s iii ) ': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony 28-70mm', qty: 1 }
  ],
  'Sony FX3 Full Production Set 4k cinema mirrorless Full Frame camera fx 3 + 28-70mm zoom lens + Smallrig tripod + Rode wireless pro mics microphones + 2x lav lavelier ': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony 28-70mm', qty: 1 },
    { item: 'Small rig tripod', qty: 1 },
    { item: 'Rode Wireless Mic Pro set', qty: 1 }
  ],
  'Sony FX3 FX-3 Cinema Camera + 28–70mm Zoom Lens | Full Frame 4K Mirrorless Cinema Camera  (Sony FX3 / FX-3 / Cinema Camera / Full Frame / 4K / Mirrorless / 28-70 / Zoom Lens / Sony E-Mount)': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony 28-70mm', qty: 1 }
  ],
  'Sony fx3 fx 3 cinema camera 4k + Sony 24-70 mm f2.8 zoom lens gmaster gm g-master + dji RS 2 gimbal ronin + atomos ninja v monitor recorder': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'DJI RS3 Pro gimbal', qty: 1 },
    { item: 'Atomos Ninja V', qty: 1 }
  ],
  'Sony fx3 fx 3 cinema camera 4k + Sony 24-70 mm f2.8 zoom lens gmaster gm g-master + dji RS 2 gimbal ronin + atomos ninja v monitor recorder and more': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'DJI RS3 Pro gimbal', qty: 1 },
    { item: 'Atomos Ninja V', qty: 1 }
  ],
  'Sony FX3 FX-3 Cinema Camera Interview Set | Full Frame 4K Mirrorless | FX3 / FX 3 / Cinema Camera / Interview Kit / Video Production  (Sony FX3 / FX-3 / Cinema Camera / Full Frame / 4K / Mirrorless / Interview )': [
    { item: 'Sony FX3', qty: 1 }
  ],
  'Sony fx 3 fx3 full frame 4k cinema camera + 24-70 mm f2.8 zoom lens gmaster gm g-master  + tripod + rode shotgun video mic pro plus ': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'Small rig tripod', qty: 1 },
    { item: 'Rode Video Mic Pro Plus', qty: 1 }
  ],
  'Sony fx3 fx 3 full frame camera + 24-70mm zoom lens gm gmaster + 70-200mm zoom f4 + dji rs 2 ronin ': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'Sony GM 70-200mm f2.8', qty: 1 },
    { item: 'DJI RS3 Pro gimbal', qty: 1 }
  ],
  'Sony fx 3 fx3 full frame cinema camera 4k + Sony 70-200 mm f2.8 gmaster g-master gm Tele zoom lens and more': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony GM 70-200mm f2.8', qty: 1 }
  ],
  'Sony FX3 + Gimbal set': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'DJI RS3 Pro gimbal', qty: 1 }
  ],
  'Sony FX3 + Gimbal set and more': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'DJI RS3 Pro gimbal', qty: 1 }
  ],
  'Sony FX 3 Mirrorless  camera cinema full frame 4k  fx3 + Sony 24-70mm gmaster g-master gm zoom lens f2.8 (same sensor as a7siii a7s iii ) ': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 }
  ],
  'Sony FX 3 Mirrorless  camera cinema full frame 4k  fx3 + Sony 24-70mm gmaster g-master gm zoom lens f2.8 (same sensor as a7siii a7s iii )  and more': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 }
  ],
  'Sony FX 3 mirrorless full frame 4k cinema camera fx3 + 24-70mm zoom lens gm g-master g master f2.8 lens + Atomos ninja v 5 1TB SSD recorder pro res ': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'Atomos Ninja V', qty: 1 }
  ],
  'Sony fx3 mirrorless full frame camera + 16-35mm gm gmaster f2.8 g-master zoom wide lens set and more': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'Sony GM 16-35mm f2.8', qty: 1 }
  ],
  'Sony Fx3 4k cinema camera + 2x v mounts + Monitor + 1TB ssd + Mic Pro + G master zoom + Wireless mics Pro and more': [
    { item: 'Sony FX3', qty: 1 },
    { item: 'V-mount 150mAh', qty: 2 },
    { item: 'Atomos Ninja V', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'Rode Wireless Mic Pro set', qty: 1 }
  ],

  // --- Sony A7 III ---
  '3x Sony A7 III 4K Cameras + Lens Set – Multi-Cam Production Kit | A7iii A7 3 Full Frame Mirrorless Camera Lenses Video Kit Photography Filmmaking Multi Setup Zoom lens': [
    { item: 'Sony A7 III', qty: 1 }
  ],
  '3x Sony a7iii 4k mirrorless Camera + LED Lights + Mics + tripod rode': [
    { item: 'Sony A7 III', qty: 1 },
    { item: 'LED light panels RGB', qty: 3 },
    { item: 'Small rig tripod', qty: 1 }
  ],
  '3x Sony a7III A73 a7 3 + 24-70 mm g master f2.8 lens zoom gm g-master gmaster Sony mirrorless 4k full frame camera ': [
    { item: 'Sony A7 III', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 }
  ],
  '3x Sony a7 iii mirrorless Camera 4k full frame + Lens set ': [
    { item: 'Sony A7 III', qty: 1 }
  ],
  '3x Sony a7 iii mirrorless Camera 4k full frame + Lens set  and more': [
    { item: 'Sony A7 III', qty: 1 }
  ],
  'Sony A7 III 4K Camera + DJI Wireless Mic (2x) – Complete Interview & Content Creator Kit A7iii full frame mirrorless microphone mic lav lapel audio recorder ': [
    { item: 'Sony A7 III', qty: 1 },
    { item: 'DJI Wireless Mics', qty: 1 }
  ],
  'Sony a7 iii 4k Mirrorless camera 2x gm 24-70mm f2.8 lens g master g-master gmaster sony 7iii Sony a7 3 a73': [
    { item: 'Sony A7 III', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 2 }
  ],
  'Sony a7III A73 a7 3 + Dji rs 2 gimbal + 16-35 mm g master f2.8 lens zoom gm g-master gmaster ronin Sony mirrorless 4k full frame camera or Sony fx3 and more': [
    { item: 'Sony A7 III', qty: 1 },
    { item: 'DJI RS3 Pro gimbal', qty: 1 },
    { item: 'Sony GM 16-35mm f2.8', qty: 1 }
  ],
  'Sony a7 iii a7iii 4k cinema camera full frame mirrorless body set Sony a7 3 Sony a73 and more': [
    { item: 'Sony A7 III', qty: 1 }
  ],
  'Sony a7iii  and more': [
    { item: 'Sony A7 III', qty: 1 }
  ],
  'Sony a7 iii mirrorless Camera 4k full frame  + 28-70mm Sony zoom camera + DJI wireless mic Sony a7iii a73 alpha cinema camera lav lapel microphone 2x or rode': [
    { item: 'Sony A7 III', qty: 1 },
    { item: 'Sony 28-70mm', qty: 1 },
    { item: 'DJI Wireless Mics', qty: 1 }
  ],
  'Sony a7 iii mirrorless Camera 4k full frame  + 28-70mm Sony zoom camera + DJI wireless mic Sony a7iii a73 alpha cinema camera lav lapel microphone 2x or rode and more': [
    { item: 'Sony A7 III', qty: 1 },
    { item: 'Sony 28-70mm', qty: 1 },
    { item: 'DJI Wireless Mics', qty: 1 }
  ],

  // --- Sony A7 II ---
  'Sony A7 ii mirrorless Camera full frame digital cinema + 28-70mm Zoom FE Sony lens + 128gb sd card Sony a7ii': [
    { item: 'Sony A7 II', qty: 1 },
    { item: 'Sony 28-70mm', qty: 1 }
  ],
  ' Dji RS 2 Gimbal + Sony a7 ii camera Combo + 28-70mm lens': [
    { item: 'DJI RS3 Pro gimbal', qty: 1 },
    { item: 'Sony A7 II', qty: 1 },
    { item: 'Sony 28-70mm', qty: 1 }
  ],

  // --- Sony Lenses ---
  'Sony 16-35 mm f2.8 g master gm g-master gmaster zoom lens wide angle + nd filter variable VND 2-400 ': [
    { item: 'Sony GM 16-35mm f2.8', qty: 1 },
    { item: 'ND filter', qty: 1 }
  ],
  'Sony 16-35 mm f2.8 g master gm g-master gmaster zoom lens wide angle + nd filter variable VND 2-400  and more': [
    { item: 'Sony GM 16-35mm f2.8', qty: 1 },
    { item: 'ND filter', qty: 1 }
  ],
  'Sony 16–35mm f/2.8 GM Wide Angle Lens – Full Frame E-Mount / G Master Series': [
    { item: 'Sony GM 16-35mm f2.8', qty: 1 }
  ],
  'Sony 16-35mm G master f2.8 lens gmaster g-master gm lens zoom wide angle ': [
    { item: 'Sony GM 16-35mm f2.8', qty: 1 }
  ],
  'Sony 16-35mm G master f2.8 lens gmaster g-master gm lens zoom wide angle  and more': [
    { item: 'Sony GM 16-35mm f2.8', qty: 1 }
  ],
  'Sony 24-70 mm f2.8 gmaster gm g-master g master zoom lens e mount autofocus + variable nd filter vnd': [
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'ND filter', qty: 1 }
  ],
  'Sony 24-70 mm f2.8 gmaster gm g-master g master zoom lens e mount autofocus + variable nd filter vnd and more': [
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'ND filter', qty: 1 }
  ],
  'Sony 24-70mm f2.8 zoom gmaster g-master g master gm e mount': [
    { item: 'Sony GM 24-70mm f2.8', qty: 1 }
  ],
  'Sony 24-70mm f2.8 zoom gmaster g-master g master gm e mount and more': [
    { item: 'Sony GM 24-70mm f2.8', qty: 1 }
  ],
  'Sony 70-200mm f2.8 zoom tele gmaster gm g-master g master lens': [
    { item: 'Sony GM 70-200mm f2.8', qty: 1 }
  ],
  'Sony 28–70mm f3.5–5.6 OSS Zoom Lens (Like Tamron 28–75mm / Sigma 24–70mm) – Versatile Full-Frame Lens': [
    { item: 'Sony 28-70mm', qty: 1 }
  ],
  'Sony Full Frame 28-70mm zoom Lens ': [
    { item: 'Sony 28-70mm', qty: 1 }
  ],
  'Sony 90mm f2.8 macro lens ': [
    { item: 'Sony GM 90mm f2.8', qty: 1 }
  ],
  'Sony 90mm f2.8 macro lens  and more': [
    { item: 'Sony GM 90mm f2.8', qty: 1 }
  ],
  'Sony 90mm f2.8 Macro / Portrait Lens (Like Sigma 105mm / Canon 100mm Macro) – Full-Frame Telephoto Prime': [
    { item: 'Sony GM 90mm f2.8', qty: 1 }
  ],
  'Sony ultimate lens set g master 16-35,24-70, 70-200mm': [
    { item: 'Sony GM 16-35mm f2.8', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'Sony GM 70-200mm f2.8', qty: 1 }
  ],
  'Sony Ultimate Lens setup, 90mm , 24-70mm, 16-35mm g master and more': [
    { item: 'Sony GM 90mm f2.8', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    { item: 'Sony GM 16-35mm f2.8', qty: 1 }
  ],

  // --- Canon Lenses ---
  'Canon 24–105mm f4 L IS USM Lens (Like Sigma 24–70mm / Tamron 28–75mm) – Professional EF Zoom Lens': [
    { item: 'Canon EF 24-105mm f4', qty: 1 }
  ],

  // --- Fisheye ---
  'TTArtisan Sony 11mm f/2.8 Fisheye / Ultra Wide Lens (Like Samyang / Laowa) – E-Mount Lens for Video & Photography': [
    { item: 'Sony 11mm f2.8 fisheye', qty: 1 }
  ],
  '7.5mm f/2.8 7Artisans Fisheye Lens Sony E-Mount | Ultra-Wide Manual Focus, Circular / Full-Frame Creative Lens (like Samyang 8mm, Laowa Fisheye)': [],
  '7.5mm f/2.8 7Artisans Fisheye Lens Sony E-Mount | Ultra-Wide Manual Focus, Circular / Full-Frame Creative Lens (like Samyang 8mm, Laowa Fisheye) and more': [],

  // --- Fujifilm ---
  'Fujifilm X100VI Camera Set | Fuji X100 VI Digital Compact Camera with Fixed 23mm f/2 Lens + Batteries + SD Card (like Fuji X100V / Ricoh GR IIIX) ': [
    { item: 'Fujifilm X100 VI', qty: 1 }
  ],

  // --- Blackmagic combos ---
  'Blackmagic 6k Full Frame Cinema camera + 1TB sd card  Bmpcc pro set Basic': [
    { item: 'BMPCC 6K Full Frame', qty: 1 }
  ],
  'Blackmagic 6k Full Frame Cinema camera + 1TB sd card  Bmpcc pro set Basic and more': [
    { item: 'BMPCC 6K Full Frame', qty: 1 }
  ],
  'Blackmagic 6k Full frame cinema camera + 24-105mm Cannon Zoom lens L series ': [
    { item: 'BMPCC 6K Full Frame', qty: 1 },
    { item: 'Canon EF 24-105mm f4', qty: 1 }
  ],
  'Blackmagic 6k Full frame cinema camera Bmpcc + 3x Anamorphic Lens Kit Great Joy Blazar  and more': [
    { item: 'BMPCC 6K Full Frame', qty: 1 },
    { item: 'Anamorphic Great Joy 35mm', qty: 1 },
    { item: 'Anamorphic Great Joy 50mm', qty: 1 },
    { item: 'Anamorphic Great Joy 85mm', qty: 1 }
  ],
  'Blackmagic 6k pro Bmpcc cinema camera + 2x cannon zoom lenses set 16-35mm and 24-105mm ': [
    { item: 'BMPCC 6K Pro', qty: 1 },
    { item: 'Canon EF 16-35mm f2.8', qty: 1 },
    { item: 'Canon EF 24-105mm f4', qty: 1 }
  ],
  'Blackmagic 6k pro Bmpcc Cinema Camera set Run and gun': [
    { item: 'BMPCC 6K Pro', qty: 1 }
  ],
  'Blackmagic 6k pro V mount rig and more': [
    { item: 'BMPCC 6K Pro', qty: 1 },
    { item: 'V-mount 150mAh', qty: 1 }
  ],
  'Blackmagic camera 6k pro BMPCC6K  Bmpcc 6k pro  and more': [
    { item: 'BMPCC 6K Pro', qty: 1 }
  ],
  'Blackmagic cinema camera full frame 6k Bmpcc + Rode video mic pro plus microphone + tripod smallrig interview set ': [
    { item: 'BMPCC 6K Full Frame', qty: 1 },
    { item: 'Rode Video Mic Pro Plus', qty: 1 },
    { item: 'Small rig tripod', qty: 1 }
  ],
  'Blackmagic cinema camera full frame 6k Bmpcc + Rode video mic pro plus microphone + tripod smallrig interview set  and more': [
    { item: 'BMPCC 6K Full Frame', qty: 1 },
    { item: 'Rode Video Mic Pro Plus', qty: 1 },
    { item: 'Small rig tripod', qty: 1 }
  ],
  'Blackmagic full frame 6k + BMPCC 6k pro cinema camera + 2x 24-105 lenses ': [
    { item: 'BMPCC 6K Full Frame', qty: 1 },
    { item: 'BMPCC 6K Pro', qty: 1 },
    { item: 'Canon EF 24-105mm f4', qty: 1 }
  ],
  'Blackmagic full frame 6k cinema camera Bmpcc + 3x DZO Vespid prime set lens 25,50,75mm': [
    { item: 'BMPCC 6K Full Frame', qty: 1 }
  ],
  'Blackmagic full frame 6k cinema camera Bmpcc + v mount run and gun setup ': [
    { item: 'BMPCC 6K Full Frame', qty: 1 },
    { item: 'V-mount 150mAh', qty: 1 }
  ],
  'Blackmagic Pocket Cinema 6k Pro (bmpcc)+ Anamorphic Sirui': [
    { item: 'BMPCC 6K Pro', qty: 1 }
  ],
  'Blackmagic Pocket Cinema Camera 6K Full Frame Set + VND Filter | BMPCC 6K FF + CFexpress 1TB + Extra Batteries + Cage (like Canon R5C / Sony FX3)  and more': [
    { item: 'BMPCC 6K Full Frame', qty: 1 }
  ],
  'Bmpcc 6k full frame blackmagic cinema camera 6k l mount bmpcc6k + cannon 24-105mm lens + tripod + 1TB sd card': [
    { item: 'BMPCC 6K Full Frame', qty: 1 },
    { item: 'Canon EF 24-105mm f4', qty: 1 },
    { item: 'Small rig tripod', qty: 1 }
  ],
  'BMPCC 6k Pro Blackmagic camera + Senheiser mic + zoom Lens Interview Kit and more': [
    { item: 'BMPCC 6K Pro', qty: 1 },
    { item: 'Audio boom mic Sennheiser', qty: 1 }
  ],
  'Bmpcc 6k pro blackmagic Cinema Camera + 24-105 mm lens bmpcc6k cannon zoom lens and more': [
    { item: 'BMPCC 6K Pro', qty: 1 },
    { item: 'Canon EF 24-105mm f4', qty: 1 }
  ],
  'BMPCC 6k PRO Cinema Camera Blackmagic + RS 3 Pro Gimbal Kit': [
    { item: 'BMPCC 6K Pro', qty: 1 },
    { item: 'DJI RS3 Pro gimbal', qty: 1 }
  ],
  'BMPCC 6k PRO Cinema Kit + tripod + follow focus tilta nucleus ': [
    { item: 'BMPCC 6K Pro', qty: 1 },
    { item: 'Small rig tripod', qty: 1 },
    { item: 'Tilta Nucleus Nano 2 follow focus', qty: 1 }
  ],

  // --- Anamorphic lenses ---
  'Anamorphic Blazar Remus Full frame Lens': [
    { item: 'Anamorphic Blazar Remus 65mm', qty: 1 }
  ],
  'Anamorphic Blazar Remus Lens 45mm 1.5x T2.0 Pl mount neutral flare': [
    { item: 'Anamorphic Blazar Remus 45mm', qty: 1 }
  ],
  'Blazar Remus full frame 33mm t1.8 1.5x anamorphic lens cinema prime for pl, ef , e , x ,l , rf mount Arri pl native silver flare  and more': [
    { item: 'Anamorphic Blazar Remus 33mm', qty: 1 }
  ],
  'Great Joy 35mm Anamorphic Cine Lens Amber Flare (Like sirui or atlas Orion or mercury)': [
    { item: 'Anamorphic Great Joy 35mm', qty: 1 }
  ],
  'Great Joy 35mm Anamorphic Cine Lens Amber Flare (Like sirui or atlas Orion or mercury) and more': [
    { item: 'Anamorphic Great Joy 35mm', qty: 1 }
  ],
  'Great Joy 35mm T2.9 1.8x Anamorphic Lens (EF / L / E Mount) – Cinematic Scope Lens (Like Sirui / Laowa)': [
    { item: 'Anamorphic Great Joy 35mm', qty: 1 }
  ],
  'Great Joy Cine Anamorphic Lens Set (like Sirui , atlas Orion , arri , atlas mercury) and more': [
    { item: 'Anamorphic Great Joy 35mm', qty: 1 },
    { item: 'Anamorphic Great Joy 50mm', qty: 1 },
    { item: 'Anamorphic Great Joy 85mm', qty: 1 }
  ],

  // --- DZO Film lenses (NOT in inventory, but PL mount adapter IS) ---
  'DZO ARLES Prime set 3 lenses t1.4 25,50,75mm DZOFILM PL mount (e,l,x,rf) digital cinema lens Full frame vista vision coverage': [
    { item: 'PL to Sony E mount', qty: 1 }
  ],
  'DZOFilm Vespid Cinema Prime 3-Lens Set (25mm / 50mm / 75mm T2.1) – PL  Mount Cine Lens Kit for BMPCC, RED, ARRI, Sony FX3, FX6, and More': [],
  'DZOFilm Vespid Cinema Prime 75mm T2.1 Lens – PL Mount Cine Lens for BMPCC, RED, ARRI, Sony FX3, FX6, and More': [],
  'DZOFilm Vespid Cinema Prime Full 6-Lens Set (16mm / 25mm / 50mm / 75mm / 100mm / 125mm T2.1) – PL Mount Cine Lens Kit for BMPCC, RED, ARRI, Sony FX3, FX6, Canon C70, and More': [],
  'DZO film Vespid Prime 3x Cinema lens set T2.1 Full Frame': [],
  'DZO film Vespid Prime 3x Cinema lens set T2.1 Full Frame and more': [],
  'DZO film Vespid Prime 6x Cinema lens set T2.1 Full Frame vista vision Arri pl mount adapts to rf,e,x,l mount': [],
  'DZO film Vespid Prime 6x Cinema lens set T2.1 Full Frame vista vision Arri pl mount adapts to rf,e,x,l mount and more': [],
  'DZO film Vespid Prime Cinema lens 16mm T2.8 Full Frame ( arri, Zeiss, cannon, Meike)': [],
  'DZO film Vespid Prime Cinema lens 16mm T2.8 Full Frame ( arri, Zeiss, cannon, Meike) and more': [],
  'DZO film Vespid Prime Cinema lens 25mm T2.1 Full Frame ( arri, Zeiss, cannon, Meike)': [],
  'DZO film Vespid Prime Cinema lens 25mm T2.1 Full Frame ( arri, Zeiss, cannon, Meike) and more': [],
  'DZO film Vespid Prime Cinema lens 50mm T2.1 Full Frame ( arri, Zeiss, cannon, Meike)': [],
  'DZO film Vespid Prime Cinema lens 50mm T2.1 Full Frame ( arri, Zeiss, cannon, Meike) and more': [],
  'DZO film Vespid Prime Cinema lens 75mm T2.1 Full Frame': [],

  // --- GoPro ---
  '3× GoPro Hero 12 Action Camera Set | Go Pro / GoPro / Hero 12 / Action Cameras / POV / 3 Camera Set / 5.3K / 4K / Vlog / Adventure': [
    { item: 'GoPro 12 Hero', qty: 3 }
  ],
  '3x Go pro hero 12 camera 4k set + 6x batteries + 3x 128gb sd cards': [
    { item: 'GoPro 12 Hero', qty: 3 },
    { item: '256GB card', qty: 3 }
  ],
  '4x go pro hero 12 set + 4x 128gb sd card + 8x batteries + suction mounts': [
    { item: 'GoPro 12 Hero', qty: 3 },
    { item: 'Suction cups', qty: 4 }
  ],
  '4x go pro hero 12 set + 4x 128gb sd card + 8x batteries + suction mounts and more': [
    { item: 'GoPro 12 Hero', qty: 3 },
    { item: 'Suction cups', qty: 4 }
  ],
  'Go pro hero 12 camera action + 128gb so card + 2x batteries + accessories ': [
    { item: 'GoPro 12 Hero', qty: 1 }
  ],
  'Go pro hero 12 + suction mount + sd card + 2x batteries ': [
    { item: 'GoPro 12 Hero', qty: 1 },
    { item: 'Suction cups', qty: 1 }
  ],
  'Go pro hero 12 + suction mount + sd card + 2x batteries  and more': [
    { item: 'GoPro 12 Hero', qty: 1 },
    { item: 'Suction cups', qty: 1 }
  ],

  // --- DJI Osmo Action ---
  // (already parsed in previous runs for most)

  // --- DJI Drones ---
  'Dji Drone Mavic 3 classic + 2x battery + rc + nd filters': [
    { item: 'DJI Mavic 3 Pro', qty: 1 }
  ],
  'Dji mavic 3 pro drone + 3x batteries + ND filter + 256gb Sd card + RC controller ': [
    { item: 'DJI Mavic 3 Pro', qty: 1 },
    { item: '256GB card', qty: 1 }
  ],
  'DJI MAVIC 3 PRO DRONE + FLY MORE KIT – 4K DRONE – CINEMATIC DRONE – AERIAL CAMERA – DJI DRONE – MAVIC3PRO – QUADCOPTER': [
    { item: 'DJI Mavic 3 Pro', qty: 1 }
  ],
  'DJI mini 4 pro Drone + 5x batteries + 256gb sd + nd filter': [
    { item: 'DJI Mini 4 Pro', qty: 1 },
    { item: '256GB card', qty: 1 }
  ],
  'DJI MINI 4 PRO + FLY MORE KIT – 4K DRONE – MINI DRONE – AERIAL DRONE – CAMERA DRONE – CINEMATIC DRONE – ULTRA LIGHT 249G – FOLDABLE DRONE – DJI MINI4 – QUADCOPTER – AERIAL PHOTOGRAPHY VIDEO': [
    { item: 'DJI Mini 4 Pro', qty: 1 }
  ],

  // --- DJI Gimbals ---
  'Dji RS3 Gimbal ronin stabilizer rs4 rs 2 Dji ': [
    { item: 'DJI RS3 Pro gimbal', qty: 1 }
  ],
  'Dji RS3 PRO Gimbal set': [
    { item: 'DJI RS3 Pro gimbal', qty: 1 }
  ],
  'DJI RS3 Pro Gimbal Set (Like Zhiyun Weebill / Ronin) – Professional Camera Stabilizer Kit': [
    { item: 'DJI RS3 Pro gimbal', qty: 1 }
  ],
  'Dji rs 4 mini set ronin gimbal with vertical shooting + 24-70mm Sony gmaster zoom lens gm g-master ': [
    { item: 'DJI RS3 Pro gimbal', qty: 1 },
    { item: 'Sony GM 24-70mm f2.8', qty: 1 }
  ],
  'Dji RSC 2 Gimbal ronin stabilizer ': [
    { item: 'DJI RS3 Pro gimbal', qty: 1 }
  ],
  'Gimbal battery dji ronin rs2 / rs3 pro extra ': [
    { item: 'DJI gimbal battery', qty: 1 }
  ],

  // --- DJI Mics ---
  'Dji mic wireless + 2x lav mics 2x transmitters (like rode go 2) and more': [
    { item: 'DJI Wireless Mics', qty: 1 }
  ],
  'DJI Mic 2 wireless': [
    { item: 'DJI Mic 2 wireless', qty: 1 }
  ],

  // --- Rode Mics ---
  'Rode Mic Go Shotgun Microphone Boom': [
    { item: 'Rode Video Mic Go', qty: 1 }
  ],
  'Rode mic wireless pro +2x lavs  32bit Float and Timecode': [
    { item: 'Rode Wireless Mic Pro set', qty: 1 }
  ],
  'Rode mic wireless pro +2x lavs  32bit Float and Timecode and more': [
    { item: 'Rode Wireless Mic Pro set', qty: 1 }
  ],
  'Rode videomic pro plus microphone shotgun ': [
    { item: 'Rode Video Mic Pro Plus', qty: 1 }
  ],
  'Rode wireless go 2 + 2x Lav mics Microphone ': [
    { item: 'Rode Wireless Mic Pro set', qty: 1 }
  ],
  'Rode wireless go 2 + 2x Lav mics Microphone  and more': [
    { item: 'Rode Wireless Mic Pro set', qty: 1 }
  ],
  'RØDE Wireless GO II Mic Set (Like DJI Mic / Hollyland Lark) – Dual Wireless Lavalier Microphone Kit': [
    { item: 'Rode Wireless Mic Pro set', qty: 1 }
  ],
  '4x Rode Mic wireless Pro set + 4x lav lavelier lapel microphone audio recorder sound recorder wireless  and more': [
    { item: 'Rode Wireless Mic Pro set', qty: 2 }
  ],
  '4x RØDE Wireless PRO Mic Set + Lavaliers – Professional Dual Wireless Microphone System for Cameras, Interviews, and Content Creators lav lapel mic microphone recorder ': [
    { item: 'Rode Wireless Mic Pro set', qty: 2 }
  ],

  // --- Sennheiser Boom Mic ---
  'Boom Mic Kit - Senheiser MKE600 like Rode NTG 5 Microphone and more': [
    { item: 'Audio boom mic Sennheiser', qty: 1 }
  ],
  'Full Boom Mic Kit – Sennheiser MKE 600 + Zoom Recorder (Like Rode NTG / Deity) – Complete Location Sound Set': [
    { item: 'Audio boom mic Sennheiser', qty: 1 }
  ],
  'Senheiser  MKE 600 Shotgun Mic (like Rode NTG mic)': [
    { item: 'Audio boom mic Sennheiser', qty: 1 }
  ],
  'Pro Boom Mic Kit + DJI Wireless Mics (2x) – Complete Audio Setup for Film, Interviews & Content Creation | Shotgun Mic, Audio Recorder, Lav Lapel Mic, Boom Pole, Sound Kit': [
    { item: 'Audio boom mic Sennheiser', qty: 1 },
    { item: 'DJI Wireless Mics', qty: 1 }
  ],
  'Ultimate audio Boom mic + Dji livelier microphone kit recorder rode Dji shotgun sound recorder': [
    { item: 'Audio boom mic Sennheiser', qty: 1 },
    { item: 'DJI Wireless Mics', qty: 1 }
  ],
  '3x Dji mic wireless receiver Transmitter +2x rode wireless pro microphone sound recorder audio 5x mics + lavalier ': [
    { item: 'DJI Wireless Mics', qty: 1 },
    { item: 'Rode Wireless Mic Pro set', qty: 2 }
  ],

  // --- Atomos ---
  'Atomos Monitor 5,5 inch Kit Cine + stand 4k hmdi': [
    { item: 'Atomos Ninja V', qty: 1 }
  ],
  'ATOMOS NINJA V – 4K MONITOR – 4K RECORDER – FIELD MONITOR – CAMERA MONITOR – HDMI MONITOR – EXTERNAL RECORDER – VIDEO MONITOR – ATOMOS MONITOR – NINJA 5 – ON-CAMERA MONITOR – SSD RECORDER': [
    { item: 'Atomos Ninja V', qty: 1 }
  ],
  'Atomos ninja v 5 inch 4k monitor + 1 tb ssd': [
    { item: 'Atomos Ninja V', qty: 1 }
  ],

  // --- Hollyland ---
  'Hollyland Pyro 7" Wireless Monitor (Like Atomos / SmallHD) – On-Camera & Director\'s Display Kit': [
    { item: 'Hollyland 7-inch monitor', qty: 1 }
  ],
  'Hollyland Pyro S 4K Wireless Video Transmission Kit + 7" Wireless Monitor | HDMI/SDI Image Transmitter & Receiver System (like "Teradek / Hollyland Mars")': [
    { item: 'Hollyland Pyro S transmitter', qty: 1 },
    { item: 'Hollyland 7-inch monitor', qty: 1 }
  ],
  'Hollyland Pyro S Wireless Video Transmitter & Receiver Kit | 4K HDMI/SDI Image Transmission System for Camera Monitoring (like "Teradek / Hollyland Mars")': [
    { item: 'Hollyland Pyro S transmitter', qty: 1 }
  ],

  // --- LED Lights ---
  '3x RGB LED Light Panels + Stands – Full Lighting Kit for Film, Photography & Studio | GVM RGB LED Panel Light Set 800D, Soft Light, Adjustable Color Temperature, App Control, Video Light Kit': [
    { item: 'LED light panels RGB', qty: 3 }
  ],
  'LED light RGB 2x Panel GVM Kit with Aputure dmx and more': [
    { item: 'LED light panels RGB', qty: 2 }
  ],

  // --- Nanlite ---
  '4x Nanlite pavotube 30x ii led rgb w  tube lights set of 4 ( like astera titan tube ) + 4x optional stands': [
    { item: 'Nanlite Pavotube 30x II', qty: 4 }
  ],
  '4x Nanlite pavotube 30x ii led rgb w  tube lights set of 4 ( like astera titan tube ) + 4x optional stands and more': [
    { item: 'Nanlite Pavotube 30x II', qty: 4 }
  ],
  'Nanlite 500 Bi-Color LED Light (Like Aputure 600D / Godox VL300) – Adjustable Daylight & Tungsten COB Light': [
    { item: 'Nanlite 500B', qty: 1 }
  ],
  'Nanlite 500 Bi-Color LED Light (Like Aputure 600D / Godox VL300) – Adjustable Daylight & Tungsten COB Light and more': [
    { item: 'Nanlite 500B', qty: 1 }
  ],
  'Nanlite 500 bi Color light LED 550w ( like Aputure 600x aputure 300d aputure led light 600d)  and more': [
    { item: 'Nanlite 500B', qty: 1 }
  ],
  'Nanlite Forza 300 LED Light (Like Aputure 300D / Godox VL300) – Professional COB Daylight Video Light': [
    { item: 'Nanlite Forza 300', qty: 1 }
  ],
  'Nanlite Forza 300 LED Light (Like Aputure 300D / Godox VL300) – Professional COB Daylight Video Light and more': [
    { item: 'Nanlite Forza 300', qty: 1 }
  ],
  'Nanlite forza 300 Lighting Kit + stand + Gels (aputure 300d) Aputure 300d ii FX LED light ': [
    { item: 'Nanlite Forza 300', qty: 1 }
  ],
  'Nanlite forza 300 Lighting Kit + stand + Gels (aputure 300d) Aputure 300d ii FX LED light  and more': [
    { item: 'Nanlite Forza 300', qty: 1 }
  ],

  // --- Ambitful ---
  'Ambitful 2x RGB LED Light Tubes (Like Aputure / Nanlite Pavotube) – Portable Video & Photography Lighting Kit': [
    { item: 'Ambitful RGB light tubes 2x set', qty: 1 }
  ],
  'Ambitful RGB Tube Light 2x strong with aputure dmx  and more': [
    { item: 'Ambitful RGB light tubes 2x set', qty: 1 }
  ],

  // --- Softbox ---
  'SmallRig Softbox 85cm (Bowens Mount) – Professional Diffusion Light Modifier for LED, RGB, and Studio Lighting | Soft Light, Parabolic Octa Softbox with Grid & Carry Bag and more': [
    { item: 'Softbox 85cm', qty: 1 }
  ],
  'Softbox bowens mount smallrig 85cm Ultra compact Light': [
    { item: 'Softbox 85cm', qty: 1 }
  ],
  'Softbox bowens mount smallrig 85cm Ultra compact Light and more': [
    { item: 'Softbox 85cm', qty: 1 }
  ],

  // --- C-Stand ---
  'C-Stand steel + Sandbag + clamps': [
    { item: 'C-stand', qty: 1 }
  ],

  // --- V-mount batteries ---
  '2x v mount battery 150 wah capacity + charger fx lion nano': [
    { item: 'V-mount 150mAh', qty: 2 }
  ],
  '2x V mount battery 95wh + Charger and more': [
    { item: 'V-mount 95mAh', qty: 2 }
  ],
  'V mount batteries 4x 150wah Mini Flexion + Dual charger': [
    { item: 'V-mount 150mAh', qty: 4 }
  ],
  'V mount batteries 4x 150wah Mini Flexion + Dual charger and more': [
    { item: 'V-mount 150mAh', qty: 4 }
  ],

  // --- Sony NP batteries ---
  '2x sony np 970 batteries  and more': [
    { item: 'Sony NPF 970 batteries 2x sets', qty: 1 }
  ],
  '2x Sony np 970 batteries  and more': [
    { item: 'Sony NPF 970 batteries 2x sets', qty: 1 }
  ],
  '4x sony np970 batteries ': [
    { item: 'Sony NPF 970 batteries 2x sets', qty: 2 }
  ],
  '4X Sony np970 batteries ': [
    { item: 'Sony NPF 970 batteries 2x sets', qty: 2 }
  ],
  '6x Batteries Sony Np 970 extension pack ': [
    { item: 'Sony NPF 970 batteries 2x sets', qty: 3 }
  ],
  '6x sony npf 550 batteries and charger ': [],
  '6x Sony NPF 550 Batteries and charger ': [],

  // --- Smoke machines ---
  'Smoke machine Fogger haze fog dry ice portable': [
    { item: 'Smoke machine fogger', qty: 1 }
  ],
  'Smoke machine Fogger haze fog dry ice portable and more': [
    { item: 'Smoke machine fogger', qty: 1 }
  ],
  'Smoke Ninja Pro Hazer Kit | Portable Handheld Smoke Machine, Mini Fogger & Atmospheric Haze Generator (like "Micro Fogger 2 Pro")': [
    { item: 'Smoke Ninja Pro hazer', qty: 1 }
  ],

  // --- Motorized slider ---
  'Motorized Neewer Slider + Tripod – Motorized Camera Dolly & Pan Kit': [
    { item: 'Motorized slider', qty: 1 }
  ],

  // --- Camera flash ---
  'Camera flash compatible with Sony, cannon, Nikon, Leica, Fuji': [
    { item: 'Camera flash', qty: 1 }
  ],

  // --- Reflector ---
  'Light reflector 5 in 1 large 85cm ': [
    { item: '5-in-1 reflector panel', qty: 1 }
  ],

  // --- Tilta ---
  'Follow Focus puller Kit Nucleus Nano 2 Tilta Wireless Arri small rig focus puller follow focus wireless nucleus m ': [
    { item: 'Tilta Nucleus Nano 2 follow focus', qty: 1 }
  ],
  'Tilta shoulder rig  and more': [
    { item: 'Tilta shoulder rig', qty: 1 }
  ],

  // --- ND Filter ---
  'Variable ND filter VND 82 and 77mm 2-400ND Addon': [
    { item: 'ND filter', qty: 1 }
  ],

  // --- DJ Controller ---
  'DJ deck pioneer rx 3 all in one Professional controller party and more': [
    { item: 'DJ RX3 Pioneer controller', qty: 1 }
  ],
  'PIONEER RX3 – ALL IN ONE DJ DECK – DJ CONTROLLER – DJ SET – REKORDBOX / SERATO CONTROLLER – DJ MIXER – DJ EQUIPMENT – DJ BOARD – CLUB DJ CONSOLE – PERFORMANCE CONTROLLER': [
    { item: 'DJ RX3 Pioneer controller', qty: 1 }
  ],

  // --- Anker Power Station ---
  '4x anker f2000 solix power station generator 2000wah each ': [
    { item: 'Anker Power Station F2000', qty: 4 }
  ],
  '4x anker f2000 solix power station generator 2000wah each  and more': [
    { item: 'Anker Power Station F2000', qty: 4 }
  ],

  // --- Cinebloom ---
  // (not in unparsed list but just in case)

  // --- Suction cups ---
  // (usually bundled with GoPro, already covered)

  // --- Monopod ---
  // (not in unparsed list)

  // --- DJI Osmo Action ---
  // (most already parsed in earlier runs)
};

async function main() {
  console.log('Starting manual backfill of parsed_items...\n');

  // Get all distinct unparsed titles
  const unparsed = await prisma.$queryRaw`
    SELECT DISTINCT title FROM rental WHERE parsed_items IS NULL ORDER BY title
  `;

  console.log(`Found ${unparsed.length} unique unparsed titles\n`);

  let updated = 0;
  let mapped = 0;
  let unmapped = [];

  for (const row of unparsed) {
    const title = row.title;

    if (title in TITLE_MAPPINGS) {
      const items = TITLE_MAPPINGS[title];
      const jsonValue = JSON.stringify(items);

      const count = await prisma.$executeRaw`
        UPDATE rental SET parsed_items = ${jsonValue}::jsonb, updated_at = NOW()
        WHERE title = ${title} AND parsed_items IS NULL
      `;

      updated += Number(count);
      mapped++;

      if (items.length > 0) {
        console.log(`✓ "${title.substring(0, 60)}..." → ${items.map(i => `${i.qty}x ${i.item}`).join(', ')}`);
      } else {
        console.log(`○ "${title.substring(0, 60)}..." → [] (not in inventory)`);
      }
    } else {
      unmapped.push(title);
    }
  }

  console.log(`\n--- Results ---`);
  console.log(`Mapped: ${mapped} unique titles → ${updated} rental rows updated`);
  console.log(`Unmapped: ${unmapped.length} titles not in mapping\n`);

  if (unmapped.length > 0) {
    console.log('UNMAPPED TITLES:');
    unmapped.forEach(t => console.log(`  "${t}"`));
  }

  // Final stats
  const stats = await prisma.$queryRaw`
    SELECT
      COUNT(*) as total,
      COUNT(parsed_items) as has_parsed,
      COUNT(*) - COUNT(parsed_items) as needs_parsing
    FROM rental
  `;
  console.log(`\nFinal DB state: ${Number(stats[0].total)} total, ${Number(stats[0].has_parsed)} parsed, ${Number(stats[0].needs_parsing)} remaining`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
