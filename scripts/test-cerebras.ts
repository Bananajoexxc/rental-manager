/**
 * Test the title parser with Claude Haiku via the NestJS service.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { TitleParserService } from '../src/revenue/title-parser.service';

const TITLES = [
  'Sony FX 3 Mirrorless  camera cinema full frame 4k  fx3 + Sony 24-70mm gmaster g-master gm zoom lens f2.8 (same sensor as a7siii a7s iii)',
  'Sony A7 III 4K Camera + DJI Wireless Mic (2x) – Complete Interview & Content Creator Kit A7iii full frame mirrorless microphone mic lav lapel audio recorder',
  'BMPCC 6K Pro Ultimate Short Film Set – Full Blackmagic Cinema Camera Kit with Canon 24-105mm Lens, DJI Gimbal, Atomos Monitor, RGB Lighting & Wireless Mics | Professional Filmmaking Package',
];

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const parser = app.get(TitleParserService);

  for (const title of TITLES) {
    console.log(`\nTitle: ${title.substring(0, 80)}`);
    const result = await parser.parseTitleWithAI(title, true);
    console.log(`  Result: ${JSON.stringify(result)}`);
    console.log(`  Items: ${result.map(r => `${r.item} (${r.qty})`).join(', ') || '(none)'}`);
  }

  await app.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
