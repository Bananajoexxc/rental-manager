const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  // Count confirmed bookings by month
  const bookings = await p.booking.findMany({
    where: { status: 'confirmed' },
    select: { start_date: true, revenue: true, account: true, item_name: true, renter_name: true },
    orderBy: { start_date: 'asc' },
  });
  
  const byMonth = {};
  for (const b of bookings) {
    const m = b.start_date.toISOString().substring(0, 7);
    if (!byMonth[m]) byMonth[m] = { count: 0, revenue: 0, items: [] };
    byMonth[m].count++;
    byMonth[m].revenue += b.revenue || 0;
  }
  
  console.log("=== Confirmed bookings by month ===");
  for (const [m, data] of Object.entries(byMonth).sort()) {
    console.log(m + ": " + data.count + " bookings, £" + Math.round(data.revenue * 100) / 100);
  }
  
  // Check January specifically
  const janBookings = bookings.filter(b => b.start_date >= new Date("2026-01-01") && b.start_date < new Date("2026-02-01"));
  console.log("\n=== January 2026 bookings (" + janBookings.length + ") ===");
  for (const b of janBookings) {
    console.log("  " + b.renter_name.padEnd(22) + b.item_name.substring(0,35).padEnd(37) + "£" + (b.revenue || 0) + " | " + b.account);
  }
  
  // Also check how many rentals we have per month (from rental table)
  const rentals = await p.rental.findMany({
    select: { start_date: true, rental_price: true, status: true },
  });
  
  const rentalsByMonth = {};
  for (const r of rentals) {
    if (!r.start_date) continue;
    const m = r.start_date.toISOString().substring(0, 7);
    if (!rentalsByMonth[m]) rentalsByMonth[m] = { count: 0, completed: 0, revenue: 0 };
    rentalsByMonth[m].count++;
    if (r.status === 'completed') rentalsByMonth[m].completed++;
    rentalsByMonth[m].revenue += r.rental_price || 0;
  }
  
  console.log("\n=== Rentals by month ===");
  for (const [m, data] of Object.entries(rentalsByMonth).sort()) {
    console.log(m + ": " + data.count + " rentals (" + data.completed + " completed), £" + Math.round(data.revenue));
  }
  
  await p.$disconnect();
})();
