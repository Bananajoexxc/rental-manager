const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Check a few rentals: compare rental.rental_price vs sum of booking.revenue
  const rentals = await p.rental.findMany({
    take: 10,
    where: { rental_price: { not: null } },
    orderBy: { created_at: 'desc' },
    select: { id: true, title: true, rental_price: true, price_per_day: true }
  });

  for (const r of rentals) {
    const bookings = await p.booking.findMany({
      where: { rental_id: r.id },
      select: { item_name: true, revenue: true, net_profit: true, status: true }
    });
    const totalBookingRev = bookings.reduce((s, b) => s + (b.revenue || 0), 0);
    console.log(`${r.title}: rental_price=£${r.rental_price}, bookings=${bookings.length}, booking_rev=£${totalBookingRev.toFixed(2)}`);
    for (const b of bookings) {
      console.log(`  - ${b.item_name}: rev=£${b.revenue || 0} profit=£${b.net_profit || 0} [${b.status}]`);
    }
  }

  // Check: are there rentals where rental_price looks like renter total (i.e., >30% more than booking revenue)?
  const allRentals = await p.rental.findMany({
    where: { rental_price: { not: null } },
    select: { id: true, title: true, rental_price: true }
  });

  let suspicious = 0;
  for (const r of allRentals) {
    const bookings = await p.booking.findMany({
      where: { rental_id: r.id, revenue: { not: null } },
      select: { revenue: true }
    });
    if (bookings.length === 0) continue;
    const bookingRev = bookings.reduce((s, b) => s + (b.revenue || 0), 0);
    // If rental_price is much higher than booking revenue, it was probably renter total, not ownerEarnings
    if (r.rental_price > bookingRev * 1.1 && bookingRev > 0) {
      suspicious++;
    }
  }
  console.log(`\nRentals where rental_price > booking_revenue * 1.1: ${suspicious}/${allRentals.length}`);

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
