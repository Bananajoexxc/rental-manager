import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

const IMAGE_BASE_DIR = path.join(process.cwd(), 'listing-creator-images');
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 890;

/**
 * Playwright HTML-to-Screenshot image composer.
 *
 * Matches Daniel's actual Hygglo listing style:
 * - BIG white caps text with THICK black surrounding (stroke)
 * - Products LARGE, filling frame — hero shots prominent
 * - Context-aware layout: 1-3 items = single row, 4+ = multi-row grid
 * - Drop shadows, warm tan gradient, DB Cinema / Leo Adams logo
 *
 * Key technique: transparent PNGs are Sharp-trimmed to remove excess whitespace
 * before embedding, so products fill the frame like Daniel's real listings.
 */
@Injectable()
export class ImageComposerService {
  private readonly logger = new Logger(ImageComposerService.name);

  async composeListingImage(
    listingId: string,
    account: 'dbcinema' | 'leo',
    title: string,
    mainPaths: string[],
    accPaths: string[],
  ): Promise<string | null> {
    const composedDir = path.join(IMAGE_BASE_DIR, listingId, 'composed');
    fs.mkdirSync(composedDir, { recursive: true });
    const outputPath = path.join(composedDir, 'listing.jpg');

    try {
      const mainDataUris: string[] = [];
      for (const p of mainPaths.filter(f => fs.existsSync(f))) {
        mainDataUris.push(await this.trimAndToDataUri(p));
      }
      const accDataUris: string[] = [];
      for (const p of accPaths.filter(f => fs.existsSync(f))) {
        accDataUris.push(await this.trimAndToDataUri(p));
      }

      if (mainDataUris.length === 0) {
        this.logger.warn(`No main images found for listing ${listingId}`);
        return null;
      }

      const html = this.buildHtml(account, title, mainDataUris, accDataUris);

      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      try {
        const page = await browser.newPage({
          viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
        });

        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);

        const screenshot = await page.screenshot({
          type: 'jpeg',
          quality: 94,
          clip: { x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
        });

        fs.writeFileSync(outputPath, screenshot);
        this.logger.log(`Composed listing image via Playwright: ${outputPath}`);
        return outputPath;
      } finally {
        await browser.close();
      }
    } catch (error) {
      this.logger.error(`Image composition failed for listing ${listingId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Trim transparent borders then convert to base64 data URI.
   * Without trimming, transparent PNGs have huge empty borders that make
   * products appear tiny when rendered with object-fit:contain.
   */
  private async trimAndToDataUri(filePath: string): Promise<string> {
    try {
      const trimmed = await sharp(filePath)
        .trim({ threshold: 10 })
        .png()
        .toBuffer();
      return `data:image/png;base64,${trimmed.toString('base64')}`;
    } catch (e) {
      this.logger.debug(`Trim failed for ${filePath}, using original: ${e.message}`);
      const buffer = fs.readFileSync(filePath);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    }
  }

  private buildHtml(
    account: string,
    title: string,
    mainDataUris: string[],
    accDataUris: string[],
  ): string {
    const displayTitle = title.toUpperCase();
    const escaped = displayTitle
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const hasAcc = accDataUris.length > 0;
    const mainCount = mainDataUris.length;

    // Title: match Daniel's EXACT Hygglo listing style — Impact font, BIG, wraps naturally
    // Daniel's visible stroke is ~8-9px at ~85px font → ~10% ratio
    let titleSize = 88;
    if (escaped.length > 55) titleSize = 78;
    else if (escaped.length > 42) titleSize = 84;

    // Impact is ~0.52 char-width ratio (wider than Anton/Bebas)
    const charsPerLine = Math.floor((CANVAS_WIDTH - 40) / (titleSize * 0.52));
    const titleLines = Math.ceil(escaped.length / charsPerLine);
    const titleAreaHeight = Math.max(100, titleLines * (titleSize * 1.1) + 16);

    // Layout: multi-row for 4+ main items
    const useMultiRow = mainCount >= 4;
    const accAreaHeight = hasAcc ? 195 : 0;
    const productTop = titleAreaHeight;
    const productHeight = CANVAS_HEIGHT - productTop - accAreaHeight - 8;

    // Build products HTML based on layout mode
    let productsHtml: string;
    let productsStyle: string;

    if (useMultiRow) {
      // Multi-row: first item is hero (larger), rest in second row
      const heroUri = mainDataUris[0];
      const restUris = mainDataUris.slice(1);
      const heroHeight = Math.round(productHeight * 0.62);
      const rowHeight = productHeight - heroHeight - 8;

      productsHtml = `
        <div class="hero-row" style="height:${heroHeight}px">
          <div class="hero-slot"><img src="${heroUri}"></div>
        </div>
        <div class="items-row" style="height:${rowHeight}px">
          ${restUris.map(u => `<div class="item-slot"><img src="${u}"></div>`).join('\n')}
        </div>`;

      productsStyle = `
        .hero-row {
          display: flex; align-items: center; justify-content: center;
          width: 100%; padding: 0 40px;
        }
        .hero-slot { height: 100%; display: flex; align-items: center; justify-content: center; }
        .hero-slot img {
          max-height: 100%; max-width: 800px; object-fit: contain;
          filter: drop-shadow(6px 12px 22px rgba(0,0,0,0.42));
        }
        .items-row {
          display: flex; align-items: center; justify-content: center;
          width: 100%; gap: 6px; padding: 0 10px;
        }
        .item-slot {
          flex: 1; height: 100%; display: flex; align-items: center; justify-content: center;
        }
        .item-slot img {
          max-width: 95%; max-height: 95%; object-fit: contain;
          filter: drop-shadow(5px 10px 18px rgba(0,0,0,0.40));
        }`;
    } else {
      // Single row: all items equal size, filling space
      productsHtml = mainDataUris
        .map(u => `<div class="product-slot"><img src="${u}"></div>`)
        .join('\n');

      productsStyle = `
        .product-slot {
          flex: 1; height: 100%; display: flex; align-items: center; justify-content: center;
        }
        .product-slot img {
          max-width: 100%; max-height: 100%; object-fit: contain;
          filter: drop-shadow(6px 12px 22px rgba(0,0,0,0.42));
        }`;
    }

    // Build accessory HTML — show duplicates (e.g. 3x batteries = 3 images)
    const accItemsHtml = accDataUris
      .map(u => `<div class="acc-slot"><img src="${u}"></div>`)
      .join('\n');

    const accSection = hasAcc
      ? `<div class="accessories">${accItemsHtml}</div>`
      : '';

    // Stroke width: text-stroke splits 50/50 inside/outside glyph edge.
    // paint-order:stroke fill covers inner half → visible outline = strokeWidth/2.
    // Daniel's visible outline is ~8px at ~85px font → ~9.4% ratio.
    // For 78px font: 8px visible → 16px text-stroke
    const strokeWidth = 16;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<!-- Impact font installed system-wide via ttf-mscorefonts-installer -->
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: ${CANVAS_WIDTH}px;
    height: ${CANVAS_HEIGHT}px;
    background: linear-gradient(155deg, #C69660 0%, #D4A574 25%, #E2BF94 60%, #DEBB8A 100%);
    overflow: hidden;
    position: relative;
  }

  /* ── Title: exact replica of Daniel's Hygglo listing style ── */
  /* Impact font + paint-order stroke for clean thick black outline behind white fill */
  .title {
    position: absolute;
    top: 6px;
    left: 16px;
    right: 16px;
    font-family: Impact, 'Arial Black', 'Anton', sans-serif;
    font-size: ${titleSize}px;
    font-weight: 400;
    color: white;
    letter-spacing: 3px;
    line-height: 1.08;
    -webkit-text-stroke: ${strokeWidth}px #000;
    paint-order: stroke fill;
    text-shadow: 2px 3px 4px rgba(0,0,0,0.35);
    z-index: 10;
  }

  /* ── Products area ── */
  .products {
    position: absolute;
    top: ${productTop}px;
    left: 6px;
    right: 6px;
    height: ${productHeight}px;
    display: flex;
    flex-direction: ${useMultiRow ? 'column' : 'row'};
    align-items: center;
    justify-content: center;
    gap: ${useMultiRow ? '4' : mainCount <= 2 ? '15' : '6'}px;
  }

  ${productsStyle}

  /* ── Accessories: visible row at bottom ── */
  .accessories {
    position: absolute;
    bottom: 6px;
    left: 16px;
    right: 16px;
    height: ${accAreaHeight - 10}px;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 15px;
  }

  .acc-slot {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .acc-slot img {
    max-height: ${accAreaHeight - 30}px;
    max-width: 165px;
    object-fit: contain;
    filter: drop-shadow(4px 8px 14px rgba(0,0,0,0.35));
  }

</style>
</head>
<body>
  <div class="title">${escaped}</div>

  <div class="products">
    ${productsHtml}
  </div>

  ${accSection}

</body>
</html>`;
  }
}
