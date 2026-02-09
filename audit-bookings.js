require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const bookings = await p.booking.findMany({
    where: { status: 'confirmed' },
    select: { id: true, item_name: true, renter_name: true, start_date: true, end_date: true, revenue: true, account: true, rental_id: true },
    orderBy: { start_date: 'desc' }
  });
  console.log('Total confirmed bookings:', bookings.length);

  const rentalIds = [];
  bookings.forEach(b => { if (b.rental_id && !rentalIds.includes(b.rental_id)) rentalIds.push(b.rental_id); });

  const rentals = await p.rental.findMany({
    where: { id: { in: rentalIds } },
    select: { id: true, status: true }
  });
  const rentalMap = {};
  rentals.forEach(r => { rentalMap[r.id] = r; });

  const byStatus = {};
  const problems = [];

  bookings.forEach(b => {
    const rental = b.rental_id ? rentalMap[b.rental_id] : null;
    const rs = rental ? rental.status : 'NO_RENTAL';
    byStatus[rs] = (byStatus[rs] || 0) + 1;
    if (rs !== 'completed') {
      const start = b.start_date ? b.start_date.toISOString().split('T')[0] : '?';
      const end = b.end_date ? b.end_date.toISOString().split('T')[0] : '?';
      problems.push(`  [${rs.padEnd(10)}] ${(b.renter_name || '?').padEnd(22)} ${start} - ${end}  £${(b.revenue || 0).toString().padEnd(6)} ${(b.item_name || '').substring(0, 45).padEnd(46)} ${b.account}`);
    }
  });

  console.log('\nBy rental status:');
  Object.keys(byStatus).forEach(k => console.log(`  ${k}: ${byStatus[k]}`));

  console.log(`\nNon-completed confirmed bookings (${problems.length}):`);
  problems.forEach(p => console.log(p));

  await p.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
