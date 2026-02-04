import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Browser, BrowserContext, Page } from 'playwright';

type HyggloAccount = 'dbcinema' | 'leo';

@Injectable()
export class PlaywrightService implements OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightService.name);
  private browser: Browser | null = null;
  private contexts = new Map<HyggloAccount, BrowserContext>();
  private readonly MAX_RETRIES = 3;

  private get isEnabled(): boolean {
    return process.env.PLAYWRIGHT_ENABLED === 'true';
  }

  private get isReadOnly(): boolean {
    return process.env.READ_ONLY_MODE === 'true';
  }

  private get isHeadless(): boolean {
    return process.env.PLAYWRIGHT_HEADLESS !== 'false';
  }

  private get baseUrl(): string {
    return process.env.FAT_LLAMA_BASE_URL || 'https://www.hygglo.com';
  }

  async onModuleDestroy() {
    await this.closeBrowser();
  }

  /**
   * Ensure browser is launched and ready.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }

    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: this.isHeadless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    this.logger.log(`Browser launched (headless: ${this.isHeadless})`);
    return this.browser;
  }

  /**
   * Close the browser and all contexts.
   */
  private async closeBrowser(): Promise<void> {
    for (const [account, ctx] of this.contexts) {
      try {
        await ctx.close();
      } catch {
        // Ignore close errors
      }
    }
    this.contexts.clear();

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Ignore close errors
      }
      this.browser = null;
    }
  }

  /**
   * Get or create a persistent browser context for an account.
   * Uses persistent storage for cookies/sessions.
   */
  private async getContext(account: HyggloAccount): Promise<BrowserContext> {
    const existing = this.contexts.get(account);
    if (existing) {
      return existing;
    }

    const browser = await this.ensureBrowser();
    const storagePath = `./playwright-data/${account}`;

    // Try to load stored state, fall back to new context
    let context: BrowserContext;
    try {
      const fs = await import('fs');
      const statePath = `${storagePath}/state.json`;
      if (fs.existsSync(statePath)) {
        context = await browser.newContext({
          storageState: statePath,
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        });
        this.logger.debug(`Loaded stored session for ${account}`);
      } else {
        context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        });
      }
    } catch {
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
    }

    this.contexts.set(account, context);
    return context;
  }

  /**
   * Save browser context storage state for session persistence.
   */
  private async saveState(account: HyggloAccount, context: BrowserContext): Promise<void> {
    try {
      const fs = await import('fs');
      const storagePath = `./playwright-data/${account}`;
      fs.mkdirSync(storagePath, { recursive: true });
      await context.storageState({ path: `${storagePath}/state.json` });
      this.logger.debug(`Saved session state for ${account}`);
    } catch (error) {
      this.logger.warn(`Failed to save state for ${account}: ${error.message}`);
    }
  }

  /**
   * Log in to Fat Llama/Hygglo for a specific account.
   * Uses stored credentials from environment variables.
   */
  async ensureLoggedIn(account: HyggloAccount): Promise<boolean> {
    if (!this.isEnabled) {
      this.logger.debug('Playwright is disabled, skipping login');
      return false;
    }

    try {
      const context = await this.getContext(account);
      const page = await context.newPage();

      try {
        // Check if already logged in
        await page.goto(`${this.baseUrl}/my/orders`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });

        // If we're redirected to login, we need to authenticate
        const url = page.url();
        if (url.includes('/login') || url.includes('/signin') || url.includes('/auth')) {
          this.logger.log(`Need to log in for ${account}...`);

          const email = account === 'dbcinema'
            ? process.env.HYGGLO_DBCINEMA_EMAIL
            : process.env.HYGGLO_LEO_EMAIL;
          const password = account === 'dbcinema'
            ? process.env.HYGGLO_DBCINEMA_PASSWORD
            : process.env.HYGGLO_LEO_PASSWORD;

          if (!email || !password) {
            this.logger.error(`No credentials configured for ${account}`);
            return false;
          }

          // Fill login form
          await page.fill('input[type="email"], input[name="email"], #email', email);
          await page.fill('input[type="password"], input[name="password"], #password', password);
          await page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")');

          // Wait for navigation after login
          await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2000);

          // Verify login succeeded
          const postLoginUrl = page.url();
          if (postLoginUrl.includes('/login') || postLoginUrl.includes('/signin')) {
            this.logger.error(`Login failed for ${account} - still on login page`);
            return false;
          }

          this.logger.log(`Successfully logged in as ${account}`);
          await this.saveState(account, context);
        } else {
          this.logger.debug(`Already logged in for ${account}`);
        }

        return true;
      } finally {
        await page.close();
      }
    } catch (error) {
      this.logger.error(`ensureLoggedIn failed for ${account}: ${error.message}`);
      // Clear cached context on auth failure to force re-login
      const ctx = this.contexts.get(account);
      if (ctx) {
        await ctx.close().catch(() => {});
        this.contexts.delete(account);
      }
      return false;
    }
  }

  /**
   * Accept a rental by navigating to the order page and clicking Accept.
   * Gated by READ_ONLY_MODE and PLAYWRIGHT_ENABLED.
   */
  async acceptRental(orderId: string, account: HyggloAccount): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.isEnabled) {
      return { success: false, error: 'Playwright is disabled' };
    }
    if (this.isReadOnly) {
      this.logger.warn(`BLOCKED [READ_ONLY_MODE] acceptRental for order ${orderId}`);
      return { success: false, error: 'Read-only mode is active' };
    }

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const loggedIn = await this.ensureLoggedIn(account);
        if (!loggedIn) {
          return { success: false, error: 'Failed to log in' };
        }

        const context = await this.getContext(account);
        const page = await context.newPage();

        try {
          // Navigate to the order page
          await page.goto(`${this.baseUrl}/my/orders/${orderId}`, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });

          await page.waitForTimeout(2000);

          // Look for Accept button - try multiple selectors
          const acceptSelectors = [
            'button:has-text("Accept")',
            'button:has-text("Approve")',
            'button:has-text("Confirm")',
            '[data-testid="accept-button"]',
            '.accept-button',
            'button.accept',
          ];

          let acceptButton: any = null;
          for (const selector of acceptSelectors) {
            acceptButton = await page.$(selector);
            if (acceptButton) break;
          }

          if (!acceptButton) {
            this.logger.warn(`No accept button found for order ${orderId} on attempt ${attempt}`);
            return { success: false, error: 'Accept button not found on page' };
          }

          // Click the accept button
          await acceptButton.click();
          await page.waitForTimeout(1000);

          // Look for confirmation dialog/button
          const confirmSelectors = [
            'button:has-text("Confirm")',
            'button:has-text("Yes")',
            'button:has-text("OK")',
            '[data-testid="confirm-button"]',
          ];

          for (const selector of confirmSelectors) {
            const confirmButton = await page.$(selector);
            if (confirmButton) {
              await confirmButton.click();
              await page.waitForTimeout(2000);
              break;
            }
          }

          await this.saveState(account, context);
          this.logger.log(`Successfully accepted rental ${orderId} for ${account}`);
          return { success: true };
        } finally {
          await page.close();
        }
      } catch (error) {
        this.logger.warn(`acceptRental attempt ${attempt}/${this.MAX_RETRIES} failed for ${orderId}: ${error.message}`);
        if (attempt < this.MAX_RETRIES) {
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        } else {
          return { success: false, error: `All ${this.MAX_RETRIES} attempts failed: ${error.message}` };
        }
      }
    }

    return { success: false, error: 'Exhausted all retry attempts' };
  }

  /**
   * Read verification status by navigating to the order chat page
   * and parsing status bar indicators (yellow/green).
   * Fallback method when API doesn't provide verification data.
   */
  async readVerificationStatus(orderId: string, account: HyggloAccount): Promise<{
    needsVerification: boolean;
    verificationComplete: boolean;
    method: 'playwright';
  }> {
    if (!this.isEnabled) {
      return { needsVerification: false, verificationComplete: false, method: 'playwright' };
    }

    try {
      const loggedIn = await this.ensureLoggedIn(account);
      if (!loggedIn) {
        return { needsVerification: false, verificationComplete: false, method: 'playwright' };
      }

      const context = await this.getContext(account);
      const page = await context.newPage();

      try {
        await page.goto(`${this.baseUrl}/my/orders/${orderId}`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });

        await page.waitForTimeout(2000);

        // Look for verification-related status indicators
        const pageContent = await page.content();
        const pageText = await page.innerText('body').catch(() => '');
        const lowerText = pageText.toLowerCase();

        const needsVerification =
          lowerText.includes('verification required') ||
          lowerText.includes('verify identity') ||
          lowerText.includes('id verification') ||
          lowerText.includes('pending verification') ||
          lowerText.includes('waiting for verification');

        const verificationComplete =
          lowerText.includes('verified') ||
          lowerText.includes('verification complete') ||
          lowerText.includes('identity confirmed');

        return { needsVerification, verificationComplete, method: 'playwright' };
      } finally {
        await page.close();
      }
    } catch (error) {
      this.logger.warn(`readVerificationStatus failed for ${orderId}: ${error.message}`);
      return { needsVerification: false, verificationComplete: false, method: 'playwright' };
    }
  }
}
