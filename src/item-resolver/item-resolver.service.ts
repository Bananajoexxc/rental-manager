import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { getInventoryItemNames, findBestMatch, MASTER_INVENTORY, detectBrandMismatch, extractPrimaryBrand } from '../utils/item-matcher';
import { getVerifiedItems } from '../data/listing-photo-reference';
import { CANONICAL_MAP, getRelevantItems } from './inventory-categories';

export interface ResolvedItem {
  item: string;       // Exact MASTER_INVENTORY name
  qty: number;        // From title "2x" / "(3x)" / repeated API items
  source: 'catalog' | 'photo_ref' | 'ai' | 'pattern' | 'detail_api';
  confidence: number; // 0.0-1.0
}

@Injectable()
export class ItemResolverService {
  private readonly logger = new Logger(ItemResolverService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    @Optional() private aiService?: AiService,
  ) {}

  /**
   * Main entry point: resolve a listing to inventory items.
   * Cascade: catalog DB → photo reference → constrained AI → pattern match → self-heal
   */
  async resolveItems(
    listingId: string,
    title: string,
    detail?: any,
  ): Promise<ResolvedItem[]> {
    // 1. Catalog lookup (fastest, most reliable)
    const catalogItems = await this.lookupCatalog(listingId);
    if (catalogItems.length > 0) {
      // Enhance qty from title if catalog has a single item and title has qty prefix
      if (catalogItems.length === 1) {
        const qtyFromTitle = this.extractQtyFromTitle(title, catalogItems[0].item);
        if (qtyFromTitle > 1) {
          catalogItems[0].qty = qtyFromTitle;
        }
      }
      this.logger.log(`[resolve] ${listingId} → catalog hit: ${catalogItems.map(i => `${i.item} x${i.qty}`).join(', ')}`);
      return catalogItems;
    }

    // 2. Photo reference lookup (101 manually verified listings)
    const photoRefItems = this.lookupPhotoReference(listingId);
    if (photoRefItems.length > 0) {
      this.logger.log(`[resolve] ${listingId} → photo_ref hit: ${photoRefItems.map(i => `${i.item} x${i.qty}`).join(', ')}`);
      // Self-heal: write to catalog for next time
      await this.saveToItemcatalog(listingId, photoRefItems);
      return photoRefItems;
    }

    // 3. Pattern match (regex-based, no AI needed)
    const normalizedTitle = this.stripSeoNoise(title);
    const patternItems = this.patternMatch(normalizedTitle);
    if (patternItems.length > 0) {
      this.logger.log(`[resolve] ${listingId} → pattern match: ${patternItems.map(i => `${i.item} x${i.qty}`).join(', ')}`);
      await this.saveToItemcatalog(listingId, patternItems);
      return patternItems;
    }

    // 4. Detail API items (Hygglo API returns item names in detail.items)
    if (detail?.items && Array.isArray(detail.items)) {
      const detailItems = this.resolveFromDetail(detail);
      if (detailItems.length > 0) {
        this.logger.log(`[resolve] ${listingId} → detail_api: ${detailItems.map(i => `${i.item} x${i.qty}`).join(', ')}`);
        await this.saveToItemcatalog(listingId, detailItems);
        return detailItems;
      }
    }

    // 5. Constrained AI (category-scoped, max 15-30 items in prompt)
    const aiItems = await this.aiResolve(normalizedTitle);
    if (aiItems.length > 0) {
      this.logger.log(`[resolve] ${listingId} → AI: ${aiItems.map(i => `${i.item} x${i.qty}`).join(', ')}`);
      await this.saveToItemcatalog(listingId, aiItems);
      return aiItems;
    }

    // 6. Last resort: try fuzzy matching the title directly
    const fuzzyMatch = findBestMatch(normalizedTitle, getInventoryItemNames());
    if (fuzzyMatch) {
      // Brand integrity gate on fuzzy fallback too
      const brandCheck = detectBrandMismatch(title, fuzzyMatch);
      if (brandCheck.isMismatch) {
        this.logger.warn(`[resolve] ${listingId} → fuzzy fallback blocked by brand gate: "${title}" → "${fuzzyMatch}" (${brandCheck.listingBrand} ≠ ${brandCheck.itemBrand})`);
      } else {
        const items: ResolvedItem[] = [{ item: fuzzyMatch, qty: 1, source: 'pattern', confidence: 0.5 }];
        this.logger.log(`[resolve] ${listingId} → fuzzy fallback: ${fuzzyMatch}`);
        await this.saveToItemcatalog(listingId, items);
        return items;
      }
    }

    this.logger.warn(`[resolve] ${listingId} → NO MATCH for "${title.substring(0, 80)}"`);
    return [];
  }

  /**
   * Look up items from the itemcatalog table by listing_id.
   * Canonicalizes dirty names and validates against MASTER_INVENTORY.
   */
  async lookupCatalog(listingId: string): Promise<ResolvedItem[]> {
    const rows = await this.prisma.itemcatalog.findMany({
      where: { listing_id: listingId },
      select: { item_name: true },
    });

    if (rows.length === 0) return [];

    // Group by canonical name, count occurrences as qty
    const qtyMap = new Map<string, number>();
    for (const row of rows) {
      const canonical = this.canonicalize(row.item_name);
      if (canonical) {
        qtyMap.set(canonical, (qtyMap.get(canonical) || 0) + 1);
      }
    }

    return Array.from(qtyMap.entries()).map(([item, qty]) => ({
      item,
      qty,
      source: 'catalog' as const,
      confidence: 1.0,
    }));
  }

  /**
   * Look up items from listing-photo-reference.ts (manually verified).
   */
  lookupPhotoReference(listingId: string): ResolvedItem[] {
    const entry = getVerifiedItems(listingId);
    if (!entry) return [];

    return entry.items
      .filter(i => {
        const match = findBestMatch(i.item, getInventoryItemNames());
        return match !== null;
      })
      .map(i => ({
        item: findBestMatch(i.item, getInventoryItemNames()) || i.item,
        qty: i.qty,
        source: 'photo_ref' as const,
        confidence: 0.95,
      }));
  }

  /**
   * Resolve items from Hygglo detail API response.
   */
  private resolveFromDetail(detail: any): ResolvedItem[] {
    const items = detail.items
      .filter((item: any) => item.name && item.type === 'PRODUCT')
      .map((item: any) => item.name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));

    const qtyMap = new Map<string, number>();
    const inventoryNames = getInventoryItemNames();

    for (const raw of items) {
      const canonical = this.canonicalize(raw);
      if (canonical) {
        qtyMap.set(canonical, (qtyMap.get(canonical) || 0) + 1);
      } else {
        // Try fuzzy match
        const matched = findBestMatch(raw, inventoryNames);
        if (matched) {
          qtyMap.set(matched, (qtyMap.get(matched) || 0) + 1);
        }
      }
    }

    return Array.from(qtyMap.entries()).map(([item, qty]) => ({
      item,
      qty,
      source: 'detail_api' as const,
      confidence: 0.8,
    }));
  }

  /**
   * Constrained AI resolution: only sends relevant category items (15-30 instead of 170+).
   */
  async aiResolve(title: string): Promise<ResolvedItem[]> {
    if (!this.aiService) return [];

    const relevantItems = getRelevantItems(title);
    const inventoryList = relevantItems.join('\n');

    // Detect primary brand for brand-aware matching
    const titleBrand = extractPrimaryBrand(title);
    const brandRule = titleBrand
      ? `- BRAND RULE: The listing is for a ${titleBrand.toUpperCase()} product. Do NOT match to a different brand (e.g., do NOT match Canon to Sony or vice versa). If no same-brand item exists in the inventory, return [].`
      : '';

    const prompt = `Match this rental listing title to items from the inventory below.

TITLE: "${title}"

INVENTORY (only match from this list):
${inventoryList}

Rules:
- Return ONLY items from the inventory list above
- Match the SPECIFIC model/variant mentioned in the title
${brandRule}
- Extract quantity from "2x", "(3x)", etc. Default qty is 1
- If title has "+" separators, each segment is usually a different item
- Do NOT add items not clearly indicated by the title
- Return JSON array: [{"item": "exact inventory name", "qty": 1}]
- If nothing matches, return []

JSON:`;

    try {
      if (!this.aiService) return [];
      const response = await this.aiService.processExtraction(prompt, { maxTokens: 512 });
      const content = response.content;
      if (!content) return [];

      // Strip markdown fences and extract first valid JSON array (greedy regex fails on trailing text)
      const stripped = content;
      let jsonStr: string | null = null;
      const start = stripped.indexOf('[');
      if (start !== -1) {
        let depth = 0;
        for (let i = start; i < stripped.length; i++) {
          if (stripped[i] === '[') depth++;
          else if (stripped[i] === ']') { depth--; if (depth === 0) { jsonStr = stripped.slice(start, i + 1); break; } }
        }
      }
      if (!jsonStr) return [];

      const parsed: Array<{ item: string; qty: number }> = JSON.parse(jsonStr);
      const inventoryNames = getInventoryItemNames();
      const seen = new Set<string>();
      const results: ResolvedItem[] = [];

      for (const p of parsed) {
        if (p.qty <= 0) continue;
        const matched = findBestMatch(p.item, inventoryNames);
        if (matched && !seen.has(matched)) {
          // Brand integrity gate: reject cross-brand AI matches
          const brandCheck = detectBrandMismatch(title, matched);
          if (brandCheck.isMismatch) {
            this.logger.warn(`[aiResolve] Brand mismatch blocked: "${title}" → "${matched}" (${brandCheck.listingBrand} ≠ ${brandCheck.itemBrand})`);
            continue;
          }
          seen.add(matched);
          results.push({
            item: matched,
            qty: Math.round(p.qty),
            source: 'ai',
            confidence: 0.7,
          });
        }
      }

      return results;
    } catch (error: any) {
      this.logger.error(`AI resolve error: ${error.message}`);
      return [];
    }
  }

  /**
   * Pattern-based matching for titles the AI consistently fails on.
   * Migrated from title-parser.service.ts matchTitlePatterns().
   */
  patternMatch(title: string): ResolvedItem[] {
    const lower = title.toLowerCase();

    // V-mount batteries
    if (/v[\s-]?mount.*batter/i.test(lower) || /batter.*v[\s-]?mount/i.test(lower)) {
      const qtyMatch = lower.match(/(\d+)x\s*v[\s-]?mount/i) || lower.match(/(\d+)x\s.*v[\s-]?mount/i);
      const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
      const is95 = /95\s*w/i.test(lower);
      return [{ item: is95 ? 'V-mount 95mAh' : 'V-mount 150mAh', qty, source: 'pattern', confidence: 0.9 }];
    }

    // Audio boom mic + DJI combo listings
    if (/audio\s*boom\s*mic/i.test(lower) || /boom\s*mic.*shotgun/i.test(lower) || /shotgun.*boom/i.test(lower)) {
      const items: ResolvedItem[] = [{ item: 'Audio boom mic Sennheiser', qty: 1, source: 'pattern', confidence: 0.9 }];
      if (/dji/i.test(lower) && (/livelier|lavalier|lav|wireless\s*mic/i.test(lower))) {
        items.push({ item: 'DJI Wireless Mics', qty: 1, source: 'pattern', confidence: 0.9 });
      }
      return items;
    }

    // Pro Boom Mic Kit + DJI Wireless Mics
    if (/boom\s*mic\s*kit/i.test(lower) && /dji/i.test(lower)) {
      const djiQtyMatch = lower.match(/dji.*?(\d+)x/i) || lower.match(/(\d+)x.*dji/i);
      const djiQty = djiQtyMatch ? parseInt(djiQtyMatch[1]) : 1;
      return [
        { item: 'Audio boom mic Sennheiser', qty: 1, source: 'pattern', confidence: 0.9 },
        { item: 'DJI Wireless Mics', qty: djiQty, source: 'pattern', confidence: 0.9 },
      ];
    }

    // Nanlite 500B
    if (/nanlite\s*500/i.test(lower) || /nanlite.*bi\s*color/i.test(lower)) {
      return [{ item: 'Nanlite 500B', qty: 1, source: 'pattern', confidence: 0.9 }];
    }

    // 7Artisans 7.5mm fisheye
    if (/7\s*artisans/i.test(lower) && /fisheye|7\.5mm/i.test(lower)) {
      return [{ item: '7Artisans 7.5mm f2.8 Fisheye', qty: 1, source: 'pattern', confidence: 0.9 }];
    }

    // Sony A7 III
    if (/a7s?\s*iii/i.test(lower) || /a7s3/i.test(lower) || /a73/i.test(lower) || /a7\s*3/i.test(lower)) {
      const items: ResolvedItem[] = [{ item: 'Sony A7 III', qty: 1, source: 'pattern', confidence: 0.9 }];
      if (/24-70/i.test(lower) && /gm|gmaster|g\s*master/i.test(lower)) {
        items.push({ item: 'Sony GM 24-70mm f2.8', qty: 1, source: 'pattern', confidence: 0.9 });
      }
      return items;
    }

    // LED panels with quantity
    if (/\bled\b.*panel/i.test(lower) || /gvm\s*\d*\s*led/i.test(lower) || /led.*\blight\b/i.test(lower)) {
      const qtyMatch = lower.match(/(\d+)x?\s*(?:rgb\s*)?(?:led|gvm|panel)/i) || lower.match(/(\d+)x?\s+\w+\s+(?:led|gvm|panel)/i) || lower.match(/(?:led|gvm|panel).*?(\d+)x/i);
      const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
      if (qty >= 1 && qty <= 3) {
        return [{ item: 'LED light panels RGB', qty, source: 'pattern', confidence: 0.85 }];
      }
    }

    return [];
  }

  /**
   * Extract quantity from a title for a specific item.
   * Looks for "3x", "(2x)", etc. near relevant keywords.
   */
  private extractQtyFromTitle(title: string, _itemName: string): number {
    const lower = title.toLowerCase();
    // Look for leading quantity: "3x LED", "2x Sony"
    const leadingQty = lower.match(/^\s*(\d+)x?\s/i);
    if (leadingQty) return parseInt(leadingQty[1]);
    // Look for quantity in parens: "(3x)"
    const parenQty = lower.match(/\((\d+)x?\)/i);
    if (parenQty) return parseInt(parenQty[1]);
    return 1;
  }

  /**
   * Canonicalize a name: apply CANONICAL_MAP then fuzzy match to MASTER_INVENTORY.
   */
  canonicalize(name: string): string | null {
    // Direct canonical map hit
    if (CANONICAL_MAP[name]) {
      return CANONICAL_MAP[name];
    }

    // Exact MASTER_INVENTORY match
    if (MASTER_INVENTORY[name]) {
      return name;
    }

    // Fuzzy match
    const matched = findBestMatch(name, getInventoryItemNames());
    return matched;
  }

  /**
   * Strip SEO noise from title.
   */
  private stripSeoNoise(title: string): string {
    return title.trim()
      .replace(/\(\s*(?:like|similar to|comparable to|replaces|vs|or|same\s+(?:sensor|chip|quality|level|class)\s+as|equivalent to|alternative to|beats|better than|compared to|upgrade from)\s[^)]+\)/gi, '')
      .replace(/\(\s*(?:same\s+as|works\s+like|competes\s+with|rival\s+to|matching)\s[^)]+\)/gi, '')
      .trim();
  }

  /**
   * Self-heal: write resolved items to itemcatalog so future lookups are deterministic.
   */
  async saveToItemcatalog(listingId: string, items: ResolvedItem[]): Promise<void> {
    for (const item of items) {
      try {
        // Check if rental exists for this listing_id (FK constraint)
        const rental = await this.prisma.rental.findFirst({
          where: { listing_id: listingId },
          select: { listing_id: true },
        });
        if (!rental) return;

        await this.prisma.itemcatalog.upsert({
          where: {
            listing_id_item_name: {
              listing_id: listingId,
              item_name: item.item,
            },
          },
          update: {},
          create: {
            listing_id: listingId,
            item_name: item.item,
          },
        });
      } catch {
        // Ignore constraint violations
      }
    }
  }

  /**
   * Convert ResolvedItem[] to the string[] format that createBookingsFromRental expects.
   * Each item is repeated qty times to match the existing quantity counting logic.
   */
  toItemNames(items: ResolvedItem[]): string[] {
    const result: string[] = [];
    for (const item of items) {
      for (let i = 0; i < item.qty; i++) {
        result.push(item.item);
      }
    }
    return result;
  }

  /**
   * Backfill: re-resolve all rentals and fix their parsed_items.
   */
  async backfillAll(): Promise<{
    total: number;
    updated: number;
    unchanged: number;
    failed: number;
    changes: Array<{ rentalId: string; title: string; old: string[]; new: string[] }>;
  }> {
    const rentals = await this.prisma.rental.findMany({
      where: { status: { in: ['completed', 'ongoing', 'upcoming'] } },
      select: { id: true, listing_id: true, title: true, parsed_items: true },
    });

    const result = { total: rentals.length, updated: 0, unchanged: 0, failed: 0, changes: [] as any[] };

    for (const rental of rentals) {
      try {
        const resolved = await this.resolveItems(rental.listing_id, rental.title);
        if (resolved.length === 0) {
          result.failed++;
          continue;
        }

        const newParsed = resolved.map(r => ({ item: r.item, qty: r.qty }));
        const oldParsed = Array.isArray(rental.parsed_items) ? rental.parsed_items as any[] : [];
        const oldItems = oldParsed.map((p: any) => p.item || p.name).sort();
        const newItems = newParsed.map(p => p.item).sort();

        if (JSON.stringify(oldItems) !== JSON.stringify(newItems)) {
          await this.prisma.rental.update({
            where: { id: rental.id },
            data: { parsed_items: newParsed as any },
          });
          result.updated++;
          result.changes.push({
            rentalId: rental.id,
            title: rental.title,
            old: oldItems,
            new: newItems,
          });
        } else {
          result.unchanged++;
        }
      } catch {
        result.failed++;
      }
    }

    return result;
  }
}
