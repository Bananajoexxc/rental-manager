import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

const IMAGE_BASE_DIR = path.join(process.cwd(), 'listing-creator-images');

// Background gradient definitions matching existing listing design language
const ACCOUNT_BACKGROUNDS: Record<string, { gradient: { r: number; g: number; b: number }[]; accent: { r: number; g: number; b: number } }> = {
  dbcinema: {
    // DB Cinema: Dark charcoal to deep navy gradient — professional cinema look
    gradient: [
      { r: 28, g: 28, b: 35 },   // top: near-black charcoal
      { r: 18, g: 22, b: 38 },   // bottom: deep navy
    ],
    accent: { r: 59, g: 130, b: 246 }, // blue accent for text
  },
  leo: {
    // Leo Adams: Warm dark gray to charcoal gradient — clean and modern
    gradient: [
      { r: 35, g: 32, b: 30 },   // top: warm dark gray
      { r: 22, g: 20, b: 20 },   // bottom: deep charcoal
    ],
    accent: { r: 245, g: 158, b: 11 }, // amber accent for text
  },
};

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 900;

@Injectable()
export class ImageComposerService {
  private readonly logger = new Logger(ImageComposerService.name);

  /**
   * Compose a final listing image from transparent product images.
   * Places main item centered with accessories arranged around it.
   */
  async composeListingImage(
    listingId: string,
    account: 'dbcinema' | 'leo',
    title: string,
    transparentPaths: string[],
  ): Promise<string | null> {
    const composedDir = path.join(IMAGE_BASE_DIR, listingId, 'composed');
    fs.mkdirSync(composedDir, { recursive: true });

    const outputPath = path.join(composedDir, 'listing.png');

    try {
      // Step 1: Create background canvas with gradient
      const background = await this.createGradientBackground(account);

      // Step 2: Prepare product images (resize and position)
      const composites = await this.prepareComposites(transparentPaths);

      // Step 3: Add title overlay
      const titleOverlay = this.createTitleOverlay(title, account);

      // Step 4: Compose everything
      const allComposites: sharp.OverlayOptions[] = [
        ...composites,
        { input: titleOverlay, top: CANVAS_HEIGHT - 100, left: 40 },
      ];

      await sharp(background)
        .composite(allComposites)
        .png({ quality: 90 })
        .toFile(outputPath);

      this.logger.log(`Composed listing image: ${outputPath}`);
      return outputPath;
    } catch (error) {
      this.logger.error(`Image composition failed for listing ${listingId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Create a gradient background matching the account's design language.
   */
  private async createGradientBackground(account: string): Promise<Buffer> {
    const config = ACCOUNT_BACKGROUNDS[account] || ACCOUNT_BACKGROUNDS.dbcinema;
    const topColor = config.gradient[0];
    const bottomColor = config.gradient[1];

    // Create gradient using raw pixel data
    const channels = 3;
    const rawBuffer = Buffer.alloc(CANVAS_WIDTH * CANVAS_HEIGHT * channels);

    for (let y = 0; y < CANVAS_HEIGHT; y++) {
      const ratio = y / CANVAS_HEIGHT;
      const r = Math.round(topColor.r + (bottomColor.r - topColor.r) * ratio);
      const g = Math.round(topColor.g + (bottomColor.g - topColor.g) * ratio);
      const b = Math.round(topColor.b + (bottomColor.b - topColor.b) * ratio);

      for (let x = 0; x < CANVAS_WIDTH; x++) {
        const idx = (y * CANVAS_WIDTH + x) * channels;
        rawBuffer[idx] = r;
        rawBuffer[idx + 1] = g;
        rawBuffer[idx + 2] = b;
      }
    }

    return sharp(rawBuffer, {
      raw: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, channels },
    })
      .png()
      .toBuffer();
  }

  /**
   * Prepare product images as composites — main item centered, accessories around it.
   */
  private async prepareComposites(transparentPaths: string[]): Promise<sharp.OverlayOptions[]> {
    const composites: sharp.OverlayOptions[] = [];

    if (transparentPaths.length === 0) return composites;

    // Main item: center, 60% of canvas height
    const mainPath = transparentPaths[0];
    if (fs.existsSync(mainPath)) {
      const mainHeight = Math.round(CANVAS_HEIGHT * 0.6);
      const mainWidth = Math.round(CANVAS_WIDTH * 0.6);

      const resized = await sharp(mainPath)
        .resize(mainWidth, mainHeight, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();

      const metadata = await sharp(resized).metadata();
      const actualWidth = metadata.width || mainWidth;
      const actualHeight = metadata.height || mainHeight;

      composites.push({
        input: resized,
        top: Math.round((CANVAS_HEIGHT - actualHeight) / 2) - 30, // Slightly above center
        left: Math.round((CANVAS_WIDTH - actualWidth) / 2),
      });
    }

    // Accessories: smaller, positioned around the main item
    const accessoryPositions = [
      { top: CANVAS_HEIGHT - 200, left: 60 },              // bottom-left
      { top: CANVAS_HEIGHT - 200, left: CANVAS_WIDTH - 220 }, // bottom-right
      { top: 40, left: CANVAS_WIDTH - 200 },                // top-right
    ];

    for (let i = 1; i < transparentPaths.length && i <= 3; i++) {
      const accPath = transparentPaths[i];
      if (!fs.existsSync(accPath)) continue;

      const accSize = Math.round(CANVAS_HEIGHT * 0.18);
      const resized = await sharp(accPath)
        .resize(accSize, accSize, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();

      const pos = accessoryPositions[i - 1];
      composites.push({
        input: resized,
        top: pos.top,
        left: pos.left,
      });
    }

    return composites;
  }

  /**
   * Create a title text overlay using SVG rendering.
   */
  private createTitleOverlay(title: string, account: string): Buffer {
    const config = ACCOUNT_BACKGROUNDS[account] || ACCOUNT_BACKGROUNDS.dbcinema;
    const accent = config.accent;

    // Truncate title if too long
    const displayTitle = title.length > 60 ? title.substring(0, 57) + '...' : title;

    // Escape XML special characters
    const escaped = displayTitle
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const svgWidth = CANVAS_WIDTH - 80;
    const svg = `
      <svg width="${svgWidth}" height="60" xmlns="http://www.w3.org/2000/svg">
        <text x="0" y="35"
          font-family="Arial, Helvetica, sans-serif"
          font-size="24"
          font-weight="600"
          fill="rgb(${accent.r}, ${accent.g}, ${accent.b})"
          letter-spacing="0.5">
          ${escaped}
        </text>
      </svg>
    `;

    return Buffer.from(svg);
  }
}
