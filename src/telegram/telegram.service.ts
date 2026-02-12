import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TelegramBot = require('node-telegram-bot-api');
import { PrismaService } from '../prisma/prisma.service';
import { RentalScannerService } from '../rental-scanner/rental-scanner.service';
import { AiService } from '../ai/ai.service';
import { RulesService } from '../rules/rules.service';
import { MemoryService } from '../memory/memory.service';
import { CalendarService } from '../calendar/calendar.service';
import { BlacklistService } from '../blacklist/blacklist.service';
import { DemandService } from '../demand/demand.service';
import { RevenueService } from '../revenue/revenue.service';
import { DeliveryService } from '../delivery/delivery.service';
import { MarketService } from '../market/market.service';
import { HyggloService } from '../hygglo/hygglo.service';
import { ErrorLogService } from '../monitoring/error-log.service';
import { DspyService } from '../dspy/dspy.service';
import { ValidationService } from '../validation/validation.service';
import { RepairService } from '../validation/repair.service';
import { QualityScorerService } from '../evaluation/quality-scorer.service';
import { ConversationStageService } from '../conversation-tree/conversation-stage.service';
import { RecommendationService } from '../recommendations/recommendation.service';
import { getInventoryItemNames, findBestMatch } from '../utils/item-matcher';
import { AutolearnService } from '../autolearn/autolearn.service';
import { CorrectionDetectorService } from '../autolearn/correction-detector.service';
import { HyggloAccount } from '../hygglo/hygglo.service';
import { LostRevenueService } from '../lost-revenue/lost-revenue.service';

// --- Consolidated rental notification types ---
export type RentalSectionType =
  | 'new_rental' | 'message_processed' | 'message_blocked' | 'quality_alert'
  | 'availability_conflict' | 'same_day_block' | 'verification_block'
  | 'review_block' | 'availability_block' | 'auto_accept_failed'
  | 'blacklist' | 'scam' | 'damage' | 'verification_failure'
  | 'pipeline_error' | 'info';

export interface RentalNotificationSection {
  type: RentalSectionType;
  priority: 'critical' | 'high' | 'normal';
  data: Record<string, any>;
}

export interface RentalNotificationMeta {
  rentalTitle?: string;
  renterName?: string;
  account?: string;
  profit?: string;
  startDate?: Date;
  endDate?: Date;
  days?: number;
}

interface RentalNotifBufferEntry {
  sections: RentalNotificationSection[];
  timer: NodeJS.Timeout;
  meta: RentalNotificationMeta;
}

export interface DecisionOption {
  label: string;
  emoji: string;
  intent: string;
  aiInstruction: string;
}

export interface DecisionPromptConfig {
  type: 'acquisition' | 'same_day' | 'cancel_reschedule' | 'escalation' | 'review_flag';
  rentalId: string;
  listingId: string;
  account: HyggloAccount;
  renterName: string;
  renterLastMessage: string;
  contextSummary: string;
  displayText: string;
  options: DecisionOption[];
  holdMessageSent: boolean;
  recommendedReply?: string;
}

interface PendingDecision {
  id: string;
  type: 'acquisition' | 'same_day' | 'cancel_reschedule' | 'escalation' | 'review_flag';
  telegramMessageId: number;
  rentalId: string;
  listingId: string;
  account: HyggloAccount;
  renterName: string;
  renterLastMessage: string;
  contextSummary: string;
  displayText: string;
  options: DecisionOption[];
  createdAt: number;
  resolved: boolean;
  holdMessageSent: boolean;
  recommendedReply?: string;
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: any;
  private ownerChatId: string;
  private simulationMode: { active: boolean; account: 'dbcinema' | 'leo' | null } = {
    active: false,
    account: null,
  };
  private simConversationHistory: { role: 'user' | 'assistant'; content: string }[] = [];
  private improvementMode = false;
  private recentRentalNotifications = new Map<number, number>(); // rental id → timestamp for dedup
  private readonly NOTIFICATION_DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minute dedup window

  // --- Centralized notification dedup & rate limiting ---
  private sentNotificationHashes = new Map<string, { ts: number; text: string }>(); // hash → { timestamp, preview }
  private lastNotificationSentAt = 0;
  private notificationsThisMinute = 0;
  private minuteWindowStart = 0;
  private readonly NOTIF_DEDUP_WINDOW_MS = 30 * 60 * 1000; // suppress identical notifications for 30 min
  private readonly NOTIF_MIN_INTERVAL_MS = 1500; // min 1.5s between sends
  private readonly NOTIF_MAX_PER_MINUTE = 5; // max 5 notifications per minute

  // --- Consolidated rental notification buffer ---
  private rentalNotifBuffer = new Map<string, RentalNotifBufferEntry>();
  private readonly RENTAL_NOTIF_BUFFER_MS = 3000;

  // --- Dashboard activity log (ring buffer) ---
  private activityLog: Array<{
    id: number;
    timestamp: string;
    type: RentalSectionType;
    priority: 'critical' | 'high' | 'normal';
    rentalTitle?: string;
    renterName?: string;
    account?: string;
    summary: string;
  }> = [];
  private activityLogCounter = 0;
  private readonly ACTIVITY_LOG_MAX = 200;

  // --- Interactive decision system ---
  private pendingDecisions = new Map<string, PendingDecision>();
  private awaitingCustomReply = new Map<string, string>(); // ownerChatId → decisionId
  private decisionCounter = 0;
  private readonly DECISION_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours

  // Unified renter chat state (replaces separate renter bot)
  private renterChatHistories = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();
  private renterChatAccounts = new Map<string, 'dbcinema' | 'leo'>();
  private renterImprovementModes = new Set<string>(); // chat IDs in improvement mode

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    @Inject(forwardRef(() => RentalScannerService)) private rentalScannerService: RentalScannerService,
    private aiService: AiService,
    private rulesService: RulesService,
    private memoryService: MemoryService,
    private calendarService: CalendarService,
    private blacklistService: BlacklistService,
    private demandService: DemandService,
    private revenueService: RevenueService,
    private deliveryService: DeliveryService,
    @Inject(forwardRef(() => MarketService)) private marketService: MarketService,
    private hyggloService: HyggloService,
    private errorLogService: ErrorLogService,
    private dspyService: DspyService,
    private validationService: ValidationService,
    private repairService: RepairService,
    private qualityScorerService: QualityScorerService,
    private conversationStageService: ConversationStageService,
    private recommendationService: RecommendationService,
    @Inject(forwardRef(() => AutolearnService)) private autolearnService: AutolearnService,
    @Inject(forwardRef(() => CorrectionDetectorService)) private correctionDetector: CorrectionDetectorService,
    private lostRevenueService: LostRevenueService,
  ) {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
    }
    // Start without polling — will enable after clearing stale connections in onModuleInit
    this.bot = new TelegramBot(token, { polling: false });
    this.ownerChatId = this.configService.get<string>('OWNER_CHAT_ID') || '6634478551';
  }

  private isOwner(chatId: number | string): boolean {
    return String(chatId) === this.ownerChatId;
  }

  async onModuleInit() {
    // Clear any stale webhook/polling before starting — prevents 409 conflict
    try {
      await this.bot.deleteWebHook({ drop_pending_updates: false });
      this.logger.log('Cleared stale webhook — starting clean polling');
    } catch (err) {
      this.logger.warn(`Failed to clear webhook: ${err.message}`);
    }

    // Wait for previous instance's polling connection to fully expire
    // This prevents 409 restart loops that kill the systemd service
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Start polling with retry — if 409 persists, wait and retry up to 5 times
    let pollingStarted = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.bot.startPolling();
        pollingStarted = true;
        break;
      } catch (err) {
        if (err.message?.includes('409') && attempt < 5) {
          this.logger.warn(`Telegram 409 on startup attempt ${attempt}/5 — waiting ${attempt * 3}s for previous instance to release...`);
          await new Promise(resolve => setTimeout(resolve, attempt * 3000));
        } else {
          throw err;
        }
      }
    }
    if (!pollingStarted) {
      this.logger.error('Failed to start Telegram polling after 5 attempts');
      return;
    }

    this.bot.on('polling_error', (err: any) => {
      // Suppress 409 Conflict logs — they're transient during restart
      if (err.message?.includes('409')) {
        this.logger.warn('Telegram 409 conflict — another instance may be stopping. Will retry.');
        return;
      }
      this.logger.error('Telegram polling error: ' + err.message);
      this.errorLogService.captureError(new Error(`Telegram polling error: ${err.message}`), {
        operation: 'telegram_polling',
      });
    });

    this.bot.on('message', (msg: any) => {
      this.logger.log(`Incoming message: "${msg.text}" from chat ${msg.chat.id}`);
    });

    this.registerCommands();
    this.registerConversationHandler();

    // Interactive decision system: handle inline keyboard button presses
    this.bot.on('callback_query', (query: any) => this.handleCallbackQuery(query));

    // Cleanup expired decisions every 30 minutes
    setInterval(() => this.cleanupExpiredDecisions(), 30 * 60 * 1000);

    this.logger.log('Telegram bot is polling for updates (unified: owner + renter)');
  }

  async onModuleDestroy() {
    await this.bot.stopPolling();
  }

  // --- Proactive messaging for autonomous pipeline ---

  /**
   * Hash notification text for dedup. Normalizes by stripping emojis, markdown,
   * collapsing whitespace, and taking the first 200 chars.
   */
  private hashNotification(text: string): string {
    const normalized = text
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{2B55}\u{FE00}-\u{FE0F}\u{200D}]/gu, '') // strip emojis
      .replace(/[*_`\[\]\\]/g, '') // strip markdown formatting
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  /**
   * Cleanup stale entries from the notification dedup map.
   */
  private cleanupNotificationHashes(): void {
    if (this.sentNotificationHashes.size < 50) return;
    const cutoff = Date.now() - this.NOTIF_DEDUP_WINDOW_MS;
    for (const [key, entry] of this.sentNotificationHashes) {
      if (entry.ts < cutoff) this.sentNotificationHashes.delete(key);
    }
  }

  /**
   * Central notification gateway. ALL owner notifications pass through here.
   * Provides: content-hash dedup (30 min window) + rate limiting (5/min, 1.5s spacing).
   * Pass force=true for critical alerts (scam, damage, blacklist) that must never be suppressed.
   */
  async sendProactiveMessage(text: string, parseMode = 'Markdown', options?: { force?: boolean }) {
    // --- Content-hash dedup ---
    if (!options?.force) {
      const hash = this.hashNotification(text);
      const existing = this.sentNotificationHashes.get(hash);
      if (existing && Date.now() - existing.ts < this.NOTIF_DEDUP_WINDOW_MS) {
        this.logger.debug(
          `[NotifGateway] SUPPRESSED duplicate (sent ${Math.round((Date.now() - existing.ts) / 1000)}s ago): ${text.substring(0, 80)}...`,
        );
        return;
      }
      this.sentNotificationHashes.set(hash, { ts: Date.now(), text: text.substring(0, 100) });
      this.cleanupNotificationHashes();
    }

    // --- Per-minute rate limiting ---
    const now = Date.now();
    if (now - this.minuteWindowStart > 60_000) {
      this.minuteWindowStart = now;
      this.notificationsThisMinute = 0;
    }
    if (!options?.force && this.notificationsThisMinute >= this.NOTIF_MAX_PER_MINUTE) {
      this.logger.warn(
        `[NotifGateway] RATE LIMITED (${this.notificationsThisMinute}/${this.NOTIF_MAX_PER_MINUTE} this minute): ${text.substring(0, 80)}...`,
      );
      return;
    }

    // --- Min interval spacing ---
    const elapsed = now - this.lastNotificationSentAt;
    if (elapsed < this.NOTIF_MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, this.NOTIF_MIN_INTERVAL_MS - elapsed));
    }

    // --- Send ---
    try {
      await this.bot.sendMessage(this.ownerChatId, text, { parse_mode: parseMode });
      this.lastNotificationSentAt = Date.now();
      this.notificationsThisMinute++;
    } catch (error) {
      // Retry without Markdown if parsing failed
      if (error.message?.includes("can't parse entities")) {
        this.logger.warn('Markdown parse failed, retrying as plain text');
        const plain = text.replace(/[*_`\[]/g, '');
        await this.bot.sendMessage(this.ownerChatId, plain);
        this.lastNotificationSentAt = Date.now();
        this.notificationsThisMinute++;
        return;
      }
      this.logger.error(`Failed to send proactive message: ${error.message}`);
      this.errorLogService.captureError(error, { operation: 'telegram_proactive_message' });
      throw error;
    }
  }

  async sendRentalNotification(rental: any, _aiAnalysis: string, _actionTaken: string) {
    // Dedup guard: prevent duplicate notifications for the same rental
    const rentalId = rental.id;
    if (rentalId) {
      const lastSent = this.recentRentalNotifications.get(rentalId);
      if (lastSent && Date.now() - lastSent < this.NOTIFICATION_DEDUP_TTL_MS) {
        this.logger.warn(`Skipping duplicate rental notification for rental id=${rentalId} (${rental.title}) — sent ${Math.round((Date.now() - lastSent) / 1000)}s ago`);
        return;
      }
      this.recentRentalNotifications.set(rentalId, Date.now());

      // Cleanup stale entries
      if (this.recentRentalNotifications.size > 100) {
        const cutoff = Date.now() - this.NOTIFICATION_DEDUP_TTL_MS;
        for (const [key, ts] of this.recentRentalNotifications) {
          if (ts < cutoff) this.recentRentalNotifications.delete(key);
        }
      }
    }

    const meta = await this.buildRentalMeta(rental);

    await this.sendRentalUpdate(
      rental.id || rental.listing_id,
      { type: 'new_rental', priority: 'normal', data: {} },
      meta,
    );
  }

  /**
   * Build standard rental metadata (profit, dates, account) for consolidated notifications.
   * Profit = owner earnings after platform fees. Estimated from catalog if no booking yet.
   */
  async buildRentalMeta(rental: any): Promise<RentalNotificationMeta> {
    const curr = rental.currency === 'SEK' ? 'kr' : '£';
    let profitStr: string | undefined;
    try {
      const bookingRevenue = await this.prisma.booking.aggregate({
        where: { rental_id: rental.id, status: { in: ['confirmed', 'pending_review'] } },
        _sum: { revenue: true },
      });
      if (bookingRevenue._sum.revenue) {
        profitStr = `${curr}${bookingRevenue._sum.revenue}`;
      } else {
        // No booking yet — estimate profit from rental_price or extracted items
        const rentalPrice = rental.rental_price || rental.rentalPrice;
        if (rentalPrice) {
          profitStr = `~${curr}${Math.round(rentalPrice * 0.64)}`;
        } else {
          // Estimate from extracted items (1-day catalog price × 64%)
          profitStr = await this.estimateProfitFromItems(rental.id, curr);
        }
      }
    } catch {
      const rentalPrice = rental.rental_price || rental.rentalPrice;
      if (rentalPrice) profitStr = `~${curr}${Math.round(rentalPrice * 0.64)}`;
    }

    // Hygglo dates are INCLUSIVE (both start and end are rental days): days = diff + 1
    const days = rental.start_date && rental.end_date
      ? Math.max(1, Math.round((new Date(rental.end_date).getTime() - new Date(rental.start_date).getTime()) / (1000 * 60 * 60 * 24)) + 1)
      : 0;

    return {
      rentalTitle: rental.title,
      renterName: rental.renter_info || undefined,
      account: rental.account,
      profit: profitStr,
      startDate: rental.start_date ? new Date(rental.start_date) : undefined,
      endDate: rental.end_date ? new Date(rental.end_date) : undefined,
      days: days || undefined,
    };
  }

  /**
   * Estimate profit from extracted items when no booking/price exists yet.
   * Uses 1-day catalog price × ~64% (after platform fees).
   */
  private async estimateProfitFromItems(rentalId: string, curr: string): Promise<string | undefined> {
    try {
      const items = await this.prisma.extracteditem.findMany({
        where: { rental_id: rentalId },
        select: { item_name: true },
      });
      if (items.length === 0) return undefined;

      const { PRICING_CATALOG } = await import('../data/pricing-catalog.js');
      let total = 0;
      for (const item of items) {
        const entry = PRICING_CATALOG.find((p: any) => p.item_name.toLowerCase() === item.item_name.toLowerCase());
        total += entry ? entry.daily_price_max : 25;
      }
      const profit = Math.round(total * 0.64);
      return `~${curr}${profit}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Structured rental notification API. Buffers sections for 3s and sends ONE consolidated message.
   * Critical-priority sections (blacklist, scam) bypass buffer and send immediately.
   */
  async sendRentalUpdate(
    rentalId: string | number,
    section: RentalNotificationSection,
    meta?: RentalNotificationMeta,
  ): Promise<void> {
    const key = String(rentalId);

    // Record to activity log for dashboard
    this.recordActivity(section, meta);

    // Critical → flush any pending buffer, then send standalone immediately
    if (section.priority === 'critical') {
      // Flush existing buffer first so ordering is preserved
      if (this.rentalNotifBuffer.has(key)) {
        await this.flushRentalBuffer(key);
      }
      const standalone: RentalNotifBufferEntry = {
        sections: [section],
        timer: null as any,
        meta: meta || {},
      };
      const text = this.formatConsolidatedNotification(standalone);
      await this.sendProactiveMessage(text, 'Markdown', { force: true });
      return;
    }

    // Normal/high → add to buffer
    const existing = this.rentalNotifBuffer.get(key);
    if (existing) {
      existing.sections.push(section);
      // Merge meta (don't overwrite existing values with undefined)
      if (meta) {
        for (const [k, v] of Object.entries(meta)) {
          if (v !== undefined && !(existing.meta as any)[k]) {
            (existing.meta as any)[k] = v;
          }
        }
      }
    } else {
      // First section for this rental — start timer (timer is NOT reset on subsequent sections)
      const timer = setTimeout(() => this.flushRentalBuffer(key), this.RENTAL_NOTIF_BUFFER_MS);
      this.rentalNotifBuffer.set(key, {
        sections: [section],
        timer,
        meta: meta || {},
      });
    }
  }

  /**
   * Flush buffered sections for a rental into one consolidated Telegram message.
   */
  private async flushRentalBuffer(key: string): Promise<void> {
    const entry = this.rentalNotifBuffer.get(key);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.rentalNotifBuffer.delete(key);

    if (entry.sections.length === 0) return;

    const text = this.formatConsolidatedNotification(entry);
    await this.sendProactiveMessage(text, 'Markdown');
  }

  /**
   * Record an activity event to the in-memory ring buffer for the dashboard.
   */
  private recordActivity(section: RentalNotificationSection, meta?: RentalNotificationMeta): void {
    const summaryMap: Partial<Record<RentalSectionType, (d: Record<string, any>) => string>> = {
      new_rental: () => 'New rental request',
      message_processed: (d) => d.renterMsg ? `"${String(d.renterMsg).substring(0, 60)}"` : 'Message processed',
      message_blocked: (d) => `Blocked: ${d.violations || 'policy violation'}`,
      quality_alert: (d) => `Quality ${d.score || '?'} — ${d.details || 'review needed'}`,
      availability_conflict: (d) => `Overbooked: ${d.overbookedItems || d.item || '?'}`,
      same_day_block: () => 'Same-day — manual approval needed',
      verification_block: (d) => `Verification: ${d.status || 'pending'}`,
      review_block: () => 'Review escalation — manual review',
      availability_block: (d) => `${d.item || 'Item'} unavailable`,
      auto_accept_failed: (d) => `Auto-accept failed: ${d.error || '?'}`,
      blacklist: (d) => `BLACKLIST: ${d.entry || d.reason || '?'}`,
      scam: (d) => `SCAM: ${d.pattern || '?'} (${d.score || '?'})`,
      damage: (d) => `Damage: ${d.score || '?'}% — ${d.issues || '?'}`,
      verification_failure: (d) => `Verification failed ${d.count || '?'}x`,
      pipeline_error: (d) => `Error: ${d.error || d.message || '?'}`,
      info: (d) => d.text || 'Info',
    };

    const summarizer = summaryMap[section.type];
    const summary = summarizer ? summarizer(section.data) : section.type;

    this.activityLog.push({
      id: ++this.activityLogCounter,
      timestamp: new Date().toISOString(),
      type: section.type,
      priority: section.priority,
      rentalTitle: meta?.rentalTitle,
      renterName: meta?.renterName,
      account: meta?.account,
      summary,
    });

    // Trim to max size
    if (this.activityLog.length > this.ACTIVITY_LOG_MAX) {
      this.activityLog = this.activityLog.slice(-this.ACTIVITY_LOG_MAX);
    }
  }

  /**
   * Get recent activity entries for the dashboard.
   */
  getRecentActivity(limit = 50, account?: string): typeof this.activityLog {
    let log = this.activityLog;
    if (account) {
      log = log.filter(e => e.account === account);
    }
    return log.slice(-limit).reverse();
  }

  /**
   * Render buffered sections into a single formatted notification.
   */
  private formatConsolidatedNotification(entry: RentalNotifBufferEntry): string {
    const m = entry.meta;
    const lines: string[] = [];

    // --- Header ---
    const accountLabel = this.getAccountLabel(m.account);
    const accountTag = accountLabel ? `[${accountLabel}] ` : '';
    const title = m.rentalTitle || 'Unknown';
    lines.push(`📦 ${accountTag}${title}`);

    // Second header line: renter · profit · dates
    const headerParts: string[] = [];
    if (m.renterName) headerParts.push(`👤 ${m.renterName}`);
    if (m.profit) headerParts.push(`💰 ${m.profit}`);
    if (m.startDate && m.endDate) {
      const fmt = (d: Date) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const days = m.days || Math.max(1, Math.round((new Date(m.endDate).getTime() - new Date(m.startDate).getTime()) / (1000 * 60 * 60 * 24)) + 1);
      headerParts.push(`📅 ${fmt(m.startDate)}–${fmt(m.endDate)} (${days}d)`);
    }
    if (headerParts.length > 0) lines.push(headerParts.join(' · '));

    lines.push(''); // blank line after header

    // --- Sort sections by display priority ---
    const displayOrder: Record<RentalSectionType, number> = {
      new_rental: 0, message_processed: 1, message_blocked: 2, quality_alert: 3,
      same_day_block: 4, availability_conflict: 5, availability_block: 6,
      verification_block: 7, review_block: 8, auto_accept_failed: 9,
      pipeline_error: 10, verification_failure: 11, damage: 12, info: 13,
      blacklist: 14, scam: 15,
    };
    const sorted = [...entry.sections].sort((a, b) => (displayOrder[a.type] ?? 99) - (displayOrder[b.type] ?? 99));

    for (const s of sorted) {
      const d = s.data;
      switch (s.type) {
        case 'new_rental':
          // Header already covers this — only add extra info if present
          if (d.extraInfo) lines.push(`ℹ️ ${d.extraInfo}`);
          break;

        case 'message_processed': {
          const msg = d.renterMsg ? `"${String(d.renterMsg).substring(0, 300)}${String(d.renterMsg).length > 300 ? '...' : ''}"` : '';
          const reply = d.botReply ? String(d.botReply).substring(0, 500) : '';
          if (msg) lines.push(`💬 ${msg}`);
          if (reply) lines.push(`🤖 ${reply}${String(d.botReply || '').length > 500 ? '...' : ''}${d.status ? '\n📋 ' + d.status : ''}`);
          break;
        }

        case 'message_blocked': {
          const msg = d.renterMsg ? `"${String(d.renterMsg).substring(0, 300)}${String(d.renterMsg).length > 300 ? '...' : ''}"` : '';
          if (msg) lines.push(`💬 ${msg}`);
          lines.push(`🚫 Response BLOCKED: ${d.violations || 'validation failed'}`);
          if (d.botReply) lines.push(`🤖 Blocked: "${String(d.botReply).substring(0, 500)}${String(d.botReply).length > 500 ? '...' : ''}"`);
          lines.push(`↪️ Reply manually`);
          break;
        }

        case 'quality_alert': {
          const msg = d.renterMsg ? `"${String(d.renterMsg).substring(0, 300)}${String(d.renterMsg).length > 300 ? '...' : ''}"` : '';
          if (msg) lines.push(`💬 ${msg}`);
          const scoreStr = d.qualityScore?.overallQuality != null
            ? ` ${(d.qualityScore.overallQuality as number).toFixed(2)}`
            : '';
          const details = d.qualityDetails || '';
          lines.push(`⚠️ Quality${scoreStr}${details ? ' (' + details + ')' : ''}`);
          if (d.botReply) lines.push(`🤖 "${String(d.botReply).substring(0, 500)}${String(d.botReply).length > 500 ? '...' : ''}"`);
          if (d.status) lines.push(`↪️ ${d.status}`);
          break;
        }

        case 'availability_conflict':
          if (Array.isArray(d.overbookedItems)) {
            for (const item of d.overbookedItems) {
              lines.push(`🚨 OVERBOOKED: ${item.item_name} ${item.maxQuantity - item.availableSlots}/${item.maxQuantity} booked`);
            }
          } else {
            lines.push(`🚨 OVERBOOKED — manual review needed`);
          }
          break;

        case 'same_day_block':
          lines.push(`⏰ Same-day — needs manual approval`);
          break;

        case 'verification_block':
          lines.push(`🔐 Verification: ${d.status || 'incomplete'} — auto-accept blocked`);
          break;

        case 'review_block':
          lines.push(`⚠️ Review escalation — manual review needed`);
          break;

        case 'availability_block':
          lines.push(`❌ ${d.itemName || 'Item'} unavailable — auto-accept blocked`);
          break;

        case 'auto_accept_failed':
          lines.push(`❌ Auto-accept failed: ${d.error || 'unknown'} — accept manually`);
          break;

        case 'pipeline_error':
          lines.push(`❌ Pipeline error: ${d.error || 'unknown'}`);
          break;

        case 'verification_failure':
          lines.push(`⚠️ Verification failed ${d.attemptCount || '?'}x — alternatives sent`);
          break;

        case 'damage': {
          const score = d.damageScore != null ? `${(d.damageScore * 100).toFixed(0)}%` : '?';
          const issues = d.issues || d.detected_issues?.join(', ') || 'General wear';
          lines.push(`📸 Damage: ${score} — ${issues}`);
          if (d.severity) lines.push(`├ Severity: ${d.severity.toUpperCase()}`);
          if (d.damageCharge) lines.push(`├ Recommended charge: £${d.damageCharge}`);
          if (d.recommendation) lines.push(`├ ${String(d.recommendation).substring(0, 150)}`);
          if (d.checkoutScore != null && d.returnScore != null) {
            lines.push(`├ Checkout: ${(d.checkoutScore * 100).toFixed(0)}% → Return: ${(d.returnScore * 100).toFixed(0)}%`);
          }
          break;
        }

        case 'blacklist':
          lines.push(`🚫 BLACKLIST MATCH`);
          if (d.matchedEntry) lines.push(`⚠️ Matched: ${d.matchedEntry}${d.reason ? ' — ' + d.reason : ''}`);
          lines.push(`Polite decline sent`);
          break;

        case 'scam': {
          const label = d.severity === 'confirmed_scam' ? '🚨 CONFIRMED SCAM'
            : d.severity === 'likely_scam' ? '🚨 LIKELY SCAM'
            : '⚠️ Suspicious';
          lines.push(`${label} (score: ${d.score || '?'})`);
          if (d.pattern) lines.push(`🔍 Pattern: ${d.pattern}`);
          if (d.message) lines.push(`💬 "${String(d.message).substring(0, 120)}"`);
          if (d.action) lines.push(`↪️ ${d.action}`);
          break;
        }

        case 'info':
          lines.push(`ℹ️ ${d.text || ''}`);
          break;
      }
    }

    return lines.join('\n');
  }

  private getAccountLabel(account?: string): string {
    if (!account) return '';
    if (account === 'dbcinema') return 'DB Cinema';
    if (account === 'leo') return 'Leo Adams';
    return account;
  }

  // --- Interactive Decision System ---

  /**
   * Send an interactive decision prompt to the owner with inline keyboard buttons.
   * Returns the decision ID for tracking.
   */
  async sendDecisionPrompt(config: DecisionPromptConfig): Promise<string> {
    const id = `D${++this.decisionCounter}`;

    // Build inline keyboard rows: option buttons + custom reply button
    const optionButtons = config.options.map((opt, idx) => ({
      text: `${opt.emoji} ${opt.label}`,
      callback_data: `dec:${id}:${idx}`,
    }));

    // Split into rows of 2 buttons max for readability
    const rows: any[][] = [];
    for (let i = 0; i < optionButtons.length; i += 2) {
      rows.push(optionButtons.slice(i, i + 2));
    }
    // Recommended reply button (if pre-drafted reply available)
    if (config.recommendedReply) {
      const truncated = config.recommendedReply.length > 50
        ? config.recommendedReply.substring(0, 47) + '...'
        : config.recommendedReply;
      rows.push([{ text: `\ud83d\udca1 "${truncated}"`, callback_data: `dec:${id}:recommended` }]);
    }
    rows.push([{ text: '\u270d\ufe0f Custom reply', callback_data: `dec:${id}:custom` }]);

    // Append recommended reply preview to the display text
    const fullDisplayText = config.recommendedReply
      ? `${config.displayText}\n\n\ud83d\udca1 *Recommended reply:*\n"${config.recommendedReply.substring(0, 300)}${config.recommendedReply.length > 300 ? '...' : ''}"`
      : config.displayText;

    let sentMessageId: number;
    try {
      const sent = await this.bot.sendMessage(this.ownerChatId, fullDisplayText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      });
      sentMessageId = sent.message_id;
    } catch (error) {
      // Retry without Markdown if parsing failed
      if (error.message?.includes("can't parse entities")) {
        this.logger.warn('Decision prompt Markdown parse failed, retrying as plain text');
        const plain = fullDisplayText.replace(/[*_`\[]/g, '');
        const sent = await this.bot.sendMessage(this.ownerChatId, plain, {
          reply_markup: { inline_keyboard: rows },
        });
        sentMessageId = sent.message_id;
      } else {
        this.logger.error(`Failed to send decision prompt: ${error.message}`);
        // Fall back to plain notification
        await this.sendProactiveMessage(config.displayText, 'Markdown', { force: true });
        return id;
      }
    }

    const decision: PendingDecision = {
      id,
      type: config.type,
      telegramMessageId: sentMessageId,
      rentalId: config.rentalId,
      listingId: config.listingId,
      account: config.account,
      renterName: config.renterName,
      renterLastMessage: config.renterLastMessage,
      contextSummary: config.contextSummary,
      displayText: config.displayText,
      options: config.options,
      createdAt: Date.now(),
      resolved: false,
      holdMessageSent: config.holdMessageSent,
      recommendedReply: config.recommendedReply,
    };

    this.pendingDecisions.set(id, decision);
    this.logger.log(`Decision prompt ${id} sent: ${config.type} for rental ${config.rentalId}`);
    return id;
  }

  /**
   * Handle Telegram inline keyboard callback queries for decision buttons.
   */
  private async handleCallbackQuery(query: any): Promise<void> {
    const data = query.data;
    if (!data?.startsWith('dec:')) return;

    // Always acknowledge the callback immediately
    try {
      await this.bot.answerCallbackQuery(query.id);
    } catch {
      // Best-effort acknowledgment
    }

    const parts = data.split(':');
    if (parts.length < 3) return;

    const decisionId = parts[1];
    const optionPart = parts[2];
    const decision = this.pendingDecisions.get(decisionId);

    if (!decision) {
      try {
        await this.bot.answerCallbackQuery(query.id, { text: 'Decision expired or not found', show_alert: true });
      } catch { /* already answered */ }
      return;
    }

    if (decision.resolved) {
      try {
        await this.bot.answerCallbackQuery(query.id, { text: 'Already resolved', show_alert: true });
      } catch { /* already answered */ }
      return;
    }

    if (optionPart === 'custom') {
      // Enter custom reply mode
      this.awaitingCustomReply.set(this.ownerChatId, decisionId);
      await this.bot.sendMessage(this.ownerChatId, `Type your reply for ${decision.renterName}. Send /cancel_reply to abort.`);
      return;
    }

    if (optionPart === 'recommended' && decision.recommendedReply) {
      // Send pre-drafted recommended reply directly (no AI polishing)
      decision.resolved = true;
      const recOption: DecisionOption = { label: 'Recommended reply', emoji: '\ud83d\udca1', intent: 'recommended', aiInstruction: '' };
      await this.resolveDecision(decision, recOption, decision.recommendedReply, true);
      return;
    }

    const optionIndex = parseInt(optionPart, 10);
    if (isNaN(optionIndex) || optionIndex < 0 || optionIndex >= decision.options.length) return;

    decision.resolved = true;
    await this.resolveDecision(decision, decision.options[optionIndex]);
  }

  /**
   * Resolve a decision: AI-filter Daniel's intent, send polished response to renter via Hygglo.
   */
  private async resolveDecision(
    decision: PendingDecision,
    chosenOption: DecisionOption,
    customText?: string,
    skipPolish?: boolean,
  ): Promise<void> {
    const resolveLabel = customText
      ? `Custom: "${customText.substring(0, 50)}${customText.length > 50 ? '...' : ''}"`
      : `${chosenOption.emoji} ${chosenOption.label}`;

    try {
      // Edit the original message to show resolution + remove keyboard
      const updatedText = `${decision.displayText}\n\n\u2705 *Resolved:* ${resolveLabel}`;
      try {
        await this.bot.editMessageText(updatedText, {
          chat_id: this.ownerChatId,
          message_id: decision.telegramMessageId,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [] },
        });
      } catch (editErr) {
        // Fallback: try without Markdown
        try {
          const plain = updatedText.replace(/[*_`\[]/g, '');
          await this.bot.editMessageText(plain, {
            chat_id: this.ownerChatId,
            message_id: decision.telegramMessageId,
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          this.logger.warn(`Failed to edit decision message: ${editErr.message}`);
        }
      }

      // "ignore" intent: skip Hygglo send, just log
      if (chosenOption.intent === 'ignore') {
        this.logger.log(`Decision ${decision.id} resolved as IGNORE — no message sent to renter`);
        await this.logDecision(decision, chosenOption, 'Ignored — no message sent', customText);
        return;
      }

      const chatId = `hygglo_${decision.listingId}`;
      let replyText: string;

      if (skipPolish && customText) {
        // Recommended reply: send pre-drafted text directly, no AI polishing
        replyText = customText;
      } else {
        // Build AI instruction for polishing Daniel's intent into a customer-friendly reply
        const aiInstruction = customText
          ? `Daniel wants to reply with this message to the renter: "${customText}". Polish it into a warm, professional response. Keep Daniel's intent and key details. Do NOT add new information or promises.`
          : chosenOption.aiInstruction;

        // Load conversation history for context
        const conversationHistory = await this.memoryService.getConversationHistory(chatId, 6);
        const rules = await this.rulesService.getCompactRules();

        // AI polish the response
        const response = await this.aiService.processRoutine(
          `DECISION CONTEXT: ${decision.contextSummary}\n\nRenter's last message: "${decision.renterLastMessage}"\n\nINSTRUCTION: ${aiInstruction}\n\nWrite ONLY the message to send to the renter. No preamble, no explanation.`,
          {
            rules,
            conversationHistory,
            additionalContext: `You are responding as ${decision.account === 'leo' ? 'Leo Adams' : 'DB Cinema Rentals'}. Be warm, professional, concise. This is a direct reply to the renter on Hygglo.`,
            maxTokens: 256,
          },
        );

        // Clean up response — strip any AI preamble
        replyText = response.content.trim();
        replyText = replyText.replace(/^(here'?s?\s+(the|a|my)\s+(message|response|reply)[:\s]*)/i, '').trim();
      }

      // Send to renter via Hygglo
      let sent = false;
      try {
        sent = await this.hyggloService.sendMessage(decision.listingId, replyText);
      } catch (sendErr) {
        this.logger.warn(`Failed to send decision reply via Hygglo: ${sendErr.message}`);
      }

      // Store in conversation history
      if (sent) {
        await this.memoryService.storeConversation(chatId, 'assistant', replyText, { model: 'system' });
      }

      const actionTaken = sent
        ? `Sent to renter: "${replyText.substring(0, 100)}..."`
        : `Failed to send to renter`;

      // Confirm to Daniel
      const confirmEmoji = sent ? '\u2705' : '\u274c';
      await this.bot.sendMessage(
        this.ownerChatId,
        `${confirmEmoji} *Sent to ${decision.renterName}:*\n${replyText}`,
        { parse_mode: 'Markdown' },
      ).catch(() => {
        // Retry without markdown
        this.bot.sendMessage(
          this.ownerChatId,
          `${confirmEmoji} Sent to ${decision.renterName}:\n${replyText}`,
        ).catch(() => {});
      });

      await this.logDecision(decision, chosenOption, actionTaken, customText);

      // Store decision context as notes on calendar bookings
      if (chosenOption.intent !== 'ignore' && decision.rentalId) {
        const noteText = customText
          ? `Owner approved: ${customText}`
          : `Owner approved: ${chosenOption.label}`;
        try {
          await this.calendarService.addDecisionNotesToBookings(decision.rentalId, noteText);
        } catch (noteErr) {
          this.logger.warn(`Failed to add decision notes to bookings: ${noteErr.message}`);
        }
      }

      // review_flag: handle post-resolution actions
      if (decision.type === 'review_flag' && decision.rentalId) {
        try {
          if (chosenOption.intent === 'accept_low_rating') {
            // Clear escalation record so auto-accept can proceed
            await this.prisma.ai_decision.deleteMany({
              where: {
                rental_id: decision.rentalId,
                decision_type: 'escalate',
                action_taken: 'review_escalation',
              },
            });
            // Re-enable auto-accept on follow_up_state
            await this.prisma.follow_up_state.updateMany({
              where: { rental_id: decision.rentalId },
              data: { auto_accept_eligible: true },
            });
            this.logger.log(`Review flag accepted for rental ${decision.rentalId} — escalation cleared, auto-accept re-enabled`);
          } else if (chosenOption.intent === 'decline') {
            // Mark rental as declined
            await this.prisma.follow_up_state.updateMany({
              where: { rental_id: decision.rentalId },
              data: { status: 'declined', auto_accept_eligible: false },
            });
            this.logger.log(`Review flag declined for rental ${decision.rentalId}`);
          }
          // 'ignore' intent = "Wait & monitor" — keep escalation in place, auto-accept stays blocked
        } catch (reviewResErr) {
          this.logger.warn(`Failed to process review_flag resolution: ${reviewResErr.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to resolve decision ${decision.id}: ${error.message}`);
      await this.bot.sendMessage(
        this.ownerChatId,
        `Failed to process decision: ${error.message}. You may need to reply manually on Hygglo.`,
      ).catch(() => {});
    }
  }

  /**
   * Log a decision resolution to the ai_decision table.
   */
  private async logDecision(
    decision: PendingDecision,
    chosenOption: DecisionOption,
    actionTaken: string,
    customText?: string,
  ): Promise<void> {
    try {
      await this.prisma.ai_decision.create({
        data: {
          rental_id: decision.rentalId || null,
          decision_type: 'owner_decision',
          input_summary: `${decision.type}: ${decision.contextSummary.substring(0, 200)}`,
          output_summary: customText
            ? `Custom reply: "${customText.substring(0, 200)}"`
            : `Chose: ${chosenOption.emoji} ${chosenOption.label} (${chosenOption.intent})`,
          confidence: 1.0,
          action_taken: actionTaken,
          notified: true,
          was_sent: chosenOption.intent !== 'ignore',
        },
      });
    } catch (logErr) {
      this.logger.warn(`Failed to log decision: ${logErr.message}`);
    }
  }

  /**
   * Cleanup expired decisions — called every 30 minutes.
   */
  private cleanupExpiredDecisions(): void {
    const cutoff = Date.now() - this.DECISION_EXPIRY_MS;
    for (const [id, decision] of this.pendingDecisions) {
      if (decision.createdAt < cutoff) {
        if (!decision.resolved) {
          // Edit message to show expired
          this.bot.editMessageText(
            `${decision.displayText}\n\n\u23f0 *EXPIRED* — no action taken`,
            {
              chat_id: this.ownerChatId,
              message_id: decision.telegramMessageId,
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [] },
            },
          ).catch(() => {
            this.bot.editMessageText(
              `${decision.displayText}\n\nEXPIRED — no action taken`,
              {
                chat_id: this.ownerChatId,
                message_id: decision.telegramMessageId,
                reply_markup: { inline_keyboard: [] },
              },
            ).catch(() => {});
          });
        }
        this.pendingDecisions.delete(id);
      }
    }
    // Also clean up stale awaitingCustomReply entries
    for (const [chatId, decId] of this.awaitingCustomReply) {
      if (!this.pendingDecisions.has(decId)) {
        this.awaitingCustomReply.delete(chatId);
      }
    }
  }

  // --- Command registration ---

  private registerCommands() {
    this.bot.setMyCommands([
      { command: 'start', description: 'Welcome message' },
      { command: 'health', description: 'Service health check' },
      { command: 'status', description: 'Scanner status' },
      { command: 'stats', description: 'Rental statistics' },
      { command: 'recent', description: 'Recent rentals' },
      { command: 'items', description: 'Recently extracted items' },
      { command: 'rules', description: 'List all active rules' },
      { command: 'addrule', description: 'Add a rule: /addrule category text' },
      { command: 'removerule', description: 'Remove a rule: /removerule id' },
      { command: 'decisions', description: 'Recent AI decisions' },
      { command: 'memory', description: 'Top memories' },
      { command: 'remember', description: 'Store a memory: /remember text' },
      { command: 'forget', description: 'Delete memory: /forget id' },
      { command: 'summary', description: 'On-demand daily summary' },
      { command: 'help', description: 'Show all commands' },
      // Phase 1: Calendar + Blacklist
      { command: 'book', description: 'Book item: /book <item> <start> <end> <renter>' },
      { command: 'unbook', description: 'Cancel booking: /unbook <id>' },
      { command: 'available', description: 'Check availability: /available <item> [date]' },
      { command: 'calendar', description: 'Day schedule: /calendar [date]' },
      { command: 'blacklist', description: 'Blacklist renter: /blacklist "name" reason' },
      { command: 'unblacklist', description: 'Remove from blacklist: /unblacklist name' },
      { command: 'blacklisted', description: 'List blacklisted renters' },
      // Phase 2: Demand + Revenue
      { command: 'demand', description: 'Demand report' },
      { command: 'revenue', description: 'Profit summary: /revenue [week|month|all]' },
      { command: 'earnings', description: 'Monthly profit (alias for /revenue month)' },
      // Phase 3: Reminders + Simulator
      { command: 'today', description: "Today's schedule" },
      { command: 'simulate', description: 'Simulate renter: /simulate <dbcinema|leo>' },
      { command: 'endsim', description: 'Exit simulation mode' },
      // Phase 4: Delivery + Market
      { command: 'quote', description: 'Delivery quote: /quote <postcode> <items>' },
      { command: 'market', description: 'Market insight report' },
      // Inventory
      { command: 'inventory', description: 'Full inventory status + availability' },
      // Alpha: Auth cycle test
      { command: 'testauthcycle', description: 'Test multi-account auth cycle' },
      // Monitoring & Optimization
      { command: 'errorlog', description: 'Error monitoring status' },
      { command: 'dspy', description: 'DSPy optimization status' },
      { command: 'optimize', description: 'Run DSPy optimization: /optimize [rental|pricing|delivery]' },
      // Improvement mode
      { command: 'improve', description: 'Enter improvement mode — AI classifies each message as a rule' },
      { command: 'endimprove', description: 'Exit improvement mode' },
      // AutoLearn Engine
      { command: 'autolearn', description: 'AutoLearn status: proposals, quality trend' },
      { command: 'veto', description: 'Veto a proposal: /veto <id> [reason]' },
      { command: 'autolearn_pause', description: 'Pause AutoLearn cycles' },
      { command: 'autolearn_resume', description: 'Resume AutoLearn cycles' },
    ]);

    // Existing commands
    this.bot.onText(/\/start/, (msg: any) => this.handleStart(msg));
    this.bot.onText(/\/health/, (msg: any) => this.handleHealth(msg));
    this.bot.onText(/\/status/, (msg: any) => this.handleStatus(msg));
    this.bot.onText(/\/stats/, (msg: any) => this.handleStats(msg));
    this.bot.onText(/\/recent/, (msg: any) => this.handleRecent(msg));
    this.bot.onText(/\/items/, (msg: any) => this.handleItems(msg));
    this.bot.onText(/\/rules$/, (msg: any) => this.handleRules(msg));
    this.bot.onText(/\/addrule\s+(\S+)\s+(.+)/, (msg: any, match: any) => this.handleAddRule(msg, match));
    this.bot.onText(/\/removerule\s+(\S+)/, (msg: any, match: any) => this.handleRemoveRule(msg, match));
    this.bot.onText(/\/decisions/, (msg: any) => this.handleDecisions(msg));
    this.bot.onText(/\/memory/, (msg: any) => this.handleMemory(msg));
    this.bot.onText(/\/remember\s+(.+)/, (msg: any, match: any) => this.handleRemember(msg, match));
    this.bot.onText(/\/forget\s+(\S+)/, (msg: any, match: any) => this.handleForget(msg, match));
    this.bot.onText(/\/summary/, (msg: any) => this.handleSummary(msg));
    this.bot.onText(/\/help/, (msg: any) => this.handleHelp(msg));

    // Phase 1: Calendar commands
    this.bot.onText(/\/book\s+(.+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(.+)/, (msg: any, match: any) => this.handleBook(msg, match));
    this.bot.onText(/\/unbook\s+(\S+)/, (msg: any, match: any) => this.handleUnbook(msg, match));
    this.bot.onText(/\/available\s+(.+?)(?:\s+(\d{4}-\d{2}-\d{2}))?$/, (msg: any, match: any) => this.handleAvailable(msg, match));
    this.bot.onText(/\/calendar(?:\s+(\d{4}-\d{2}-\d{2}))?$/, (msg: any, match: any) => this.handleCalendar(msg, match));

    // Phase 1: Blacklist commands
    this.bot.onText(/\/blacklist\s+"([^"]+)"\s+(.+)/, (msg: any, match: any) => this.handleBlacklist(msg, match));
    this.bot.onText(/\/unblacklist\s+(.+)/, (msg: any, match: any) => this.handleUnblacklist(msg, match));
    this.bot.onText(/\/blacklisted$/, (msg: any) => this.handleBlacklisted(msg));

    // Phase 2: Demand + Revenue commands
    this.bot.onText(/\/demand/, (msg: any) => this.handleDemand(msg));
    this.bot.onText(/\/revenue(?:\s+(week|month|all))?$/, (msg: any, match: any) => this.handleRevenue(msg, match));
    this.bot.onText(/\/earnings/, (msg: any) => this.handleEarnings(msg));

    // Phase 3: Today + Simulator commands
    this.bot.onText(/\/today/, (msg: any) => this.handleToday(msg));
    this.bot.onText(/\/simulate\s+(dbcinema|leo)/, (msg: any, match: any) => this.handleSimulate(msg, match));
    this.bot.onText(/\/endsim/, (msg: any) => this.handleEndSim(msg));

    // Phase 4: Delivery + Market commands
    this.bot.onText(/\/quote\s+(\S+)\s+(.+)/, (msg: any, match: any) => this.handleQuote(msg, match));
    this.bot.onText(/\/market/, (msg: any) => this.handleMarket(msg));

    // Inventory
    this.bot.onText(/\/inventory/, (msg: any) => this.handleInventory(msg));

    // Alpha: Auth cycle test
    this.bot.onText(/\/testauthcycle/, (msg: any) => this.handleTestAuthCycle(msg));

    // Monitoring & Optimization
    this.bot.onText(/\/errorlog/, (msg: any) => this.handleErrorLog(msg));
    this.bot.onText(/\/dspy/, (msg: any) => this.handleDspy(msg));
    this.bot.onText(/\/optimize(?:\s+(rental|pricing|delivery))?$/, (msg: any, match: any) => this.handleOptimize(msg, match));

    // Improvement mode
    this.bot.onText(/\/improve$/, (msg: any) => this.handleImprove(msg));
    this.bot.onText(/\/endimprove/, (msg: any) => this.handleEndImprove(msg));

    // AutoLearn Engine
    this.bot.onText(/\/autolearn$/, (msg: any) => this.handleAutolearn(msg));
    this.bot.onText(/\/veto\s+(\S+)(?:\s+(.+))?/, (msg: any, match: any) => this.handleVeto(msg, match));
    this.bot.onText(/\/autolearn_pause/, (msg: any) => this.handleAutolearnPause(msg));
    this.bot.onText(/\/autolearn_resume/, (msg: any) => this.handleAutolearnResume(msg));

    // Vacation / Owner unavailability
    this.bot.onText(/\/vacation\s+cancel\s+(\S+)/, (msg: any, match: any) => this.handleVacationCancel(msg, match));
    this.bot.onText(/\/vacation$/, (msg: any) => this.handleVacationList(msg));

    // Renter commands (accessible to non-owner users)
    this.bot.onText(/\/reset$/, (msg: any) => this.handleRenterReset(msg));
    this.bot.onText(/\/account\s+(dbcinema|leo)/, (msg: any, match: any) => this.handleRenterAccount(msg, match));
  }

  // --- Conversation handler (non-command messages -> Claude) ---

  private registerConversationHandler() {
    this.bot.on('message', async (msg: any) => {
      if (!msg.text || msg.text.startsWith('/')) return;

      // Non-owner users get routed to renter conversation mode
      if (!this.isOwner(msg.chat.id)) {
        await this.handleRenterMessage(msg);
        return;
      }

      // Owner: Custom reply for pending decision
      const pendingDecisionId = this.awaitingCustomReply.get(String(msg.chat.id));
      if (pendingDecisionId) {
        this.awaitingCustomReply.delete(String(msg.chat.id));

        if (msg.text === '/cancel_reply') {
          await this.bot.sendMessage(msg.chat.id, 'Custom reply cancelled. Decision still pending.');
          return;
        }

        const decision = this.pendingDecisions.get(pendingDecisionId);
        if (decision && !decision.resolved) {
          decision.resolved = true;
          const customOption: DecisionOption = {
            label: 'Custom reply',
            emoji: '\u270d\ufe0f',
            intent: 'custom',
            aiInstruction: '',
          };
          await this.resolveDecision(decision, customOption, msg.text);
        } else {
          await this.bot.sendMessage(msg.chat.id, 'That decision has already been resolved or expired.');
        }
        return;
      }

      // Owner: Improvement mode — classify message as a high-priority rule
      if (this.improvementMode) {
        await this.handleImprovementMessage(msg);
        return;
      }

      // Owner: Simulation mode — treat owner messages as renter messages
      if (this.simulationMode.active) {
        await this.handleSimulatedConversation(msg);
        return;
      }

      // Owner: Detect vacation/unavailability intent and handle directly
      const vacationIntent = this.parseVacationIntent(msg.text);
      if (vacationIntent) {
        await this.handleVacationFromChat(msg, vacationIntent);
        return;
      }

      // Owner: Auto-detect roleplay requests and route through full renter pipeline
      const roleplayMatch = this.detectRoleplayIntent(msg.text);
      if (roleplayMatch) {
        this.simulationMode = { active: true, account: roleplayMatch.account };
        this.simConversationHistory = [];
        await this.bot.sendMessage(
          msg.chat.id,
          `Entering sim mode (${roleplayMatch.account}). Use /endsim when done.`,
        );
        // Strip the roleplay preamble and process the actual renter message
        const renterText = roleplayMatch.renterMessage || msg.text;
        await this.handleSimulatedConversation({ ...msg, text: renterText });
        return;
      }

      await this.handleConversation(msg);

      // Passive correction detection (non-blocking)
      this.correctionDetector.processMessage(msg.text, false).catch(err =>
        this.logger.debug(`Correction detector: ${err.message}`),
      );
    });
  }

  /**
   * Detect business/strategy intent — when Daniel asks about revenue, marketing, buying, demand, etc.
   * Returns true if the message warrants injecting comprehensive business intelligence data.
   */
  private hasBusinessIntent(text: string): boolean {
    const businessPatterns = [
      // Buying/acquisition strategy
      /\b(buy|purchase|acquire|invest|add to inventory|new gear|new equipment|should i get|worth buying|worth getting)\b/i,
      // Selling/dropping items
      /\b(sell|drop|get rid of|remove from inventory|not worth keeping|underperforming)\b/i,
      // Revenue/profit analysis
      /\b(revenue|profit|earnings|income|how much .*(made|earned|brought in)|top earner|best seller|worst performer)\b/i,
      // Demand/market signals
      /\b(demand|trending|popular|what.*people.*want|what.*renters.*ask|most requested|unmatched|gap in)\b/i,
      // Marketing strategy
      /\b(marketing|advertis|promot|listing strategy|SEO|visibility|attract more|grow|expansion)\b/i,
      // ROI and utilization
      /\b(ROI|return on investment|utilization|utilisation|idle|sitting unused|not renting|underused)\b/i,
      // Strategy/optimization
      /\b(strategy|optimiz|optimis|maximize|maximise|improve revenue|boost|grow the business)\b/i,
      // Competition and market position
      /\b(competitor|competition|market position|pricing strategy|undercut|cheaper than)\b/i,
      // Item-level performance queries
      /\b(how.*doing|performing|performance of|stats for|numbers on|data on|breakdown)\b/i,
      // Lost revenue / missed opportunities
      /\b(lost revenue|missed.*booking|turned away|couldn't fulfill|stock.*out|overbooked|denied)\b/i,
      // Bundle/pricing optimization
      /\b(bundle|package|pricing|reprice|price change|adjust price|too cheap|too expensive)\b/i,
    ];
    return businessPatterns.some(p => p.test(text));
  }

  /**
   * Build comprehensive business intelligence context for owner strategy conversations.
   * Pulls per-item revenue with monthly breakdowns, lost revenue, unmatched demand,
   * investment scorecard, and monthly trends.
   */
  private async buildBusinessIntelligenceContext(): Promise<string> {
    const parts: string[] = [];

    try {
      // Parallel fetch of all business data
      const [
        itemBreakdown,
        monthlyTotals,
        weekRevenue,
        monthRevenue,
        lostRevenue,
        unmatchedDemand,
        investmentScorecard,
      ] = await Promise.all([
        this.revenueService.getItemRevenueBreakdown('all').catch(() => null),
        this.revenueService.getMonthlyTotals(12).catch(() => null),
        this.revenueService.getRevenueForPeriod('week').catch(() => null),
        this.revenueService.getRevenueForPeriod('month').catch(() => null),
        this.lostRevenueService.getLostRevenueSummary('6m').catch(() => null),
        this.lostRevenueService.getUnmatchedDemand('6m').catch(() => null),
        this.lostRevenueService.getRevenuePotential('6m').catch(() => null),
      ]);

      // === REVENUE OVERVIEW ===
      if (weekRevenue || monthRevenue) {
        parts.push('=== REVENUE OVERVIEW ===');
        if (weekRevenue) parts.push(`This week: £${weekRevenue.totalRevenue} from ${weekRevenue.bookings} bookings`);
        if (monthRevenue) parts.push(`This month: £${monthRevenue.totalRevenue} from ${monthRevenue.bookings} bookings`);
      }

      // === MONTHLY REVENUE TREND (12 months) ===
      if (monthlyTotals && monthlyTotals.length > 0) {
        parts.push('\n=== MONTHLY REVENUE TREND ===');
        for (const m of monthlyTotals) {
          parts.push(`${m.month}: £${m.revenue} (${m.count} bookings)`);
        }
      }

      // === PER-ITEM REVENUE WITH MONTHLY BREAKDOWN ===
      if (itemBreakdown && itemBreakdown.items.length > 0) {
        parts.push(`\n=== ITEM REVENUE (ALL TIME, total £${itemBreakdown.totalRevenue}) ===`);
        for (const item of itemBreakdown.items) {
          const monthlyStr = item.monthlyBreakdown
            .map(mb => `${mb.month}:£${mb.revenue}`)
            .join(', ');
          parts.push(`${item.item}: £${item.totalRevenue} total, ${item.totalCount} rentals, £${item.avgPerRental}/rental avg [${monthlyStr}]`);
        }
        if (itemBreakdown.otherRevenue > 0) {
          parts.push(`Unattributed/bundle-overflow: £${itemBreakdown.otherRevenue}`);
        }
        // Items earning revenue but not in current MASTER_INVENTORY (sold/removed/untracked)
        if (itemBreakdown.unmatchedItems && itemBreakdown.unmatchedItems.length > 0) {
          parts.push(`\n=== HISTORICAL ITEMS (no longer in inventory but earned revenue) ===`);
          for (const ui of itemBreakdown.unmatchedItems) {
            parts.push(`  ${ui.item}: £${ui.totalRevenue} total, ${ui.totalCount} rentals`);
          }
        }
      }

      // === LOST REVENUE (stock blocked) ===
      if (lostRevenue && lostRevenue.deniedRequestCount > 0) {
        parts.push(`\n=== LOST REVENUE (6mo, stock unavailable) === £${lostRevenue.totalLostRevenue} from ${lostRevenue.deniedRequestCount} denied requests`);
        if (lostRevenue.topDeniedItems.length > 0) {
          parts.push('Top blocked items:');
          for (const item of lostRevenue.topDeniedItems) {
            parts.push(`  ${item.item}: ${item.count} denials, £${item.revenue} lost`);
          }
        }
      }

      // === UNMATCHED DEMAND (items we don't stock) ===
      if (unmatchedDemand && unmatchedDemand.length > 0) {
        parts.push('\n=== UNMATCHED DEMAND (items not in inventory, requested 2+ times in 6mo) ===');
        for (const item of unmatchedDemand) {
          parts.push(`  "${item.item}": ${item.requestCount} requests, avg ${item.avgRentalDays} days/rental`);
        }
      }

      // === INVESTMENT SCORECARD ===
      if (investmentScorecard && investmentScorecard.length > 0) {
        parts.push('\n=== INVESTMENT SCORECARD (6mo, sorted by confidence) ===');
        parts.push('Format: item | stock | daily rate | earned | lost | util% | rentals/mo | confidence');
        for (const item of investmentScorecard.slice(0, 25)) {
          const lostStr = item.lostRevenue > 0 ? ` | £${item.lostRevenue} lost` : '';
          parts.push(`  ${item.item} | ${item.currentStock}x | £${item.dailyPrice || '?'}/day | £${item.actualRevenue} earned${lostStr} | ${item.utilization}% util | ${item.rentalsPerMonth}/mo | ${item.confidence}`);
        }
      }

    } catch (err) {
      this.logger.warn(`Business intelligence context build failed: ${err.message}`);
      parts.push('[Business data temporarily unavailable]');
    }

    return parts.join('\n');
  }

  private async handleConversation(msg: any) {
    const chatId = String(msg.chat.id);
    const userText = msg.text;

    try {
      await this.memoryService.storeConversation(chatId, 'user', userText);

      // Extract meaningful keywords (individual words, not just first 5)
      const chatKeywords = userText
        .split(/[\s,.\-!?;:()]+/)
        .filter((w: string) => w.length > 2)
        .slice(0, 10);

      // Detect pricing intent for additional memory fetch
      const pricingTerms = /\b(price|pricing|cost|how much|rate|rates|quote|charge|fee|fees|per day|daily|weekly|budget|listing)\b/i;
      const hasPricingIntent = pricingTerms.test(userText);

      // Detect business/strategy intent for comprehensive data injection
      const isBusinessQuery = this.hasBusinessIntent(userText);

      const [rules, history, generalMemories, blacklist, schedule, revenueSummary] = await Promise.all([
        this.rulesService.getFormattedRules(),
        this.memoryService.getConversationHistory(chatId, 10),
        this.memoryService.getRelevantMemories(chatKeywords),
        this.blacklistService.getFormattedBlacklist(),
        this.calendarService.getFormattedSchedule(new Date()),
        this.revenueService.getRevenueForPeriod('week'),
      ]);

      // Add pricing data when relevant
      let memories = generalMemories;
      if (hasPricingIntent) {
        const pricingMem = await this.memoryService.getPricingMemories();
        if (pricingMem) {
          memories = [generalMemories, pricingMem].filter(Boolean).join('\n');
        }
      }

      const recentRentals = await this.prisma.rental.findMany({
        take: 5,
        orderBy: { created_at: 'desc' },
        select: { title: true, status: true, renter_info: true, start_date: true, end_date: true },
      });
      const rentalContext = recentRentals.length > 0
        ? recentRentals.map((r) => `- ${r.title} (${r.status}), renter: ${r.renter_info || 'N/A'}`).join('\n')
        : 'No recent rentals.';

      const additionalParts: string[] = [
        'IMPORTANT: You are chatting with DANIEL, THE OWNER — not a renter. ',
        'Daniel owns DB Cinema Rentals and Leo Adams rental accounts on Hygglo/Fat Llama. ',
        'You are his business assistant. You have FULL authority to discuss all business data openly with him — ',
        'revenue numbers, profit margins, item performance, demand trends, competitor data, strategy, everything. ',
        'Do NOT "escalate to Daniel" — you ARE talking to Daniel. Do NOT withhold any data. ',
        'When he asks about revenue, items, demand, or strategy, give SPECIFIC numbers from the data provided to you. ',
        'Help him manage the business, answer questions, and provide actionable insights backed by the data you have. ',
        'IMPORTANT: When Daniel tells you new information, rules, preferences, facts about items, renters, schedules, or anything worth remembering, ',
        'you MUST store it using <memory> tags. Examples: if he says an item is in repair, store it. If he tells you about a vacation day, store it. ',
        'If he gives you a new rule or corrects you, store the correction. If he mentions a renter preference or pattern, store it. ',
        'Be proactive about learning - anything Daniel tells you that would be useful for future conversations should be stored as a memory.',
      ];

      if (schedule) {
        additionalParts.push(`\n\nTODAY'S SCHEDULE:\n${schedule}`);
      }
      if (blacklist) {
        additionalParts.push(`\n\n${blacklist}`);
      }
      if (revenueSummary.bookings > 0) {
        additionalParts.push(`\n\nWEEKLY EARNINGS: £${revenueSummary.totalRevenue} from ${revenueSummary.bookings} bookings`);
      }

      // Live availability check: detect item names and date references in the message
      try {
        const availabilityData = await this.getAvailabilityForMessage(userText);
        if (availabilityData) {
          additionalParts.push(`\n\n${availabilityData}`);
        }
      } catch (availErr) {
        this.logger.warn(`Availability check failed: ${availErr.message}`);
      }

      // Business intelligence: inject comprehensive revenue/demand/investment data for strategy conversations
      if (isBusinessQuery) {
        this.logger.log(`Business intent detected — loading comprehensive business intelligence context`);
        const bizContext = await this.buildBusinessIntelligenceContext();
        if (bizContext) {
          additionalParts.push(`\n\n--- BUSINESS INTELLIGENCE DATA ---\nUse this data to give Daniel specific, data-backed answers about revenue, demand, investment, and strategy.\n${bizContext}`);
        }
      }

      // Business strategy conversations use Sonnet with generous token budget
      const response = isBusinessQuery
        ? await this.aiService.processComplex(userText, {
            rules,
            memories,
            conversationHistory: history,
            rentalContext,
            additionalContext: additionalParts.join(''),
            maxTokens: 1500,
          })
        : await this.aiService.processRoutine(userText, {
            rules,
            memories,
            conversationHistory: history,
            rentalContext,
            additionalContext: additionalParts.join(''),
          });

      await this.memoryService.storeConversation(chatId, 'assistant', response.content);

      if (response.memories.length > 0) {
        await this.memoryService.processAiMemories(response.memories);
      }

      await this.bot.sendMessage(msg.chat.id, response.content);
    } catch (error) {
      this.logger.error(`Conversation error: ${error.message}`);
      this.errorLogService.captureError(error, {
        operation: 'telegram_conversation',
        chat_id: chatId,
        message_preview: userText.substring(0, 100),
      });
      await this.bot.sendMessage(msg.chat.id, 'Sorry, I encountered an error processing your message. Please try again.');
    }
  }

  /**
   * Core renter conversation logic shared by both simulation mode and the renter-facing bot.
   * Returns { replyText, qualityInfo } so callers can format and send the response.
   */
  private async processRenterConversation(
    userText: string,
    account: 'dbcinema' | 'leo' | null,
    conversationHistory: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<{ replyText: string; qualityInfo: string; rawContent: string } | null> {
    // SCAM DETECTION
    const scamResult = this.detectSimScamPattern(userText);
    if (scamResult.isScam) {
      return {
        replyText: `🚨 SCAM DETECTED (${scamResult.severity})\nPatterns: ${scamResult.matchedPattern}\nScore: ${scamResult.score}\n\nIn production, this message would be auto-blocked and the renter blacklisted.`,
        qualityInfo: '',
        rawContent: '',
      };
    }

      // CANCEL/RESCHEDULE DETECTION (from autonomous service)
      const cancelReschedulePatterns = [
        { pattern: /\b(cancel|cancellation)\b(?!.*\b(my other|my plans|everything else)\b)/i, type: 'cancel' as const },
        { pattern: /\b(reschedule|change the date|move the booking|different date|postpone)\b/i, type: 'reschedule' as const },
      ];
      for (const { pattern, type } of cancelReschedulePatterns) {
        if (pattern.test(userText)) {
          const label = type === 'cancel' ? 'CANCELLATION' : 'RESCHEDULE';
          return {
            replyText: `Let me check on that for you - I'll get back to you shortly.`,
            qualityInfo: `\n\n🚨 ${label} REQUEST detected — escalated to owner`,
            rawContent: `Let me check on that for you - I'll get back to you shortly.`,
          };
        }
      }

      // BLACKLIST CHECK: Only on first message (result is session-stable)
      const isFirstMessage = conversationHistory.length === 0;
      if (isFirstMessage) {
        try {
          const blacklist = await this.blacklistService.getFormattedBlacklist();
          if (blacklist) {
            const blacklistLower = blacklist.toLowerCase();
            if (blacklistLower.includes('BLOCKED')) {
              // Blacklist data available for AI awareness
            }
          }
        } catch (blErr) {
          this.logger.debug(`Blacklist check failed: ${blErr.message}`);
        }
      }

      // INTENT DETECTION: Classify message intent for conditional context loading
      const textLower = userText.toLowerCase();
      const pricingTerms = /\b(price|pricing|cost|how much|rate|rates|quote|charge|fee|fees|per day|daily|weekly|budget|afford|expensive|cheap|discount|deal)\b/i;
      const deliveryTerms = /\b(deliver|delivery|courier|ship|shipping|post|postcode|send it|drop off|dropoff|bring it|transport|how far|distance|collect from|too far|can you bring|come to me)\b/i;
      const schedulingTerms = /\b(pickup|pick up|collect|return|drop off|time|slot|morning|evening|tomorrow|today|weekend|schedule|when can)\b/i;
      const hasPricingIntent = pricingTerms.test(userText);
      const hasDeliveryIntent = deliveryTerms.test(userText);
      const hasSchedulingIntent = schedulingTerms.test(userText);
      const sameDayPatterns = /\b(today|tonight|this evening|this afternoon|asap|right now|immediately|same[\s-]?day)\b/i;
      const hasSameDayIntent = sameDayPatterns.test(userText);
      const onMyWayPatterns = [
        /\bon\s+my\s+way\b/i, /\bcoming\s+now\b/i, /\bheading\s+(there|over|to\s+you)\b/i,
        /\bomw\b/i, /\bon\s+the\s+way\b/i, /\bnearly\s+there\b/i, /\balmost\s+there\b/i,
        /\bleaving\s+now\b/i, /\bsetting\s+off\b/i, /\bon\s+route\b/i, /\ben\s+route\b/i,
        /\bbe\s+there\s+(in|soon)\b/i, /\b(5|10|15|20|30)\s+min(ute)?s?\s+away\b/i,
      ];
      const hasOnMyWayIntent = onMyWayPatterns.some(p => p.test(userText));

      // Extract meaningful keywords
      const words = userText
        .split(/[\s,.\-!?;:()]+/)
        .filter((w: string) => w.length > 2)
        .slice(0, 10);

      // Detect mentioned items (always needed for availability + compatibility)
      const mentionedItems = words
        .map((w: string) => findBestMatch(w, getInventoryItemNames()))
        .filter(Boolean) as string[];

      // Also scan conversation history for previously mentioned items
      const historyItems: string[] = [];
      for (const msg of conversationHistory.slice(-6)) {
        const msgWords = msg.content.split(/[\s,.\-!?;:()]+/).filter((w: string) => w.length > 2);
        for (const w of msgWords) {
          const match = findBestMatch(w, getInventoryItemNames());
          if (match && !mentionedItems.includes(match) && !historyItems.includes(match)) {
            historyItems.push(match);
          }
        }
      }
      const allRelevantItems = [...mentionedItems, ...historyItems];

      // COMPACT INVENTORY CONTEXT: AI-native — full inventory + bookings, AI reasons about availability
      const inventoryContext = await this.calendarService.getCompactInventoryContext();

      // RULES: Use compact format for routine, full for complex conversations
      const rules = isFirstMessage || conversationHistory.length > 8
        ? await this.rulesService.getFormattedRules()
        : await this.rulesService.getCompactRules();

      // PARALLEL FETCHES: Load always-needed + conditional data concurrently
      const deliveryKeywords = hasDeliveryIntent ? ['Delivery Pricing Zones', 'Delivery Courier Framework', 'Delivery Rules', 'Delivery Mandatory', 'Fake Location Handling'] : [];

      // Filter pricing catalog to relevant items when possible
      const { PRICING_CATALOG } = await import('../data/pricing-catalog.js');
      let pricingCatalogText: string;
      if (allRelevantItems.length > 0 && !textLower.includes('what do you have') && !textLower.includes('what items') && !textLower.includes('full list')) {
        // Filtered catalog: mentioned items + their bundles + same-category items
        const relevantCategories = new Set<string>();
        const relevantEntries: any[] = [];
        for (const item of allRelevantItems) {
          const entry = PRICING_CATALOG.find((p: any) => p.item_name.toLowerCase() === item.toLowerCase());
          if (entry) {
            relevantEntries.push(entry);
            relevantCategories.add(entry.category);
          }
        }
        // Add bundles containing mentioned items
        for (const entry of PRICING_CATALOG) {
          if (entry.is_bundle && entry.bundle_items?.some((bi: string) =>
            allRelevantItems.some(ai => bi.toLowerCase().includes(ai.toLowerCase()) || ai.toLowerCase().includes(bi.toLowerCase()))
          )) {
            relevantEntries.push(entry);
          }
        }
        // Add a few alternatives from same categories
        for (const cat of relevantCategories) {
          const catItems = PRICING_CATALOG.filter((p: any) => p.category === cat && !p.marketing_only && !relevantEntries.includes(p));
          relevantEntries.push(...catItems.slice(0, 3));
        }
        // Deduplicate
        const seen = new Set<string>();
        const uniqueEntries = relevantEntries.filter(e => {
          if (seen.has(e.item_name)) return false;
          seen.add(e.item_name);
          return true;
        });
        pricingCatalogText = '=== RELEVANT PRICING (filtered) ===\n' +
          uniqueEntries.map((e: any) => {
            const bundleTag = e.is_bundle && e.bundle_items ? ` (includes: ${e.bundle_items.join(' + ')})` : '';
            return `${e.item_name}: £${e.daily_price_min}-${e.daily_price_max}/day${bundleTag}`;
          }).join('\n') +
          '\nMulti-day: 3d ~2.5x, 7d ~5x, month ~2.5 weeks. Full catalog available on request.';
      } else {
        pricingCatalogText = this.memoryService.getPricingCatalogContext();
      }

      const [generalMem, pricingMem, deliveryMem] = await Promise.all([
        this.memoryService.getRelevantMemories(words, 5),
        hasPricingIntent ? this.memoryService.getPricingMemories() : Promise.resolve(''),
        hasDeliveryIntent ? this.memoryService.getMinimalMemories(deliveryKeywords, 3) : Promise.resolve(''),
      ]);

      // Build memories with token budget awareness (~800 token cap for general memories)
      let memories: string = [pricingCatalogText, generalMem, pricingMem, deliveryMem].filter(Boolean).join('\n');

      // COMPATIBILITY + PRODUCT SPECS context (always when items are mentioned)
      if (allRelevantItems.length > 0) {
        const compatContext = this.memoryService.getCompatibilityContext(allRelevantItems);
        if (compatContext) {
          memories = [memories, compatContext].filter(Boolean).join('\n');
        }
        const specsContext = this.memoryService.getItemSpecsContext(allRelevantItems);
        if (specsContext) {
          memories = [memories, specsContext].filter(Boolean).join('\n');
        }
      }

      // UNIFIED RECOMMENDATIONS — use ALL relevant items (current + history), not just current message
      const { startDate: bundleStartDate, endDate: bundleEndDate } = this.parseDateReferences(textLower);
      let estimatedTotal = 0;
      for (const item of allRelevantItems) {
        const catalogEntry = PRICING_CATALOG.find(
          (p: any) => p.item_name.toLowerCase() === item.toLowerCase(),
        );
        estimatedTotal += catalogEntry ? catalogEntry.daily_price_max : 25;
      }
      if (estimatedTotal === 0) estimatedTotal = 25;

      const recommendations = await this.recommendationService.generateRecommendations({
        message: userText,
        mentionedItems,
        conversationText: userText,
        estimatedTotal,
        hasPricingIntent,
        startDate: bundleStartDate,
        endDate: bundleEndDate,
      });

      if (recommendations.bundleContext) {
        memories = [memories, recommendations.bundleContext].filter(Boolean).join('\n');
      } else {
        const bundleSuggestionContext = this.memoryService.getBundleSuggestionContext(userText, mentionedItems);
        if (bundleSuggestionContext) {
          memories = [memories, bundleSuggestionContext].filter(Boolean).join('\n');
        }
      }

      // DEMAND DATA: Fetch once, reuse for trends + upselling (saves duplicate DB query)
      let topDemandItems: [string, number][] = [];
      if (conversationHistory.length <= 4) {
        try {
          topDemandItems = await this.demandService.getTopRequestedItems(30);
        } catch (demandErr) {
          this.logger.debug(`Demand fetch failed: ${demandErr.message}`);
        }
      }

      let upsellContext = recommendations.upsellContext || '';

      // Demand-based upselling — first 3 messages, reuse already-fetched data
      if ((upsellContext || hasPricingIntent) && topDemandItems.length > 0 && conversationHistory.length <= 4) {
        const popularNotMentioned = topDemandItems
          .filter(([item]) => !allRelevantItems.some(m => m.toLowerCase() === item.toLowerCase()))
          .slice(0, 3);
        if (popularNotMentioned.length > 0) {
          const popularSuggestions = popularNotMentioned.map(([item, count]) => `${item} (${count})`).join(', ');
          upsellContext += `\nPopular: ${popularSuggestions}`;
        }
      }

      // ACCOUNT TEMPLATES — only first 3 messages (establishes tone, then persona context takes over)
      const accountName = account || 'dbcinema';
      if (conversationHistory.length <= 4) {
        try {
          const accountTemplates = await this.memoryService.getAccountTemplates(accountName as 'dbcinema' | 'leo');
          if (accountTemplates) {
            memories = [memories, `\n--- ACCOUNT TEMPLATES ---\n${accountTemplates}`].filter(Boolean).join('\n');
          }
        } catch (templateErr) {
          this.logger.debug(`Account templates fetch failed: ${templateErr.message}`);
        }
      }

      // Demand trends — first message only (~50 tokens)
      if (isFirstMessage && topDemandItems.length > 0) {
        const trendLines = topDemandItems.slice(0, 3).map(([item, count]) => `${item}: ${count}`).join(', ');
        memories = [memories, `\n--- TRENDING ---\n${trendLines}`].filter(Boolean).join('\n');
      }

      // Revenue context REMOVED — wastes tokens, no renter-facing value, AI should never share it

      // Market data REMOVED from renter chats — internal owner insight only

      // DELIVERY QUOTE (only when delivery is discussed — with item specs from autonomous service)
      let deliveryQuoteContext = '';
      if (hasDeliveryIntent) {
        try {
          // Search current message AND conversation history for postcodes
          const postcodeMatch = userText.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
          const historyText = conversationHistory.map(m => m.content).join(' ');
          const historyPostcodeMatch = !postcodeMatch ? historyText.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i) : null;
          const postcode = postcodeMatch?.[1] || historyPostcodeMatch?.[1];

          if (postcode) {
            const itemsForQuote = mentionedItems.length > 0 ? mentionedItems : ['camera'];
            const quote = await this.deliveryService.calculateQuote(postcode, itemsForQuote);
            if (quote) {
              deliveryQuoteContext = `\n--- CALCULATED DELIVERY QUOTE ---\n` +
                `Postcode: ${postcode.toUpperCase()}\n` +
                `Distance: ${quote.distance_km}km from pickup point\n` +
                `Zone: ${quote.zone}\n` +
                `Courier type: ${quote.vehicle_display}\n` +
                `Reason: ${quote.courier_explanation}\n` +
                (quote.price_min > 0 ? `One-way estimate: £${quote.price_min}-${quote.price_max}\nRound-trip estimate: £${Math.round(quote.price_min * 1.8)}-${Math.round(quote.price_max * 1.8)}\n` : '') +
                // Include item dimension breakdown (from autonomous service)
                (quote.items?.length > 0 ? `Item specs:\n${quote.items.map((item: any) => `  - ${item.name}: size ${item.size_score}/5, ${item.weight_kg}kg${item.is_heavy_large ? ' (heavy/large)' : ''}`).join('\n')}\n` : '') +
                (quote.notes?.length > 0 ? `Notes: ${quote.notes.join('. ')}\n` : '') +
                `Use this CALCULATED quote — do NOT guess. Delivery estimates are usually accurate within approximately 15%.`;
            }
          } else {
            const vehicleItems = mentionedItems.length > 0 ? mentionedItems : ['camera'];
            const vehicleInfo = await this.deliveryService.determineVehicle(vehicleItems);
            deliveryQuoteContext = `\n--- DELIVERY VEHICLE DETERMINATION ---\n` +
              `Courier type needed: ${vehicleInfo.vehicle_display}\n` +
              `Reason: ${vehicleInfo.courier_explanation}\n` +
              (vehicleInfo.items?.length > 0 ? `Item specs:\n${vehicleInfo.items.map((item: any) => `  - ${item.name}: size ${item.size_score}/5, ${item.weight_kg}kg${item.is_heavy_large ? ' (heavy/large)' : ''}`).join('\n')}\n` : '') +
              `Ask the renter for their postcode to calculate the exact delivery price.`;
          }
        } catch (e) {
          this.logger.debug(`Delivery quote failed: ${e.message}`);
        }
      }

      // SCHEDULE — only when scheduling intent AND conversation is advanced (QUALIFIED+ stage) or on-my-way
      let scheduleContext = '';
      if ((hasSchedulingIntent && conversationHistory.length >= 4) || hasSameDayIntent || hasOnMyWayIntent) {
        try {
          const schedule = await this.calendarService.getFormattedSchedule(new Date());
          if (schedule) {
            scheduleContext = `\n--- TODAY'S SCHEDULE ---\n${schedule}`;
          }
        } catch (e) {
          this.logger.debug(`Schedule load failed: ${e.message}`);
        }
      }

      // ON MY WAY DETECTION
      let onMyWayContext = '';
      if (hasOnMyWayIntent) {
        onMyWayContext = `\n--- ON MY WAY DETECTED ---\nRenter heading to pickup. Check booking is confirmed and verified before sharing address. If not confirmed, remind them to complete booking first. Only say "Central London (Trafalgar Square area)" until confirmed.`;
      }

      // MINIMUM FEE + UPSELL CONTEXT
      let discountContext = '';
      const MIN_PROFIT_THRESHOLD = 30; // £30 profit minimum (≈ £47 listing price after platform fees)
      const estimatedProfit = Math.round(estimatedTotal * 0.64);
      if (estimatedProfit < MIN_PROFIT_THRESHOLD && allRelevantItems.length > 0) {
        discountContext = `\n--- LOW VALUE RENTAL (est. ~£${estimatedProfit} profit) ---\nThis is below the £${MIN_PROFIT_THRESHOLD} profit minimum. Naturally suggest relevant add-ons (batteries, memory cards, lenses, mics) that complement what they're renting. NEVER mention a minimum fee or profit — just recommend useful extras.`;
      } else if (estimatedTotal >= 500) {
        discountContext = `\n--- DISCOUNT ---\nINTERNAL: Top-tier discount applies (auto at checkout). Do NOT reveal percentage.`;
      } else if (estimatedTotal >= 250) {
        discountContext = `\n--- DISCOUNT ---\nINTERNAL: Qualifies for discount, close to bigger tier. Suggest add-ons naturally.`;
      } else if (estimatedTotal >= 225) {
        discountContext = `\n--- DISCOUNT ---\nINTERNAL: Close to qualifying. Suggest add-ons naturally.`;
      }

      // SAME-DAY DETECTION
      let sameDayContext = '';
      if (hasSameDayIntent) {
        sameDayContext = estimatedTotal >= 40
          ? `\n--- SAME-DAY ---\nHigh-value (est. £${estimatedTotal}). Escalate to Daniel. Ask pickup time.`
          : `\n--- SAME-DAY ---\nLower-value (est. £${estimatedTotal}). Suggest add-ons first, then escalate.`;
      }

      // ENHANCED STAGE TRACKING (8-stage funnel from autonomous service, inline detection)
      // Check BOTH conversation history AND current message for stage signals
      let stageContext = '';
      const msgCount = conversationHistory.length / 2;
      const allContent = [...conversationHistory.map(m => m.content), userText]; // Include current message
      const hasPricingDiscussed = allContent.some(c => c && /\b(£\d|price|cost|rate|quote|how much|per day)\b/i.test(c));
      const hasDeliveryDiscussed = allContent.some(c => c && /\b(deliver|pickup|collect|postcode)\b/i.test(c));
      // Stage detection — tightened patterns to prevent false triggers
      // "confirmed" must be in booking-confirmation context, not "I confirmed the price" or "item confirmed available"
      const hasConfirmedItems = conversationHistory.some(m => m.role === 'assistant' &&
        /\b(booking confirmed|booking is confirmed|reservation confirmed|your booking|rental confirmed)\b/i.test(m.content));
      const hasBookingRequest = conversationHistory.some(m => m.content && /\b(send a request|booking request|book it|go ahead|let'?s do it|i'?ve booked|just booked)\b/i.test(m.content));
      // Verification must be in identity-verification context, not just mentioning "ID" or "verify availability"
      const hasVerificationMention = allContent.some(c => c && /\b(identity verif|id verif|verify your identity|upload.*id|passport.*verif|driving licen|verification required|needs? verif)\b/i.test(c));
      const hasGoneQuiet = msgCount > 3 && conversationHistory.slice(-2).every(m => m.role === 'assistant');

      if (hasGoneQuiet) {
        stageContext = `\n--- STAGE: DEAD ---\nRenter has gone quiet. Do NOT send follow-ups (handled automatically). If they re-engage, welcome them back warmly.`;
      } else if (hasConfirmedItems) {
        stageContext = `\n--- STAGE: CONFIRMED ---\nFinal details only. Focus on pickup/return logistics.`;
      } else if (hasVerificationMention || hasBookingRequest) {
        stageContext = `\n--- STAGE: BOOKED ---\nBooking in progress. Guide through verification if needed, confirm details.`;
      } else if (hasPricingDiscussed && hasDeliveryDiscussed && !hasConfirmedItems) {
        stageContext = `\n--- STAGE: READY_TO_BOOK ---\nPricing AND delivery discussed. IMPORTANT: Guide renter to submit a booking request through Hygglo. Tell them exactly how to proceed.`;
      } else if (hasPricingDiscussed && !hasDeliveryDiscussed && !hasConfirmedItems) {
        stageContext = `\n--- STAGE: READY_TO_BOOK ---\nPricing discussed. Push to booking — ask about dates, pickup/delivery preference.`;
      } else if (msgCount === 0) {
        stageContext = `\n--- STAGE: INQUIRY ---\nFirst message. Welcome warmly, confirm needs, ask about their shoot. MUST ask what the project is for to give better recommendations.`;
      } else if (msgCount <= 2 && !hasPricingDiscussed) {
        stageContext = `\n--- STAGE: INTERESTED ---\nExploring options. Give pricing proactively, suggest bundles. Ask about their shoot/project.`;
      }

      // SMART CONVERSATION HISTORY: Keep first msg + last 4 exchanges + summarize middle
      let smartHistory: { role: 'user' | 'assistant'; content: string }[] | undefined;
      if (conversationHistory.length > 0) {
        if (conversationHistory.length <= 10) {
          smartHistory = conversationHistory;
        } else {
          const first2 = conversationHistory.slice(0, 2); // First exchange (establishes context)
          const last8 = conversationHistory.slice(-8); // Last 4 exchanges
          // Summarize dropped middle as context note
          const droppedCount = conversationHistory.length - 10;
          const summaryMsg: { role: 'user' | 'assistant'; content: string } = {
            role: 'assistant',
            content: `[${droppedCount} earlier messages omitted. Key topics covered: ${hasPricingDiscussed ? 'pricing, ' : ''}${hasDeliveryDiscussed ? 'delivery, ' : ''}items discussed: ${allRelevantItems.slice(0, 5).join(', ') || 'general inquiry'}]`,
          };
          smartHistory = [...first2, summaryMsg, ...last8];
        }
      }

      // BUILD ADDITIONAL CONTEXT: Only dynamic, per-message data (no duplicated rules)
      const persona = accountName === 'leo'
        ? 'You are Leo Adams — a real person, NOT a business. OVERRIDE: The rule "Never say my gear/items/equipment" does NOT apply here. That rule is for DB Cinema only. As Leo, you MUST say "I\'ve got", "my gear", "my kit", "I can deliver". NEVER say "we" or "our". Example: "Yeah I\'ve got the FX3 available, my gear is all based in Central London." Be warm, personable, and slightly chill.'
        : 'You are Daniel from DB Cinema Rentals. Professional, concise, human tone. Use "we" and "our" — never "my gear".';
      const businessName = accountName === 'leo' ? 'Leo Adams' : 'DB Cinema Rentals';

      const pricingInstruction = hasPricingIntent
        ? `The renter is asking about pricing. Reference the pricing catalog to give an accurate estimate. ` +
          `Say "approximately £X/day based on our current listings". ` +
          `When quoting daily prices, use the standard single-day rate (the higher rate). The lower rate only applies to multi-day discounted bookings. ` +
          `Always quote the ONE-DAY price and mention multi-day discounts are available for longer rentals. ` +
          `Present as ESTIMATES. If a relevant bundle exists, suggest it as better value. ` +
          `CRITICAL: Quote INDIVIDUAL item price for single items — never confuse with bundle prices. ` +
          `NEVER reveal owner margins or commission rates. Do NOT require a rental request just for a quote.`
        : '';

      const deliveryInstruction = hasDeliveryIntent
        ? `The renter is asking about delivery. We only deliver within London (max 30km from our pickup point). ` +
          `Give a delivery price estimate DIRECTLY based on the delivery pricing zones. ` +
          `Tell them which courier type their items need (motorcycle, car, or van) and briefly explain why. ` +
          `Ask for their postcode if not provided. Do NOT require a booking request before giving a quote. ` +
          `Delivery estimates are usually accurate within approximately 15%.`
        : '';

      const additionalParts = [
        inventoryContext,
        pricingInstruction,
        deliveryInstruction,
        scheduleContext,
        deliveryQuoteContext,
        upsellContext,
        onMyWayContext,
        discountContext,
        sameDayContext,
        // CRITICAL BEHAVIORAL RULES (merged from autonomous service)
        `CRITICAL — CONTEXTUAL RECOMMENDATIONS: Only in EARLY conversation stages (before booking confirmed), if the renter has NOT mentioned what they are shooting, ask casually what the project is for (e.g., "What's the shoot for?"). This helps recommend the right gear. Do NOT ask this during pickup logistics, time confirmations, or after booking is confirmed. Once you know the use case, suggest complementary items naturally.`,
        `CRITICAL — NO DOWNSELLING: NEVER tell a renter they have "enough", are "set", are "all good", or "don't need" something. If they ask what else they might need, suggest relevant accessories — do NOT dismiss the question.`,
        `CRITICAL — RETURNING RENTERS: If conversation history shows familiarity, skip generic welcome. Say "Welcome back!" and get straight to confirming items and dates.`,
        `CRITICAL — WRITING STYLE: Keep messages concise and scannable. Use short paragraphs (2-3 sentences max). Lead with the answer, then add context. Make prices and key info easy to spot.`,
        `CRITICAL — LOCATION EXCUSES: When LISTING_LOCATION is non-central, acknowledge their specific location by name, apologise with a varied excuse (out of stock, on a rental, in for service, maintenance, consolidating pickups, all rented out), offer central branch + 10% distance discount, ask if that works or prefer delivery. NEVER reveal all items are at the same place.`,
        accountName === 'leo'
          ? `CRITICAL — LANGUAGE (HIGHEST PRIORITY): You are Leo. ALWAYS use "I" and "my" — say "I've got", "my gear", "my kit", "I can". NEVER say "we" or "our". You are one person, not a business.`
          : `CRITICAL — LANGUAGE (HIGHEST PRIORITY): You are Daniel from DB Cinema Rentals. NEVER say "my gear", "my items", "my equipment". Use "our", "the gear", "the equipment", "we have".`,
        `CRITICAL — SUBSTITUTIONS: When an exact item is unavailable but a close alternative exists, explain the difference simply and naturally.`,
        `CRITICAL — BUNDLE VALUE: ALWAYS check if a bundle/kit exists that includes the items the renter wants. If a bundle is CHEAPER than renting items individually, you MUST suggest it and show the savings. Example: "The Wedding Full Kit includes everything you need at £110-150/day — that's better value than renting separately." If renter mentions a use case (wedding, documentary, music video, etc.), check for matching named kits.`,
      ].filter(Boolean).join('\n');

      // DSPy disabled for renter conversations — it bypasses persona, stage tracking, and context pipeline
      // DSPy can be re-enabled once it supports account-aware modules
      const dspyResponse: any = null;

      // Build rental context for persona + stage (uses dedicated system prompt section for stronger signal)
      const rentalContextStr =
        `ACTIVE ACCOUNT: ${businessName} — respond ONLY as this account.\n` +
        `${persona}\n` +
        `${stageContext}\n` +
        `This is message #${msgCount + 1} in the conversation. ${conversationHistory.length > 0 ? 'IMPORTANT: Reference items and details from the conversation history above.' : ''}\n` +
        `Reply as a direct message to the renter. Plain text only. Start with the reply text (no preamble).`;

      // For Leo account, prefix the AI message with persona reminder (Haiku needs this for reliable persona switching)
      const aiUserMessage = accountName === 'leo'
        ? `[Respond as Leo Adams — use "I" and "my", never "we" or "our"]\n${userText}`
        : userText;

      // Adaptive token budget based on query complexity signals
      const tokenBudget = this.calculateTokenBudget({
        hasPricingIntent,
        hasDeliveryIntent,
        itemCount: allRelevantItems.length,
        estimatedTotal,
        messageCount: conversationHistory.length,
      });

      const response = dspyResponse?.response
        ? { content: dspyResponse.response, memories: [], model: 'dspy-optimized', inputTokens: 0, outputTokens: 0 }
        : await this.aiService.processRoutine(aiUserMessage, {
        rules,
        memories,
        conversationHistory: smartHistory,
        rentalContext: rentalContextStr,
        additionalContext: additionalParts,
        maxTokens: tokenBudget,
      });

      // Validate response before sending — pass sim context for accurate validation
      const validationResult = await this.validationService.validateResponse(
        response.content,
        {
          responseType: 'customer_message',
          context: {
            rental: {
              account,
              title: mentionedItems.join(', ') || 'Simulation',
              items: mentionedItems,
            },
            message: { content: userText },
          },
        },
      );

      // QUALITY SCORING: Compute quality metrics for sim feedback
      let qualityInfo = '';
      try {
        const qualityScore = await this.qualityScorerService.scoreResponse(
          response.content,
          {
            account: account || undefined,
            messageType: hasPricingIntent ? 'pricing' : hasDeliveryIntent ? 'delivery' : 'message',
            hasPricing: hasPricingIntent,
          },
          validationResult,
        );

        const emoji = qualityScore.overallQuality >= 0.85 ? '🟢' : qualityScore.overallQuality >= 0.7 ? '🟡' : '🔴';
        qualityInfo = `\n\n${emoji} Quality: ${(qualityScore.overallQuality * 100).toFixed(0)}% | Compliance: ${(qualityScore.ruleCompliance * 100).toFixed(0)}% | Tone: ${(qualityScore.toneMatch * 100).toFixed(0)}% | Concise: ${(qualityScore.conciseness * 100).toFixed(0)}%` +
          (qualityScore.pricingAccuracy !== undefined ? ` | Pricing: ${(qualityScore.pricingAccuracy * 100).toFixed(0)}%` : '') +
          ` | Confidence: ${(qualityScore.computedConfidence * 100).toFixed(0)}%`;
      } catch (qualityErr) {
        this.logger.debug(`Quality scoring failed in sim: ${qualityErr.message}`);
      }

      let replyText = response.content;
      if (validationResult.blocked) {
        // Attempt deterministic repair
        const repairResult = this.repairService.attemptRepair(response.content, validationResult, { account: account || undefined });
        if (repairResult.repaired) {
          const revalidation = await this.validationService.validateResponse(
            repairResult.content, { responseType: 'customer_message', context: { rental: { account }, message: { content: userText } } },
          );
          if (!revalidation.blocked) {
            replyText = repairResult.content;
            validationResult.blocked = false;
          }
        }
        if (validationResult.blocked) {
          replyText = `[BLOCKED by validation: ${validationResult.violations.join(', ')}]\n\nOriginal: ${response.content}`;
        }
      }

      // Track conversation history for multi-turn awareness
      conversationHistory.push(
        { role: 'user', content: userText },
        { role: 'assistant', content: response.content },
      );

      return { replyText, qualityInfo, rawContent: response.content };
  }

  /**
   * Adaptive token budget: gives more tokens when query complexity warrants it.
   */
  private calculateTokenBudget(signals: {
    hasPricingIntent: boolean;
    hasDeliveryIntent: boolean;
    itemCount: number;
    estimatedTotal: number;
    messageCount: number;
  }): number {
    let budget = 256; // default for simple queries

    if (signals.hasPricingIntent) budget = Math.max(budget, 320);
    if (signals.hasDeliveryIntent) budget = Math.max(budget, 320);
    if (signals.itemCount >= 3) budget = Math.max(budget, 384);
    if (signals.estimatedTotal > 300) budget = Math.max(budget, 384);
    if (signals.messageCount > 8) budget = Math.max(budget, 320);

    // Combination bonus: pricing + delivery + multi-item
    const complexSignals = [signals.hasPricingIntent, signals.hasDeliveryIntent, signals.itemCount >= 3].filter(Boolean).length;
    if (complexSignals >= 2) budget = Math.max(budget, 448);

    return budget;
  }

  private async handleSimulatedConversation(msg: any) {
    const userText = msg.text;
    const account = this.simulationMode.account;

    try {
      const result = await this.processRenterConversation(userText, account, this.simConversationHistory);
      if (!result) return;

      await this.bot.sendMessage(
        msg.chat.id,
        `[SIM:${account}] ${result.replyText}${result.qualityInfo}`,
      );
    } catch (error) {
      this.logger.error(`Simulation error: ${error.message}`);
      this.errorLogService.captureError(error, {
        operation: 'telegram_simulation',
        account: this.simulationMode.account,
        message_preview: userText.substring(0, 100),
      });
      await this.bot.sendMessage(msg.chat.id, 'Simulation error. Try /endsim and retry.');
    }
  }

  // --- Availability detection for AI context ---

  private async getAvailabilityForMessage(userText: string): Promise<string | null> {
    const textLower = userText.toLowerCase();

    // Quick keyword check: only proceed if the message seems availability-related
    const availabilityKeywords = ['available', 'availability', 'book', 'free', 'rent', 'hire', 'booked', 'schedule', 'calendar', 'next week', 'this week', 'weekend', 'tomorrow', 'today'];
    const hasAvailabilityIntent = availabilityKeywords.some(kw => textLower.includes(kw));
    if (!hasAvailabilityIntent) return null;

    // Detect item names from inventory
    const inventoryNames = getInventoryItemNames();
    const detectedItems: string[] = [];

    for (const itemName of inventoryNames) {
      const itemLower = itemName.toLowerCase();
      // Check for direct mentions or key parts of the name
      const itemParts = itemLower.split(' ').filter(p => p.length > 2);
      // Match if the user mentions the full item name or significant parts
      if (textLower.includes(itemLower)) {
        detectedItems.push(itemName);
      } else {
        // Check if enough distinctive tokens are present
        const matchCount = itemParts.filter(part => textLower.includes(part)).length;
        if (matchCount >= Math.min(2, itemParts.length) && itemParts.length > 0) {
          detectedItems.push(itemName);
        }
      }
    }

    // Also try fuzzy matching on significant words from the user's message
    const userWords = userText.split(/\s+/).filter(w => w.length > 2);
    for (const word of userWords) {
      const match = findBestMatch(word, inventoryNames);
      if (match && !detectedItems.includes(match)) {
        // Only add if the match seems strong (not too generic)
        const wordLower = word.toLowerCase();
        const matchLower = match.toLowerCase();
        if (matchLower.includes(wordLower) || wordLower.includes(matchLower.split(' ')[0])) {
          detectedItems.push(match);
        }
      }
    }

    // Fetch upcoming bookings once (used in both branches)
    const upcomingBookings = await this.calendarService.getAllUpcomingBookings(7);

    if (detectedItems.length === 0) {
      return upcomingBookings;
    }

    // Parse date references from the message
    const { startDate, endDate } = this.parseDateReferences(textLower);

    // Get availability summary for detected items
    const availabilitySummary = await this.calendarService.getAvailabilitySummary(
      detectedItems.slice(0, 5), // Limit to 5 items
      startDate,
      endDate,
    );

    return [availabilitySummary, upcomingBookings].filter(Boolean).join('\n\n');
  }

  private parseDateReferences(textLower: string): { startDate: Date; endDate: Date } {
    const now = new Date();
    let startDate = new Date(now);
    let endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 1);

    if (textLower.includes('tomorrow')) {
      startDate.setDate(startDate.getDate() + 1);
      endDate.setDate(startDate.getDate() + 1);
    } else if (textLower.includes('next week')) {
      // Next Monday to Sunday
      const dayOfWeek = now.getDay();
      const daysUntilNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      startDate.setDate(now.getDate() + daysUntilNextMonday);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 7);
    } else if (textLower.includes('this week')) {
      // Today to end of this week (Sunday)
      const dayOfWeek = now.getDay();
      const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
      endDate.setDate(now.getDate() + daysUntilSunday);
    } else if (textLower.includes('weekend') || textLower.includes('this weekend')) {
      // Coming Saturday to Sunday
      const dayOfWeek = now.getDay();
      const daysUntilSaturday = dayOfWeek <= 6 ? 6 - dayOfWeek : 0;
      startDate.setDate(now.getDate() + daysUntilSaturday);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 2);
    } else if (textLower.includes('next weekend')) {
      const dayOfWeek = now.getDay();
      const daysUntilNextSaturday = (6 - dayOfWeek) + 7;
      startDate.setDate(now.getDate() + daysUntilNextSaturday);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 2);
    } else {
      // Try to find explicit dates (YYYY-MM-DD format)
      const dateMatches = textLower.match(/(\d{4}-\d{2}-\d{2})/g);
      if (dateMatches && dateMatches.length >= 1) {
        startDate = new Date(dateMatches[0]);
        endDate = dateMatches.length >= 2 ? new Date(dateMatches[1]) : new Date(startDate);
        endDate.setDate(endDate.getDate() + 1);
      } else {
        // Try informal dates like "Feb 5" or "5th February"
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const informalMatch = textLower.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
        const informalMatch2 = textLower.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*(\d{1,2})/);

        if (informalMatch) {
          const day = parseInt(informalMatch[1]);
          const month = monthNames.indexOf(informalMatch[2]);
          startDate = new Date(now.getFullYear(), month, day);
          if (startDate < now) startDate.setFullYear(startDate.getFullYear() + 1);
          endDate = new Date(startDate);
          endDate.setDate(startDate.getDate() + 1);
        } else if (informalMatch2) {
          const day = parseInt(informalMatch2[2]);
          const month = monthNames.indexOf(informalMatch2[1]);
          startDate = new Date(now.getFullYear(), month, day);
          if (startDate < now) startDate.setFullYear(startDate.getFullYear() + 1);
          endDate = new Date(startDate);
          endDate.setDate(startDate.getDate() + 1);
        } else {
          // Default: check for the next 3 days
          endDate.setDate(now.getDate() + 3);
        }
      }
    }

    return { startDate, endDate };
  }

  // --- Command handlers ---

  private async handleStart(msg: any) {
    const chatId = msg.chat.id;
    this.logger.log(`/start from ${msg.from?.first_name} (chat ${chatId})`);

    if (this.isOwner(chatId)) {
      await this.bot.sendMessage(
        chatId,
        `*Bananajoe Rental Manager* (Owner verified)\n\nI autonomously manage your Hygglo rentals with AI.\n\nUse /help to see available commands, or just chat with me.`,
        { parse_mode: 'Markdown' },
      );
    } else {
      // Renter-facing welcome
      const chatKey = String(chatId);
      const account = this.renterChatAccounts.get(chatKey) || 'dbcinema';
      const name = account === 'leo' ? 'Leo Adams' : 'DB Cinema Rentals';
      await this.bot.sendMessage(
        chatId,
        `Hey! Welcome to the rental enquiry chat.\n\n` +
        `Just message me like you would on the platform — ask about gear, pricing, availability, delivery, anything.\n\n` +
        `This uses the exact same AI, rules, and logic as the real bot on Hygglo.\n\n` +
        `Commands:\n` +
        `/reset — clear conversation history\n` +
        `/account dbcinema — switch to DB Cinema\n` +
        `/account leo — switch to Leo Adams\n` +
        `/improve — enter improvement mode (each message becomes a high-priority rule)\n` +
        `/endimprove — exit improvement mode\n\n` +
        `Currently chatting as: ${name}`,
      );
    }
  }

  private async handleHelp(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      // Renter help
      await this.bot.sendMessage(
        msg.chat.id,
        `*Rental Enquiry Chat*\n\n` +
        `Just message me about gear, pricing, availability, delivery — anything.\n\n` +
        `Commands:\n` +
        `/reset — clear conversation history\n` +
        `/account dbcinema — switch to DB Cinema\n` +
        `/account leo — switch to Leo Adams\n` +
        `/improve — enter improvement mode\n` +
        `/endimprove — exit improvement mode`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    await this.bot.sendMessage(
      msg.chat.id,
      '*Available Commands*\n\n' +
      '*Monitoring*\n' +
      '/health - Service health check\n' +
      '/status - Scanner status\n' +
      '/stats - Rental statistics\n' +
      '/recent - Recent rentals (last 5)\n' +
      '/items - Recently extracted items\n\n' +
      '*AI & Rules*\n' +
      '/rules - List all active rules\n' +
      '/addrule <category> <text> - Add a rule\n' +
      '/removerule <id> - Deactivate a rule\n' +
      '/decisions - Recent AI decisions\n' +
      '/memory - Top memories\n' +
      '/remember <text> - Store something to memory\n' +
      '/forget <id> - Delete a memory\n' +
      '/summary - On-demand daily summary\n\n' +
      '*Calendar & Bookings*\n' +
      '/book <item> <start> <end> <renter> - Create booking\n' +
      '/unbook <id> - Cancel a booking\n' +
      '/available <item> [date] - Check availability\n' +
      '/calendar [date] - Day schedule\n' +
      '/today - Today\'s full schedule\n\n' +
      '*Blacklist*\n' +
      '/blacklist "<name>" <reason> - Blacklist renter\n' +
      '/unblacklist <name> - Remove from blacklist\n' +
      '/blacklisted - List all blacklisted\n\n' +
      '*Profit & Demand*\n' +
      '/revenue [week|month|all] - Profit summary\n' +
      '/earnings - Monthly profit\n' +
      '/demand - Demand report\n\n' +
      '*Inventory*\n' +
      '/inventory - Full inventory status with quantities & availability\n\n' +
      '*Delivery & Market*\n' +
      '/quote <postcode> <items> - Delivery quote\n' +
      '/market - Market insight report\n\n' +
      '*Simulation*\n' +
      '/simulate <dbcinema|leo> - Enter sim mode\n' +
      '/endsim - Exit sim mode\n\n' +
      '*Improvement*\n' +
      '/improve - Enter improvement mode (each message becomes a rule)\n' +
      '/endimprove - Exit improvement mode\n\n' +
      '*Monitoring & Optimization*\n' +
      '/errorlog - Error monitoring status\n' +
      '/dspy - DSPy prompt optimization status\n' +
      '/optimize [rental|pricing|delivery] - Run DSPy optimization\n\n' +
      '*AutoLearn*\n' +
      '/autolearn - AutoLearn status & quality trend\n' +
      '/veto <id> [reason] - Veto a pending proposal\n' +
      '/autolearn\\_pause - Pause analysis cycles\n' +
      '/autolearn\\_resume - Resume analysis cycles\n\n' +
      '*Vacation / Unavailability*\n' +
      '/vacation - List active unavailability blocks\n' +
      '/vacation cancel <id> - Cancel an unavailability block\n' +
      'Or just tell me: "vacation Saturday from 3pm" / "day off tomorrow" / "away Friday"\n\n' +
      '*Chat*\nJust send any message to chat with AI about your rentals.\n' +
      'I also learn from our conversations automatically.',
      { parse_mode: 'Markdown' },
    );
  }

  private async handleHealth(msg: any) {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const scannerStatus = this.rentalScannerService.getStatus();

    await this.bot.sendMessage(
      msg.chat.id,
      `💚 *Health Status*\n\n` +
      `├ ✅ Status: healthy\n` +
      `├ ⏰ Uptime: ${hours}h ${minutes}m\n` +
      `├ 📡 Scanner: ${scannerStatus.isScanning ? 'scanning' : 'idle'}\n` +
      `└ 🔑 Auth: ${scannerStatus.authenticated ? 'yes' : 'no'}` +
      (this.simulationMode.active ? `\n🎭 Simulation: ${this.simulationMode.account}` : ''),
      { parse_mode: 'Markdown' },
    );
  }

  private async handleStatus(msg: any) {
    const status = this.rentalScannerService.getStatus();
    const intervalSec = status.currentScanInterval / 1000;

    await this.bot.sendMessage(
      msg.chat.id,
      `📡 *Scanner Status*\n\n` +
      `├ ${status.isScanning ? '🔄 Scanning' : '💤 Idle'}\n` +
      `├ ⏱ Interval: ${intervalSec}s\n` +
      `├ 📅 Last activity: ${status.lastActivityTime}\n` +
      `└ 🔑 Auth: ${status.authenticated ? '✅' : '❌'}`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleStats(msg: any) {
    const total = await this.prisma.rental.count();
    const ongoing = await this.prisma.rental.count({ where: { status: 'ongoing' } });
    const upcoming = await this.prisma.rental.count({ where: { status: 'upcoming' } });
    const decisions = await this.prisma.ai_decision.count();
    const memoryCount = await this.prisma.memory.count();

    await this.bot.sendMessage(
      msg.chat.id,
      `📊 *Statistics*\n\n` +
      `├ 📦 Rentals: ${total} total (${ongoing} ongoing, ${upcoming} upcoming)\n` +
      `├ 🤖 AI Decisions: ${decisions}\n` +
      `└ 🧠 Memories: ${memoryCount}`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleRecent(msg: any) {
    const rentals = await this.prisma.rental.findMany({
      take: 5,
      orderBy: { created_at: 'desc' },
      select: {
        title: true,
        status: true,
        start_date: true,
        end_date: true,
        renter_info: true,
        listing_url: true,
      },
    });

    if (rentals.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No rentals found yet.');
      return;
    }

    const lines = rentals.map((r, i) => {
      const start = r.start_date ? r.start_date.toLocaleDateString() : '?';
      const end = r.end_date ? r.end_date.toLocaleDateString() : '?';
      return (
        `*${i + 1}. ${r.title}*\n` +
        `   ├ Status: ${r.status}\n` +
        `   ├ 📅 ${start} - ${end}\n` +
        `   └ 👤 ${r.renter_info || 'N/A'}`
      );
    });

    await this.bot.sendMessage(
      msg.chat.id,
      `📦 *Recent Rentals*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleItems(msg: any) {
    const items = await this.prisma.extracteditem.findMany({
      take: 10,
      orderBy: { created_at: 'desc' },
      select: {
        item_name: true,
        source: true,
        confidence_score: true,
        rental: { select: { title: true } },
      },
    });

    if (items.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No extracted items found yet.');
      return;
    }

    const lines = items.map((item, i) => {
      const confidence = item.confidence_score
        ? `${Math.round(item.confidence_score * 100)}%`
        : 'N/A';
      return (
        `${i + 1}. *${item.item_name}*\n` +
        `   From: ${item.rental.title}\n` +
        `   Source: ${item.source} | Confidence: ${confidence}`
      );
    });

    await this.bot.sendMessage(
      msg.chat.id,
      `*Recent Extracted Items*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' },
    );
  }

  // --- AI/Rules commands ---

  private async handleRules(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const rules = await this.rulesService.getAllActive();
    if (rules.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No active rules.');
      return;
    }

    const grouped: Record<string, { id: string; name: string; content: string }[]> = {};
    for (const r of rules) {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r);
    }

    let text = '📜 *Active Rules*\n\n';
    for (const [cat, items] of Object.entries(grouped)) {
      text += `*${cat.toUpperCase()}*\n`;
      for (const item of items) {
        const shortId = item.id.substring(0, 8);
        text += `  ├ \`${shortId}\` ${item.name}\n`;
      }
      text += '\n';
    }
    text += '_Use /removerule <id> to deactivate_';

    await this.bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  }

  private async handleAddRule(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const category = match[1].toLowerCase();
    const content = match[2];
    const validCategories = ['inventory', 'policy', 'communication', 'pricing', 'faq'];

    if (!validCategories.includes(category)) {
      await this.bot.sendMessage(
        msg.chat.id,
        `Invalid category. Use one of: ${validCategories.join(', ')}`,
      );
      return;
    }

    const name = content.split(' ').slice(0, 4).join(' ');
    const rule = await this.rulesService.addRule(category, name, content);

    await this.bot.sendMessage(
      msg.chat.id,
      `Rule added to *${category}*:\n\`${rule.id.substring(0, 8)}\` ${content}`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleRemoveRule(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const partialId = match[1];

    try {
      const rules = await this.prisma.rule.findMany({
        where: { id: { startsWith: partialId }, is_active: true },
      });

      if (rules.length === 0) {
        await this.bot.sendMessage(msg.chat.id, `No active rule found with ID starting with \`${partialId}\``);
        return;
      }

      if (rules.length > 1) {
        await this.bot.sendMessage(msg.chat.id, 'Multiple rules match. Be more specific.');
        return;
      }

      await this.rulesService.deactivateRule(rules[0].id);
      await this.bot.sendMessage(
        msg.chat.id,
        `Rule deactivated: *${rules[0].name}* (${rules[0].category})`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error removing rule: ${error.message}`);
    }
  }

  private async handleDecisions(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const decisions = await this.prisma.ai_decision.findMany({
      take: 5,
      orderBy: { created_at: 'desc' },
      include: { rental: { select: { title: true } } },
    });

    if (decisions.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No AI decisions recorded yet.');
      return;
    }

    const lines = decisions.map((d, i) => {
      const rental = d.rental ? d.rental.title : 'N/A';
      const conf = d.confidence ? `${Math.round(d.confidence * 100)}%` : 'N/A';
      const time = d.created_at.toLocaleString();
      return (
        `*${i + 1}. ${d.decision_type.toUpperCase()}*\n` +
        `   ├ 📦 ${rental}\n` +
        `   ├ 🎯 Confidence: ${conf}\n` +
        `   ├ Action: ${(d.action_taken || 'N/A').substring(0, 100)}\n` +
        `   └ ⏰ ${time}`
      );
    });

    await this.bot.sendMessage(
      msg.chat.id,
      `🤖 *Recent AI Decisions*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleMemory(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const memories = await this.memoryService.getTopMemories(10);

    if (memories.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No memories stored yet. Chat with me to build memory!');
      return;
    }

    const lines = memories.map((m, i) => {
      return (
        `${i + 1}. [${m.memory_type}] *${m.subject}*\n` +
        `   ├ ${m.content.substring(0, 80)}${m.content.length > 80 ? '...' : ''}\n` +
        `   └ ⭐ ${m.importance}/10 | Accessed: ${m.access_count}x`
      );
    });

    await this.bot.sendMessage(
      msg.chat.id,
      `🧠 *Top Memories*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleRemember(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const text = match[1].trim();
    if (!text) {
      await this.bot.sendMessage(msg.chat.id, 'Usage: /remember <something to remember>');
      return;
    }

    try {
      // Use lightweight AI to extract a good subject and classify the memory
      const response = await this.aiService.processLightweight(
        `Extract a short subject (3-6 words) and classify this memory.\n` +
        `Memory text: "${text}"\n\n` +
        `Respond ONLY in this exact format:\n` +
        `SUBJECT: <short subject>\n` +
        `TYPE: <one of: fact, preference, pattern, renter_profile>\n` +
        `IMPORTANCE: <1-10>`,
        {},
      );

      let subject = text.split(' ').slice(0, 5).join(' ');
      let memType = 'fact';
      let importance = 8;

      const subjectMatch = response.content.match(/SUBJECT:\s*(.+)/i);
      const typeMatch = response.content.match(/TYPE:\s*(\w+)/i);
      const impMatch = response.content.match(/IMPORTANCE:\s*(\d+)/i);

      if (subjectMatch) subject = subjectMatch[1].trim();
      if (typeMatch && ['fact', 'preference', 'pattern', 'renter_profile'].includes(typeMatch[1].toLowerCase())) {
        memType = typeMatch[1].toLowerCase();
      }
      if (impMatch) importance = Math.min(10, Math.max(1, parseInt(impMatch[1])));

      await this.memoryService.storeMemory(memType, subject, text, importance);

      await this.bot.sendMessage(
        msg.chat.id,
        `Stored [${memType}] "${subject}" (importance: ${importance}/10)`,
      );
    } catch (error) {
      // Fallback: store directly without AI classification
      const subject = text.split(' ').slice(0, 5).join(' ');
      await this.memoryService.storeMemory('fact', subject, text, 8);
      await this.bot.sendMessage(msg.chat.id, `Stored: "${subject}"`);
    }
  }

  private async handleForget(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const partialId = match[1];

    try {
      const memories = await this.prisma.memory.findMany({
        where: { id: { startsWith: partialId } },
      });

      if (memories.length === 0) {
        await this.bot.sendMessage(msg.chat.id, `No memory found with ID starting with \`${partialId}\``);
        return;
      }

      if (memories.length > 1) {
        await this.bot.sendMessage(msg.chat.id, 'Multiple memories match. Be more specific.');
        return;
      }

      await this.prisma.memory.delete({ where: { id: memories[0].id } });
      await this.bot.sendMessage(
        msg.chat.id,
        `Deleted memory: "${memories[0].subject}"`,
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleSummary(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    await this.bot.sendMessage(msg.chat.id, 'Generating summary...');

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [todayRentals, todayDecisions, totalRentals, totalMemories] = await Promise.all([
        this.prisma.rental.count({ where: { created_at: { gte: today } } }),
        this.prisma.ai_decision.findMany({ where: { created_at: { gte: today } } }),
        this.prisma.rental.count(),
        this.prisma.memory.count(),
      ]);

      const rules = await this.rulesService.getFormattedRules();
      const summaryPrompt =
        `Generate a concise daily summary for Bananajoe Rentals.\n\n` +
        `Today's stats:\n` +
        `- New rentals today: ${todayRentals}\n` +
        `- AI decisions today: ${todayDecisions.length}\n` +
        `- Total rentals in DB: ${totalRentals}\n` +
        `- Total memories: ${totalMemories}\n\n` +
        `Decision details:\n${todayDecisions.map((d) => `- ${d.decision_type}: ${(d.output_summary || '').substring(0, 100)}`).join('\n') || 'None'}\n\n` +
        `Provide a brief summary, any concerns, and recommendations.`;

      const response = await this.aiService.processRoutine(summaryPrompt, { rules });

      await this.bot.sendMessage(msg.chat.id, `📋 *Daily Summary*\n\n${response.content}`, { parse_mode: 'Markdown' });

      if (response.memories.length > 0) {
        await this.memoryService.processAiMemories(response.memories);
      }
    } catch (error) {
      this.logger.error(`Summary error: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, 'Error generating summary. Check logs.');
    }
  }

  // --- Phase 1A: Calendar command handlers ---

  private async handleBook(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const itemName = match[1].trim();
    const startDate = new Date(match[2]);
    const endDate = new Date(match[3]);
    const renterName = match[4].trim();

    try {
      const availability = await this.calendarService.checkAvailability(itemName, startDate, endDate);

      if (!availability.matchedItem) {
        await this.bot.sendMessage(msg.chat.id, `Item not found in inventory: "${itemName}"`);
        return;
      }

      if (!availability.available) {
        await this.bot.sendMessage(
          msg.chat.id,
          `${availability.matchedItem} is fully booked (${availability.booked}/${availability.maxQuantity}) for those dates.`,
        );
        return;
      }

      const booking = await this.calendarService.createBooking({
        item_name: itemName,
        start_date: startDate,
        end_date: endDate,
        renter_name: renterName,
        account: 'dbcinema',
      });

      await this.bot.sendMessage(
        msg.chat.id,
        `Booking created:\n` +
        `ID: \`${booking.id.substring(0, 8)}\`\n` +
        `Item: ${booking.item_name}\n` +
        `Dates: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n` +
        `Renter: ${renterName}\n` +
        `Availability: ${availability.booked + 1}/${availability.maxQuantity} booked`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error creating booking: ${error.message}`);
    }
  }

  private async handleUnbook(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const partialId = match[1];

    try {
      const cancelled = await this.calendarService.cancelBooking(partialId);

      if (!cancelled) {
        await this.bot.sendMessage(msg.chat.id, `No confirmed booking found starting with \`${partialId}\``);
        return;
      }

      await this.bot.sendMessage(
        msg.chat.id,
        `Booking cancelled:\n${cancelled.item_name} for ${cancelled.renter_name}\n(${cancelled.start_date.toISOString().split('T')[0]} - ${cancelled.end_date.toISOString().split('T')[0]})`,
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleAvailable(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const itemName = match[1].trim();
    const dateStr = match[2];

    const startDate = dateStr ? new Date(dateStr) : new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    try {
      const result = await this.calendarService.checkAvailability(itemName, startDate, endDate);

      if (!result.matchedItem) {
        await this.bot.sendMessage(msg.chat.id, `Item not found: "${itemName}"`);
        return;
      }

      const status = result.available ? 'AVAILABLE' : 'FULLY BOOKED';
      await this.bot.sendMessage(
        msg.chat.id,
        `*${result.matchedItem}*\n` +
        `Status: ${status}\n` +
        `Booked: ${result.booked}/${result.maxQuantity}\n` +
        `Date: ${startDate.toISOString().split('T')[0]}`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleCalendar(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const dateStr = match[1];
    const date = dateStr ? new Date(dateStr) : new Date();

    try {
      const schedule = await this.calendarService.getFormattedSchedule(date);
      await this.bot.sendMessage(msg.chat.id, `*Calendar*\n\n${schedule}`, { parse_mode: 'Markdown' });
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  // --- Phase 1B: Blacklist command handlers ---

  private async handleBlacklist(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const name = match[1].trim();
    const reason = match[2].trim();

    try {
      const entry = await this.blacklistService.addToBlacklist(name, reason);
      await this.bot.sendMessage(
        msg.chat.id,
        `Blacklisted: *${entry.name}*\nReason: ${entry.reason}`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleUnblacklist(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const name = match[1].trim();

    try {
      const removed = await this.blacklistService.removeFromBlacklist(name);

      if (!removed) {
        await this.bot.sendMessage(msg.chat.id, `No blacklisted renter found matching "${name}"`);
        return;
      }

      await this.bot.sendMessage(msg.chat.id, `Removed from blacklist: ${removed.name}`);
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleBlacklisted(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const entries = await this.blacklistService.getAll();

    if (entries.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No blacklisted renters.');
      return;
    }

    const lines = entries.map((e, i) =>
      `${i + 1}. 🚫 *${e.name}*\n   ├ Reason: ${e.reason}\n   └ Added: ${e.created_at.toLocaleDateString()}`,
    );

    await this.bot.sendMessage(
      msg.chat.id,
      `🚫 *Blacklisted Renters*\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' },
    );
  }

  // --- Phase 2: Demand + Revenue command handlers ---

  private async handleDemand(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    try {
      const report = await this.demandService.getFormattedDemandReport(30);
      await this.bot.sendMessage(msg.chat.id, `📈 *Demand Report*\n\n${report}`, { parse_mode: 'Markdown' });
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleRevenue(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const period = (match[1] || 'month') as 'week' | 'month' | 'all';

    try {
      const report = await this.revenueService.getFormattedRevenue(period);
      await this.bot.sendMessage(msg.chat.id, `💰 *Profit Report*\n\n${report}`, { parse_mode: 'Markdown' });
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleEarnings(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    try {
      const report = await this.revenueService.getFormattedRevenue('month');
      await this.bot.sendMessage(msg.chat.id, `💰 *Profit This Month*\n\n${report}`, { parse_mode: 'Markdown' });
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  // --- Phase 3: Today + Simulation command handlers ---

  private async handleToday(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    try {
      const today = new Date();
      const todayStart = new Date(today);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);

      const [schedule, confirmedCount, weekRevenue] = await Promise.all([
        this.calendarService.getFormattedSchedule(today),
        this.prisma.booking.count({ where: { status: 'confirmed' } }),
        this.revenueService.getRevenueForPeriod('week'),
      ]);

      // Get bookings starting today (revenue counts on start day only)
      const todayBookings = await this.prisma.booking.findMany({
        where: {
          status: 'confirmed',
          start_date: { gte: todayStart, lte: todayEnd },
        },
        orderBy: { start_date: 'asc' },
      });

      const todayEarnings = todayBookings.reduce((sum, b) => sum + (b.revenue || 0), 0);

      // Build booking lines
      const bookingLines: string[] = [];
      for (const b of todayBookings) {
        const timeParts = [
          b.pickup_time ? `pickup ${b.pickup_time}` : null,
          b.return_time ? `return ${b.return_time}` : null,
        ].filter(Boolean).join(', ');
        const timeStr = timeParts ? ` | ${timeParts}` : '';
        bookingLines.push(`  ${b.item_name} — ${b.renter_name}: £${b.revenue || 0} profit${timeStr}`);
      }

      let response = `📅 *Today's Schedule*\n\n${schedule}`;

      if (bookingLines.length > 0) {
        response += `\n\n📦 *Starting Today:*\n${bookingLines.join('\n')}`;
      }

      response += `\n\n💰 *Earnings:*`;
      response += `\n├ Today: £${Math.round(todayEarnings * 100) / 100} (${todayBookings.length} bookings)`;
      response += `\n├ Week: £${weekRevenue.totalRevenue} (${weekRevenue.bookings} bookings)`;
      response += `\n└ 📋 Active bookings: ${confirmedCount}`;

      await this.bot.sendMessage(msg.chat.id, response, { parse_mode: 'Markdown' });
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleSimulate(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const account = match[1] as 'dbcinema' | 'leo';
    this.simulationMode = { active: true, account };
    this.simConversationHistory = []; // Reset history for new sim session

    const persona = account === 'dbcinema' ? 'DB Cinema Rentals (Daniel)' : 'Leo Adams (Leo)';
    await this.bot.sendMessage(
      msg.chat.id,
      `🎭 *Simulation Mode Active*\n\n` +
      `├ 👤 Account: ${persona}\n` +
      `├ Messages treated as renter\n` +
      `└ Memory storage: OFF\n\n` +
      `Use /endsim to exit.`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleEndSim(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    if (!this.simulationMode.active) {
      await this.bot.sendMessage(msg.chat.id, 'Not in simulation mode.');
      return;
    }

    this.simulationMode = { active: false, account: null };
    this.simConversationHistory = []; // Clear sim history
    await this.bot.sendMessage(msg.chat.id, 'Simulation mode ended. Back to normal.');
  }

  // --- Improvement mode handlers ---

  private async handleImprove(msg: any) {
    const chatKey = String(msg.chat.id);

    if (this.isOwner(msg.chat.id)) {
      // Owner improvement mode (global)
      this.improvementMode = true;
    } else {
      // Non-owner: per-chat improvement mode
      this.renterImprovementModes.add(chatKey);
    }

    await this.bot.sendMessage(
      msg.chat.id,
      `🛠 *Improvement Mode Active*\n\n` +
      `Each message you send will be AI-classified and stored as a high-priority rule.\n\n` +
      `Examples:\n` +
      `├ "Never offer discounts below 10%"\n` +
      `├ "Always mention battery count for BMPCC"\n` +
      `└ "When quoting V-mounts, mention both sizes"\n\n` +
      `Use /endimprove to exit.`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleEndImprove(msg: any) {
    const chatKey = String(msg.chat.id);

    if (this.isOwner(msg.chat.id)) {
      if (!this.improvementMode) {
        await this.bot.sendMessage(msg.chat.id, 'Not in improvement mode.');
        return;
      }
      this.improvementMode = false;
    } else {
      if (!this.renterImprovementModes.has(chatKey)) {
        await this.bot.sendMessage(msg.chat.id, 'Not in improvement mode.');
        return;
      }
      this.renterImprovementModes.delete(chatKey);
    }

    await this.bot.sendMessage(msg.chat.id, 'Improvement mode ended. Rules saved.');
  }

  private async handleImprovementMessage(msg: any) {
    const text = msg.text;

    try {
      // Use AI to classify the improvement into a category and rule name
      const classificationPrompt =
        `Classify the following improvement instruction into a category and a short rule name.\n\n` +
        `Instruction: "${text}"\n\n` +
        `Available categories: communication, pricing, delivery, inventory, verification, scheduling, upselling, safety, general\n\n` +
        `Respond in EXACTLY this format (no other text):\n` +
        `CATEGORY: <category>\n` +
        `NAME: <short_rule_name_with_underscores>\n\n` +
        `Example:\n` +
        `CATEGORY: communication\n` +
        `NAME: always_mention_battery_count`;

      const response = await this.aiService.processExtraction(classificationPrompt);
      const lines = response.content.trim().split('\n');

      let category = 'general';
      let name = 'improvement_rule';

      for (const line of lines) {
        const categoryMatch = line.match(/^CATEGORY:\s*(.+)/i);
        if (categoryMatch) category = categoryMatch[1].trim().toLowerCase();
        const nameMatch = line.match(/^NAME:\s*(.+)/i);
        if (nameMatch) name = nameMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
      }

      // Add timestamp suffix to name for uniqueness
      const uniqueName = `${name}_${Date.now().toString(36)}`;

      await this.rulesService.addRule(category, uniqueName, text, 8);

      // Log explicit teaching signal in AutoLearn audit trail
      this.correctionDetector.processMessage(text, true).catch(err =>
        this.logger.debug(`Correction detector (explicit): ${err.message}`),
      );

      await this.bot.sendMessage(
        msg.chat.id,
        `✅ Rule stored\n\n` +
        `├ Category: ${category}\n` +
        `├ Name: ${uniqueName}\n` +
        `├ Priority: 8 (high)\n` +
        `└ Content: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      this.logger.error(`Improvement classification failed: ${error.message}`);
      // Fallback: store as general rule without AI classification
      const fallbackName = `improvement_${Date.now().toString(36)}`;
      try {
        await this.rulesService.addRule('general', fallbackName, text, 8);
        await this.bot.sendMessage(
          msg.chat.id,
          `✅ Rule stored (fallback)\n├ Category: general\n└ Name: ${fallbackName}`,
        );
      } catch (fallbackErr) {
        await this.bot.sendMessage(msg.chat.id, `Failed to store rule: ${fallbackErr.message}`);
      }
    }
  }

  // --- AutoLearn Engine commands ---

  private async handleAutolearn(msg: any) {
    try {
      const status = await this.autolearnService.getStatus();
      const stateEmoji = status.paused ? '⏸️' : (status.enabled ? '✅' : '❌');
      const stateText = status.paused ? 'Paused' : (status.enabled ? 'Active' : 'Disabled');

      await this.bot.sendMessage(
        msg.chat.id,
        `*AutoLearn Engine* ${stateEmoji}\n\n` +
        `Status: ${stateText}\n` +
        `Proposals today: ${status.todayProposals}\n` +
        `Pending: ${status.pendingProposals}\n` +
        `Reworking: ${status.reworkingProposals}\n` +
        `Failed (needs review): ${status.failedProposals}\n` +
        `Quality (24h): ${status.qualityTrend?.toFixed(2) || 'N/A'}\n\n` +
        `Commands:\n` +
        `/veto <id> [reason] - Veto a proposal\n` +
        `/autolearn\\_pause - Pause cycles\n` +
        `/autolearn\\_resume - Resume cycles`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      await this.bot.sendMessage(msg.chat.id, `AutoLearn status error: ${err.message}`);
    }
  }

  private async handleVeto(msg: any, match: any) {
    const shortId = match[1];
    const reason = match[2] || undefined;

    try {
      const result = await this.autolearnService.vetoProposal(shortId, reason);
      await this.bot.sendMessage(msg.chat.id, result);
    } catch (err) {
      await this.bot.sendMessage(msg.chat.id, `Veto failed: ${err.message}`);
    }
  }

  private async handleAutolearnPause(msg: any) {
    await this.autolearnService.pause();
    await this.bot.sendMessage(msg.chat.id, 'AutoLearn paused. Use /autolearn\\_resume to resume.');
  }

  private async handleAutolearnResume(msg: any) {
    await this.autolearnService.resume();
    await this.bot.sendMessage(msg.chat.id, 'AutoLearn resumed.');
  }

  // --- Unified renter message handling (replaces separate renter bot) ---

  private async handleRenterMessage(msg: any) {
    const chatKey = String(msg.chat.id);
    const userText = msg.text;

    // Improvement mode for non-owner users
    if (this.renterImprovementModes.has(chatKey)) {
      await this.handleRenterImprovementMessage(msg);
      return;
    }

    // Get or create per-chat conversation history
    if (!this.renterChatHistories.has(chatKey)) {
      this.renterChatHistories.set(chatKey, []);
    }
    const history = this.renterChatHistories.get(chatKey)!;
    const account = this.renterChatAccounts.get(chatKey) || 'dbcinema';

    try {
      const result = await this.processRenterConversation(userText, account, history);
      if (!result) return;

      // Send clean response (no quality info — just the raw reply)
      await this.bot.sendMessage(msg.chat.id, result.rawContent);
    } catch (error) {
      this.logger.error(`Renter message error: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, 'Sorry, something went wrong. Try again.');
    }
  }

  // === Vacation / Owner Unavailability ===

  /**
   * Parse natural language vacation intent from owner messages.
   * Detects: "vacation Saturday from 10:30", "day off tomorrow", "away Friday afternoon", "free from 3pm today"
   */
  private parseVacationIntent(text: string): { start_time: Date; end_time: Date | null; reason: string; all_day: boolean } | null {
    const lower = text.toLowerCase().trim();

    // Trigger words — natural conversational phrases for setting unavailability
    const triggerPattern = /\b(vacation|day off|away|unavailable|not working|off work|free day|taking off|out of office|holiday|on leave|on break|no pickups|can'?t do pickups|won'?t be around|won'?t be available|i'?m off|going away|stepping out|not around|not in)\b/i;
    if (!triggerPattern.test(lower)) return null;

    const now = new Date();

    // Detect day reference
    let targetDate: Date | null = null;
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    // Check for specific day names
    for (let i = 0; i < dayNames.length; i++) {
      if (lower.includes(dayNames[i])) {
        targetDate = this.getNextDayOfWeek(i);
        break;
      }
    }

    // Check for "today" / "tomorrow"
    if (lower.includes('today')) {
      targetDate = new Date(now);
    } else if (lower.includes('tomorrow')) {
      targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + 1);
    }

    // Check for date ordinals like "8th", "15th", "22nd"
    if (!targetDate) {
      const ordinalMatch = lower.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
      if (ordinalMatch) {
        const dayNum = parseInt(ordinalMatch[1], 10);
        targetDate = new Date(now);
        targetDate.setDate(dayNum);
        // If day is in the past this month, use next month
        if (targetDate < now) {
          targetDate.setMonth(targetDate.getMonth() + 1);
        }
      }
    }

    // Check for YYYY-MM-DD or DD/MM format
    if (!targetDate) {
      const isoMatch = lower.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (isoMatch) {
        targetDate = new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
      }
    }

    if (!targetDate) return null;

    // Detect time: "from 10:30", "after 3pm", "from 3pm", "at 15:00", "onwards from 10:30"
    let startHour = 0;
    let startMin = 0;
    let hasTime = false;

    const timePatterns = [
      /(?:from|after|at|starting)\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i,
      /(?:from|after|at|starting)\s+(\d{1,2})\s*(am|pm)/i,
      /(\d{1,2}):(\d{2})\s*(am|pm)?\s*(?:onwards|onward)/i,
      /(\d{1,2})\s*(am|pm)\s*(?:onwards|onward)/i,
    ];

    for (const pattern of timePatterns) {
      const match = lower.match(pattern);
      if (match) {
        startHour = parseInt(match[1], 10);
        startMin = match[2] && !['am', 'pm'].includes(match[2].toLowerCase()) ? parseInt(match[2], 10) : 0;
        const meridiem = match[3] || match[2];
        if (meridiem && typeof meridiem === 'string') {
          if (meridiem.toLowerCase() === 'pm' && startHour < 12) startHour += 12;
          if (meridiem.toLowerCase() === 'am' && startHour === 12) startHour = 0;
        }
        hasTime = true;
        break;
      }
    }

    // Detect "afternoon" / "morning" / "evening"
    if (!hasTime) {
      if (lower.includes('afternoon')) { startHour = 12; hasTime = true; }
      else if (lower.includes('morning')) { startHour = 0; hasTime = true; }
      else if (lower.includes('evening')) { startHour = 17; hasTime = true; }
    }

    // Detect end time
    let endTime: Date | null = null;
    const endTimePatterns = [
      /(?:until|to|till)\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i,
      /(?:until|to|till)\s+(\d{1,2})\s*(am|pm)/i,
    ];
    for (const pattern of endTimePatterns) {
      const match = lower.match(pattern);
      if (match) {
        let endH = parseInt(match[1], 10);
        const endM = match[2] && !['am', 'pm'].includes(match[2].toLowerCase()) ? parseInt(match[2], 10) : 0;
        const endMeridiem = match[3] || match[2];
        if (endMeridiem && typeof endMeridiem === 'string') {
          if (endMeridiem.toLowerCase() === 'pm' && endH < 12) endH += 12;
          if (endMeridiem.toLowerCase() === 'am' && endH === 12) endH = 0;
        }
        endTime = new Date(targetDate);
        endTime.setHours(endH, endM, 0, 0);
        break;
      }
    }

    const allDay = !hasTime;
    const startTime = new Date(targetDate);
    if (hasTime) {
      startTime.setHours(startHour, startMin, 0, 0);
    } else {
      startTime.setHours(0, 0, 0, 0);
    }

    // Extract reason — use the trigger word
    const reasonMatch = lower.match(triggerPattern);
    const reason = reasonMatch ? reasonMatch[1] : 'personal';

    return { start_time: startTime, end_time: endTime, reason, all_day: allDay };
  }

  private getNextDayOfWeek(dayIndex: number): Date {
    const now = new Date();
    const current = now.getDay();
    let daysAhead = dayIndex - current;
    if (daysAhead <= 0) daysAhead += 7;
    const target = new Date(now);
    target.setDate(target.getDate() + daysAhead);
    return target;
  }

  /**
   * Handle vacation intent detected from chat message.
   */
  private async handleVacationFromChat(msg: any, intent: { start_time: Date; end_time: Date | null; reason: string; all_day: boolean }) {
    try {
      const record = await this.calendarService.createUnavailability({
        start_time: intent.start_time,
        end_time: intent.end_time,
        reason: intent.reason,
        all_day: intent.all_day,
      });

      const dayStr = intent.start_time.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
      let timeDesc: string;
      if (intent.all_day) {
        timeDesc = 'all day';
      } else {
        const startStr = `${String(intent.start_time.getHours()).padStart(2, '0')}:${String(intent.start_time.getMinutes()).padStart(2, '0')}`;
        timeDesc = intent.end_time
          ? `${startStr} to ${String(intent.end_time.getHours()).padStart(2, '0')}:${String(intent.end_time.getMinutes()).padStart(2, '0')}`
          : `${startStr} onwards`;
      }

      // Check for booking conflicts
      const conflicts = await this.getVacationConflicts(intent.start_time, intent.end_time);
      let conflictWarning = '';
      if (conflicts.length > 0) {
        conflictWarning = `\n\n⚠️ *Booking conflicts:*\n`;
        for (const c of conflicts) {
          conflictWarning += `- ${c.item_name} (${c.renter_name}) pickup ${c.pickup_time || 'TBC'} / return ${c.return_time || 'TBC'}\n`;
        }
        conflictWarning += `\nThese renters may need their times adjusted.`;
      }

      await this.bot.sendMessage(
        msg.chat.id,
        `✅ *Unavailability saved*\n\n` +
        `📅 ${dayStr}\n` +
        `⏰ ${timeDesc}\n` +
        `📝 ${intent.reason}\n` +
        `🔑 ID: \`${record.id.substring(0, 8)}\`\n\n` +
        `Schedule, auto-assign, and renter AI will respect this.` +
        conflictWarning,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      this.logger.error(`Vacation save error: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, `Failed to save unavailability: ${error.message}`);
    }
  }

  /**
   * Find bookings with pickups/returns overlapping a vacation window.
   */
  private async getVacationConflicts(startTime: Date, endTime: Date | null): Promise<any[]> {
    const dayStart = new Date(startTime);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(startTime);
    dayEnd.setHours(23, 59, 59, 999);

    // Use actual pickup/return dates when available (pickup_date/return_date > start_date/end_date)
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        OR: [
          { pickup_date: { gte: dayStart, lte: dayEnd } },
          { pickup_date: null, start_date: { gte: dayStart, lte: dayEnd } },
          { return_date: { gte: dayStart, lte: dayEnd } },
          { return_date: null, end_date: { gte: dayStart, lte: dayEnd } },
        ],
      },
    });

    if (bookings.length === 0) return [];

    // Deduplicate (OR query can match same booking multiple ways)
    const seen = new Set<string>();
    const unique = bookings.filter(b => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });

    // Filter to bookings with times overlapping the vacation window
    const vacStartMin = startTime.getHours() * 60 + startTime.getMinutes();
    const vacEndMin = endTime ? endTime.getHours() * 60 + endTime.getMinutes() : 24 * 60;

    return unique.filter(b => {
      // Check pickup time (using actual pickup date when available)
      const effectivePickupDate = b.pickup_date || b.start_date;
      if (b.pickup_time && effectivePickupDate >= dayStart && effectivePickupDate <= dayEnd) {
        const [h, m] = b.pickup_time.split(':').map(Number);
        const timeMin = h * 60 + m;
        if (timeMin >= vacStartMin && timeMin <= vacEndMin) return true;
      }
      // Check return time (using actual return date when available)
      const effectiveReturnDate = b.return_date || b.end_date;
      if (b.return_time && effectiveReturnDate >= dayStart && effectiveReturnDate <= dayEnd) {
        const [h, m] = b.return_time.split(':').map(Number);
        const timeMin = h * 60 + m;
        if (timeMin >= vacStartMin && timeMin <= vacEndMin) return true;
      }
      return false;
    });
  }

  private async handleVacationList(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    try {
      const blocks = await this.calendarService.getActiveUnavailabilities();
      if (blocks.length === 0) {
        await this.bot.sendMessage(msg.chat.id, 'No active unavailability blocks.');
        return;
      }

      const lines = blocks.map(b => {
        const dayStr = b.start_time.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        let timeDesc: string;
        if (b.all_day) {
          timeDesc = 'ALL DAY';
        } else {
          const startStr = `${String(b.start_time.getHours()).padStart(2, '0')}:${String(b.start_time.getMinutes()).padStart(2, '0')}`;
          const endStr = b.end_time
            ? `${String(b.end_time.getHours()).padStart(2, '0')}:${String(b.end_time.getMinutes()).padStart(2, '0')}`
            : 'onwards';
          timeDesc = `${startStr} ${endStr === 'onwards' ? 'onwards' : `to ${endStr}`}`;
        }
        return `\`${b.id.substring(0, 8)}\` ${dayStr} ${timeDesc}${b.reason ? ` (${b.reason})` : ''}`;
      });

      await this.bot.sendMessage(
        msg.chat.id,
        `*Active Unavailability Blocks*\n\n${lines.join('\n')}\n\nCancel: /vacation cancel <id>`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleVacationCancel(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    try {
      const partialId = match[1];
      const cancelled = await this.calendarService.cancelUnavailability(partialId);
      if (!cancelled) {
        await this.bot.sendMessage(msg.chat.id, 'No matching active unavailability block found.');
        return;
      }
      await this.bot.sendMessage(
        msg.chat.id,
        `✅ Unavailability block \`${cancelled.id.substring(0, 8)}\` cancelled.`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleRenterReset(msg: any) {
    if (this.isOwner(msg.chat.id)) return; // Owner has own /reset
    const chatKey = String(msg.chat.id);
    this.renterChatHistories.delete(chatKey);
    await this.bot.sendMessage(msg.chat.id, 'Conversation reset. Send a new message to start fresh.');
  }

  private async handleRenterAccount(msg: any, match: any) {
    if (this.isOwner(msg.chat.id)) return; // Owner uses /simulate
    const chatKey = String(msg.chat.id);
    const account = match[1] as 'dbcinema' | 'leo';
    this.renterChatAccounts.set(chatKey, account);
    this.renterChatHistories.delete(chatKey); // Reset history on account switch
    const name = account === 'leo' ? 'Leo Adams' : 'DB Cinema Rentals';
    await this.bot.sendMessage(msg.chat.id, `Switched to ${name}. Conversation reset.`);
  }

  private async handleRenterImprovementMessage(msg: any) {
    const text = msg.text;
    try {
      const classificationPrompt =
        `Classify the following improvement instruction into a category and a short rule name.\n\n` +
        `Instruction: "${text}"\n\n` +
        `Available categories: communication, pricing, delivery, inventory, verification, scheduling, upselling, safety, general\n\n` +
        `Respond in EXACTLY this format (no other text):\n` +
        `CATEGORY: <category>\n` +
        `NAME: <short_rule_name_with_underscores>`;

      const response = await this.aiService.processExtraction(classificationPrompt);
      const lines = response.content.trim().split('\n');
      let category = 'general';
      let name = 'improvement_rule';
      for (const line of lines) {
        const categoryMatch = line.match(/^CATEGORY:\s*(.+)/i);
        if (categoryMatch) category = categoryMatch[1].trim().toLowerCase();
        const nameMatch = line.match(/^NAME:\s*(.+)/i);
        if (nameMatch) name = nameMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
      }
      const uniqueName = `${name}_${Date.now().toString(36)}`;
      await this.rulesService.addRule(category, uniqueName, text, 8);
      await this.bot.sendMessage(
        msg.chat.id,
        `✅ Rule stored\n\nCategory: ${category}\nName: ${uniqueName}\nPriority: 8 (high)\nContent: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`,
      );
    } catch (error) {
      this.logger.error(`Improvement classification failed: ${error.message}`);
      const fallbackName = `improvement_${Date.now().toString(36)}`;
      try {
        await this.rulesService.addRule('general', fallbackName, text, 8);
        await this.bot.sendMessage(msg.chat.id, `✅ Rule stored (fallback)\nCategory: general\nName: ${fallbackName}`);
      } catch (fallbackErr) {
        await this.bot.sendMessage(msg.chat.id, `Failed to store rule: ${fallbackErr.message}`);
      }
    }
  }

  // --- Phase 4: Delivery + Market command handlers ---

  private async handleQuote(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const postcode = match[1].trim();
    const itemsStr = match[2].trim();
    const itemNames = itemsStr.split(',').map((s: string) => s.trim()).filter(Boolean);

    if (itemNames.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'Usage: /quote <postcode> <item1>, <item2>, ...');
      return;
    }

    await this.bot.sendMessage(msg.chat.id, 'Calculating delivery quote...');

    try {
      const quote = await this.deliveryService.calculateQuote(postcode, itemNames);

      if (!quote) {
        await this.bot.sendMessage(msg.chat.id, `Invalid postcode: ${postcode}`);
        return;
      }

      const itemLines = quote.items
        .map((i) => {
          const tag = i.is_heavy_large ? ' [HEAVY]' : '';
          return `  ├ ${i.name} (size: ${i.size_score}/5, ${i.weight_kg}kg)${tag}`;
        })
        .join('\n');

      await this.bot.sendMessage(
        msg.chat.id,
        `🚚 *Delivery Quote*\n\n` +
        `├ 📍 ${postcode} (${quote.distance_km}km)\n` +
        `├ 🗺 Zone: ${quote.zone}\n` +
        `├ 🚗 Courier: ${quote.vehicle_display || quote.vehicle}\n` +
        `├ 💡 ${quote.courier_explanation}\n` +
        `├ 💰 Price: £${quote.price_min} - £${quote.price_max}\n\n` +
        `📦 *Items:*\n${itemLines}\n\n` +
        `📝 *Notes:*\n${quote.notes.map((n) => `├ ${n}`).join('\n')}\n\n` +
        `_Estimates accurate within ~15%_`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleMarket(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    await this.bot.sendMessage(msg.chat.id, 'Generating market report...');

    try {
      const report = await this.marketService.getOnDemandReport();
      await this.bot.sendMessage(
        msg.chat.id,
        `📈 *Market Insight Report*\n\n${report}`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error generating market report: ${error.message}`);
    }
  }

  // --- Inventory command ---

  private async handleInventory(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    try {
      const inventoryStatus = await this.calendarService.getFullInventoryStatus(7);

      // Split into chunks if too long for Telegram (4096 char limit)
      if (inventoryStatus.length > 4000) {
        const lines = inventoryStatus.split('\n');
        let chunk = '';
        for (const line of lines) {
          if (chunk.length + line.length + 1 > 4000) {
            await this.bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
            chunk = '';
          }
          chunk += line + '\n';
        }
        if (chunk.trim()) {
          await this.bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
        }
      } else {
        await this.bot.sendMessage(msg.chat.id, `📦 *Inventory*\n\n${inventoryStatus}`, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  // --- Monitoring & Optimization commands ---

  private async handleErrorLog(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    try {
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);

      const [
        totalDecisions,
        blockedDecisions,
        totalErrors,
        exceptions,
        qualityWarnings,
        validationFailures,
        slowApis,
        pendingAnalysis,
      ] = await Promise.all([
        this.prisma.ai_decision.count({
          where: { created_at: { gte: oneDayAgo } },
        }),
        this.prisma.ai_decision.count({
          where: {
            created_at: { gte: oneDayAgo },
            action_taken: { contains: 'BLOCKED', mode: 'insensitive' },
          },
        }),
        this.prisma.error_log.count({
          where: { created_at: { gte: oneDayAgo } },
        }),
        this.prisma.error_log.count({
          where: { created_at: { gte: oneDayAgo }, error_type: 'exception' },
        }),
        this.prisma.error_log.count({
          where: { created_at: { gte: oneDayAgo }, error_type: 'quality_warning' },
        }),
        this.prisma.error_log.count({
          where: { created_at: { gte: oneDayAgo }, error_type: 'validation_failure' },
        }),
        this.prisma.error_log.count({
          where: { created_at: { gte: oneDayAgo }, error_type: 'slow_api' },
        }),
        this.prisma.error_log.count({
          where: { feedback_analyzed: false },
        }),
      ]);

      const errorRate = totalDecisions > 0 ? ((blockedDecisions / totalDecisions) * 100).toFixed(1) : '0';

      await this.bot.sendMessage(
        msg.chat.id,
        `*Error Monitoring*\n\n` +
        `*Last 24h — AI Decisions:*\n` +
        `├ Total: ${totalDecisions}\n` +
        `├ Blocked: ${blockedDecisions}\n` +
        `└ Block rate: ${errorRate}%\n\n` +
        `*Last 24h — Application Errors:*\n` +
        `├ Total: ${totalErrors}\n` +
        `├ Exceptions: ${exceptions}\n` +
        `├ Quality warnings: ${qualityWarnings}\n` +
        `├ Validation failures: ${validationFailures}\n` +
        `└ Slow API calls: ${slowApis}\n\n` +
        `*Pipeline:*\n` +
        `├ Pending analysis: ${pendingAnalysis}\n` +
        `└ Status: ${pendingAnalysis > 50 ? 'Backlog building' : 'Healthy'}\n\n` +
        `_Errors stored locally in error\\_log table. Analyzed daily at 2 AM._`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async handleDspy(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    try {
      const health = await this.dspyService.getHealth();

      if (!this.dspyService.isEnabled()) {
        // Even when DSPy is disabled, show AI performance stats
        const aiStats = await this.getAiPerformanceStats();
        await this.bot.sendMessage(
          msg.chat.id,
          `*AI Performance Dashboard*\n\n` +
          `⚡ DSPy: Disabled\n\n` +
          aiStats +
          `\n_Set DSPY\\_ENABLED=true to enable DSPy optimization._`,
          { parse_mode: 'Markdown' },
        );
        return;
      }

      const statusEmoji = health.healthy ? '🟢' : '🔴';
      const lastOpt = health.lastOptimized
        ? new Date(health.lastOptimized).toLocaleString()
        : 'Never';

      // Get additional status
      const status = await this.dspyService.getStatus();
      const modules = status.optimized_modules || {};
      const moduleLines = Object.entries(modules).map(([name, data]: [string, any]) =>
        `  ├ ${name}: quality ${(data.quality_score != null ? (data.quality_score * 100).toFixed(0) : 'N/A')}%, ${data.training_examples || 0} examples`,
      );

      const aiStats = await this.getAiPerformanceStats();

      await this.bot.sendMessage(
        msg.chat.id,
        `*AI Performance Dashboard*\n\n` +
        `*DSPy Optimizer*\n` +
        `├ ${statusEmoji} Service: ${health.healthy ? 'Running' : 'Offline'}\n` +
        `├ Last optimized: ${lastOpt}\n` +
        `├ Training examples: ${health.trainingExamples}\n` +
        `└ Token savings: ${health.tokenSavingsPct}%\n` +
        (moduleLines.length > 0 ? `\n*Modules:*\n${moduleLines.join('\n')}\n` : '') +
        `\n` + aiStats +
        `\n_Use /optimize [rental|pricing|delivery] to run optimization._`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
  }

  private async getAiPerformanceStats(): Promise<string> {
    try {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Today's decisions
      const todayDecisions = await this.prisma.ai_decision.count({
        where: { created_at: { gte: today }, decision_type: 'message' },
      });
      const todaySent = await this.prisma.ai_decision.count({
        where: { created_at: { gte: today }, decision_type: 'message', was_sent: true },
      });
      const todayBlocked = await this.prisma.ai_decision.count({
        where: { created_at: { gte: today }, decision_type: 'message', was_sent: false },
      });

      // Quality scores today
      const todayQuality: { avg: number | null }[] = await this.prisma.$queryRaw`
        SELECT AVG(rq.overall_quality)::float AS avg
        FROM response_quality rq
        JOIN ai_decision ad ON ad.id = rq.ai_decision_id
        WHERE ad.created_at >= ${today} AND ad.decision_type = 'message'
      `;
      const avgQuality = todayQuality[0]?.avg;

      // Weekly trend
      const weekQuality: { avg: number | null }[] = await this.prisma.$queryRaw`
        SELECT AVG(rq.overall_quality)::float AS avg
        FROM response_quality rq
        JOIN ai_decision ad ON ad.id = rq.ai_decision_id
        WHERE ad.created_at >= ${weekAgo} AND ad.decision_type = 'message'
      `;
      const weekAvg = weekQuality[0]?.avg;

      // Model breakdown today
      const modelBreakdown: { model: string; cnt: string }[] = await this.prisma.$queryRaw`
        SELECT
          CASE
            WHEN action_taken LIKE '%Sonnet%' THEN 'Sonnet'
            WHEN action_taken LIKE '%DSPy%' THEN 'DSPy'
            ELSE 'Haiku'
          END AS model,
          COUNT(*)::text AS cnt
        FROM ai_decision
        WHERE created_at >= ${today} AND decision_type = 'message'
        GROUP BY 1 ORDER BY cnt DESC
      `;

      // Confidence distribution
      const highConf = await this.prisma.ai_decision.count({
        where: { created_at: { gte: today }, decision_type: 'message', confidence: { gte: 0.8 } },
      });

      const qualityStr = avgQuality != null ? `${Math.round(avgQuality * 100)}%` : 'N/A';
      const weekStr = weekAvg != null ? `${Math.round(weekAvg * 100)}%` : 'N/A';
      const trendEmoji = avgQuality != null && weekAvg != null
        ? (avgQuality > weekAvg ? '📈' : avgQuality < weekAvg - 0.02 ? '📉' : '➡️')
        : '';

      const modelStr = modelBreakdown.map(m => `${m.model}: ${m.cnt}`).join(', ') || 'none';
      const autoRate = todayDecisions > 0 ? Math.round((todaySent / todayDecisions) * 100) : 0;

      return `*Today's AI Stats*\n` +
        `├ Messages: ${todayDecisions} (${todaySent} sent, ${todayBlocked} blocked)\n` +
        `├ Auto-send rate: ${autoRate}%\n` +
        `├ Avg quality: ${qualityStr} ${trendEmoji} (week: ${weekStr})\n` +
        `├ High confidence: ${highConf}/${todayDecisions}\n` +
        `├ Models: ${modelStr}\n`;
    } catch (err) {
      return `_Stats unavailable: ${err.message}_\n`;
    }
  }

  private async handleOptimize(msg: any, match: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    if (!this.dspyService.isEnabled()) {
      await this.bot.sendMessage(
        msg.chat.id,
        'DSPy is disabled. Set DSPY_ENABLED=true in .env and start the Python service.',
      );
      return;
    }

    const moduleType = (match[1] || 'rental') as 'rental' | 'pricing' | 'delivery';

    await this.bot.sendMessage(
      msg.chat.id,
      `Starting DSPy optimization for *${moduleType}* module...\n_This may take a few moments._`,
      { parse_mode: 'Markdown' },
    );

    try {
      const result = await this.dspyService.runOptimization(moduleType);

      if (!result.success) {
        await this.bot.sendMessage(
          msg.chat.id,
          `Optimization failed: ${result.error}`,
        );
        return;
      }

      const qualityEmoji = result.meetsTarget ? '✅' : '⚠️';

      await this.bot.sendMessage(
        msg.chat.id,
        `*DSPy Optimization Complete*\n\n` +
        `├ Module: ${result.moduleType}\n` +
        `├ Training examples: ${result.trainingExamples}\n` +
        `├ ${qualityEmoji} Quality: ${(result.validationQuality * 100).toFixed(1)}%\n` +
        `├ Token savings: ~${result.estimatedTokenSavingsPct}%\n` +
        `└ Meets target: ${result.meetsTarget ? 'Yes' : 'No'}`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      this.errorLogService.captureError(error, {
        operation: 'dspy_optimization',
        module_type: moduleType,
      });
      await this.bot.sendMessage(msg.chat.id, `Optimization error: ${error.message}`);
    }
  }

  // --- Alpha: Auth cycle test ---

  private async handleTestAuthCycle(msg: any) {
    if (!this.isOwner(msg.chat.id)) {
      await this.bot.sendMessage(msg.chat.id, 'Unauthorized.');
      return;
    }

    const accounts = this.hyggloService.getAccounts();
    if (accounts.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No Hygglo accounts configured.');
      return;
    }

    await this.bot.sendMessage(
      msg.chat.id,
      `🔑 *Auth Cycle Test*\nTesting ${accounts.length} account(s): ${accounts.map(a => a.label).join(', ')}...`,
      { parse_mode: 'Markdown' },
    );

    const results: string[] = [];

    for (const account of accounts) {
      const startTime = Date.now();
      try {
        const authed = await this.hyggloService.authenticate(account);
        if (!authed) {
          results.push(`${account.label}: AUTH FAILED`);
          continue;
        }

        const ongoing = await this.hyggloService.scanRentals('ongoing');
        const upcoming = await this.hyggloService.scanRentals('upcoming');
        await this.hyggloService.logout();

        const duration = Date.now() - startTime;
        results.push(`${account.label}: ${ongoing.length} ongoing, ${upcoming.length} upcoming (${duration}ms)`);
      } catch (error) {
        const duration = Date.now() - startTime;
        results.push(`${account.label}: ERROR - ${error.message} (${duration}ms)`);
        try { await this.hyggloService.logout(); } catch { /* ignore */ }
      }
    }

    // Re-login to first account to verify session handling
    if (accounts.length > 0) {
      try {
        const reAuth = await this.hyggloService.authenticate(accounts[0]);
        results.push(`Re-login ${accounts[0].label}: ${reAuth ? 'OK' : 'FAILED'}`);
        await this.hyggloService.logout();
      } catch (error) {
        results.push(`Re-login ${accounts[0].label}: ERROR - ${error.message}`);
      }
    }

    await this.bot.sendMessage(
      msg.chat.id,
      `🔑 *Auth Cycle Results*\n\n${results.join('\n')}`,
      { parse_mode: 'Markdown' },
    );
  }

  // --- Roleplay detection for auto-entering simulation mode ---

  private detectRoleplayIntent(text: string): { account: 'dbcinema' | 'leo'; renterMessage: string | null } | null {
    const lower = text.toLowerCase();

    // Detect "roleplay as leo/daniel", "you are leo/daniel", "pretend you're leo", "simulate leo", etc.
    const leoPatterns = /(?:roleplay|role.?play|pretend|act|simulate|you\s*(?:are|'re)\s+leo|as\s+leo)/i;
    const danielPatterns = /(?:roleplay|role.?play|pretend|act|simulate|you\s*(?:are|'re)\s+daniel|as\s+daniel|as\s+db\s*cinema)/i;

    let account: 'dbcinema' | 'leo' | null = null;

    if (leoPatterns.test(text)) {
      account = 'leo';
    } else if (danielPatterns.test(text)) {
      account = 'dbcinema';
    }

    if (!account) return null;

    // Try to extract the actual renter message after the preamble
    // e.g. "roleplay you are leo and I'm a renter, I want 1x ND filter Saturday"
    const renterMsgMatch = text.match(/(?:i\s*(?:want|need|'m\s*(?:looking|interested|after))|my\s*name\s*is|can\s*i|do\s*you\s*have|is\s*the|how\s*much)(.*)/is);
    const renterMessage = renterMsgMatch
      ? renterMsgMatch[0].trim()
      : null;

    return { account, renterMessage };
  }

  // --- Scam detection for simulation mode ---

  private detectSimScamPattern(message: string): {
    isScam: boolean;
    matchedPattern?: string;
    severity?: string;
    score?: number;
  } {
    const text = message.toLowerCase();
    let totalScore = 0;
    const matchedPatterns: string[] = [];

    const confirmedScamPatterns = [
      { pattern: /we\s+are\s+the\s+hygglo\s+security/i, label: 'hygglo security impersonation' },
      { pattern: /security\s+team\s+requires/i, label: 'security team impersonation' },
      { pattern: /verification\s+payment\s+required/i, label: 'verification payment scam' },
      { pattern: /platform\s+requires\s+you\s+to\s+pay/i, label: 'platform payment scam' },
      { pattern: /crypto\s+payment/i, label: 'crypto payment' },
      { pattern: /gift\s+card/i, label: 'gift card scam' },
      { pattern: /wire\s+transfer/i, label: 'wire transfer' },
      { pattern: /click\s+this\s+link\s+to\s+(pay|verify)/i, label: 'suspicious link' },
    ];

    for (const { pattern, label } of confirmedScamPatterns) {
      if (pattern.test(text)) {
        totalScore += 10;
        matchedPatterns.push(label);
      }
    }

    const likelyScamPatterns = [
      { pattern: /send\s+payment/i, label: 'send payment' },
      { pattern: /pay\s+via(?!\s+(hygglo|the\s+platform|the\s+app|fat\s+llama))/i, label: 'pay via (off-platform)' },
      { pattern: /transfer\s+money/i, label: 'transfer money' },
      { pattern: /bank\s+details\s+needed/i, label: 'bank details needed' },
      { pattern: /pay\s+(me|us)\s+directly/i, label: 'pay directly' },
    ];

    for (const { pattern, label } of likelyScamPatterns) {
      if (pattern.test(text)) {
        totalScore += 5;
        matchedPatterns.push(label);
      }
    }

    if (totalScore === 0) return { isScam: false };

    return {
      isScam: totalScore >= 5,
      matchedPattern: matchedPatterns.join(', '),
      severity: totalScore >= 10 ? 'confirmed_scam' : 'likely_scam',
      score: totalScore,
    };
  }
}
