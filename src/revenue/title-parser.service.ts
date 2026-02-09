import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../prisma/prisma.service';
import { getInventoryItemNames, findBestMatch } from '../utils/item-matcher';

export interface ParsedItem {
  item: string;
  qty: number;
}

@Injectable()
export class TitleParserService {
  private readonly logger = new Logger(TitleParserService.name);

  /** In-memory cache: title → parsed items (avoids duplicate AI calls within a session) */
  private readonly cache = new Map<string, ParsedItem[]>();

  private readonly apiKey: string | null;
  private readonly anthropicClient: Anthropic | null;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.apiKey = this.configService.get<string>('CEREBRAS_API_KEY') || null;
    const anthropicKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    this.anthropicClient = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
  }

  /**
   * Call Cerebras API directly with llama-3.3-70b (non-reasoning, fast, token-efficient).
   * Separate from GeminiService to avoid interfering with autolearn's model/quota.
   */
  private async callCerebras(prompt: string): Promise<string | null> {
    if (!this.apiKey) return null;

    try {
      const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 512,
        }),
      });

      if (!res.ok) {
        if (res.status === 429) {
          // Rate limited — wait and retry once
          this.logger.warn('Cerebras rate limited, waiting 10s...');
          await new Promise(r => setTimeout(r, 10_000));
          const retry = await fetch('https://api.cerebras.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 512,
            }),
          });
          if (!retry.ok) return null;
          const data = await retry.json();
          return data.choices?.[0]?.message?.content || null;
        }
        return null;
      }

      const data = await res.json();
      return data.choices?.[0]?.message?.content || null;
    } catch (error: any) {
      this.logger.error(`Cerebras API error: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse a Hygglo rental title into structured inventory items using AI.
   * Results are cached in-memory to avoid duplicate calls for the same title.
   */
  async parseTitleWithAI(title: string): Promise<ParsedItem[]> {
    if (!title || title.trim().length === 0) return [];

    const normalizedTitle = title.trim();

    // Check in-memory cache
    const cached = this.cache.get(normalizedTitle);
    if (cached) return cached;

    // Check if any rental with this exact title already has parsed_items (DB lookup)
    const existingWithItems = await this.prisma.$queryRaw<{ parsed_items: any }[]>`
      SELECT parsed_items FROM rental WHERE title = ${normalizedTitle} AND parsed_items IS NOT NULL LIMIT 1
    `;
    if (existingWithItems.length > 0 && existingWithItems[0].parsed_items) {
      const items = existingWithItems[0].parsed_items as ParsedItem[];
      this.cache.set(normalizedTitle, items);
      return items;
    }

    if (!this.apiKey) {
      this.logger.warn('No CEREBRAS_API_KEY — title parsing unavailable');
      return [];
    }

    const inventoryNames = getInventoryItemNames();

    const prompt = `Match this rental listing title to items from my inventory. Titles are SEO-heavy with synonyms and noise words — focus on the CORE product identity (brand + model/focal length).

TITLE: "${normalizedTitle}"

INVENTORY:
${inventoryNames.map(n => `- ${n}`).join('\n')}

MATCHING GUIDE:
- "fx 3" / "fx3" → "Sony FX3"
- "24-70mm f2.8 gmaster" / "24-70 gm" → "Sony GM 24-70mm f2.8"
- "70-200mm" with sony context → "Sony GM 70-200mm f2.8"
- "bmpcc 6k" → "BMPCC 6K Pro" or "BMPCC 6K Full Frame" (use "full frame" if title says so)
- "DJI Osmo Action 5" / "Action 5 pro" → "DJI Osmo Action Pro 5"
- "go pro hero 12" / "gopro 12" → "GoPro 12 Hero"
- "JBL partybox club 120" → "JBL Club 120 speaker"
- "pioneer DJ" / "RX3" / "rekordbox" → "DJ RX3 Pioneer controller"
- "a7III" / "a7 3" / "a73" → "Sony A7 III"
- "nanlite 500" → "Nanlite 500B"
- "v-mount" / "v mount" batteries → "V-mount 95mAh" or "V-mount 150mAh"
- "boom mic" / "shotgun sennheiser" → "Audio boom mic Sennheiser"
- "rode wireless" → "Rode Wireless Mic Pro set"
- "suction cup" / "suction mount" → "Suction cups"
- "2x" or "3x" prefix → set qty accordingly
- Bundle listings with "+" separate multiple items
- Ignore items NOT in inventory (tripods, stands, cables, cards unless 256GB, cases, adapters unless PL mount)

Return ONLY a JSON array. Example: [{"item": "Sony FX3", "qty": 1}, {"item": "Sony GM 24-70mm f2.8", "qty": 1}]`;

    try {
      const content = await this.callCerebras(prompt);
      if (!content) return [];

      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = content.trim();
      const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger.warn(`No JSON array in AI response for "${normalizedTitle.substring(0, 60)}": ${jsonStr.substring(0, 100)}`);
        return [];
      }
      jsonStr = jsonMatch[0];

      const parsed: ParsedItem[] = JSON.parse(jsonStr);

      // Validate: only keep items that exist in inventory
      const inventorySet = new Set(inventoryNames);
      const validated = parsed
        .filter(p => inventorySet.has(p.item) && p.qty > 0)
        .map(p => ({ item: p.item, qty: Math.round(p.qty) }));

      this.cache.set(normalizedTitle, validated);
      return validated;
    } catch (error: any) {
      this.logger.error(`Failed to parse title "${normalizedTitle.substring(0, 60)}": ${error.message}`);
      return [];
    }
  }

  /**
   * Use Claude Haiku vision to identify equipment in a listing photo.
   * Returns inventory-matched items found in the image.
   */
  async parsePhotoItems(photoUrls: string[], titleHint: string): Promise<ParsedItem[]> {
    if (!this.anthropicClient || !photoUrls.length) return [];

    // Filter to product photos only (skip profile photos which are tiny 120x120)
    const productPhotos = photoUrls.filter(u => u.includes('/products/'));
    if (productPhotos.length === 0) return [];

    const inventoryNames = getInventoryItemNames();

    try {
      const imageContent: any[] = productPhotos.slice(0, 3).map(url => ({
        type: 'image' as const,
        source: { type: 'url' as const, url },
      }));

      const response = await this.anthropicClient.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: `Identify ALL camera/video equipment visible in this rental listing photo.

Match each visible item to my inventory list:
${inventoryNames.map(n => `- ${n}`).join('\n')}

CRITICAL — Read brand names and model numbers PRINTED ON each item. Do NOT guess brands.

LENSES — Read the focal length printed on the barrel:
- "FE 3.5-5.6/28-70" or "28-70" = "Sony 28-70mm" (kit lens, NO red G badge, smaller, variable aperture)
- "FE 2.8/24-70 GM" with red G badge = "Sony GM 24-70mm f2.8" (larger, constant f2.8)
- If you see "28-70" or "3.5-5.6" anywhere on the lens, it is "Sony 28-70mm", NOT the GM

WIRELESS MICS — ONE brand per rental. Read the logo on the device:
- "RØDE" or "RODE" logo = Rode product. Small square transmitters (~4cm) with clip-on lavs = "Rode Wireless Go II set"
- "RØDE" or "RODE" logo on a small on-camera shotgun mic = "Rode Video Mic Go"
- "DJI" logo clearly visible on rounded square with LCD screen = "DJI Mic 2 wireless"
- A rental has ONE wireless mic brand. If ANY mic shows "RODE" branding, ALL the wireless mics and lavs in the image are Rode. Do NOT also add a DJI mic.
- Transmitters + receiver + lav mics = ONE set. Do not count each piece separately.

BATTERIES:
- Small rectangular with green "N" or "NP-F" text = "Sony NPF 970 batteries 2x sets" (qty: 1 regardless of count)
- Large rectangular with V-shaped mount = V-mount battery

Include: cameras, lenses, mics, gimbals, lights, monitors, wireless transmitters, tripods
Exclude: SD cards, memory cards, cables, cases, bags, adapters, handles, battery chargers
Only return items from my inventory list above.
Title context: "${titleHint}"

Return ONLY a JSON array: [{"item": "Exact inventory name", "qty": 1}]`,
            },
          ],
        }],
      });

      const content = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed: ParsedItem[] = JSON.parse(jsonMatch[0]);
      // Map vision results through findBestMatch for fuzzy matching
      const validated: ParsedItem[] = [];
      const seen = new Set<string>();
      for (const p of parsed) {
        if (p.qty <= 0) continue;
        const matched = findBestMatch(p.item, inventoryNames);
        if (matched && !seen.has(matched)) {
          seen.add(matched);
          validated.push({ item: matched, qty: Math.round(p.qty) });
        }
      }

      // Post-processing: resolve conflicting wireless mic brands
      // If both Rode and DJI wireless mics detected, keep only the Rode ones (DJI is likely hallucinated)
      const hasRodeWireless = validated.some(v => v.item.toLowerCase().includes('rode') && v.item.toLowerCase().includes('wireless'));
      const hasDjiWireless = validated.some(v =>
        (v.item === 'DJI Wireless Mics' || v.item === 'DJI Mic 2 wireless'));
      if (hasRodeWireless && hasDjiWireless) {
        const beforeCount = validated.length;
        const toRemove = validated.filter(v =>
          v.item === 'DJI Wireless Mics' || v.item === 'DJI Mic 2 wireless');
        for (const r of toRemove) {
          const idx = validated.indexOf(r);
          if (idx >= 0) validated.splice(idx, 1);
        }
        this.logger.log(`Dedup: removed ${beforeCount - validated.length} conflicting DJI mic(s) — Rode wireless already detected`);
      }

      this.logger.log(`Photo parse for "${titleHint.substring(0, 40)}": found ${validated.length} items: ${validated.map(v => v.item).join(', ')}`);
      return validated;
    } catch (error: any) {
      this.logger.warn(`Photo parsing failed: ${error.message?.substring(0, 100)}`);
      return [];
    }
  }

  /**
   * Enhance parsed_items using listing photos.
   * Vision ALWAYS runs when photos exist — it validates title-parsed items AND discovers extras.
   * Vision results are authoritative: if vision detects a different lens variant (e.g. 28-70mm vs GM 24-70mm),
   * the vision result wins because it sees the actual physical item.
   */
  async enhanceWithPhotos(
    rentalId: string,
    title: string,
    currentItems: ParsedItem[],
    photoUrls: string[],
  ): Promise<ParsedItem[]> {
    const hasPhotos = photoUrls.some(u => u.includes('/products/'));
    if (!hasPhotos) return currentItems;

    this.logger.log(`Vision analysis for "${title.substring(0, 50)}" (${currentItems.length} title-parsed items)`);

    const photoItems = await this.parsePhotoItems(photoUrls, title);
    if (photoItems.length === 0) return currentItems;

    // Vision-authoritative merge: vision items override title items in same category
    const merged = new Map<string, ParsedItem>();

    // Start with title items
    for (const item of currentItems) merged.set(item.item, item);

    // Vision items: add new discoveries AND replace conflicting title items
    for (const visionItem of photoItems) {
      if (merged.has(visionItem.item)) continue; // Already have exact match

      // Check if vision found a different variant of same product category
      // e.g. title says "Sony GM 24-70mm f2.8" but vision sees "Sony 28-70mm"
      const visionCategory = this.getItemCategory(visionItem.item);
      if (visionCategory) {
        for (const [key] of merged) {
          if (key !== visionItem.item && this.getItemCategory(key) === visionCategory) {
            this.logger.log(`Vision override: "${key}" → "${visionItem.item}" (${visionCategory})`);
            merged.delete(key);
            break;
          }
        }
      }
      merged.set(visionItem.item, visionItem);
    }

    const result = Array.from(merged.values());
    const changed = result.length !== currentItems.length ||
      result.some(r => !currentItems.find(c => c.item === r.item));

    if (changed) {
      this.logger.log(`Vision result: ${result.map(r => r.item).join(', ')}`);
      const jsonValue = JSON.stringify(result);
      await this.prisma.$executeRaw`
        UPDATE rental SET parsed_items = ${jsonValue}::jsonb, updated_at = NOW()
        WHERE id = ${rentalId}
      `;
    }

    return result;
  }

  /**
   * Categorize inventory items for conflict detection.
   * Items in the same category are variants (e.g. "Sony GM 24-70mm f2.8" vs "Sony 28-70mm" = both "sony-zoom-lens").
   */
  private getItemCategory(item: string): string | null {
    const lower = item.toLowerCase();
    // Sony zoom lenses (standard range ~24-70)
    if (lower.includes('sony') && (lower.includes('24-70') || lower.includes('28-70'))) return 'sony-standard-zoom';
    // Sony tele lenses
    if (lower.includes('sony') && lower.includes('70-200')) return 'sony-tele-zoom';
    // Sony wide zoom
    if (lower.includes('sony') && (lower.includes('16-35') || lower.includes('12-24'))) return 'sony-wide-zoom';
    // DJI gimbal
    if (lower.includes('dji') && lower.includes('gimbal') && !lower.includes('battery')) return 'dji-gimbal';
    // Rode wireless mics
    if (lower.includes('rode') && lower.includes('wireless')) return 'rode-wireless-mic';
    // DJI wireless mics
    if (lower.includes('dji') && (lower.includes('mic') || lower.includes('wireless'))) return 'dji-wireless-mic';
    return null;
  }

  /**
   * Backfill parsed_items for all rentals that don't have them yet.
   * Groups by unique title to minimize AI calls.
   */
  async backfillParsedItems(): Promise<{ updated: number; skipped: number; failed: number; titles: number }> {
    // Get all unique titles that need parsing
    const unparsed = await this.prisma.$queryRaw<{ title: string }[]>`
      SELECT DISTINCT title FROM rental WHERE parsed_items IS NULL
    `;

    const uniqueTitles = unparsed.map(r => r.title);
    this.logger.log(`Backfill: ${uniqueTitles.length} unique titles to parse`);

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < uniqueTitles.length; i++) {
      const title = uniqueTitles[i];
      try {
        const items = await this.parseTitleWithAI(title);
        const jsonValue = JSON.stringify(items.length === 0 ? [] : items);

        const count = await this.prisma.$executeRaw`
          UPDATE rental SET parsed_items = ${jsonValue}::jsonb, updated_at = NOW()
          WHERE title = ${title} AND parsed_items IS NULL
        `;

        if (items.length === 0) {
          skipped++;
        } else {
          updated += Number(count);
        }
      } catch (error: any) {
        this.logger.error(`Failed to backfill title "${title.substring(0, 60)}": ${error.message}`);
        failed++;
      }

      // Log progress every 50 titles
      if ((i + 1) % 50 === 0 || i === uniqueTitles.length - 1) {
        this.logger.log(`Backfill progress: ${i + 1}/${uniqueTitles.length} titles (${updated} updated, ${skipped} skipped)`);
      }
    }

    this.logger.log(`Backfill complete: ${updated} rentals updated, ${skipped} skipped (no match), ${failed} failed`);
    return { updated, skipped, failed, titles: uniqueTitles.length };
  }

  /**
   * Re-run photo vision analysis on all rentals that have photos.
   * Clears title-parse cache first so vision results can override stale title assumptions.
   * Useful after prompt improvements to correct misidentified items.
   */
  async reanalyzeAllPhotos(): Promise<{ analyzed: number; updated: number; failed: number; changes: { rentalId: string; renter: string; before: string; after: string }[] }> {
    this.cache.clear();

    const rentals = await this.prisma.$queryRaw<{
      id: string; title: string; photos_urls: string[]; parsed_items: any; renter_info: string | null;
    }[]>`
      SELECT id, title, photos_urls, parsed_items, renter_info
      FROM rental
      WHERE photos_urls IS NOT NULL AND array_length(photos_urls, 1) > 0
      ORDER BY created_at DESC
      LIMIT 200
    `;

    this.logger.log(`Photo reanalysis: ${rentals.length} rentals with photos`);

    let analyzed = 0;
    let updated = 0;
    let failed = 0;
    const changes: { rentalId: string; renter: string; before: string; after: string }[] = [];

    for (const rental of rentals) {
      try {
        const currentItems: ParsedItem[] = (rental.parsed_items as ParsedItem[]) || [];
        const result = await this.enhanceWithPhotos(rental.id, rental.title, currentItems, rental.photos_urls);
        analyzed++;

        const changed = result.length !== currentItems.length ||
          result.some(r => !currentItems.find(c => c.item === r.item));
        if (changed) {
          updated++;
          changes.push({
            rentalId: rental.id,
            renter: rental.renter_info || 'Unknown',
            before: currentItems.map(i => i.item).join(', ') || '(none)',
            after: result.map(i => i.item).join(', '),
          });
        }

        // Rate limit: 1 second between vision calls
        await new Promise(r => setTimeout(r, 1000));
      } catch (err: any) {
        this.logger.warn(`Photo reanalysis failed for ${rental.id}: ${err.message?.substring(0, 80)}`);
        failed++;
      }

      if (analyzed % 20 === 0) {
        this.logger.log(`Photo reanalysis progress: ${analyzed}/${rentals.length} (${updated} updated)`);
      }
    }

    this.logger.log(`Photo reanalysis complete: ${analyzed} analyzed, ${updated} updated, ${failed} failed`);
    return { analyzed, updated, failed, changes };
  }
}
