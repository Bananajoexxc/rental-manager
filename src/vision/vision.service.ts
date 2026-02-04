import { Injectable, Logger } from '@nestjs/common';
import { SentryService } from '../monitoring/sentry.service';

// Import Vision API types without strict checking
const vision = require('@google-cloud/vision');

export interface DamageAnalysisResult {
  damage_score: number; // 0-1 scale (0 = pristine, 1 = severely damaged)
  detected_issues: string[];
  confidence: number;
  labels: string[];
  objects: string[];
  safe_search: {
    adult: string;
    violence: string;
  };
  comparison_vs_checkout?: string;
}

@Injectable()
export class VisionService {
  private readonly logger = new Logger(VisionService.name);
  private client: any = null;
  private enabled: boolean = false;

  constructor(private sentryService: SentryService) {
    // Only initialize if credentials are available
    if (process.env.GOOGLE_CLOUD_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      try {
        this.client = new vision.ImageAnnotatorClient({
          keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        });
        this.enabled = true;
        this.logger.log('✅ Google Vision API initialized');
      } catch (error: any) {
        this.logger.warn('⚠️ Google Vision API not configured. Damage detection disabled.');
        this.logger.warn(`Error: ${error.message}`);
      }
    } else {
      this.logger.warn('⚠️ Google Vision API credentials not found. Set GOOGLE_APPLICATION_CREDENTIALS in .env');
    }
  }

  /**
   * Analyze equipment photo for damage detection
   */
  async analyzeEquipmentPhoto(
    imageUrl: string,
    photoType: 'checkout' | 'return' | 'listing',
  ): Promise<DamageAnalysisResult> {
    if (!this.enabled || !this.client) {
      this.logger.warn('Vision API not enabled. Returning default result.');
      return this.getDefaultResult();
    }

    const startTime = Date.now();

    try {
      // Perform multiple detections in parallel for efficiency
      const [labelResults, objectResults, safeSearchResults] = await Promise.all([
        this.client.labelDetection(imageUrl),
        this.client.objectLocalization(imageUrl),
        this.client.safeSearchDetection(imageUrl),
      ]);

      const labels = labelResults[0].labelAnnotations?.map((label: any) => label.description) || [];
      const objects = objectResults[0].localizedObjectAnnotations?.map((obj: any) => obj.name) || [];
      const safeSearch = safeSearchResults[0].safeSearchAnnotation;

      // Calculate damage score based on detected issues
      const damageIndicators = this.detectDamageIndicators(labels, objects);
      const damageScore = this.calculateDamageScore(damageIndicators);

      const result: DamageAnalysisResult = {
        damage_score: damageScore,
        detected_issues: damageIndicators,
        confidence: this.calculateConfidence(labelResults[0].labelAnnotations || []),
        labels: labels.slice(0, 10), // Top 10 labels
        objects: objects.slice(0, 10), // Top 10 objects
        safe_search: {
          adult: String(safeSearch?.adult || 'UNKNOWN'),
          violence: String(safeSearch?.violence || 'UNKNOWN'),
        },
      };

      // Monitor performance
      const duration = Date.now() - startTime;
      this.sentryService.monitorApiPerformance('google_vision', duration, {
        photo_type: photoType,
        damage_score: damageScore,
        detected_issues_count: damageIndicators.length,
      });

      // Log result
      this.logger.log(
        `Vision analysis complete: damage_score=${damageScore.toFixed(2)}, ` +
          `issues=${damageIndicators.length}, duration=${duration}ms`,
      );

      // Alert if significant damage detected
      if (photoType === 'return' && damageScore > 0.5) {
        this.sentryService.captureMessage('Significant equipment damage detected', 'warning', {
          damage_score: damageScore,
          detected_issues: damageIndicators,
          photo_type: photoType,
          image_url: imageUrl,
        });
      }

      return result;
    } catch (error: any) {
      this.logger.error(`Vision API error: ${error.message}`, error.stack);
      this.sentryService.captureError(error, {
        operation: 'vision_analysis',
        photo_type: photoType,
        image_url: imageUrl,
      });

      return this.getDefaultResult();
    }
  }

  /**
   * Compare checkout and return photos to detect damage
   */
  async compareDamage(
    checkoutImageUrl: string,
    returnImageUrl: string,
  ): Promise<{
    checkout: DamageAnalysisResult;
    return: DamageAnalysisResult;
    damage_increase: number;
    recommendation: string;
  }> {
    const [checkoutResult, returnResult] = await Promise.all([
      this.analyzeEquipmentPhoto(checkoutImageUrl, 'checkout'),
      this.analyzeEquipmentPhoto(returnImageUrl, 'return'),
    ]);

    const damageIncrease = returnResult.damage_score - checkoutResult.damage_score;

    let recommendation = 'No action needed';
    if (damageIncrease > 0.3) {
      recommendation = 'Significant damage detected. Charge renter for repair/replacement.';
    } else if (damageIncrease > 0.15) {
      recommendation = 'Minor damage detected. Consider charging cleaning or minor repair fee.';
    } else if (damageIncrease < -0.1) {
      recommendation = 'Equipment appears to be in better condition. Possible cleaning by renter.';
    }

    returnResult.comparison_vs_checkout = recommendation;

    return {
      checkout: checkoutResult,
      return: returnResult,
      damage_increase: damageIncrease,
      recommendation,
    };
  }

  /**
   * Verify equipment matches listing description
   */
  async verifyEquipment(
    imageUrl: string,
    expectedEquipment: string[],
  ): Promise<{
    verified: boolean;
    detected_equipment: string[];
    missing_equipment: string[];
    extra_equipment: string[];
    confidence: number;
  }> {
    if (!this.enabled || !this.client) {
      return {
        verified: true,
        detected_equipment: expectedEquipment,
        missing_equipment: [],
        extra_equipment: [],
        confidence: 0.5,
      };
    }

    try {
      const [objectResults] = await this.client.objectLocalization(imageUrl);
      const detectedObjects = objectResults?.localizedObjectAnnotations?.map((obj: any) => obj.name.toLowerCase()) || [];

      // Match detected objects with expected equipment
      const expectedLower = expectedEquipment.map((item) => item.toLowerCase());
      const missing = expectedLower.filter((item: string) => !detectedObjects.some((obj: string) => obj.includes(item)));
      const extra = detectedObjects.filter((obj: string) => !expectedLower.some((item: string) => obj.includes(item)));

      const verified = missing.length === 0;
      const confidence = detectedObjects.length > 0 ? 1 - missing.length / expectedLower.length : 0.5;

      if (!verified) {
        this.logger.warn(`Equipment verification failed. Missing: ${missing.join(', ')}`);
      }

      return {
        verified,
        detected_equipment: detectedObjects,
        missing_equipment: missing,
        extra_equipment: extra,
        confidence,
      };
    } catch (error: any) {
      this.logger.error(`Equipment verification error: ${error.message}`);
      return {
        verified: true, // Don't block on verification errors
        detected_equipment: [],
        missing_equipment: [],
        extra_equipment: [],
        confidence: 0,
      };
    }
  }

  /**
   * Extract text from image (OCR for serial numbers)
   */
  async extractText(imageUrl: string): Promise<{
    text: string;
    serial_numbers: string[];
    confidence: number;
  }> {
    if (!this.enabled || !this.client) {
      return { text: '', serial_numbers: [], confidence: 0 };
    }

    try {
      const [result] = await this.client.textDetection(imageUrl);
      const text = result.fullTextAnnotation?.text || '';

      // Extract potential serial numbers (alphanumeric patterns)
      const serialNumberPattern = /\b[A-Z0-9]{6,20}\b/g;
      const serialNumbers = text.match(serialNumberPattern) || [];

      return {
        text,
        serial_numbers: serialNumbers,
        confidence: result.fullTextAnnotation ? 0.9 : 0,
      };
    } catch (error: any) {
      this.logger.error(`Text extraction error: ${error.message}`);
      return { text: '', serial_numbers: [], confidence: 0 };
    }
  }

  /**
   * Detect damage indicators from labels and objects
   */
  private detectDamageIndicators(labels: string[], objects: string[]): string[] {
    const damageKeywords = [
      'scratch',
      'dent',
      'crack',
      'broken',
      'damaged',
      'wear',
      'tear',
      'stain',
      'dirt',
      'dust',
      'rust',
      'corrosion',
      'discoloration',
      'chip',
      'scuff',
      'mark',
    ];

    const allText = [...labels, ...objects].map((text) => text.toLowerCase());
    const issues: string[] = [];

    for (const keyword of damageKeywords) {
      if (allText.some((text) => text.includes(keyword))) {
        issues.push(keyword);
      }
    }

    return issues;
  }

  /**
   * Calculate damage score (0-1) based on detected issues
   */
  private calculateDamageScore(issues: string[]): number {
    if (issues.length === 0) return 0;

    // Weight different issues differently
    const severityWeights: Record<string, number> = {
      broken: 1.0,
      crack: 0.9,
      damaged: 0.9,
      dent: 0.7,
      scratch: 0.5,
      wear: 0.4,
      tear: 0.4,
      stain: 0.3,
      dirt: 0.2,
      dust: 0.1,
    };

    let totalScore = 0;
    for (const issue of issues) {
      const weight = severityWeights[issue] || 0.3;
      totalScore += weight;
    }

    // Normalize to 0-1 scale (cap at 1.0)
    return Math.min(totalScore / 2, 1.0);
  }

  /**
   * Calculate confidence from label annotations
   */
  private calculateConfidence(annotations: any[] = []): number {
    if (!annotations || annotations.length === 0) return 0.5;

    const avgScore =
      annotations.reduce((sum: number, ann: any) => sum + (ann.score || 0), 0) / annotations.length;

    return avgScore;
  }

  /**
   * Get default result when Vision API is disabled
   */
  private getDefaultResult(): DamageAnalysisResult {
    return {
      damage_score: 0.0,
      detected_issues: [],
      confidence: 0.5,
      labels: [],
      objects: [],
      safe_search: {
        adult: 'UNKNOWN',
        violence: 'UNKNOWN',
      },
    };
  }

  /**
   * Check if Vision API is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}
