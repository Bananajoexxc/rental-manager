const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart); todayEnd.setHours(23,59,59,999);
  
  const active = await p.booking.findMany({
    where: { status: 'confirmed', end_date: { gte: todayStart } },
    select: { id: true, renter_name: true, item_name: true, start_date: true, end_date: true, account: true, rental_id: true, created_at: true },
    orderBy: { start_date: 'asc' },
  });
  
  console.log("=== Currently active confirmed bookings: " + active.length + " ===");
  
  // Get rental listing_ids
  const rentalIds = [...new Set(active.map(b => b.rental_id).filter(Boolean))];
  const rentals = await p.rental.findMany({
    where: { id: { in: rentalIds } },
    select: { id: true, listing_id: true, status: true },
  });
  const rentalMap = new Map(rentals.map(r => [r.id, r]));
  
  const ongoing = active.filter(b => b.start_date <= todayEnd && b.end_date >= todayStart);
  const upcoming = active.filter(b => b.start_date > todayEnd);
  
  console.log("\nONGOING (" + ongoing.length + "):");
  for (const b of ongoing) {
    const r = rentalMap.get(b.rental_id);
    const listing = r ? r.listing_id : 'NO_RENTAL';
    const rStatus = r ? r.status : '?';
    console.log("  " + b.renter_name.padEnd(22) + b.item_name.substring(0,35).padEnd(37) + b.start_date.toISOString().split("T")[0] + "->" + b.end_date.toISOString().split("T")[0] + " | " + b.account + " | L:" + listing + " | rs:" + rStatus);
  }
  
  console.log("\nUPCOMING (" + upcoming.length + "):");
  for (const b of upcoming) {
    const r = rentalMap.get(b.rental_id);
    const listing = r ? r.listing_id : 'NO_RENTAL';
    const rStatus = r ? r.status : '?';
    console.log("  " + b.renter_name.padEnd(22) + b.item_name.substring(0,35).padEnd(37) + b.start_date.toISOString().split("T")[0] + "->" + b.end_date.toISOString().split("T")[0] + " | " + b.account + " | L:" + listing + " | rs:" + rStatus);
  }
  
  await p.$disconnect();
})();
