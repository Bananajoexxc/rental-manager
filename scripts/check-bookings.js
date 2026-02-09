const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999);

  const all = await p.booking.findMany({
    where: { status: 'confirmed' },
    select: { id: true, item_name: true, renter_name: true, start_date: true, end_date: true, revenue: true, account: true },
    orderBy: { start_date: 'asc' }
  });

  // Dedup
  const seen = new Map();
  for (const b of all) {
    const key = `${b.item_name}|${b.renter_name}|${b.start_date.toISOString().split('T')[0]}`;
    const existing = seen.get(key);
    if (!existing || (b.revenue || 0) > (existing.revenue || 0)) {
      seen.set(key, b);
    }
  }
  const deduped = Array.from(seen.values());

  const ongoing = deduped.filter(b => b.start_date <= todayEnd && b.end_date >= todayStart);
  const upcoming = deduped.filter(b => b.start_date > todayEnd);
  const completed = deduped.filter(b => b.end_date < todayStart);

  console.log(`Total confirmed (raw): ${all.length}`);
  console.log(`Total confirmed (deduped): ${deduped.length}`);
  console.log(`Ongoing (start<=today, end>=today): ${ongoing.length}`);
  console.log(`Upcoming (start > today): ${upcoming.length}`);
  console.log(`Completed (end < today): ${completed.length}`);
  console.log(`Active (ongoing+upcoming): ${ongoing.length + upcoming.length}`);

  // Show duplicates
  const dupes = all.length - deduped.length;
  if (dupes > 0) {
    console.log(`\n--- ${dupes} DUPLICATE bookings found ---`);
    const dupeKeys = new Map();
    for (const b of all) {
      const key = `${b.item_name}|${b.renter_name}|${b.start_date.toISOString().split('T')[0]}`;
      if (!dupeKeys.has(key)) dupeKeys.set(key, []);
      dupeKeys.get(key).push(b);
    }
    for (const [key, bookings] of dupeKeys) {
      if (bookings.length > 1) {
        console.log(`  ${key}: ${bookings.length} copies (rev: ${bookings.map(b => '£' + (b.revenue||0)).join(', ')})`);
      }
    }
  }

  console.log(`\n--- ONGOING (${ongoing.length}) ---`);
  for (const b of ongoing) {
    console.log(`  ${b.item_name} | ${b.renter_name} | ${b.start_date.toISOString().split('T')[0]} - ${b.end_date.toISOString().split('T')[0]} | £${b.revenue||0} | ${b.account}`);
  }

  console.log(`\n--- UPCOMING (${upcoming.length}) ---`);
  for (const b of upcoming) {
    console.log(`  ${b.item_name} | ${b.renter_name} | ${b.start_date.toISOString().split('T')[0]} - ${b.end_date.toISOString().split('T')[0]} | £${b.revenue||0} | ${b.account}`);
  }

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
