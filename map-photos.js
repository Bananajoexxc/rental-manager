const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const fs = require("fs");

async function main() {
  const downloadedIds = fs.readdirSync("/tmp/listing-images").map(f => f.replace(".jpg",""));
  console.log("Downloaded IDs count:", downloadedIds.length);

  const rentals = await p.rental.findMany({
    where: { listing_id: { in: downloadedIds } },
    select: { listing_id: true, title: true, parsed_items: true, photos_urls: true, account: true },
    orderBy: { created_at: "desc" }
  });

  const seen = new Set();
  const unique = [];
  for (const r of rentals) {
    if (!seen.has(r.listing_id)) {
      seen.add(r.listing_id);
      unique.push(r);
    }
  }

  console.log("Matched unique listings:", unique.length);
  for (const row of unique) {
    const items = row.parsed_items ? row.parsed_items.map(i => i.item).join(", ") : "NONE";
    console.log(`\n[${row.account}] ${row.listing_id}: ${(row.title || "").substring(0, 100)}`);
    console.log(`  >> ${items}`);
  }

  await p.$disconnect();
}
main().catch(e => { console.error("ERROR:", e.message); p.$disconnect(); });
