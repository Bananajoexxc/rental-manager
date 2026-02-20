import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import axios from 'axios';

const execFileAsync = promisify(execFile);
const IMAGE_BASE_DIR = path.join(process.cwd(), 'listing-creator-images');

@Injectable()
export class BackgroundRemoverService {
  private readonly logger = new Logger(BackgroundRemoverService.name);
  private readonly method: 'rembg' | 'removebg';
  private readonly removeBgApiKey: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.method = (this.configService.get('BACKGROUND_REMOVAL_METHOD') || 'rembg') as 'rembg' | 'removebg';
    this.removeBgApiKey = this.configService.get('REMOVE_BG_API_KEY');
  }

  /**
   * Remove background from a source image and save as transparent PNG.
   */
  async removeBackground(
    listingId: string,
    sourcePath: string,
  ): Promise<string | null> {
    const transparentDir = path.join(IMAGE_BASE_DIR, listingId, 'transparent');
    fs.mkdirSync(transparentDir, { recursive: true });

    const basename = path.basename(sourcePath, path.extname(sourcePath));
    const outputPath = path.join(transparentDir, `${basename}_transparent.png`);

    try {
      if (this.method === 'removebg' && this.removeBgApiKey) {
        await this.removeWithRemoveBg(sourcePath, outputPath);
      } else {
        await this.removeWithRembg(sourcePath, outputPath);
      }

      // Validate result
      const valid = await this.validateTransparentImage(outputPath);
      if (!valid) {
        this.logger.warn(`Background removal quality check failed for ${sourcePath}`);
        // Keep the file anyway — it might still be usable
      }

      return outputPath;
    } catch (error) {
      this.logger.error(`Background removal failed for ${sourcePath}: ${error.message}`);
      return null;
    }
  }

  /**
   * Remove background using rembg Python API (local ML model, no API key needed).
   * Uses /usr/bin/python3 directly to avoid CLI dependency issues (gradio, watchdog).
   */
  private async removeWithRembg(inputPath: string, outputPath: string): Promise<void> {
    const script = `
from rembg import remove
from PIL import Image
img = Image.open("${inputPath.replace(/"/g, '\\"')}")
result = remove(img)
result.save("${outputPath.replace(/"/g, '\\"')}")
print("OK")
`.trim();

    try {
      const { stdout, stderr } = await execFileAsync('/usr/bin/python3', ['-c', script], {
        timeout: 120000, // 120s timeout — first run downloads model
      });
      if (stdout.includes('OK')) {
        this.logger.debug(`rembg processed: ${inputPath} → ${outputPath}`);
      } else {
        throw new Error(`rembg output: ${stdout} ${stderr}`);
      }
    } catch (error: any) {
      this.logger.error(`rembg failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Remove background using remove.bg API (paid, higher quality).
   */
  private async removeWithRemoveBg(inputPath: string, outputPath: string): Promise<void> {
    const imageData = fs.readFileSync(inputPath);
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('image_file', imageData, { filename: path.basename(inputPath) });
    form.append('size', 'auto');

    const response = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
      headers: {
        ...form.getHeaders(),
        'X-Api-Key': this.removeBgApiKey!,
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    fs.writeFileSync(outputPath, Buffer.from(response.data));
    this.logger.debug(`remove.bg processed: ${inputPath} → ${outputPath}`);
  }

  /**
   * Validate that the background removal produced a reasonable result.
   * Checks that alpha channel covers >10% and <90% of the image.
   */
  private async validateTransparentImage(imagePath: string): Promise<boolean> {
    try {
      const { data, info } = await sharp(imagePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const totalPixels = info.width * info.height;
      let transparentPixels = 0;

      // Alpha channel is every 4th byte (RGBA)
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 128) transparentPixels++;
      }

      const transparentRatio = transparentPixels / totalPixels;

      if (transparentRatio < 0.1) {
        this.logger.debug(`Validation: only ${(transparentRatio * 100).toFixed(1)}% transparent — background may not have been removed`);
        return false;
      }
      if (transparentRatio > 0.9) {
        this.logger.debug(`Validation: ${(transparentRatio * 100).toFixed(1)}% transparent — subject may have been removed`);
        return false;
      }

      this.logger.debug(`Validation passed: ${(transparentRatio * 100).toFixed(1)}% transparent`);
      return true;
    } catch (error) {
      this.logger.warn(`Validation error: ${error.message}`);
      return false;
    }
  }
}
