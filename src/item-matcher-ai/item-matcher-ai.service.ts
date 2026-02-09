import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  MASTER_INVENTORY,
  getInventoryItemNames,
  normalizeItemName,
  findBestMatch,
} from '../utils/item-matcher';
import { PRICING_CATALOG } from '../data/pricing-catalog';

// --- Types ---

export interface ItemMatch {
  item: string | null;
  confidence: number;
  alternatives: string[];
  isMarketing: boolean;
}

export interface ExtractedItems {
  inventoryItems: string[];
  nonInventoryItems: string[];
}

interface CacheEntry {
  matched_item: string | null;
  confidence: number;
  alternatives: string[];
  is_marketing: boolean;
  inventory_hash: string;
}

interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
  THRESHOLD: number;
  RESET_AFTER: number;
}

// --- Service ---

@Injectable()
export class ItemMatcherAiService implements OnModuleInit {
  private readonly logger = new Logger(ItemMatcherAiService.name);
  private client: Anthropic;
  private model: string;

  // Cache layers
  private memoryCache = new Map<string, CacheEntry>();
  private inventoryHash: string;
  private inventoryNames: string[];
  private inventorySet: Set<string>;
  private marketingItems: string[];

  // Circuit breaker
  private circuitBreaker: CircuitBreaker = {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
    THRESHOLD: 3,
    RESET_AFTER: 60_000,
  };

  // Stats
  private stats = { hits: 0, misses: 0, aiCalls: 0, errors: 0, legacyFallbacks: 0 };
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    this.client = new Anthropic({ apiKey: apiKey || '' });
    this.model = this.configService.get<string>('CLAUDE_MODEL') || 'claude-haiku-4-5-20250514';

    // Pre-compute inventory data
    this.inventoryNames = getInventoryItemNames();
    this.inventorySet = new Set(this.inventoryNames);
    this.inventoryHash = this.computeInventoryHash();
    this.marketingItems = PRICING_CATALOG
      .filter(e => e.marketing_only)
      .map(e => e.item_name);
  }

  async onModuleInit() {
    // Load DB cache into memory (non-blocking for bot startup)
    this.loadCacheFromDb().catch(err =>
      this.logger.warn(`Cache load failed: ${err.message}`),
    );

    // Log cache stats every 10 minutes
    this.statsInterval = setInterval(() => this.logStats(), 10 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.statsInterval) clearInterval(this.statsInterval);
  }

  // --- Public API ---

  /**
   * Resolve a single listing title / item name to inventory.
   * Fallback chain: memory cache → DB cache → Claude Haiku → legacy findBestMatch()
   */
  async resolveItem(title: string): Promise<ItemMatch> {
    const normalized = normalizeItemName(title);
    if (!normalized) return { item: null, confidence: 0, alternatives: [], isMarketing: false };

    // 1. Memory cache
    const cached = this.memoryCache.get(normalized);
    if (cached && cached.inventory_hash === this.inventoryHash) {
      this.stats.hits++;
      return this.cacheEntryToItemMatch(cached);
    }

    // 2. DB cache
    try {
      const dbRow = await this.prisma.item_match_cache.findUnique({
        where: { input_normalized: normalized },
      });
      if (dbRow && dbRow.inventory_hash === this.inventoryHash) {
        const entry: CacheEntry = {
          matched_item: dbRow.matched_item,
          confidence: dbRow.confidence,
          alternatives: dbRow.alternatives,
          is_marketing: dbRow.is_marketing,
          inventory_hash: dbRow.inventory_hash,
        };
        this.memoryCache.set(normalized, entry);
        this.stats.hits++;
        return this.cacheEntryToItemMatch(entry);
      }
    } catch (err) {
      this.logger.warn(`DB cache lookup failed: ${(err as Error).message}`);
    }

    this.stats.misses++;

    // 3. AI call (with circuit breaker)
    if (!this.isCircuitOpen()) {
      try {
        const result = await this.callAiSingle(title, normalized);
        if (result) {
          await this.storeInCache(normalized, result);
          return this.cacheEntryToItemMatch(result);
        }
      } catch (err) {
        this.recordCircuitFailure();
        this.stats.errors++;
        this.logger.warn(`AI resolveItem failed: ${(err as Error).message}`);
      }
    }

    // 4. Legacy fallback
    this.stats.legacyFallbacks++;
    const legacyResult = findBestMatch(title, this.inventoryNames);
    const isMarketing = legacyResult === null && this.isMarketingItem(title);
    const entry: CacheEntry = {
      matched_item: legacyResult,
      confidence: legacyResult ? 0.7 : 0,
      alternatives: [],
      is_marketing: isMarketing,
      inventory_hash: this.inventoryHash,
    };
    // Cache the legacy result too (avoids repeated AI calls for same input)
    await this.storeInCache(normalized, entry).catch(() => {});
    this.logDifference('resolveItem', title, null, legacyResult);
    return this.cacheEntryToItemMatch(entry);
  }

  /**
   * Batch resolve multiple titles. Uses batched AI calls (up to 10 per call).
   */
  async resolveItems(titles: string[]): Promise<Map<string, ItemMatch>> {
    const results = new Map<string, ItemMatch>();
    const uncached: { title: string; normalized: string }[] = [];

    // Check caches first
    for (const title of titles) {
      const normalized = normalizeItemName(title);
      if (!normalized) {
        results.set(title, { item: null, confidence: 0, alternatives: [], isMarketing: false });
        continue;
      }
      const cached = this.memoryCache.get(normalized);
      if (cached && cached.inventory_hash === this.inventoryHash) {
        results.set(title, this.cacheEntryToItemMatch(cached));
        this.stats.hits++;
      } else {
        uncached.push({ title, normalized });
      }
    }

    if (uncached.length === 0) return results;

    // Check DB cache for remaining
    const stillUncached: { title: string; normalized: string }[] = [];
    try {
      const dbRows = await this.prisma.item_match_cache.findMany({
        where: {
          input_normalized: { in: uncached.map(u => u.normalized) },
          inventory_hash: this.inventoryHash,
        },
      });
      const dbMap = new Map(dbRows.map(r => [r.input_normalized, r]));
      for (const { title, normalized } of uncached) {
        const dbRow = dbMap.get(normalized);
        if (dbRow) {
          const entry: CacheEntry = {
            matched_item: dbRow.matched_item,
            confidence: dbRow.confidence,
            alternatives: dbRow.alternatives,
            is_marketing: dbRow.is_marketing,
            inventory_hash: dbRow.inventory_hash,
          };
          this.memoryCache.set(normalized, entry);
          results.set(title, this.cacheEntryToItemMatch(entry));
          this.stats.hits++;
        } else {
          stillUncached.push({ title, normalized });
        }
      }
    } catch (err) {
      this.logger.warn(`DB batch lookup failed: ${(err as Error).message}`);
      stillUncached.push(...uncached);
    }

    if (stillUncached.length === 0) return results;

    // Batch AI calls (10 per batch)
    if (!this.isCircuitOpen()) {
      const batches = this.chunk(stillUncached, 10);
      for (const batch of batches) {
        try {
          const batchResults = await this.callAiBatch(batch.map(b => b.title));
          for (let i = 0; i < batch.length; i++) {
            const entry = batchResults[i];
            if (entry) {
              this.memoryCache.set(batch[i].normalized, entry);
              results.set(batch[i].title, this.cacheEntryToItemMatch(entry));
              await this.storeInCache(batch[i].normalized, entry).catch(() => {});
            }
          }
        } catch (err) {
          this.recordCircuitFailure();
          this.stats.errors++;
          this.logger.warn(`AI batch failed: ${(err as Error).message}`);
          // Fall back to legacy for this batch
          for (const { title, normalized } of batch) {
            if (!results.has(title)) {
              const legacyResult = findBestMatch(title, this.inventoryNames);
              results.set(title, {
                item: legacyResult,
                confidence: legacyResult ? 0.7 : 0,
                alternatives: [],
                isMarketing: legacyResult === null && this.isMarketingItem(title),
              });
              this.stats.legacyFallbacks++;
            }
          }
        }
      }
    } else {
      // Circuit open — all legacy
      for (const { title } of stillUncached) {
        const legacyResult = findBestMatch(title, this.inventoryNames);
        results.set(title, {
          item: legacyResult,
          confidence: legacyResult ? 0.7 : 0,
          alternatives: [],
          isMarketing: legacyResult === null && this.isMarketingItem(title),
        });
        this.stats.legacyFallbacks++;
      }
    }

    // Fill any missing with null
    for (const title of titles) {
      if (!results.has(title)) {
        results.set(title, { item: null, confidence: 0, alternatives: [], isMarketing: false });
      }
    }

    return results;
  }

  /**
   * Extract equipment items from a renter message.
   * Single Claude Haiku call replaces both extractMentionedItems() and extractNonInventoryItems().
   * NOT cached (each message is unique).
   */
  async extractItemsFromMessage(
    message: string,
    conversationContext?: string,
  ): Promise<ExtractedItems> {
    if (!message.trim()) return { inventoryItems: [], nonInventoryItems: [] };

    // Try AI extraction
    if (!this.isCircuitOpen()) {
      try {
        const result = await this.callAiExtract(message, conversationContext);
        if (result) return result;
      } catch (err) {
        this.recordCircuitFailure();
        this.stats.errors++;
        this.logger.warn(`AI extractItemsFromMessage failed: ${(err as Error).message}`);
      }
    }

    // Legacy fallback: brute-force extraction
    this.stats.legacyFallbacks++;
    return this.legacyExtractItems(message);
  }

  /**
   * Pre-warm cache with all known rental titles from DB.
   * Runs in background — bot starts immediately.
   */
  async preWarm(): Promise<void> {
    try {
      const rentals = await this.prisma.rental.findMany({
        select: { title: true },
        distinct: ['title'],
      });
      const titles = rentals.map(r => r.title).filter(Boolean);
      this.logger.log(`Pre-warm: ${titles.length} unique rental titles found`);

      const result = await this.resolveItems(titles);
      const cached = [...result.values()].filter(v => v.item !== null).length;
      this.logger.log(`Pre-warm complete: ${cached} matched, ${result.size - cached} unmatched`);
    } catch (err) {
      this.logger.warn(`Pre-warm failed: ${(err as Error).message}`);
    }
  }

  // --- AI Calls ---

  private async callAiSingle(title: string, normalized: string): Promise<CacheEntry | null> {
    const prompt = this.buildSinglePrompt(title);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      this.stats.aiCalls++;
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 150,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: controller.signal as any },
      );

      clearTimeout(timeout);
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = this.parseMatchResponse(text);
      if (!parsed) return null;

      // Validate match against inventory Set
      const validatedMatch = parsed.match && this.inventorySet.has(parsed.match)
        ? parsed.match
        : parsed.match
          ? (findBestMatch(parsed.match, this.inventoryNames) || null)
          : null;

      if (parsed.match && !validatedMatch) {
        this.logger.warn(`AI returned invalid item "${parsed.match}" for "${title}" — dropped`);
      }

      const entry: CacheEntry = {
        matched_item: validatedMatch,
        confidence: parsed.confidence,
        alternatives: (parsed.alternatives || []).filter(a => this.inventorySet.has(a)),
        is_marketing: parsed.isMarketing || false,
        inventory_hash: this.inventoryHash,
      };

      // Log disagreements with legacy
      const legacyResult = findBestMatch(title, this.inventoryNames);
      if (validatedMatch !== legacyResult) {
        this.logDifference('resolveItem', title, validatedMatch, legacyResult);
      }

      return entry;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  private async callAiBatch(titles: string[]): Promise<(CacheEntry | null)[]> {
    const prompt = this.buildBatchPrompt(titles);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      this.stats.aiCalls++;
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 100 + titles.length * 80,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: controller.signal as any },
      );

      clearTimeout(timeout);
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = this.parseBatchResponse(text, titles.length);
      if (!parsed) return titles.map(() => null);

      return parsed.map((p, i) => {
        if (!p) return null;
        const validatedMatch = p.match && this.inventorySet.has(p.match)
          ? p.match
          : p.match
            ? (findBestMatch(p.match, this.inventoryNames) || null)
            : null;

        return {
          matched_item: validatedMatch,
          confidence: p.confidence,
          alternatives: [],
          is_marketing: p.isMarketing || false,
          inventory_hash: this.inventoryHash,
        };
      });
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  private async callAiExtract(
    message: string,
    conversationContext?: string,
  ): Promise<ExtractedItems | null> {
    const prompt = this.buildExtractPrompt(message, conversationContext);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      this.stats.aiCalls++;
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 250,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: controller.signal as any },
      );

      clearTimeout(timeout);
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = this.parseExtractResponse(text);
      if (!parsed) return null;

      // Validate inventory items against Set
      const validatedInventory = parsed.inventoryItems
        .map(item => {
          if (this.inventorySet.has(item)) return item;
          // Try recovery via findBestMatch
          const recovered = findBestMatch(item, this.inventoryNames);
          if (recovered) return recovered;
          this.logger.warn(`AI extracted invalid inventory item "${item}" — dropped`);
          return null;
        })
        .filter((item): item is string => item !== null);

      return {
        inventoryItems: [...new Set(validatedInventory)],
        nonInventoryItems: parsed.nonInventoryItems || [],
      };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  // --- Prompt Builders ---

  private buildSinglePrompt(title: string): string {
    return `Match this listing title to inventory. Return the EXACT inventory name or null.

TITLE: "${title}"

INVENTORY (${this.inventoryNames.length} items):
${this.inventoryNames.join('\n')}

MARKETING-ONLY (listed but NOT physically owned — match as null + isMarketing=true):
${this.marketingItems.join('\n')}

Rules:
- Brand precision: Sony ≠ Canon ≠ Aputure ≠ Nanlite. NEVER cross-match brands.
- Focal length precision: 24-70mm ≠ 28-70mm ≠ 16-35mm. These are DIFFERENT lenses.
- Model precision: FX3 ≠ FX6 ≠ FX30. A7 III ≠ A7 IV. BMPCC 6K ≠ 6K Pro ≠ 6K Full Frame.
- Aputure: We do NOT own any Aputure products. All Aputure = marketing-only.
- "gmaster" / "g-master" / "gm" all mean Sony G Master lens series
- "2x" / "3x" prefix = quantity, not part of item name
- If title contains "+" it may be a bundle (multiple items) — match the PRIMARY item only
- If uncertain, return null. False negatives are safe; false positives break bookings.

JSON only: {"match":"Exact Name"|null,"confidence":0.0-1.0,"isMarketing":false,"alternatives":["Exact Name",...]}`;
  }

  private buildBatchPrompt(titles: string[]): string {
    return `Match each listing title to inventory. Return EXACT inventory names or null.

TITLES:
${titles.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

INVENTORY (${this.inventoryNames.length} items):
${this.inventoryNames.join('\n')}

MARKETING-ONLY (listed but NOT physically owned — match as null + isMarketing=true):
${this.marketingItems.join('\n')}

Rules:
- Brand precision: Sony ≠ Canon ≠ Aputure ≠ Nanlite. NEVER cross-match brands.
- Focal length precision: 24-70mm ≠ 28-70mm ≠ 16-35mm. These are DIFFERENT lenses.
- Model precision: FX3 ≠ FX6 ≠ FX30. A7 III ≠ A7 IV. BMPCC 6K ≠ 6K Pro ≠ 6K Full Frame.
- Aputure: We do NOT own any Aputure products. All Aputure = marketing-only.
- "gmaster" / "g-master" / "gm" all mean Sony G Master lens series
- "2x" / "3x" prefix = quantity, not part of item name
- If uncertain, return null. False negatives are safe; false positives break bookings.

JSON array only: [{"index":1,"match":"Exact"|null,"confidence":0.9,"isMarketing":false},...]`;
  }

  private buildExtractPrompt(message: string, conversationContext?: string): string {
    return `Extract equipment items mentioned in this rental message.

MESSAGE: "${message}"
${conversationContext ? `CONTEXT (what this rental is about): ${conversationContext}` : ''}

INVENTORY (${this.inventoryNames.length} items):
${this.inventoryNames.join('\n')}

Rules:
- Match by brand + model. Ignore noise words (rental, London, availability, etc.)
- "the camera" / "your FX3" → resolve to specific inventory item from context
- "some lights" without brand/model → skip (too generic)
- "Aputure 300d" → nonInventoryItems (we don't own Aputure)
- Items NOT in inventory but with specific brand+model → nonInventoryItems
- Generic words without models ("camera", "lens", "gear") → skip entirely

JSON only: {"inventoryItems":["Exact Name",...],"nonInventoryItems":["Brand Model",...]}`;
  }

  // --- Response Parsers ---

  private parseMatchResponse(text: string): {
    match: string | null;
    confidence: number;
    isMarketing: boolean;
    alternatives: string[];
  } | null {
    try {
      const json = this.extractJson(text);
      if (!json) return null;
      const obj = JSON.parse(json);
      return {
        match: obj.match || null,
        confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5,
        isMarketing: obj.isMarketing === true,
        alternatives: Array.isArray(obj.alternatives) ? obj.alternatives : [],
      };
    } catch {
      return null;
    }
  }

  private parseBatchResponse(text: string, expectedCount: number): ({
    match: string | null;
    confidence: number;
    isMarketing: boolean;
  } | null)[] {
    try {
      const json = this.extractJson(text);
      if (!json) return new Array(expectedCount).fill(null);
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) return new Array(expectedCount).fill(null);

      const result: ({ match: string | null; confidence: number; isMarketing: boolean } | null)[] =
        new Array(expectedCount).fill(null);
      for (const item of arr) {
        const idx = (item.index || 0) - 1;
        if (idx >= 0 && idx < expectedCount) {
          result[idx] = {
            match: item.match || null,
            confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
            isMarketing: item.isMarketing === true,
          };
        }
      }
      return result;
    } catch {
      return new Array(expectedCount).fill(null);
    }
  }

  private parseExtractResponse(text: string): {
    inventoryItems: string[];
    nonInventoryItems: string[];
  } | null {
    try {
      const json = this.extractJson(text);
      if (!json) return null;
      const obj = JSON.parse(json);
      return {
        inventoryItems: Array.isArray(obj.inventoryItems) ? obj.inventoryItems : [],
        nonInventoryItems: Array.isArray(obj.nonInventoryItems) ? obj.nonInventoryItems : [],
      };
    } catch {
      return null;
    }
  }

  private extractJson(text: string): string | null {
    // Strip ```json fences
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    // Find first { or [
    const objStart = cleaned.indexOf('{');
    const arrStart = cleaned.indexOf('[');
    const start = objStart >= 0 && arrStart >= 0
      ? Math.min(objStart, arrStart)
      : objStart >= 0 ? objStart : arrStart;
    if (start < 0) return null;

    // Find matching closer
    const opener = cleaned[start];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === opener) depth++;
      else if (cleaned[i] === closer) depth--;
      if (depth === 0) {
        return cleaned.substring(start, i + 1);
      }
    }
    return null;
  }

  // --- Cache Management ---

  private async loadCacheFromDb(): Promise<void> {
    const rows = await this.prisma.item_match_cache.findMany({
      where: { inventory_hash: this.inventoryHash },
    });
    for (const row of rows) {
      this.memoryCache.set(row.input_normalized, {
        matched_item: row.matched_item,
        confidence: row.confidence,
        alternatives: row.alternatives,
        is_marketing: row.is_marketing,
        inventory_hash: row.inventory_hash,
      });
    }
    this.logger.log(`Loaded ${rows.length} cached matches from DB`);
  }

  private async storeInCache(normalized: string, entry: CacheEntry): Promise<void> {
    this.memoryCache.set(normalized, entry);
    try {
      await this.prisma.item_match_cache.upsert({
        where: { input_normalized: normalized },
        create: {
          input_normalized: normalized,
          matched_item: entry.matched_item,
          confidence: entry.confidence,
          alternatives: entry.alternatives,
          is_marketing: entry.is_marketing,
          inventory_hash: entry.inventory_hash,
        },
        update: {
          matched_item: entry.matched_item,
          confidence: entry.confidence,
          alternatives: entry.alternatives,
          is_marketing: entry.is_marketing,
          inventory_hash: entry.inventory_hash,
          updated_at: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn(`Cache write failed: ${(err as Error).message}`);
    }
  }

  private computeInventoryHash(): string {
    const keys = Object.keys(MASTER_INVENTORY).sort().join(',');
    return crypto.createHash('md5').update(keys).digest('hex');
  }

  // --- Circuit Breaker ---

  private isCircuitOpen(): boolean {
    if (!this.circuitBreaker.isOpen) return false;
    // Auto-reset after RESET_AFTER ms
    if (Date.now() - this.circuitBreaker.lastFailure > this.circuitBreaker.RESET_AFTER) {
      this.circuitBreaker.isOpen = false;
      this.circuitBreaker.failures = 0;
      this.logger.log('Circuit breaker CLOSED (auto-reset)');
      return false;
    }
    return true;
  }

  private recordCircuitFailure(): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();
    if (this.circuitBreaker.failures >= this.circuitBreaker.THRESHOLD) {
      this.circuitBreaker.isOpen = true;
      this.logger.warn(`Circuit breaker OPEN after ${this.circuitBreaker.failures} failures`);
    }
  }

  // --- Legacy Fallback ---

  private legacyExtractItems(message: string): ExtractedItems {
    const inventoryItems: string[] = [];
    const nonInventoryItems: string[] = [];
    const words = message.toLowerCase().split(/\s+/);

    // Try every 1, 2, 3, 4, 5 word combination against findBestMatch
    for (let len = 5; len >= 1; len--) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ');
        if (phrase.length < 3) continue;
        const match = findBestMatch(phrase, this.inventoryNames);
        if (match && !inventoryItems.includes(match)) {
          inventoryItems.push(match);
        }
      }
    }

    // Extract non-inventory items via simple brand+model pattern
    const nonInventoryPatterns = [
      /\b(aputure|sigma|tamron|canon rf|nikon z|panasonic|fuji)\s+[\w\s-]+/gi,
      /\b\d+mm\s+f[\d.]+\b/gi,
    ];
    for (const pattern of nonInventoryPatterns) {
      const matches = message.match(pattern) || [];
      for (const m of matches) {
        const trimmed = m.trim();
        if (!findBestMatch(trimmed, this.inventoryNames) && !nonInventoryItems.includes(trimmed)) {
          nonInventoryItems.push(trimmed);
        }
      }
    }

    return { inventoryItems, nonInventoryItems };
  }

  // --- Helpers ---

  private cacheEntryToItemMatch(entry: CacheEntry): ItemMatch {
    return {
      item: entry.matched_item,
      confidence: entry.confidence,
      alternatives: entry.alternatives,
      isMarketing: entry.is_marketing,
    };
  }

  private isMarketingItem(title: string): boolean {
    const normalized = normalizeItemName(title);
    for (const mkt of this.marketingItems) {
      if (normalizeItemName(mkt) === normalized) return true;
      // Fuzzy: check if normalized contains brand+model from marketing item
      const mktNorm = normalizeItemName(mkt);
      const mktTokens = mktNorm.split(' ');
      const matchCount = mktTokens.filter(t => normalized.includes(t)).length;
      if (matchCount >= Math.min(3, mktTokens.length) && matchCount / mktTokens.length >= 0.7) {
        return true;
      }
    }
    return false;
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private logDifference(method: string, input: string, aiResult: string | null, legacyResult: string | null): void {
    if (aiResult !== legacyResult) {
      this.logger.debug(
        `MATCH_DIFF method=${method} ai="${aiResult}" legacy="${legacyResult}" input="${input.substring(0, 80)}"`,
      );
    }
  }

  private logStats(): void {
    this.logger.log(
      `CACHE_STATS hit=${this.stats.hits} miss=${this.stats.misses} ai_calls=${this.stats.aiCalls} ` +
      `errors=${this.stats.errors} legacy=${this.stats.legacyFallbacks} ` +
      `circuit=${this.circuitBreaker.isOpen ? 'open' : 'closed'} cache_size=${this.memoryCache.size}`,
    );
  }

  // --- Debug endpoint support ---

  async debugMatch(title: string): Promise<{
    input: string;
    normalized: string;
    ai: ItemMatch | null;
    legacy: string | null;
    cached: boolean;
  }> {
    const normalized = normalizeItemName(title);

    // Check if cached
    const cached = this.memoryCache.has(normalized) &&
      this.memoryCache.get(normalized)!.inventory_hash === this.inventoryHash;

    // Get AI result
    let aiResult: ItemMatch | null = null;
    try {
      aiResult = await this.resolveItem(title);
    } catch {
      // AI failed — leave null
    }

    // Get legacy result
    const legacyResult = findBestMatch(title, this.inventoryNames);

    return {
      input: title,
      normalized,
      ai: aiResult,
      legacy: legacyResult,
      cached,
    };
  }
}
