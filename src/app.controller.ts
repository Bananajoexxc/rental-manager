import { Body, Controller, Req, Res, Get, Post, Patch, Delete, Query, Param, Header, Headers, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

/** Generate a short ETag from JSON-serializable data */
function generateETag(data: any): string {
  const hash = crypto.createHash('md5').update(JSON.stringify(data)).digest('hex').substring(0, 16);
  return `"${hash}"`;
}

/** Send response with ETag — returns 304 if client has matching ETag */
function sendWithETag(res: Response, data: any, ifNoneMatch?: string): void {
  const etag = generateETag(data);
  res.setHeader('ETag', etag);
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.status(304).end();
    return;
  }
  res.json(data);
}
import * as path from 'path';
import { AppService } from './app.service';
import { AiService } from './ai/ai.service';
import { RulesService } from './rules/rules.service';
import { MemoryService } from './memory/memory.service';
import { CalendarService } from './calendar/calendar.service';
import { BlacklistService } from './blacklist/blacklist.service';
import { PrismaService } from './prisma/prisma.service';
import { TelegramService } from './telegram/telegram.service';
import { RevenueService } from './revenue/revenue.service';
import { TaxReportService } from './revenue/tax-report.service';
import { TitleParserService } from './revenue/title-parser.service';
import { ItemResolverService } from './item-resolver/item-resolver.service';
import { HyggloService } from './hygglo/hygglo.service';
import { ACCESSORY_ITEMS, isAccessoryItem, MASTER_INVENTORY } from './utils/item-matcher';
import { PRICING_CATALOG, getItemPrice } from './data/pricing-catalog';
import { checkCompatibilityConflicts, detectMissingEssentials, formatCompatibilityForAI } from './data/item-compatibility';
import { ToolHandlers } from './ai/ai.service';
import { LostRevenueService } from './lost-revenue/lost-revenue.service';
import { AutonomousService } from './autonomous/autonomous.service';
import { CompetitorIntelService } from './competitor-intel/competitor-intel.service';
import { MarketReleasesService } from './market/market-releases.service';
import { ConversationStageService } from './conversation-tree/conversation-stage.service';
import { ItemMatcherAiService } from './item-matcher-ai/item-matcher-ai.service';
import { SellRecommenderService } from './sell-recommender/sell-recommender.service';
import { ListingCreatorService } from './listing-creator/listing-creator.service';
import { PlaywrightService } from './playwright/playwright.service';
import { ConfigManagerService } from './config/config-manager.service';
import { OnModuleInit } from '@nestjs/common';

@ApiTags('Health')
@Controller()
export class AppController implements OnModuleInit {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly appService: AppService,
    private readonly aiService: AiService,
    private readonly rulesService: RulesService,
    private readonly memoryService: MemoryService,
    private readonly calendarService: CalendarService,
    private readonly blacklistService: BlacklistService,
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
    private readonly revenueService: RevenueService,
    private readonly titleParserService: TitleParserService,
    private readonly hyggloService: HyggloService,
    private readonly lostRevenueService: LostRevenueService,
    private readonly competitorIntelService: CompetitorIntelService,
    private readonly marketReleasesService: MarketReleasesService,
    private readonly autonomousService: AutonomousService,
    private readonly conversationStageService: ConversationStageService,
    private readonly itemMatcherAi: ItemMatcherAiService,
    private readonly sellRecommenderService: SellRecommenderService,
    private readonly taxReportService: TaxReportService,
    private readonly listingCreatorService: ListingCreatorService,
    private readonly configManager: ConfigManagerService,
    private readonly itemResolverService: ItemResolverService,
    private readonly playwrightService: PlaywrightService,
  ) {}

  // In-memory session store for renter chat testing
  private renterChatSessions = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();

  // Claude Code — terminal-based now (xterm.js + PTY via WebSocket)

  // ---- Cron Claude State ----
  private cronRunHistory: { task: string; label: string; startedAt: string; completedAt: string; result: string; toolCount: number }[] = [];
  private cronLastRun: Record<string, number> = {};
  private cronRunning = false;
  private cronTimer: ReturnType<typeof setInterval> | null = null;
  private readonly CLAUDE_CODE_MEMORY_PATH = '/home/ubuntu/rental-manager/.claude-code-memory.md';

  private loadClaudeCodeMemory(): string {
    try {
      if (fs.existsSync(this.CLAUDE_CODE_MEMORY_PATH)) {
        return fs.readFileSync(this.CLAUDE_CODE_MEMORY_PATH, 'utf-8').substring(0, 4000);
      }
    } catch (e: any) {
      this.logger.warn('Failed to load Claude Code memory: ' + e.message);
    }
    return '';
  }

  private async buildClaudeCodeSystemPrompt(): Promise<string> {
    const cronEnabled = await this.configManager.getBool('cron_claude.enabled');
    const cronFreq = (await this.configManager.getInt('cron_claude.frequency_minutes')) || 240;
    const cronTasksStr = (await this.configManager.get('cron_claude.tasks')) || 'message_audit';
    const cronQuietStart = (await this.configManager.getInt('cron_claude.quiet_hours_start')) ?? 2;
    const cronQuietEnd = (await this.configManager.getInt('cron_claude.quiet_hours_end')) ?? 7;

    const cronTaskList = Object.entries(this.CRON_TASKS)
      .map(([key, t]) => `  - ${key}: ${t.label} — ${t.description}`)
      .join('\n');

    const lastRunInfo = this.cronRunHistory.slice(0, 3)
      .map(r => `  - ${r.label}: ${r.completedAt} (${r.toolCount} tools)`)
      .join('\n') || '  (no recent runs)';

    const memory = this.loadClaudeCodeMemory();
    const memorySection = memory ? `\n## Your Memory\n${memory}` : '';

    return `You are Claude Code, an AI assistant with direct access to the rental-manager server at /home/ubuntu/rental-manager.
You can execute commands, read/write files, and manage the service.

Stack: NestJS + TypeScript, PostgreSQL/Prisma, Ubuntu 24.04
Build: npm run build
Restart: sudo systemctl restart rental-manager
Logs: journalctl -u rental-manager -n 50 --no-pager
Dashboard: src/public/dashboard.html

## Your Cron System
You have your OWN scheduled task system (separate from the bot's NestJS @Cron decorators).
It is managed via the dashboard gear icon or these API endpoints on localhost:3000:

Config: GET/POST /api/cron-claude/config
Trigger: POST /api/cron-claude/trigger with { task: "task_key" }
History: GET /api/cron-claude/runs

Current config:
- Enabled: ${cronEnabled}
- Frequency: every ${cronFreq} minutes
- Active tasks: ${cronTasksStr}
- Quiet hours: ${cronQuietStart}:00-${cronQuietEnd}:00 UTC
- Running now: ${this.cronRunning}

Available tasks:
${cronTaskList}

Recent runs:
${lastRunInfo}

When asked about "crons" or "scheduled tasks", this is YOUR system — use these endpoints.

## Persistent Memory
You have a memory file at /home/ubuntu/rental-manager/.claude-code-memory.md
Write important learnings, preferences, and context there so you remember across sessions.

When asked to make changes:
1. Explain what you'll do
2. Execute the necessary tool calls
3. Report the results concisely

Be efficient. Use tools to verify your work. Keep responses short.${memorySection}`;
  }

  private readonly CRON_TASKS: Record<string, { label: string; description: string; prompt: string }> = {
    message_audit: {
      label: 'Message Audit',
      description: 'Review last 100 bot messages for communication errors and fix rules if needed',
      prompt: `Audit the last 100 messages the bot wanted to send to renters. Look for systematic communication errors.

Steps:
1. Run this SQL via execute_command: cd /home/ubuntu/rental-manager && npx prisma db execute --stdin <<'SQL'
SELECT id, rental_id, input_summary, output_summary, action_taken, confidence, was_sent, created_at FROM ai_decision WHERE decision_type = 'message' AND was_sent IS NOT NULL ORDER BY created_at DESC LIMIT 100;
SQL
2. For each SENT message (was_sent = true), check:
   - Factual accuracy: does the response match what was asked?
   - Tone consistency: DB Cinema = professional/efficient, Leo Adams = casual/friendly
   - Rule compliance: any violations of the bot rules listed above?
   - Hallucination: any invented facts, prices, or policies?
   - Communication quality: awkward phrasing, redundancy, missing info?
3. For BLOCKED messages (was_sent = false): was the block justified?
4. If you find SYSTEMATIC issues (same error type in 3+ messages):
   - Identify root cause (rule gap? prompt issue? logic bug?)
   - Fix by editing the rule in the database or the relevant code file
   - Explain your reasoning
5. Summarize: total reviewed, issues by category, fixes applied, recommendations.

IMPORTANT: Be surgical. Only fix issues you are confident about. Report uncertain findings for Daniel to review.`,
    },
    log_health: {
      label: 'Log Health Check',
      description: 'Check recent logs for errors or warnings',
      prompt: 'Read the last 200 lines of rental-manager logs using: journalctl -u rental-manager -n 200 --no-pager. Identify any ERROR or WARN entries from the last hour. Summarize findings concisely. If there are recurring errors, investigate the root cause by reading the relevant source file.',
    },
    build_check: {
      label: 'Build Verification',
      description: 'Verify TypeScript compilation succeeds',
      prompt: 'Run: cd /home/ubuntu/rental-manager && npm run build. If it fails, read the error output, identify the issue, and report what needs fixing. Do NOT attempt to fix code — just report clearly.',
    },
  };

  async onModuleInit() {
    // Start cron tick every 60 seconds
    this.cronTimer = setInterval(() => this.cronTick().catch(e => {
      this.logger.error('Cron tick error: ' + e.message);
    }), 60_000);
    this.logger.log('Claude Code cron timer started (60s interval)');
  }

  @Get()
  @ApiOperation({
    summary: 'Service information',
    description: 'Returns basic information about the Rental Manager service',
  })
  @ApiResponse({
    status: 200,
    description: 'Service information retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        service: { type: 'string', example: 'Rental Manager' },
        status: { type: 'string', example: 'running' },
        message: { type: 'string', example: 'Background service is active' },
        version: { type: 'string', example: '1.0.0' },
        documentation: { type: 'string', example: '/api-docs' },
      },
    },
  })
  getRoot() {
    return {
      service: 'Rental Manager',
      status: 'running',
      message: 'Background service is active',
      version: '1.0.0',
      documentation: '/api-docs',
    };
  }

  @Get('health')
  @ApiOperation({
    summary: 'Health check',
    description:
      'Returns the health status of the service including uptime, scanner state, and authentication status',
  })
  @ApiResponse({ status: 200, description: 'Health status retrieved successfully' })
  async getHealth(@Res() res: Response, @Headers('if-none-match') ifNoneMatch?: string) {
    const data = await this.appService.getHealthStatus();
    sendWithETag(res, data, ifNoneMatch);
  }

  @Get('scanner/status')
  @ApiTags('Scanner')
  @ApiOperation({ summary: 'Scanner status' })
  @ApiResponse({ status: 200, description: 'Scanner status retrieved successfully' })
  getScannerStatus(@Res() res: Response, @Headers('if-none-match') ifNoneMatch?: string) {
    const data = this.appService.getScannerStatus();
    sendWithETag(res, data, ifNoneMatch);
  }

  @Get('rentals/stats')
  @ApiTags('Rentals')
  @ApiOperation({ summary: 'Rental statistics (uses booking data grouped by rental)' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Rental statistics retrieved successfully' })
  async getRentalStats(@Query('account') account?: string) {
    // Forward to booking stats for backward compat — rental-level counts come from bookings now
    const stats = await this.appService.getBookingStats(account || undefined);
    return {
      total: stats.activeRentals,
      ongoing: stats.ongoingRentals,
      upcoming: stats.upcomingRentals,
    };
  }

  @Get('bookings/stats')
  @ApiTags('Bookings')
  @ApiOperation({ summary: 'Booking statistics with profit data' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Booking stats with today/week profit' })
  async getBookingStats(@Res() res: Response, @Query('account') account?: string, @Headers('if-none-match') ifNoneMatch?: string) {
    const data = await this.appService.getBookingStats(account || undefined);
    sendWithETag(res, data, ifNoneMatch);
  }

  @Get('bookings/by-stage')
  @ApiTags('Bookings')
  @ApiOperation({ summary: 'Bookings by funnel stage' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Stage distribution counts' })
  async getBookingsByStage(@Query('account') account?: string) {
    return await this.appService.getBookingsByStage(account || undefined);
  }

  @Get('rentals/recent')
  @ApiTags('Rentals')
  @ApiOperation({ summary: 'Recent rentals' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Recent rentals retrieved successfully' })
  async getRecentRentals(@Query('limit') limit?: string, @Query('account') account?: string) {
    const parsed = parseInt(limit || '10', 10);
    const limitNum = Math.min(Number.isNaN(parsed) ? 10 : Math.max(1, parsed), 100);
    return await this.appService.getRecentRentals(limitNum, account || undefined);
  }

  @Get('items/recent')
  @ApiTags('Items')
  @ApiOperation({ summary: 'Recently extracted items' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Recent items retrieved successfully' })
  async getRecentItems(@Query('limit') limit?: string, @Query('account') account?: string) {
    const parsed = parseInt(limit || '20', 10);
    const limitNum = Math.min(Number.isNaN(parsed) ? 20 : Math.max(1, parsed), 100);
    return await this.appService.getRecentItems(limitNum, account || undefined);
  }

  @Get('items/catalog')
  @ApiTags('Items')
  @ApiOperation({ summary: 'Item catalog' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Item catalog retrieved successfully' })
  async getItemCatalog(@Query('limit') limit?: string) {
    const parsed = parseInt(limit || '50', 10);
    const limitNum = Math.min(Number.isNaN(parsed) ? 50 : Math.max(1, parsed), 100);
    return await this.appService.getItemCatalog(limitNum);
  }

  @Get('debug/item-match')
  @ApiTags('Debug')
  @ApiOperation({ summary: 'Compare AI vs legacy item matching' })
  @ApiQuery({ name: 'title', required: true, type: String })
  @ApiExcludeEndpoint()
  async debugItemMatch(@Query('title') title: string) {
    return await this.itemMatcherAi.debugMatch(title || '');
  }

  // --- Revenue/Profit endpoints ---

  @Get('revenue/weekly')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Weekly profit totals' })
  @ApiQuery({ name: 'weeks', required: false, type: Number })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Weekly profit data for charts' })
  async getWeeklyRevenue(@Query('weeks') weeks?: string, @Query('account') account?: string) {
    const w = Math.min(parseInt(weeks || '8', 10) || 8, 52);
    return await this.revenueService.getWeeklyTotals(w, account || undefined);
  }

  @Get('revenue/monthly')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Monthly profit totals' })
  @ApiQuery({ name: 'months', required: false, type: Number })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Monthly profit data for charts' })
  async getMonthlyRevenue(@Query('months') months?: string, @Query('account') account?: string) {
    const m = Math.min(parseInt(months || '6', 10) || 6, 24);
    return await this.revenueService.getMonthlyTotals(m, account || undefined);
  }

  @Get('revenue/lifetime')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Lifetime revenue growth (all months from first rental)' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Monthly revenue with cumulative totals for growth chart' })
  async getLifetimeRevenue(@Query('account') account?: string) {
    return await this.revenueService.getLifetimeRevenue(account || undefined);
  }

  @Get('revenue/summary')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Revenue summary for period' })
  @ApiQuery({ name: 'period', required: false, enum: ['week', 'month', 'all'] })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Revenue summary with account breakdown' })
  async getRevenueSummary(@Query('period') period?: string, @Query('account') account?: string) {
    const p = (['week', 'month', 'all'].includes(period || '') ? period : 'month') as 'week' | 'month' | 'all';
    const acct = account || undefined;
    const [summary, accounts, topItems] = await Promise.all([
      this.revenueService.getRevenueForPeriod(p, acct),
      this.revenueService.getAccountBreakdown(p, acct),
      this.revenueService.getTopEarningItems(p, acct),
    ]);
    return { summary, accounts, topItems };
  }

  @Get('revenue/top-items')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Top profit items with proportional bundle attribution' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all, or YYYY-MM' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Top earning items' })
  async getTopItems(
    @Query('period') period?: string,
    @Query('account') account?: string,
    @Query('limit') limit?: string,
  ) {
    const p = period || 'month';
    const l = limit ? parseInt(limit, 10) : 10;
    return await this.revenueService.getTopEarningItems(p, account || undefined, l);
  }

  @Get('revenue/items')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Full item revenue breakdown with monthly detail' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all, or YYYY-MM' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'All items with revenue and monthly breakdown' })
  async getItemRevenue(@Query('period') period?: string, @Query('account') account?: string) {
    return await this.revenueService.getItemRevenueBreakdown(period || '6m', account || undefined);
  }

  @Get('revenue/projection')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Expected monthly revenue projection' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Current month revenue with projection' })
  async getMonthlyProjection(@Query('account') account?: string) {
    return await this.revenueService.getMonthlyProjection(account || undefined);
  }

  @Get('revenue/ai-boost')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'AI revenue boost estimate (uses weekly self-evaluated rate)' })
  @ApiQuery({ name: 'period', required: false, enum: ['month', 'year'] })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Estimated additional revenue from AI automation' })
  async getAiBoost(@Query('period') period?: string, @Query('account') account?: string) {
    const p = (period === 'year' ? 'year' : 'month') as 'month' | 'year';
    return await this.revenueService.getAiBoostMetric(p, account || undefined);
  }

  @Get('revenue/ai-boost/evaluate')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Force re-evaluation of AI boost rate (normally runs weekly)' })
  @ApiResponse({ status: 200, description: 'Fresh AI boost evaluation results' })
  async evaluateAiBoost() {
    const result = await this.revenueService.evaluateAiPerformance();
    await this.revenueService.storeBoostEvaluation(result);
    return result;
  }

  @Get('revenue/tax-summary')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'UK sole trader tax calculation for current tax year' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Tax breakdown with income tax, NIC, capital allowances' })
  async getTaxSummary(@Query('account') account?: string) {
    return await this.revenueService.getTaxSummary(account || undefined);
  }

  @Get('revenue/tax-multi-year')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Multi-year UK tax calculation with penalties (2022/23–2025/26)' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Full multi-year tax breakdown with penalties and interest' })
  async getMultiYearTaxSummary(@Query('account') account?: string) {
    return await this.revenueService.getMultiYearTaxSummary(account || undefined);
  }

  @Get('revenue/tax-report.pdf')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Download multi-year tax report as PDF' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'PDF tax report' })
  async getTaxReportPdf(@Query('account') account?: string, @Res() res?: any) {
    const buffer = await this.taxReportService.generateTaxReport(account || undefined);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="tax-report.pdf"',
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Get('revenue/funnel-history')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Monthly funnel snapshot trend log' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Funnel snapshots with conversion rates per month' })
  async getFunnelHistory(@Query('account') account?: string) {
    return await this.revenueService.getFunnelHistory(account || undefined);
  }

  @Get('revenue/funnel-snapshot')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Manually trigger funnel snapshot for current month' })
  @ApiResponse({ status: 200, description: 'Snapshot results' })
  async triggerFunnelSnapshot() {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return await this.revenueService.takeFunnelSnapshot(periodStart, periodEnd);
  }

  @Get('revenue/funnel-backfill')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Backfill funnel snapshots for all historical months' })
  @ApiResponse({ status: 200, description: 'Backfill results' })
  async backfillFunnelSnapshots() {
    return await this.revenueService.backfillFunnelSnapshots();
  }

  @Get('revenue/item-earnings-history')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Get per-item monthly earnings history' })
  @ApiQuery({ name: 'item', required: false, description: 'Filter by item name' })
  @ApiQuery({ name: 'account', required: false, description: 'Filter by account' })
  @ApiResponse({ status: 200, description: 'Item earnings snapshots' })
  async getItemEarningsHistory(@Query('item') item?: string, @Query('account') account?: string) {
    return await this.revenueService.getItemEarningsHistory(item || undefined, account || undefined);
  }

  @Get('revenue/item-earnings-snapshot')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Manually trigger item earnings snapshot for current month' })
  @ApiResponse({ status: 200, description: 'Items snapshotted' })
  async triggerItemEarningsSnapshot() {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const count = await this.revenueService.takeItemEarningsSnapshot(periodStart, periodEnd);
    return { monthsProcessed: 1, itemsSnapshotted: count, period: periodStart.toISOString().substring(0, 7) };
  }

  @Get('revenue/item-earnings-backfill')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Backfill item earnings snapshots for all historical months' })
  @ApiResponse({ status: 200, description: 'Backfill results' })
  async backfillItemEarningsSnapshots() {
    return await this.revenueService.backfillItemEarningsSnapshots();
  }

  @Get('revenue/ai-boost/calibrate')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Recalculate AI boost baselines from real data (conversion rate, quality score, response coverage)' })
  @ApiResponse({ status: 200, description: 'Calibrated baselines with data provenance' })
  async calibrateAiBoostBaselines() {
    return await this.revenueService.calibrateBaselines();
  }

  @Get('revenue/bundle-revenue')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Top bundles/sets by cumulative revenue' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Top bundle revenue' })
  async getTopBundles(@Query('limit') limit?: string) {
    return await this.revenueService.getTopBundles(limit ? parseInt(limit, 10) : 20);
  }

  @Get('revenue/bundle-revenue-history')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Bundle revenue history by month' })
  @ApiQuery({ name: 'bundle', required: false, description: 'Bundle key filter' })
  @ApiResponse({ status: 200, description: 'Bundle revenue snapshots' })
  async getBundleRevenueHistory(@Query('bundle') bundle?: string) {
    return await this.revenueService.getBundleRevenueHistory(bundle || undefined);
  }

  @Get('revenue/bundle-revenue-backfill')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Backfill bundle revenue snapshots for all historical months' })
  @ApiResponse({ status: 200, description: 'Backfill results' })
  async backfillBundleRevenueSnapshots() {
    return await this.revenueService.backfillBundleRevenueSnapshots();
  }

  @Get('revenue/top-bundles')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Top bundles by revenue with period filtering (live query)' })
  @ApiQuery({ name: 'period', required: false, type: String })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Top bundles with revenue data' })
  async getTopBundlesLive(
    @Query('period') period?: string,
    @Query('account') account?: string,
    @Query('limit') limit?: string,
  ) {
    return await this.revenueService.getTopBundlesLive(
      period || '6m',
      account || undefined,
      limit ? parseInt(limit, 10) : 15,
    );
  }

  @Get('revenue/item-cycle')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Item Cycle Tracker — seasonal demand patterns by category (Jan-Dec)' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Seasonal demand curves per category' })
  async getItemCycle(@Query('account') account?: string) {
    return await this.revenueService.getItemCycleData(account || undefined);
  }

  @Get('revenue/item-cycle/refresh')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Manually refresh item cycle tracker cache' })
  async refreshItemCycle() {
    await this.revenueService.monthlyItemCycleRefresh();
    return { status: 'ok', message: 'Item cycle cache refreshed for all accounts' };
  }

  @Get('revenue/fix-misattributed')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Fix misattributed old items in parsed_items and bookings' })
  @ApiResponse({ status: 200, description: 'Fix results' })
  async fixMisattributedItems() {
    return await this.revenueService.fixMisattributedItems();
  }

  // --- Calendar ---

  @Get('calendar/bookings')
  @ApiTags('Calendar')
  @ApiOperation({ summary: 'Calendar bookings for date range' })
  @ApiQuery({ name: 'start', required: true, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'end', required: true, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Calendar bookings grouped by rental' })
  async getCalendarBookings(
    @Res() res: Response,
    @Query('start') start: string,
    @Query('end') end: string,
    @Query('account') account?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    if (!start || !end) { res.json([]); return; }
    const data = await this.appService.getCalendarBookings(start, end, account || undefined);
    sendWithETag(res, data, ifNoneMatch);
  }

  // --- Activity feed ---

  @Get('activity/recent')
  @ApiTags('Activity')
  @ApiOperation({ summary: 'Recent activity feed from notification system' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Recent activity events' })
  getRecentActivity(@Query('limit') limit?: string, @Query('account') account?: string) {
    const l = Math.min(parseInt(limit || '50', 10) || 50, 200);
    return this.telegramService.getRecentActivity(l, account || undefined);
  }

  // --- Chat endpoints ---

  @Post('chat')
  @ApiTags('Chat')
  @ApiOperation({
    summary: 'Dashboard chat — intelligent assistant with full business context and tools',
  })
  @ApiResponse({ status: 200, description: 'AI response' })
  async chatMessage(@Body() body: { message: string }) {
    const userMessage = body.message;
    if (!userMessage || typeof userMessage !== 'string') {
      return { error: 'Message is required' };
    }

    try {
      const chatId = 'dashboard';
      await this.memoryService.storeConversation(chatId, 'user', userMessage);

      const dashKeywords = userMessage
        .split(/[\s,.\-!?;:()]+/)
        .filter((w: string) => w.length > 2)
        .slice(0, 10);

      const pricingTerms = /\b(price|pricing|cost|how much|rate|rates|quote|charge|fee|fees|per day|daily|weekly|budget|listing)\b/i;
      const hasPricingIntent = pricingTerms.test(userMessage);

      const [rules, history, generalMemories, blacklist, schedule] = await Promise.all([
        this.rulesService.getFormattedRules(),
        this.memoryService.getConversationHistory(chatId, 10),
        this.memoryService.getRelevantMemories(dashKeywords),
        this.blacklistService.getFormattedBlacklist(),
        this.calendarService.getFormattedSchedule(new Date()),
      ]);

      let memories = generalMemories;
      if (hasPricingIntent) {
        const pricingMem = await this.memoryService.getPricingMemories();
        if (pricingMem) memories = [generalMemories, pricingMem].filter(Boolean).join('\n');
      }

      const recentRentals = await this.prisma.rental.findMany({
        take: 5,
        orderBy: { created_at: 'desc' },
        select: { title: true, status: true, renter_info: true, account: true, start_date: true, end_date: true },
      });
      const rentalContext = recentRentals.length > 0
        ? recentRentals.map((r) => `- ${r.title} (${r.status}, ${r.account || 'unknown'}) renter: ${r.renter_info || 'N/A'}`).join('\n')
        : 'No recent rentals.';

      // === ENHANCED SYSTEM PROMPT ===
      const additionalParts: string[] = [
        `You are the Dashboard AI Assistant for a camera rental business on Hygglo.`,
        ` You are chatting with the business operator (Leo or Daniel) through the web dashboard.`,
        ` You have FULL access to business data via tools. Use them proactively.`,
        `\n\n--- YOUR CAPABILITIES ---`,
        `\n1. EQUIPMENT ORACLE: Answer ANY question about compatibility, pricing, accessories, specs. Use check_compatibility and lookup_pricing tools.`,
        `\n2. DASHBOARD CONTEXT: You can pull live stats (today's earnings, active rentals, revenue) using get_dashboard_stats.`,
        `\n3. BOOKING ADVISOR: For pending rentals, use get_pending_rentals to check details, then advise accept/decline with reasoning.`,
        `\n4. CONVERSATION OVERRIDE: Use read_conversation to read any rental chat. Use send_correction to send a fix message if the bot said something wrong. ALWAYS show the message to the user and ask for confirmation before sending.`,
        `\n5. DAILY BRIEFING: When asked to "brief me" or for a status update, use get_daily_briefing.`,
        `\n6. BUSINESS INTELLIGENCE: When asked about what to buy, demand patterns, denied rentals, time gaps, substitutions, marketing item demand, or investment decisions, use getBusinessIntelligence. This gives you purchase recommendations, revenue analysis, and demand signals.`,
        `\n6. RULE/MEMORY EDITOR: Use search_rules and search_memories to find entries, then update_rule or update_memory to fix them. ALWAYS show what you will change and ask for confirmation before updating. NOTE: Only scheduling/timing rules can be edited (pickup times, return windows, opening hours). General rules are locked.`,
        `\n\n--- IMPORTANT RULES ---`,
        `\n- For send_correction and update_rule/update_memory: ALWAYS preview the change and ask "Should I go ahead?" before executing.`,
        `\n- Be concise and direct. Use bullet points for lists.`,
        `\n- Leo is less experienced with cameras — explain compatibility and technical details clearly.`,
        `\n- When you don't know something, use the tools to look it up rather than guessing.`,
      ];

      if (schedule) additionalParts.push(`\n\nTODAY'S SCHEDULE:\n${schedule}`);
      if (blacklist) additionalParts.push(`\n\n${blacklist}`);

      try {
        const upcomingBookings = await this.calendarService.getAllUpcomingBookings(14);
        if (upcomingBookings) {
          additionalParts.push(`\n\n${upcomingBookings}`);
          additionalParts.push('\nIMPORTANT: When answering availability questions, ALWAYS use the check_availability tool — it counts all confirmed AND pending bookings accurately, and automatically suggests compatible alternatives when an item is unavailable. Use the UPCOMING BOOKINGS data above for context on who has what, but rely on the tool for the actual yes/no availability answer.');
        }
      } catch { /* optional */ }

      try {
        const revenueIntelligence = await this.lostRevenueService.buildAIContext();
        if (revenueIntelligence) additionalParts.push(`\n\nREVENUE INTELLIGENCE:\n${revenueIntelligence}`);
      } catch { /* optional */ }

      // Advanced Business Intelligence context
      try {
        const biContext = await this.lostRevenueService.buildBIContext();
        if (biContext) additionalParts.push(`\n\nBUSINESS INTELLIGENCE (for purchase/investment decisions):\n${biContext}`);
      } catch { /* optional */ }

      try {
        const [revSummary, allItemEarnings] = await Promise.all([
          this.revenueService.getFormattedRevenue('month'),
          this.revenueService.getAllItemEarnings(),
        ]);
        if (revSummary) additionalParts.push(`\n\nCURRENT REVENUE:\n${revSummary}`);
        if (allItemEarnings.currentItems.length > 0) {
          const lines = allItemEarnings.currentItems.map(i =>
            `- ${i.item}: £${i.totalRevenue} (${i.rentalCount} rentals${i.lastRented ? ', last: ' + i.lastRented : ''})`
          );
          additionalParts.push(`\n\nITEM EARNINGS (all time):\n${lines.join('\n')}`);
        }
      } catch { /* optional */ }

      try {
        const lifetime = await this.revenueService.getLifetimeRevenue();
        if (lifetime.months.length > 0) {
          const lines = lifetime.months.filter(m => m.revenue > 0).map(m => {
            const parts = [`${m.month}: £${Math.round(m.revenue)} total`];
            if (m.dbcinemaRevenue) parts.push(`DB Cinema £${Math.round(m.dbcinemaRevenue)}`);
            if (m.leoRevenue) parts.push(`Leo £${Math.round(m.leoRevenue)}`);
            if (m.aiAttribution) parts.push(`AI Boost £${Math.round(m.aiAttribution)}`);
            return `- ${parts.join(' | ')}`;
          });
          additionalParts.push(`\n\nMONTHLY INCOME:\nTotal lifetime: £${Math.round(lifetime.totalRevenue)}\n${lines.slice(-6).join('\n')}`);
        }
      } catch { /* optional */ }

      try {
        const bundleLines: string[] = [];
        for (const entry of PRICING_CATALOG) {
          if (entry.is_bundle && entry.bundle_items) {
            bundleLines.push(`- ${entry.item_name}: £${entry.daily_price_max}/day (contains: ${entry.bundle_items.join(', ')})`);
          }
        }
        if (bundleLines.length > 0) additionalParts.push(`\n\nBUNDLE PRICING:\n${bundleLines.join('\n')}`);
      } catch { /* optional */ }

      try {
        const competitorIntelligence = await this.competitorIntelService.buildAIContext();
        if (competitorIntelligence) additionalParts.push(`\n\nCOMPETITOR INTELLIGENCE:\n${competitorIntelligence}`);
      } catch { /* optional */ }

      // === TOOL HANDLERS ===
      const toolHandlers: ToolHandlers = {
        checkAvailability: async (itemName, startDate, endDate) => {
          const result = await this.calendarService.checkAvailability(itemName, new Date(startDate), new Date(endDate));
          const breakdown = result.pendingBooked > 0
            ? ` (${result.confirmedBooked} confirmed + ${result.pendingBooked} pending review)`
            : '';
          const timeHint = !result.available
            ? [result.availableFrom ? `available from ${result.availableFrom}` : '', result.unavailableAfter ? `must return by ${result.unavailableAfter}` : ''].filter(Boolean).join(', ')
            : '';

          if (result.available) {
            return `${result.matchedItem || itemName} is AVAILABLE (${result.booked}/${result.maxQuantity} booked${breakdown})`;
          }

          // Item unavailable — proactively find compatible alternatives (same brand/mount)
          let altText = '';
          if (result.matchedItem) {
            const alts = await this.calendarService.findAvailableAlternatives(
              result.matchedItem, new Date(startDate), new Date(endDate),
            );
            if (alts.length > 0) {
              altText = `\nAvailable compatible alternatives: ${alts.map(a => `${a.name} (${a.available}/${a.maxQuantity} free)`).join(', ')}`;
            } else {
              altText = '\nNo compatible alternatives available for these dates.';
            }
          }
          return `${result.matchedItem || itemName} is NOT available (${result.booked}/${result.maxQuantity} booked${breakdown})${timeHint ? ` — ${timeHint}` : ''}${altText}`;
        },
        lookupPricing: async (itemName, days) => {
          const entry = getItemPrice(itemName);
          if (!entry) return `Pricing not found for "${itemName}". Check the exact item name.`;
          const dailyRate = entry.daily_price_max;
          let total = dailyRate * days;
          if (days >= 7) total = dailyRate * 5;
          else if (days === 3) total = dailyRate * 2.5;
          return `${entry.item_name}: £${dailyRate}/day, ${days} day(s): ~£${Math.round(total)} renter pays, ~£${Math.round(total * 0.64)} owner earnings`;
        },
        checkCompatibility: async (items) => {
          const conflicts = checkCompatibilityConflicts(items);
          const missing = detectMissingEssentials(items);
          const parts: string[] = [];
          if (conflicts.conflicts.length > 0) {
            parts.push('CONFLICTS: ' + conflicts.conflicts.map(c => c.reason).join('; '));
          } else {
            parts.push('No compatibility conflicts detected.');
          }
          if (missing.missing.length > 0) {
            parts.push('MISSING ESSENTIALS: ' + missing.missing.map(m => `${m.camera} needs ${m.category}: ${m.suggestions.join(', ')}`).join('; '));
          }
          const compatInfo = formatCompatibilityForAI(items);
          if (compatInfo) parts.push(compatInfo);
          return parts.join('\n');
        },
        getRentalDetails: async (rentalId) => {
          const r = await this.prisma.rental.findUnique({ where: { id: rentalId }, include: { bookings: true } });
          if (!r) return 'Rental not found';
          const bookingInfo = r.bookings?.map(b => `Booking ${b.id.substring(0,8)}: ${b.status}, ${b.start_date?.toLocaleDateString('en-GB') || 'TBC'}-${b.end_date?.toLocaleDateString('en-GB') || 'TBC'}`).join('; ') || 'No bookings';
          return `Title: ${r.title}\nStatus: ${r.status}\nOrder step: ${r.order_step}\nAccount: ${r.account}\nRenter: ${r.renter_info || 'Unknown'}\nPrice: £${r.rental_price || 0}\nDates: ${r.start_date?.toLocaleDateString('en-GB') || 'TBC'} to ${r.end_date?.toLocaleDateString('en-GB') || 'TBC'}\nBookings: ${bookingInfo}`;
        },
        // --- NEW TOOLS ---
        readConversation: async (search) => {
          // Find rental by ID or search term
          let rental = await this.prisma.rental.findUnique({ where: { id: search } }) as any;
          if (!rental) {
            const rentals = await this.prisma.rental.findMany({
              where: {
                OR: [
                  { title: { contains: search, mode: 'insensitive' } },
                  { renter_info: { contains: search, mode: 'insensitive' } },
                ],
              },
              orderBy: { created_at: 'desc' },
              take: 1,
            });
            rental = (rentals[0] || null) as any;
          }
          if (!rental) return `No rental found matching "${search}". Try a different search term.`;
          try {
            const messages = await this.hyggloService.readMessages(rental.hygglo_order_id || rental.id, (rental.account || 'dbcinema') as 'dbcinema' | 'leo');
            if (!messages || messages.length === 0) return `Found rental "${rental.title}" (${rental.status}) but no messages yet.`;
            const transcript = messages.map(m => `[${m.timestamp?.substring(0, 16) || '?'}] ${m.sender}: ${m.content}`).join('\n');
            return `CONVERSATION for "${rental.title}" (${rental.status}, ${rental.account}, renter: ${rental.renter_info || 'Unknown'}, ID: ${rental.id}):\n\n${transcript}`;
          } catch (err: any) {
            return `Found rental "${rental.title}" but could not read messages: ${err.message}`;
          }
        },
        sendCorrectionMessage: async (rentalId, message) => {
          const rental = await this.prisma.rental.findUnique({ where: { id: rentalId } });
          if (!rental) return `Rental ${rentalId} not found.`;
          try {
            const sent = await this.hyggloService.sendMessage(rentalId, message);
            return sent
              ? `Message sent to ${rental.renter_info || 'renter'} on "${rental.title}": "${message}"`
              : `BLOCKED: Message was not sent. This may be due to READ_ONLY_MODE or account restrictions.`;
          } catch (err: any) {
            return `Failed to send message: ${err.message}`;
          }
        },
        searchRules: async (query) => {
          const allRules = await this.prisma.rule.findMany({
            where: {
              is_active: true,
              OR: [
                { name: { contains: query, mode: 'insensitive' } },
                { content: { contains: query, mode: 'insensitive' } },
              ],
            },
            orderBy: { priority: 'desc' },
            take: 10,
          });
          if (allRules.length === 0) return `No active rules matching "${query}".`;
          return allRules.map(r => `[${r.id.substring(0,8)}] p${r.priority} [${r.category}] "${r.name}": ${(r.content || '').substring(0, 200)}...`).join('\n\n');
        },
        searchMemories: async (query) => {
          const mems = await this.prisma.memory.findMany({
            where: {
              content: { contains: query, mode: 'insensitive' },
            },
            take: 10,
          });
          if (mems.length === 0) return `No memories matching "${query}".`;
          return mems.map(m => `[${m.id.substring(0,8)}] type="${m.memory_type}" subject="${m.subject}": ${(m.content || '').substring(0, 300)}...`).join('\n\n');
        },
        updateRule: async (ruleId, field, value) => {
          const rule = await this.prisma.rule.findFirst({ where: { id: { startsWith: ruleId } } });
          if (!rule) return `Rule ${ruleId} not found.`;

          // GATE: Only scheduling/timing rules editable from dashboard chat
          const allowedCats = ['scheduling', 'booking'];
          const timingRe = /(time|hour|pickup|return|slot|schedul|morning|evening|window|opening|delivery.time|lead.time)/i;
          if (!allowedCats.includes(rule.category) && !timingRe.test(rule.name)) {
            return `BLOCKED: "${rule.name}" is a ${rule.category} rule. Only scheduling/timing rules can be edited here. Contact Daniel for other changes.`;
          }

          const updateData: any = {};
          if (field === 'content') updateData.content = value;
          else if (field === 'priority') updateData.priority = parseInt(value, 10);
          else if (field === 'active') updateData.is_active = value === 'true';
          else return `Invalid field "${field}". Use content, priority, or active.`;
          await this.prisma.rule.update({ where: { id: rule.id }, data: updateData });
          return `Updated rule "${rule.name}" (${rule.id.substring(0,8)}): ${field} = ${value}`;
        },
        updateMemory: async (memoryId, newContent) => {
          const mem = await this.prisma.memory.findFirst({ where: { id: { startsWith: memoryId } } });
          if (!mem) return `Memory ${memoryId} not found.`;
          await this.prisma.memory.update({ where: { id: mem.id }, data: { content: newContent } });
          return `Updated memory ${mem.id.substring(0,8)} (${mem.memory_type}). New content saved.`;
        },
        getDashboardStats: async () => {
          const stats = await this.appService.getBookingStats();
          const projection = await this.revenueService.getMonthlyProjection();
          const parts: string[] = [];
          parts.push(`TODAY: £${Math.round(stats.todayEarnings || 0)} earnings, ${stats.todayRentalCount || 0} rental(s)`);
          parts.push(`ACTIVE: ${stats.activeRentals || 0} total (${stats.ongoingRentals || 0} ongoing, ${stats.upcomingRentals || 0} upcoming, ${stats.pendingRentals || 0} pending)`);
          parts.push(`THIS WEEK: £${Math.round(stats.weekEarnings || 0)}`);
          if (projection) {
            parts.push(`THIS MONTH: £${Math.round(projection.currentMonthEarnings || 0)} confirmed, projected £${Math.round(projection.projectedMonthEarnings || 0)}`);
          }
          if (stats.pendingDetails?.length > 0) {
            parts.push(`\nPENDING DECISIONS:`);
            for (const p of stats.pendingDetails) {
              parts.push(`  - ${p.items?.join(', ') || 'items'} (${p.renter}) £${p.earnings}`);
            }
          }
          return parts.join('\n');
        },
        getBusinessIntelligence: async () => {
          const bi = await this.lostRevenueService.buildBIContext();
          return bi || 'No BI data available yet.';
        },
        getDailyBriefing: async () => {
          const stats = await this.appService.getBookingStats();
          const projection = await this.revenueService.getMonthlyProjection();
          const todaySchedule = await this.calendarService.getFormattedSchedule(new Date());
          const upcomingBookings = await this.calendarService.getAllUpcomingBookings(3);
          const activity = this.telegramService.getRecentActivity(10);

          const parts: string[] = [];
          parts.push(`=== DAILY BRIEFING (${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}) ===`);

          // Revenue
          parts.push(`\nREVENUE:`);
          parts.push(`  Today: £${Math.round(stats.todayEarnings || 0)} (${stats.todayRentalCount || 0} rentals)`);
          parts.push(`  This week: £${Math.round(stats.weekEarnings || 0)}`);
          if (projection) parts.push(`  This month: £${Math.round(projection.currentMonthEarnings || 0)} confirmed`);

          // Active rentals
          parts.push(`\nACTIVE RENTALS: ${stats.activeRentals || 0}`);
          if (stats.ongoingDetails?.length > 0) {
            parts.push('  Ongoing:');
            for (const r of stats.ongoingDetails) parts.push(`    - ${(r as any).items?.join(', ') || 'items'} (${r.renter}) £${r.earnings}`);
          }
          if (stats.upcomingDetails?.length > 0) {
            parts.push('  Upcoming:');
            for (const r of stats.upcomingDetails) parts.push(`    - ${(r as any).items?.join(', ') || 'items'} (${r.renter})`);
          }

          // Pending decisions
          if (stats.pendingDetails?.length > 0) {
            parts.push(`\nPENDING DECISIONS (${stats.pendingRentals}):`);
            for (const p of stats.pendingDetails) {
              parts.push(`  - ${p.items?.join(', ') || 'items'} (${p.renter}) £${p.earnings} — needs accept/decline`);
            }
          }

          // Schedule
          if (todaySchedule) parts.push(`\nTODAY'S SCHEDULE:\n${todaySchedule}`);
          if (upcomingBookings) parts.push(`\nNEXT 3 DAYS:\n${upcomingBookings}`);

          // Recent activity
          if (activity.length > 0) {
            parts.push(`\nRECENT ACTIVITY:`);
            for (const a of activity.slice(0, 5)) {
              parts.push(`  - ${a.summary} (${a.rentalTitle || ''}) ${a.timestamp?.substring(11, 16) || ''}`);
            }
          }

          return parts.join('\n');
        },
        getPendingRentals: async () => {
          const pending = await this.prisma.rental.findMany({
            where: {
              order_step: { in: ['VERIFIED', 'BOOKED_AFTER_VERIFIED'] },
              status: { notIn: ['cancelled', 'completed', 'obsolete', 'consolidated'] },
            },
            include: { bookings: { where: { status: { not: 'cancelled' } } } },
            orderBy: { created_at: 'desc' },
          });
          if (pending.length === 0) return 'No pending rental requests.';
          const lines: string[] = [];
          for (const r of pending) {
            const bookingDates = r.bookings.map(b =>
              `${b.start_date?.toLocaleDateString('en-GB') || '?'}-${b.end_date?.toLocaleDateString('en-GB') || '?'}`
            ).join(', ');
            lines.push(`ID: ${r.id}\nTitle: ${r.title}\nRenter: ${r.renter_info || 'Unknown'}\nAccount: ${r.account}\nPrice: £${r.rental_price || 0}\nDates: ${bookingDates || 'TBC'}\nOrder step: ${r.order_step}`);
          }
          return `PENDING RENTALS (${pending.length}):\n\n` + lines.join('\n---\n');
        },
      };

      // Dashboard routing split:
      //   Sonnet 4.6 -> edit/action verbs, strategic/analytic queries, long asks.
      //   Haiku 4.5  -> read-only lookups and short factual questions (same tools available).
      // Saves ~5x per call on the cheap path without losing tool access.
      const actionVerb = /\b(update|edit|rewrite|send|correct|change|fix|cancel|accept|decline|approve|reject|mark|buy|invest|delete|remove)\b/i.test(userMessage);
      const strategicAsk = /\b(strategy|strateg|analyz|analyse|optimi[sz]e|recommend|advice|why is|why are|what should|brief me|briefing|report|compete|competitor|invest|demand pattern|forecast|outlook|roadmap)\b/i.test(userMessage);
      const longAsk = userMessage.length > 220;
      const needsSonnet = actionVerb || strategicAsk || longAsk;

      const response = needsSonnet
        ? await this.aiService.processComplex(userMessage, {
            rules,
            memories,
            conversationHistory: history,
            rentalContext,
            additionalContext: additionalParts.join(''),
            toolHandlers,
            maxTokens: 4096,
          })
        : await this.aiService.processRoutine(userMessage, {
            rules,
            memories,
            conversationHistory: history,
            rentalContext,
            additionalContext: additionalParts.join(''),
            toolHandlers,
            maxTokens: 1200,
          });

      await this.memoryService.storeConversation(chatId, 'assistant', response.content);
      if (response.memories.length > 0) {
        await this.memoryService.processAiMemories(response.memories);
      }
      return { reply: response.content, model: response.model };
    } catch (error) {
      return { error: `Chat error: ${error.message}` };
    }
  }

  @Post('renter-chat')
  @ApiTags('Testing')
  @ApiOperation({ summary: 'Test renter-facing conversation engine' })
  async renterChatMessage(@Body() body: { message: string; account?: string; sessionId?: string }) {
    const userMessage = body.message;
    if (!userMessage || typeof userMessage !== 'string') {
      return { error: 'Message is required' };
    }

    const sessionId = body.sessionId || 'test-default';
    const account = (body.account || 'dbcinema') as 'dbcinema' | 'leo';

    if (!this.renterChatSessions.has(sessionId)) {
      this.renterChatSessions.set(sessionId, []);
    }
    const history = this.renterChatSessions.get(sessionId)!;

    try {
      const result = await (this.telegramService as any).processRenterConversation(userMessage, account, history);
      if (!result) {
        return { reply: '(no response)', model: 'unknown', quality: '' };
      }
      return { reply: result.rawContent, quality: result.qualityInfo, model: 'adaptive' };
    } catch (error) {
      return { error: `Renter chat error: ${error.message}` };
    }
  }

  @Post('renter-chat/reset')
  @ApiTags('Testing')
  @ApiOperation({ summary: 'Reset renter chat session' })
  async resetRenterChat(@Body() body: { sessionId?: string }) {
    const sessionId = body.sessionId || 'test-default';
    this.renterChatSessions.delete(sessionId);
    return { status: 'session reset', sessionId };
  }

  // --- Backfill & Cleanup endpoints ---

  /**
   * Full sync: reconcile active bookings + import all completed history from Hygglo.
   * 1. Scans Hygglo for REAL ongoing + upcoming → cancels phantom DB bookings
   * 2. Scans ALL completed bookings (paginated) → imports with ownerEarnings
   * 3. Updates existing bookings with correct revenue from Hygglo
   */
  @Get('sync/full')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Full Hygglo sync: reconcile active bookings + import completed history' })
  @ApiResponse({ status: 200, description: 'Sync results' })
  async syncFull() {
    const accounts = this.hyggloService.getAccounts();
    const syncResults = {
      reconcile: { cancelled: 0, kept: 0, details: [] as string[] },
      completed: { imported: 0, updated: 0, skipped: 0, errors: [] as string[] },
      byAccount: {} as Record<string, { ongoing: number; upcoming: number; completed: number }>,
    };

    // ======= STEP 1: Reconcile active bookings against Hygglo =======
    this.logger.log('=== SYNC STEP 1: Reconciling active bookings ===');

    // Collect REAL active listing_ids from Hygglo (ongoing + upcoming ONLY — pending = unaccepted requests, don't count)
    const activeListingIds = new Set<string>();
    for (const account of accounts) {
      try {
        const ongoing = await this.hyggloService.scanRentalsForAccountPublic(account.name, 'ongoing');
        const upcoming = await this.hyggloService.scanRentalsForAccountPublic(account.name, 'upcoming');

        const acctKey = account.name;
        syncResults.byAccount[acctKey] = {
          ongoing: ongoing.length,
          upcoming: upcoming.length,
          completed: 0,
        };

        for (const r of [...ongoing, ...upcoming]) {
          activeListingIds.add(r.listingId);
        }

        this.logger.log(`Hygglo ${account.name}: ${ongoing.length} ongoing, ${upcoming.length} upcoming`);
      } catch (err) {
        this.logger.error(`Failed to scan active for ${account.name}: ${err.message}`);
      }
    }

    // Find confirmed bookings whose rental is NOT on Hygglo anymore
    const allConfirmedBookings = await this.prisma.booking.findMany({
      where: { status: 'confirmed' },
      select: { id: true, rental_id: true, item_name: true, renter_name: true, start_date: true, end_date: true },
    });

    // Get rental listing_id for each booking
    const rentalIds = [...new Set(allConfirmedBookings.map(b => b.rental_id).filter(Boolean))];
    const rentals = await this.prisma.rental.findMany({
      where: { id: { in: rentalIds as string[] } },
      select: { id: true, listing_id: true },
    });
    const rentalToListing = new Map(rentals.map(r => [r.id, r.listing_id]));

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    for (const booking of allConfirmedBookings) {
      if (!booking.rental_id) continue;
      const listingId = rentalToListing.get(booking.rental_id);
      if (!listingId) continue;

      if (activeListingIds.has(listingId)) {
        syncResults.reconcile.kept++;
      } else {
        // This booking's rental is not on Hygglo active list — it's either completed or cancelled
        // If end_date is in the future, it's a phantom booking → cancel it
        if (booking.end_date >= now) {
          await this.prisma.booking.update({
            where: { id: booking.id },
            data: { status: 'cancelled' },
          });
          syncResults.reconcile.cancelled++;
          syncResults.reconcile.details.push(
            `Cancelled: ${booking.renter_name} - ${booking.item_name} (${booking.start_date.toISOString().split('T')[0]} → ${booking.end_date.toISOString().split('T')[0]})`,
          );
        } else {
          // Past booking not on Hygglo — it's completed, keep it
          syncResults.reconcile.kept++;
        }
      }
    }

    this.logger.log(`Reconcile: cancelled ${syncResults.reconcile.cancelled}, kept ${syncResults.reconcile.kept}`);

    // ======= STEP 2: Import completed bookings from Hygglo =======
    this.logger.log('=== SYNC STEP 2: Importing completed bookings ===');

    for (const account of accounts) {
      try {
        const completedRentals = await this.hyggloService.scanCompletedRentalsPaginated(account.name);
        if (syncResults.byAccount[account.name]) {
          syncResults.byAccount[account.name].completed = completedRentals.length;
        }

        this.logger.log(`Hygglo ${account.name}: ${completedRentals.length} completed rentals fetched`);

        for (const rental of completedRentals) {
          try {
            if (!rental.startDate || !rental.endDate) {
              syncResults.completed.skipped++;
              continue;
            }

            // Check if rental already exists in DB
            const existingRental = await this.prisma.rental.findFirst({
              where: { listing_id: rental.listingId },
            });

            if (existingRental) {
              // UPDATE revenue on existing bookings if it changed
              const ownerEarnings = rental.rentalPrice || 0;
              if (ownerEarnings > 0) {
                const existingBookings = await this.prisma.booking.findMany({
                  where: { rental_id: existingRental.id, status: { in: ['confirmed', 'pending_review'] } },
                });
                const mainBookings = existingBookings.filter(b => !isAccessoryItem(b.item_name));
                const perItem = mainBookings.length > 0 ? Math.round((ownerEarnings / mainBookings.length) * 100) / 100 : ownerEarnings;

                let anyUpdated = false;
                for (const b of mainBookings) {
                  if (b.revenue !== perItem) {
                    await this.prisma.booking.update({
                      where: { id: b.id },
                      data: { revenue: perItem, net_profit: perItem, status: 'confirmed' },
                    });
                    anyUpdated = true;
                  }
                }

                // Also update rental record
                if (existingRental.rental_price !== ownerEarnings || existingRental.status !== 'completed') {
                  // Parse items if not already parsed
                  let parsedUpdate: any = {};
                  if (!existingRental.parsed_items) {
                    try {
                      const resolved = await this.itemResolverService.resolveItems(rental.listingId, rental.title);
                      parsedUpdate.parsed_items = resolved.map(r => ({ item: r.item, qty: r.qty })) as any;
                    } catch { /* non-critical */ }
                  }
                  await this.prisma.rental.update({
                    where: { id: existingRental.id },
                    data: { rental_price: ownerEarnings, status: 'completed', ...parsedUpdate },
                  });
                  anyUpdated = true;
                }

                if (anyUpdated) syncResults.completed.updated++;
                else syncResults.completed.skipped++;
              } else {
                syncResults.completed.skipped++;
              }
              continue;
            }

            // Parse items using resolver cascade
            let parsedItems: any = null;
            try {
              const resolved = await this.itemResolverService.resolveItems(rental.listingId, rental.title);
              parsedItems = resolved.map(r => ({ item: r.item, qty: r.qty }));
            } catch { /* non-critical */ }

            // CREATE new rental + bookings
            const savedRental = await this.prisma.rental.create({
              data: {
                listing_id: rental.listingId,
                title: rental.title,
                status: 'completed',
                start_date: rental.startDate,
                end_date: rental.endDate,
                renter_info: rental.renterInfo || null,
                listing_url: rental.listingUrl || '',
                account: rental.account || account.name,
                rental_price: rental.rentalPrice || null,
                price_per_day: rental.pricePerDay || null,
                ...(parsedItems ? { parsed_items: parsedItems } : {}),
              },
            });

            // Extract items from detail
            const itemNames: string[] = [];
            if (rental._detail?.items && Array.isArray(rental._detail.items)) {
              for (const item of rental._detail.items) {
                if (item.type === 'PRODUCT' && item.title) {
                  itemNames.push(item.title);
                }
              }
            }

            await this.calendarService.createBookingsFromRental(
              { ...savedRental, rental_price: rental.rentalPrice || savedRental.rental_price },
              itemNames,
            );

            syncResults.completed.imported++;
          } catch (err) {
            syncResults.completed.errors.push(`${rental.title}: ${err.message}`);
          }
        }
      } catch (err) {
        syncResults.completed.errors.push(`Account ${account.name}: ${err.message}`);
      }
    }

    this.logger.log(`Completed import: ${syncResults.completed.imported} new, ${syncResults.completed.updated} updated, ${syncResults.completed.skipped} skipped`);

    // ======= STEP 3: Reconcile past entries not in Hygglo completed =======
    this.logger.log('=== SYNC STEP 3: Reconciling phantom revenue entries ===');
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let totalCancelled = 0;

    for (const account of accounts) {
      try {
        const completedRentals = await this.hyggloService.scanCompletedRentalsPaginated(account.name);
        const completedIds = new Set(completedRentals.map(r => r.listingId));

        const phantomEntries = await this.prisma.rental.findMany({
          where: {
            account: account.name,
            end_date: { lt: cutoffDate },
            status: { notIn: ['cancelled'] },
            listing_id: { notIn: [...completedIds] },
          },
          select: { id: true, listing_id: true, rental_price: true },
        });

        for (const entry of phantomEntries) {
          await this.prisma.rental.update({ where: { id: entry.id }, data: { status: 'cancelled' } });
          await this.prisma.booking.updateMany({
            where: { rental_id: entry.id, status: { notIn: ['cancelled'] } },
            data: { status: 'cancelled' },
          });
          totalCancelled++;
        }

        if (phantomEntries.length > 0) {
          const phantomRev = phantomEntries.reduce((s, e) => s + Number(e.rental_price || 0), 0);
          this.logger.warn(`Reconcile ${account.name}: Cancelled ${phantomEntries.length} phantom entries (£${phantomRev.toFixed(0)})`);
        }
      } catch (err) {
        this.logger.error(`Reconcile ${account.name} failed: ${err.message}`);
      }
    }

    (syncResults as any).reconcilePhantom = { cancelled: totalCancelled };
    this.logger.log(`Reconcile: cancelled ${totalCancelled} phantom entries`);

    return syncResults;
  }

  @Get('revenue/parse-titles')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Backfill AI-parsed items for all rentals missing parsed_items' })
  @ApiResponse({ status: 200, description: 'Backfill results' })
  async parseTitles() {
    return this.titleParserService.backfillParsedItems();
  }

  @Get('revenue/reanalyze-photos')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Re-run photo vision analysis on all rentals with photos (fixes misidentified items)' })
  @ApiResponse({ status: 200, description: 'Reanalysis results with before/after changes' })
  async reanalyzePhotos() {
    return this.titleParserService.reanalyzeAllPhotos();
  }

  @Get('backfill/historical')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Backfill historical rentals from Hygglo completed orders (legacy — use /sync/full instead)' })
  @ApiResponse({ status: 200, description: 'Redirects to full sync' })
  async backfillHistorical() {
    return this.syncFull();
  }

  @Get('calendar/reconcile')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Reconcile bookings for recent rentals — creates missing bookings from parsed_items' })
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'Number of days to look back (default 14)' })
  @ApiResponse({ status: 200, description: 'Reconciliation results' })
  async reconcileBookings(@Query('days') days?: string) {
    const lookback = days ? parseInt(days, 10) || 14 : 14;
    return this.calendarService.reconcileRecentBookings(lookback);
  }

  @Get('calendar/resync-from-parsed')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Resync bookings from parsed_items — deletes wrong bookings, creates correct ones' })
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'Number of days to look back (default 365)' })
  async resyncFromParsed(@Query('days') days?: string) {
    const lookback = days ? parseInt(days, 10) || 365 : 365;
    return this.calendarService.resyncFromParsedItems(lookback);
  }

  @Get('calendar/recompute-revenue')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Recompute booking revenue using proportional split by catalog daily price' })
  async recomputeRevenue() {
    return this.calendarService.recomputeBookingRevenue();
  }

  @Get('cleanup/accessories')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Remove accessory bookings and fix platform fees on existing bookings' })
  @ApiResponse({ status: 200, description: 'Cleanup results' })
  async cleanupAccessories() {
    const accessoryNames = Array.from(ACCESSORY_ITEMS);

    // 1. Find and delete accessory bookings
    const accessoryBookings = await this.prisma.booking.findMany({
      where: { item_name: { in: accessoryNames } },
      select: { id: true, item_name: true, rental_id: true, revenue: true },
    });

    const deletedCount = accessoryBookings.length;
    if (deletedCount > 0) {
      await this.prisma.booking.deleteMany({
        where: { item_name: { in: accessoryNames } },
      });
      this.logger.log(`Deleted ${deletedCount} accessory bookings`);
    }

    // 2. For rentals that had accessories deleted, redistribute revenue to remaining main items
    const affectedRentalIds = [...new Set(accessoryBookings.filter(b => b.rental_id).map(b => b.rental_id!))];
    let redistributed = 0;

    for (const rentalId of affectedRentalIds) {
      const rental = await this.prisma.rental.findUnique({ where: { id: rentalId } });
      if (!rental) continue;

      const remainingBookings = await this.prisma.booking.findMany({
        where: { rental_id: rentalId, status: { in: ['confirmed', 'pending_review'] } },
      });

      if (remainingBookings.length === 0) continue;

      // Get the actual ownerEarnings from the rental price
      const totalRevenue = rental.rental_price || 0;
      const perItemRevenue = Math.round((totalRevenue / remainingBookings.length) * 100) / 100;

      for (const booking of remainingBookings) {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: {
            revenue: perItemRevenue > 0 ? perItemRevenue : null,
            platform_fee: 0,
            net_profit: perItemRevenue > 0 ? perItemRevenue : null,
          },
        });
      }
      redistributed++;
    }

    // 3. Fix platform fees on ALL bookings: net_profit should equal revenue (ownerEarnings already has fees deducted)
    const allBookingsWithFees = await this.prisma.booking.findMany({
      where: {
        revenue: { not: null },
        OR: [
          { platform_fee: { not: null, gt: 0 } },
          { net_profit: { not: null } },
        ],
      },
      select: { id: true, revenue: true, platform_fee: true, net_profit: true },
    });

    let feesCorrected = 0;
    for (const b of allBookingsWithFees) {
      if (b.revenue && (b.platform_fee !== 0 || b.net_profit !== b.revenue)) {
        await this.prisma.booking.update({
          where: { id: b.id },
          data: {
            platform_fee: 0,
            net_profit: b.revenue,
          },
        });
        feesCorrected++;
      }
    }

    this.logger.log(`Cleanup: ${deletedCount} accessories deleted, ${redistributed} rentals redistributed, ${feesCorrected} fees corrected`);
    return {
      accessoriesDeleted: deletedCount,
      rentalsRedistributed: redistributed,
      feesFixed: feesCorrected,
    };
  }

  @Get('backfill/bookings')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Backfill missing bookings from parsed_items + fetch empty titles from Hygglo' })
  @ApiResponse({ status: 200, description: 'Backfill results' })
  async backfillMissingBookings() {
    const results = {
      titlesFetched: 0,
      titlesFailed: 0,
      itemsParsed: 0,
      bookingsCreated: 0,
      rentalsProcessed: 0,
      skipped: 0,
    };

    // Step 1: Find rentals with empty titles — fetch from Hygglo API
    const emptyTitleRentals = await this.prisma.rental.findMany({
      where: {
        title: '',
        status: { in: ['completed', 'ongoing', 'upcoming'] },
      },
      select: { id: true, listing_id: true, account: true },
    });

    this.logger.log(`Backfill: ${emptyTitleRentals.length} rentals with empty titles`);

    for (const rental of emptyTitleRentals) {
      try {
        const accountName = (rental.account || 'dbcinema') as 'dbcinema' | 'leo';
        const detail = await this.hyggloService.getOrderDetailPublic(rental.listing_id, accountName);
        if (detail) {
          const rawTitle = detail.labels?.name || detail.title || '';
          const title = rawTitle.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

          const updateData: any = {};
          if (title) updateData.title = title;

          // Also extract renter info if missing
          if (detail.users?.otherPart?.name) {
            updateData.renter_info = detail.users.otherPart.name;
          }

          if (Object.keys(updateData).length > 0) {
            await this.prisma.rental.update({ where: { id: rental.id }, data: updateData });
            results.titlesFetched++;
          }
        }
      } catch (err) {
        this.logger.debug(`Failed to fetch title for ${rental.listing_id}: ${err.message}`);
        results.titlesFailed++;
      }
      // Rate limit: 300ms between requests
      await new Promise(r => setTimeout(r, 300));
    }

    // Step 2: Parse items for rentals that have titles but no parsed_items
    const unparsedRentals = await this.prisma.rental.findMany({
      where: {
        parsed_items: { equals: Prisma.DbNull },
        title: { not: '' },
        status: { in: ['completed', 'ongoing', 'upcoming'] },
      },
      select: { id: true, title: true, listing_id: true },
    });

    this.logger.log(`Backfill: ${unparsedRentals.length} rentals need item parsing`);

    for (const rental of unparsedRentals) {
      try {
        const resolved = await this.itemResolverService.resolveItems(rental.listing_id, rental.title);
        const parsed = resolved.map(r => ({ item: r.item, qty: r.qty }));
        if (parsed.length > 0) {
          await this.prisma.rental.update({
            where: { id: rental.id },
            data: { parsed_items: parsed as any },
          });
          results.itemsParsed++;
        }
      } catch { /* non-critical */ }
    }

    // Step 3: Create bookings for all rentals that have parsed_items but no bookings
    const rentalsNeedingBookings = await this.prisma.$queryRaw<
      { id: string; title: string; start_date: Date; end_date: Date; renter_info: string; account: string; rental_price: number; status: string; parsed_items: any }[]
    >`
      SELECT r.id, r.title, r.start_date, r.end_date, r.renter_info, r.account, r.rental_price, r.status, r.parsed_items
      FROM rental r
      WHERE r.status IN ('completed', 'ongoing', 'upcoming')
        AND r.rental_price > 0
        AND r.start_date IS NOT NULL
        AND r.end_date IS NOT NULL
        AND r.parsed_items IS NOT NULL
        AND (SELECT COUNT(*) FROM booking b WHERE b.rental_id = r.id AND b.status IN ('confirmed', 'pending_review')) = 0
    `;

    this.logger.log(`Backfill: ${rentalsNeedingBookings.length} rentals need booking creation`);

    for (const rental of rentalsNeedingBookings) {
      try {
        // Extract item names from parsed_items
        const items: string[] = [];
        const parsedItems = Array.isArray(rental.parsed_items) ? rental.parsed_items : [];
        for (const pi of parsedItems) {
          if (pi.item) {
            // parsed_items already has MASTER_INVENTORY names, add qty times
            for (let i = 0; i < (pi.qty || 1); i++) {
              items.push(pi.item);
            }
          }
        }

        if (items.length === 0) {
          results.skipped++;
          continue;
        }

        const created = await this.calendarService.createBookingsFromRental(rental, items);
        results.bookingsCreated += created.length;
        results.rentalsProcessed++;
      } catch (err) {
        this.logger.debug(`Backfill booking failed for ${rental.id}: ${err.message}`);
        results.skipped++;
      }
    }

    this.logger.log(`Backfill complete: ${JSON.stringify(results)}`);
    return results;
  }

  @Get('backfill/times')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Extract missing pickup/return times from chat history for confirmed bookings' })
  @ApiResponse({ status: 200, description: 'Extraction results per rental' })
  async backfillMissingTimes() {
    // Only check RECENT ongoing/upcoming bookings — never historical
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // Re-extract ALL active bookings — conversation-level AI is source of truth
    // and can correct previously wrong times from the old per-message system
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ['confirmed', 'pending_review'] },
        end_date: { gte: oneWeekAgo }, // Only ongoing or upcoming (ended within last week or future)
      },
      select: {
        id: true, rental_id: true, renter_name: true, pickup_time: true, return_time: true,
      },
      distinct: ['rental_id'],
    });

    const results: { total: number; extracted: number; noTimes: number; failed: number; details: any[] } = {
      total: bookings.length, extracted: 0, noTimes: 0, failed: 0, details: [],
    };

    // Process in parallel batches of 5 (fail-safe: each rental isolated)
    const BATCH_SIZE = 5;
    for (let i = 0; i < bookings.length; i += BATCH_SIZE) {
      const batch = bookings.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (b) => {
          if (!b.rental_id) return { renter: b.renter_name, status: 'no_rental_id' };

          const rental = await this.prisma.rental.findUnique({
            where: { id: b.rental_id },
          });
          if (!rental) return { renter: b.renter_name, status: 'no_rental' };

          const extracted = await this.autonomousService.extractAndUpdateTimes(rental);
          if (extracted && (extracted.pickupTime || extracted.returnTime)) {
            return {
              renter: b.renter_name,
              pickup: extracted.pickupTime || b.pickup_time || null,
              pickupDate: extracted.pickupDate || null,
              return: extracted.returnTime || b.return_time || null,
              returnDate: extracted.returnDate || null,
              status: 'extracted',
            };
          }
          return { renter: b.renter_name, status: 'no_times_in_chat' };
        }),
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          const d = result.value;
          results.details.push(d);
          if (d.status === 'extracted') results.extracted++;
          else if (d.status === 'no_times_in_chat') results.noTimes++;
          else results.failed++;
        } else {
          results.details.push({ status: `error: ${result.reason?.message || 'unknown'}` });
          results.failed++;
        }
      }
    }

    // Fix 5: times_status integrity — 'confirmed' with null times → downgrade
    let integrityFixed = 0;
    try {
      const brokenStates = await this.prisma.follow_up_state.findMany({
        where: { times_status: 'confirmed' },
        select: { id: true, rental_id: true },
      });
      for (const state of brokenStates) {
        if (!state.rental_id) continue;
        const booking = await this.prisma.booking.findFirst({
          where: { rental_id: state.rental_id, status: { in: ['confirmed', 'pending_review'] } },
          select: { pickup_time: true, return_time: true },
        });
        if (!booking || (!booking.pickup_time && !booking.return_time)) {
          await this.prisma.follow_up_state.update({
            where: { id: state.id },
            data: { times_status: 'none' },
          });
          integrityFixed++;
        } else if (!booking.pickup_time || !booking.return_time) {
          await this.prisma.follow_up_state.update({
            where: { id: state.id },
            data: { times_status: 'tentative' },
          });
          integrityFixed++;
        }
      }
    } catch (intErr) {
      this.logger.warn(`times_status integrity check error: ${(intErr as any).message}`);
    }

    this.logger.log(`Times backfill: ${results.extracted} extracted, ${results.noTimes} no times, ${results.failed} failed from ${results.total} rentals, ${integrityFixed} integrity fixes`);
    return { ...results, integrityFixed };
  }

  @Get('reconcile/stages')
  @ApiTags('Maintenance')
  @ApiOperation({ summary: 'Reconcile conversation stages with rental status — fixes stuck stages' })
  @ApiResponse({ status: 200, description: 'Reconciliation results' })
  async reconcileStages() {
    // Reassess stages for all active pipeline rentals (matches dashboard funnel scope)
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const states = await this.prisma.follow_up_state.findMany({
      where: {
        status: 'active',
        rental: {
          OR: [
            { status: { in: ['pending', 'upcoming', 'ongoing'] } },
            { end_date: { gte: twoWeeksAgo } },
          ],
        },
      },
      select: { rental_id: true, conversation_stage: true },
    });

    const before: Record<string, number> = {};
    const after: Record<string, number> = {};

    for (const s of states) {
      const stage = s.conversation_stage || 'null';
      before[stage] = (before[stage] || 0) + 1;
    }

    // Run reassessStage on each — this handles both status-based and conversation-based transitions
    let changed = 0;
    for (const s of states) {
      try {
        const result = await this.conversationStageService.reassessStage(s.rental_id);
        if (result.shouldTransition) changed++;
      } catch (err) {
        this.logger.warn(`Reconcile failed for ${s.rental_id}: ${err.message}`);
      }
    }

    // Get after counts
    const afterStates = await this.prisma.follow_up_state.findMany({
      where: {
        status: 'active',
        rental: {
          OR: [
            { status: { in: ['pending', 'upcoming', 'ongoing'] } },
            { end_date: { gte: twoWeeksAgo } },
          ],
        },
      },
      select: { conversation_stage: true },
    });
    for (const s of afterStates) {
      const stage = s.conversation_stage || 'null';
      after[stage] = (after[stage] || 0) + 1;
    }

    return { total: states.length, changed, before, after };
  }

  // --- Lost Revenue endpoints ---

  @Get('denied-revenue/summary')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Denied revenue summary — items were available but owner declined' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Denied revenue summary with top denied items (>£25 only)' })
  async getDeniedRevenueSummary(@Query('period') period?: string, @Query('account') account?: string) {
    return await this.lostRevenueService.getDeniedRevenueSummary(period || '3m', account || undefined);
  }

  @Get('lost-revenue/summary')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Lost revenue summary — items were booked out/unavailable' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Lost revenue summary with top blocked items (>£25 only)' })
  async getLostRevenueSummary(@Query('period') period?: string, @Query('account') account?: string) {
    return await this.lostRevenueService.getLostRevenueSummary(period || '3m', account || undefined);
  }

  @Get('lost-revenue/items')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Denied items breakdown with inventory suggestions' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Per-item denied count and lost revenue (>£25 only)' })
  async getLostRevenueItems(@Query('period') period?: string, @Query('account') account?: string) {
    return await this.lostRevenueService.getBlockedItemsBreakdown(period || '3m', account || undefined);
  }

  @Get('lost-revenue/sync')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Manually trigger obsolete booking sync' })
  @ApiQuery({ name: 'since', required: false, description: 'Days back to scan (default 90)' })
  @ApiResponse({ status: 200, description: 'Sync results per account' })
  async syncLostRevenue(@Query('since') since?: string) {
    const days = parseInt(since || '90', 10) || 90;
    const accounts = this.hyggloService.getAccounts();
    const results: Record<string, { imported: number; skipped: number }> = {};

    for (const account of accounts) {
      try {
        results[account.name] = await this.lostRevenueService.syncObsoleteBookings(account.name, days);
      } catch (error) {
        results[account.name] = { imported: 0, skipped: -1 };
        this.logger.error(`Lost revenue sync failed for ${account.name}: ${error.message}`);
      }
    }

    return results;
  }

  @Get('lost-revenue/backfill')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Backfill denial_type for existing records' })
  @ApiResponse({ status: 200, description: 'Number of records backfilled' })
  async backfillDenialTypes() {
    return await this.lostRevenueService.backfillDenialTypes();
  }

  @Get('missed-revenue/summary')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Missed revenue summary — items not in inventory with actual revenue' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Missed revenue from unmatched items with revenue amounts' })
  async getMissedRevenueSummary(@Query('period') period?: string, @Query('account') account?: string) {
    return await this.lostRevenueService.getMissedRevenueSummary(period || '3m', account || undefined);
  }

  @Get('timeout-revenue/summary')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Timeout revenue summary — items in stock but owner never responded' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Timeout revenue summary with top items' })
  async getTimeoutRevenueSummary(@Query('period') period?: string, @Query('account') account?: string) {
    return await this.lostRevenueService.getTimeoutSummary(period || '3m', account || undefined);
  }

  @Get('lost-revenue/unmatched')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Demand for items we don\'t stock' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Unmatched item demand with estimated revenue' })
  async getUnmatchedDemand(@Query('period') period?: string, @Query('account') account?: string) {
    return await this.lostRevenueService.getUnmatchedDemand(period || '6m', account || undefined);
  }

  @Get('lost-revenue/combined')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Combined lost revenue — denied, timeout, items, unmatched in one call' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Combined lost revenue data (4 queries in parallel)' })
  async getCombinedLostRevenue(@Query('period') period?: string, @Query('account') account?: string) {
    const p = period || '3m';
    const a = account || undefined;
    const [denied, timeout, items, unmatched, missed] = await Promise.all([
      this.lostRevenueService.getDeniedRevenueSummary(p, a),
      this.lostRevenueService.getTimeoutSummary(p, a),
      this.lostRevenueService.getBlockedItemsBreakdown(p, a),
      this.lostRevenueService.getUnmatchedDemand(p === '3m' ? '6m' : p, a),
      this.lostRevenueService.getMissedRevenueSummary(p, a),
    ]);
    return { denied, timeout, items, unmatched, missed };
  }

  @Get('lost-revenue/monthly-breakdown')
  @ApiTags('Lost Revenue')
  @ApiOperation({ summary: 'Monthly breakdown of denied and missed revenue' })
  async getMonthlyBreakdown(@Query('months') months?: string) {
    const monthCount = parseInt(months || '6') || 6;
    const results: any[] = [];
    for (let i = 0; i < monthCount; i++) {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const monthLabel = start.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      const [denied, missed, cancelled, timeout] = await Promise.all([
        this.prisma.lost_revenue_record.aggregate({ where: { denial_type: 'owner_denied', start_date: { gte: start, lt: end } }, _sum: { lost_revenue: true }, _count: true }),
        this.prisma.lost_revenue_record.aggregate({ where: { denial_type: 'unmatched', start_date: { gte: start, lt: end } }, _sum: { lost_revenue: true }, _count: true }),
        this.prisma.lost_revenue_record.aggregate({ where: { denial_type: 'renter_cancelled', start_date: { gte: start, lt: end } }, _sum: { lost_revenue: true }, _count: true }),
        this.prisma.lost_revenue_record.aggregate({ where: { denial_type: 'timeout', start_date: { gte: start, lt: end } }, _sum: { lost_revenue: true }, _count: true }),
      ]);
      results.push({
        month: monthLabel, monthKey: start.toISOString().substring(0, 7),
        denied: { count: denied._count, revenue: Math.round(denied._sum.lost_revenue || 0) },
        missed: { count: missed._count, revenue: Math.round(missed._sum.lost_revenue || 0) },
        cancelled: { count: cancelled._count, revenue: Math.round(cancelled._sum.lost_revenue || 0) },
        timeout: { count: timeout._count, revenue: Math.round(timeout._sum.lost_revenue || 0) },
      });
    }
    return results.reverse();
  }

  @Get('revenue/potential')
  @ApiTags('Revenue')
  @ApiOperation({ summary: 'Investment scorecard with confidence scoring for all items' })
  @ApiQuery({ name: 'period', required: false, description: 'week, month, 3m, 6m, 12m, all' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Items with confidence score, utilization, and earning potential' })
  async getRevenuePotential(@Query('period') period?: string, @Query('account') account?: string) {
    return await this.lostRevenueService.getRevenuePotential(period || '6m', account || undefined);
  }

  @Get('inventory/unavailable')
  @ApiTags('Inventory')
  @ApiOperation({ summary: 'Items currently fully booked (all units out)' })
  @ApiResponse({ status: 200, description: 'Items with all units currently out and return dates' })
  async getCurrentlyUnavailable() {
    return await this.lostRevenueService.getCurrentlyUnavailable();
  }

  @Get('inventory/items')
  @ApiOperation({ summary: 'Get inventory items grouped by category for UI dropdowns' })
  getInventoryItemsList() {
    const categories = [
      { name: 'Anamorphic Lenses', prefix: 'Anamorphic' },
      { name: 'Sony Lenses', items: ['Sony GM 24-70mm f2.8','Sony GM 16-35mm f2.8','Sony GM 70-200mm f2.8','Sony GM 90mm f2.8','Sony 28-70mm','Sony 11mm f2.8 fisheye'] },
      { name: 'Canon Lenses', prefix: 'Canon' },
      { name: 'Camera Bodies', items: ['Sony FX3','Sony A7 III','Sony A7 V','Sony A7 II','Fujifilm X100 VI','BMPCC 6K Pro','BMPCC 6K Full Frame'] },
      { name: 'Lights & Modifiers', items: ['Softbox 85cm','LED light panels RGB','Nanlite Forza 300','Nanlite Pavotube 30x II','Nanlite 500B','Ambitful RGB light tubes 2x set','5-in-1 reflector panel','Camera flash'] },
      { name: 'Support & Gimbals', items: ['C-stand','Small rig tripod','Sirui tripod','DJI RS3 Pro gimbal','Motorized slider','Tilta Nucleus Nano 2 follow focus','Tilta shoulder rig','Monopod arm support'] },
      { name: 'Monitors & Transmitters', items: ['Atomos Ninja V','Hollyland Mars 4K transmitter','Hollyland Pyro S transmitter','Hollyland 7-inch monitor'] },
      { name: 'Audio', items: ['Rode Video Mic Go','Rode Wireless Mic Pro set','Rode Video Mic Pro Plus','Audio boom mic Sennheiser','DJI Wireless Mics','DJI Mic 2 wireless','JBL wireless microphones'] },
      { name: 'Drones & Action Cameras', items: ['DJI Mavic 3 Pro','DJI Mini 4 Pro','DJI Osmo Action Pro 5','GoPro 12 Hero'] },
      { name: 'DJ & Speakers', items: ['DJ RX3 Pioneer controller','JBL Club 120 speaker'] },
      { name: 'Smoke & Effects', items: ['Smoke machine fogger','Smoke Ninja Pro hazer','Smoke Ninja'] },
      { name: 'Power & Batteries', items: ['V-mount 95mAh','V-mount 150mAh','Sony NP-FZ100 batteries 2x sets','DJI gimbal battery','Anker Power Station F2000'] },
      { name: 'Filters & Accessories', items: ['ND filter','Cinebloom filter mist','256GB card','CF Express Type A card','Suction cups','PL to Sony E mount','PL to EF mount','PL to RF mount','PL to L mount'] },
    ];
    const allItems = Object.keys(MASTER_INVENTORY);
    return {
      categories: categories.map(cat => {
        if (cat.items) return { name: cat.name, items: cat.items.filter(i => allItems.includes(i)) };
        if (cat.prefix) return { name: cat.name, items: allItems.filter(i => i.startsWith(cat.prefix)) };
        return cat;
      }),
    };
  }

  @Get('analytics/business-intelligence')
  @ApiTags('Analytics')
  @ApiOperation({ summary: 'Advanced business intelligence — denied analysis, time gaps, substitutions, marketing demand, purchase recommendations' })
  async getBusinessIntelligence(@Query('period') period?: string) {
    try {
      const [
        denied,
        missed,
        timeGap,
        substitutions,
        marketingDemand,
        purchaseRecs,
        potential,
      ] = await Promise.all([
        this.lostRevenueService.getDeniedRevenueSummary(period || '6m'),
        this.lostRevenueService.getMissedRevenueSummary(period || '6m'),
        this.lostRevenueService.getTimeGapAnalysis(),
        this.lostRevenueService.getSubstitutionAnalysis(period || '6m'),
        this.lostRevenueService.getMarketingOnlyDemand(period || '6m'),
        this.lostRevenueService.getPurchaseRecommendations(),
        this.lostRevenueService.getRevenuePotential(period || '6m'),
      ]);

      return {
        denied: {
          totalRevenue: denied.totalDeniedRevenue,
          count: denied.deniedCount,
          topItems: denied.topDeniedItems?.slice(0, 10) || [],
        },
        missed: {
          totalRevenue: missed.totalMissedRevenue,
          count: missed.missedCount,
          topItems: missed.topMissedItems?.slice(0, 10) || [],
        },
        timeGap,
        substitutions: {
          pairs: substitutions.substitutions,
          topRequestedNotOwned: substitutions.topRequestedNotOwned,
          totalSubstitutedRevenue: substitutions.totalSubstitutedRevenue,
        },
        marketingDemand: {
          items: marketingDemand.items,
          totalPotentialRevenue: marketingDemand.totalPotentialRevenue,
        },
        purchaseRecommendations: purchaseRecs,
        investmentScorecard: potential.slice(0, 20),
      };
    } catch (error) {
      return { error: `BI analysis failed: ${error.message}` };
    }
  }

  // --- Competitor Intelligence endpoints ---

  @Get('price-recommendations')
  @ApiTags('Competitor Intelligence')
  @ApiOperation({ summary: 'Per-item price comparison: our price vs competitors with signals' })
  @ApiResponse({ status: 200, description: 'Price recommendations with gap analysis' })
  async getPriceRecommendations() {
    return await this.competitorIntelService.getPriceRecommendations();
  }

  @Get('competitor-intel/insights')
  @ApiTags('Competitor Intelligence')
  @ApiOperation({ summary: 'AI-generated strategic recommendations from competitor data' })
  @ApiQuery({ name: 'budget', required: false, description: '0-500, 500-2000, or 2000+' })
  @ApiResponse({ status: 200, description: 'Strategic recommendations (budget-filtered if specified)' })
  async getCompetitorInsights(@Query('budget') budget?: string) {
    const validBudgets = ['0-500', '500-2000', '2000+'];
    if (budget && validBudgets.includes(budget)) {
      const revenueContext = await this.lostRevenueService.buildAIContext();
      return await this.competitorIntelService.generateBudgetInsights(budget, revenueContext);
    }
    return await this.competitorIntelService.generateInsights();
  }

  @Get('competitor-intel/catalog')
  @ApiTags('Competitor Intelligence')
  @ApiOperation({ summary: 'Competitor listing catalog' })
  @ApiQuery({ name: 'competitor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Competitor listings grouped by competitor' })
  async getCompetitorCatalog(@Query('competitor') competitor?: string) {
    return await this.competitorIntelService.getCompetitorCatalog(competitor || undefined);
  }

  @Get('competitor-intel/reviews')
  @ApiTags('Competitor Intelligence')
  @ApiOperation({ summary: 'Recent competitor reviews' })
  @ApiQuery({ name: 'competitor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Competitor reviews' })
  async getCompetitorReviews(
    @Query('competitor') competitor?: string,
    @Query('limit') limit?: string,
  ) {
    const l = Math.min(parseInt(limit || '20', 10) || 20, 100);
    return await this.competitorIntelService.getCompetitorReviews(competitor || undefined, l);
  }

  @Get('competitor-intel/summary')
  @ApiTags('Competitor Intelligence')
  @ApiOperation({ summary: 'Aggregate competitor stats and market gaps' })
  @ApiResponse({ status: 200, description: 'Competitor summary with market gaps' })
  async getCompetitorSummary() {
    return await this.competitorIntelService.getCompetitorSummary();
  }

  @Get('competitor-intel/sync')
  @ApiTags('Competitor Intelligence')
  @ApiOperation({ summary: 'Manually trigger competitor data scrape + insight generation' })
  @ApiResponse({ status: 200, description: 'Sync results' })
  async syncCompetitorIntel() {
    const scraped = await this.competitorIntelService.scrapeCompetitorListings();
    const reviews = await this.competitorIntelService.scrapeCompetitorReviews();

    // Force regeneration with fresh data (both old format and all budget tiers)
    const revenueContext = await this.lostRevenueService.buildAIContext();
    const [insights] = await Promise.all([
      this.competitorIntelService.generateInsights(true),
      this.competitorIntelService.generateBudgetInsights('0-500', revenueContext, true),
      this.competitorIntelService.generateBudgetInsights('500-2000', revenueContext, true),
      this.competitorIntelService.generateBudgetInsights('2000+', revenueContext, true),
    ]);

    return {
      scraped,
      reviews,
      insights: insights.recommendations.length > 0,
    };
  }

  @Get('market-releases/insights')
  @ApiTags('Market Intelligence')
  @ApiOperation({ summary: 'Latest market release opportunities' })
  @ApiResponse({ status: 200, description: 'New product opportunities based on similar item performance' })
  async getMarketReleaseInsights() {
    return await this.marketReleasesService.getLatestInsights();
  }

  @Get('market-releases/scan')
  @ApiTags('Market Intelligence')
  @ApiOperation({ summary: 'Manually trigger market release scan (monthly cron)' })
  @ApiResponse({ status: 200, description: 'Scan results' })
  async triggerMarketReleaseScan() {
    await this.marketReleasesService.monthlyReleaseScan();
    return await this.marketReleasesService.getLatestInsights();
  }

  // --- Vacation Mode ---

  @Get('vacation/upcoming')
  @ApiTags('Vacation')
  @ApiOperation({ summary: 'Upcoming owner unavailability blocks (up to 3)' })
  @ApiResponse({ status: 200, description: 'Upcoming vacation blocks' })
  async getUpcomingVacation() {
    const now = new Date();
    const blocks = await this.prisma.owner_unavailability.findMany({
      where: {
        active: true,
        OR: [
          { end_time: { gte: now } },
          { end_time: null, start_time: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } },
        ],
      },
      orderBy: { start_time: 'asc' },
      take: 3,
    });

    return blocks.map(b => ({
      id: b.id,
      startTime: b.start_time,
      endTime: b.end_time,
      reason: b.reason,
      allDay: b.all_day,
    }));
  }

  // --- Return Hub ---

  @Get('rentals/ongoing')
  @ApiTags('Return Hub')
  @ApiOperation({ summary: 'Ongoing rentals for return processing' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Ongoing rentals ready for return' })
  async getOngoingRentals(@Query('account') account?: string) {
    return await this.appService.getOngoingRentals(account || undefined);
  }

  @Post('rentals/:id/return')
  @ApiTags('Return Hub')
  @ApiOperation({ summary: 'Process a rental return' })
  @ApiResponse({ status: 200, description: 'Return processed' })
  async processReturn(
    @Param('id') id: string,
    @Body() body: { outcome: 'good' | 'issues'; blacklist?: boolean; reason?: string; issues?: string[]; skipFollowUp?: boolean; dashboardApproved?: boolean },
  ) {
    return await this.appService.processReturn(id, body);
  }

  @Post('rentals/:id/send-thankyou')
  @ApiTags('Return Hub')
  @ApiOperation({ summary: 'Manually send thank you + review request' })
  @ApiResponse({ status: 200, description: 'Thank you sent' })
  async sendThankYou(@Param('id') id: string) {
    return await this.appService.sendThankYou(id);
  }

  // --- Sell Recommender ---

  @Get('recommender/sell-items')
  @ApiTags('Sell Recommender')
  @ApiOperation({ summary: 'Item sell recommendations based on rental performance + eBay resale prices' })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Sell recommendations with scores and verdicts' })
  async getSellRecommendations(@Query('account') account?: string) {
    return await this.sellRecommenderService.getSellRecommendations(account || undefined);
  }

  @Get('recommender/ebay-scrape')
  @ApiTags('Sell Recommender')
  @ApiOperation({ summary: 'Manually trigger eBay sold price scrape for all inventory items' })
  @ApiResponse({ status: 200, description: 'eBay scrape results' })
  async triggerEbayScrape() {
    return await this.sellRecommenderService.scrapeAllEbayPrices();
  }

  @Post('recommender/ebay-prices')
  @ApiTags('Sell Recommender')
  @ApiOperation({ summary: 'Import eBay resale prices manually (JSON: { "Item Name": price })' })
  async importEbayPrices(@Body() prices: Record<string, number>) {
    return await this.sellRecommenderService.importEbayPrices(prices);
  }

  @Get('recommender/ebay-template')
  @ApiTags('Sell Recommender')
  @ApiOperation({ summary: 'Get price template (all items with current cached prices)' })
  async getEbayTemplate() {
    return await this.sellRecommenderService.getEbayPriceTemplate();
  }

  @Get('inventory/valuation')
  @ApiTags('Sell Recommender')
  @ApiOperation({ summary: 'Conservative inventory valuation based on eBay sold prices' })
  @ApiResponse({ status: 200, description: 'Total inventory resale value with per-item breakdown' })
  async getInventoryValuation() {
    return await this.sellRecommenderService.getInventoryValuation();
  }

  // --- Insurance Claims ---

  @Get('insurance/claims')
  @ApiTags('Insurance')
  @ApiOperation({ summary: 'List all insurance claims + total for new claims' })
  @ApiResponse({ status: 200, description: 'Claims list with total' })
  async getInsuranceClaims() {
    return await this.appService.getInsuranceClaims();
  }

  @Post('insurance/claims')
  @ApiTags('Insurance')
  @ApiOperation({ summary: 'Create a new insurance claim' })
  @ApiResponse({ status: 201, description: 'Claim created' })
  async createInsuranceClaim(@Body() body: { amount: number; item: string; damage: string; notes?: string; is_new: boolean }) {
    if (!body.amount || !body.item || !body.damage || body.is_new === undefined) {
      return { error: 'amount, item, damage, and is_new are required' };
    }
    return await this.appService.createInsuranceClaim(body);
  }

  @Delete('insurance/claims/:id')
  @ApiTags('Insurance')
  @ApiOperation({ summary: 'Delete an insurance claim' })
  @ApiResponse({ status: 200, description: 'Claim deleted' })
  async deleteInsuranceClaim(@Param('id') id: string) {
    try {
      await this.appService.deleteInsuranceClaim(id);
      return { success: true };
    } catch {
      return { error: 'Claim not found' };
    }
  }

  // --- Marketing Listings ---

  @Get('marketing-listings')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'List all marketing listings with optional filters' })
  @ApiQuery({ name: 'image_status', required: false, type: String })
  @ApiQuery({ name: 'upload_status', required: false, type: String })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Marketing listings' })
  async getMarketingListings(
    @Query('image_status') imageStatus?: string,
    @Query('upload_status') uploadStatus?: string,
    @Query('account') account?: string,
  ) {
    return await this.listingCreatorService.getMarketingListings({
      image_status: imageStatus,
      upload_status: uploadStatus,
      account,
    });
  }

  @Get('marketing-listings/stats')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Marketing listing summary stats' })
  @ApiResponse({ status: 200, description: 'Stats summary' })
  async getMarketingListingStats() {
    return await this.listingCreatorService.getMarketingListingStats();
  }

  @Get('marketing-listings/discover')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Manually trigger listing discovery from competitor reviews' })
  @ApiResponse({ status: 200, description: 'Discovery results' })
  async discoverMarketingListings() {
    const count = await this.listingCreatorService.discoverListingsFromReviews();
    return { discovered: count };
  }

  @Get('marketing-listings/:id')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Get marketing listing detail' })
  @ApiResponse({ status: 200, description: 'Marketing listing detail' })
  async getMarketingListing(@Param('id') id: string) {
    const listing = await this.listingCreatorService.getMarketingListing(id);
    if (!listing) return { error: 'Not found' };
    return listing;
  }

  @Post('marketing-listings')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Create a marketing listing (manual or from search bar)' })
  @ApiResponse({ status: 201, description: 'Marketing listing created' })
  async createMarketingListing(@Body() body: { itemName: string; title?: string; account?: string }) {
    if (!body.itemName) return { error: 'itemName is required' };
    return await this.listingCreatorService.createMarketingListing(body);
  }

  @Patch('marketing-listings/:id')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Update marketing listing fields' })
  @ApiResponse({ status: 200, description: 'Marketing listing updated' })
  async updateMarketingListing(@Param('id') id: string, @Body() body: Record<string, any>) {
    try {
      return await this.listingCreatorService.updateMarketingListing(id, body);
    } catch {
      return { error: 'Not found or update failed' };
    }
  }

  @Post('marketing-listings/:id/approve')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Approve a marketing listing for upload' })
  @ApiResponse({ status: 200, description: 'Marketing listing approved' })
  async approveMarketingListing(@Param('id') id: string) {
    try {
      return await this.listingCreatorService.approveMarketingListing(id);
    } catch {
      return { error: 'Not found or approval failed' };
    }
  }

  @Post('marketing-listings/:id/generate-image')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Generate listing image (find → remove BG → compose)' })
  @ApiResponse({ status: 200, description: 'Image generation result' })
  async generateMarketingListingImage(@Param('id') id: string) {
    return this.listingCreatorService.generateImages(id);
  }

  @Post('marketing-listings/generate-all-images')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Generate images for all pending listings' })
  @ApiResponse({ status: 200, description: 'Batch image generation result' })
  async generateAllMarketingListingImages() {
    return this.listingCreatorService.generateAllPendingImages();
  }

  @Post('marketing-listings/re-estimate')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Re-estimate pricing and revenue for all listings using improved fuzzy matching' })
  @ApiResponse({ status: 200, description: 'Re-estimation result' })
  async reEstimateMarketingListings() {
    return this.listingCreatorService.reEstimateAll();
  }

  @Post('marketing-listings/reset-images')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Reset image statuses to pending for re-processing' })
  @ApiResponse({ status: 200, description: 'Number of listings reset' })
  async resetMarketingListingImages() {
    const count = await this.listingCreatorService.resetImageStatuses();
    return { reset: count };
  }




  // ── Port to Leo ──

  @Get('port-to-leo/gaps')
  @ApiTags('Port to Leo')
  @ApiOperation({ summary: 'Get DB Cinema listings missing from Leo with images' })
  async getPortGaps() {
    const result = await this.listingCreatorService.getPortableGaps();
    return result;
  }

  @Post('port-to-leo/execute')
  @ApiTags('Port to Leo')
  @ApiOperation({ summary: 'Port a single DB Cinema listing to Leo' })
  async executePort(@Body() body: { slug: string; title: string; image?: string; price?: number }) {
    const result = await this.listingCreatorService.portSingleListing(body);
    return result;
  }
  @Post('port-to-leo/upload')
  @ApiTags('Port to Leo')
  @ApiOperation({ summary: 'Upload a ported listing to Hygglo via Playwright' })
  async uploadPortedListing(@Body() body: {
    listingId: string;
    autoPublish?: boolean;
    title?: string;
    description?: string;
    categoryPath?: string[];
    dailyPrice?: number;
    price3days?: number;
    price7days?: number;
    estimatedValue?: number;
  }) {
    // Get the marketing listing from DB
    const listing = await this.prisma.marketing_listing.findUnique({
      where: { id: body.listingId },
    });
    if (!listing) return { success: false, error: 'Listing not found' };
    if (!listing.composed_image) return { success: false, error: 'No composed image for this listing' };

    // Use body overrides if provided, fall back to DB values
    const uploadTitle = body.title || listing.title;
    const uploadDesc = body.description || listing.description || '';
    const uploadDailyPrice = body.dailyPrice ?? (listing.price_1day ? Number(listing.price_1day) : 25);
    const uploadEstValue = body.estimatedValue ?? (listing.price_1day ? Number(listing.price_1day) * 10 : 250);

    // Update the DB listing with edited values
    await this.prisma.marketing_listing.update({
      where: { id: body.listingId },
      data: {
        title: uploadTitle,
        description: uploadDesc,
        price_1day: uploadDailyPrice,
        price_3day: body.price3days ?? undefined,
        price_7day: body.price7days ?? undefined,
        estimated_value: uploadEstValue,
      },
    });

    const result = await this.playwrightService.createMarketingListing({
      account: (listing.account || 'leo') as any,
      title: uploadTitle,
      description: uploadDesc,
      dailyPrice: uploadDailyPrice,
      price3days: body.price3days,
      price7days: body.price7days,
      estimatedValue: uploadEstValue,
      imagePath: listing.composed_image,
      categoryPath: body.categoryPath,
      autoPublish: body.autoPublish || false,
    });

    // Update listing status
    if (result.success) {
      await this.prisma.marketing_listing.update({
        where: { id: body.listingId },
        data: {
          upload_status: result.error?.includes('REVIEW_REQUIRED') ? 'review' : 'uploaded',
          hygglo_listing_id: result.hyggloListingUrl || null,
        },
      });
    }

    return result;
  }


  @Get("port-to-leo/screenshot")
  @ApiTags("Port to Leo")
  async getUploadScreenshot(@Query("path") filePath: string, @Res() res: any) {
    const fs = require("fs");
    if (!filePath || !filePath.startsWith("/tmp/hygglo-")) {
      return res.status(400).json({ error: "Invalid path" });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Screenshot not found" });
    }
    res.type("image/png");
    res.send(fs.readFileSync(filePath));
  }


  @Delete('marketing-listings/:id')
  @ApiTags('Marketing Listings')
  @ApiOperation({ summary: 'Delete a marketing listing' })
  @ApiResponse({ status: 200, description: 'Marketing listing deleted' })
  async deleteMarketingListing(@Param('id') id: string) {
    try {
      await this.listingCreatorService.deleteMarketingListing(id);
      return { success: true };
    } catch {
      return { error: 'Not found' };
    }
  }

  // ---- Claude Code: Server Operations Chat ----

  private readonly PROJECT_DIR = '/home/ubuntu/rental-manager';

  private validatePath(filePath: string): string {
    const resolved = path.resolve(this.PROJECT_DIR, filePath);
    if (!resolved.startsWith(this.PROJECT_DIR + '/') && resolved !== this.PROJECT_DIR) {
      throw new Error('Path outside project directory: ' + filePath);
    }
    return resolved;
  }

  private validateCommand(cmd: string): boolean {
    // Split on shell operators to check each sub-command
    const parts = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/);
    const allowedPrefixes = ['npm', 'npx', 'git', 'cat', 'head', 'tail', 'ls', 'find', 'grep', 'rg', 'wc', 'diff', 'node', 'tsc', 'echo', 'pwd', 'mkdir', 'touch', 'cp'];
    const allowedSudo = ['sudo systemctl restart rental-manager', 'sudo systemctl status rental-manager', 'sudo systemctl is-active rental-manager'];
    const allowedJournal = 'journalctl -u rental-manager';

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Block dangerous patterns
      if (/rm\s+(-[a-z]*r|-[a-z]*f)\s/i.test(trimmed)) return false;
      if (/\.\.\//g.test(trimmed) && trimmed.includes('/')) return false;

      // Check sudo whitelist
      if (trimmed.startsWith('sudo ')) {
        if (!allowedSudo.some(s => trimmed.startsWith(s))) return false;
        continue;
      }
      // Check journalctl
      if (trimmed.startsWith('journalctl')) {
        if (!trimmed.startsWith(allowedJournal)) return false;
        continue;
      }
      // Check allowed prefixes
      const firstWord = trimmed.split(/\s/)[0];
      if (!allowedPrefixes.includes(firstWord)) return false;
    }
    return true;
  }

  private async executeToolCall(toolName: string, input: any): Promise<string> {
    try {
      if (toolName === 'execute_command') {
        const cmd = input.command as string;
        if (!this.validateCommand(cmd)) {
          return JSON.stringify({ error: 'Command not allowed: ' + cmd });
        }
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            cwd: this.PROJECT_DIR,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          });
          const out = (stdout || '').substring(0, 4000);
          const err = (stderr || '').substring(0, 1000);
          return out + (err ? '\nSTDERR: ' + err : '');
        } catch (e: any) {
          return `Exit code ${e.code || 1}\n${(e.stdout || '').substring(0, 2000)}\n${(e.stderr || '').substring(0, 2000)}`;
        }
      }

      if (toolName === 'read_file') {
        const filePath = this.validatePath(input.path);
        const content = fs.readFileSync(filePath, 'utf-8');
        const offset = input.offset || 0;
        const limit = input.limit || 200;
        const lines = content.split('\n');
        return lines.slice(offset, offset + limit).map((l, i) => `${offset + i + 1}: ${l}`).join('\n').substring(0, 8000);
      }

      if (toolName === 'write_file') {
        const filePath = this.validatePath(input.path);
        if (filePath.includes('node_modules/') || filePath.endsWith('.env') || filePath.includes('prisma/migrations/')) {
          return JSON.stringify({ error: 'Cannot write to protected path: ' + input.path });
        }
        fs.writeFileSync(filePath, input.content, 'utf-8');
        return JSON.stringify({ success: true, bytesWritten: Buffer.byteLength(input.content) });
      }

      if (toolName === 'list_directory') {
        const dirPath = this.validatePath(input.path || '.');
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries.map(e => (e.isDirectory() ? 'd ' : 'f ') + e.name).join('\n').substring(0, 4000);
      }

      return JSON.stringify({ error: 'Unknown tool: ' + toolName });
    } catch (e: any) {
      return JSON.stringify({ error: e.message });
    }
  }

  private async sendClaudeCodeTelegramNotification(
    task: string, result: string, toolCalls: { tool: string; input: any; output: string }[],
  ): Promise<void> {
    // Strip Markdown special chars from dynamic content for safe Telegram Markdown
    const esc = (s: string) => s.replace(/[_*`\[\]]/g, '');

    const toolSummary = toolCalls.slice(0, 8).map(tc => {
      const label = tc.tool === 'execute_command' ? tc.input.command :
                    tc.tool === 'read_file' ? tc.input.path :
                    tc.tool === 'write_file' ? tc.input.path :
                    tc.tool === 'list_directory' ? (tc.input.path || '.') :
                    JSON.stringify(tc.input);
      return `  • ${tc.tool}: ${esc((label || '').substring(0, 60))}`;
    }).join('\n');

    const text = [
      '🤖 *Claude Code completed*',
      '',
      `_Task:_ ${esc(task.substring(0, 100))}`,
      `_Tools:_ ${toolCalls.length} call${toolCalls.length !== 1 ? 's' : ''}`,
      toolSummary,
      '',
      `_Result:_ ${esc((result || '').substring(0, 200))}`,
    ].join('\n');

    await this.telegramService.sendProactiveMessage(text, 'Markdown');
  }

  // ---- Cron Claude: Tick + Runner ----

  private async cronTick(): Promise<void> {
    if (this.cronRunning) return;

    const enabled = await this.configManager.getBool('cron_claude.enabled');
    if (!enabled) return;

    // Quiet hours check
    const quietStart = await this.configManager.getInt('cron_claude.quiet_hours_start') ?? 2;
    const quietEnd = await this.configManager.getInt('cron_claude.quiet_hours_end') ?? 7;
    const hour = new Date().getUTCHours();
    if (quietStart <= quietEnd ? (hour >= quietStart && hour < quietEnd) : (hour >= quietStart || hour < quietEnd)) return;

    const frequencyMs = ((await this.configManager.getInt('cron_claude.frequency_minutes')) ?? 240) * 60_000;
    const tasksStr = (await this.configManager.get('cron_claude.tasks')) || 'message_audit';
    const enabledTasks = tasksStr.split(',').map(t => t.trim()).filter(t => this.CRON_TASKS[t]);

    for (const taskKey of enabledTasks) {
      const lastRun = this.cronLastRun[taskKey] || 0;
      if (Date.now() - lastRun >= frequencyMs) {
        this.runCronTask(taskKey).catch(e => {
          this.logger.error(`Cron task ${taskKey} failed: ${e.message}`);
        });
        return; // Only 1 task per tick
      }
    }
  }

  private async runCronTask(taskKey: string): Promise<{ result: string; toolCount: number }> {
    const task = this.CRON_TASKS[taskKey];
    if (!task) throw new Error(`Unknown cron task: ${taskKey}`);

    this.cronRunning = true;
    this.cronLastRun[taskKey] = Date.now();
    const startedAt = new Date();
    this.logger.log(`Cron task starting: ${task.label}`);

    try {
      // Build rules-aware system prompt
      const compactRules = await this.rulesService.getCompactRules();
      const systemPrompt = `You are Claude Code (Autonomous), running a scheduled maintenance task on the rental-manager bot at /home/ubuntu/rental-manager/.
You have FULL write access to the project directory.

## Your Mission
${task.prompt}

## Bot Rules (MANDATORY)
${compactRules}

## Understanding Rules
Before modifying ANY rule:
1. Understand WHY it exists — what problem does it prevent?
2. Verify the issue is systematic (3+ occurrences), not a one-off
3. Ensure your fix IMPROVES communication quality
4. Prefer targeted, elegant solutions. Avoid regex hacks or fuzzy matching.

## Constraints
- Changes must make the bot BETTER at communicating with renters
- Never remove safety rules (escalation, verification, credential protection)
- If unsure, REPORT instead of fixing — add to your summary
- Stack: NestJS + TypeScript, PostgreSQL/Prisma, Ubuntu 24.04
- Build: npm run build | Restart: sudo systemctl restart rental-manager

## Working Style
- Be token-efficient. Read only what you need.
- Verify changes compile before finishing.
- End with a clear summary.`;

      // Write prompt to temp file
      const tmpPath = `/tmp/cron-prompt-${Date.now()}.txt`;
      fs.writeFileSync(tmpPath, systemPrompt);

      const args = [
        '-p', task.prompt,
        '--output-format', 'json',
        '--max-turns', '15',
        '--model', 'sonnet',
        '--system-prompt-file', tmpPath,
        '--allowedTools', 'Bash,Read,Edit,Write,Grep,Glob',
        '--no-session-persistence',
        '--settings', JSON.stringify({ hooks: {}, permissions: { allow: ['Bash(*)', 'Read', 'Write', 'Edit', 'Grep', 'Glob'] } }),
      ];

      const result = await new Promise<{ result: string; numTurns: number }>((resolve, reject) => {
        const cronCleanEnv: Record<string, string> = {
          HOME: '/home/ubuntu',
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          USER: 'ubuntu',
          LANG: process.env.LANG || 'C.UTF-8',
        };
        const child = spawn('/usr/bin/claude', args, {
          cwd: '/home/ubuntu/rental-manager',
          env: cronCleanEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('Cron CLI timed out after 5 minutes'));
        }, 300_000);

        child.on('close', (code) => {
          clearTimeout(timeout);
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          try {
            const parsed = JSON.parse(stdout);
            resolve({ result: parsed.result || '', numTurns: parsed.num_turns || 0 });
          } catch {
            if (code !== 0) reject(new Error(`CLI exited ${code}: ${stderr.substring(0, 300)}`));
            else resolve({ result: stdout.substring(0, 500), numTurns: 0 });
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          reject(err);
        });
      });

      const completedAt = new Date();
      const runEntry = {
        task: taskKey,
        label: task.label,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        result: result.result.substring(0, 500),
        toolCount: result.numTurns,
      };

      this.cronRunHistory.unshift(runEntry);
      if (this.cronRunHistory.length > 20) this.cronRunHistory = this.cronRunHistory.slice(0, 20);

      this.logger.log(`Cron task completed: ${task.label} (${result.numTurns} turns, ${Math.round((completedAt.getTime() - startedAt.getTime()) / 1000)}s)`);

      // Telegram notification
      this.sendCronTelegramNotification(task.label, result.result, []).catch(e => {
        this.logger.warn('Cron Telegram notification failed: ' + e.message);
      });

      return { result: result.result, toolCount: result.numTurns };
    } catch (e: any) {
      this.logger.error(`Cron task ${task.label} error: ${e.message}`);
      const runEntry = {
        task: taskKey,
        label: task.label,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        result: `ERROR: ${e.message}`,
        toolCount: 0,
      };
      this.cronRunHistory.unshift(runEntry);
      if (this.cronRunHistory.length > 20) this.cronRunHistory = this.cronRunHistory.slice(0, 20);
      throw e;
    } finally {
      this.cronRunning = false;
    }
  }

  private async sendCronTelegramNotification(
    taskLabel: string, result: string, toolCalls: { tool: string; input: any; output: string }[],
  ): Promise<void> {
    const esc = (s: string) => s.replace(/[_*`\[\]]/g, '');
    const toolSummary = toolCalls.slice(0, 5).map(tc => {
      const label = tc.tool === 'execute_command' ? tc.input.command :
                    tc.tool === 'read_file' ? tc.input.path :
                    tc.tool === 'write_file' ? tc.input.path :
                    tc.tool === 'list_directory' ? (tc.input.path || '.') :
                    JSON.stringify(tc.input);
      return `  • ${tc.tool}: ${esc((label || '').substring(0, 50))}`;
    }).join('\n');

    const text = [
      `🔄 *Cron: ${esc(taskLabel)}*`,
      '',
      `_Tools:_ ${toolCalls.length} call${toolCalls.length !== 1 ? 's' : ''}`,
      toolSummary,
      '',
      `_Result:_ ${esc((result || '').substring(0, 300))}`,
    ].join('\n');

    await this.telegramService.sendProactiveMessage(text, 'Markdown');
  }

  // ---- Claw Quality Audit: API Endpoint ----

  @Get('audit/packet')
  @ApiTags('Audit')
  @ApiOperation({ summary: 'Get audit packet for Claw quality auditor' })
  async getAuditPacket(@Query('hours') hoursParam?: string) {
    const hours = Math.min(Math.max(parseInt(hoursParam || '12', 10) || 12, 1), 72);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [decisions, bookings, contentions, validationFailures] = await Promise.all([
      // Recent AI decisions with rental context
      this.prisma.ai_decision.findMany({
        where: { created_at: { gte: since }, decision_type: { in: ['message', 'analyze', 'escalate'] } },
        orderBy: { created_at: 'desc' },
        take: 100,
        include: { rental: { select: { id: true, title: true, status: true, start_date: true, end_date: true, account: true, order_step: true, renter_info: true } } },
      }),
      // Active + recent bookings
      this.prisma.booking.findMany({
        where: { status: 'confirmed', end_date: { gte: sevenDaysAgo } },
        orderBy: { start_date: 'desc' },
        select: { id: true, item_name: true, quantity: true, start_date: true, end_date: true, return_date: true, renter_name: true, status: true, account: true, rental_id: true },
      }),
      // Active contentions
      this.prisma.inventory_contention.findMany({
        where: { status: 'active' },
        orderBy: { created_at: 'desc' },
      }),
      // Recent validation failures
      this.prisma.validation_log.findMany({
        where: { created_at: { gte: since } },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
    ]);

    // Truncation helper for compact output (keeps packet under 40KB for LLM context)
    const trunc = (s: string | null, max: number) => s ? s.substring(0, max) : '';

    return {
      generated_at: new Date().toISOString(),
      window_hours: hours,
      decisions: decisions.map(d => ({
        id: d.id.substring(0, 8),
        type: d.decision_type,
        input: trunc(d.input_summary, 200),
        out: trunc(d.output_summary, 400),
        action: trunc(d.action_taken, 150),
        confidence: d.confidence,
        sent: d.was_sent,
        rental: d.rental ? {
          title: trunc(d.rental.title, 80),
          status: d.rental.status,
          start: d.rental.start_date,
          end: d.rental.end_date,
          account: d.rental.account,
          renter: d.rental.renter_info,
        } : null,
      })),
      inventory: MASTER_INVENTORY,
      bookings: bookings.map(b => ({
        item: b.item_name,
        qty: b.quantity,
        start: b.start_date,
        end: b.end_date,
        renter: b.renter_name,
        account: b.account,
      })),
      pricing: PRICING_CATALOG.map(p => ({
        item: p.item_name,
        min: p.daily_price_min,
        max: p.daily_price_max,
      })),
      contentions: contentions.map(c => ({
        item: c.item_name,
        start: c.date_start,
        end: c.date_end,
        status: c.status,
        favored: c.favored_rental_id,
      })),
      validation_failure_count: validationFailures.length,
    };
  }

  // ---- Cron Claude: API Endpoints ----

  @Get('cron-claude/config')
  @ApiTags('Cron Claude')
  @ApiOperation({ summary: 'Get cron Claude configuration' })
  async getCronConfig() {
    const enabled = await this.configManager.getBool('cron_claude.enabled');
    const frequencyMinutes = (await this.configManager.getInt('cron_claude.frequency_minutes')) ?? 240;
    const tasksStr = (await this.configManager.get('cron_claude.tasks')) || 'message_audit';
    const quietStart = (await this.configManager.getInt('cron_claude.quiet_hours_start')) ?? 2;
    const quietEnd = (await this.configManager.getInt('cron_claude.quiet_hours_end')) ?? 7;

    return {
      enabled,
      frequencyMinutes,
      tasks: tasksStr.split(',').map(t => t.trim()).filter(Boolean),
      quietStart,
      quietEnd,
      availableTasks: Object.entries(this.CRON_TASKS).map(([key, t]) => ({
        key,
        label: t.label,
        description: t.description,
      })),
    };
  }

  @Post('cron-claude/config')
  @ApiTags('Cron Claude')
  @ApiOperation({ summary: 'Update cron Claude configuration' })
  async setCronConfig(@Body() body: { enabled?: boolean; frequencyMinutes?: number; tasks?: string[]; quietStart?: number; quietEnd?: number }) {
    if (body.enabled !== undefined) await this.configManager.set('cron_claude.enabled', String(body.enabled));
    if (body.frequencyMinutes) await this.configManager.set('cron_claude.frequency_minutes', String(body.frequencyMinutes));
    if (body.tasks) await this.configManager.set('cron_claude.tasks', body.tasks.join(','));
    if (body.quietStart !== undefined) await this.configManager.set('cron_claude.quiet_hours_start', String(body.quietStart));
    if (body.quietEnd !== undefined) await this.configManager.set('cron_claude.quiet_hours_end', String(body.quietEnd));
    return { ok: true };
  }

  @Get('cron-claude/runs')
  @ApiTags('Cron Claude')
  @ApiOperation({ summary: 'Get cron Claude run history' })
  getCronRuns() {
    return this.cronRunHistory;
  }

  @Post('cron-claude/trigger')
  @ApiTags('Cron Claude')
  @ApiOperation({ summary: 'Manually trigger a cron task' })
  async triggerCronTask(@Body() body: { task: string }) {
    const taskKey = body.task;
    if (!this.CRON_TASKS[taskKey]) return { error: 'Unknown task: ' + taskKey };
    if (this.cronRunning) return { error: 'A cron task is already running' };

    // Run in background, return immediately
    this.runCronTask(taskKey).catch(e => {
      this.logger.error(`Manual cron trigger failed: ${e.message}`);
    });

    return { ok: true, message: `Task "${this.CRON_TASKS[taskKey].label}" started. Check runs endpoint for results.` };
  }

  // ---- Notification Config: API Endpoints ----

  @Get('notify-config/new-booking/telegram')
  @ApiTags('Notification Config')
  @ApiOperation({ summary: 'Get new booking confirmed Telegram notification configuration' })
  async getNewBookingTelegramNotifyConfig() {
    const enabled = await this.configManager.getBool('notify_new_booking.telegram.enabled');
    return { enabled };
  }

  @Post('notify-config/new-booking/telegram')
  @ApiTags('Notification Config')
  @ApiOperation({ summary: 'Update new booking confirmed Telegram notification configuration' })
  async setNewBookingTelegramNotifyConfig(@Body() body: { enabled?: boolean }) {
    if (body.enabled !== undefined) await this.configManager.set('notify_new_booking.telegram.enabled', String(body.enabled));
    return { ok: true };
  }

  @Get('notify-config/new-booking/activity')
  @ApiTags('Notification Config')
  @ApiOperation({ summary: 'Get new booking confirmed activity-feed notification configuration' })
  async getNewBookingActivityNotifyConfig() {
    const enabled = await this.configManager.getBool('notify_new_booking.activity.enabled');
    return { enabled };
  }

  @Post('notify-config/new-booking/activity')
  @ApiTags('Notification Config')
  @ApiOperation({ summary: 'Update new booking confirmed activity-feed notification configuration' })
  async setNewBookingActivityNotifyConfig(@Body() body: { enabled?: boolean }) {
    if (body.enabled !== undefined) await this.configManager.set('notify_new_booking.activity.enabled', String(body.enabled));
    return { ok: true };
  }

  @Get('listing-images/*')
  async serveListingImage(@Req() req: any, @Res() res: any) {
    const subPath = req.params[0];
    const filePath = require('path').join(process.cwd(), 'listing-creator-images', subPath);
    try {
      if (require('fs').existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    } catch {}
    return res.status(404).json({ error: 'Image not found' });
  }

  @Get('dashboard')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html')
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  getDashboard(@Res() res: Response) {
    const htmlPath = path.join(__dirname, '..', 'public', 'dashboard.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    res.send(html);
  }

  @Get('dashboard/mobile')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html')
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  getMobileDashboard(@Res() res: Response) {
    const htmlPath = path.join(__dirname, '..', 'public', 'dashboard-mobile.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    res.send(html);
  }


  @Get("resolve/test")
  async resolveTest(@Query("listing_id") listingId: string, @Query("title") title?: string) {
    if (!listingId) return { error: "listing_id required" };
    const rental = await this.prisma.rental.findFirst({
      where: { listing_id: listingId },
      select: { title: true, listing_id: true },
    });
    const resolveTitle = title || rental?.title || "Unknown";
    const items = await this.itemResolverService.resolveItems(listingId, resolveTitle);
    return { listingId, title: resolveTitle, items };
  }

  @Post("resolve/backfill")
  async resolveBackfill() {
    return this.itemResolverService.backfillAll();
  }

  @Get('bot/status')
  @ApiExcludeEndpoint()
  getBotStatus() {
    return {
      aiEnabled: process.env.AI_ENABLED !== 'false',
    };
  }

  @Post('bot/toggle-ai')
  @ApiExcludeEndpoint()
  toggleAi(@Body() body: { enabled: boolean }) {
    process.env.AI_ENABLED = body.enabled ? 'true' : 'false';
    return {
      aiEnabled: process.env.AI_ENABLED !== 'false',
    };
  }

}
