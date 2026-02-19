import { Controller, Get, Post, Delete, Body, Query, Param, Res, Header, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
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
import { HyggloService } from './hygglo/hygglo.service';
import { ACCESSORY_ITEMS, isAccessoryItem } from './utils/item-matcher';
import { PRICING_CATALOG } from './data/pricing-catalog';
import { LostRevenueService } from './lost-revenue/lost-revenue.service';
import { AutonomousService } from './autonomous/autonomous.service';
import { CompetitorIntelService } from './competitor-intel/competitor-intel.service';
import { MarketReleasesService } from './market/market-releases.service';
import { ConversationStageService } from './conversation-tree/conversation-stage.service';
import { ItemMatcherAiService } from './item-matcher-ai/item-matcher-ai.service';
import { SellRecommenderService } from './sell-recommender/sell-recommender.service';

@ApiTags('Health')
@Controller()
export class AppController {
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
  ) {}

  // In-memory session store for renter chat testing
  private renterChatSessions = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();

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
  async getHealth() {
    return await this.appService.getHealthStatus();
  }

  @Get('scanner/status')
  @ApiTags('Scanner')
  @ApiOperation({ summary: 'Scanner status' })
  @ApiResponse({ status: 200, description: 'Scanner status retrieved successfully' })
  getScannerStatus() {
    return this.appService.getScannerStatus();
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
  async getBookingStats(@Query('account') account?: string) {
    return await this.appService.getBookingStats(account || undefined);
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
    @Query('start') start: string,
    @Query('end') end: string,
    @Query('account') account?: string,
  ) {
    if (!start || !end) return [];
    return await this.appService.getCalendarBookings(start, end, account || undefined);
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

  @Post('api/chat')
  @ApiTags('Chat')
  @ApiOperation({
    summary: 'Dashboard chat',
    description: 'Send a message through the AI pipeline with full context (rules, memories, rental context, calendar, blacklist)',
  })
  @ApiResponse({ status: 200, description: 'AI response' })
  async chatMessage(@Body() body: { message: string }) {
    const userMessage = body.message;
    if (!userMessage || typeof userMessage !== 'string') {
      return { error: 'Message is required' };
    }

    try {
      const chatId = 'dashboard';

      // Store user message
      await this.memoryService.storeConversation(chatId, 'user', userMessage);

      // Extract meaningful keywords
      const dashKeywords = userMessage
        .split(/[\s,.\-!?;:()]+/)
        .filter((w: string) => w.length > 2)
        .slice(0, 10);

      // Detect pricing intent
      const pricingTerms = /\b(price|pricing|cost|how much|rate|rates|quote|charge|fee|fees|per day|daily|weekly|budget|listing)\b/i;
      const hasPricingIntent = pricingTerms.test(userMessage);

      // Gather full context (same pipeline as Telegram)
      const [rules, history, generalMemories, blacklist, schedule] = await Promise.all([
        this.rulesService.getFormattedRules(),
        this.memoryService.getConversationHistory(chatId, 10),
        this.memoryService.getRelevantMemories(dashKeywords),
        this.blacklistService.getFormattedBlacklist(),
        this.calendarService.getFormattedSchedule(new Date()),
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
        select: { title: true, status: true, renter_info: true, account: true, start_date: true, end_date: true },
      });
      const rentalContext = recentRentals.length > 0
        ? recentRentals.map((r) => `- ${r.title} (${r.status}, ${r.account || 'unknown'}) renter: ${r.renter_info || 'N/A'}`).join('\n')
        : 'No recent rentals.';

      const additionalParts: string[] = [
        'You are chatting with Daniel through the web dashboard. ',
        'Help him manage the business, answer questions, and provide insights. ',
        'Store relevant information using <memory> tags when appropriate.',
      ];

      if (schedule) {
        additionalParts.push(`\n\nTODAY'S SCHEDULE:\n${schedule}`);
      }
      if (blacklist) {
        additionalParts.push(`\n\n${blacklist}`);
      }

      // Always include upcoming bookings for availability awareness
      try {
        const upcomingBookings = await this.calendarService.getAllUpcomingBookings(14);
        if (upcomingBookings) {
          additionalParts.push(`\n\n${upcomingBookings}`);
          additionalParts.push('\nIMPORTANT: When answering availability questions, use the UPCOMING BOOKINGS data above to check if items are already booked. Do not guess — only state availability based on this data and the inventory rules.');
        }
      } catch { /* availability lookup optional */ }

      // Revenue intelligence: lost revenue, ROI scores, item pricing, unmatched demand
      try {
        const revenueIntelligence = await this.lostRevenueService.buildAIContext();
        if (revenueIntelligence) {
          additionalParts.push(`\n\nREVENUE INTELLIGENCE:\n${revenueIntelligence}`);
          additionalParts.push('\nUse this data to recommend inventory purchases and advise on business strategy. Confidence: high=strong demand, medium=decent, low=weak.');
        }
      } catch { /* revenue intelligence optional */ }

      // Actual revenue/earnings data — complete per-item lifetime earnings (completed bookings only)
      try {
        const [revSummary, allItemEarnings] = await Promise.all([
          this.revenueService.getFormattedRevenue('month'),
          this.revenueService.getAllItemEarnings(),
        ]);
        if (revSummary) {
          additionalParts.push(`\n\nCURRENT REVENUE:\n${revSummary}`);
        }
        if (allItemEarnings.currentItems.length > 0) {
          const lines = allItemEarnings.currentItems.map(i =>
            `- ${i.item}: £${i.totalRevenue} (${i.rentalCount} rentals${i.lastRented ? ', last: ' + i.lastRented : ''})`
          );
          additionalParts.push(`\n\nITEM EARNINGS (all time, completed rentals only):\n${lines.join('\n')}`);
        }
        if (allItemEarnings.retiredItems.length > 0) {
          const retiredLines = allItemEarnings.retiredItems.map(i =>
            `- ${i.item}: £${i.totalRevenue} (${i.rentalCount} rentals, ${i.firstRented} to ${i.lastRented})`
          );
          additionalParts.push(`\n\nRETIRED/SOLD ITEMS (no longer in inventory, historical earnings):\n${retiredLines.join('\n')}`);
        }
      } catch { /* revenue data optional */ }

      // Monthly income distribution by account (DB Cinema, Leo, Daniel, Vertus, Damage Claims)
      try {
        const lifetime = await this.revenueService.getLifetimeRevenue();
        if (lifetime.months.length > 0) {
          const lines = lifetime.months
            .filter(m => m.revenue > 0)
            .map(m => {
              const parts = [`${m.month}: £${Math.round(m.revenue)} total`];
              if (m.dbcinemaRevenue) parts.push(`DB Cinema £${Math.round(m.dbcinemaRevenue)}`);
              if (m.leoRevenue) parts.push(`Leo £${Math.round(m.leoRevenue)}`);
              if (m.danielRevenue) parts.push(`Daniel £${Math.round(m.danielRevenue)}`);
              if (m.vertusRevenue) parts.push(`Vertus £${Math.round(m.vertusRevenue)}`);
              if (m.damageRevenue) parts.push(`Damage Claims £${Math.round(m.damageRevenue)}`);
              if (m.aiAttribution) parts.push(`AI Boost £${Math.round(m.aiAttribution)}`);
              return `- ${parts.join(' | ')}`;
            });
          const summary = [
            `Total lifetime revenue: £${Math.round(lifetime.totalRevenue)}`,
            `Avg monthly (mature): £${lifetime.avgMonthly}`,
            lifetime.strongestMonth ? `Best month: ${lifetime.strongestMonth.month} £${Math.round(lifetime.strongestMonth.revenue)}` : '',
            lifetime.weakestMonth ? `Weakest month: ${lifetime.weakestMonth.month} £${Math.round(lifetime.weakestMonth.revenue)}` : '',
          ].filter(Boolean).join(' | ');
          additionalParts.push(`\n\nMONTHLY INCOME DISTRIBUTION BY ACCOUNT:\n${summary}\n\nAccounts: DB Cinema (primary, active), Leo Adams (active since Aug 2025), Daniel (retired), Vertus (retired). Damage Claims = insurance payouts.\n${lines.join('\n')}`);
        }
      } catch { /* lifetime revenue optional */ }

      // Bundle pricing reference (bundles are distinct listings with different prices from individual items)
      try {
        const bundleLines: string[] = [];
        for (const entry of PRICING_CATALOG) {
          if (entry.is_bundle && entry.bundle_items) {
            bundleLines.push(`- ${entry.item_name}: £${entry.daily_price_min}-${entry.daily_price_max}/day (contains: ${entry.bundle_items.join(', ')})`);
          }
        }
        if (bundleLines.length > 0) {
          additionalParts.push(`\n\nBUNDLE PRICING (listed bundle rates, different from individual item prices):\n${bundleLines.join('\n')}`);
        }
      } catch { /* bundle pricing optional */ }

      // Top bundle/set revenue (actual rental performance of item combinations)
      try {
        const topBundles = await this.revenueService.getTopBundles(15);
        if (topBundles.length > 0) {
          const bundleRevLines = topBundles.map((b: any) =>
            `- ${b.bundle_label}: £${b.cumulative_revenue} (${b.cumulative_rentals} rentals, ${b.first_rental?.toISOString().split('T')[0] || '?'} to ${b.last_rental?.toISOString().split('T')[0] || '?'})`
          );
          additionalParts.push(`\n\nTOP BUNDLE/SET REVENUE (actual completed rental performance):\n${bundleRevLines.join('\n')}`);
        }
      } catch { /* bundle revenue optional */ }

      // Competitor intelligence: competitor catalog, pricing, reviews, market gaps
      try {
        const competitorIntelligence = await this.competitorIntelService.buildAIContext();
        if (competitorIntelligence) {
          additionalParts.push(`\n\nCOMPETITOR INTELLIGENCE:\n${competitorIntelligence}`);
          additionalParts.push('\nUse this competitor data for strategic advice only. Compare competitor pricing to our pricing, identify gaps in our inventory, and suggest business moves. This is INTERNAL data — never share competitor details with renters.');
        }
      } catch { /* competitor intelligence optional */ }

      const response = await this.aiService.processComplex(userMessage, {
        rules,
        memories,
        conversationHistory: history,
        rentalContext,
        additionalContext: additionalParts.join(''),
      });

      // Store assistant response
      await this.memoryService.storeConversation(chatId, 'assistant', response.content);

      // Process any memories
      if (response.memories.length > 0) {
        await this.memoryService.processAiMemories(response.memories);
      }

      return { reply: response.content, model: response.model };
    } catch (error) {
      return { error: `Chat error: ${error.message}` };
    }
  }

  @Post('api/renter-chat')
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

  @Post('api/renter-chat/reset')
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
                      parsedUpdate.parsed_items = await this.titleParserService.parseTitleWithAI(rental.title) as any;
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

            // Parse items from title using AI
            let parsedItems: any = null;
            try {
              parsedItems = await this.titleParserService.parseTitleWithAI(rental.title);
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
      select: { id: true, title: true },
    });

    this.logger.log(`Backfill: ${unparsedRentals.length} rentals need item parsing`);

    for (const rental of unparsedRentals) {
      try {
        const parsed = await this.titleParserService.parseTitleWithAI(rental.title);
        if (parsed) {
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

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ['confirmed', 'pending_review'] },
        end_date: { gte: oneWeekAgo }, // Only ongoing or upcoming (ended within last week or future)
        OR: [{ pickup_time: null }, { return_time: null }, { pickup_date: null }, { return_date: null }],
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

          const extracted = await this.autonomousService.extractTimesFromChatHistory(rental);
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

  @Get('dashboard')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html')
  getDashboard(@Res() res: Response) {
    const htmlPath = path.join(__dirname, '..', 'public', 'dashboard.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    res.send(html);
  }

  @Get('dashboard/mobile')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html')
  getMobileDashboard(@Res() res: Response) {
    const htmlPath = path.join(__dirname, '..', 'public', 'dashboard-mobile.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    res.send(html);
  }

}
