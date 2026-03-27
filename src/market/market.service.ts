import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { TelegramService } from '../telegram/telegram.service';
import axios from 'axios';

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  constructor(
    private prisma: PrismaService,
    private aiService: AiService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
  ) {}

  async scrapeTopLondonAccounts(): Promise<number> {
    // DISABLED: Fat Llama rebranded to Hygglo. This scraper targets dead URLs.
    // Competitor intel is handled by competitor-intel.service.ts using the Hygglo API.
    this.logger.warn('MarketService.scrapeTopLondonAccounts() is disabled - Fat Llama no longer exists.');
    return 0;
  }

  private parseListingsFromHtml(html: string): { title?: string; price?: number; reviews?: number; rating?: number; lender?: string; url?: string }[] {
    const listings: any[] = [];

    // Extract JSON-LD or listing data from page
    const priceMatches = html.matchAll(/£(\d+(?:\.\d{2})?)\s*\/\s*day/gi);
    const titleMatches = html.matchAll(/<h[23][^>]*>([^<]+)<\/h[23]>/gi);

    const prices = [...priceMatches].map((m) => parseFloat(m[1]));
    const titles = [...titleMatches].map((m) => m[1].trim());

    for (let i = 0; i < Math.min(prices.length, titles.length, 10); i++) {
      listings.push({
        title: titles[i],
        price: prices[i],
        reviews: null,
        rating: null,
        lender: 'fat_llama_lender',
      });
    }

    return listings;
  }

  async analyzeMarketData(): Promise<string> {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const snapshots = await this.prisma.market_snapshot.findMany({
      where: { scraped_at: { gte: weekAgo } },
      orderBy: { scraped_at: 'desc' },
      take: 100,
    });

    if (snapshots.length === 0) {
      return 'No market data available. Run /market to trigger a scrape.';
    }

    // Aggregate by item
    const byItem: Record<string, { prices: number[]; count: number }> = {};
    for (const s of snapshots) {
      if (!byItem[s.item_name]) byItem[s.item_name] = { prices: [], count: 0 };
      if (s.price_daily) byItem[s.item_name].prices.push(s.price_daily);
      byItem[s.item_name].count++;
    }

    const summary = Object.entries(byItem)
      .map(([item, data]) => {
        const avg = data.prices.length > 0
          ? Math.round(data.prices.reduce((a, b) => a + b, 0) / data.prices.length)
          : 0;
        return `${item}: avg £${avg}/day (${data.count} listings)`;
      })
      .join('\n');

    return summary;
  }

  async generateWeeklyReport(): Promise<string> {
    const marketSummary = await this.analyzeMarketData();

    const prompt =
      `Analyze this competitive market data from Fat Llama London and provide insights:\n\n` +
      `${marketSummary}\n\n` +
      `Provide:\n` +
      `1. What items rent well on the platform\n` +
      `2. Pricing gaps or opportunities\n` +
      `3. Inventory recommendations\n` +
      `4. Any competitive concerns\n` +
      `Keep it concise and actionable.`;

    const response = await this.aiService.processLightweight(prompt, {});

    await this.prisma.market_report.create({
      data: {
        report_type: 'weekly',
        content: response.content,
        insights: { raw_summary: marketSummary },
      },
    });

    return response.content;
  }

  // Sunday 6pm - before the weekly summary at 8pm
  // @Cron('0 18 * * 0') // DISABLED: Fat Llama scraper is dead
  async weeklyMarketScrape() {
    this.logger.log('Running weekly market scrape...');

    try {
      await this.scrapeTopLondonAccounts();
      const report = await this.generateWeeklyReport();

      await this.telegramService.sendProactiveMessage(
        `*Weekly Market Report*\n\n${report}`,
      );
    } catch (error) {
      this.logger.error(`Weekly market scrape error: ${error.message}`);
    }
  }

  async getOnDemandReport(): Promise<string> {
    // Check for recent report (last 24h)
    const dayAgo = new Date();
    dayAgo.setDate(dayAgo.getDate() - 1);

    const recent = await this.prisma.market_report.findFirst({
      where: { created_at: { gte: dayAgo } },
      orderBy: { created_at: 'desc' },
    });

    if (recent) return recent.content;

    // Generate fresh
    // Fat Llama scraper is dead - return a message instead of scraping
    return 'Market scraping is disabled (Fat Llama rebranded to Hygglo). Use competitor-intel for market data.';
  }
}
