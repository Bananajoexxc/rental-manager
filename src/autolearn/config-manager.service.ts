import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CONFIG_DEFAULTS } from './autolearn.types';

@Injectable()
export class ConfigManagerService implements OnModuleInit {
  private readonly logger = new Logger(ConfigManagerService.name);
  private cache = new Map<string, string>();
  private lastRefresh = new Date(0);
  private readonly CACHE_TTL_MS = 60_000; // 1 minute

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaults();
    await this.refreshCache();
  }

  private async seedDefaults() {
    let seeded = 0;
    for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
      const existing = await this.prisma.bot_config.findUnique({ where: { key } });
      if (!existing) {
        await this.prisma.bot_config.create({ data: { key, value } });
        seeded++;
      }
    }
    if (seeded > 0) this.logger.log(`Seeded ${seeded} new config key(s)`);
  }

  private async refreshCache() {
    const rows = await this.prisma.bot_config.findMany();
    this.cache.clear();
    for (const row of rows) {
      this.cache.set(row.key, row.value);
    }
    this.lastRefresh = new Date();
  }

  private async ensureFresh() {
    if (Date.now() - this.lastRefresh.getTime() > this.CACHE_TTL_MS) {
      await this.refreshCache();
    }
  }

  async get(key: string): Promise<string | null> {
    await this.ensureFresh();
    return this.cache.get(key) ?? CONFIG_DEFAULTS[key] ?? null;
  }

  async getFloat(key: string): Promise<number> {
    const val = await this.get(key);
    return val ? parseFloat(val) : 0;
  }

  async getInt(key: string): Promise<number> {
    const val = await this.get(key);
    return val ? parseInt(val, 10) : 0;
  }

  async getBool(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val === 'true';
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.bot_config.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    this.cache.set(key, value);
  }

  async getAll(prefix?: string): Promise<Record<string, string>> {
    await this.ensureFresh();
    const result: Record<string, string> = {};
    for (const [k, v] of this.cache) {
      if (!prefix || k.startsWith(prefix)) {
        result[k] = v;
      }
    }
    return result;
  }
}
