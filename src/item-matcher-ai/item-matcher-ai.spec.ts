/**
 * AI Item Matcher — Comprehensive Test Suite
 *
 * Tests the ItemMatcherAiService with mocked Anthropic API.
 * 30+ scenarios covering brand confusion, focal length, SEO titles,
 * bundles, message extraction, edge cases, and vision post-processing.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ItemMatcherAiService } from './item-matcher-ai.service';
import { PrismaService } from '../prisma/prisma.service';

// --- Mock helpers ---

function createMockPrisma() {
  return {
    item_match_cache: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
    },
    rental: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function createMockConfig() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return 'test-key';
      if (key === 'CLAUDE_MODEL') return 'claude-haiku-4-5-20250514';
      return undefined;
    }),
  };
}

// Helper to create an AI response for the mock
function aiResponse(jsonStr: string) {
  return {
    content: [{ type: 'text', text: jsonStr }],
  };
}

// Build the test module with a controllable AI mock
async function buildTestModule(aiMock?: jest.Mock) {
  const prisma = createMockPrisma();
  const config = createMockConfig();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ItemMatcherAiService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();

  const service = module.get<ItemMatcherAiService>(ItemMatcherAiService);

  // Replace the Anthropic client with our mock
  if (aiMock) {
    (service as any).client = {
      messages: { create: aiMock },
    };
  }

  return { service, prisma, aiMock };
}

// ============================================================
// Category 1: Brand Confusion (6 tests)
// ============================================================

describe('Brand Confusion', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service } = await buildTestModule(aiMock));
  });

  it('should NOT match Aputure 300d II to any inventory item', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":null,"confidence":0.95,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('2x Aputure 300d II lights');
    expect(result.item).toBeNull();
  });

  it('should NOT match Canon RF lens to Sony inventory', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":null,"confidence":0.9,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Canon RF 24-70mm f2.8 L IS');
    expect(result.item).toBeNull();
  });

  it('should NOT match Sigma lens to Sony inventory', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":null,"confidence":0.9,"isMarketing":true,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Sigma 24-70mm f2.8 Art');
    expect(result.item).toBeNull();
  });

  it('should match Sony FX3 correctly', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony FX3","confidence":0.98,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Sony FX3 cinema camera');
    expect(result.item).toBe('Sony FX3');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('should match Nanlite Forza 60 II to inventory', async () => {
    // Note: inventory has "Nanlite Forza 300" but not "Forza 60 II" — AI should return null
    aiMock.mockResolvedValue(
      aiResponse('{"match":null,"confidence":0.8,"isMarketing":false,"alternatives":["Nanlite Forza 300"]}'),
    );
    const result = await service.resolveItem('Nanlite Forza 60 II bi-color light');
    // Forza 60 II is NOT in inventory (only Forza 300 is)
    expect(result.item).toBeNull();
  });

  it('should mark Aputure 600X Pro as marketing-only', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":null,"confidence":0.95,"isMarketing":true,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Aputure 600X Pro bi-color');
    expect(result.item).toBeNull();
    expect(result.isMarketing).toBe(true);
  });
});

// ============================================================
// Category 2: Focal Length Confusion (5 tests)
// ============================================================

describe('Focal Length Confusion', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service } = await buildTestModule(aiMock));
  });

  it('should NOT match Sony 12-24mm to any inventory lens (not in stock)', async () => {
    // 12-24mm is NOT in inventory — only 16-35mm, 24-70mm, 70-200mm, 90mm exist
    aiMock.mockResolvedValue(
      aiResponse('{"match":null,"confidence":0.3,"isMarketing":false,"alternatives":["Sony GM 16-35mm f2.8"]}'),
    );
    const result = await service.resolveItem('Sony 12-24mm f2.8 GM');
    expect(result.item).toBeNull();
  });

  it('should match Sony GM 24-70mm correctly (not 28-70mm)', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony GM 24-70mm f2.8","confidence":0.97,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Sony GM 24-70mm f2.8 zoom lens');
    expect(result.item).toBe('Sony GM 24-70mm f2.8');
    expect(result.item).not.toBe('Sony 28-70mm');
  });

  it('should match Sony 28-70mm kit lens correctly (not GM 24-70mm)', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony 28-70mm","confidence":0.95,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Sony 28-70mm kit lens');
    expect(result.item).toBe('Sony 28-70mm');
  });

  it('should match Sony G Master 70-200mm correctly', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony GM 70-200mm f2.8","confidence":0.97,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Sony G Master 70-200mm f2.8 tele');
    expect(result.item).toBe('Sony GM 70-200mm f2.8');
  });

  it('should match Sony FE 90mm to GM 90mm', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony GM 90mm f2.8","confidence":0.90,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Sony FE 90mm f2.8 Macro G OSS');
    expect(result.item).toBe('Sony GM 90mm f2.8');
  });
});

// ============================================================
// Category 3: SEO-Heavy Hygglo Titles (5 tests)
// ============================================================

describe('SEO-Heavy Hygglo Titles', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service } = await buildTestModule(aiMock));
  });

  it('should extract Sony FX3 from long SEO title', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony FX3","confidence":0.98,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem(
      'Sony FX3 Full Frame Cinema Camera Body Filmmaking Video 4K 120fps E-mount',
    );
    expect(result.item).toBe('Sony FX3');
  });

  it('should extract Sony GM 70-200mm from SEO title with gmaster variants', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony GM 70-200mm f2.8","confidence":0.97,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem(
      'Sony 70-200mm f2.8 zoom tele gmaster gm g-master g master lens rental London',
    );
    expect(result.item).toBe('Sony GM 70-200mm f2.8');
  });

  it('should extract BMPCC 6K Pro from long title', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"BMPCC 6K Pro","confidence":0.96,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem(
      'Blackmagic Design BMPCC 6K Pro Cinema Camera Super 35 EF Mount',
    );
    expect(result.item).toBe('BMPCC 6K Pro');
  });

  it('should extract DJI Mavic 3 Pro from SEO drone title', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"DJI Mavic 3 Pro","confidence":0.96,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem(
      'DJI Mavic 3 Pro Drone Hasselblad Camera 4K Professional Aerial Photography',
    );
    expect(result.item).toBe('DJI Mavic 3 Pro');
  });

  it('should extract JBL Club 120 speaker from SEO title', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"JBL Club 120 speaker","confidence":0.95,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem(
      'JBL PartyBox Club 120 Portable Bluetooth Speaker LED Lights Bass Party',
    );
    expect(result.item).toBe('JBL Club 120 speaker');
  });
});

// ============================================================
// Category 4: Multi-Item / Bundle Titles (4 tests)
// ============================================================

describe('Multi-Item / Bundle Titles', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service } = await buildTestModule(aiMock));
  });

  it('should match primary item in bundle title (FX3 + 24-70)', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony FX3","confidence":0.95,"isMarketing":false,"alternatives":["Sony GM 24-70mm f2.8"]}'),
    );
    const result = await service.resolveItem('Sony FX3 + GM 24-70mm f2.8 Kit');
    expect(result.item).toBe('Sony FX3');
    expect(result.alternatives).toContain('Sony GM 24-70mm f2.8');
  });

  it('should match Nanlite PavoTube with quantity prefix', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Nanlite Pavotube 30x II","confidence":0.93,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('2x Nanlite PavoTube II 30X RGB');
    // Should be closest match to "Nanlite Pavotube 30x II" (actual inventory name)
    expect(result.item).not.toBeNull();
  });

  it('should match Rode wireless mic set', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Rode Wireless Mic Pro set","confidence":0.88,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Rode Wireless Go II 2-person set');
    expect(result.item).toBe('Rode Wireless Mic Pro set');
  });

  it('should match V-mount battery', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"V-mount 150mAh","confidence":0.90,"isMarketing":false,"alternatives":["V-mount 95mAh"]}'),
    );
    const result = await service.resolveItem('V-Mount Battery 150Wh Gold Mount');
    expect(result.item).toBe('V-mount 150mAh');
  });
});

// ============================================================
// Category 5: Renter Message Extraction (6 tests)
// ============================================================

describe('Renter Message Extraction', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service } = await buildTestModule(aiMock));
  });

  it('should extract FX3 and 24-70mm from natural message', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"inventoryItems":["Sony FX3","Sony GM 24-70mm f2.8"],"nonInventoryItems":[]}'),
    );
    const result = await service.extractItemsFromMessage(
      "Hi, I'd like to rent the FX3 with a 24-70mm lens for a wedding shoot",
    );
    expect(result.inventoryItems).toContain('Sony FX3');
    expect(result.inventoryItems).toContain('Sony GM 24-70mm f2.8');
  });

  it('should separate Aputure (non-inventory) from boom mic (inventory)', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"inventoryItems":["Audio boom mic Sennheiser"],"nonInventoryItems":["Aputure 300d"]}'),
    );
    const result = await service.extractItemsFromMessage(
      'Do you have any Aputure 300d lights? I also need a boom mic',
    );
    expect(result.inventoryItems).toContain('Audio boom mic Sennheiser');
    expect(result.nonInventoryItems).toContain('Aputure 300d');
  });

  it('should resolve "the camera" from conversation context', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"inventoryItems":["Sony FX3","DJI RS3 Pro gimbal"],"nonInventoryItems":[]}'),
    );
    const result = await service.extractItemsFromMessage(
      'I need the camera and gimbal we discussed',
      'Renter inquired about Sony FX3 rental',
    );
    expect(result.inventoryItems).toContain('Sony FX3');
    expect(result.inventoryItems).toContain('DJI RS3 Pro gimbal');
  });

  it('should return empty for generic messages', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"inventoryItems":[],"nonInventoryItems":[]}'),
    );
    const result = await service.extractItemsFromMessage('How much for the gear?');
    expect(result.inventoryItems).toHaveLength(0);
  });

  it('should extract ND filters and wireless mics', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"inventoryItems":["ND filter","Rode Wireless Mic Pro set"],"nonInventoryItems":[]}'),
    );
    const result = await service.extractItemsFromMessage(
      'Can I add ND filters and the wireless mics?',
    );
    expect(result.inventoryItems).toContain('ND filter');
    expect(result.inventoryItems).toContain('Rode Wireless Mic Pro set');
  });

  it('should extract Sony lenses and separate Canon R5 as non-inventory', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"inventoryItems":["Sony GM 24-70mm f2.8","Sony GM 70-200mm f2.8"],"nonInventoryItems":["Canon R5"]}'),
    );
    const result = await service.extractItemsFromMessage(
      "I have a Canon R5 but need Sony lenses — the 24-70 and 70-200",
    );
    expect(result.inventoryItems).toContain('Sony GM 24-70mm f2.8');
    expect(result.inventoryItems).toContain('Sony GM 70-200mm f2.8');
    expect(result.nonInventoryItems).toContain('Canon R5');
  });
});

// ============================================================
// Category 6: Edge Cases / Reliability (5 tests)
// ============================================================

describe('Edge Cases / Reliability', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service } = await buildTestModule(aiMock));
  });

  it('should handle empty input gracefully', async () => {
    const result = await service.resolveItem('');
    expect(result.item).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('should handle random noise gracefully', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":null,"confidence":0.0,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('asdfghjkl random noise');
    expect(result.item).toBeNull();
  });

  it('should handle generic words without brands', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":null,"confidence":0.1,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('camera lens light mic');
    expect(result.item).toBeNull();
  });

  it('should fall back to legacy when API fails', async () => {
    aiMock.mockRejectedValue(new Error('API timeout'));
    const result = await service.resolveItem('Sony FX3 cinema camera');
    // Legacy findBestMatch should kick in
    expect(result.item).toBe('Sony FX3');
  });

  it('should use legacy after circuit breaker opens', async () => {
    // Trigger 3 failures to open circuit breaker
    aiMock.mockRejectedValue(new Error('API error'));
    await service.resolveItem('test 1 item');
    await service.resolveItem('test 2 item');
    await service.resolveItem('test 3 item');

    // Circuit should now be open — next call should not even try AI
    aiMock.mockClear();
    const result = await service.resolveItem('Sony FX3 cinema camera');
    // AI should NOT have been called
    expect(aiMock).not.toHaveBeenCalled();
    // Legacy should still work
    expect(result.item).toBe('Sony FX3');
  });
});

// ============================================================
// Category 7: Vision Post-processing (3 tests)
// ============================================================

describe('Vision Post-processing', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service } = await buildTestModule(aiMock));
  });

  it('should handle vision typo "Sony FX 3" → "Sony FX3"', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony FX3","confidence":0.95,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Sony FX 3 camera');
    expect(result.item).toBe('Sony FX3');
  });

  it('should handle vision shorthand "24-70 GM lens" → "Sony GM 24-70mm f2.8"', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony GM 24-70mm f2.8","confidence":0.92,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('24-70 GM lens');
    expect(result.item).toBe('Sony GM 24-70mm f2.8');
  });

  it('should match "Ambitful RGB tubes" correctly', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Ambitful RGB light tubes 2x set","confidence":0.93,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Ambitful RGB tubes');
    expect(result.item).toBe('Ambitful RGB light tubes 2x set');
  });
});

// ============================================================
// Category 8: Cache Behavior (4 tests)
// ============================================================

describe('Cache Behavior', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service, prisma } = await buildTestModule(aiMock));
  });

  it('should serve from memory cache on second call', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony FX3","confidence":0.98,"isMarketing":false,"alternatives":[]}'),
    );

    // First call — hits AI
    const r1 = await service.resolveItem('Sony FX3 Cinema Camera');
    expect(r1.item).toBe('Sony FX3');
    expect(aiMock).toHaveBeenCalledTimes(1);

    // Second call — should hit cache, NOT AI
    aiMock.mockClear();
    const r2 = await service.resolveItem('Sony FX3 Cinema Camera');
    expect(r2.item).toBe('Sony FX3');
    expect(aiMock).not.toHaveBeenCalled();
  });

  it('should write cache entry to DB after AI call', async () => {
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony FX3","confidence":0.98,"isMarketing":false,"alternatives":[]}'),
    );
    await service.resolveItem('Sony FX3 Camera Body');
    expect(prisma.item_match_cache.upsert).toHaveBeenCalled();
  });

  it('should handle empty message in extractItemsFromMessage', async () => {
    const result = await service.extractItemsFromMessage('');
    expect(result.inventoryItems).toHaveLength(0);
    expect(result.nonInventoryItems).toHaveLength(0);
    expect(aiMock).not.toHaveBeenCalled();
  });

  it('should handle AI returning invalid item name', async () => {
    // AI returns an item that's NOT in inventory
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony FX30","confidence":0.8,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Sony FX30 Cinema Camera');
    // FX30 is NOT in inventory — should be dropped or recovered
    // Recovery via findBestMatch might match to FX3 or return null
    // Either way, it should NOT return "Sony FX30"
    expect(result.item).not.toBe('Sony FX30');
  });
});

// ============================================================
// Category 9: Batch Resolution (3 tests)
// ============================================================

describe('Batch Resolution', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service } = await buildTestModule(aiMock));
  });

  it('should batch-resolve multiple titles', async () => {
    aiMock.mockResolvedValue(
      aiResponse(JSON.stringify([
        { index: 1, match: 'Sony FX3', confidence: 0.98, isMarketing: false },
        { index: 2, match: 'Sony GM 24-70mm f2.8', confidence: 0.97, isMarketing: false },
        { index: 3, match: null, confidence: 0.95, isMarketing: true },
      ])),
    );

    const titles = ['Sony FX3 camera', 'Sony 24-70mm GM lens', 'Aputure 300d II'];
    const results = await service.resolveItems(titles);

    expect(results.get('Sony FX3 camera')?.item).toBe('Sony FX3');
    expect(results.get('Sony 24-70mm GM lens')?.item).toBe('Sony GM 24-70mm f2.8');
    expect(results.get('Aputure 300d II')?.item).toBeNull();
  });

  it('should use cache for already-resolved items in batch', async () => {
    // First resolve one item
    aiMock.mockResolvedValue(
      aiResponse('{"match":"Sony FX3","confidence":0.98,"isMarketing":false,"alternatives":[]}'),
    );
    await service.resolveItem('Sony FX3 camera');

    // Now batch-resolve including that item
    aiMock.mockClear();
    aiMock.mockResolvedValue(
      aiResponse(JSON.stringify([
        { index: 1, match: 'Sony GM 24-70mm f2.8', confidence: 0.97, isMarketing: false },
      ])),
    );

    const results = await service.resolveItems(['Sony FX3 camera', 'Sony 24-70mm GM']);
    expect(results.get('Sony FX3 camera')?.item).toBe('Sony FX3');
    // Only the uncached item should trigger an AI call
    expect(aiMock).toHaveBeenCalledTimes(1);
  });

  it('should handle empty batch', async () => {
    const results = await service.resolveItems([]);
    expect(results.size).toBe(0);
    expect(aiMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// Category 10: JSON Parsing Robustness (3 tests)
// ============================================================

describe('JSON Parsing Robustness', () => {
  let service: ItemMatcherAiService;
  let aiMock: jest.Mock;

  beforeEach(async () => {
    aiMock = jest.fn();
    ({ service } = await buildTestModule(aiMock));
  });

  it('should handle ```json fenced response', async () => {
    aiMock.mockResolvedValue(
      aiResponse('```json\n{"match":"Sony FX3","confidence":0.98,"isMarketing":false,"alternatives":[]}\n```'),
    );
    const result = await service.resolveItem('Sony FX3');
    expect(result.item).toBe('Sony FX3');
  });

  it('should handle response with text before JSON', async () => {
    aiMock.mockResolvedValue(
      aiResponse('Here is the match:\n{"match":"Sony FX3","confidence":0.98,"isMarketing":false,"alternatives":[]}'),
    );
    const result = await service.resolveItem('Sony FX3');
    expect(result.item).toBe('Sony FX3');
  });

  it('should fall back to legacy when AI returns garbage', async () => {
    aiMock.mockResolvedValue(
      aiResponse('I cannot process this request because it contains invalid characters.'),
    );
    const result = await service.resolveItem('Sony FX3 cinema camera');
    // Should fall back to legacy findBestMatch
    expect(result.item).toBe('Sony FX3');
  });
});
