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

  private isWriteEnabledRental(orderId: string): boolean {
    const allowed = process.env.WRITE_ENABLED_RENTALS || '';
    if (!allowed) return false;
    return allowed.split(',').map(s => s.trim()).includes(orderId);
  }

  private isReturnEnabledRental(orderId: string): boolean {
    const allowed = process.env.RETURN_ENABLED_RENTALS || '';
    if (!allowed) return false;
    return allowed.split(',').map(s => s.trim()).includes(orderId);
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
   * Dismiss common Hygglo modals/popups (e.g., "Fat Llama is now Hygglo").
   */
  private async dismissModals(page: any): Promise<void> {
    try {
      // "Fat Llama is now Hygglo" modal — click Continue or X
      const continueBtn = await page.$('button:has-text("Continue")');
      if (continueBtn) {
        await continueBtn.click();
        await page.waitForTimeout(500);
        this.logger.debug('Dismissed "Fat Llama is now Hygglo" modal');
        return;
      }
      // Try X button on modal
      const closeBtn = await page.$('.modal-close, [aria-label="Close"], button:has-text("×")');
      if (closeBtn) {
        await closeBtn.click();
        await page.waitForTimeout(500);
      }
      // Cookie consent
      const cookieBtn = await page.$('button:has-text("Accept"), button:has-text("Got it")');
      if (cookieBtn) {
        await cookieBtn.click();
        await page.waitForTimeout(300);
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Check if the page shows a logged-in state (not just URL check).
   */
  private async isPageLoggedIn(page: any): Promise<boolean> {
    try {
      // Check for "Log in or register" text — means NOT logged in
      const loginLink = await page.$('a:has-text("Log in or register"), a:has-text("Log in"), button:has-text("Log in or register")');
      if (loginLink) return false;
      // Check for account/profile indicators — means logged in
      const profileIndicators = await page.$('[data-testid="user-menu"], .user-avatar, a[href="/my/profile"], a[href*="/my/"]');
      if (profileIndicators) return true;
      // Fallback: check URL
      const url = page.url();
      return !url.includes('/login') && !url.includes('/signin');
    } catch {
      return false;
    }
  }

  /**
   * Perform login on the current page by navigating to the login page.
   */
  private async performLogin(page: any, account: HyggloAccount): Promise<boolean> {
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

    this.logger.log(`Logging in to Hygglo for ${account}...`);

    // Navigate to the main page first
    await page.goto(this.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForTimeout(1500);
    await this.dismissModals(page);

    // Click "Log in or register" button in the header to open login modal/page
    try {
      const loginLink = await page.$('a:has-text("Log in or register"), a:has-text("Log in"), button:has-text("Log in or register"), button:has-text("Log in")');
      if (loginLink) {
        await loginLink.click();
        await page.waitForTimeout(2000);
        await this.dismissModals(page);
      } else {
        this.logger.warn(`No "Log in" button found on main page for ${account}`);
      }
    } catch (e) {
      this.logger.debug(`Click login link failed: ${e.message}`);
    }

    // Take screenshot to see login form state
    const preLoginScreenshot = `/tmp/login-pre-${account}-${Date.now()}.png`;
    await page.screenshot({ path: preLoginScreenshot, fullPage: true });
    this.logger.debug(`Pre-login screenshot: ${preLoginScreenshot}`);

    // Fill login form (could be modal or page)
    try {
      // Wait for email input to appear (modal may take time to render)
      await page.waitForSelector('input[type="email"], input[name="email"], #email, input[placeholder*="mail"]', { timeout: 10000 });
      await page.fill('input[type="email"], input[name="email"], #email, input[placeholder*="mail"]', email);
      await page.fill('input[type="password"], input[name="password"], #password, input[placeholder*="assword"]', password);
      await page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Continue")');
    } catch (e) {
      this.logger.error(`Login form interaction failed for ${account}: ${e.message}`);
      const screenshotPath = `/tmp/login-debug-${account}-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      this.logger.warn(`Login form screenshot saved to ${screenshotPath}`);
      return false;
    }

    // Wait for login to complete
    await page.waitForTimeout(3000);
    await this.dismissModals(page);

    const loggedIn = await this.isPageLoggedIn(page);
    if (loggedIn) {
      this.logger.log(`Successfully logged in as ${account}`);
    } else {
      this.logger.error(`Login failed for ${account} — still not authenticated`);
      const screenshotPath = `/tmp/login-failed-${account}-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
    return loggedIn;
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
        // Navigate to orders page to check login state
        await page.goto(`${this.baseUrl}/my/orders`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        await page.waitForTimeout(1500);
        await this.dismissModals(page);

        // Check both URL and page content for login state
        const url = page.url();
        const needsLogin = url.includes('/login') || url.includes('/signin') || url.includes('/auth')
          || !(await this.isPageLoggedIn(page));

        if (needsLogin) {
          const success = await this.performLogin(page, account);
          if (success) {
            await this.saveState(account, context);
          }
          return success;
        } else {
          this.logger.debug(`Already logged in for ${account}`);
          return true;
        }
      } finally {
        await page.close();
      }
    } catch (error) {
      this.logger.error(`ensureLoggedIn failed for ${account}: ${error.message}`);
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
   * Apply a discount to a rental order by modifying the earnings/price on the Hygglo order page.
   * Must be called BEFORE acceptRental(). Gated by READ_ONLY_MODE and PLAYWRIGHT_ENABLED.
   */
  async applyDiscount(orderId: string, account: HyggloAccount, discountPercent: number): Promise<{
    success: boolean;
    originalPrice?: number;
    discountedPrice?: number;
    error?: string;
  }> {
    if (!this.isEnabled) {
      return { success: false, error: 'Playwright is disabled' };
    }
    if (this.isReadOnly) {
      this.logger.warn(`BLOCKED [READ_ONLY_MODE] applyDiscount for order ${orderId}`);
      return { success: false, error: 'Read-only mode is active' };
    }

    try {
      const loggedIn = await this.ensureLoggedIn(account);
      if (!loggedIn) {
        return { success: false, error: 'Failed to log in' };
      }

      const context = await this.getContext(account);
      const page = await context.newPage();

      try {
        await page.goto(`${this.baseUrl}/my/orders/${orderId}`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        await page.waitForTimeout(2000);

        // Find the earnings/price element on the order page
        const earningsSelectors = [
          '[data-testid="earnings"]',
          '[data-testid="price"]',
          '.earnings-amount',
          '.order-earnings',
          'input[name="earnings"]',
          'input[name="price"]',
        ];

        // Try to find an editable price field
        let priceInput: any = null;
        for (const selector of earningsSelectors) {
          priceInput = await page.$(selector);
          if (priceInput) break;
        }

        // If no dedicated input, look for the price text and try to find an edit button
        if (!priceInput) {
          const editSelectors = [
            'button:has-text("Edit price")',
            'button:has-text("Edit earnings")',
            'button:has-text("Adjust")',
            '[data-testid="edit-price"]',
            '.edit-price-button',
          ];

          for (const selector of editSelectors) {
            const editBtn = await page.$(selector);
            if (editBtn) {
              await editBtn.click();
              await page.waitForTimeout(1000);
              // After clicking edit, look for the input again
              for (const inputSelector of earningsSelectors) {
                priceInput = await page.$(inputSelector);
                if (priceInput) break;
              }
              break;
            }
          }
        }

        if (!priceInput) {
          this.logger.warn(`Could not find price input for order ${orderId} — discount will need manual application`);
          return { success: false, error: 'Price input not found on order page' };
        }

        // Read current price
        const currentValue = await priceInput.inputValue().catch(() => null)
          || await priceInput.textContent().catch(() => null);
        const originalPrice = parseFloat((currentValue || '0').replace(/[^0-9.]/g, ''));

        if (!originalPrice || originalPrice <= 0) {
          return { success: false, error: `Could not read current price: ${currentValue}` };
        }

        const discountedPrice = Math.round(originalPrice * (1 - discountPercent / 100));

        // Clear and type new price
        await priceInput.click({ clickCount: 3 }); // Select all
        await priceInput.fill(discountedPrice.toString());
        await page.waitForTimeout(500);

        // Look for save/apply button
        const saveSelectors = [
          'button:has-text("Save")',
          'button:has-text("Apply")',
          'button:has-text("Update")',
          '[data-testid="save-price"]',
        ];

        for (const selector of saveSelectors) {
          const saveBtn = await page.$(selector);
          if (saveBtn) {
            await saveBtn.click();
            await page.waitForTimeout(1000);
            break;
          }
        }

        await this.saveState(account, context);
        this.logger.log(`Discount applied for order ${orderId}: £${originalPrice} → £${discountedPrice} (${discountPercent}% off)`);
        return { success: true, originalPrice, discountedPrice };
      } finally {
        await page.close();
      }
    } catch (error) {
      this.logger.error(`applyDiscount failed for order ${orderId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Mark a rental as returned on Hygglo by navigating to the order page and clicking the return button.
   * Handles: login, modal dismissal, star rating popup (closes without reviewing).
   * Gated by READ_ONLY_MODE + RETURN_ENABLED_RENTALS and PLAYWRIGHT_ENABLED.
   */
  async markAsReturned(orderId: string, account: HyggloAccount, forceReturn = false): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.isEnabled) {
      return { success: false, error: 'Playwright is disabled' };
    }
    if (this.isReadOnly && !forceReturn && !this.isReturnEnabledRental(orderId)) {
      this.logger.warn(`BLOCKED [READ_ONLY_MODE] markAsReturned for order ${orderId}`);
      return { success: false, error: 'Read-only mode is active' };
    }

    this.logger.log(`markAsReturned: starting for order ${orderId} on ${account}`);

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
          this.logger.debug(`markAsReturned: navigating to order ${orderId}`);
          await page.goto(`${this.baseUrl}/my/orders/${orderId}`, {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
          });
          await page.waitForTimeout(2500);
          await this.dismissModals(page);

          // Verify we're logged in on this page too
          if (!(await this.isPageLoggedIn(page))) {
            this.logger.warn(`markAsReturned: not logged in on order page, re-attempting login`);
            const loginOk = await this.performLogin(page, account);
            if (!loginOk) {
              return { success: false, error: 'Login failed on order page' };
            }
            await this.saveState(account, context);
            // Navigate back to the order
            await page.goto(`${this.baseUrl}/my/orders/${orderId}`, {
              waitUntil: 'domcontentloaded',
              timeout: 20000,
            });
            await page.waitForTimeout(2500);
            await this.dismissModals(page);
          }

          // Take a pre-action screenshot for debugging
          const preScreenshot = `/tmp/return-pre-${orderId}-${Date.now()}.png`;
          await page.screenshot({ path: preScreenshot, fullPage: true });
          this.logger.debug(`markAsReturned: pre-action screenshot saved to ${preScreenshot}`);

          // Log all visible buttons for debugging
          const allButtons = await page.$$eval('button', (btns: any[]) =>
            btns.map(b => ({ text: b.textContent?.trim(), visible: b.offsetParent !== null }))
          );
          this.logger.debug(`markAsReturned: visible buttons on page: ${JSON.stringify(allButtons.filter(b => b.visible).map(b => b.text))}`);

          // Look for return/complete/mark-as-returned buttons
          const returnSelectors = [
            'button:has-text("Mark as returned")',
            'button:has-text("Mark as Returned")',
            'button:has-text("Returned")',
            'button:has-text("Mark returned")',
            'button:has-text("End rental")',
            'button:has-text("End Rental")',
            'button:has-text("Complete rental")',
            'button:has-text("Complete Rental")',
            'button:has-text("Confirm return")',
            'button:has-text("Confirm Return")',
            'button:has-text("Return item")',
            'button:has-text("Return Item")',
            '[data-testid="return-button"]',
            '[data-testid="complete-button"]',
            '[data-testid="mark-returned"]',
          ];

          let returnButton: any = null;
          let matchedSelector = '';
          for (const selector of returnSelectors) {
            returnButton = await page.$(selector);
            if (returnButton) {
              matchedSelector = selector;
              this.logger.debug(`markAsReturned: found button with selector "${selector}"`);
              break;
            }
          }

          if (!returnButton) {
            const screenshotPath = `/tmp/return-debug-${orderId}-${Date.now()}.png`;
            await page.screenshot({ path: screenshotPath, fullPage: true });
            this.logger.warn(`No return button found for order ${orderId} — screenshot saved to ${screenshotPath}`);
            this.logger.warn(`markAsReturned: buttons found were: ${JSON.stringify(allButtons.filter(b => b.visible).map(b => b.text))}`);
            return { success: false, error: 'Return button not found on page' };
          }

          // Click the return button
          this.logger.log(`markAsReturned: clicking "${matchedSelector}" for order ${orderId}`);
          await returnButton.click();
          await page.waitForTimeout(2000);

          // Handle confirmation dialog if it appears
          const confirmSelectors = [
            'button:has-text("Confirm")',
            'button:has-text("Yes")',
            'button:has-text("OK")',
            'button:has-text("Done")',
            'button:has-text("Submit")',
            '[data-testid="confirm-button"]',
          ];

          for (const selector of confirmSelectors) {
            const confirmButton = await page.$(selector);
            if (confirmButton) {
              this.logger.debug(`markAsReturned: clicking confirmation "${selector}"`);
              await confirmButton.click();
              await page.waitForTimeout(2000);
              break;
            }
          }

          // Handle star rating popup — CLOSE IT without rating
          await page.waitForTimeout(1000);
          const ratingDismissed = await this.dismissRatingPopup(page);
          if (ratingDismissed) {
            this.logger.log(`markAsReturned: dismissed star rating popup without reviewing`);
          }

          // Take post-action screenshot
          const postScreenshot = `/tmp/return-post-${orderId}-${Date.now()}.png`;
          await page.screenshot({ path: postScreenshot, fullPage: true });
          this.logger.debug(`markAsReturned: post-action screenshot saved to ${postScreenshot}`);

          await this.saveState(account, context);
          this.logger.log(`Successfully marked rental ${orderId} as returned for ${account}`);
          return { success: true };
        } finally {
          await page.close();
        }
      } catch (error) {
        this.logger.warn(`markAsReturned attempt ${attempt}/${this.MAX_RETRIES} failed for ${orderId}: ${error.message}`);
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
   * Dismiss star rating popup without leaving a review.
   * Tries: close/X button, skip, "Not now", "Maybe later", or clicking outside.
   */
  private async dismissRatingPopup(page: any): Promise<boolean> {
    try {
      // Check if a rating/review modal appeared
      const ratingIndicators = [
        'text=Rate your experience',
        'text=Leave a review',
        'text=How was your experience',
        'text=Rate this',
        'text=stars',
        '[class*="rating"]',
        '[class*="review"]',
        '[class*="star"]',
      ];

      let hasRating = false;
      for (const sel of ratingIndicators) {
        const el = await page.$(sel);
        if (el) { hasRating = true; break; }
      }

      if (!hasRating) return false;

      this.logger.debug('dismissRatingPopup: rating popup detected, dismissing...');

      // Try dismiss buttons in order of preference
      const dismissSelectors = [
        'button:has-text("Skip")',
        'button:has-text("Not now")',
        'button:has-text("Maybe later")',
        'button:has-text("Close")',
        'button:has-text("Cancel")',
        'button:has-text("No thanks")',
        '[aria-label="Close"]',
        '.modal-close',
        'button:has-text("×")',
        'button.close',
      ];

      for (const selector of dismissSelectors) {
        const btn = await page.$(selector);
        if (btn) {
          await btn.click();
          await page.waitForTimeout(1000);
          this.logger.debug(`dismissRatingPopup: clicked "${selector}"`);
          return true;
        }
      }

      // Last resort: press Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Leave a 5-star review on a completed rental order.
   * Gated by READ_ONLY_MODE and PLAYWRIGHT_ENABLED.
   */
  async leaveReview(orderId: string, account: HyggloAccount, stars: number = 5, forceReturn = false): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.isEnabled) {
      return { success: false, error: 'Playwright is disabled' };
    }
    if (this.isReadOnly && !forceReturn) {
      this.logger.warn(`BLOCKED [READ_ONLY_MODE] leaveReview for order ${orderId}`);
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
          await page.goto(`${this.baseUrl}/my/orders/${orderId}`, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });

          await page.waitForTimeout(2000);

          // Look for review button / section
          const reviewSelectors = [
            'button:has-text("Leave a review")',
            'button:has-text("Write a review")',
            'button:has-text("Rate")',
            'button:has-text("Review")',
            '[data-testid="review-button"]',
            '.review-button',
            'a:has-text("Leave a review")',
          ];

          let reviewButton: any = null;
          for (const selector of reviewSelectors) {
            reviewButton = await page.$(selector);
            if (reviewButton) break;
          }

          if (!reviewButton) {
            this.logger.warn(`No review button found for order ${orderId} — may already be reviewed`);
            return { success: false, error: 'Review button not found — may already be reviewed' };
          }

          await reviewButton.click();
          await page.waitForTimeout(2000);

          // Select star rating
          const starSelectors = [
            `[data-rating="${stars}"]`,
            `[data-value="${stars}"]`,
            `.star-rating .star:nth-child(${stars})`,
            `.rating-stars [data-star="${stars}"]`,
            `.stars label:nth-child(${stars})`,
            `input[name="rating"][value="${stars}"]`,
          ];

          let starElement: any = null;
          for (const selector of starSelectors) {
            starElement = await page.$(selector);
            if (starElement) break;
          }

          if (starElement) {
            await starElement.click();
            await page.waitForTimeout(500);
          } else {
            // Try clicking the 5th star element generically
            const allStars = await page.$$('.star, .star-icon, [class*="star"], svg[class*="star"]');
            if (allStars.length >= stars) {
              await allStars[stars - 1].click();
              await page.waitForTimeout(500);
            } else {
              this.logger.warn(`Could not find star rating elements for order ${orderId}`);
            }
          }

          // Submit the review
          const submitSelectors = [
            'button:has-text("Submit")',
            'button:has-text("Send")',
            'button:has-text("Post review")',
            'button[type="submit"]',
            '[data-testid="submit-review"]',
          ];

          for (const selector of submitSelectors) {
            const submitBtn = await page.$(selector);
            if (submitBtn) {
              await submitBtn.click();
              await page.waitForTimeout(2000);
              break;
            }
          }

          await this.saveState(account, context);
          this.logger.log(`Left ${stars}-star review for order ${orderId} (${account})`);
          return { success: true };
        } finally {
          await page.close();
        }
      } catch (error) {
        this.logger.warn(`leaveReview attempt ${attempt}/${this.MAX_RETRIES} failed for ${orderId}: ${error.message}`);
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

  /**
   * Scrape renter reviews from their Hygglo public profile page.
   * Returns average rating, review count, and individual review details.
   */
  async scrapeRenterReviews(
    renterUserId: string,
    account: HyggloAccount = 'dbcinema',
  ): Promise<{
    averageRating?: number;
    reviewCount?: number;
    reviews: { stars: number; text: string; date?: string }[];
  }> {
    if (!this.isEnabled) {
      return { reviews: [] };
    }

    try {
      const context = await this.getContext(account);
      const page = await context.newPage();

      try {
        const profileUrl = `https://www.hygglo.com/user/${renterUserId}`;
        this.logger.debug(`Scraping renter reviews from ${profileUrl}`);

        await page.goto(profileUrl, {
          waitUntil: 'networkidle',
          timeout: 20000,
        });

        await page.waitForTimeout(2000);

        const pageText = await page.innerText('body').catch(() => '');

        // Extract average rating — look for patterns like "4.8" near star/rating elements
        let averageRating: number | undefined;
        let reviewCount: number | undefined;
        const reviews: { stars: number; text: string; date?: string }[] = [];

        // Try to find rating from structured data or visible text
        // Common patterns: "4.8 (12 reviews)", "4.8/5", "★ 4.8"
        const ratingMatch = pageText.match(/(\d+\.?\d*)\s*(?:\/\s*5|stars?|⭐|★)/i)
          || pageText.match(/(?:rating|betyg)[:\s]*(\d+\.?\d*)/i);
        if (ratingMatch) {
          averageRating = parseFloat(ratingMatch[1]);
          if (averageRating > 5) averageRating = undefined; // Sanity check
        }

        // Try to find review count
        const countMatch = pageText.match(/(\d+)\s*(?:reviews?|omdömen|recension)/i)
          || pageText.match(/(?:reviews?|omdömen)[:\s]*(\d+)/i);
        if (countMatch) {
          reviewCount = parseInt(countMatch[1], 10);
        }

        // Try to extract individual reviews from the page
        // Look for review containers with star ratings and text
        const reviewElements = await page.$$('[class*="review"], [class*="Review"], [data-testid*="review"]').catch(() => []);

        for (const el of reviewElements) {
          try {
            const text = await el.innerText();
            // Try to find star count in this review element
            const starsInReview = text.match(/(\d+\.?\d*)\s*(?:\/\s*5|stars?|⭐|★)/i);
            const stars = starsInReview ? parseFloat(starsInReview[1]) : 5;
            // Clean the text: remove the rating portion
            const cleanText = text.replace(/\d+\.?\d*\s*(?:\/\s*5|stars?|⭐|★)/gi, '').trim();
            if (cleanText.length > 5) {
              reviews.push({ stars, text: cleanText.substring(0, 500) });
            }
          } catch {
            // Skip unparseable review elements
          }
        }

        // If no structured reviews found, try to find review text blocks
        if (reviews.length === 0) {
          // Look for star elements (filled vs empty stars)
          const starElements = await page.$$('[class*="star"], [class*="Star"], svg[class*="rating"]').catch(() => []);
          this.logger.debug(`Found ${starElements.length} star elements, ${reviewElements.length} review elements on profile page`);
        }

        this.logger.log(`Scraped renter ${renterUserId}: rating=${averageRating}, reviews=${reviewCount}, details=${reviews.length}`);

        return { averageRating, reviewCount, reviews };
      } finally {
        await page.close();
      }
    } catch (error) {
      this.logger.warn(`scrapeRenterReviews failed for user ${renterUserId}: ${error.message}`);
      return { reviews: [] };
    }
  }
}
