const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const ACCESSORY_NAMES = [
  'PL to Sony E mount', 'PL to EF mount', 'PL to RF mount', 'PL to L mount',
  'CF Express Type A card', 'ND filter', '256GB card'
];

async function main() {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999);

  // RAW confirmed bookings
  const all = await p.booking.findMany({
    where: { status: 'confirmed' },
    select: { id: true, item_name: true, renter_name: true, start_date: true, end_date: true, revenue: true, rental_id: true }
  });

  console.log('Raw confirmed bookings:', all.length);

  // Check for bookings with raw Hygglo titles (long titles with | or + or keywords like "Like", "Kit")
  const rawTitles = all.filter(b => b.item_name.length > 50 || b.item_name.includes('|') || b.item_name.includes('Like'));
  console.log('Bookings with raw Hygglo titles (ghost):', rawTitles.length);
  for (const b of rawTitles) {
    console.log(`  ID: ${b.id.substring(0,8)}... "${b.item_name.substring(0,80)}..." rev=£${b.revenue||0} ${b.start_date.toISOString().split('T')[0]}`);
  }

  // Check duplicates
  const keyCount = new Map();
  for (const b of all) {
    const key = `${b.item_name}|${b.renter_name}|${b.start_date.toISOString().split('T')[0]}`;
    keyCount.set(key, (keyCount.get(key) || 0) + 1);
  }
  const dupeCount = [...keyCount.values()].filter(c => c > 1).reduce((s, c) => s + c - 1, 0);
  console.log('Duplicate bookings (extra copies):', dupeCount);

  // Real counts after cleaning ghosts and dupes
  const clean = all.filter(b => b.item_name.length <= 50 && !b.item_name.includes('|') && !b.item_name.includes('Like'));
  const cleanSeen = new Map();
  for (const b of clean) {
    const key = `${b.item_name}|${b.renter_name}|${b.start_date.toISOString().split('T')[0]}`;
    const existing = cleanSeen.get(key);
    if (!existing || (b.revenue || 0) > (existing.revenue || 0)) {
      cleanSeen.set(key, b);
    }
  }
  const cleanDeduped = Array.from(cleanSeen.values());

  const cleanOngoing = cleanDeduped.filter(b => b.start_date <= todayEnd && b.end_date >= todayStart);
  const cleanUpcoming = cleanDeduped.filter(b => b.start_date > todayEnd);
  const cleanCompleted = cleanDeduped.filter(b => b.end_date < todayStart);

  console.log(`\n=== CLEAN COUNTS (no ghosts, no dupes) ===`);
  console.log('Total:', cleanDeduped.length);
  console.log('Ongoing:', cleanOngoing.length);
  console.log('Upcoming:', cleanUpcoming.length);
  console.log('Completed:', cleanCompleted.length);
  console.log('Active (ongoing+upcoming):', cleanOngoing.length + cleanUpcoming.length);

  // Show what the rental stats give
  const rentals = await p.rental.findMany({
    select: { id: true, status: true }
  });
  const rentalOngoing = rentals.filter(r => r.status === 'ongoing').length;
  const rentalUpcoming = rentals.filter(r => r.status === 'upcoming').length;
  console.log(`\n=== RENTAL TABLE COUNTS ===`);
  console.log('Total rentals:', rentals.length);
  console.log('Ongoing rentals:', rentalOngoing);
  console.log('Upcoming rentals:', rentalUpcoming);
  console.log('NOTE: These are RENTALS not bookings. A rental can have multiple bookings (bundle items).');

  // IDs of ghost bookings to clean
  console.log(`\n=== GHOST BOOKING IDs to delete ===`);
  for (const b of rawTitles) {
    console.log(b.id);
  }

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
