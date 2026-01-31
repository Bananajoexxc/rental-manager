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
import { getInventoryItemNames, findBestMatch } from '../utils/item-matcher';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: any;
  private ownerChatId: string;
  private simulationMode: { active: boolean; account: 'dbcinema' | 'leo' | null } = {
    active: false,
    account: null,
  };

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
  ) {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
    }
    this.bot = new TelegramBot(token);
    this.ownerChatId = this.configService.get<string>('OWNER_CHAT_ID') || '6634478551';
  }

  private isOwner(chatId: number | string): boolean {
    return String(chatId) === this.ownerChatId;
  }

  async onModuleInit() {
    this.bot.on('polling_error', (err: any) => {
      this.logger.error('Telegram polling error: ' + err.message);
    });

    this.bot.on('message', (msg: any) => {
      this.logger.log(`Incoming message: "${msg.text}" from chat ${msg.chat.id}`);
    });

    this.registerCommands();
    this.registerConversationHandler();

    this.bot.startPolling();
    this.logger.log('Telegram bot is polling for updates');
  }

  async onModuleDestroy() {
    await this.bot.stopPolling();
  }

  // --- Proactive messaging for autonomous pipeline ---

  async sendProactiveMessage(text: string, parseMode = 'Markdown') {
    try {
      await this.bot.sendMessage(this.ownerChatId, text, { parse_mode: parseMode });
    } catch (error) {
      this.logger.error(`Failed to send proactive message: ${error.message}`);
    }
  }

  async sendRentalNotification(rental: any, aiAnalysis: string, actionTaken: string) {
    // Account tag
    const accountLabel = this.getAccountLabel(rental.account);
    const accountTag = accountLabel ? `[${accountLabel}] ` : '';

    // Build structured notification sections
    const sections: string[] = [];

    // Header
    sections.push(`📦 ${accountTag}*New Rental Activity*`);

    // Rental summary with dates
    const startStr = rental.start_date ? new Date(rental.start_date).toLocaleDateString() : '?';
    const endStr = rental.end_date ? new Date(rental.end_date).toLocaleDateString() : '?';
    const days = rental.start_date && rental.end_date
      ? Math.ceil((new Date(rental.end_date).getTime() - new Date(rental.start_date).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    sections.push(
      `📋 *Summary*\n` +
      `├ 📦 ${rental.title}\n` +
      `├ Status: ${rental.status}\n` +
      `├ 👤 ${rental.renter_info || rental.renterInfo || 'N/A'}\n` +
      (rental.start_date ? `├ 📅 ${startStr} - ${endStr} (${days} days)\n` : '') +
      `└ ${rental.listing_url || rental.listingUrl || 'N/A'}`,
    );

    // Revenue & pricing info
    const rentalPrice = rental.rental_price || rental.rentalPrice;
    const pricePerDay = rental.price_per_day || rental.pricePerDay;
    if (rentalPrice) {
      const curr = rental.currency === 'SEK' ? 'kr' : '£';
      let revenueText = `💰 *Revenue*\n├ Total: ${curr}${rentalPrice}`;
      if (pricePerDay) revenueText += ` (${curr}${pricePerDay}/day)`;
      const estFee = Math.round(rentalPrice * 0.15 * 100) / 100;
      const estProfit = Math.round((rentalPrice - estFee) * 100) / 100;
      revenueText += `\n├ Platform fee: -${curr}${estFee}`;
      revenueText += `\n└ Net profit: ${curr}${estProfit}`;
      sections.push(revenueText);
    }

    // Timing info (pickup/return from bookings)
    try {
      const bookings = await this.prisma.booking.findMany({
        where: { rental_id: rental.id, status: 'confirmed' },
        select: { item_name: true, pickup_time: true, return_time: true },
      });
      const withTimes = bookings.filter(b => b.pickup_time || b.return_time);
      if (withTimes.length > 0) {
        const timeLines = withTimes.map(b => {
          const times = [b.pickup_time ? `pickup ${b.pickup_time}` : null, b.return_time ? `return ${b.return_time}` : null].filter(Boolean).join(', ');
          return `├ ${b.item_name}: ${times}`;
        });
        sections.push(`⏰ *Timing*\n${timeLines.join('\n')}`);
      }
    } catch { /* timing lookup optional */ }

    // Availability check for items in this rental
    try {
      if (rental.start_date && rental.end_date) {
        const bookings = await this.prisma.booking.findMany({
          where: { rental_id: rental.id, status: 'confirmed' },
          select: { item_name: true },
        });
        if (bookings.length > 0) {
          const availLines: string[] = [];
          for (const b of bookings) {
            const avail = await this.calendarService.checkAvailability(
              b.item_name,
              new Date(rental.start_date),
              new Date(rental.end_date),
            );
            if (avail.matchedItem) {
              const status = avail.available ? '✅' : '⚠️ FULL';
              availLines.push(`├ ${status} ${avail.matchedItem}: ${avail.booked}/${avail.maxQuantity} booked`);
            }
          }
          if (availLines.length > 0) {
            sections.push(`📊 *Availability*\n${availLines.join('\n')}`);
          }
        }
      }
    } catch { /* availability lookup optional */ }

    // AI insights
    if (aiAnalysis) {
      sections.push(`🤖 *AI Insights*\n${aiAnalysis}`);
    }

    // Recommendations / Action
    if (actionTaken) {
      sections.push(`💡 *Recommendation*\n${actionTaken}`);
    }

    // Warnings (blacklist, scheduling conflicts)
    const warnings: string[] = [];
    if (actionTaken && actionTaken.toLowerCase().includes('blacklist')) {
      warnings.push('🚫 Renter may be blacklisted - review required');
    }
    if (actionTaken && actionTaken.toLowerCase().includes('blocked')) {
      warnings.push('🔒 Message was blocked by read-only mode');
    }
    if (warnings.length > 0) {
      sections.push(`⚠️ *Warnings*\n${warnings.map(w => `├ ${w}`).join('\n')}`);
    }

    await this.sendProactiveMessage(sections.join('\n\n'));
  }

  private getAccountLabel(account?: string): string {
    if (!account) return '';
    if (account === 'dbcinema') return 'DB Cinema';
    if (account === 'leo') return 'Leo Adams';
    return account;
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
      { command: 'revenue', description: 'Revenue summary: /revenue [week|month|all]' },
      { command: 'earnings', description: 'Monthly earnings (alias for /revenue month)' },
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
  }

  // --- Conversation handler (non-command messages -> Claude) ---

  private registerConversationHandler() {
    this.bot.on('message', async (msg: any) => {
      if (!msg.text || msg.text.startsWith('/')) return;
      if (!this.isOwner(msg.chat.id)) {
        await this.bot.sendMessage(msg.chat.id, 'Unauthorized. This bot is private.');
        return;
      }

      // Simulation mode: treat owner messages as renter messages
      if (this.simulationMode.active) {
        await this.handleSimulatedConversation(msg);
        return;
      }

      await this.handleConversation(msg);
    });
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
        'You are chatting with Daniel, the owner of DB Cinema Rentals and Leo Adams rental accounts on Hygglo/Fat Llama. ',
        'Help him manage the business, answer questions, and provide insights. ',
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
        additionalParts.push(`\n\nWEEKLY REVENUE: £${revenueSummary.totalRevenue} revenue, £${revenueSummary.totalProfit} profit from ${revenueSummary.bookings} bookings`);
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

      const response = await this.aiService.processComplex(userText, {
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
      await this.bot.sendMessage(msg.chat.id, 'Sorry, I encountered an error processing your message. Please try again.');
    }
  }

  private async handleSimulatedConversation(msg: any) {
    const userText = msg.text;
    const account = this.simulationMode.account;

    try {
      const rules = await this.rulesService.getFormattedRules();

      // Extract meaningful keywords (individual words, not full text)
      const words = userText
        .split(/[\s,.\-!?;:()]+/)
        .filter((w: string) => w.length > 2)
        .slice(0, 10);

      // Detect pricing and delivery intent
      const pricingTerms = /\b(price|pricing|cost|how much|rate|rates|quote|charge|fee|fees|per day|daily|weekly|budget|afford|expensive|cheap|discount|deal)\b/i;
      const deliveryTerms = /\b(deliver|delivery|courier|ship|shipping|post|postcode|send it|drop off|dropoff|bring it|transport|how far|distance|collect from|too far|can you bring|come to me)\b/i;
      const hasPricingIntent = pricingTerms.test(userText);
      const hasDeliveryIntent = deliveryTerms.test(userText);

      // Fetch memories — include pricing/delivery data when relevant
      let memories: string;
      if (hasPricingIntent || hasDeliveryIntent) {
        const deliveryKeywords = hasDeliveryIntent ? ['Delivery Pricing Zones', 'Delivery Courier Framework', 'Delivery Rules'] : [];
        const [generalMem, pricingMem, deliveryMem] = await Promise.all([
          this.memoryService.getRelevantMemories(words),
          hasPricingIntent ? this.memoryService.getPricingMemories() : Promise.resolve(''),
          hasDeliveryIntent ? this.memoryService.getMinimalMemories(deliveryKeywords, 5) : Promise.resolve(''),
        ]);
        memories = [generalMem, pricingMem, deliveryMem].filter(Boolean).join('\n');
      } else {
        memories = await this.memoryService.getRelevantMemories(words);
      }

      const persona = account === 'dbcinema'
        ? 'You are Daniel from DB Cinema Rentals. Professional, concise, human tone.'
        : 'You are Leo from Leo Adams. Human, kind, slightly chill tone.';

      const pricingInstruction = hasPricingIntent
        ? `4) The renter is asking about pricing. Use the listing price data in your memories to give an estimate. Say "approximately £X/day based on our current listings". Mention Hygglo adds a service fee at checkout. Mention multi-day discounts for longer rentals. If a bundle covers their needs, recommend it. CRITICAL: Quote the INDIVIDUAL item price for single items — never confuse bundle prices with individual prices (e.g. a single Sony GM lens is £14-22/day, NOT the bundle price). NEVER reveal margins or commission rates. Do NOT tell them to send a rental request just to get a quote. `
        : '';

      const deliveryInstruction = hasDeliveryIntent
        ? `5) The renter is asking about delivery. Give them a delivery price estimate DIRECTLY from the delivery pricing zones in your memories. Ask for their postcode if not provided, then quote the zone-based price range. Do NOT require a booking request before giving a delivery quote. Do NOT send the full delivery booking form yet — just give the price estimate first. Only ask for full details after they agree. `
        : '';

      const response = await this.aiService.processComplex(userText, {
        rules,
        memories,
        additionalContext:
          `SIMULATION MODE: A renter is messaging on the ${account === 'dbcinema' ? 'DB Cinema Rentals' : 'Leo Adams'} account. ` +
          `${persona} ` +
          `Reply as you would to a real renter. Follow all business rules. ` +
          `IMPORTANT REMINDERS: ` +
          `1) When a renter enquires about items, pricing, or delivery, just give them the information directly. Do NOT tell them to send a rental request just to get information or a quote — a request is only needed when they want to actually book. ` +
          `2) Always tell renters right away that all items are based in Central London (Trafalgar Square area) and collection is from there. ` +
          `3) If the renter mentions their location and it is far from central London (20km+), proactively inform them they are eligible for a 10% travel distance discount. If that is the only discount they qualify for, still mention it. ` +
          pricingInstruction +
          deliveryInstruction,
      });

      // Don't store simulation conversations to memory
      await this.bot.sendMessage(
        msg.chat.id,
        `[SIM:${account}] ${response.content}`,
      );
    } catch (error) {
      this.logger.error(`Simulation error: ${error.message}`);
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

    if (detectedItems.length === 0) {
      // No specific items detected — provide general upcoming bookings snapshot
      const upcomingBookings = await this.calendarService.getAllUpcomingBookings(7);
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

    // Also add upcoming bookings for context
    const upcomingBookings = await this.calendarService.getAllUpcomingBookings(7);

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

    const isAuth = this.isOwner(chatId) ? ' (Owner verified)' : '';
    await this.bot.sendMessage(
      chatId,
      `*Bananajoe Rental Manager*${isAuth}\n\nI autonomously manage your Hygglo rentals with AI.\n\nUse /help to see available commands, or just chat with me.`,
      { parse_mode: 'Markdown' },
    );
  }

  private async handleHelp(msg: any) {
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
      '*Revenue & Demand*\n' +
      '/revenue [week|month|all] - Revenue summary\n' +
      '/earnings - Monthly earnings\n' +
      '/demand - Demand report\n\n' +
      '*Inventory*\n' +
      '/inventory - Full inventory status with quantities & availability\n\n' +
      '*Delivery & Market*\n' +
      '/quote <postcode> <items> - Delivery quote\n' +
      '/market - Market insight report\n\n' +
      '*Simulation*\n' +
      '/simulate <dbcinema|leo> - Enter sim mode\n' +
      '/endsim - Exit sim mode\n\n' +
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
      // Use AI to extract a good subject and classify the memory
      const response = await this.aiService.processRoutine(
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
        `Decision details:\n${todayDecisions.map((d) => `- ${d.decision_type}: ${d.output_summary.substring(0, 100)}`).join('\n') || 'None'}\n\n` +
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
      await this.bot.sendMessage(msg.chat.id, `💰 *Revenue Report*\n\n${report}`, { parse_mode: 'Markdown' });
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
      await this.bot.sendMessage(msg.chat.id, `💰 *Monthly Earnings*\n\n${report}`, { parse_mode: 'Markdown' });
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

      const todayRevenue = todayBookings.reduce((sum, b) => sum + (b.revenue || 0), 0);
      const todayProfit = todayBookings.reduce((sum, b) => sum + (b.net_profit || 0), 0);

      // Build booking lines
      const bookingLines: string[] = [];
      for (const b of todayBookings) {
        const timeParts = [
          b.pickup_time ? `pickup ${b.pickup_time}` : null,
          b.return_time ? `return ${b.return_time}` : null,
        ].filter(Boolean).join(', ');
        const timeStr = timeParts ? ` | ${timeParts}` : '';
        bookingLines.push(`  ${b.item_name} — ${b.renter_name}: £${b.revenue || 0}${timeStr}`);
      }

      let response = `📅 *Today's Schedule*\n\n${schedule}`;

      if (bookingLines.length > 0) {
        response += `\n\n📦 *Starting Today:*\n${bookingLines.join('\n')}`;
      }

      response += `\n\n💰 *Revenue:*`;
      response += `\n├ Today: £${Math.round(todayRevenue * 100) / 100} revenue, £${Math.round(todayProfit * 100) / 100} profit (${todayBookings.length} bookings)`;
      response += `\n├ Week: £${weekRevenue.totalRevenue} revenue, £${weekRevenue.totalProfit} profit (${weekRevenue.bookings} bookings)`;
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
    await this.bot.sendMessage(msg.chat.id, 'Simulation mode ended. Back to normal.');
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
            await this.bot.sendMessage(msg.chat.id, chunk);
            chunk = '';
          }
          chunk += line + '\n';
        }
        if (chunk.trim()) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } else {
        await this.bot.sendMessage(msg.chat.id, `📦 *Inventory*\n\n${inventoryStatus}`, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
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
}
