import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AppService } from './app.service';

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

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
  getHealth() {
    return this.appService.getHealthStatus();
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
    const limitNum = Math.min(parseInt(limit || '10', 10), 100);
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
    const limitNum = Math.min(parseInt(limit || '20', 10), 100);
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
    const limitNum = Math.min(parseInt(limit || '50', 10), 100);
    return await this.appService.getItemCatalog(limitNum);
  }
}
