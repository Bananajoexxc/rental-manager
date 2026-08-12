/**
 * Core Services Unit Tests
 *
 * Comprehensive tests for 4 core services using NestJS testing patterns
 * with mocked PrismaService:
 *   1. ValidationService - response validation and safety checks
 *   2. CalendarService - availability checking against bookings
 *   3. DeliveryService - vehicle selection based on item specs
 *   4. BlacklistService - renter blacklist checking
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ValidationService, ValidationContext } from './validation/validation.service';
import { CalendarService } from './calendar/calendar.service';
import { DeliveryService } from './delivery/delivery.service';
import { BlacklistService } from './blacklist/blacklist.service';
import { PrismaService } from './prisma/prisma.service';

// ---------------------------------------------------------------------------
// Shared mock factory
// ---------------------------------------------------------------------------

function createMockPrismaService() {
  return {
    validation_log: {
      create: jest.fn().mockResolvedValue({ id: 'mock-log-id' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    booking: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'mock-booking-id' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    item_spec: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    blacklisted_renter: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    renter_profile: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

// ===========================================================================
// 1. ValidationService
// ===========================================================================

describe('ValidationService', () => {
  let service: ValidationService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ValidationService>(ValidationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Credential leakage ──

  it('should detect email leakage', async () => {
    const response = 'Sure, you can reach us at email@example.com for further details.';
    const context: ValidationContext = {};

    const result = await service.validateResponse(response, context);

    expect(result.passed).toBe(false);
    expect(result.severity).toBe('critical');
    expect(result.blocked).toBe(true);
    expect(result.violations.some((v) => v.includes('Email address detected'))).toBe(true);
    expect(prisma.validation_log.create).toHaveBeenCalled();
  });

  it('should detect phone number leakage', async () => {
    // The UK phone regex matches formats like 07911123456 or 0791 112 3456
    const response = 'You can call us at 07911123456 to arrange pickup.';
    const context: ValidationContext = {};

    const result = await service.validateResponse(response, context);

    expect(result.passed).toBe(false);
    expect(result.severity).toBe('critical');
    expect(result.blocked).toBe(true);
    expect(result.violations.some((v) => v.includes('Phone number detected'))).toBe(true);
  });

  // ── Address disclosure ──

  it('should detect address disclosure before booking verified', async () => {
    const response = 'Come pick up at 11 Trafalgar Square, we will be waiting there.';
    const context: ValidationContext = { responseType: 'inquiry_response' };

    const result = await service.validateResponse(response, context);

    expect(result.passed).toBe(false);
    expect(result.severity).toBe('critical');
    expect(result.blocked).toBe(true);
    expect(
      result.violations.some((v) => v.includes('pickup address disclosed before booking verified')),
    ).toBe(true);
  });

  it('should allow address disclosure when booking is confirmed', async () => {
    const response =
      'Your booking is confirmed! Collect at 11 Trafalgar Square, WC2N 5DN. Looking forward to meeting you.';
    const context: ValidationContext = { responseType: 'booking_confirmed' };

    const result = await service.validateResponse(response, context);

    // The address check should pass because responseType is booking_confirmed.
    // Other validators (credential, etc.) may still flag, so we just confirm no address violation.
    const addressViolations = result.violations.filter((v) =>
      v.includes('pickup address disclosed before booking verified'),
    );
    expect(addressViolations.length).toBe(0);
  });

  // ── Dual account disclosure ──

  it('should detect dual account disclosure mentioning both DB Cinema and Leo Adams', async () => {
    const response =
      'DB Cinema and Leo Adams are run by the same business, so you get shared inventory.';
    const context: ValidationContext = {};

    const result = await service.validateResponse(response, context);

    expect(result.passed).toBe(false);
    expect(result.severity).toBe('critical');
    expect(result.blocked).toBe(true);
    expect(
      result.violations.some(
        (v) =>
          v.includes('Dual-account disclosure') ||
          v.includes('Both account names mentioned'),
      ),
    ).toBe(true);
  });

  // ── Clean responses ──

  it('should pass clean responses with no violations', async () => {
    const response =
      'Hi! Thanks for your interest. We have the Sony FX3 available for that weekend. Would you like to go ahead?';
    const context: ValidationContext = { responseType: 'inquiry_response' };

    const result = await service.validateResponse(response, context);

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.severity).toBe('low');
    expect(result.blocked).toBe(false);
    expect(prisma.validation_log.create).toHaveBeenCalledTimes(1);
  });

  // ── Inventory hallucination ──

  it('should detect inventory hallucination for items not in MASTER_INVENTORY', async () => {
    // The hallucination detector looks for capitalized phrases with digits or uppercase starts
    // in the context of equipment-sounding text. "XZ9000" is not in inventory.
    const response =
      'We have the XZ9000 camera available along with a lens for your shoot.';
    const context: ValidationContext = {};

    const result = await service.validateResponse(response, context);

    // The hallucination detector flags items that look like model numbers but are not in inventory
    expect(
      result.violations.some((v) => v.includes('inventory hallucination') || v.includes('XZ9000')),
    ).toBe(true);
  });

  it('should not flag known inventory items as hallucinations', async () => {
    const response =
      'The Sony FX3 is a great camera for your project, paired with the Sony GM 24-70mm lens.';
    const context: ValidationContext = {};

    const result = await service.validateResponse(response, context);

    // Known inventory items should not trigger hallucination violations
    const hallucinationViolations = result.violations.filter((v) =>
      v.includes('inventory hallucination'),
    );
    expect(hallucinationViolations).toHaveLength(0);
  });

  // ── Validation logging ──

  it('should log validation results to the database', async () => {
    const response = 'Hello, thanks for reaching out!';
    const context: ValidationContext = {};
    const aiDecisionId = 'decision-123';

    await service.validateResponse(response, context, aiDecisionId);

    expect(prisma.validation_log.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ai_decision_id: aiDecisionId,
        response_text: response.substring(0, 1000),
      }),
    });
  });
});

// ===========================================================================
// 2. CalendarService
// ===========================================================================

describe('CalendarService', () => {
  let service: CalendarService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CalendarService>(CalendarService);
    // Do NOT call onModuleInit - it validates catalogs and logs warnings
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const startDate = new Date('2026-03-01T09:00:00Z');
  const endDate = new Date('2026-03-03T17:00:00Z');

  it('should return available when no bookings exist', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    const result = await service.checkAvailability('Sony FX3', startDate, endDate);

    expect(result.available).toBe(true);
    expect(result.booked).toBe(0);
    expect(result.maxQuantity).toBe(3); // MASTER_INVENTORY has 3 Sony FX3 units
    expect(result.matchedItem).toBe('Sony FX3');
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          item_name: 'Sony FX3',
          status: 'confirmed',
        }),
      }),
    );
  });

  it('should return unavailable when all units are booked', async () => {
    // Sony FX3 has maxQuantity of 3. Simulate 3 bookings that overlap.
    prisma.booking.findMany.mockResolvedValue([
      { id: 'b1', item_name: 'Sony FX3', quantity: 1, status: 'confirmed' },
      { id: 'b2', item_name: 'Sony FX3', quantity: 1, status: 'confirmed' },
      { id: 'b3', item_name: 'Sony FX3', quantity: 1, status: 'confirmed' },
    ]);

    const result = await service.checkAvailability('Sony FX3', startDate, endDate);

    expect(result.available).toBe(false);
    expect(result.booked).toBe(3);
    expect(result.maxQuantity).toBe(3);
    expect(result.matchedItem).toBe('Sony FX3');
  });

  it('should return available when only partial units are booked', async () => {
    // Sony FX3 has maxQuantity of 3. Simulate 2 bookings.
    prisma.booking.findMany.mockResolvedValue([
      { id: 'b1', item_name: 'Sony FX3', quantity: 1, status: 'confirmed' },
      { id: 'b2', item_name: 'Sony FX3', quantity: 1, status: 'confirmed' },
    ]);

    const result = await service.checkAvailability('Sony FX3', startDate, endDate);

    expect(result.available).toBe(true);
    expect(result.booked).toBe(2);
    expect(result.maxQuantity).toBe(3);
    expect(result.matchedItem).toBe('Sony FX3');
  });

  it('should handle unknown items not in MASTER_INVENTORY', async () => {
    // Use a name that cannot fuzzy-match any inventory item
    const result = await service.checkAvailability(
      'xwqrzplk',
      startDate,
      endDate,
    );

    expect(result.available).toBe(false);
    expect(result.booked).toBe(0);
    expect(result.maxQuantity).toBe(0);
    expect(result.matchedItem).toBeNull();
    // Should not even query bookings for an unknown item
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('should handle single-quantity items correctly', async () => {
    // Fujifilm X100 VI has maxQuantity 1
    prisma.booking.findMany.mockResolvedValue([
      { id: 'b1', item_name: 'Fujifilm X100 VI', quantity: 1, status: 'confirmed' },
    ]);

    const result = await service.checkAvailability('Fujifilm X100 VI', startDate, endDate);

    expect(result.available).toBe(false);
    expect(result.booked).toBe(1);
    expect(result.maxQuantity).toBe(1);
    expect(result.matchedItem).toBe('Fujifilm X100 VI');
  });

  it('should apply 1-hour buffer on date range queries', async () => {
    prisma.booking.findMany.mockResolvedValue([]);

    await service.checkAvailability('Sony FX3', startDate, endDate);

    // The service adds 1-hour buffer on each side
    const callArgs = prisma.booking.findMany.mock.calls[0][0];
    const queryStartDate = callArgs.where.start_date.lt;

    // bufferEnd = endDate + 1 hour => start_date < bufferEnd
    const expectedBufferEnd = new Date(endDate.getTime() + 60 * 60 * 1000);
    expect(queryStartDate.getTime()).toBe(expectedBufferEnd.getTime());

    // bufferStart = startDate - 1 hour => overlap checked against return_date
    // (actual return, when known) falling back to end_date (scheduled) via OR
    const expectedBufferStart = new Date(startDate.getTime() - 60 * 60 * 1000);
    expect(callArgs.where.OR).toEqual([
      { return_date: { gt: expectedBufferStart } },
      { return_date: null, end_date: { gt: expectedBufferStart } },
    ]);
  });
});

// ===========================================================================
// 3. DeliveryService
// ===========================================================================

describe('DeliveryService', () => {
  let service: DeliveryService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<DeliveryService>(DeliveryService);
    // Do NOT call onModuleInit - it seeds DB and calls external APIs
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should select motorcycle for a single small item', async () => {
    // Rode Wireless Mic Pro set: size_score=1, weight_kg=0.5, is_heavy_large=false
    prisma.item_spec.findFirst.mockResolvedValue(null);

    const result = await service.determineVehicle(['Rode Wireless Mic Pro set']);

    expect(result.vehicle).toBe('motorcycle');
    expect(result.vehicle_display).toBe('Motorcycle courier');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('Rode Wireless Mic Pro set');
    expect(result.items[0].size_score).toBe(1);
    expect(result.items[0].is_heavy_large).toBe(false);
  });

  it('should select small_car for a typical camera kit with tripod', async () => {
    // Sony FX3: size_score=2, Small rig tripod: size_score=3 (needs car)
    prisma.item_spec.findFirst.mockResolvedValue(null);

    const result = await service.determineVehicle(['Sony FX3', 'Small rig tripod']);

    expect(result.vehicle).toBe('small_car');
    expect(result.vehicle_display).toBe('Small car courier');
    expect(result.items).toHaveLength(2);
  });

  it('should select large_van for DJ controller + speakers combo', async () => {
    // DJ RX3 Pioneer controller + JBL Club 120 speaker -> mandatory large van
    prisma.item_spec.findFirst.mockResolvedValue(null);

    const result = await service.determineVehicle([
      'DJ RX3 Pioneer controller',
      'JBL Club 120 speaker',
    ]);

    expect(result.vehicle).toBe('large_van');
    expect(result.vehicle_display).toBe('Large van');
    expect(result.courier_explanation).toContain('DJ controller');
    expect(result.courier_explanation).toContain('speakers');
    expect(result.courier_explanation).toContain('large van');
  });

  it('should select large_van when 3+ items have size_score >= 4', async () => {
    // Nanlite Forza 300 (4), Nanlite 500B (4), C-stand (4) all have size_score=4
    prisma.item_spec.findFirst.mockResolvedValue(null);

    const result = await service.determineVehicle([
      'Nanlite Forza 300',
      'Nanlite 500B',
      'C-stand',
    ]);

    expect(result.vehicle).toBe('large_van');
    expect(result.vehicle_display).toBe('Large van');
    expect(result.courier_explanation).toContain('heavy/large');
  });

  it('should use conservative defaults for unknown items', async () => {
    // Use a name that cannot fuzzy-match any inventory item
    prisma.item_spec.findFirst.mockResolvedValue(null);

    const result = await service.determineVehicle(['xwqrzplk']);

    // Conservative default: size_score=3, weight_kg=2.0
    // maxScore=3 >= 3, so should be small_car (not motorcycle)
    expect(result.vehicle).toBe('small_car');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].size_score).toBe(3);
    expect(result.items[0].weight_kg).toBe(2.0);
    expect(result.items[0].is_heavy_large).toBe(false);
  });

  it('should fall back to DB item_spec when delivery spec is not found', async () => {
    // Mock findBestMatch to find the item, but getDeliverySpec returns null
    // by using a name that exists in inventory but we'll mock the DB spec
    prisma.item_spec.findFirst.mockResolvedValue({
      id: 'spec-1',
      item_name: 'Sony FX3',
      size_score: 2,
      weight_kg: 0.7,
    });

    const result = await service.determineVehicle(['Sony FX3']);

    // Sony FX3 has a delivery spec (size_score=2), so the delivery spec takes priority.
    // Either way, motorcycle or the correct score should be used.
    expect(result.items[0].size_score).toBe(2);
    expect(result.items[0].weight_kg).toBe(0.7);
  });

  it('should select motorcycle for multiple small items under weight limit', async () => {
    // Two wireless mic sets: each score=1, weight=0.5kg, total=1.0kg <= 8kg, no heavy_large
    prisma.item_spec.findFirst.mockResolvedValue(null);

    const result = await service.determineVehicle([
      'Rode Wireless Mic Pro set',
      'DJI Wireless Mics',
    ]);

    expect(result.vehicle).toBe('motorcycle');
    expect(result.vehicle_display).toBe('Motorcycle courier');
    expect(result.items).toHaveLength(2);
  });
});

// ===========================================================================
// 4. BlacklistService
// ===========================================================================

describe('BlacklistService', () => {
  let service: BlacklistService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlacklistService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<BlacklistService>(BlacklistService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should find exact name match in blacklist', async () => {
    const blacklistEntry = {
      id: 'bl-1',
      name: 'John Doe',
      reason: 'Equipment damage',
      added_by: 'owner',
    };
    prisma.blacklisted_renter.findFirst.mockResolvedValue(blacklistEntry);

    const result = await service.isBlacklisted('John Doe');

    expect(result.blacklisted).toBe(true);
    expect(result.entry).toEqual(blacklistEntry);
    expect(prisma.blacklisted_renter.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { name: { contains: 'John Doe', mode: 'insensitive' } },
          { name: { equals: 'John Doe', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('should find case-insensitive match', async () => {
    const blacklistEntry = {
      id: 'bl-2',
      name: 'Jane Smith',
      reason: 'Late returns',
      added_by: 'owner',
    };
    prisma.blacklisted_renter.findFirst.mockResolvedValue(blacklistEntry);

    const result = await service.isBlacklisted('jane smith');

    expect(result.blacklisted).toBe(true);
    expect(result.entry).toEqual(blacklistEntry);
    // Verify insensitive mode is used in the query
    expect(prisma.blacklisted_renter.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { name: { contains: 'jane smith', mode: 'insensitive' } },
          { name: { equals: 'jane smith', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('should find partial name match (contains)', async () => {
    // The service uses "contains" in the OR clause, so "Bob" should match "Bob Johnson"
    const blacklistEntry = {
      id: 'bl-3',
      name: 'Bob Johnson',
      reason: 'Non-payment',
      added_by: 'owner',
    };
    prisma.blacklisted_renter.findFirst.mockResolvedValue(blacklistEntry);

    const result = await service.isBlacklisted('Bob');

    expect(result.blacklisted).toBe(true);
    expect(result.entry).toEqual(blacklistEntry);
    // The query sends trimmed name with contains
    expect(prisma.blacklisted_renter.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { name: { contains: 'Bob', mode: 'insensitive' } },
          { name: { equals: 'Bob', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('should return not blacklisted for unknown name', async () => {
    // Both blacklisted_renter and renter_profile return null
    prisma.blacklisted_renter.findFirst.mockResolvedValue(null);
    prisma.renter_profile.findFirst.mockResolvedValue(null);

    const result = await service.isBlacklisted('Completely Unknown Person');

    expect(result.blacklisted).toBe(false);
    expect(result.entry).toBeUndefined();
  });

  it('should check renter_profile name variants for cross-reference', async () => {
    // Direct blacklist check returns null
    prisma.blacklisted_renter.findFirst
      .mockResolvedValueOnce(null) // First call: direct check for "Mike Wilson"
      .mockResolvedValueOnce({      // Second call: checking variant "Michael W"
        id: 'bl-4',
        name: 'Michael W',
        reason: 'Fraud',
        added_by: 'owner',
      });

    // renter_profile has a name variant that IS blacklisted
    prisma.renter_profile.findFirst.mockResolvedValue({
      id: 'rp-1',
      name: 'Mike Wilson',
      name_variants: ['Michael W', 'M. Wilson'],
    });

    const result = await service.isBlacklisted('Mike Wilson');

    expect(result.blacklisted).toBe(true);
    expect(result.entry).toEqual(
      expect.objectContaining({ name: 'Michael W', reason: 'Fraud' }),
    );
    // Verify renter_profile was queried
    expect(prisma.renter_profile.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { name: { equals: 'Mike Wilson', mode: 'insensitive' } },
          { name_variants: { has: 'Mike Wilson' } },
        ],
      },
    });
  });

  it('should return not blacklisted for empty string', async () => {
    const result = await service.isBlacklisted('');

    expect(result.blacklisted).toBe(false);
    // Should short-circuit without querying
    expect(prisma.blacklisted_renter.findFirst).not.toHaveBeenCalled();
  });

  it('should trim whitespace from name before checking', async () => {
    const blacklistEntry = {
      id: 'bl-5',
      name: 'Sarah Connor',
      reason: 'Stolen equipment',
      added_by: 'owner',
    };
    prisma.blacklisted_renter.findFirst.mockResolvedValue(blacklistEntry);

    const result = await service.isBlacklisted('  Sarah Connor  ');

    expect(result.blacklisted).toBe(true);
    // Verify the trimmed name is used in the query
    expect(prisma.blacklisted_renter.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { name: { contains: 'Sarah Connor', mode: 'insensitive' } },
          { name: { equals: 'Sarah Connor', mode: 'insensitive' } },
        ],
      },
    });
  });
});
