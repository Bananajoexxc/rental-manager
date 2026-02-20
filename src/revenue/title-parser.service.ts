import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../prisma/prisma.service';
import { getInventoryItemNames, findBestMatch } from '../utils/item-matcher';
import { getVerifiedItems } from '../data/listing-photo-reference';

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
   * Call Claude Haiku for title parsing. Reliable JSON output, follows instructions precisely.
   */
  private async callHaiku(prompt: string): Promise<string | null> {
    if (!this.anthropicClient) return null;

    try {
      const response = await this.anthropicClient.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.content[0]?.type === 'text' ? response.content[0].text : null;
    } catch (error: any) {
      this.logger.error(`Claude Haiku API error: ${error.message}`);
      return null;
    }
  }

  /**
   * Pattern-based overrides for titles the AI consistently fails on.
   * These are checked BEFORE the AI call and bypass it entirely if matched.
   * Patterns are tested against the lowercased, SEO-stripped title.
   */
  private matchTitlePatterns(normalizedTitle: string): ParsedItem[] | null {
    const lower = normalizedTitle.toLowerCase();

    // DZO Vespid 6x lens set — title doesn't list individual focal lengths
    if (/vespid.*prime.*6x/i.test(lower) || /6x.*vespid/i.test(lower) || /vespid.*6.*lens.*set/i.test(lower)) {
      return [
        { item: 'DZO Vespid Prime 16mm T2.1', qty: 1 },
        { item: 'DZO Vespid Prime 25mm T2.1', qty: 1 },
        { item: 'DZO Vespid Prime 50mm T2.1', qty: 1 },
        { item: 'DZO Vespid Prime 75mm T2.1', qty: 1 },
        { item: 'DZO Vespid Prime 100mm T2.1', qty: 1 },
        { item: 'DZO Vespid Prime 125mm T2.1', qty: 1 },
      ];
    }

    // DZO Vespid 3x lens set — most common combo
    if (/vespid.*prime.*3x/i.test(lower) || /3x.*vespid/i.test(lower) || /vespid.*3.*lens.*set/i.test(lower)) {
      return [
        { item: 'DZO Vespid Prime 25mm T2.1', qty: 1 },
        { item: 'DZO Vespid Prime 50mm T2.1', qty: 1 },
        { item: 'DZO Vespid Prime 75mm T2.1', qty: 1 },
      ];
    }

    // DZO Vespid individual lenses
    const vespidMatch = lower.match(/vespid.*prime.*?(\d+)mm/i);
    if (vespidMatch) {
      const fl = vespidMatch[1];
      const tStop = fl === '16' ? 'T2.8' : 'T2.1';
      const itemName = `DZO Vespid Prime ${fl}mm ${tStop}`;
      return [{ item: itemName, qty: 1 }];
    }

    // V-mount batteries — "v mount", "v-mount", "150 wah", "150wh"
    if (/v[\s-]?mount.*batter/i.test(lower) || /batter.*v[\s-]?mount/i.test(lower)) {
      const qtyMatch = lower.match(/(\d+)x\s*v[\s-]?mount/i) || lower.match(/(\d+)x\s.*v[\s-]?mount/i);
      const qty = qtyMatch ? parseInt(qtyMatch[1]) : (lower.includes('150') ? 1 : 1);
      // Determine capacity: 150Wh (most common) vs 95Wh
      const is95 = /95\s*w/i.test(lower);
      return [{ item: is95 ? 'V-mount 95mAh' : 'V-mount 150mAh', qty }];
    }

    // "Ultimate audio Boom mic + Dji livelier/lavalier" — combo listings
    if (/audio\s*boom\s*mic/i.test(lower) || /boom\s*mic.*shotgun/i.test(lower) || /shotgun.*boom/i.test(lower)) {
      const items: ParsedItem[] = [{ item: 'Audio boom mic Sennheiser', qty: 1 }];
      if (/dji/i.test(lower) && (/livelier|lavalier|lav|wireless\s*mic/i.test(lower))) {
        items.push({ item: 'DJI Wireless Mics', qty: 1 });
      }
      return items;
    }

    // "Pro Boom Mic Kit + DJI Wireless Mics (2x)"
    if (/boom\s*mic\s*kit/i.test(lower) && /dji/i.test(lower)) {
      const djiQtyMatch = lower.match(/dji.*?(\d+)x/i) || lower.match(/(\d+)x.*dji/i);
      const djiQty = djiQtyMatch ? parseInt(djiQtyMatch[1]) : 1;
      return [
        { item: 'Audio boom mic Sennheiser', qty: 1 },
        { item: 'DJI Wireless Mics', qty: djiQty },
      ];
    }

    // Nanlite 500B — "nanlite 500" / "nanlite bi color"
    if (/nanlite\s*500/i.test(lower) || /nanlite.*bi\s*color/i.test(lower)) {
      return [{ item: 'Nanlite 500B', qty: 1 }];
    }

    // 7Artisans 7.5mm fisheye — "7artisans" / "7.5mm fisheye"
    if (/7\s*artisans/i.test(lower) && /fisheye|7\.5mm/i.test(lower)) {
      return [{ item: '7Artisans 7.5mm f2.8 Fisheye', qty: 1 }];
    }

    // Sony A7 III — "a7s iii" / "a7siii" / "a7 iii" / "a73"
    if (/a7s?\s*iii/i.test(lower) || /a7s3/i.test(lower) || /a73/i.test(lower) || /a7\s*3/i.test(lower)) {
      const items: ParsedItem[] = [{ item: 'Sony A7 III', qty: 1 }];
      // Check for lens
      if (/24-70/i.test(lower) && /gm|gmaster|g\s*master/i.test(lower)) {
        items.push({ item: 'Sony GM 24-70mm f2.8', qty: 1 });
      }
      return items;
    }

    return null; // No pattern matched — fall through to AI
  }

  /**
   * Parse a Hygglo rental title into structured inventory items using AI.
   * Results are cached in-memory to avoid duplicate calls for the same title.
   */
  async parseTitleWithAI(title: string, force = false): Promise<ParsedItem[]> {
    if (!title || title.trim().length === 0) return [];

    // Strip SEO noise: parenthetical comparisons, sensor references, model comparisons
    // These cause the AI to extract comparison items instead of the actual product
    const normalizedTitle = title.trim()
      .replace(/\(\s*(?:like|similar to|comparable to|replaces|vs|or|same\s+(?:sensor|chip|quality|level|class)\s+as|equivalent to|alternative to|beats|better than|compared to|upgrade from)\s[^)]+\)/gi, '')
      .replace(/\(\s*(?:same\s+as|works\s+like|competes\s+with|rival\s+to|matching)\s[^)]+\)/gi, '')
      .trim();

    // Check in-memory cache (skip if force re-parse)
    if (!force) {
      const cached = this.cache.get(normalizedTitle);
      if (cached) return cached;
    }

    // Pattern-based overrides for titles the AI consistently fails on
    const patternMatch = this.matchTitlePatterns(normalizedTitle);
    if (patternMatch) {
      this.logger.log(`Pattern override for "${normalizedTitle.substring(0, 60)}": ${patternMatch.map(i => i.item).join(', ')}`);
      this.cache.set(normalizedTitle, patternMatch);
      return patternMatch;
    }

    // Check if any rental with this exact title already has non-empty parsed_items (DB lookup)
    if (!force) {
      const existingWithItems = await this.prisma.$queryRaw<{ parsed_items: any }[]>`
        SELECT parsed_items FROM rental
        WHERE (title = ${normalizedTitle} OR title = ${title.trim()})
        AND parsed_items IS NOT NULL AND parsed_items::text != '[]' AND parsed_items::text != 'null'
        LIMIT 1
      `;
      if (existingWithItems.length > 0 && existingWithItems[0].parsed_items) {
        const items = existingWithItems[0].parsed_items as ParsedItem[];
        if (items.length > 0) {
          this.cache.set(normalizedTitle, items);
          return items;
        }
      }
    }

    if (!this.anthropicClient) {
      this.logger.warn('No ANTHROPIC_API_KEY — title parsing unavailable');
      return [];
    }

    const inventoryNames = getInventoryItemNames();

    // Estimate expected item count from title structure
    const plusCount = (normalizedTitle.match(/\+/g) || []).length;
    // For '+' separated titles: strict count. For comma/ampersand titles: count equipment keywords.
    let maxItems: number;
    if (plusCount > 0) {
      maxItems = plusCount + 2;
    } else {
      // Count equipment category keywords mentioned in title (Lens, Gimbal, Monitor, Mic, Light, Camera, etc.)
      const equipmentKeywords = normalizedTitle.match(/\b(lens|gimbal|monitor|mic|mics|microphone|light|lighting|camera|stabilizer|tripod|slider|transmitter|wireless|speaker|DJ|controller)\b/gi) || [];
      maxItems = Math.max(3, Math.min(10, equipmentKeywords.length + 2));
    }

    const prompt = `Match this rental listing title to items from my inventory. Titles are SEO-heavy with synonyms and noise words — focus on the CORE product identity (brand + model/focal length).

TITLE: "${normalizedTitle}"

INVENTORY:
${inventoryNames.map(n => `- ${n}`).join('\n')}

CRITICAL RULES — READ CAREFULLY:
1. ONLY extract items that are EXPLICITLY named in the title. NEVER infer or assume accessories.
2. If the title says "Sony FX3 + 24-70mm lens", that's EXACTLY 2 items. Not 2 items + batteries + shoulder rig + cards.
3. Items are separated by "+" in bundle titles. Each "+" marks a NEW distinct item. "Camera + Mic" = 2 items, "Camera + Lens + Mic" = 3 items. You MUST return an item for EACH segment separated by "+".
4. IGNORE parenthetical SEO comparisons like "(same sensor as...)", "(like...)", "(similar to...)" — but DO NOT ignore quantity markers like "(2x)", "(3x)" — those indicate item quantity.
5. IGNORE descriptive words that aren't items: "cinema", "full frame", "4k", "professional", "ultimate", "complete kit/set".
6. Words like "kit", "set", "bundle", "complete" do NOT mean extra items — they describe the listing itself.
7. "a7siii" / "a7s iii" / "a7s3" appearing as a COMPARISON (e.g., "same sensor as a7siii") is NOT an actual item.
8. Return at most ${maxItems} items. If you find more, you are probably hallucinating.

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
- "nanlite 500" / "nanlite 500b" / "nanlite bi color" → "Nanlite 500B"
- "v-mount" / "v mount" / "vmount" batteries → "V-mount 95mAh" or "V-mount 150mAh" (150wh/150wah=150mAh, 95wh=95mAh)
- "sennheiser" / "MKE" / "MKE600" → "Audio boom mic Sennheiser"
- "DJI wireless mic" / "DJI mic" / "wireless mic DJI" → "DJI Mic 2 wireless"
- "rode wireless" → "Rode Wireless Mic Pro set"
- "suction cup" / "suction mount" → "Suction cups"
- "7artisans" / "7.5mm fisheye" → "7Artisans 7.5mm f2.8 Fisheye"
- "8-15mm fisheye" → "8-15mm f2.8 Fisheye Zoom"
- "a7s iii" / "a7siii" / "a7s3" → "Sony A7 III" (ONLY if used as the primary item, NOT in comparisons)
- "2x" or "3x" prefix → set qty accordingly
- Bundle listings with "+" separate multiple items

Return ONLY a JSON array. Example: [{"item": "Sony FX3", "qty": 1}, {"item": "Sony GM 24-70mm f2.8", "qty": 1}]`;

    try {
      const content = await this.callHaiku(prompt);
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

      // Validate: fuzzy match to inventory (handles AI returning close-but-not-exact names)
      const seen = new Set<string>();
      let validated: ParsedItem[] = [];
      for (const p of parsed) {
        if (p.qty <= 0) continue;
        const matched = findBestMatch(p.item, inventoryNames);
        if (matched && !seen.has(matched)) {
          seen.add(matched);
          validated.push({ item: matched, qty: Math.round(p.qty) });
        }
      }

      // Structural constraint: AI should not return more items than the title suggests.
      if (validated.length > maxItems) {
        this.logger.warn(`AI returned ${validated.length} items for "${normalizedTitle.substring(0, 60)}" (max expected: ${maxItems}). Trimming to first ${maxItems}.`);
        validated = validated.slice(0, maxItems);
      }

      // Post-processing: if title has '+' segments, ensure each segment is represented.
      // If the AI missed a segment, try fuzzy matching that segment directly.
      if (plusCount > 0) {
        const segments = normalizedTitle.split(/\s*\+\s*/);
        for (const seg of segments) {
          // Clean segment: strip trailing SEO noise (after ' – ', ' | ', ' -')
          const cleanSeg = seg.split(/\s*[–|]\s*/)[0].trim();
          if (!cleanSeg) continue;
          // Check if any validated item could represent this segment
          const segLower = cleanSeg.toLowerCase();
          const alreadyCovered = validated.some(v => {
            const vLower = v.item.toLowerCase();
            // Check if segment keywords overlap with item name
            const segWords = segLower.split(/\s+/).filter(w => w.length > 2);
            return segWords.some(w => vLower.includes(w));
          });
          if (!alreadyCovered) {
            // Strip quantity markers like "(2x)" before fuzzy matching
            const matchableSeg = cleanSeg.replace(/\(\d+x?\)/gi, '').trim();
            // Try fuzzy matching the segment text directly
            const matched = findBestMatch(matchableSeg, inventoryNames);
            if (matched && !seen.has(matched)) {
              this.logger.log(`Post-process: segment "${cleanSeg.substring(0, 40)}" → "${matched}"`);
              seen.add(matched);
              // Try to extract quantity from segment (e.g., "(2x)")
              const qtyMatch = cleanSeg.match(/\((\d+)x?\)/i);
              const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
              validated.push({ item: matched, qty });
            }
          }
        }
      }

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
    listingId?: string,
  ): Promise<ParsedItem[]> {
    // AUTHORITATIVE OVERRIDE: If listing-photo-reference has verified items for this listing,
    // use those instead of title-parsed items. This prevents SEO noise from polluting extraction.
    if (listingId) {
      const verified = getVerifiedItems(listingId);
      if (verified && verified.items.length > 0) {
        this.logger.log(`Photo reference override for listing ${listingId}: ${verified.items.map(i => i.item).join(', ')}`);
        const refItems: ParsedItem[] = verified.items.map(i => ({ item: i.item, qty: i.qty }));
        const jsonValue = JSON.stringify(refItems);
        await this.prisma.$executeRaw`
          UPDATE rental SET parsed_items = ${jsonValue}::jsonb, updated_at = NOW()
          WHERE id = ${rentalId}
        `;
        return refItems;
      }
    }

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

    // Collapse items that map to the same inventory item via findBestMatch
    // e.g. "Anamorphic Great Joy 35mm" and "Anamorphic Great Joy lens 35mm" → keep one
    const inventoryNames = getInventoryItemNames();
    const dedupedByInventory = new Map<string, ParsedItem>();
    for (const item of merged.values()) {
      const matched = findBestMatch(item.item, inventoryNames);
      const key = matched || item.item;
      if (!dedupedByInventory.has(key)) {
        // Prefer the canonical inventory name if matched
        dedupedByInventory.set(key, matched ? { ...item, item: matched } : item);
      }
    }
    const result = Array.from(dedupedByInventory.values());
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
    // Clear cache to force fresh parsing (especially after adding pattern overrides)
    this.cache.clear();

    // Get all unique titles that need parsing: NULL or empty array []
    const unparsed = await this.prisma.$queryRaw<{ title: string }[]>`
      SELECT DISTINCT title FROM rental
      WHERE parsed_items IS NULL OR parsed_items::text = '[]' OR parsed_items::text = 'null'
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
        if (items.length === 0) {
          skipped++;
          continue;
        }

        const jsonValue = JSON.stringify(items);
        const count = await this.prisma.$executeRaw`
          UPDATE rental SET parsed_items = ${jsonValue}::jsonb, updated_at = NOW()
          WHERE title = ${title}
          AND (parsed_items IS NULL OR parsed_items::text = '[]' OR parsed_items::text = 'null')
        `;

        updated += Number(count);
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
      id: string; title: string; photos_urls: string[]; parsed_items: any; renter_info: string | null; listing_id: string;
    }[]>`
      SELECT id, title, photos_urls, parsed_items, renter_info, listing_id
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
        const result = await this.enhanceWithPhotos(rental.id, rental.title, currentItems, rental.photos_urls, rental.listing_id);
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
