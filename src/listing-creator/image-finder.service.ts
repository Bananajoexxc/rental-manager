import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

const IMAGE_BASE_DIR = path.join(process.cwd(), 'listing-creator-images');

@Injectable()
export class ImageFinderService {
  private readonly logger = new Logger(ImageFinderService.name);
  private readonly googleCseKey: string | undefined;
  private readonly googleCseId: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.googleCseKey = this.configService.get('GOOGLE_CSE_KEY');
    this.googleCseId = this.configService.get('GOOGLE_CSE_ID');
  }

  /**
   * Find and download high-res product images for a given item name.
   * Tries Google Custom Search API first, falls back to direct manufacturer page scraping.
   */
  async findProductImages(
    listingId: string,
    itemName: string,
  ): Promise<string[]> {
    const sourceDir = path.join(IMAGE_BASE_DIR, listingId, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });

    const downloadedPaths: string[] = [];

    // Strategy 1: Google Custom Search API (if configured)
    if (this.googleCseKey && this.googleCseId) {
      try {
        const urls = await this.searchGoogleImages(itemName);
        for (const url of urls.slice(0, 3)) {
          const downloaded = await this.downloadAndValidate(url, sourceDir, `gcs_${downloadedPaths.length}`);
          if (downloaded) downloadedPaths.push(downloaded);
        }
      } catch (error) {
        this.logger.warn(`Google CSE search failed for "${itemName}": ${error.message}`);
      }
    }

    // Strategy 2: Direct product image URLs from known manufacturers
    if (downloadedPaths.length === 0) {
      try {
        const manufacturerUrls = await this.searchManufacturerImages(itemName);
        for (const url of manufacturerUrls.slice(0, 3)) {
          const downloaded = await this.downloadAndValidate(url, sourceDir, `mfr_${downloadedPaths.length}`);
          if (downloaded) downloadedPaths.push(downloaded);
        }
      } catch (error) {
        this.logger.debug(`Manufacturer image search failed for "${itemName}": ${error.message}`);
      }
    }

    // Strategy 3: Fallback to web search with image size filters
    if (downloadedPaths.length === 0) {
      try {
        const webUrls = await this.searchWebImages(itemName);
        for (const url of webUrls.slice(0, 3)) {
          const downloaded = await this.downloadAndValidate(url, sourceDir, `web_${downloadedPaths.length}`);
          if (downloaded) downloadedPaths.push(downloaded);
        }
      } catch (error) {
        this.logger.debug(`Web image search failed for "${itemName}": ${error.message}`);
      }
    }

    this.logger.log(`Found ${downloadedPaths.length} valid images for "${itemName}" (listing ${listingId})`);
    return downloadedPaths;
  }

  /**
   * Google Custom Search API — high quality results.
   */
  private async searchGoogleImages(query: string): Promise<string[]> {
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: this.googleCseKey,
        cx: this.googleCseId,
        q: `${query} product photo`,
        searchType: 'image',
        imgSize: 'large',
        imgType: 'photo',
        num: 5,
        safe: 'active',
      },
      timeout: 10000,
    });

    const items = response.data?.items || [];
    return items
      .filter((item: any) => {
        const w = item.image?.width || 0;
        const h = item.image?.height || 0;
        return w >= 600 && h >= 600;
      })
      .map((item: any) => item.link);
  }

  /**
   * Search manufacturer product pages for official product images.
   */
  private async searchManufacturerImages(itemName: string): Promise<string[]> {
    const urls: string[] = [];
    const lower = itemName.toLowerCase();

    // Build manufacturer-specific search URLs
    const searchQueries: string[] = [];

    if (lower.includes('sony')) {
      searchQueries.push(`site:sony.com ${itemName} product image`);
    } else if (lower.includes('canon')) {
      searchQueries.push(`site:canon.com ${itemName} product image`);
    } else if (lower.includes('nikon')) {
      searchQueries.push(`site:nikon.com ${itemName} product image`);
    } else if (lower.includes('dji')) {
      searchQueries.push(`site:dji.com ${itemName} product image`);
    } else if (lower.includes('nanlite') || lower.includes('forza')) {
      searchQueries.push(`site:nanlite.com ${itemName} product image`);
    } else if (lower.includes('rode')) {
      searchQueries.push(`site:rode.com ${itemName} product image`);
    } else if (lower.includes('blackmagic') || lower.includes('bmpcc')) {
      searchQueries.push(`site:blackmagicdesign.com ${itemName} product image`);
    } else if (lower.includes('aputure')) {
      searchQueries.push(`site:aputure.com ${itemName} product image`);
    } else if (lower.includes('hollyland')) {
      searchQueries.push(`site:hollyland.com ${itemName} product image`);
    }

    // Generic search as fallback
    searchQueries.push(`${itemName} official product photo transparent background`);

    // Use Google CSE if available for manufacturer search
    if (this.googleCseKey && this.googleCseId) {
      for (const query of searchQueries.slice(0, 2)) {
        try {
          const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
            params: {
              key: this.googleCseKey,
              cx: this.googleCseId,
              q: query,
              searchType: 'image',
              imgSize: 'large',
              num: 3,
            },
            timeout: 10000,
          });
          const items = response.data?.items || [];
          for (const item of items) {
            if (item.link) urls.push(item.link);
          }
          if (urls.length >= 3) break;
        } catch { /* continue with next query */ }
      }
    }

    return urls;
  }

  /**
   * Generic web image search fallback.
   */
  private async searchWebImages(itemName: string): Promise<string[]> {
    // Without Google CSE, we can try to get images from product pages
    // This is a simplified approach - in production, would use Playwright
    const urls: string[] = [];

    try {
      // Try to find product pages via regular search
      const response = await axios.get('https://www.google.com/search', {
        params: {
          q: `${itemName} product photo png`,
          tbm: 'isch',
          tbs: 'isz:l', // large images
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        timeout: 10000,
      });

      // Extract image URLs from response (basic regex extraction)
      const imgMatches = response.data.match(/https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|webp)/gi) || [];
      for (const url of imgMatches) {
        if (!url.includes('google.com') && !url.includes('gstatic.com')) {
          urls.push(url);
          if (urls.length >= 5) break;
        }
      }
    } catch {
      this.logger.debug(`Web image search failed for "${itemName}"`);
    }

    return urls;
  }

  /**
   * Download an image, validate dimensions, and save to disk.
   */
  private async downloadAndValidate(
    url: string,
    outputDir: string,
    prefix: string,
  ): Promise<string | null> {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 20 * 1024 * 1024, // 20MB max
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'image/*',
        },
      });

      const buffer = Buffer.from(response.data);

      // Validate image dimensions
      const metadata = await sharp(buffer).metadata();
      if (!metadata.width || !metadata.height) return null;
      if (metadata.width < 600 || metadata.height < 600) {
        this.logger.debug(`Rejected image from ${url}: ${metadata.width}x${metadata.height} (too small)`);
        return null;
      }

      // Determine file extension from format
      const ext = metadata.format === 'png' ? 'png' : metadata.format === 'webp' ? 'webp' : 'jpg';
      const filename = `${prefix}.${ext}`;
      const filepath = path.join(outputDir, filename);

      // Convert to PNG for consistent processing
      await sharp(buffer).png().toFile(filepath);

      this.logger.debug(`Downloaded: ${filepath} (${metadata.width}x${metadata.height})`);
      return filepath;
    } catch (error) {
      this.logger.debug(`Failed to download/validate image from ${url}: ${error.message}`);
      return null;
    }
  }
}
