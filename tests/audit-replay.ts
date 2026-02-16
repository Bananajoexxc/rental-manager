/**
 * Audit Replay: Scans recent ai_decision records for the issues identified in the
 * Feb 15 2026 bot response audit. Checks historical responses against the new
 * violation rules to verify fixes would have caught them.
 *
 * Usage: npx ts-node --compiler-options '{"strict":false}' tests/audit-replay.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface AuditIssue {
  type: string;
  severity: 'critical' | 'warning';
  decisionId: string;
  rentalId: string | null;
  renterMessage: string;
  botResponse: string;
  detail: string;
}

async function runAuditReplay() {
  console.log('=== AUDIT REPLAY: Scanning recent ai_decision records ===\n');

  // Pull last 300 message decisions
  const decisions = await prisma.ai_decision.findMany({
    where: {
      decision_type: 'message',
      created_at: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { created_at: 'desc' },
    take: 300,
  });

  console.log(`Found ${decisions.length} message decisions to scan.\n`);

  const issues: AuditIssue[] = [];

  for (const d of decisions) {
    const response = d.output_summary || '';
    const input = d.input_summary || '';

    // 1. Duplicate detection: same rental + same input within 60s
    const dupes = decisions.filter(
      other =>
        other.id !== d.id &&
        other.rental_id === d.rental_id &&
        other.input_summary === d.input_summary &&
        Math.abs(new Date(other.created_at).getTime() - new Date(d.created_at).getTime()) < 60_000,
    );
    if (dupes.length > 0) {
      issues.push({
        type: 'DUPLICATE',
        severity: 'critical',
        decisionId: d.id,
        rentalId: d.rental_id,
        renterMessage: input.substring(0, 100),
        botResponse: response.substring(0, 100),
        detail: `${dupes.length} duplicate(s) within 60s`,
      });
    }

    // 2. False unavailability: "out of stock" while offering same items
    if (/out of stock|currently unavailable|not available/i.test(response)) {
      const offerPattern = /(?:I(?:'ve| have)|we have|available|can sort|can offer)\s/i;
      if (offerPattern.test(response)) {
        issues.push({
          type: 'FALSE_UNAVAILABILITY',
          severity: 'critical',
          decisionId: d.id,
          rentalId: d.rental_id,
          renterMessage: input.substring(0, 100),
          botResponse: response.substring(0, 150),
          detail: 'Says unavailable but also offers items',
        });
      }
    }

    // 3. Hygglo name leak
    if (/\bHygglo\b/i.test(response)) {
      issues.push({
        type: 'HYGGLO_LEAK',
        severity: 'warning',
        decisionId: d.id,
        rentalId: d.rental_id,
        renterMessage: input.substring(0, 100),
        botResponse: response.substring(0, 150),
        detail: 'Platform name "Hygglo" in response',
      });
    }

    // 4. Internal annotation leak
    if (/\*[^*]*(?:Daniel|Telegram|escalat|internal|notify)[^*]*\*/i.test(response)) {
      issues.push({
        type: 'INTERNAL_ANNOTATION',
        severity: 'critical',
        decisionId: d.id,
        rentalId: d.rental_id,
        renterMessage: input.substring(0, 100),
        botResponse: response.substring(0, 150),
        detail: 'Internal annotation in renter-facing text',
      });
    }

    // 5. Timestamp prefix
    if (/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+\w{3}/m.test(response)) {
      issues.push({
        type: 'TIMESTAMP_PREFIX',
        severity: 'warning',
        decisionId: d.id,
        rentalId: d.rental_id,
        renterMessage: input.substring(0, 100),
        botResponse: response.substring(0, 150),
        detail: 'Response starts with timestamp prefix',
      });
    }

    // 6. Location placeholder
    if (/exact address shared after booking confirmed/i.test(response)) {
      issues.push({
        type: 'LOCATION_PLACEHOLDER',
        severity: 'warning',
        decisionId: d.id,
        rentalId: d.rental_id,
        renterMessage: input.substring(0, 100),
        botResponse: response.substring(0, 150),
        detail: 'Template location text leaked',
      });
    }

    // 7. Low confidence sent
    if (d.confidence != null && d.confidence < 0.4 && d.was_sent === true) {
      issues.push({
        type: 'LOW_CONFIDENCE_SENT',
        severity: 'warning',
        decisionId: d.id,
        rentalId: d.rental_id,
        renterMessage: input.substring(0, 100),
        botResponse: response.substring(0, 150),
        detail: `Confidence ${(d.confidence * 100).toFixed(0)}% — would now be blocked`,
      });
    }

    // 8. Formatting artifacts
    if (/\]\]/.test(response) || /\n{3,}/.test(response)) {
      issues.push({
        type: 'FORMAT_ARTIFACT',
        severity: 'warning',
        decisionId: d.id,
        rentalId: d.rental_id,
        renterMessage: input.substring(0, 100),
        botResponse: response.substring(0, 150),
        detail: 'Contains formatting artifacts',
      });
    }

    // 9. Upsell on logistics/goodbye messages
    const isLogisticsInput = /\b(i'?m here|on my way|waiting|arrived|outside|minutes away|heading over|pickup|drop.?off)\b/i.test(input);
    const isGoodbyeInput = /^(thanks?|cheers|ok|okay|no worries|perfect|great|cool|lovely|brilliant|sorted|bye|see you)\b/i.test(input.trim()) && input.trim().length < 80;
    const hasUpsell = /\b(might be worth|also grab|worth adding|suggest|recommend|most people|popular|bundle|add.*(mic|filter|light|tripod|battery|lens))\b/i.test(response);
    if ((isLogisticsInput || isGoodbyeInput) && hasUpsell) {
      issues.push({
        type: 'UPSELL_WRONG_CONTEXT',
        severity: 'warning',
        decisionId: d.id,
        rentalId: d.rental_id,
        renterMessage: input.substring(0, 100),
        botResponse: response.substring(0, 150),
        detail: `Upselling on ${isLogisticsInput ? 'logistics' : 'goodbye'} message`,
      });
    }

    // 10. False capabilities promised
    if (/\b(I'll add|I can add|let me add|I'll update|I'll check.*(and|then) get back|I'll send.*link|I've updated)\b/i.test(response)) {
      issues.push({
        type: 'FALSE_CAPABILITY',
        severity: 'warning',
        decisionId: d.id,
        rentalId: d.rental_id,
        renterMessage: input.substring(0, 100),
        botResponse: response.substring(0, 150),
        detail: 'Bot promises action it cannot perform',
      });
    }
  }

  // Deduplicate: only show first occurrence per rental+type
  const seen = new Set<string>();
  const uniqueIssues = issues.filter(i => {
    const key = `${i.rentalId}:${i.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Summary
  const byType: Record<string, number> = {};
  for (const i of uniqueIssues) {
    byType[i.type] = (byType[i.type] || 0) + 1;
  }

  console.log('--- ISSUE SUMMARY ---');
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`\nTotal unique issues: ${uniqueIssues.length} across ${decisions.length} decisions`);

  if (uniqueIssues.length > 0) {
    console.log('\n--- SAMPLE ISSUES (first 10) ---');
    for (const i of uniqueIssues.slice(0, 10)) {
      console.log(`\n[${i.severity.toUpperCase()}] ${i.type}`);
      console.log(`  Rental: ${i.rentalId}`);
      console.log(`  Renter: ${i.renterMessage}`);
      console.log(`  Bot: ${i.botResponse}`);
      console.log(`  Detail: ${i.detail}`);
    }
  }

  await prisma.$disconnect();
}

runAuditReplay().catch(err => {
  console.error('Audit replay failed:', err);
  prisma.$disconnect();
  process.exit(1);
});
