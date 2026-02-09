const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const active = await p.booking.findMany({
    where: { status: 'confirmed', end_date: { gte: todayStart } },
    select: { id: true, renter_name: true, item_name: true, start_date: true, end_date: true, account: true, rental_id: true },
    orderBy: { start_date: 'asc' },
  });
  
  // Check which have valid rental_ids with listing_ids
  let noRentalId = 0;
  let noListingId = 0;
  let withListingId = 0;
  
  for (const b of active) {
    if (!b.rental_id) {
      noRentalId++;
      console.log("NO RENTAL_ID: " + b.renter_name + " | " + b.item_name.substring(0,40));
      continue;
    }
    
    const rental = await p.rental.findUnique({
      where: { id: b.rental_id },
      select: { listing_id: true },
    });
    
    if (!rental || !rental.listing_id) {
      noListingId++;
      console.log("NO LISTING_ID: " + b.renter_name + " | " + b.item_name.substring(0,40) + " | rental_id=" + b.rental_id.substring(0,8));
      continue;
    }
    
    withListingId++;
    console.log("HAS LISTING: " + b.renter_name.padEnd(22) + b.item_name.substring(0,35).padEnd(37) + "listing=" + rental.listing_id.substring(0,10) + " | " + b.account);
  }
  
  console.log("\nSummary: " + withListingId + " with listing_id, " + noRentalId + " no rental_id, " + noListingId + " no listing_id");
  
  await p.$disconnect();
})();
