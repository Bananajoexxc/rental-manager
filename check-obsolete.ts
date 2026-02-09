/**
 * Check if Leo's obsolete (cancelled) orders have ownerEarnings set.
 * This would explain the phantom entries if obsolete was imported as completed.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { HyggloService } from './src/hygglo/hygglo.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const hygglo = app.get(HyggloService);

  console.log('Fetching Leo OBSOLETE (cancelled) orders from Hygglo...');
  const obsolete = await hygglo.scanObsoleteRentalsPaginated('leo' as any, 50, new Date('2025-11-01'));
  console.log(`Leo obsolete orders (since Nov 2025): ${obsolete.length}`);

  let withPrice = 0;
  let withoutPrice = 0;
  let totalEarnings = 0;

  const novObsolete = obsolete.filter(r => {
    if (!r.startDate) return false;
    return r.startDate >= new Date('2025-11-01') && r.startDate < new Date('2025-12-01');
  });

  console.log(`\nNovember obsolete: ${novObsolete.length}`);
  for (const r of novObsolete.slice(0, 30)) {
    const price = r.rentalPrice || 0;
    if (price > 0) withPrice++;
    else withoutPrice++;
    totalEarnings += price;
    console.log(`£${price.toFixed(2)} | ${r.startDate?.toISOString().split('T')[0]} → ${r.endDate?.toISOString().split('T')[0]} | ${(r.renterInfo || '').substring(0, 25)} | ${(r.title || '').substring(0, 45)}`);
  }

  console.log(`\nWith price: ${withPrice}`);
  console.log(`Without price: ${withoutPrice}`);
  console.log(`Total earnings of obsolete Nov orders: £${totalEarnings.toFixed(2)}`);

  // Also check: how many Leo obsolete total
  console.log('\nFetching ALL Leo obsolete (unlimited)...');
  const allObsolete = await hygglo.scanObsoleteRentalsPaginated('leo' as any, 0);
  const allNovObs = allObsolete.filter(r => r.startDate && r.startDate >= new Date('2025-11-01') && r.startDate < new Date('2025-12-01'));
  console.log(`All Leo obsolete: ${allObsolete.length}`);
  console.log(`November obsolete: ${allNovObs.length}`);
  const obsTotal = allNovObs.reduce((s, r) => s + (r.rentalPrice || 0), 0);
  const obsWithPrice = allNovObs.filter(r => (r.rentalPrice || 0) > 0);
  console.log(`Nov obsolete with price > 0: ${obsWithPrice.length} (£${obsTotal.toFixed(2)})`);

  // Cross-check: completed(14) + obsolete with price = should match DB(191)?
  console.log(`\nCompleted (14) + Obsolete with price (${obsWithPrice.length}) = ${14 + obsWithPrice.length}`);
  console.log(`DB has 191 entries. Gap: ${191 - 14 - obsWithPrice.length}`);

  await app.close();
}
main().catch(e => { console.error(e); process.exit(1); });
