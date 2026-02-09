const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  // Find confirmed bookings with future or current dates
  const active = await p.booking.findMany({
    where: { 
      status: 'confirmed',
      end_date: { gte: todayStart },
    },
    select: { id: true, renter_name: true, item_name: true, start_date: true, end_date: true, account: true, rental_id: true, created_at: true },
    orderBy: { start_date: 'asc' },
  });
  
  console.log("=== Active confirmed bookings (end >= today) ===");
  console.log("Total:", active.length);
  
  // Split by recently created (likely from completed import)
  const cutoff = new Date("2026-02-07T13:00:00Z"); // before the sync
  const oldBookings = active.filter(b => b.created_at < cutoff);
  const newBookings = active.filter(b => b.created_at >= cutoff);
  
  console.log("\nOLD bookings (pre-sync):", oldBookings.length);
  for (const b of oldBookings) {
    console.log("  " + b.renter_name.padEnd(22) + b.item_name.substring(0,35).padEnd(37) + b.start_date.toISOString().split("T")[0] + " -> " + b.end_date.toISOString().split("T")[0] + " | " + b.account);
  }
  
  console.log("\nNEW bookings (from sync):", newBookings.length);
  for (const b of newBookings) {
    console.log("  " + b.renter_name.padEnd(22) + b.item_name.substring(0,35).padEnd(37) + b.start_date.toISOString().split("T")[0] + " -> " + b.end_date.toISOString().split("T")[0] + " | " + b.account);
  }
  
  await p.$disconnect();
})();
