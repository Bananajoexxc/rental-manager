import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { formatPricingCatalogForAI } from '../data/pricing-catalog';
import { formatCompatibilityForAI } from '../data/item-compatibility';
import { formatBundleSuggestionsForAI } from '../data/bundle-suggestions';
import { formatSpecsForAI } from '../data/item-specs';

@Injectable()
export class MemoryService implements OnModuleInit {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => AiService)) private aiService: AiService,
  ) {}

  async onModuleInit() {
    await this.seedCriticalMemories();
    await this.ensureUpdatedMemories();
  }

  private async seedCriticalMemories() {
    const count = await this.prisma.memory.count();
    if (count > 0) {
      this.logger.log(`Memories already seeded (${count} found)`);
      return;
    }

    this.logger.log('Seeding critical operational memories...');

    const memories = [
      // === ACCOUNT DETAILS ===
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals Account',
        content: 'DB Cinema Rentals is one of two Hygglo/Fat Llama accounts. Owner: Daniel. Email: daniel.malai1999@gmail.com. Voice: Professional, concise, human. Pickup location: Statue of James II, 11 Trafalgar Square, London WC2N 5DN. Real address: 23 Whitcomb Street, WC2H 7ER. Apple Maps: https://maps.apple/p/FexFCzGnk59Y-S Google Maps: https://maps.app.goo.gl/ry8ea4tySBoah7d7A',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'Leo Adams Account',
        content: 'Leo Adams is the second Hygglo/Fat Llama account sharing the same inventory. Email: leo.adams.work@gmail.com. Voice: Human, kind, slightly more chill. Pickup location: 5 Pall Mall East, London SW1Y 5BF, meet outside by the Pret. Both accounts share all equipment - if booked on one, unavailable on the other.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'Owner Info - Daniel',
        content: 'Owner is Daniel (Daniel Broj). Telegram chat ID: 6634478551. All escalations, cancellation approvals, damage claims, same-day rental approvals, and uncertain situations must be reported to Daniel via Telegram. Revolut payment link for delivery/fees: https://revolut.me/dbcinema. Bank: Daniel Broj, Sort code 23-01-20, Account 52037163, Revolut Ltd 30 South Colonnade E14 5HX London.',
        importance: 10,
      },

      // === DB CINEMA TEMPLATES (condensed) ===
      {
        memory_type: 'fact',
        subject: 'DB Cinema Welcome Text',
        content: 'DB Cinema welcome text (send when item confirmed available, meets minimum, no reason to decline): "Hey! Thx for your interest, the item is available for hire! Location: Trafalgar Square rental hub, next to the National Gallery. Delivery available (separate charge) - let us know now if needed, must be booked by us. Opening times: 10am-12pm & 7-9pm. Evening before pickup or morning after return = +50% fee; both = extra rental day. Exact address sent after booking verification. If you dont confirm your time after booking youll be assigned the latest slot. Please reply: read and understood. Well then progress your rental."',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Booking Confirmed Text',
        content: 'DB Cinema booking confirmed text (send when verified): "Your booking is confirmed & verified! Pickup/return address: Statue of James II, 11 Trafalgar Square, London WC2N 5DN. Apple Maps: https://maps.apple/p/FexFCzGnk59Y-S Google Maps: https://maps.app.goo.gl/ry8ea4tySBoah7d7A. Need delivery? Tell us NOW. Message here when you arrive both times - we wont come without it! Questions via chat only, phone doesnt work. Batteries may not be fully charged. If your listing has optional items, tell us if you want them."',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Times Confirmation Text',
        content: 'DB Cinema times confirmation text (send after booking confirmed): "Please confirm times by copying & pasting: Hi! I would love to pickup at .... on the .... and return at .... on the .... I will see you at 11 Trafalgar Square BY THE STATUE OF JAMES THE SECOND. Hours: 10-12pm & 7-9pm ONLY. Miss 9pm cutoff = extend by an extra day. Once confirmed, no further confirmation needed."',
        importance: 9,
      },

      // === LEO ADAMS TEMPLATES (condensed) ===
      {
        memory_type: 'fact',
        subject: 'Leo Adams Welcome Text',
        content: 'Leo Adams welcome text: "Hey! Thx for the request, item is available for those times. Ill be by Charing Cross Road station near the National Portrait Gallery for pickup & return. Usually 10-12:30pm & 7-9pm. Let me know if that works & ill move it forward. - Leo"',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'Leo Adams Booking Confirmed Text',
        content: 'Leo Adams booking confirmed text: "All booked! Location: 5 Pall Mall East, London SW1Y 5BF - meet outside by the Pret. Google it to find the right one. Keep all communication here & text me times like: I will pickup at .... on .... and return at .... on the .... Reminder: 10-12pm & 7-9pm unless stated otherwise."',
        importance: 9,
      },

      // === DELIVERY FRAMEWORK ===
      {
        memory_type: 'fact',
        subject: 'Delivery Courier Framework',
        content: 'Delivery uses Addison Lee COURIER (not taxi). Origin: 23 Whitcomb Street WC2H 7ER. Phone: 020 7387 8888. Vehicles: Motorcycle (small items ≤2 items, ≤3 score, ≤4kg). Small Car (cameras + lenses, single light, gimbal - most orders). Large Van (3+ large/heavy items or DJ+speakers). Never recommend van unless 3+ large items. All estimates accurate within ~15% - actual price confirmed by courier.',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'Delivery Pricing Zones',
        content: 'Delivery pricing from Trafalgar Square (6 zones, London only, max 30km). Motorcycle-to-car increase: 35-45%. Central Core (0-3km): Motorcycle £15-20, Car £21-27, Van £45-65. Central London (3-5km): Motorcycle £20-27, Car £27-37, Van £55-75. Inner London (5-10km): Motorcycle £28-38, Car £38-52, Van £70-95. Mid London (10-15km): Motorcycle £35-48, Car £48-65, Van £80-105. Outer London (15-20km): Motorcycle £42-55, Car £57-75, Van £90-115. Greater London (20-30km): Motorcycle £50-68, Car £68-93, Van £105-140. Beyond 30km: NOT AVAILABLE - suggest pickup instead. Round-trip ≈1.8x one-way. Rush/priority at surcharge. Estimates ~15% accurate.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'Delivery Fee Payment Text',
        content: 'Delivery fee payment text (send ONLY after booking is verified and accepted, never before): "Hey! Kindly follow this link to complete the transaction for the requested amount. Use reference: delivery fee. Confirm here once sent please. https://revolut.me/dbcinema Should the link not work please use: British Pound, Beneficiary Daniel Broj, Sort code 23-01-20, Account number 52037163, Address Revolut Ltd 30 South Colonnade E14 5HX London UK."',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'Delivery Mandatory Items',
        content: 'Delivery is MANDATORY ONLY when DJ deck + speakers are booked TOGETHER. Speakers alone or DJ deck alone = self-pickup is fine, delivery NOT mandatory. Orders with more than one large light should recommend delivery. For all other items delivery is optional and only discussed when renter asks.',
        importance: 8,
      },

      // === LOCATION HANDLING ===
      {
        memory_type: 'fact',
        subject: 'Fake Location Handling',
        content: 'All listing locations except Trafalgar Square/Whitehall/Central London area are marketing-only. NEVER tell renters locations are fake or that all items are at one place. ALWAYS: (1) acknowledge their specific location by name, (2) apologise with a natural excuse — vary between: "out of stock at that branch", "out on a rental there", "pulled in for a service", "in for maintenance at our central hub", "consolidating pickups at Trafalgar Square today", "stock all rented out". (3) Offer central branch + 10% distance discount (automatic for any non-central location). (4) Ask if that works or if they prefer delivery. If renter says too far, don\'t assume delivery — apologise, mention the discount, then gently suggest delivery as an option.',
        importance: 10,
      },

      // === CURVEBALL HANDLING ===
      {
        memory_type: 'fact',
        subject: 'Shared Rental Handling',
        content: 'If two renters try to book the same item for the same dates (shared rental/split payment): One physical item = one booking only. Split payment is their problem. Ask who should be the booking holder.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'Extension Fishing Prevention',
        content: 'If a renter repeatedly asks to extend day by day, consolidate after 2 requests: "Rather than extending day by day, let me know your full end date and I will quote the whole period." Never reveal specific future booking dates or other renters info. Vague is fine: "available through [date], after that gets tighter."',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'Flip-Flopper Handling',
        content: 'If a renter keeps changing their mind on times/items, after 2 changes set a decision deadline: "Need to confirm within the next 2 hours so I can hold the slot." Never waive fees due to indecision. Consistency over being nice - exceptions create precedent.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'Angry Renter Protocol',
        content: 'If renter sends angry/rude messages: Acknowledge frustration, never get defensive, solve the problem, escalate urgently to Daniel. Example: "Really sorry for the wait! Let me check on this right now. Are you at [location]? Sorting this immediately."',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'Late Pickup Protocol',
        content: 'If renter is late to pickup: 30min late = send reminder asking if still coming. 1 hour late = warning that slot may need to be released. End of slot = offer next slot or reschedule. If renter not responding and 30min past return time = potential non-return, inform Daniel.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'Item Breaks Mid-Rental',
        content: 'If gear breaks during rental: First troubleshoot (battery seated? power cycle? error lights?). If truly broken, tell renter not to force it, come back for swap if backup unit available. Escalate to Daniel for billing decisions. Never promise refunds without Daniel approval.',
        importance: 8,
      },

      // === COMMON RENTER Q&A ===
      {
        memory_type: 'fact',
        subject: 'FAQ - Memory Cards',
        content: 'Memory cards (256GB) are included free with every camera rental.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Camera Cages',
        content: 'All cameras come with cages as standard, including the BMPCC 6K Pro and 6K Full Frame. Mention this if the renter asks about rigging or protection.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - RX2 Listing Redirect',
        content: 'The Pioneer XDJ-RX2 listing exists for search visibility only. When a renter comes through this listing, immediately recommend the DJ RX3 Pioneer controller which we actually have in stock. Do NOT explain or discuss the RX2 — just naturally suggest the RX3 as our available DJ controller. NEVER reveal the listing exists for visibility purposes.',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Canon EF Lenses on Sony FX3',
        content: 'Using Canon EF lenses on the Sony FX3 is not recommended. The FX3 is Sony E-mount — use native Sony lenses for best results (AF, stabilisation, communication).',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - V-mount Batteries on Planes',
        content: 'Always check with your specific airline before flying with V-mount batteries. Rules vary by carrier.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - DJI RS3 Pro Gimbal Payload',
        content: 'The DJI RS3 Pro handles the FX3 + 70-200mm fine — 4.5kg payload capacity. Just takes careful balancing.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - BMPCC Handheld vs Rig',
        content: 'BMPCC 6K Pro handheld vs rig depends on the shoot. Short takes handheld is fine, anything over 30 min you\'ll want a rig or shoulder support.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Remus vs Great Joy Anamorphic',
        content: 'Remus: amber/warm flare, 1.5x squeeze, T1.6 (faster, better low-light), PL mount native. Great Joy: blue flare, 1.8x squeeze, T2.9 (more cinematic stretch), EF mount native. Remus needs PL adapter for Sony/Canon. Great Joy mounts directly on EF cameras (BMPCC 6K Pro) or via EF adapter on Sony.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Light Stands',
        content: 'Every light rental includes a stand.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Smoke Machine Indoors',
        content: 'The smoke machine/hazer works indoors but disable or cover smoke detectors first and ventilate well after use.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - BMPCC Battery Life',
        content: 'BMPCC LP-E6 batteries drain fast — about 30-45 min each. We include 5 but recommend adding a V-mount battery for all-day shoots (lasts hours).',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Delivery',
        content: 'Pickup from central London is free. Courier delivery is also available for an extra fee.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Rode Wireless Mic with iPhone',
        content: 'The Rode Wireless Mic works with iPhone via cable, though the cable is not included — renter needs their own Lightning or USB-C cable.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - ND Filter Sizes',
        content: 'We have 82mm and 77mm variable ND filters.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Interview Lighting',
        content: '2 lights minimum (key + fill), 3 ideal (key, fill, backlight) for interview setups.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Extending Rental',
        content: 'Rental extensions require sending a new separate request on Hygglo — we then reconfirm availability. Can\'t just extend the existing booking.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Damage During Rental',
        content: 'If gear breaks during rental: contact us immediately. Covered by Hygglo rental protection for accidental damage — renter is not personally liable unless it\'s negligence.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Tripods',
        content: 'Tripods are available as an add-on — not included by default with camera rentals.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Atomos Ninja V as Monitor',
        content: 'The Atomos Ninja V works great as a standalone 5" HDR monitor even without recording — just plug in via HDMI.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Pickup Process',
        content: 'We meet at an agreed central London spot. Quick 5-min handover — we walk through the gear, and you\'re good to go.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Experience Required',
        content: 'No experience needed to use the FX3 or other cinema cameras. They\'re user-friendly — anyone can pick up and shoot.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - JBL Speakers Outdoors',
        content: 'JBL Club 120 speakers are portable with built-in rechargeable batteries and Bluetooth — perfect for outdoor events. Just be mindful of noise regulations.',
        importance: 7,
      },

      // === EDGE CASE FAQ (Batch 2) ===
      {
        memory_type: 'fact',
        subject: 'FAQ - Late Return / Won\'t Make It On Time',
        content: 'If the renter is past the rental date and past the latest return slot, or the next available slot is not available, they need to extend the rental for a fee. The fee is an extra day on all items rented and must be requested via Hygglo. Failure to extend will result in an insurance case being opened and possibly a holding deposit placed on the account until resolved.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Gear Walkthrough on Pickup',
        content: 'We do not provide on-site tutorials or gear walkthroughs at pickup. Renters should watch YouTube tutorials beforehand to familiarise themselves with the equipment.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Keeping the SD Card',
        content: 'No — the SD card must be returned with the gear. It is not included as a freebie to keep.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Getting Footage Off Camera',
        content: 'Remove the SD card from the camera and use a card reader on your laptop to transfer footage. Most modern laptops have USB-C or USB-A ports that work with standard card readers.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Early Pickup (Night Before)',
        content: 'If available, yes — early pickup the evening before is free for rentals earning £50+/day. For smaller rentals, a small fee applies. However it\'s either pickup the day before OR return the day after that\'s free, not both together. Both = extra rental day.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Third Party Pickup',
        content: 'Yes, someone else can pick up or return on behalf of the renter. They will need the booking reference number, and the renter must message us in the chat when the third party arrives at the pickup spot.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Cancellation Policy',
        content: 'Hygglo\'s cancellation policy applies. We do not have our own separate cancellation terms — refer the renter to the Hygglo platform terms.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Gear Malfunction During Rental',
        content: 'If gear isn\'t working: first troubleshoot (check battery, restart, check settings). If still broken, contact us immediately via the chat. Do not force anything or attempt repairs.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Lens Only Rental',
        content: 'Yes, you can rent just a lens without a camera body — but minimum spend applies.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Deposit',
        content: 'We do not charge a deposit. No upfront deposit required for any rental.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Lost or Missing Accessory',
        content: 'Everything must be returned in the next possible time frame the renter is free, and within 24 hours. If not returned within that window, the replacement cost will be invoiced.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Commercial Use',
        content: 'Yes, the gear can be used for commercial or paid projects. No restrictions on how the equipment is used.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Recording Format / Editing Software',
        content: 'Recording format depends on the camera. Sony FX3/A7 shoot XAVC S (H.264/H.265) — works in any editor. BMPCC shoots Blackmagic RAW — needs DaVinci Resolve (free) or BRAW plugin for Premiere. All footage is editable in Premiere Pro and DaVinci Resolve.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Weather / Rain',
        content: 'The gear is not waterproof. If shooting outdoors in rain or bad weather, use rain covers. Rain covers are not provided — the renter needs to bring their own.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Off-Hours Pickup',
        content: 'Off-hours pickup is not possible. Pickup and return slots are strictly 10am-12pm and 7-9pm only.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Student Discount',
        content: 'No student discount available. However, there are no restrictions — students, professionals, and hobbyists are all welcome to rent.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Ship / Courier Return',
        content: 'Yes, delivery/courier return is possible but must be booked by us and at extra cost. Give us your postcode and we\'ll quote the delivery. Deliveries must also be placed during opening hours.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Optional Items in Listing',
        content: 'Optional items listed in a bundle are NOT included by default — they are removed from the set unless the renter specifically asks for them. If requested, they will be added at no extra cost.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Half-Day Rental',
        content: 'No half-day rates available. The minimum rental period is one full day, even if the gear is only needed for a few hours.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Battery Charge Level at Pickup',
        content: 'Batteries may not be fully charged at pickup — this is not guaranteed. Chargers are included with the rental, so renters should charge batteries themselves before the shoot.',
        importance: 7,
      },

      // === HIGH-RISK EDGE CASE FAQ (Batch 3) ===
      {
        memory_type: 'fact',
        subject: 'FAQ - Address / Where Do I Go',
        content: 'Before booking is verified: only say "Trafalgar Square area — exact address sent after booking is confirmed." After verified: give the meeting point (Statue of James II, 11 Trafalgar Square). NEVER reveal the real storage address (23 Whitcomb St) or use words like "warehouse" or "storage." The statue IS the pickup/return point as far as renters know.',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Off-Platform / Direct Payment',
        content: 'All rentals MUST be booked and paid through Hygglo — no exceptions. Off-platform payment means no insurance coverage for either party. The Revolut link is ONLY for delivery fees, late fees, and surcharges — never for the rental itself. If a renter asks to pay directly or in cash, explain that everything goes through the platform for both parties\' protection.',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Other Renters / When Item Returns',
        content: 'NEVER reveal other renters\' booking dates, names, return times, or any details. Say "it\'s currently out on another rental" or "not available for those dates." Offer the closest alternative item or suggest different dates. Privacy of all renters is absolute.',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Are You AI / Bot / Real Person',
        content: 'NEVER admit to being an AI, bot, or automated system. Always respond as a human team member. Deflect naturally: "Yeah of course! How can I help?" or just answer their actual question without addressing the AI question. Maintain the human persona at all times.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Swap Items on Existing Booking',
        content: 'Item swap requests on existing bookings must always be escalated to Daniel. Do not attempt to swap items yourself or tell the renter it\'s done. Inform the renter you\'re checking with the team and will get back to them.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Gear Condition / Photos',
        content: 'All gear is professional-grade and may show normal signs of use but is fully functional and regularly inspected. Do not promise to send custom photos or make specific condition claims like "brand new" or "mint." Refer to listing photos as representative. Be honest: gear is well-used professional equipment, fully working.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Invoice / Receipt',
        content: 'Hygglo provides all rental invoices — renters can find them in the app\'s Profile section. We can only invoice separately for delivery fees (via Revolut). Do not promise to generate custom invoices or receipts for the rental itself.',
        importance: 7,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Damage Photo Sent During Rental',
        content: 'When a renter sends a photo or reports damage during a rental: acknowledge it ("Thanks for letting us know — I\'ve flagged this with the team and someone will get back to you shortly"), do NOT attempt to assess damage or promise outcomes, and escalate to Daniel immediately with critical priority. Never promise free replacement, refunds, or insurance coverage specifics.',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Items Not In Stock / Unlisted Items',
        content: 'If an item is not on the master inventory list, we do not have it. Say "we don\'t currently stock that" and suggest the closest alternative from our inventory. NEVER promise to source, order, or acquire items we don\'t have. NEVER say "let me check" and leave it unresolved — give a definitive answer.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'FAQ - Location Mismatch / Why Different Address',
        content: 'If a renter asks why the listing says a different location (Shoreditch, Camden, etc.) but you said Trafalgar Square: use a natural excuse — "that unit is out on rental from that branch" or "pulled in for maintenance at our central hub" or "consolidating pickups at Trafalgar Square today." Offer the central branch + mention any applicable distance discount. NEVER say locations are fake, marketing-only, or that all gear is in one place.',
        importance: 10,
      },

      // === AVAILABILITY LOGIC ===
      {
        memory_type: 'fact',
        subject: 'Availability Check Procedure',
        content: 'Before confirming ANY item availability: 1) Check master inventory stock count. 2) Check all active/upcoming rentals on BOTH accounts for that item. 3) Decompose bundles into individual items and check each. 4) Account for invisible overlaps (day-before pickup, day-after return). 5) Ensure 1-hour buffer between return and next pickup. 6) If item shows in listing but quantity shows a different spec (e.g. "70-200mm f4" but we only have f2.8), recognize they are the same physical item. 7) Keep all checks internal - only share result with renter.',
        importance: 10,
      },

      // === ITEM SIZING FOR COURIER ===
      {
        memory_type: 'fact',
        subject: 'Item Size Categories for Courier',
        content: 'XS (Motorcycle OK): Wireless mics, SD cards, filters, small accessories, ND filters. S (Motorcycle OK): Camera bodies (FX3, A7III etc), single lenses, small monitors, follow focus. M (Small Car): DJI Mavic 3 Pro (Fly More case ~45x35x20cm), Sony GM 70-200mm f2.8 (hard case ~30cm, 1.5kg), Audio boom mic Sennheiser (boom+windshield ~60cm), gimbal + camera, LED panel single, tripod, power station. L (Small Car): Nanlite 500B, Forza 300, pavotube sets, C-stand, large speakers. XL (Van only if 3+): Smoke machines, DJ controller + speakers, multiple large lights together. Motorcycle threshold: ≤3 total score, max score ≤2, ≤4kg total, ≤2 items.',
        importance: 8,
      },

      // =====================================================
      // DANIEL'S ORIGINAL RULES - EXACT TEXT - HIGHEST PRIORITY
      // =====================================================
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 1 - Two Accounts',
        content: 'There are two accounts: Leo Adams and DB Cinema Rentals. They have different things to say and send and different locations and confirmations needed. Account-specific rules apply separately.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE - Master Inventory 71 Items',
        content: 'Full master inventory with max quantities (shared across both accounts): Anamorphic Blazar Remus 33mm:1, 45mm:1, 65mm:1, 100mm:1. Anamorphic Great Joy lens 35mm:1, 50mm:1, 85mm:1. Sony GM 24-70mm f2.8:4, 16-35mm f2.8:1, 70-200mm f2.8:2, 90mm f2.8:1. Sony 28-70mm:2. Canon EF 24-105mm f4:1, 16-35mm f2.8:1. Sony 11mm f2.8 fisheye:1. Sony FX3:3, A7 III:1, A7 II:1. Fujifilm X100 VI:1. BMPCC 6K Pro:1, BMPCC 6K Full Frame:1. Softbox 85cm:2. V-mount 95mAh:2, 150mAh:4. C-stand:1. DJI Osmo Action Pro 5:3. DJI Mavic 3 Pro:1. LED light panels RGB:3. DJI gimbal battery:3. Hollyland Mars 4K transmitter:1. GoPro 12 Hero:3. Suction cups:6. Nanlite Forza 300:1. Rode Video Mic Go:1. Camera flash:1. Rode Wireless Mic Pro set:2. Audio boom mic Sennheiser:1. DJI Wireless Mics:1. Smoke machine fogger:1. Motorized slider:1. ND filter:3. 256GB card:3. Atomos Ninja V:1. DJI Mini 4 Pro:1. Cinebloom filter mist:1. Rode Video Mic Pro Plus:1. Nanlite Pavotube 30x II:4. Small rig tripod:3. Nanlite 500B:1. JBL wireless microphones:1. Smoke Ninja Pro hazer:1. DJ RX3 Pioneer controller:1. PL to Sony E mount:2. Anker Power Station F2000:1. Hollyland Pyro S transmitter:1. Hollyland 7-inch monitor:1. PL to EF mount:1, RF mount:1, L mount:1. DJI Mic 2 wireless:1. Sirui tripod:1. CF Express Type A card:1. JBL Club 120 speaker:2. Ambitful RGB light tubes 2x set:2. Smoke Ninja:1. Tilta Nucleus Nano 2 follow focus:1. Sony NPF 970 batteries 2x sets:4. Monopod arm support:1. 5-in-1 reflector panel:1. Tilta shoulder rig:1. DJI RS3 Pro gimbal:2.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 2 - Cross-Account Stock',
        content: 'Some items are listed multiple times and available in sets and different combinations. Dont argue with renters when they claim its available. All that matters is the master inventory checklist cross-referenced across ALL accounts as they share the same equipment quantity. If something is booked on one account for a timeframe, it will be unavailable on the other for that time.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 3 - Free Days Vacation',
        content: 'Some days Daniel wont want to work or certain times. He will inform you and you craft a response that only triggers when that time/date is requested, telling them that time wont be available and to return in the morning time slot the day after. If those days already have booked rentals, inform Daniel when he tells you he wants to be free, listing the rentals and times on that day.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 4 - Unavailable Item Alternatives',
        content: 'If an item is not or never available, go through listings and check what items ARE available that fit the renters needs. Recommend the next best closest alternative and try to upsell kindly. PRICING: When offering a slight upgrade or downgrade, quote the MIDPOINT price between the requested item and the alternative (e.g. requested £30/day + alternative £40/day = quote £35/day). This only applies to the substituted item — other items in the order stay at normal price. If they agree, change the requested items to the available ones and ask them to confirm. If no request sent yet, tell them to send one first so you can change items.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 5 - Additional Items',
        content: 'Sometimes renters request additional items. Check in the master list if available, and only add items if confirmed available on all accounts. Update them about what was changed once completed.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 6 - Availability Confirmation',
        content: 'For confirmed availability: check internal item quantity list, all connected Fat Llama accounts, current active rentals and when items will be back, and all upcoming rentals. Keep a log and check every time before confirming. Monitor progress of rental booking requests. Once booking is confirmed and ready for pickup, inform any renters you accepted but havent booked yet IF: 1) the item is booked in overlapping time without 1hr buffer, or 2) item is fully booked out. Offer alternatives or cancel. Also check item is not in "doesnt exist / not in stock" category.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 7 - Discounts',
        content: 'Distance discount is determined by LISTING_LOCATION in rental context — NEVER ask the renter where they are based. If listing is non-central (Shoreditch, Camden, Hackney, etc.), the 10% discount applies automatically. Delivery postcode is for delivery quotes only, NOT discount decisions. Other discounts are applied automatically when they send a request. NEVER reveal specific discount thresholds or percentages to renters — these are internal business rules.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 8 - Uncertainty',
        content: 'If you encounter an edge scenario that was not discussed, do NOT auto reply. Text Daniel and ask for instructions or confirmation.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 9 - Logging and Observing',
        content: 'Keep a log of every rental request with basic stats: item, time, whether it converted to successful rental or not and the reason why. Once every week give Daniel a quick breakdown and analysis on the week, note anything specific to optimize rentals and generate more revenue. Flag unused/unrented items on monthly review. Reference previous logs for long-term trends.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 10 - Minimum Rental Value',
        content: 'If rental revenue is small, first suggest relevant add-ons naturally. If renter declines all add-ons, offer that the booking total will be adjusted to process — never reveal the internal threshold figure or earnings. NEVER tell the renter there is a minimum rental value by name.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 11 - Cancellation Requests',
        content: 'NEVER automatically accept cancellation requests. Always text the renter and ask for the reason. Tell them a request has been sent to the department head. Then inform Daniel and ask for his response.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 12 - Booking Must Be Complete',
        content: 'A booking has to be fully booked and accepted before item handover.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 13 - Sets and Minimum Packages',
        content: 'When items are rented in sets, remove them from availability as singular items and all other items associated with the order for that timeframe. Sony cameras come with 3x NP-FZ100 batteries and 128GB card. Blackmagic cameras (BMPCC 6K Pro, BMPCC 6K Full Frame) each come with 5x LP-E6NH batteries and 128GB card. Always check item compatibility data for exact included items per camera. This stock needs to be blocked out for that rental timeframe. Do NOT use included batteries as a reason to discourage additional battery or power accessory purchases.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 14 - Verification Help',
        content: 'We do NOT perform verification. It is entirely done by Fat Llama. Kindly ask renters to contact the live chat in the app in the Profile section and ask to talk to an employee. Alternatively, if verification keeps failing, suggest the renter can ask a friend with a verified account (or one with the correct documentation) to place the rental request from their account instead — they just need to mention in the new chat that it is a continuation of the original request so we can link them.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 15 - New Listings',
        content: 'Once a week review new listings that might be profitable based on the weeks rental review, market research, other Fat Llama accounts, rental and review frequency, and publicly available data. Present recommendations to Daniel as packages to approve. If approved, create listing image using Bazaart matching account-specific font/look/color. After Daniel signs off on image, create the listing. Orient pricing on existing similar listings. Description uses account-specific template layout.',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 16 - Repair Items',
        content: 'Sometimes items will be in repair and Daniel will inform you. They must be set to unavailable internally on the list until Daniel informs they are back.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 17 - Conflicts',
        content: 'If renters have issues with items, inform Daniel. If they are late for a return, inform Daniel with options to text them. Look up if this conflicts with other rentals for the same items.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 18 - Availability Logic Detail',
        content: 'If quantity shows "LED panel lights: 3" and a set with 2x lights is rented, only 1 will be available. If 3x lights set is rented, no lights available. Check item images for quantities of items visible. Accessories like drone batteries not listed separately are included automatically. Some listings show "70-200mm f4" but we only have f2.8 - recognize they are the same physical item and block accordingly. Same for gimbal in a set - only RS3 Pro exists, so it blocks one slot. ANY item not on the master list is assumed not in stock.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 19 - Extensions and Late Returns',
        content: 'If renter is delayed (traffic etc) ask for ETA. If ETA is in same time slot (morning/evening are separate), say yes, inform Daniel, update calendar. If outside opening hours, inform Daniel before replying. If not responding and 30min past return, this might be a non-return - inform Daniel. If renter cant return in their slot and needs different slot, check if booking extends to that day. If yes and item available, accept new time. If item not available, inform Daniel. If booking doesnt extend to that day, tell them to send extension request (wait 2hrs to see if they book and pay, if not inform Daniel). HALF-DAY RULE (1-DAY RENTALS ONLY): For 1-day rentals, anything more than a half-day past the booked return is an extension. For multi-day rentals, any return past the booked slot is an extension. Always suggest the earliest return slot first.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE 20 - Same Day Rentals',
        content: 'Same-day rentals: confirm items available, suggest a LATE pickup time (push as late as reasonable for the day). Agree to everything and confirm all details in writing. Once everything is agreed, say "just confirming final details" and hold. Do NOT say the booking is accepted — the system escalates to Daniel for approval, then accepts on Hygglo. If renter asks for updates while waiting, say you are sorting the last bits.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE - General Exceptions',
        content: 'Working hours: 10-12pm and 7-9pm every day unless vacation. Day-before evening pickup or morning-after return: FREE for larger orders, small fee for smaller orders (INTERNAL — never tell renters the surcharge percentage or threshold, just quote the adjusted total). Both day-before pickup AND morning-after return together = extra rental day. Evening next day (instead of morning-after) = always a full extra rental day. If renter times are outside opening hours, tell them and ask to resubmit. When rental is accepted with confirmed dates, add to calendar with 1hr and 2hr reminders. Calendar entry lists: items rented, pickup/dropoff, Leo or DB Cinema. Leo = purple, DB Cinema = blue. IF RENTER TEXTS THEY ARRIVED - always inform Daniel right away. If rental value over £100, check all items available, if true confirm right away and send welcome text. Always check renter reviews - less than 5 stars = escalate to Daniel for approval before accepting. Never send DB Cinema text to Leo account or vice versa. Any other request must be approved by Daniel. If unsure or off-script always ask Daniel.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DANIEL RULE - Delivery Rules',
        content: 'If delivery is required or requested, ask for full postcode and inform Daniel. Orders with more than one light = recommend delivery. DJ deck + speakers TOGETHER = delivery is MANDATORY due to weight/size, inform renters. Speakers alone or DJ deck alone = self-pickup OK, delivery NOT mandatory. If renter booked delivery and has paid and verified, inform Daniel that he needs to book the courier.',
        importance: 10,
      },

      // === EXACT TEMPLATE TEXTS (DB Cinema) ===
      {
        memory_type: 'fact',
        subject: 'DB Cinema Text 4 - Delivery Booking Form',
        content: 'DB Cinema delivery booking text (send ONLY AFTER renter has agreed to delivery and received a price estimate — NEVER send this before giving them a delivery quote first): "For courier pickup/dropoff, please provide: Service (pickup/dropoff/both) | Phone | Email | Full name | Delivery address | Preferred time | Driver notes. Once paid well book & send tracking. Larger items = higher charge due to bigger vehicle. +10% buffer included for driver surcharges. Courier booked on our end only. If youve already received a quote, its all-inclusive. Tight schedule? Ask about priority delivery. Estimates accurate within ~15% - actual price confirmed by courier. No exact times guaranteed (Addison Lee is third-party). No refunds for courier delays or traffic issues. By choosing delivery, you agree to these T&Cs." IMPORTANT: When a renter first asks about delivery, give them a price estimate from the delivery pricing zones FIRST. Only send this form after they agree to proceed.',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Text 5 - Travel Discount',
        content: 'DB Cinema travel discount text (send when location is 20km+ from Trafalgar Square, after welcome text): "This item is currently available in the Trafalgar Square branch for the time you are requesting it for. We see you requested it for a different location we have. To accommodate this and the travel and inconvenience we are happy to discount the rental by 5%. Let us know if that works and we will put it through :)"',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Text 6 - Payment Link',
        content: 'Payment link text (for delivery fees, late fees, broken item fees, early pickup - send ONLY after booking is verified and accepted, NEVER before): "Hey! Kindly follow this link to complete the transaction for the requested amount. Use reference: [late fee / broken item fee / delivery fee / early pickup] based on your case. Confirm here once sent please. https://revolut.me/dbcinema Should the link not work please use these bank details: British Pound, Beneficiary: Daniel Broj, Sort code: 23-01-20, Account number: 52037163, Address: Revolut Ltd, 30 South Colonnade, E14 5HX, London, United Kingdom"',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Text 7 - Price Match',
        content: 'Price match text (ONLY send if renter claims price is too much or is bargaining): "I always want to make sure youre getting the best value when renting with me. If you find the exact same item and package listed by another renter in Zone 1-2 London for the same dates, Ill beat it by 10%. To apply, just send me: 1) A screenshot of the other listing showing the item(s), price, and dates available. 2) A screenshot showing the listings location. Once Ive verified it, Ill adjust your booking here so youre guaranteed the best deal - plus my usual reliable service and support."',
        importance: 10,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Text 8 - Arrival Reminder',
        content: 'Arrival reminder text (send 5 min before scheduled arrival): "When you arrive at Trafalgar Square, wait by the Statue of James II next to the Sainsburys Wing entrance of the National Gallery & text arrived in this chat - well be right with you. PLEASE DONT GO IN ANYWHERE. Location: https://share.google/G28UkWpFMDB2BDVWi If someone else picks up, forward this - they need the booking number or screenshot of this chat."',
        importance: 10,
      },

      // === HYGGLO/FAT LLAMA PRICING DATA ===
      {
        memory_type: 'fact',
        subject: 'Hygglo Fee Structure & Discount Tiers',
        content: 'INTERNAL ONLY — NEVER share any of this with renters. Volume discounts auto-applied: 3 days = price of ~2.5 days, 7 days = price of ~5 days, 1 month = price of ~2.5 weeks. When quoting renters, use the listed daily price as reference and mention discounts apply for longer rentals. NEVER reveal owner commission rates, platform fees, service fee percentages, or net earnings to renters.',
        importance: 9,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals - Individual Item Prices (Cameras)',
        content: 'DB Cinema listing prices (per day). CAMERAS: Sony FX3 body £34-40/day. Sony A7 IV body £15-35/day. Sony A7 II + 28-70mm kit £16-28/day. Sony A7 III body £20-30/day. Fujifilm X100 VI £30-45/day. BMPCC 6K Pro body £35-50/day. BMPCC 6K Full Frame body £35-50/day. ACTION CAMERAS: 2x DJI Osmo Action 5 Pro £26-33/day. GoPro Hero 12 Black £16-18/day. 3x GoPro Hero 12 set £30-40/day. NOTE: These are ESTIMATES from real listings - actual prices may vary by date/availability. Always present as estimates to renters.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals - Individual Item Prices (Lenses)',
        content: 'DB Cinema listing prices (per day). LENSES: Sony GM 24-70mm f2.8 £14-20/day. Sony GM 70-200mm f2.8 £16-22/day. Sony GM 16-35mm f2.8 £14-20/day. Sony 90mm f2.8 Macro £10-15/day. Canon EF 24-105mm f4 £8-12/day. Canon EF 16-35mm f2.8 £12-18/day. Sony 28-70mm f3.5-5.6 £5-8/day (kit lens). Sony 11mm f1.8 APS-C £8-12/day. Blazar Remus 33mm 1.5x Anamorphic £26-30/day. MOUNT ADAPTERS: PL to Sony E mount £8-12/day. PL to EF mount £8-10/day. PL to RF mount £8-10/day. PL to L mount £8-10/day. NOTE: Estimates from real listings.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals - Individual Item Prices (Drones & Gimbals)',
        content: 'DB Cinema listing prices (per day). DRONES: DJI Mavic 3 Pro (Fly More Combo) £36-37/day. DJI Mini 4 Pro £18-22/day. GIMBALS: DJI RSC2 gimbal £14-20/day. DJI RS3 Pro gimbal £18-25/day. DJI RS4 Pro gimbal £19-30/day. Tilta Nucleus Nano 2 follow focus £10-15/day. SLIDERS & RIGS: Motorized camera slider £21-26/day. Tilta shoulder rig £14-20/day. NOTE: Estimates from real listings.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals - Individual Item Prices (Audio)',
        content: 'DB Cinema listing prices (per day). AUDIO: Rode Wireless Pro mic set £17-26/day. Audio boom mic Sennheiser £17-27/day. DJI Mic wireless (single) £14-15/day. DJI Mic 2 wireless £15-18/day. Rode VideoMic Go £5-8/day. Rode VideoMic Pro Plus £8-12/day. JBL wireless microphones (conference) £10-15/day. NOTE: Estimates from real listings.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals - Individual Item Prices (Lighting & Effects)',
        content: 'DB Cinema listing prices (per day). LIGHTING: Nanlite 500B LED £19-30/day. Nanlite Forza 300 £20-30/day. Nanlite Pavotube 30x II (single) £12-18/day. 2x Nanlite Pavotube 30x II set £20-30/day. 4x Nanlite Pavotube 30x II set £35-50/day. Ambitful RGB light tubes 2x set £4-18/day. 3x RGB LED panels £15-25/day. Softbox 85cm £5-8/day. C-stand £5-8/day. EFFECTS: Smoke machine fogger £21-27/day. Smoke Ninja Pro hazer £25-35/day. 5-in-1 reflector panel £5-7/day. NOTE: Estimates from real listings.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals - Individual Item Prices (Monitors, Power, Accessories)',
        content: 'DB Cinema listing prices (per day). MONITORS & TX: Hollyland Mars 4K wireless transmitter £13-25/day. Hollyland Pyro S transmitter £15-20/day. Hollyland 7-inch monitor £15-20/day. Atomos Ninja V 5" monitor £15-20/day. POWER: 2x V-mount batteries 95mAh £11-15/day. 4x V-mount batteries 150mAh £20-28/day. Anker Power Station F2000 £25-35/day. Sony NPF 970 battery 2x sets £5-8/day. ACCESSORIES: 3x 256GB SD cards £5-8/day. CF Express Type A card £8-12/day. 3x ND filters £5-8/day. Cinebloom mist filter £5-7/day. Suction cups (various) £5-10/day. Small rig tripod £5-8/day. Sirui tripod £8-12/day. Monopod arm support £5-8/day. Camera flash £5-8/day. NOTE: Estimates from real listings.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals - Individual Item Prices (Speakers & DJ)',
        content: 'DB Cinema listing prices (per day). SPEAKERS & DJ: 2x JBL Club 120 speakers £39-49/day. Pioneer DJ RX3 controller £40-55/day. NOTE: Delivery MANDATORY only when DJ deck + speakers booked TOGETHER. Speakers alone = self-pickup OK. Estimates from real listings.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals - Bundle Prices (Camera Kits)',
        content: 'DB Cinema BUNDLE listing prices (per day). Bundles are pricing tiers, NOT stock quantities. CAMERA BUNDLES: Sony FX3 + 24-70mm GM £41-60/day. Sony FX3 + 24-70mm GM + DJI RS gimbal £40-70/day. Sony FX3 Full Production Kit (body + GM lens + gimbal + wireless mic + monitor + accessories) £100-120/day. 2x Sony FX3 set (two bodies) £57-90/day. Sony A7 IV + 24-70mm GM £25-40/day. BLACKMAGIC BUNDLES: BMPCC 6K Pro Cinema Kit (body + lenses + gimbal + monitor + accessories) £79-140/day. BMPCC 6K Pro Interview Kit (body + lens + lighting + mic) £57-75/day. NOTE: Estimates from real listings. Multi-day discounts apply automatically.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'DB Cinema Rentals - Bundle Prices (Lens & Specialty Kits)',
        content: 'DB Cinema BUNDLE listing prices (per day). ANAMORPHIC BUNDLES: Great Joy anamorphic set (35mm+50mm+85mm) £50-99/day. Blazar Remus 4-lens anamorphic set £80-120/day. Atlas Mercury anamorphic set £143-300/day. LENS BUNDLES: Sony GM triple lens set (16-35 + 24-70 + 70-200) £35-55/day. Canon EF triple set £25-40/day. DJ & SPEAKER BUNDLES: JBL speakers + Pioneer DJ RX3 controller set £79-100/day (delivery mandatory). LIGHTING BUNDLES: Interview lighting kit (2x lights + stands) £25-40/day. Full lighting kit (Forza 300 + pavotube set + stands) £50-70/day. NOTE: Estimates from real listings.',
        importance: 8,
      },
      {
        memory_type: 'fact',
        subject: 'Quoting Instructions - Always Reference Listing Prices',
        content: 'When a renter asks about pricing or you need to quote: 1) ALWAYS reference the DB Cinema listing prices stored in memory. 2) Present prices as ESTIMATES - say "runs around £X/day" or "usually about £X/day". 3) NEVER mention platform fees, service fees, Hygglo fees, or any percentage added at checkout. 4) For longer rentals, mention discounts apply for longer bookings. 5) NEVER reveal owner commission rates, net profit, discount thresholds, or internal pricing formulas. 6) If a bundle exists that covers what they need, recommend it as it is usually better value. 7) Give the price estimate DIRECTLY - do NOT tell them they need to send a rental request just to get a quote. A rental request is only needed when they want to proceed with booking. 8) Add-on items within bundles may be available at reduced rates compared to standalone listing prices. 9) CRITICAL: Always quote the INDIVIDUAL item price when asked about a single item. NEVER confuse bundle prices with individual item prices. For example, a single Sony GM 24-70mm lens is £14-20/day — do NOT quote the FX3+lens bundle price of £41-60/day for just the lens.',
        importance: 9,
      },
    ];

    for (const mem of memories) {
      await this.prisma.memory.create({ data: mem });
    }

    this.logger.log(`Seeded ${memories.length} critical memories`);
  }

  private async ensureUpdatedMemories() {
    const patches: { subject: string; missingFragment: string; updatedContent: string }[] = [
      {
        subject: 'DANIEL RULE 13 - Sets and Minimum Packages',
        missingFragment: '5x LP-E6NH',
        updatedContent:
          'When items are rented in sets, remove them from availability as singular items and all other items associated with the order for that timeframe. Sony cameras come with 3x NP-FZ100 batteries and 128GB card. Blackmagic cameras (BMPCC 6K Pro, BMPCC 6K Full Frame) each come with 5x LP-E6NH batteries and 128GB card. Always check item compatibility data for exact included items per camera. This stock needs to be blocked out for that rental timeframe. Do NOT use included batteries as a reason to discourage additional battery or power accessory purchases.',
      },
      {
        subject: 'DANIEL RULE 19 - Extensions and Late Returns',
        missingFragment: 'HALF-DAY RULE',
        updatedContent:
          'If renter is delayed (traffic etc) ask for ETA. If ETA is in same time slot (morning/evening are separate), say yes, inform Daniel, update calendar. If outside opening hours, inform Daniel before replying. If not responding and 30min past return, this might be a non-return - inform Daniel. If renter cant return in their slot and needs different slot, check if booking extends to that day. If yes and item available, accept new time. If item not available, inform Daniel. If booking doesnt extend to that day, tell them to send extension request (wait 2hrs to see if they book and pay, if not inform Daniel). HALF-DAY RULE (1-DAY RENTALS ONLY): For 1-day rentals, anything more than a half-day past the booked return is an extension. For multi-day rentals, any return past the booked slot is an extension. Always suggest the earliest return slot first.',
      },
      {
        subject: 'DANIEL RULE - General Exceptions',
        missingFragment: 'FREE for rentals over',
        updatedContent:
          'Working hours: 10-12pm and 7-9pm every day unless vacation. Day-before evening pickup or morning-after return: FREE for larger orders, small fee for smaller orders (INTERNAL — never tell renters the surcharge percentage or threshold). Both day-before pickup AND morning-after return together = extra rental day. Evening next day (instead of morning-after) = always a full extra rental day. If renter times are outside opening hours, tell them and ask to resubmit. When rental is accepted with confirmed dates, add to calendar with 1hr and 2hr reminders. Calendar entry lists: items rented, pickup/dropoff, Leo or DB Cinema. Leo = purple, DB Cinema = blue. IF RENTER TEXTS THEY ARRIVED - always inform Daniel right away. If rental value over £100, check all items available, if true confirm right away and send welcome text. Always check renter reviews - less than 5 stars = escalate to Daniel for approval before accepting. Never send DB Cinema text to Leo account or vice versa. Any other request must be approved by Daniel. If unsure or off-script always ask Daniel.',
      },
    ];

    for (const patch of patches) {
      const existing = await this.prisma.memory.findFirst({
        where: { subject: patch.subject },
      });
      if (existing && !existing.content.includes(patch.missingFragment)) {
        await this.prisma.memory.update({
          where: { id: existing.id },
          data: { content: patch.updatedContent },
        });
        this.logger.log(`Patched stale memory: ${patch.subject}`);
      }
    }

    // Replace stale content that leaks internal rules to renters
    const staleReplacements: { subject: string; staleFragment: string; updatedContent: string }[] = [
      {
        subject: 'DANIEL RULE - General Exceptions',
        staleFragment: '+30% surcharge',
        updatedContent:
          'Working hours: 10-12pm and 7-9pm every day unless vacation. Day-before evening pickup or morning-after return: FREE for larger orders, small fee for smaller orders (INTERNAL — never tell renters the surcharge percentage or threshold, just quote the adjusted total). Both day-before pickup AND morning-after return together = extra rental day. Evening next day (instead of morning-after) = always a full extra rental day. If renter times are outside opening hours, tell them and ask to resubmit. When rental is accepted with confirmed dates, add to calendar with 1hr and 2hr reminders. Calendar entry lists: items rented, pickup/dropoff, Leo or DB Cinema. Leo = purple, DB Cinema = blue. IF RENTER TEXTS THEY ARRIVED - always inform Daniel right away. If rental value over £100, check all items available, if true confirm right away and send welcome text. Always check renter reviews - less than 5 stars = escalate to Daniel for approval before accepting. Never send DB Cinema text to Leo account or vice versa. Any other request must be approved by Daniel. If unsure or off-script always ask Daniel.',
      },
      {
        subject: 'Hygglo Fee Structure & Discount Tiers',
        staleFragment: 'Renter pays listed price',
        updatedContent:
          'INTERNAL ONLY — NEVER share any of this with renters. Volume discounts auto-applied: 3 days = price of ~2.5 days, 7 days = price of ~5 days, 1 month = price of ~2.5 weeks. When quoting renters, use the listed daily price as reference and mention discounts apply for longer rentals. NEVER reveal owner commission rates, platform fees, service fee percentages, or net earnings to renters.',
      },
      {
        subject: 'Quoting Instructions - Always Reference Listing Prices',
        staleFragment: 'Hygglo adds a service fee',
        updatedContent:
          'When a renter asks about pricing or you need to quote: 1) ALWAYS reference the DB Cinema listing prices stored in memory. 2) Present prices as ESTIMATES - say "runs around £X/day" or "usually about £X/day". 3) NEVER mention platform fees, service fees, Hygglo fees, or any percentage added at checkout. 4) For longer rentals, mention discounts apply for longer bookings. 5) NEVER reveal owner commission rates, net profit, discount thresholds, or internal pricing formulas. 6) If a bundle exists that covers what they need, recommend it as it is usually better value. 7) Give the price estimate DIRECTLY - do NOT tell them they need to send a rental request just to get a quote. 8) Add-on items within bundles may be available at reduced rates. 9) CRITICAL: Always quote the INDIVIDUAL item price when asked about a single item. NEVER confuse bundle prices with individual item prices.',
      },
      {
        subject: 'DANIEL RULE 7 - Discounts',
        staleFragment: 'over £350 profit',
        updatedContent:
          'Distance discount is determined by LISTING_LOCATION in rental context — NEVER ask the renter where they are based. If listing is non-central, the 10% discount applies automatically. Delivery postcode is for delivery quotes only, NOT discount decisions. Other discounts are applied automatically when they send a request. NEVER reveal specific discount thresholds or percentages to renters — these are internal business rules.',
      },
      {
        subject: 'DANIEL RULE 10 - Minimum Rental Value',
        staleFragment: 'just upsell naturally',
        updatedContent:
          'If rental revenue is small, first suggest relevant add-ons naturally. If renter declines all add-ons, offer that the booking total will be adjusted to process — never reveal the internal threshold figure or earnings. NEVER tell the renter there is a minimum rental value by name.',
      },
    ];

    for (const replacement of staleReplacements) {
      const existing = await this.prisma.memory.findFirst({
        where: { subject: replacement.subject },
      });
      if (existing && existing.content.includes(replacement.staleFragment)) {
        await this.prisma.memory.update({
          where: { id: existing.id },
          data: { content: replacement.updatedContent },
        });
        this.logger.log(`Replaced stale content in memory: ${replacement.subject}`);
      }
    }
  }

  async storeConversation(chatId: string, role: string, content: string, metadata?: any) {
    // Dedup: skip if an identical message was already stored in the last 60 seconds
    const cutoff = new Date(Date.now() - 60_000);
    const existing = await this.prisma.conversation.findFirst({
      where: {
        chat_id: chatId,
        role,
        content,
        created_at: { gte: cutoff },
      },
    });
    if (existing) {
      this.logger.debug(`Skipping duplicate conversation entry for ${chatId} (role=${role})`);
      return existing;
    }

    return this.prisma.conversation.create({
      data: { chat_id: chatId, role, content, metadata },
    });
  }

  async getConversationHistory(chatId: string, limit = 30): Promise<{ role: 'user' | 'assistant'; content: string; timestamp?: Date }[]> {
    // Fetch more than needed so we can build a facts summary from older messages
    const fetchCount = Math.max(limit * 5, 30);
    const messages = await this.prisma.conversation.findMany({
      where: { chat_id: chatId },
      orderBy: { created_at: 'desc' },
      take: fetchCount,
      select: { role: true, content: true, created_at: true },
    });

    const ordered = messages
      .reverse()
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, timestamp: m.created_at }));

    // Retrieval-side dedup: filter out consecutive identical messages (handles pre-fix duplicates)
    const deduped = ordered.filter((m, i) =>
      i === 0 || m.role !== ordered[i - 1].role || m.content !== ordered[i - 1].content,
    );

    // If within limit, return as-is
    if (deduped.length <= limit) {
      return deduped;
    }

    // Compress: keep `limit` recent messages, extract facts from older ones
    return this.compressOldMessages(deduped, limit);
  }

  /**
   * Compress older messages into a facts summary.
   * Keeps `recentCount` recent messages intact, extracts key facts from older messages.
   */
  private compressOldMessages(
    messages: { role: 'user' | 'assistant'; content: string; timestamp?: Date }[],
    recentCount = 3,
  ): { role: 'user' | 'assistant'; content: string; timestamp?: Date }[] {
    const older = messages.slice(0, messages.length - recentCount);
    const recent = messages.slice(messages.length - recentCount);

    // Extract facts from older messages (items, dates, names, prices, decisions)
    const facts = new Set<string>();
    const allText = older.map(m => m.content).join(' ');

    // Extract item mentions (camera/lens/light gear patterns)
    const itemMatches = allText.match(/\b(Sony|Canon|Blackmagic|Nanlite|Aputure|DJI|Sennheiser|Rode|SmallRig|Hollyland|Atomos|Tilta|BMPCC|JBL|Pioneer|Anker|DZO|DZOFILM|Nikon|Fujifilm|Panasonic|RED|ARRI)\s+[\w\-\s]+(?=[\.,!?\s])/gi);
    if (itemMatches) itemMatches.slice(0, 8).forEach(m => facts.add(`Item: ${m.trim()}`));

    // Extract dates (multiple formats)
    const dateMatches = allText.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\b/gi);
    if (dateMatches) dateMatches.slice(0, 4).forEach(m => facts.add(`Date: ${m}`));
    const dateAlt = allText.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}(?:st|nd|rd|th)?\b/gi);
    if (dateAlt) dateAlt.slice(0, 2).forEach(m => facts.add(`Date: ${m}`));

    // Extract prices
    const priceMatches = allText.match(/£\d+[\d,]*(?:\.\d{2})?(?:\s*\/\s*day)?/g);
    if (priceMatches) priceMatches.slice(0, 4).forEach(m => facts.add(`Price: ${m}`));

    // Extract names (from renter messages — first capitalized word after greeting)
    const nameMatch = allText.match(/(?:I'm|my name is|I am|this is|name'?s)\s+([A-Z][a-z]+)/i);
    if (nameMatch) facts.add(`Renter name: ${nameMatch[1]}`);

    // Extract delivery/location info
    const postcodeMatch = allText.match(/\b[A-Z]{1,2}\d{1,2}\s*\d[A-Z]{2}\b/i);
    if (postcodeMatch) facts.add(`Postcode: ${postcodeMatch[0].toUpperCase()}`);
    const locationMatch = allText.match(/\b(?:based in|located in|coming from|I'm in|address is|near)\s+([^.,!?\n]{3,40})/i);
    if (locationMatch) facts.add(`Location: ${locationMatch[1].trim()}`);

    // Extract project/purpose — critical for gear recommendations
    const projectMatch = allText.match(/\b(?:for|shooting|filming|doing|working on|it'?s a|it'?s for|project is|making|producing)\s+(a\s+)?([^.,!?\n]{3,50})/i);
    if (projectMatch) facts.add(`Project: ${projectMatch[2].trim()}`);
    const useCases = allText.match(/\b(wedding|interview|documentary|music video|short film|corporate|event|commercial|youtube|podcast|live stream|concert|conference|real estate|property|fashion|brand|indie film|content|vlog|behind the scenes|BTS)\b/gi);
    if (useCases) {
      const unique = [...new Set(useCases.map(u => u.toLowerCase()))];
      unique.slice(0, 3).forEach(u => facts.add(`Use case: ${u}`));
    }

    // Extract agreed preferences (pickup/delivery, times)
    const pickupPref = allText.match(/\b(pickup|pick up|collect|self.collect|delivery|deliver|courier|drop off|dropoff)\b/i);
    if (pickupPref) facts.add(`Preference: ${pickupPref[1]}`);
    const timePref = allText.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/gi);
    if (timePref) timePref.slice(0, 3).forEach(t => facts.add(`Time mentioned: ${t}`));

    // Extract concerns, complaints, negotiation stance
    const concerns = allText.match(/\b(?:worried|concerned|issue|problem|unfortunately|damaged|broken|late|delay|cancel|refund|complaint|disappointed|not happy|too expensive|can't afford|budget is|maximum budget|lower price)\b/gi);
    if (concerns) {
      const unique = [...new Set(concerns.map(c => c.toLowerCase()))];
      facts.add(`Renter concerns: ${unique.join(', ')}`);
    }

    // Extract explicit agreements and confirmations
    const agreements = allText.match(/\b(?:agreed|confirmed|sounds good|perfect|yes please|let'?s do it|book it|go ahead|that works|deal)\b/gi);
    if (agreements) facts.add(`Renter agreed/confirmed during conversation`);

    // Extract quantity mentions
    const qtyMatch = allText.match(/\b(\d+)\s*(?:units?|cameras?|bodies|lenses|lights?|mics?|kits?|sets?|pairs?)\b/gi);
    if (qtyMatch) qtyMatch.slice(0, 3).forEach(q => facts.add(`Quantity: ${q}`));

    // DECISIONS & OFFERS: Preserve conditional statements and commitments verbatim
    // These are critical for context and lose meaning when extracted as bare facts
    for (const m of older) {
      if (m.role === 'assistant') {
        // Conditional offers: "if you add X, I'll give you Y"
        const conditionalOffers = m.content.match(/if\s+you\s+(?:add|book|take|rent|extend|include).{10,80}(?:discount|off|free|£\d+|percent|%)/gi);
        if (conditionalOffers) conditionalOffers.slice(0, 2).forEach(o => facts.add(`Offer made: "${o.trim()}"`));
        // Quoted prices with context
        const pricedOffers = m.content.match(/(?:total|quote|come to|looking at|that'?s|would be)\s+[^.]*£\d+[^.]{0,40}/gi);
        if (pricedOffers) pricedOffers.slice(0, 2).forEach(o => facts.add(`Quote: "${o.trim()}"`));
      }
      if (m.role === 'user') {
        // Renter commitments/decisions
        const decisions = m.content.match(/(?:I'?ll take|I want|I'?d like|let'?s go with|I'?ll go for|I prefer|I need|not interested in|don'?t need|skip the).{5,60}/gi);
        if (decisions) decisions.slice(0, 2).forEach(d => facts.add(`Renter decision: "${d.trim()}"`));
      }
    }

    const factsLine = facts.size > 0
      ? `[CONTEXT from ${older.length} earlier messages] ${Array.from(facts).join('. ')}`
      : `[${older.length} earlier messages — general inquiry]`;

    const summary: { role: 'user' | 'assistant'; content: string; timestamp?: Date } = {
      role: 'user',
      content: factsLine,
    };

    // Ensure alternating roles: if recent starts with 'user', insert a synthetic ack
    const result: { role: 'user' | 'assistant'; content: string; timestamp?: Date }[] = [summary];
    if (recent.length > 0 && recent[0].role === 'user') {
      result.push({ role: 'assistant', content: 'Understood, continuing our conversation.' });
    }
    result.push(...recent);

    this.logger.debug(
      `Compressed conversation: ${messages.length} messages → facts + ${recent.length} recent`,
    );
    return result;
  }

  async storeMemory(memoryType: string, subject: string, content: string, importance = 5) {
    // Check for existing memory with same subject to update instead of duplicate
    const existing = await this.prisma.memory.findFirst({
      where: { subject, memory_type: memoryType },
    });

    if (existing) {
      return this.prisma.memory.update({
        where: { id: existing.id },
        data: { content, importance, access_count: existing.access_count + 1 },
      });
    }

    return this.prisma.memory.create({
      data: { memory_type: memoryType, subject, content, importance },
    });
  }

  async getRelevantMemories(keywords: string[], limit = 10): Promise<string> {
    // Get high-importance memories plus keyword-matched ones
    const highImportance = await this.prisma.memory.findMany({
      where: {
        importance: { gte: 7 },
        OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
      },
      orderBy: { importance: 'desc' },
      take: 80,
    });

    let keywordMemories: any[] = [];
    if (keywords.length > 0) {
      keywordMemories = await this.prisma.memory.findMany({
        where: {
          OR: keywords.map((kw) => ({
            OR: [
              { subject: { contains: kw, mode: 'insensitive' as const } },
              { content: { contains: kw, mode: 'insensitive' as const } },
            ],
          })),
          AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }],
        },
        orderBy: { importance: 'desc' },
        take: limit,
      });
    }

    // Merge and deduplicate
    const seen = new Set<string>();
    const allMemories: any[] = [];
    for (const m of [...highImportance, ...keywordMemories]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        allMemories.push(m);
      }
    }

    // Increment access counts
    const ids = allMemories.map((m) => m.id);
    if (ids.length > 0) {
      await this.prisma.memory.updateMany({
        where: { id: { in: ids } },
        data: { access_count: { increment: 1 } },
      });
    }

    if (allMemories.length === 0) return '';

    return allMemories
      .map((m) => `[${m.memory_type}] ${m.subject}: ${m.content}`)
      .join('\n');
  }

  /**
   * Lightweight keyword-only memory search — no blanket high-importance fetch.
   * Use for context where full memories are not needed (e.g., new message handling).
   */
  async getMinimalMemories(keywords: string[], limit = 5): Promise<string> {
    if (keywords.length === 0) return '';

    const memories = await this.prisma.memory.findMany({
      where: {
        OR: keywords.map((kw) => ({
          OR: [
            { subject: { contains: kw, mode: 'insensitive' as const } },
            { content: { contains: kw, mode: 'insensitive' as const } },
          ],
        })),
        AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }],
      },
      orderBy: { importance: 'desc' },
      take: limit,
    });

    if (memories.length === 0) return '';

    // Increment access counts
    const ids = memories.map((m) => m.id);
    await this.prisma.memory.updateMany({
      where: { id: { in: ids } },
      data: { access_count: { increment: 1 } },
    });

    return memories
      .map((m) => `[${m.memory_type}] ${m.subject}: ${m.content}`)
      .join('\n');
  }

  /**
   * Fetch all pricing-related memories (listing prices, fee structure, quoting instructions).
   * Used when a renter asks about pricing, costs, or quotes.
   */
  async getPricingMemories(): Promise<string> {
    const pricingKeywords = ['Item Prices', 'Bundle Prices', 'Fee Structure', 'Quoting Instructions'];

    const memories = await this.prisma.memory.findMany({
      where: {
        OR: pricingKeywords.map((kw) => ({
          subject: { contains: kw, mode: 'insensitive' as const },
        })),
        AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }],
      },
      orderBy: { importance: 'desc' },
    });

    if (memories.length === 0) return '';

    const ids = memories.map((m) => m.id);
    await this.prisma.memory.updateMany({
      where: { id: { in: ids } },
      data: { access_count: { increment: 1 } },
    });

    return memories
      .map((m) => `[${m.memory_type}] ${m.subject}: ${m.content}`)
      .join('\n');
  }

  /**
   * Fetch only template texts for a specific account (DB Cinema or Leo Adams).
   */
  async getAccountTemplates(account: 'dbcinema' | 'leo'): Promise<string> {
    const searchTerm = account === 'dbcinema' ? 'DB Cinema' : 'Leo Adams';

    const templates = await this.prisma.memory.findMany({
      where: {
        subject: { contains: searchTerm, mode: 'insensitive' },
        memory_type: 'fact',
        importance: { gte: 8 },
      },
      orderBy: { importance: 'desc' },
    });

    if (templates.length === 0) return '';

    return templates
      .map((m) => `[${m.memory_type}] ${m.subject}: ${m.content}`)
      .join('\n');
  }

  async getTopMemories(limit = 10) {
    return this.prisma.memory.findMany({
      orderBy: [{ importance: 'desc' }, { access_count: 'desc' }],
      take: limit,
    });
  }

  /**
   * Get the full pricing catalog formatted for AI context.
   * Uses the structured pricing-catalog.ts data file (not database memories).
   */
  getPricingCatalogContext(): string {
    return formatPricingCatalogForAI();
  }

  /**
   * Get compatibility info for specific items, formatted for AI context.
   */
  getCompatibilityContext(itemNames: string[]): string {
    return formatCompatibilityForAI(itemNames);
  }

  /**
   * Get detailed product specs for mentioned items, formatted for AI context.
   */
  getItemSpecsContext(itemNames: string[]): string {
    return formatSpecsForAI(itemNames);
  }

  /**
   * Get relevant bundle suggestions based on message text and mentioned items.
   */
  getBundleSuggestionContext(messageText: string, mentionedItems: string[]): string {
    return formatBundleSuggestionsForAI(messageText, mentionedItems);
  }

  async processAiMemories(memories: string[]) {
    for (const mem of memories) {
      // Simple heuristic: extract subject from first few words
      const words = mem.split(' ');
      const subject = words.slice(0, 5).join(' ');
      await this.storeMemory('pattern', subject, mem, 6);
      this.logger.log(`Stored AI-learned memory: ${subject}`);
    }
  }

  /**
   * Build a 3-line conversation summary via Haiku call.
   * Cached on follow_up_state.conversation_summary, refreshed every 3 new messages.
   */
  async buildConversationSummary(
    rentalId: string,
    chatId: string,
    forceRefresh = false,
  ): Promise<string | null> {
    try {
      const state = await this.prisma.follow_up_state.findUnique({ where: { rental_id: rentalId } });
      if (!state) {
        // No follow_up_state yet — create one so summary can be stored
        try {
          await this.prisma.follow_up_state.create({
            data: { rental_id: rentalId, status: 'active' },
          });
        } catch {
          // May already exist from race condition — ignore
        }
      }

      // Check if we have a recent summary and don't need to refresh
      const messages = await this.prisma.conversation.findMany({
        where: { chat_id: chatId },
        orderBy: { created_at: 'desc' },
        take: 30,
        select: { role: true, content: true, created_at: true },
      });

      const messageCount = messages.length;
      if (!forceRefresh && state?.conversation_summary && messageCount > 0) {
        // Return cached summary if recently built (within 5min) — avoids redundant Haiku calls
        const summaryAge = state.updated_at ? Date.now() - state.updated_at.getTime() : Infinity;
        if (summaryAge < 300_000) return state.conversation_summary;
      }

      // Build summary from even a single message — don't wait for 4
      if (messageCount < 1) return state?.conversation_summary || null;

      const convoText = messages.reverse().map(m =>
        `${m.role === 'user' ? 'Renter' : 'Bot'}: ${m.content.substring(0, 400)}`,
      ).join('\n');

      // Richer summary prompt — captures operational context the bot needs to reply correctly
      const prompt = messageCount === 1
        ? `Summarize this first rental message in 2-3 short lines. Capture:\n- What the renter wants (items, dates, purpose)\n- Any specific requests (delivery, time preferences, questions asked)\n- Their tone (casual, urgent, professional)\n\nMessage:\n${convoText}\n\nRespond with ONLY the summary, no labels.`
        : `Summarize this rental conversation in 4-5 short lines. Capture ALL of these:\n1. Who they are and what they're shooting/using it for\n2. Items discussed, what's confirmed available, what was quoted\n3. What the bot promised or committed to (delivery quotes, times, discounts)\n4. What the renter agreed to, asked about, or is still deciding on\n5. Any concerns, rejections, or unresolved questions\n\nConversation:\n${convoText}\n\nRespond with ONLY the summary, no labels or numbers.`;

      const response = await this.aiService.processExtraction(prompt);

      const summary = response.content.trim();

      // Persist to follow_up_state
      await this.prisma.follow_up_state.update({
        where: { rental_id: rentalId },
        data: { conversation_summary: summary },
      });

      return summary;
    } catch (error) {
      this.logger.debug(`Failed to build conversation summary: ${error.message}`);
      return null;
    }
  }

  /**
   * Get cached conversation summary (no AI call, just DB read).
   */
  async getCachedSummary(rentalId: string): Promise<string | null> {
    try {
      const state = await this.prisma.follow_up_state.findUnique({
        where: { rental_id: rentalId },
        select: { conversation_summary: true, rejected_suggestions: true },
      });
      if (!state) return null;

      let context = '';
      if (state.conversation_summary) {
        context += `CONVERSATION SUMMARY: ${state.conversation_summary}`;
      }
      if (state.rejected_suggestions) {
        context += `\nDon't suggest again: ${state.rejected_suggestions}`;
      }
      return context || null;
    } catch {
      return null;
    }
  }
}
