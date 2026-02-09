/**
 * Backfill conversation summaries for all active rentals that are missing them.
 * Uses Haiku for cheap, fast summarization.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';

const prisma = new PrismaClient();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 5; // parallel calls
const DELAY_MS = 500; // between batches

async function buildSummary(rentalId: string, messages: { role: string; content: string }[]): Promise<string | null> {
  const convoText = messages.map(m =>
    `${m.role === 'user' ? 'Renter' : 'Bot'}: ${m.content.substring(0, 400)}`,
  ).join('\n');

  const prompt = messages.length === 1
    ? `Summarize this first rental message in 2-3 short lines. Capture:\n- What the renter wants (items, dates, purpose)\n- Any specific requests (delivery, time preferences, questions asked)\n- Their tone (casual, urgent, professional)\n\nMessage:\n${convoText}\n\nRespond with ONLY the summary, no labels.`
    : `Summarize this rental conversation in 4-5 short lines. Capture ALL of these:\n1. Who they are and what they're shooting/using it for\n2. Items discussed, what's confirmed available, what was quoted\n3. What the bot promised or committed to (delivery quotes, times, discounts)\n4. What the renter agreed to, asked about, or is still deciding on\n5. Any concerns, rejections, or unresolved questions\n\nConversation:\n${convoText}\n\nRespond with ONLY the summary, no labels or numbers.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].type === 'text' ? response.content[0].text.trim() : null;
}

async function main() {
  // Find all active rentals missing summaries
  const missing = await prisma.follow_up_state.findMany({
    where: { status: 'active', conversation_summary: null },
    select: { rental_id: true },
  });

  console.log(`Found ${missing.length} active rentals missing summaries`);

  let processed = 0;
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(batch.map(async (item) => {
      const rentalId = item.rental_id;
      const chatId = `rental:${rentalId}`;

      // Get conversation messages
      const messages = await prisma.conversation.findMany({
        where: { chat_id: chatId },
        orderBy: { created_at: 'asc' },
        take: 30,
        select: { role: true, content: true },
      });

      if (messages.length === 0) {
        skipped++;
        return { rentalId, status: 'skipped', reason: 'no messages' };
      }

      // Build summary via AI
      const summary = await buildSummary(rentalId, messages);
      if (!summary) {
        failed++;
        return { rentalId, status: 'failed', reason: 'empty response' };
      }

      // Persist
      await prisma.follow_up_state.update({
        where: { rental_id: rentalId },
        data: { conversation_summary: summary },
      });

      succeeded++;
      return { rentalId, status: 'ok', summary: summary.substring(0, 80) };
    }));

    processed += batch.length;

    // Log progress
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const v = r.value;
        if (v.status === 'ok') {
          console.log(`  ✓ ${v.rentalId.substring(0, 8)}... → ${v.summary}...`);
        } else {
          console.log(`  ⊘ ${v.rentalId.substring(0, 8)}... → ${v.reason}`);
        }
      } else {
        failed++;
        console.log(`  ✗ Error: ${r.reason}`);
      }
    }

    console.log(`Progress: ${processed}/${missing.length} (${succeeded} ok, ${skipped} skipped, ${failed} failed)`);

    if (i + BATCH_SIZE < missing.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\n=== BACKFILL COMPLETE ===`);
  console.log(`Total: ${missing.length}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);

  // Final stats
  const total = await prisma.follow_up_state.count({ where: { status: 'active' } });
  const withSummary = await prisma.follow_up_state.count({ where: { status: 'active', conversation_summary: { not: null } } });
  console.log(`\nCoverage: ${withSummary}/${total} active rentals now have summaries (${Math.round(100*withSummary/total)}%)`);

  await prisma.$disconnect();
}

main().catch(console.error);
