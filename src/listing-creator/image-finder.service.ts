import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import axios from 'axios';

const IMAGE_BASE_DIR = path.join(process.cwd(), 'listing-creator-images');

@Injectable()
export class ImageFinderService {
  private readonly logger = new Logger(ImageFinderService.name);

  /**
   * Find and download high-res product images using free methods (no API keys).
   * Uses Playwright to scrape product images from retailer sites and image searches.
   *
   * @param filePrefix - unique prefix for filenames to avoid collisions when
   *   searching for multiple items in the same listing (e.g., "main0", "acc1")
   */
  async findProductImages(
    listingId: string,
    itemName: string,
    filePrefix: string = 'img',
  ): Promise<string[]> {
    const sourceDir = path.join(IMAGE_BASE_DIR, listingId, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });

    const downloadedPaths: string[] = [];

    let browser: any = null;
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
      });

      // Enhance camera search queries for hero front shots (not side/top views)
      const isCamera = /fx[0-9]|a7|a9|a1|r[0-9]|gh[0-9]|z[0-9]|bmpcc|pyxis|eos|x-t|x-h|gopro|komodo|alexa/i.test(itemName);
      const searchName = isCamera
        ? `${itemName} camera body front`
        : itemName;

      try {
        // Strategy 1: B&H Photo — best quality product images on white backgrounds
        const bhImages = await this.searchBHPhoto(context, searchName);
        for (const url of bhImages.slice(0, 2)) {
          const p = await this.downloadAndValidate(url, sourceDir, `${filePrefix}_bh_${downloadedPaths.length}`);
          if (p) downloadedPaths.push(p);
        }

        // Strategy 2: Google Images — broad coverage fallback
        if (downloadedPaths.length === 0) {
          const googleImages = await this.searchGoogleImages(context, searchName);
          for (const url of googleImages.slice(0, 4)) {
            const p = await this.downloadAndValidate(url, sourceDir, `${filePrefix}_gimg_${downloadedPaths.length}`);
            if (p) downloadedPaths.push(p);
            if (downloadedPaths.length >= 2) break;
          }
        }

        // Strategy 3: DuckDuckGo Images — if Google failed
        if (downloadedPaths.length === 0) {
          const ddgImages = await this.searchDuckDuckGo(context, searchName);
          for (const url of ddgImages.slice(0, 4)) {
            const p = await this.downloadAndValidate(url, sourceDir, `${filePrefix}_ddg_${downloadedPaths.length}`);
            if (p) downloadedPaths.push(p);
            if (downloadedPaths.length >= 2) break;
          }
        }
      } finally {
        await context.close();
      }
    } catch (error) {
      this.logger.error(`Image finding failed for "${itemName}": ${error.message}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    this.logger.log(`Found ${downloadedPaths.length} images for "${itemName}" (listing ${listingId})`);
    return downloadedPaths;
  }

  /**
   * Search B&H Photo for product images. Their images are high-res on white backgrounds —
   * ideal for background removal and composition.
   */
  private async searchBHPhoto(context: any, itemName: string): Promise<string[]> {
    const urls: string[] = [];
    const page = await context.newPage();

    try {
      const searchUrl = `https://www.bhphotovideo.com/c/search?q=${encodeURIComponent(itemName)}&filters=fct_category%3Acameras`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      // Extract product image URLs from search results
      const imageUrls = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img[src*="static.bhphoto"], img[data-src*="static.bhphoto"]'));
        return imgs
          .map((img: any) => {
            let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
            // B&H images have size params — request large version
            if (src.includes('static.bhphoto')) {
              src = src.replace(/\/images\/\d+x\d+\//, '/images/500x500/');
            }
            return src;
          })
          .filter((src: string) => src && src.startsWith('http') && !src.includes('placeholder'));
      });

      urls.push(...imageUrls.slice(0, 5));

      // Try to get the first product page for higher-res image
      if (urls.length === 0) {
        const productLink = await page.evaluate(() => {
          const link = document.querySelector('a[data-selenium="miniProductPageProductImgLink"], a[href*="/c/product/"]') as any;
          return link?.href || null;
        });

        if (productLink) {
          await page.goto(productLink, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);

          const productImages = await page.evaluate(() => {
            const imgs = Array.from(document.querySelectorAll('img[src*="static.bhphoto"]'));
            return imgs
              .map((img: any) => img.src)
              .filter((src: string) => src && !src.includes('thumbnail') && !src.includes('placeholder'));
          });

          urls.push(...productImages.slice(0, 3));
        }
      }
    } catch (error) {
      this.logger.debug(`B&H Photo search failed for "${itemName}": ${error.message}`);
    } finally {
      await page.close();
    }

    return urls;
  }

  /**
   * Search Google Images via Playwright — extract image source URLs from the results page.
   * Searches for product photos with white/transparent backgrounds.
   */
  private async searchGoogleImages(context: any, itemName: string): Promise<string[]> {
    const urls: string[] = [];
    const page = await context.newPage();

    try {
      const query = encodeURIComponent(`${itemName} product photo white background`);
      await page.goto(
        `https://www.google.com/search?q=${query}&tbm=isch&tbs=isz:l`,
        { waitUntil: 'domcontentloaded', timeout: 15000 },
      );
      await page.waitForTimeout(2000);

      // Google Images embeds base64-encoded thumbnails + loads full URLs via JS.
      // Extract the actual image source URLs from the page's embedded data.
      const imageUrls = await page.evaluate(() => {
        const results: string[] = [];

        // Method 1: Click on images to get full-res URLs
        // Google stores full URLs in the page data
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const text = script.textContent || '';
          // Google embeds image URLs in AF_initDataCallback
          const urlMatches = text.match(/https?:\/\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp)/gi);
          if (urlMatches) {
            for (const url of urlMatches) {
              if (
                !url.includes('google.com') &&
                !url.includes('gstatic.com') &&
                !url.includes('googleapis.com') &&
                !url.includes('schema.org') &&
                url.length < 500
              ) {
                results.push(url);
              }
            }
          }
        }

        // Method 2: Get img src attributes (usually thumbnails but sometimes full-res)
        const imgs = Array.from(document.querySelectorAll('img'));
        for (const img of imgs) {
          const src = img.src;
          if (
            src &&
            src.startsWith('http') &&
            !src.includes('google.com') &&
            !src.includes('gstatic.com') &&
            (src.includes('.jpg') || src.includes('.png') || src.includes('.webp'))
          ) {
            results.push(src);
          }
        }

        // Deduplicate
        return [...new Set(results)];
      });

      urls.push(...imageUrls.slice(0, 10));
    } catch (error) {
      this.logger.debug(`Google Images search failed for "${itemName}": ${error.message}`);
    } finally {
      await page.close();
    }

    return urls;
  }

  /**
   * DuckDuckGo Image search fallback — friendlier to scraping.
   */
  private async searchDuckDuckGo(context: any, itemName: string): Promise<string[]> {
    const urls: string[] = [];
    const page = await context.newPage();

    try {
      const query = encodeURIComponent(`${itemName} product photo`);
      await page.goto(
        `https://duckduckgo.com/?q=${query}&iax=images&ia=images`,
        { waitUntil: 'domcontentloaded', timeout: 15000 },
      );
      await page.waitForTimeout(3000);

      const imageUrls = await page.evaluate(() => {
        const results: string[] = [];
        // DDG stores image info in tile elements
        const tiles = Array.from(document.querySelectorAll('img.tile--img__img, img[data-src]'));
        for (const img of tiles) {
          const src = (img as any).dataset?.src || (img as any).src || '';
          if (src && src.startsWith('http') && !src.includes('duckduckgo.com')) {
            results.push(src);
          }
        }
        return results;
      });

      urls.push(...imageUrls.slice(0, 8));
    } catch (error) {
      this.logger.debug(`DuckDuckGo search failed for "${itemName}": ${error.message}`);
    } finally {
      await page.close();
    }

    return urls;
  }

  /**
   * Download an image URL, validate dimensions (min 400x400), and save as PNG.
   */
  private async downloadAndValidate(
    url: string,
    outputDir: string,
    prefix: string,
  ): Promise<string | null> {
    try {
      // Decode any escaped URLs
      const cleanUrl = url.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\/g, '');

      const response = await axios.get(cleanUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 20 * 1024 * 1024,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Accept: 'image/*',
        },
      });

      const buffer = Buffer.from(response.data);

      // Validate it's actually an image with reasonable dimensions
      const metadata = await sharp(buffer).metadata();
      if (!metadata.width || !metadata.height) return null;
      if (metadata.width < 400 || metadata.height < 400) {
        this.logger.debug(`Rejected ${cleanUrl}: ${metadata.width}x${metadata.height} too small`);
        return null;
      }

      const filename = `${prefix}.png`;
      const filepath = path.join(outputDir, filename);

      // Save as PNG for consistent processing
      await sharp(buffer).png().toFile(filepath);

      this.logger.debug(`Downloaded: ${filepath} (${metadata.width}x${metadata.height})`);
      return filepath;
    } catch (error) {
      this.logger.debug(`Failed to download ${url}: ${error.message}`);
      return null;
    }
  }
}
