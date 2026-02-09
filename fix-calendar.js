require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const now = new Date();

  // 1. Demote any remaining confirmed bookings on pending rentals
  const pendingFix = await p.$executeRaw`
    UPDATE booking b
    SET status = 'pending_review'
    FROM rental r
    WHERE b.rental_id = r.id
      AND b.status = 'confirmed'
      AND r.status = 'pending'
  `;
  console.log('Demoted confirmed→pending_review for pending rentals:', pendingFix);

  // 2. Find ongoing rentals whose end_date is in the past (should be completed)
  const staleOngoing = await p.rental.findMany({
    where: { status: 'ongoing', end_date: { lt: now } },
    select: { id: true, renter_info: true, title: true, end_date: true }
  });
  console.log('\nStale ongoing rentals (end_date in past):', staleOngoing.length);
  for (const r of staleOngoing) {
    console.log('  Updating to completed:', r.renter_info, r.title?.substring(0, 50), 'ended:', r.end_date?.toISOString().split('T')[0]);
    await p.rental.update({
      where: { id: r.id },
      data: { status: 'completed' }
    });
  }

  // 3. Verify: count confirmed bookings by rental status
  const bookings = await p.booking.findMany({
    where: { status: 'confirmed' },
    select: { rental_id: true }
  });
  const rentalIds = [...new Set(bookings.map(b => b.rental_id).filter(Boolean))];
  const rentals = await p.rental.findMany({
    where: { id: { in: rentalIds } },
    select: { id: true, status: true }
  });
  const rentalMap = {};
  rentals.forEach(r => { rentalMap[r.id] = r; });

  const byStatus = {};
  bookings.forEach(b => {
    const rental = b.rental_id ? rentalMap[b.rental_id] : null;
    const rs = rental ? rental.status : 'NO_RENTAL';
    byStatus[rs] = (byStatus[rs] || 0) + 1;
  });

  console.log('\nConfirmed bookings by rental status AFTER fix:');
  Object.keys(byStatus).forEach(k => console.log('  ' + k + ': ' + byStatus[k]));

  await p.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
