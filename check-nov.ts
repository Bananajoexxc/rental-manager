/**
 * Quick script: pull ALL completed rentals from Hygglo for both accounts,
 * filter to November 2025, and compare against the DB.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { HyggloService } from './src/hygglo/hygglo.service';
import { PrismaService } from './src/prisma/prisma.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const hygglo = app.get(HyggloService);
  const prisma = app.get(PrismaService);

  const novStart = new Date('2025-11-01');
  const novEnd = new Date('2025-12-01');

  console.log('Fetching completed rentals from Hygglo (both accounts)...');

  const results: any[] = [];

  for (const acct of ['dbcinema', 'leo'] as const) {
    console.log(`\n=== Scanning ${acct} ===`);
    const rentals = await hygglo.scanCompletedRentalsPaginated(acct, 0);
    console.log(`Total completed rentals from Hygglo (${acct}): ${rentals.length}`);

    const novRentals = rentals.filter(r => {
      if (!r.startDate) return false;
      return r.startDate >= novStart && r.startDate < novEnd;
    });

    console.log(`November 2025 rentals (${acct}): ${novRentals.length}`);
    let acctTotal = 0;

    for (const r of novRentals) {
      acctTotal += r.rentalPrice || 0;
      results.push({
        account: acct,
        listingId: r.listingId,
        title: (r.title || '').substring(0, 50),
        renterName: r.renterInfo || '',
        startDate: r.startDate?.toISOString().split('T')[0],
        endDate: r.endDate?.toISOString().split('T')[0],
        ownerEarnings: r.rentalPrice || 0,
      });
    }
    console.log(`November total from Hygglo (${acct}): £${acctTotal.toFixed(2)}`);
  }

  // Sort by earnings desc
  results.sort((a, b) => b.ownerEarnings - a.ownerEarnings);

  const hyggloTotal = results.reduce((s, r) => s + r.ownerEarnings, 0);
  console.log(`\n=== HYGGLO TOTAL (Nov 2025): £${hyggloTotal.toFixed(2)} across ${results.length} bookings ===`);

  // Now compare with DB
  const dbRentals = await prisma.rental.findMany({
    where: {
      start_date: { gte: novStart, lt: novEnd },
      rental_price: { gt: 0 },
      status: { in: ['completed', 'ongoing', 'upcoming'] },
    },
    select: { rental_price: true },
  });
  const dbTotal = dbRentals.reduce((s: number, r: any) => s + (r.rental_price || 0), 0);
  console.log(`DB TOTAL (Nov 2025): £${dbTotal.toFixed(2)} across ${dbRentals.length} rows`);
  console.log(`DIFFERENCE: £${(dbTotal - hyggloTotal).toFixed(2)}`);

  // Show top 30 entries from Hygglo
  console.log('\n=== TOP 30 FROM HYGGLO ===');
  for (const r of results.slice(0, 30)) {
    console.log(`£${r.ownerEarnings.toFixed(2)} | ${r.account} | ${r.startDate} → ${r.endDate} | ${r.renterName.substring(0, 25)} | ${r.title}`);
  }

  // Check for Leo/DB Cinema cross-account duplicates from Hygglo itself
  console.log('\n=== CROSS-ACCOUNT DUPLICATE CHECK ===');
  const byKey: Record<string, any[]> = {};
  for (const r of results) {
    // Normalize renter name for matching
    const normName = r.renterName.trim().toLowerCase().replace(/[^a-z]/g, '').substring(0, 8);
    const key = `${normName}|${r.startDate}`;
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(r);
  }

  let crossDupeTotal = 0;
  for (const [key, group] of Object.entries(byKey)) {
    const accounts = new Set(group.map((r: any) => r.account));
    if (accounts.size > 1) {
      const leoEarnings = group.filter((r: any) => r.account === 'leo').reduce((s: number, r: any) => s + r.ownerEarnings, 0);
      crossDupeTotal += leoEarnings;
      console.log(`DUPE: ${key} → ${group.map((r: any) => `${r.account} £${r.ownerEarnings}`).join(' | ')}`);
    }
  }
  console.log(`\nCross-account duplicate Leo total: £${crossDupeTotal.toFixed(2)}`);
  console.log(`Hygglo total minus cross-dupes: £${(hyggloTotal - crossDupeTotal).toFixed(2)}`);

  // Check per-account totals
  const dbByAcct = await prisma.rental.groupBy({
    by: ['account'],
    where: {
      start_date: { gte: novStart, lt: novEnd },
      rental_price: { gt: 0 },
      status: { in: ['completed', 'ongoing', 'upcoming'] },
    },
    _sum: { rental_price: true },
    _count: true,
  });
  console.log('\n=== DB BY ACCOUNT ===');
  for (const a of dbByAcct) {
    console.log(`${a.account}: £${a._sum.rental_price?.toFixed(2)} (${a._count} rows)`);
  }

  const hyggloByAcct: Record<string, { total: number; count: number }> = {};
  for (const r of results) {
    if (!hyggloByAcct[r.account]) hyggloByAcct[r.account] = { total: 0, count: 0 };
    hyggloByAcct[r.account].total += r.ownerEarnings;
    hyggloByAcct[r.account].count++;
  }
  console.log('\n=== HYGGLO BY ACCOUNT ===');
  for (const [acct, d] of Object.entries(hyggloByAcct)) {
    console.log(`${acct}: £${d.total.toFixed(2)} (${d.count} bookings)`);
  }

  await app.close();
}

main().catch(e => { console.error(e); process.exit(1); });
