import { Controller, Get, Post, Body, Query, Res, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AppService } from './app.service';
import { AiService } from './ai/ai.service';
import { RulesService } from './rules/rules.service';
import { MemoryService } from './memory/memory.service';
import { CalendarService } from './calendar/calendar.service';
import { BlacklistService } from './blacklist/blacklist.service';
import { PrismaService } from './prisma/prisma.service';

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly aiService: AiService,
    private readonly rulesService: RulesService,
    private readonly memoryService: MemoryService,
    private readonly calendarService: CalendarService,
    private readonly blacklistService: BlacklistService,
    private readonly prisma: PrismaService,
  ) {}

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
  @ApiResponse({
    status: 200,
    description: 'Health status retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'healthy' },
        uptime: { type: 'number', example: 3600 },
        timestamp: { type: 'string', example: '2026-01-29T12:00:00.000Z' },
        scanner: {
          type: 'object',
          properties: {
            isScanning: { type: 'boolean', example: false },
            currentScanInterval: { type: 'number', example: 60000 },
            lastActivityTime: { type: 'string', example: '2026-01-29T11:55:00.000Z' },
            authenticated: { type: 'boolean', example: true },
          },
        },
      },
    },
  })
  async getHealth() {
    return await this.appService.getHealthStatus();
  }

  @Get('scanner/status')
  @ApiTags('Scanner')
  @ApiOperation({
    summary: 'Scanner status',
    description:
      'Returns detailed status information about the rental scanner including scan intervals and activity tracking',
  })
  @ApiResponse({
    status: 200,
    description: 'Scanner status retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        isScanning: { type: 'boolean', example: false },
        currentScanInterval: { type: 'number', example: 60000 },
        lastActivityTime: { type: 'string', example: '2026-01-29T11:55:00.000Z' },
        authenticated: { type: 'boolean', example: true },
      },
    },
  })
  getScannerStatus() {
    return this.appService.getScannerStatus();
  }

  @Get('rentals/stats')
  @ApiTags('Rentals')
  @ApiOperation({
    summary: 'Rental statistics',
    description: 'Returns statistics about tracked rentals including counts by status',
  })
  @ApiResponse({
    status: 200,
    description: 'Rental statistics retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        total: { type: 'number', example: 42 },
        ongoing: { type: 'number', example: 15 },
        upcoming: { type: 'number', example: 27 },
      },
    },
  })
  async getRentalStats() {
    return await this.appService.getRentalStats();
  }

  @Get('rentals/recent')
  @ApiTags('Rentals')
  @ApiOperation({
    summary: 'Recent rentals',
    description: 'Returns the most recently tracked rental listings',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of rentals to return (default: 10, max: 100)',
    example: 10,
  })
  @ApiResponse({
    status: 200,
    description: 'Recent rentals retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '123e4567-e89b-12d3-a456-426614174000' },
          listing_id: { type: 'string', example: 'hygglo_12345' },
          title: { type: 'string', example: 'Vintage Camera Equipment' },
          status: { type: 'string', example: 'ongoing' },
          created_at: { type: 'string', example: '2026-01-29T12:00:00.000Z' },
          updated_at: { type: 'string', example: '2026-01-29T12:00:00.000Z' },
        },
      },
    },
  })
  async getRecentRentals(@Query('limit') limit?: string) {
    const parsed = parseInt(limit || '10', 10);
    const limitNum = Math.min(Number.isNaN(parsed) ? 10 : Math.max(1, parsed), 100);
    return await this.appService.getRecentRentals(limitNum);
  }

  @Get('items/recent')
  @ApiTags('Items')
  @ApiOperation({
    summary: 'Recently extracted items',
    description: 'Returns the most recently extracted items from rental photos',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items to return (default: 20, max: 100)',
    example: 20,
  })
  @ApiResponse({
    status: 200,
    description: 'Recent items retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '123e4567-e89b-12d3-a456-426614174000' },
          item_name: { type: 'string', example: 'camera' },
          source: { type: 'string', example: 'photo' },
          confidence_score: { type: 'number', example: 0.95 },
          created_at: { type: 'string', example: '2026-01-29T12:00:00.000Z' },
          rental: {
            type: 'object',
            properties: {
              title: { type: 'string', example: 'Vintage Camera Equipment' },
              listing_id: { type: 'string', example: 'hygglo_12345' },
            },
          },
        },
      },
    },
  })
  async getRecentItems(@Query('limit') limit?: string) {
    const parsed = parseInt(limit || '20', 10);
    const limitNum = Math.min(Number.isNaN(parsed) ? 20 : Math.max(1, parsed), 100);
    return await this.appService.getRecentItems(limitNum);
  }

  @Get('items/catalog')
  @ApiTags('Items')
  @ApiOperation({
    summary: 'Item catalog',
    description: 'Returns the catalog of items extracted from listing descriptions',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of catalog items to return (default: 50, max: 100)',
    example: 50,
  })
  @ApiResponse({
    status: 200,
    description: 'Item catalog retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '123e4567-e89b-12d3-a456-426614174000' },
          listing_id: { type: 'string', example: 'hygglo_12345' },
          item_name: { type: 'string', example: 'tripod' },
          description: { type: 'string', example: 'Professional camera tripod...' },
          first_seen_at: { type: 'string', example: '2026-01-29T12:00:00.000Z' },
        },
      },
    },
  })
  async getItemCatalog(@Query('limit') limit?: string) {
    const parsed = parseInt(limit || '50', 10);
    const limitNum = Math.min(Number.isNaN(parsed) ? 50 : Math.max(1, parsed), 100);
    return await this.appService.getItemCatalog(limitNum);
  }

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

  @Get('dashboard')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html')
  getDashboard(@Res() res: Response) {
    const htmlPath = path.join(__dirname, 'public', 'dashboard.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    res.send(html);
  }
}
