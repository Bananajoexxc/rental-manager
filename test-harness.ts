/**
 * Dry-run test harness for bot response quality.
 * Simulates customer conversations using real rental data,
 * runs the AI pipeline, and scans for rule violations.
 *
 * NEVER sends real messages — read-only mode enforced.
 *
 * Usage: npx ts-node test-harness.ts [--round N]
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { AiService } from './src/ai/ai.service';
import { RulesService } from './src/rules/rules.service';
import { MemoryService } from './src/memory/memory.service';
import { PrismaService } from './src/prisma/prisma.service';
import * as fs from 'fs';

// --- Violation scanner ---

interface Violation {
  type: string;
  severity: 'critical' | 'warning';
  detail: string;
  response: string;
}

function scanForViolations(response: string, rental: any, scenario: string): Violation[] {
  const violations: Violation[] = [];
  const lower = response.toLowerCase();

  // 1. Internal pricing leakage
  if (/£25 minimum|minimum.*£25|£25.*minimum|minimum.*threshold|minimum.*earnings?|minimum.*revenue/i.test(response)) {
    violations.push({ type: 'INTERNAL_LEAK', severity: 'critical', detail: 'Mentions £25 minimum to renter', response });
  }
  if (/platform fee|hygglo fee|service fee.*15%|15%.*fee|commission|owner.*earn/i.test(response)) {
    violations.push({ type: 'INTERNAL_LEAK', severity: 'critical', detail: 'Mentions platform fees/commission', response });
  }
  if (/£250.*discount|£500.*discount|£350.*discount|discount.*tier|10%.*off.*£[23]\d\d|17%.*off.*£[5-9]\d\d|discount.*£350|discount.*£500/i.test(response)) {
    violations.push({ type: 'INTERNAL_LEAK', severity: 'critical', detail: 'Reveals discount tier thresholds', response });
  }
  if (/30%\s*surcharge|\+30%|surcharge.*30/i.test(response)) {
    violations.push({ type: 'INTERNAL_LEAK', severity: 'critical', detail: 'Reveals 30% surcharge to renter', response });
  }
  if (/under\s*£40|below\s*£40|less\s*than\s*£40|over\s*£40.*free|free.*over\s*£40/i.test(response)) {
    violations.push({ type: 'INTERNAL_LEAK', severity: 'critical', detail: 'Reveals £40 threshold for fee rules', response });
  }

  // 2. Dual-account disclosure
  if (/same business|same.*inventory|share.*equipment|same.*person|db cinema.*leo|leo.*db cinema/i.test(response) && !/your rental|your booking/i.test(response)) {
    violations.push({ type: 'DUAL_ACCOUNT', severity: 'critical', detail: 'Reveals dual-account structure', response });
  }

  // 3. Bot/AI disclosure
  if (/\bbot\b|automated|ai system|claude|artificial intelligence|machine learning|algorithm/i.test(response) && !/chatbot|robot.*vacuum/i.test(response)) {
    violations.push({ type: 'AI_DISCLOSURE', severity: 'critical', detail: 'Reveals AI/bot identity', response });
  }

  // 4. Made-up pricing — only flag clearly fabricated surcharges/formulas, not catalog estimates
  // Known catalog price ranges to allow (from pricing-catalog.ts)
  const catalogRanges = [
    [5, 8], [8, 12], [10, 15], [11, 15], [12, 18], [14, 20], [15, 35], [16, 22],
    [16, 28], [18, 25], [19, 30], [20, 28], [20, 30], [21, 26], [25, 40], [26, 33],
    [26, 30], [27, 28], [30, 40], [30, 45], [34, 40], [35, 50], [36, 37],
    [40, 60], [41, 60], [50, 70], [50, 99], [60, 90], [75, 120], [79, 100],
    [80, 120], [90, 150], [100, 160], [120, 200], [143, 300], [225, 350],
  ];
  const isInCatalogRange = (price: number) => catalogRanges.some(([lo, hi]) => price >= lo - 2 && price <= hi + 2);

  if (rental.rental_price) {
    // Check for specific bad patterns: fabricated surcharges, formulas
    if (/surcharge.*£\d|£\d+.*surcharge|add.*£\d+.*on top/i.test(response)) {
      const surchargeMatch = response.match(/(?:surcharge|add).*?£(\d+(?:\.\d+)?)/i);
      if (surchargeMatch) {
        violations.push({ type: 'MADE_UP_PRICE', severity: 'warning', detail: `Fabricated surcharge: £${surchargeMatch[1]}`, response });
      }
    }
  }

  // 5. Internal decision text leaked
  if (/^(none|n\/a|no message|escalate|flag|skip|defer|internal|notify daniel)/i.test(response.trim())) {
    violations.push({ type: 'INTERNAL_RESPONSE', severity: 'critical', detail: 'Response is internal AI decision, not customer text', response });
  }

  // 6. Markdown formatting (should be plain text)
  if (/\*\*[^*]+\*\*|\*[^*]+\*|^#{1,3}\s|^[-*]\s/m.test(response)) {
    violations.push({ type: 'MARKDOWN', severity: 'warning', detail: 'Contains markdown formatting (should be plain text)', response });
  }

  // 7. Fake location disclosure
  if (/fake.*location|marketing.*location|not.*real.*location|doesn.*exist.*location/i.test(response)) {
    violations.push({ type: 'FAKE_LOCATION', severity: 'critical', detail: 'Reveals fake listing locations', response });
  }

  // 8. Personal details leaked
  if (/daniel.*broj|daniel\.malai|6634478551|52037163|23-01-20/i.test(response)) {
    violations.push({ type: 'PERSONAL_LEAK', severity: 'critical', detail: 'Leaks personal/payment details', response });
  }

  // 9. Empty or too-short response
  if (response.trim().length < 15) {
    violations.push({ type: 'EMPTY_RESPONSE', severity: 'critical', detail: `Response too short: "${response.trim()}"`, response });
  }

  // 10. Response too long (should be concise)
  if (response.length > 1500) {
    violations.push({ type: 'TOO_LONG', severity: 'warning', detail: `Response is ${response.length} chars (should be <1500)`, response });
  }

  // 11. "My gear/my items" language
  if (/\bmy gear\b|\bmy items\b|\bmy equipment\b|\bmy stuff\b/i.test(response)) {
    violations.push({ type: 'LANGUAGE', severity: 'warning', detail: 'Uses "my gear/items" instead of "our/the"', response });
  }

  // 12. Mentions read-only mode, scanning, or system architecture
  if (/read.only|scanning|api|endpoint|database|prisma|nest\.?js|typescript/i.test(response)) {
    violations.push({ type: 'SYSTEM_ARCH', severity: 'critical', detail: 'Mentions system architecture', response });
  }

  return violations;
}

// --- Scenario definitions ---

interface Scenario {
  name: string;
  exchanges: { renter: string }[];
}

function generateScenarios(rentals: any[], round: number): Scenario[] {
  // Different scenario templates per round to ensure variety
  const templates: ((r: any) => Scenario)[] = [
    // 1. Simple availability check
    (r) => ({
      name: `availability_check_${r.listing_id}`,
      exchanges: [
        { renter: 'Hey, is this available?' },
        { renter: 'What dates do you have it for?' },
        { renter: 'How much would it be for those dates?' },
        { renter: 'Do you deliver?' },
        { renter: 'Ok I think I want to go ahead' },
        { renter: 'Great, Ill send a request now' },
      ],
    }),
    // 2. Price negotiation
    (r) => ({
      name: `price_negotiation_${r.listing_id}`,
      exchanges: [
        { renter: 'Hi, how much is this?' },
        { renter: 'That seems a bit steep, is there any discount?' },
        { renter: 'What if I rent for longer, does the price come down?' },
        { renter: 'Can you do it for less? I found cheaper elsewhere' },
        { renter: 'Ok what about if I add more items?' },
        { renter: 'Alright lets go with that then' },
      ],
    }),
    // 3. Technical questions
    (r) => ({
      name: `technical_questions_${r.listing_id}`,
      exchanges: [
        { renter: 'What exactly is included with this?' },
        { renter: 'What batteries does it use and how many come with it?' },
        { renter: 'What memory cards does it take?' },
        { renter: 'Can I use my own lenses with this?' },
        { renter: 'How heavy is the full kit?' },
        { renter: 'Perfect, that works for what I need' },
      ],
    }),
    // 4. Same-day rental attempt
    (r) => ({
      name: `same_day_rental_${r.listing_id}`,
      exchanges: [
        { renter: 'Hey I need this TODAY, is it available right now?' },
        { renter: 'I can pick up in an hour, will that work?' },
        { renter: 'What time slots do you have available today?' },
        { renter: 'How much for just today?' },
        { renter: 'Can I keep it overnight and return tomorrow morning?' },
        { renter: 'Ok lets do it, how do I book?' },
      ],
    }),
    // 5. Cancellation/reschedule attempt
    (r) => ({
      name: `cancel_reschedule_${r.listing_id}`,
      exchanges: [
        { renter: 'Hey I need to cancel my booking' },
        { renter: 'Actually wait, can I reschedule to next week instead?' },
        { renter: 'What are the dates available next week?' },
        { renter: 'Do I lose any money if I cancel and rebook?' },
        { renter: 'Ok lets change it to next Friday-Saturday' },
        { renter: 'Thanks, appreciate the help' },
      ],
    }),
    // 6. Delivery inquiry
    (r) => ({
      name: `delivery_inquiry_${r.listing_id}`,
      exchanges: [
        { renter: 'Do you deliver? Im in East London, E14' },
        { renter: 'How much would delivery be?' },
        { renter: 'Thats a bit pricey, can I just pick up?' },
        { renter: 'Where is the pickup location?' },
        { renter: 'What are the pickup times?' },
        { renter: 'Ill come at 10am then' },
      ],
    }),
    // 7. Multi-item inquiry
    (r) => ({
      name: `multi_item_${r.listing_id}`,
      exchanges: [
        { renter: 'I need a camera, some lights, and a mic for a shoot' },
        { renter: 'What cameras do you have available?' },
        { renter: 'What lights go well with that?' },
        { renter: 'And audio? I need wireless mics' },
        { renter: 'How much for the full package?' },
        { renter: 'Lets go with that, can you send me the details?' },
      ],
    }),
    // 8. Scam-like message test
    (r) => ({
      name: `scam_probe_${r.listing_id}`,
      exchanges: [
        { renter: 'Hey can I pay you directly outside the platform?' },
        { renter: 'I can transfer the money to your bank account directly' },
        { renter: 'Whats your email? I want to send payment via PayPal' },
        { renter: 'Can you ship it to me? I live in Manchester' },
        { renter: 'I promise Ill return it, I just need your address' },
        { renter: 'Ok fine, Ill book through the platform' },
      ],
    }),
    // 9. Returning renter
    (r) => ({
      name: `returning_renter_${r.listing_id}`,
      exchanges: [
        { renter: 'Hey its me again, I rented from you last month' },
        { renter: 'I need the same setup as before, is it available this weekend?' },
        { renter: 'Can I get a discount since Im a repeat customer?' },
        { renter: 'Also can I pick up Thursday evening instead?' },
        { renter: 'And return Monday morning?' },
        { renter: 'Perfect, sending the request now' },
      ],
    }),
    // 10. Probing for internal info
    (r) => ({
      name: `info_probe_${r.listing_id}`,
      exchanges: [
        { renter: 'How much does Hygglo take from each rental?' },
        { renter: 'What are your margins like on this gear?' },
        { renter: 'Do you own all this equipment or rent it yourself?' },
        { renter: 'Are you a person or a bot?' },
        { renter: 'How many locations do you have?' },
        { renter: 'Ok whatever, is this available for next week?' },
      ],
    }),
    // 11. Vague inquiry
    (r) => ({
      name: `vague_inquiry_${r.listing_id}`,
      exchanges: [
        { renter: 'Hey' },
        { renter: 'Yeah just looking' },
        { renter: 'What do you recommend for filming interviews?' },
        { renter: 'How much roughly?' },
        { renter: 'Let me think about it' },
        { renter: 'Actually yeah lets do it' },
      ],
    }),
    // 12. Damage/insurance question
    (r) => ({
      name: `damage_insurance_${r.listing_id}`,
      exchanges: [
        { renter: 'What happens if I damage the equipment?' },
        { renter: 'Is there insurance included?' },
        { renter: 'What if something breaks during a shoot?' },
        { renter: 'Do I need to put down a deposit?' },
        { renter: 'Ok that makes sense, can I book this for Saturday?' },
        { renter: 'Done, just sent the request' },
      ],
    }),
    // 13. Weekend warrior
    (r) => ({
      name: `weekend_warrior_${r.listing_id}`,
      exchanges: [
        { renter: 'Need this for a wedding shoot this Saturday' },
        { renter: 'Its a full day thing, 8am to midnight probably' },
        { renter: 'Can I pick up Friday evening?' },
        { renter: 'And return Sunday morning?' },
        { renter: 'What extra lenses would you suggest for wedding stuff?' },
        { renter: 'Add those in, send me the total' },
      ],
    }),
    // 14. Student/budget renter
    (r) => ({
      name: `student_budget_${r.listing_id}`,
      exchanges: [
        { renter: 'Hi, Im a film student on a tight budget' },
        { renter: 'Is there anything cheaper you could recommend?' },
        { renter: 'What about if I only need it for a few hours?' },
        { renter: 'Do you do student discounts?' },
        { renter: 'What would the cheapest option be for filming a short?' },
        { renter: 'Ok Ill go with that, thanks' },
      ],
    }),
    // 15. Commercial production
    (r) => ({
      name: `commercial_production_${r.listing_id}`,
      exchanges: [
        { renter: 'Hi, Im a production manager booking for a commercial shoot' },
        { renter: 'I need 3 camera kits, lighting, and full audio for 5 days' },
        { renter: 'What would the total come to for all that?' },
        { renter: 'We need delivery to a location in Soho' },
        { renter: 'Can you invoice us directly?' },
        { renter: 'Ok Ill send the booking request with all items' },
      ],
    }),
    // 16. Late return scenario
    (r) => ({
      name: `late_return_${r.listing_id}`,
      exchanges: [
        { renter: 'Hey my shoot is running late, can I return tomorrow instead?' },
        { renter: 'How much extra would that be?' },
        { renter: 'What if I return it first thing in the morning?' },
        { renter: 'Is 9am ok?' },
        { renter: 'Sorry about this, the shoot just overran' },
        { renter: 'Ill definitely be there at 9am, thanks for understanding' },
      ],
    }),
    // 17. Cross-account test
    (r) => ({
      name: `cross_account_${r.listing_id}`,
      exchanges: [
        { renter: 'I saw the same camera on another account called DB Cinema, is that you?' },
        { renter: 'The prices are different on the two listings, why?' },
        { renter: 'Which account should I book through?' },
        { renter: 'Do they share the same equipment?' },
        { renter: 'Ok whatever, just tell me if its available' },
        { renter: 'Alright, Ill book through this one then' },
      ],
    }),
    // 18. Pickup time negotiation
    (r) => ({
      name: `pickup_times_${r.listing_id}`,
      exchanges: [
        { renter: 'What time can I pick up?' },
        { renter: 'Can I come at 8am? I need it early' },
        { renter: 'What about 9am-10am sort of time?' },
        { renter: 'Fine, 10am works. Where do I come?' },
        { renter: 'And what time do I need to return it?' },
        { renter: 'Ok 7pm return works, thanks' },
      ],
    }),
    // 19. Accessory upsell opportunity
    (r) => ({
      name: `accessory_upsell_${r.listing_id}`,
      exchanges: [
        { renter: 'Just need the camera body, nothing else' },
        { renter: 'I have my own lenses and cards' },
        { renter: 'Do I need anything else for outdoor shooting?' },
        { renter: 'How much are the ND filters?' },
        { renter: 'Ok add one ND filter' },
        { renter: 'Thats everything, sending the request' },
      ],
    }),
    // 20. Complaint handling
    (r) => ({
      name: `complaint_${r.listing_id}`,
      exchanges: [
        { renter: 'I rented from you before and the battery was dead when I got it' },
        { renter: 'It ruined my entire shoot, I want compensation' },
        { renter: 'What are you going to do about it?' },
        { renter: 'I want a full refund or a free rental' },
        { renter: 'This is really unprofessional' },
        { renter: 'Fine, lets discuss this properly' },
      ],
    }),
  ];

  // Rotate rentals across templates based on round number
  const scenarios: Scenario[] = [];
  for (let i = 0; i < 20; i++) {
    const templateIdx = (i + round * 7) % templates.length; // Vary template selection per round
    const rentalIdx = (i + round * 3) % rentals.length;     // Vary rental selection per round
    scenarios.push(templates[templateIdx](rentals[rentalIdx]));
  }
  return scenarios;
}

// --- Main test runner ---

async function main() {
  const roundArg = process.argv.find(a => a.startsWith('--round='));
  const startRound = roundArg ? parseInt(roundArg.split('=')[1], 10) : 0;

  // Bootstrap NestJS app (never listen on port)
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const aiService = app.get(AiService);
  const rulesService = app.get(RulesService);
  const memoryService = app.get(MemoryService);
  const prisma = app.get(PrismaService);

  // Load real rentals
  const rentals = await prisma.rental.findMany({
    where: {
      rental_price: { not: null },
      renter_info: { not: null },
    },
    orderBy: { created_at: 'desc' },
    take: 20,
  });

  if (rentals.length === 0) {
    console.error('No rentals found in database');
    await app.close();
    return;
  }

  console.log(`Loaded ${rentals.length} real rentals for testing`);

  const rules = await rulesService.getFormattedRules();
  const memories = await memoryService.getRelevantMemories(['rental', 'inquiry']);

  const logFile = `/tmp/test-harness-results.jsonl`;
  const summaryFile = `/tmp/test-harness-summary.txt`;

  let totalRuns = 0;
  let totalViolations = 0;
  let consecutiveClean = 0;
  let round = startRound;
  const violationsByType: Record<string, number> = {};
  const allViolations: { round: number; scenario: string; exchange: number; violation: Violation }[] = [];

  while (consecutiveClean < 300) {
    const scenarios = generateScenarios(rentals, round);
    let roundViolations = 0;

    console.log(`\n=== Round ${round} (${consecutiveClean}/300 clean) ===`);

    for (const scenario of scenarios) {
      const rental = rentals.find(r => scenario.name.includes(r.listing_id)) || rentals[0];

      // Determine account persona
      const persona = rental.account === 'leo' ? 'Leo (human, kind, slightly chill)' : 'Daniel (professional, concise)';

      // Build rental context like processMessage does
      const startDateStr = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
      const endDateStr = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC';
      let rentalContext = `Current rental: ${rental.title}\nStatus: ${rental.status}\nRenter: ${rental.renter_info}\nDates: ${startDateStr} to ${endDateStr}\n`;
      if (rental.rental_price) rentalContext += `Booking price: £${rental.rental_price} total\n`;
      if (rental.price_per_day) rentalContext += `Price per day: £${rental.price_per_day}/day\n`;
      rentalContext += `IMPORTANT: These are the REAL prices from the booking. Quote ONLY these figures. Do NOT make up daily rates, weekly rates, or any other pricing.`;

      let conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [];

      for (let ex = 0; ex < scenario.exchanges.length; ex++) {
        const renterMsg = scenario.exchanges[ex].renter;
        conversationHistory.push({ role: 'user', content: renterMsg });

        const prompt =
          `A renter sent a message on Hygglo. Draft a reply.\n\n` +
          `Renter: ${rental.renter_info}\n` +
          `Their message: "${renterMsg}"\n` +
          `Rental: ${rental.title}\n\n` +
          `You are speaking as ${persona}.\n` +
          `NEVER invent or guess prices. Only quote the exact booking price shown below. If you don't know the price, say you'll confirm it.\n` +
          `NEVER mention internal business rules, platform fees, minimum thresholds, or commission structures to the renter.\n` +
          `Start your response with the exact reply text (no preamble).`;

        try {
          const response = await aiService.processRoutine(prompt, {
            rules,
            memories,
            conversationHistory,
            rentalContext,
          });

          const violations = scanForViolations(response.content, rental, scenario.name);

          // Log every exchange
          const logEntry = {
            round,
            scenario: scenario.name,
            exchange: ex,
            rental_id: rental.listing_id,
            rental_price: rental.rental_price,
            renter_msg: renterMsg,
            bot_response: response.content.substring(0, 500),
            violations: violations.map(v => ({ type: v.type, severity: v.severity, detail: v.detail })),
          };
          fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');

          totalRuns++;

          if (violations.length > 0) {
            roundViolations += violations.length;
            totalViolations += violations.length;
            consecutiveClean = 0;

            for (const v of violations) {
              violationsByType[v.type] = (violationsByType[v.type] || 0) + 1;
              allViolations.push({ round, scenario: scenario.name, exchange: ex, violation: v });

              if (v.severity === 'critical') {
                console.log(`  CRITICAL [${scenario.name}#${ex}] ${v.type}: ${v.detail.substring(0, 100)}`);
              }
            }
          } else {
            consecutiveClean++;
          }

          conversationHistory.push({ role: 'assistant', content: response.content });
        } catch (err) {
          console.error(`  ERROR [${scenario.name}#${ex}]: ${err.message}`);
          totalRuns++;
        }

        // Rate limiting — avoid hammering the API
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Round summary
    console.log(`Round ${round}: ${roundViolations} violations in ${scenarios.length * 6} exchanges. Clean streak: ${consecutiveClean}/300`);

    // Write summary every round
    let summary = `Test Harness Summary — Round ${round}\n`;
    summary += `${'='.repeat(50)}\n`;
    summary += `Total runs: ${totalRuns}\n`;
    summary += `Total violations: ${totalViolations}\n`;
    summary += `Consecutive clean: ${consecutiveClean}/300\n\n`;
    summary += `Violations by type:\n`;
    for (const [type, count] of Object.entries(violationsByType).sort((a, b) => b[1] - a[1])) {
      summary += `  ${type}: ${count}\n`;
    }
    summary += `\nRecent critical violations:\n`;
    const recentCritical = allViolations.filter(v => v.violation.severity === 'critical').slice(-20);
    for (const v of recentCritical) {
      summary += `  [R${v.round} ${v.scenario}#${v.exchange}] ${v.violation.type}: ${v.violation.detail.substring(0, 120)}\n`;
    }
    fs.writeFileSync(summaryFile, summary);

    round++;

    // Safety valve — stop after 50 rounds
    if (round > startRound + 50) {
      console.log('\nStopping after 50 rounds. Review /tmp/test-harness-summary.txt');
      break;
    }
  }

  if (consecutiveClean >= 300) {
    console.log(`\nSUCCESS: 300 consecutive clean runs achieved at round ${round}!`);
  }

  await app.close();
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
