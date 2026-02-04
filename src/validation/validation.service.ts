import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getInventoryItemNames } from '../utils/item-matcher';

export interface ValidationResult {
  passed: boolean;
  violations: string[];
  severity: 'critical' | 'high' | 'medium' | 'low';
  blocked: boolean;
  details?: Record<string, any>;
}

export interface ValidationContext {
  responseType?: string;
  context?: {
    rental?: any;
    message?: any;
    pricing?: any;
  };
}

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Main validation entry point - runs all validators
   */
  async validateResponse(
    responseText: string,
    context: ValidationContext,
    aiDecisionId?: string,
  ): Promise<ValidationResult> {
    const violations: string[] = [];
    let severity: 'critical' | 'high' | 'medium' | 'low' = 'low';
    let blocked = false;

    // Run all validators
    const results = await Promise.all([
      this.checkCredentialLeakage(responseText),
      this.checkDualAccountDisclosure(responseText),
      this.checkEarlyAddressDisclosure(responseText, context),
      this.checkPricingAccuracy(responseText, context),
      this.checkTemplateFidelity(responseText, context),
      this.checkInventoryHallucination(responseText),
    ]);

    // Aggregate results
    for (const result of results) {
      if (!result.passed) {
        violations.push(...result.violations);

        // Severity escalation
        if (result.severity === 'critical') {
          severity = 'critical';
          blocked = true;
        } else if (result.severity === 'high' && severity !== 'critical') {
          severity = 'high';
          if (result.blocked) blocked = true;
        } else if (result.severity === 'medium' && !['critical', 'high'].includes(severity)) {
          severity = 'medium';
        }
      }
    }

    const finalResult: ValidationResult = {
      passed: violations.length === 0,
      violations,
      severity,
      blocked,
    };

    // Log to database
    await this.logValidation(responseText, finalResult, aiDecisionId);

    if (!finalResult.passed) {
      this.logger.warn(
        `Validation failed: ${violations.length} violations (${severity}) - blocked: ${blocked}`,
      );
    }

    return finalResult;
  }

  /**
   * Validator 1: Credential Leakage Detector
   * Detects emails, passwords, API keys, tokens, phone numbers
   */
  private async checkCredentialLeakage(text: string): Promise<ValidationResult> {
    const violations: string[] = [];

    // Email pattern
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    const emails = text.match(emailPattern);
    if (emails && emails.length > 0) {
      violations.push(`Email address detected: ${emails.join(', ')}`);
    }

    // API key patterns (common formats)
    const apiKeyPatterns = [
      /\b[A-Za-z0-9_-]{32,}\b/, // Generic long alphanumeric strings
      /sk-[A-Za-z0-9]{20,}/, // OpenAI/Anthropic style
      /ANTHROPIC_API_KEY/, // Environment variable names
      /API[_-]?KEY/i,
    ];

    for (const pattern of apiKeyPatterns) {
      if (pattern.test(text)) {
        violations.push(`Potential API key pattern detected`);
        break;
      }
    }

    // Password-related keywords
    const passwordKeywords = /\b(password|passwd|pwd|secret|token|credential|auth_token)\b[:\s]*[A-Za-z0-9!@#$%^&*()_+=-]{6,}/i;
    if (passwordKeywords.test(text)) {
      violations.push(`Password or credential reference detected`);
    }

    // UK phone numbers
    const phonePattern = /\b((\+44\s?|0)(\d\s?){9,10})\b/g;
    const phones = text.match(phonePattern);
    if (phones && phones.length > 0) {
      // Allow phone numbers in specific contexts (booking confirmation templates)
      const isBookingContext = text.includes('booking confirmed') || text.includes('collection details');
      if (!isBookingContext) {
        violations.push(`Phone number detected outside approved context`);
      }
    }

    return {
      passed: violations.length === 0,
      violations,
      severity: 'critical',
      blocked: violations.length > 0, // Always block credential leaks
    };
  }

  /**
   * Validator 2: Early Address Disclosure Detector
   * CRITICAL: Prevents revealing exact pickup address before booking is verified
   * Only allow vague "Central London" or "Trafalgar Square area" until booking confirmed
   */
  private async checkEarlyAddressDisclosure(
    text: string,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const violations: string[] = [];

    // Check if this is a booking confirmation message (allowed to have address)
    const isBookingConfirmed =
      context.responseType === 'booking_confirmed' ||
      /booking.*(confirmed|verified|accepted)/i.test(text) ||
      /your booking is/i.test(text);

    // If booking is confirmed, address disclosure is allowed
    if (isBookingConfirmed) {
      return {
        passed: true,
        violations: [],
        severity: 'low',
        blocked: false,
      };
    }

    // CRITICAL: Actual pickup addresses that must NEVER be disclosed before booking confirmed
    // Note: 23 Whitcomb Street is internal delivery reference, not a critical disclosure
    const forbiddenAddresses = [
      // DB Cinema pickup location
      /11\s*Trafalgar\s*Square/i,
      /WC2N\s*5DN/i,
      /Statue\s*of\s*James/i,
      /James\s*(II|the\s*Second)/i,

      // Leo Adams pickup location
      /5\s*Pall\s*Mall\s*East/i,
      /SW1Y\s*5BF/i,
      /Pret.*Pall\s*Mall/i,

      // Map links (contain exact locations)
      /maps\.apple.*FexFCzGnk59Y/i,
      /maps\.app\.goo\.gl.*ry8ea4tySBoah7d7A/i,
      /maps\.(google|apple).*trafalgar/i,
    ];

    for (const addressPattern of forbiddenAddresses) {
      if (addressPattern.test(text)) {
        violations.push(
          `Exact pickup address disclosed before booking verified: "${text.match(addressPattern)?.[0]}"`,
        );
      }
    }

    // Check for suspicious address-like patterns (street numbers + postcode format)
    const suspiciousAddress = /\b\d+\s+[A-Z][a-z]+\s+(Street|Road|Square|Mall)\b.*\b[A-Z]{2}\d{1,2}\s*\d[A-Z]{2}\b/i;
    if (suspiciousAddress.test(text) && !isBookingConfirmed) {
      violations.push('Potential exact address disclosed before booking verified');
    }

    return {
      passed: violations.length === 0,
      violations,
      severity: 'critical',
      blocked: violations.length > 0, // Always block early address disclosure
    };
  }

  /**
   * Validator 3: Dual-Account Disclosure Detector
   * Prevents revealing DB Cinema & Leo Adams are same business
   */
  private async checkDualAccountDisclosure(text: string): Promise<ValidationResult> {
    const violations: string[] = [];

    const blacklistedPhrases = [
      /\bsame\s+(business|company|person|owner|inventory|stock)\b/i,
      /\bshared?\s+(inventory|stock|items|equipment)\b/i,
      /\bboth\s+accounts?\b/i,
      /\bDB\s+Cinema.*Leo\s+Adams.*same/i,
      /\bLeo\s+Adams.*DB\s+Cinema.*same/i,
      /\bone\s+business.*two\s+accounts/i,
      /\btwo\s+accounts.*one\s+business/i,
      /\brun\s+both/i,
      /\bown\s+both/i,
    ];

    for (const phrase of blacklistedPhrases) {
      if (phrase.test(text)) {
        violations.push(`Dual-account disclosure phrase detected: "${text.match(phrase)?.[0]}"`);
      }
    }

    // Check for mentions of both account names in close proximity
    const hasDBCinema = /DB\s+Cinema/i.test(text);
    const hasLeoAdams = /Leo\s+Adams/i.test(text);

    if (hasDBCinema && hasLeoAdams) {
      // Check if they're mentioned in a way that suggests connection
      const connectionWords = /(same|shared|both|also|too|as well|related|connected)/i;
      if (connectionWords.test(text)) {
        violations.push(`Both account names mentioned with connection keywords`);
      }
    }

    return {
      passed: violations.length === 0,
      violations,
      severity: 'critical',
      blocked: violations.length > 0, // Always block dual-account disclosures
    };
  }

  /**
   * Validator 4: Pricing Accuracy Validator
   * Cross-references quoted prices against pricing catalog
   */
  private async checkPricingAccuracy(
    text: string,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const violations: string[] = [];

    // Extract price mentions (£X, £X-Y, approximately £X)
    const pricePattern = /£\s*(\d+)(?:\s*-\s*£?\s*(\d+))?/g;
    const priceMatches = [...text.matchAll(pricePattern)];

    if (priceMatches.length === 0) {
      // No prices mentioned, validation passes
      return {
        passed: true,
        violations: [],
        severity: 'low',
        blocked: false,
      };
    }

    // Load pricing catalog from memory service (simplified check)
    // In production, this would cross-reference actual catalog
    const extractedPrices = priceMatches.map(match => ({
      low: parseInt(match[1]),
      high: match[2] ? parseInt(match[2]) : parseInt(match[1]),
    }));

    // Flag obviously wrong prices (too low or too high for cinema equipment)
    for (const price of extractedPrices) {
      if (price.low < 5) {
        violations.push(`Suspiciously low price: £${price.low} (minimum daily rate should be ~£10+)`);
      }
      if (price.high > 500) {
        violations.push(`Suspiciously high daily price: £${price.high} (most items <£200/day)`);
      }
    }

    // Check for common pricing errors mentioned in the plan
    if (/Sony\s+GM\s+24-70/.test(text) || /24-70mm/.test(text)) {
      const lensPrice = extractedPrices.find(p => p.low >= 50 && p.high >= 50);
      if (lensPrice) {
        violations.push(
          `Sony 24-70mm lens pricing error: quoted £${lensPrice.low}-${lensPrice.high} but individual lens is ~£14-20/day (may be confusing with FX3+lens bundle)`,
        );
      }
    }

    return {
      passed: violations.length === 0,
      violations,
      severity: violations.length > 0 ? 'high' : 'low',
      blocked: false, // Don't block, but flag for review
    };
  }

  /**
   * Validator 5: Template Fidelity Checker
   * Ensures critical templates (welcome, booking confirmation) are followed
   */
  private async checkTemplateFidelity(
    text: string,
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const violations: string[] = [];

    // Detect if this should be a template response
    const isWelcomeMessage = context.responseType === 'welcome' ||
      /^(hi|hello|hey|good\s+(morning|afternoon|evening))/i.test(text);

    const isBookingConfirmation = context.responseType === 'booking_confirmed' ||
      /booking\s+(confirmed|accepted)/i.test(text);

    // Template checks (simplified - in production, use fuzzy matching)
    if (isBookingConfirmation) {
      const requiredElements = [
        { pattern: /pickup|collect(ion)?/i, name: 'pickup information' },
        { pattern: /Central\s+London|Trafalgar\s+Square/i, name: 'location' },
      ];

      for (const element of requiredElements) {
        if (!element.pattern.test(text)) {
          violations.push(`Booking confirmation missing required element: ${element.name}`);
        }
      }
    }

    return {
      passed: violations.length === 0,
      violations,
      severity: violations.length > 0 ? 'medium' : 'low',
      blocked: false,
    };
  }

  /**
   * Validator 6: Inventory Hallucination Detector
   * Validates mentioned items exist in master inventory
   */
  private async checkInventoryHallucination(text: string): Promise<ValidationResult> {
    const violations: string[] = [];

    const masterInventory = getInventoryItemNames();

    // Extract potential item mentions (capitalized phrases)
    const itemPattern = /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z0-9][A-Za-z0-9]*)*)\b/g;
    const mentions = [...new Set(text.match(itemPattern) || [])];

    for (const mention of mentions) {
      // Skip common words
      if (['Hi', 'Hello', 'Thanks', 'Sorry', 'Yes', 'No', 'I', 'The', 'London'].includes(mention)) {
        continue;
      }

      // Check if mentioned item matches any inventory item (fuzzy)
      const isInInventory = masterInventory.some(item =>
        item.toLowerCase().includes(mention.toLowerCase()) ||
        mention.toLowerCase().includes(item.toLowerCase())
      );

      // Only flag if it looks like camera equipment but isn't in inventory
      const looksLikeEquipment = /\b(camera|lens|mic|light|drone|battery|card|gimbal|monitor)\b/i.test(text);
      if (looksLikeEquipment && !isInInventory && mention.length > 4) {
        // Check if it's a specific model number or brand name
        if (/\d/.test(mention) || /^[A-Z]{2,}/.test(mention)) {
          violations.push(`Potential inventory hallucination: mentioned "${mention}" which may not be in stock`);
        }
      }
    }

    return {
      passed: violations.length === 0,
      violations,
      severity: violations.length > 0 ? 'medium' : 'low',
      blocked: false, // Don't block, but flag for review
    };
  }

  /**
   * Log validation result to database
   */
  private async logValidation(
    responseText: string,
    result: ValidationResult,
    aiDecisionId?: string,
  ): Promise<void> {
    try {
      await this.prisma.validation_log.create({
        data: {
          ai_decision_id: aiDecisionId,
          response_text: responseText.substring(0, 1000), // Truncate to avoid huge entries
          violations: result.violations,
          severity: result.severity,
          blocked: result.blocked,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to log validation: ${error.message}`);
    }
  }

  /**
   * Get validation statistics
   */
  async getValidationStats(days: number = 7): Promise<{
    totalValidations: number;
    passRate: number;
    blockRate: number;
    violationBreakdown: Record<string, number>;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const logs = await this.prisma.validation_log.findMany({
      where: { created_at: { gte: since } },
    });

    const totalValidations = logs.length;
    const passed = logs.filter(log => log.violations.length === 0).length;
    const blocked = logs.filter(log => log.blocked).length;

    const violationBreakdown: Record<string, number> = {};
    for (const log of logs) {
      for (const violation of log.violations) {
        const category = violation.split(':')[0]; // Extract category from violation message
        violationBreakdown[category] = (violationBreakdown[category] || 0) + 1;
      }
    }

    return {
      totalValidations,
      passRate: totalValidations > 0 ? passed / totalValidations : 1,
      blockRate: totalValidations > 0 ? blocked / totalValidations : 0,
      violationBreakdown,
    };
  }
}
