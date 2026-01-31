import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { HyggloService } from '../src/hygglo/hygglo.service';
import { LoggingService } from '../src/logging/logging.service';

/**
 * E2E test for multi-account login/logout/login cycle.
 *
 * Tests:
 * 1. Login Account A -> scrape -> logout
 * 2. Login Account B -> scrape -> logout
 * 3. Re-login Account A -> verify session handling
 *
 * Requires real Hygglo credentials in .env.
 * Run with: npx jest test/hygglo-auth-cycle.e2e-spec.ts --no-cache
 */
describe('Hygglo Auth Cycle (E2E)', () => {
  let hyggloService: HyggloService;
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        HyggloService,
        {
          provide: LoggingService,
          useValue: {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
          },
        },
      ],
    }).compile();

    hyggloService = module.get<HyggloService>(HyggloService);
    await hyggloService.onModuleInit();
  }, 30000);

  afterAll(async () => {
    await hyggloService.logout();
    await module.close();
  }, 15000);

  it('should have loaded at least one account', () => {
    const accounts = hyggloService.getAccounts();
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    console.log(`Configured accounts: ${accounts.map(a => a.label).join(', ')}`);
  });

  it('should cycle through accounts: login -> scrape -> logout', async () => {
    const accounts = hyggloService.getAccounts();
    const results: { account: string; ongoingCount: number; upcomingCount: number; durationMs: number }[] = [];

    for (const account of accounts) {
      const startTime = Date.now();

      // Login
      console.log(`\n--- Authenticating as ${account.label} ---`);
      const authenticated = await hyggloService.authenticate(account);
      expect(authenticated).toBe(true);
      expect(hyggloService.getCurrentAccount()).toBe(account.name);

      // Scrape ongoing
      console.log(`Scanning ongoing rentals for ${account.label}...`);
      const ongoing = await hyggloService.scanRentals('ongoing');
      console.log(`Found ${ongoing.length} ongoing rentals`);

      // Scrape upcoming
      console.log(`Scanning upcoming rentals for ${account.label}...`);
      const upcoming = await hyggloService.scanRentals('upcoming');
      console.log(`Found ${upcoming.length} upcoming rentals`);

      // Verify account tagging
      for (const rental of [...ongoing, ...upcoming]) {
        expect(rental.account).toBe(account.name);
      }

      // Logout
      console.log(`Logging out of ${account.label}...`);
      await hyggloService.logout();
      expect(hyggloService.getCurrentAccount()).toBeNull();

      const durationMs = Date.now() - startTime;
      results.push({
        account: account.label,
        ongoingCount: ongoing.length,
        upcomingCount: upcoming.length,
        durationMs,
      });

      console.log(`${account.label}: ${ongoing.length} ongoing, ${upcoming.length} upcoming, ${durationMs}ms`);
    }

    // Log summary
    console.log('\n=== Auth Cycle Results ===');
    for (const r of results) {
      console.log(`${r.account}: ongoing=${r.ongoingCount}, upcoming=${r.upcomingCount}, time=${r.durationMs}ms`);
    }
  }, 120000); // 2-minute timeout

  it('should re-login to first account after full cycle', async () => {
    const accounts = hyggloService.getAccounts();
    if (accounts.length === 0) {
      console.log('No accounts configured, skipping re-login test');
      return;
    }

    const firstAccount = accounts[0];
    console.log(`\n--- Re-authenticating as ${firstAccount.label} ---`);
    const authenticated = await hyggloService.authenticate(firstAccount);
    expect(authenticated).toBe(true);
    expect(hyggloService.getCurrentAccount()).toBe(firstAccount.name);

    // Quick scrape to verify session
    const ongoing = await hyggloService.scanRentals('ongoing');
    console.log(`Re-login scrape: ${ongoing.length} ongoing rentals`);

    // Cleanup
    await hyggloService.logout();
  }, 60000);
});
