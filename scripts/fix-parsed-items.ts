/**
 * Fix over-parsed rental items.
 *
 * Force re-parses titles with improved AI prompt (anti-hallucination + item count constraint),
 * deletes bookings for items no longer in parsed list, updates rental.parsed_items.
 *
 * SAFETY: If parser returns empty, the rental is SKIPPED (API failure, not "no items").
 *
 * Usage: npx ts-node --compiler-options '{"strict":false}' scripts/fix-parsed-items.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { TitleParserService } from '../src/revenue/title-parser.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { findBestMatch, getInventoryItemNames } from '../src/utils/item-matcher';

const RENTAL_IDS = [
  '78868d01-46a6-448c-bcda-371194d1369b', // Matthew Labudda — FX3 + 24-70mm
  '8cf67aec-fa1d-4250-862b-04b328124905', // Casius Stone — A7III + DJI Mic
  'de934552-1ab2-4107-82a5-816d8bcc5aa9', // Amy Chappel — BMPCC 6K Pro set
];

async function main() {
  console.log('Bootstrapping NestJS app...');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const titleParser = app.get(TitleParserService);
  const prisma = app.get(PrismaService);
  const inventoryNames = getInventoryItemNames();

  for (const rentalId of RENTAL_IDS) {
    const rental = await prisma.rental.findUnique({
      where: { id: rentalId },
      include: { bookings: { where: { status: { in: ['confirmed', 'pending_review'] } } } },
    });
    if (!rental) {
      console.log(`\nSkipping ${rentalId} — not found`);
      continue;
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`Rental: ${rental.title?.substring(0, 80)}`);
    console.log(`Renter: ${rental.renter_info}`);
    console.log(`Old parsed_items: ${JSON.stringify(rental.parsed_items)}`);
    console.log(`Current bookings (${rental.bookings.length}):`);
    for (const b of rental.bookings) {
      console.log(`  - [${b.status}] ${b.item_name} (${b.id})`);
    }

    // Force re-parse with improved AI
    console.log(`\nForce re-parsing title...`);
    const newParsed = await titleParser.parseTitleWithAI(rental.title || '', true);
    console.log(`New parsed items: ${JSON.stringify(newParsed)}`);

    // SAFETY: If parser returns empty, skip this rental — it's an API failure, not "no items"
    if (newParsed.length === 0) {
      console.log('  SKIPPED — parser returned empty (likely API failure). No changes made.');
      continue;
    }

    // Resolve new items to canonical inventory names
    const newCanonical = new Set<string>();
    for (const item of newParsed) {
      const matched = findBestMatch(item.item, inventoryNames);
      if (matched) newCanonical.add(matched);
      else console.log(`  WARNING: "${item.item}" has no inventory match`);
    }
    console.log(`Canonical items: ${[...newCanonical].join(', ')}`);

    // SAFETY: If canonical resolution produces fewer items than 50% of current bookings, warn
    if (newCanonical.size < rental.bookings.length * 0.5) {
      console.log(`  WARNING: New items (${newCanonical.size}) are <50% of current bookings (${rental.bookings.length}). Skipping deletion.`);
      console.log('  Review manually and re-run with explicit IDs if needed.');
      continue;
    }

    // Find bookings to DELETE (items no longer in parsed list)
    const toDelete: { id: string; item_name: string }[] = [];
    for (const b of rental.bookings) {
      if (!newCanonical.has(b.item_name)) {
        toDelete.push({ id: b.id, item_name: b.item_name });
      }
    }

    if (toDelete.length > 0) {
      console.log(`\nBookings to DELETE (${toDelete.length}):`);
      for (const d of toDelete) {
        console.log(`  - ${d.item_name} (${d.id})`);
      }

      // Delete the wrong bookings
      const deleteResult = await prisma.booking.deleteMany({
        where: { id: { in: toDelete.map(d => d.id) } },
      });
      console.log(`Deleted ${deleteResult.count} booking(s)`);
    } else {
      console.log('\nNo bookings to delete — all match new parsed items');
    }

    // Update parsed_items on the rental
    await prisma.rental.update({
      where: { id: rentalId },
      data: { parsed_items: newParsed as any },
    });
    console.log('Updated rental.parsed_items');

    // Verify final state
    const finalBookings = await prisma.booking.findMany({
      where: { rental_id: rentalId, status: { in: ['confirmed', 'pending_review'] } },
      select: { item_name: true, status: true },
    });
    console.log(`\nFinal bookings (${finalBookings.length}):`);
    for (const b of finalBookings) {
      console.log(`  - [${b.status}] ${b.item_name}`);
    }
  }

  await prisma.$disconnect();
  await app.close();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
