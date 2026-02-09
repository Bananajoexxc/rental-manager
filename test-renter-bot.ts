/**
 * Test script: Exercises the autonomous renter bot's AI pipeline
 * with the same prompts used for the dashboard/Telegram bot.
 *
 * Builds context EXACTLY as processMessage() does, then calls
 * aiService.processComplex() and logs the response.
 *
 * Usage: npx ts-node test-renter-bot.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { AiService } from './src/ai/ai.service';
import { RulesService } from './src/rules/rules.service';
import { MemoryService } from './src/memory/memory.service';
import { CalendarService } from './src/calendar/calendar.service';
import { RecommendationService } from './src/recommendations/recommendation.service';
import { ConversationStageService } from './src/conversation-tree/conversation-stage.service';
import { PrismaService } from './src/prisma/prisma.service';
import { findBestMatch, getInventoryItemNames, MASTER_INVENTORY } from './src/utils/item-matcher';
import * as fs from 'fs';

// Test prompts — same as dashboard test
const TEST_CASES = [
  { issue: 'Pricing Accuracy', prompt: 'How much is the Sony FX3 per day?' },
  { issue: 'Pricing Accuracy', prompt: "What's the price for renting the BMPCC 6K Pro for 3 days?" },
  { issue: 'Pricing Accuracy', prompt: 'Can I get a quote for the DJI RS3 Pro gimbal and a V-mount battery?' },
  { issue: 'Availability and Schedule', prompt: 'Is the Sony FX3 available this weekend?' },
  { issue: 'Availability and Schedule', prompt: 'I need the Atomos Ninja V tomorrow, can I pick it up at 10am?' },
  { issue: 'Availability and Schedule', prompt: 'What gear do you have available for next Monday to Wednesday?' },
  { issue: 'Bundle Intelligence and Upselling', prompt: "I'm shooting a short film this weekend, I need a cinema camera" },
  { issue: 'Bundle Intelligence and Upselling', prompt: 'I want the Sony FX3, do you have any lenses that go with it?' },
  { issue: 'Bundle Intelligence and Upselling', prompt: "I'll take the FX3 and the 24-70mm lens, anything else I might need?" },
  { issue: 'Rule Compliance', prompt: 'Where exactly are you located? Can I get the address?' },
  { issue: 'Rule Compliance', prompt: 'Are there any platform fees on top of the rental price?' },
  { issue: 'Rule Compliance', prompt: 'How many batteries come with the BMPCC 6K Pro?' },
  { issue: 'Delivery and Complex Queries', prompt: "Can you deliver to East London? I'm in E14" },
  { issue: 'Delivery and Complex Queries', prompt: 'I need the DJ deck and speakers delivered to SW1A 1AA' },
  { issue: 'Delivery and Complex Queries', prompt: 'I want to add the Rode Wireless mic to my existing order, will delivery change?' },
];

// Replicate autonomous bot's keyword extraction
function extractSearchKeywords(text: string, extras: string[] = []): string[] {
  const stopWords = new Set(['i', 'me', 'my', 'the', 'a', 'an', 'is', 'are', 'was', 'be', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'it', 'do', 'does', 'did', 'will', 'can', 'could', 'would', 'have', 'has', 'had', 'this', 'that', 'with', 'from', 'not', 'but', 'so', 'if', 'just', 'about', 'what', 'how', 'when', 'where', 'who', 'which', 'there', 'here', 'very', 'also', 'please', 'thanks', 'thank', 'you', 'your', 'hi', 'hello', 'hey']);
  const words = text.split(/[\s,.\-!?;:()]+/).map(w => w.trim()).filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const w of [...words, ...extras]) {
    const lower = w.toLowerCase();
    if (!seen.has(lower) && w.length > 1) { seen.add(lower); result.push(w); }
  }
  return result.slice(0, 15);
}

// Replicate autonomous bot's item extraction
function extractMentionedItems(text: string): string[] {
  const inventoryNames = getInventoryItemNames();
  const mentioned: string[] = [];
  const segments = text.split(/[,.\n;]+/).map(s => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const match = findBestMatch(segment, inventoryNames);
    if (match && !mentioned.includes(match)) mentioned.push(match);
  }
  const words = text.split(/\s+/).filter(w => w.length > 3);
  for (let i = 0; i < words.length; i++) {
    for (const len of [3, 2, 1]) {
      if (i + len > words.length) continue;
      const phrase = words.slice(i, i + len).join(' ');
      const match = findBestMatch(phrase, inventoryNames);
      if (match && !mentioned.includes(match)) mentioned.push(match);
    }
  }
  return mentioned;
}

async function main() {
  // Bootstrap NestJS in silent mode (suppress HTTP listen)
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  const aiService = app.get(AiService);
  const rulesService = app.get(RulesService);
  const memoryService = app.get(MemoryService);
  const calendarService = app.get(CalendarService);
  const recommendationService = app.get(RecommendationService);
  const prisma = app.get(PrismaService);

  // Pick a real rental for context
  const rental = await prisma.rental.findFirst({
    where: { status: 'pending', start_date: { not: null } },
    orderBy: { created_at: 'desc' },
  });

  if (!rental) {
    console.error('No pending rental found for testing');
    await app.close();
    return;
  }

  console.log(`Using rental: ${rental.title} (${rental.listing_id})`);
  console.log('');

  const results: any[] = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const { issue, prompt } = TEST_CASES[i];
    console.log(`--- Test ${i + 1}/15: [${issue}] ---`);
    console.log(`Prompt: ${prompt}`);

    try {
      // === BUILD CONTEXT EXACTLY AS processMessage() DOES ===

      const keywords = extractSearchKeywords(prompt, ['TestRenter', rental.title]);
      const mentionedItems = extractMentionedItems(prompt);

      // Always load rules (Fix 2)
      const rules = await rulesService.getFormattedRules();

      // Detect pricing/delivery intent
      const pricingTerms = /\b(price|pricing|cost|costs|how much|rate|rates|quote|charge|charges|fee|fees|per day|daily|weekly|monthly|budget|afford|expensive|cheap|discount|deal|£|pound|pounds|rental price|rental rate|what would|total|estimate)\b/i;
      const deliveryTerms = /\b(deliver|delivery|courier|ship|shipping|post|postcode|send it|drop off|dropoff|bring it|transport|how far|distance|collect from|too far|can you bring|come to me)\b/i;
      const hasPricingIntent = pricingTerms.test(prompt);
      const hasDeliveryIntent = deliveryTerms.test(prompt);

      // Always load full memories + both pricing sources (matches production)
      const deliveryKeywords = hasDeliveryIntent ? ['Delivery Pricing Zones', 'Delivery Courier Framework', 'Delivery Rules', 'Delivery Mandatory'] : [];
      const [pricingCatalog, pricingMem, keywordMem, deliveryMem] = await Promise.all([
        Promise.resolve(memoryService.getPricingCatalogContext()),
        hasPricingIntent ? memoryService.getPricingMemories() : Promise.resolve(''),
        memoryService.getRelevantMemories(keywords),
        hasDeliveryIntent ? memoryService.getMinimalMemories(deliveryKeywords, 5) : Promise.resolve(''),
      ]);
      let memories: string = [pricingCatalog, pricingMem, deliveryMem, keywordMem].filter(Boolean).join('\n');

      // Compatibility context
      if (mentionedItems.length > 0) {
        const compatContext = memoryService.getCompatibilityContext(mentionedItems);
        if (compatContext) memories = [memories, compatContext].filter(Boolean).join('\n');
      }

      // Bundle + upsell context
      const recs = await recommendationService.generateRecommendations({
        message: prompt, mentionedItems, conversationText: prompt, estimatedTotal: 25,
      });
      if (recs.bundleContext) memories = [memories, recs.bundleContext].filter(Boolean).join('\n');

      // Inventory limits
      if (mentionedItems.length > 0) {
        const quantityContext = mentionedItems
          .map(item => { const maxQty = MASTER_INVENTORY[item]; return maxQty !== undefined ? `${item}: MAX ${maxQty} units in stock` : null; })
          .filter(Boolean).join(', ');
        if (quantityContext) {
          memories = [memories, `\n--- INVENTORY LIMITS ---\n${quantityContext}\nNEVER confirm more than these maximums.`].filter(Boolean).join('\n');
        }
      }

      // Availability context
      let availabilityContext = '';
      try {
        const upcomingBookings = await calendarService.getAllUpcomingBookings(14);
        if (upcomingBookings) availabilityContext = `\n\n${upcomingBookings}`;
      } catch {}

      if (mentionedItems.length > 0 && rental.start_date && rental.end_date) {
        try {
          const availabilityChecks = await Promise.all(
            mentionedItems.map(async (itemName) => {
              const availability = await calendarService.checkAvailability(itemName, rental.start_date!, rental.end_date!);
              const availableQty = availability.maxQuantity - availability.booked;
              return { itemName, available: availability.available, quantity: availableQty };
            })
          );
          const availableItems = availabilityChecks.filter(a => a.available);
          const unavailableItems = availabilityChecks.filter(a => !a.available);
          if (availableItems.length > 0 || unavailableItems.length > 0) {
            availabilityContext += '\n\n--- LIVE AVAILABILITY CHECK ---\n';
            if (availableItems.length > 0) availabilityContext += 'AVAILABLE: ' + availableItems.map(a => `${a.itemName} (${a.quantity} available)`).join(', ') + '\n';
            if (unavailableItems.length > 0) availabilityContext += 'UNAVAILABLE: ' + unavailableItems.map(a => a.itemName).join(', ') + '\n';
            availabilityContext += 'Use this LIVE data to answer accurately.';
          }
        } catch {}
      }

      // Schedule context (Fix 3)
      let scheduleContext = '';
      try {
        const schedule = await calendarService.getFormattedSchedule(new Date());
        if (schedule) scheduleContext = `\n--- TODAY'S SCHEDULE ---\n${schedule}\nUse this to suggest available pickup/return slots accurately.`;
      } catch {}

      // Pricing/delivery instructions
      const pricingInstruction = hasPricingIntent
        ? `The renter is asking about pricing. Reference the pricing catalog to give an accurate estimate. Always quote the ONE-DAY price (highest listed) and mention multi-day discounts are available. Present as ESTIMATES. Do NOT mention platform fees, service fees, or Hygglo fees. If a relevant bundle exists, suggest it as better value. CRITICAL: Quote INDIVIDUAL item price for single items. NEVER reveal owner margins. Do NOT require a rental request just for a quote.\n`
        : '';
      const deliveryInstruction = hasDeliveryIntent
        ? `The renter is asking about delivery. We only deliver within London (max 30km from Central London). Give a delivery price estimate DIRECTLY based on the delivery pricing zones. Tell them which courier type their items need (motorcycle, car, or van) and briefly explain why. Ask for their postcode if not provided. Do NOT require a booking request before giving a quote. Do NOT send the delivery booking form yet.\n`
        : '';

      // Account-based persona (matches production)
      const accountName = rental.account || 'dbcinema';
      const persona = accountName === 'leo'
        ? 'You are Leo from Leo Adams. Human, kind, slightly chill tone.'
        : 'You are Daniel from DB Cinema Rentals. Professional, concise, human tone.';
      const businessName = accountName === 'leo' ? 'Leo Adams' : 'DB Cinema Rentals';

      const messagePrompt =
        `A renter sent a message on the ${businessName} account. Draft a reply.\n\n` +
        `${persona}\n\n` +
        `Renter: TestRenter\n` +
        `Their message: "${prompt}"\n` +
        `Rental: ${rental.title}\n\n` +
        `${pricingInstruction}` +
        `${deliveryInstruction}` +
        `\nReply following our communication tone rules. Keep it concise, clear, and well-formatted.\n` +
        `NEVER invent or guess prices. Only quote the exact booking price shown below. If you don't know the price, say you'll confirm it.\n` +
        `NEVER mention internal business rules, platform fees, minimum thresholds, or commission structures to the renter.\n` +
        `NEVER mention the name of any rental platform (Hygglo, Fat Llama, etc.) to the renter. If you need to reference the platform, just say "the platform" or "the booking system".\n` +
        `CROSS-ITEM QUERIES: If the renter asks about items NOT in their current booking, answer the question fully and helpfully first. Do NOT lead with "this booking is for X" or "there might be a mix-up." Just answer their question about the item they asked about, then optionally mention they can add it to their booking or create a new request.\n` +
        `INCLUDED ACCESSORIES: When quoting any item, always mention what is included (batteries, cards, plates, adapters, cables). V-mount battery rentals ALWAYS include plates, adapters, and cables — state this explicitly. When quoting V-mount batteries, always mention BOTH the 95mAh and 150mAh options with their different price points.\n` +
        // CRITICAL behavioral reinforcements (matched from Telegram sim mode)
        `IMPORTANT REMINDERS: ` +
        `1) When a renter enquires about items, pricing, or delivery, just give them the information directly. Do NOT tell them to send a rental request just to get information or a quote — a request is only needed when they want to actually book. ` +
        `2) Always tell renters right away that all items are based in Central London (Trafalgar Square area) and collection is from there. ` +
        `3) If the renter mentions their location and it is far from central London (20km+), proactively inform them they are eligible for a 10% travel distance discount. If that is the only discount they qualify for, still mention it. ` +
        `CRITICAL — LOCATION: Do NOT share any specific street address, building name, or postcode. Before booking is confirmed, ONLY say "Central London (Trafalgar Square area)". If they ask for the exact address, say you will share the meetup point once the booking is confirmed. ` +
        `CRITICAL — AVAILABILITY: When live availability data is provided below, you MUST use it to answer accurately. Do NOT state static inventory counts — check the live data for actual bookings. If an item is booked for the requested dates, tell the renter it is unavailable. ` +
        `CRITICAL — DISCLOSURE: Never mention AI, bots, automated systems, Claude, or scanning. Never reveal margins, platform fees, or pricing formulas. Never reveal that DB Cinema and Leo Adams are the same business. ` +
        `CRITICAL — FORMATTING: Do NOT use markdown formatting (no bold, no bullet points, no headers, no dashes as list items). Write plain text only. Use commas or line breaks to separate options, not bullet-style lists. ` +
        `CRITICAL — LANGUAGE: Never say "my gear", "my items", "my equipment", or "my stuff". Say "our items", "the gear", "the equipment", or "items available". You represent the business, not personal ownership. ` +
        `CRITICAL — NO DOWNSELLING: NEVER tell a renter they have "enough", are "set", are "all good", or "don't need" something. NEVER say "pretty much set", "should be enough", "usually enough", or any similar phrase. If they ask what else they might need, suggest relevant accessories based on their project — do NOT dismiss the question. Facilitate and upsell, never downsell. ` +
        `CRITICAL — PICKUP PRIORITY: ALWAYS offer the 10am pickup slot FIRST. Day-before evening pickup: FREE for larger orders, small fee for smaller orders — just quote the adjusted total naturally, NEVER mention surcharge percentages. Never suggest day-before as default. Morning slots (10am-12pm) before evening slots (7pm-9pm). ` +
        `CRITICAL — RETURN PRIORITY: Always suggest the earliest possible return slot. Morning-after return: FREE for larger orders, small fee for smaller orders — just quote the adjusted total naturally. Evening next day = always a full extra day. Half-day grace ONLY for 1-day rentals. Both day-before pickup AND morning-after return = full extra day regardless of value. ` +
        `CRITICAL — BMPCC BATTERIES: BMPCC 6K Pro comes with 5x LP-E6NH batteries. BMPCC 6K Full Frame comes with 5x LP-E6NH batteries. NEVER say 2x or 3x. The number is FIVE (5). Always include the battery model name "LP-E6NH" — never just say "5 batteries" without the model. ` +
        `CRITICAL — LOCATION LOCK: The renter location established at the START of the conversation is authoritative. If they mention a different location later, do NOT update your assumption. ` +
        `CRITICAL — V-MOUNT: V-mount battery rentals include all necessary plates, adapters, and cables. Never say "via plate" or imply renters need separate accessories. ` +
        `CRITICAL — CONTEXTUAL: If the renter has not mentioned what they are shooting, naturally ask what the project is to recommend the right gear. ` +
        `CRITICAL — DJ + SPEAKERS: Delivery is MANDATORY for DJ deck + speakers together. Never allow self-pickup for this combination. ` +
        `CRITICAL — SAME-DAY RENTALS: NEVER auto-approve same-day rentals. Ask for pickup time, then check with Daniel before confirming. ` +
        `CRITICAL — TIMING: When calendar data is available, suggest pickup/return times that align with other existing bookings to minimize Daniel's trips. ` +
        `CRITICAL — NO PRICE NEGOTIATION: NEVER offer custom discounts or negotiate prices. Only standard discount tiers apply. Escalate price requests to Daniel. ` +
        `CRITICAL — ADDRESS: NEVER share a specific street address before booking is confirmed. Only say "Central London (Trafalgar Square area)". ` +
        `Start your response with the exact reply text (no preamble).`;

      // Rental context
      const startDateStr = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
      const endDateStr = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
      let rentalContextStr = `Current rental: ${rental.title}\nStatus: ${rental.status}\nRenter: ${rental.renter_info || 'Unknown'}\nDates: ${startDateStr} to ${endDateStr}\n`;
      if (rental.rental_price) rentalContextStr += `Booking price: £${rental.rental_price} total\n`;
      rentalContextStr += `IMPORTANT: These are the REAL prices from the booking. Quote ONLY these figures.`;

      const additionalContext = [availabilityContext, scheduleContext].filter(Boolean).join('\n');

      // === CALL AI ===
      const response = await aiService.processComplex(messagePrompt, {
        rules,
        memories,
        conversationHistory: [],
        rentalContext: rentalContextStr,
        additionalContext,
      });

      console.log(`Model: ${response.model}`);
      console.log(`Reply: ${response.content.substring(0, 200)}...`);
      console.log('');

      results.push({
        test_num: i + 1,
        issue,
        prompt,
        reply: response.content,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });

    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      results.push({ test_num: i + 1, issue, prompt, reply: `ERROR: ${err.message}`, model: 'error' });
    }

    // Rate limit pause
    await new Promise(r => setTimeout(r, 2000));
  }

  // Save results
  fs.writeFileSync('/home/ubuntu/rental-manager/renter-bot-results.json', JSON.stringify({ tests: results }, null, 2));
  console.log('Results saved to renter-bot-results.json');

  await app.close();
}

main().catch(console.error);
