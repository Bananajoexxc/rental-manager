const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const ACCESSORY_NAMES = [
  'PL to Sony E mount', 'PL to EF mount', 'PL to RF mount', 'PL to L mount',
  'CF Express Type A card', 'ND filter', '256GB card'
];

async function main() {
  // 1. Find accessory bookings
  const accBookings = await p.booking.findMany({
    where: { item_name: { in: ACCESSORY_NAMES } },
    select: { id: true, item_name: true, rental_id: true, revenue: true }
  });
  console.log('Accessory bookings found:', accBookings.length);

  // Get affected rental IDs before deleting
  const affectedRentalIds = [...new Set(accBookings.filter(b => b.rental_id).map(b => b.rental_id))];
  console.log('Affected rentals:', affectedRentalIds.length);

  // Delete accessory bookings
  const deleted = await p.booking.deleteMany({
    where: { item_name: { in: ACCESSORY_NAMES } }
  });
  console.log('Deleted:', deleted.count);

  // 2. Redistribute revenue for affected rentals
  let redistributed = 0;
  for (const rentalId of affectedRentalIds) {
    const rental = await p.rental.findUnique({ where: { id: rentalId } });
    if (!rental) continue;

    const remaining = await p.booking.findMany({
      where: { rental_id: rentalId, status: { in: ['confirmed', 'pending_review'] } }
    });
    if (remaining.length === 0) continue;

    const totalRevenue = rental.rental_price || 0;
    const perItem = Math.round((totalRevenue / remaining.length) * 100) / 100;

    for (const b of remaining) {
      await p.booking.update({
        where: { id: b.id },
        data: { revenue: perItem > 0 ? perItem : null, platform_fee: 0, net_profit: perItem > 0 ? perItem : null }
      });
    }
    redistributed++;
  }
  console.log('Rentals redistributed:', redistributed);

  // 3. Fix ALL bookings: platform_fee → 0, net_profit → revenue
  const allWithRevenue = await p.booking.findMany({
    where: { revenue: { not: null } },
    select: { id: true, revenue: true, platform_fee: true, net_profit: true }
  });

  let feesCorrected = 0;
  for (const b of allWithRevenue) {
    if (b.platform_fee !== 0 || b.net_profit !== b.revenue) {
      await p.booking.update({
        where: { id: b.id },
        data: { platform_fee: 0, net_profit: b.revenue }
      });
      feesCorrected++;
    }
  }
  console.log('Fees corrected:', feesCorrected);

  // 4. Verify
  const afterTotal = await p.booking.count();
  const afterAcc = await p.booking.count({ where: { item_name: { in: ACCESSORY_NAMES } } });
  const afterFees = await p.booking.count({ where: { platform_fee: { gt: 0 } } });
  const sample = await p.booking.findMany({
    take: 5, where: { revenue: { not: null } },
    select: { item_name: true, revenue: true, platform_fee: true, net_profit: true }
  });
  console.log('\n=== AFTER CLEANUP ===');
  console.log('Total bookings:', afterTotal);
  console.log('Accessory bookings:', afterAcc);
  console.log('Bookings with fees > 0:', afterFees);
  console.log('Sample:', JSON.stringify(sample, null, 2));

  // 5. Revenue summary
  const allBookings = await p.booking.findMany({
    where: { status: 'confirmed', revenue: { not: null } },
    select: { revenue: true, net_profit: true, start_date: true }
  });

  const now = new Date();
  const febStart = new Date(2026, 1, 1);
  const febBookings = allBookings.filter(b => b.start_date >= febStart);
  const febRevenue = febBookings.reduce((s, b) => s + (b.revenue || 0), 0);
  const febProfit = febBookings.reduce((s, b) => s + (b.net_profit || 0), 0);
  const totalRevenue = allBookings.reduce((s, b) => s + (b.revenue || 0), 0);
  const totalProfit = allBookings.reduce((s, b) => s + (b.net_profit || 0), 0);

  console.log('\n=== REVENUE SUMMARY ===');
  console.log('Feb revenue:', Math.round(febRevenue * 100) / 100);
  console.log('Feb profit (= revenue, fees pre-deducted):', Math.round(febProfit * 100) / 100);
  console.log('Feb bookings:', febBookings.length);
  console.log('All-time revenue:', Math.round(totalRevenue * 100) / 100);
  console.log('All-time profit:', Math.round(totalProfit * 100) / 100);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
