/**
 * Backfill: Fetch missing photos + run vision analysis for active/upcoming rentals.
 * Focus on rentals that appear on the calendar.
 *
 * Usage: npx ts-node scripts/backfill-photos.ts [phase1|phase2|both]
 */
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const HYGGLO_BASE = 'https://api.hygglo.com/v2';

// Must match MASTER_INVENTORY in item-matcher.ts
const INVENTORY_ITEMS = [
  'Sony FX3', 'Sony FX6', 'Sony A7IV', 'Sony A7SIII', 'Sony A7RV',
  'Sony GM 24-70mm f2.8', 'Sony GM 70-200mm f2.8', 'Sony GM 16-35mm f2.8',
  'Sony GM 90mm f2.8 Macro', 'Sony GM 12-24mm f2.8', 'Sony GM 50mm f1.2',
  'Sony GM 85mm f1.4', 'Sony GM 135mm f1.8', 'Sony GM 24mm f1.4',
  'Sony GM 35mm f1.4', 'Sony GM 20-70mm f4',
  'Sony 28-60mm f4-5.6', 'Sony 50mm f1.8', 'Sony 85mm f1.8',
  'Canon R5', 'Canon R6 II', 'Canon RF 24-70mm f2.8', 'Canon RF 70-200mm f2.8',
  'Canon RF 15-35mm f2.8', 'Canon EF 24-70mm f2.8', 'Canon EF 70-200mm f2.8',
  'BMPCC 6K Full Frame', 'BMPCC 6K G2',
  'DJI RS3 Pro', 'DJI RS4 Pro', 'DJI Ronin SC',
  'DJI Mic 2', 'DJI Mic', 'Rode Wireless GO II', 'Rode Wireless PRO',
  'Rode VideoMic NTG', 'Rode NTG5',
  'Sennheiser MKE 600', 'Sennheiser EW 112P',
  'Atomos Ninja V', 'Atomos Ninja V+',
  'DJI Mavic 3 Pro', 'DJI Mini 4 Pro', 'DJI Avata 2',
  'Aputure 300D II', 'Aputure 600D Pro', 'Aputure MC Pro',
  'Nanlite Forza 60', 'Nanlite PavoTube II 6C',
  'Godox SL200 III', 'Godox ML60',
  'SmallHD 702 Touch', 'SmallHD Focus Pro',
  'Anker Power Station F2000', 'Anker Nebula Projector',
  'DJ RX3 Pioneer controller', 'JBL PartyBox 310', 'JBL Charge 5',
  'Motorized slider', 'Video tripod', 'V-mount battery',
  'Sony NP-FZ100 battery', 'SanDisk CFexpress Type A',
];

function extractSlug(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/^\//, '').replace(/\/$/, '');
    const segments = pathname.split('/');
    return segments[segments.length - 1] || null;
  } catch {
    return url || null;
  }
}

async function phase1_fetchPhotos() {
  console.log('\n=== PHASE 1: Fetching missing photos from Hygglo ===\n');

  const missing = await prisma.$queryRaw<any[]>`
    SELECT DISTINCT ON (listing_url) id, title, listing_url
    FROM rental
    WHERE (array_length(photos_urls, 1) IS NULL OR photos_urls = '{}')
      AND listing_url IS NOT NULL AND listing_url != ''
    ORDER BY listing_url, created_at DESC
  `;

  console.log(`Found ${missing.length} unique listings missing photos`);
  let fetched = 0, failed = 0;

  for (let i = 0; i < missing.length; i++) {
    const rental = missing[i];
    const slug = extractSlug(rental.listing_url);
    if (!slug) { failed++; continue; }

    try {
      const resp = await axios.get(`${HYGGLO_BASE}/product-listings/${slug}`, { timeout: 10000 });
      const images: any[] = resp.data.images || resp.data.photos || [];
      const photoUrls = images
        .map((img: any) => typeof img === 'string' ? img : (img?.url || img?.src || ''))
        .filter(Boolean);

      if (photoUrls.length > 0) {
        const result = await prisma.rental.updateMany({
          where: { listing_url: rental.listing_url },
          data: { photos_urls: photoUrls, updated_at: new Date() },
        });
        fetched++;
        console.log(`  [${i+1}/${missing.length}] ${photoUrls.length} photos -> ${result.count} rows | ${rental.title?.substring(0, 50)}`);
      } else {
        failed++;
      }
    } catch (err: any) {
      const status = err.response?.status || err.code || 'ERR';
      console.log(`  [${i+1}/${missing.length}] ${status} | ${rental.title?.substring(0, 50)}`);
      failed++;
    }

    if (i < missing.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nPhase 1: ${fetched} fetched, ${failed} failed`);
}

async function phase2_visionAnalysis() {
  console.log('\n=== PHASE 2: Vision analysis for sparse parsed_items ===\n');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set!'); return; }

  const anthropic = new Anthropic({ apiKey });

  // Group by unique title - all rentals with same title get the same items
  const sparse = await prisma.$queryRaw<any[]>`
    SELECT DISTINCT ON (title) id, title, photos_urls, parsed_items::text as items_text
    FROM rental
    WHERE array_length(photos_urls, 1) > 0
      AND (
        parsed_items IS NULL
        OR parsed_items::text = 'null'
        OR parsed_items::text = '[]'
        OR jsonb_array_length(parsed_items::jsonb) <= 1
      )
    ORDER BY title, created_at DESC
  `;

  console.log(`Found ${sparse.length} unique titles needing vision analysis`);
  let enhanced = 0, skipped = 0, errors = 0;

  for (let i = 0; i < sparse.length; i++) {
    const rental = sparse[i];
    const photoUrls: string[] = rental.photos_urls || [];
    const productPhotos = photoUrls.filter((u: string) => u.includes('/products/'));

    if (productPhotos.length === 0) {
      skipped++;
      continue;
    }

    try {
      const imageContent = productPhotos.slice(0, 3).map((url: string) => ({
        type: 'image' as const,
        source: { type: 'url' as const, url },
      }));

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: `Identify ALL camera/video equipment in this rental listing photo. Title: "${rental.title?.substring(0, 80)}"

Match to inventory:
${INVENTORY_ITEMS.map(n => `- ${n}`).join('\n')}

Rules:
- Include main camera AND all lenses, mics, gimbals, lights visible
- "Standard zoom" with Sony = "Sony GM 24-70mm f2.8" unless focal length visible
- Only return items from inventory above
- Tripods, SD cards, batteries, bags = ignore

Return ONLY JSON: [{"item": "Name", "qty": 1}]`,
            },
          ],
        }],
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { skipped++; continue; }

      const parsed: Array<{item: string, qty: number}> = JSON.parse(jsonMatch[0]);
      const inventorySet = new Set(INVENTORY_ITEMS);
      const validated = parsed.filter(p => inventorySet.has(p.item) && p.qty > 0);

      if (validated.length === 0) { skipped++; continue; }

      // Merge with existing
      let existing: Array<{item: string, qty: number}> = [];
      try {
        if (rental.items_text && rental.items_text !== 'null' && rental.items_text !== '[]') {
          existing = JSON.parse(rental.items_text);
        }
      } catch { /* ignore */ }

      const merged = new Map<string, {item: string, qty: number}>();
      for (const item of existing) merged.set(item.item, item);
      for (const item of validated) if (!merged.has(item.item)) merged.set(item.item, item);
      const final = Array.from(merged.values());

      // Update ALL rentals with this title
      const jsonValue = JSON.stringify(final);
      const result = await prisma.$executeRaw`
        UPDATE rental SET parsed_items = ${jsonValue}::jsonb, updated_at = NOW()
        WHERE title = ${rental.title}
      `;

      // Also populate extracteditem table for the primary rental
      for (const item of final) {
        try {
          await prisma.extracteditem.create({
            data: { rental_id: rental.id, item_name: item.item, source: 'photo', confidence_score: 0.9 },
          });
        } catch { /* ignore dups */ }
      }

      enhanced++;
      console.log(`  [${i+1}/${sparse.length}] +${final.length - existing.length} items (${final.length} total) -> ${result} rows | ${rental.title?.substring(0, 50)}`);
      console.log(`    ${final.map(f => f.item).join(', ')}`);

    } catch (err: any) {
      console.log(`  [${i+1}/${sparse.length}] ERR: ${err.message?.substring(0, 80)} | ${rental.title?.substring(0, 50)}`);
      errors++;
    }

    if (i < sparse.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nPhase 2: ${enhanced} enhanced, ${skipped} skipped, ${errors} errors`);
}

async function main() {
  const phase = process.argv[2] || 'both';
  try {
    if (phase === 'phase1' || phase === 'both') await phase1_fetchPhotos();
    if (phase === 'phase2' || phase === 'both') await phase2_visionAnalysis();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
