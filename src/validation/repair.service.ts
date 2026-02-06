import { Injectable, Logger } from '@nestjs/common';
import { ValidationResult } from './validation.service';

export interface RepairResult {
  repaired: boolean;
  content: string;
  repairs: string[];
}

@Injectable()
export class RepairService {
  private readonly logger = new Logger(RepairService.name);

  /**
   * Attempt deterministic regex-based repair of a blocked AI response.
   * Returns repaired content if fixable, or original if not.
   */
  attemptRepair(
    responseText: string,
    validation: ValidationResult,
    context?: { account?: string },
  ): RepairResult {
    let content = responseText;
    const repairs: string[] = [];

    for (const violation of validation.violations) {
      const repair = this.repairViolation(content, violation, context);
      if (repair) {
        content = repair.content;
        repairs.push(repair.description);
      }
    }

    return {
      repaired: repairs.length > 0,
      content,
      repairs,
    };
  }

  private repairViolation(
    text: string,
    violation: string,
    context?: { account?: string },
  ): { content: string; description: string } | null {
    // Email leak → mask
    if (violation.includes('Email address detected')) {
      const repaired = text.replace(
        /\b([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)@([A-Za-z0-9.-]+\.[A-Z|a-z]{2,})\b/g,
        (_, first, rest, domain) => `${first}${'*'.repeat(Math.min(rest.length, 5))}@${domain}`,
      );
      if (repaired !== text) {
        return { content: repaired, description: 'Masked email address' };
      }
    }

    // Phone number leak → mask
    if (violation.includes('Phone number detected')) {
      const repaired = text.replace(
        /\b((\+44\s?|0)(\d\s?){9,10})\b/g,
        (match) => {
          const digits = match.replace(/\D/g, '');
          return `${digits.slice(0, 3)}XX XXX ${digits.slice(-3)}`;
        },
      );
      if (repaired !== text) {
        return { content: repaired, description: 'Masked phone number' };
      }
    }

    // Address disclosure → replace with safe text
    if (violation.includes('address disclosed') || violation.includes('Exact pickup address')) {
      let repaired = text;
      // Replace specific known addresses
      repaired = repaired.replace(/11\s*Trafalgar\s*Square/gi, 'Central London (exact address shared after booking confirmed)');
      repaired = repaired.replace(/5\s*Pall\s*Mall\s*East/gi, 'Central London (exact address shared after booking confirmed)');
      repaired = repaired.replace(/WC2N\s*5DN/gi, 'Central London');
      repaired = repaired.replace(/SW1Y\s*5BF/gi, 'Central London');
      repaired = repaired.replace(/Statue\s*of\s*James\s*(II|the\s*Second)?/gi, 'Central London (Trafalgar Square area)');
      // Replace map links
      repaired = repaired.replace(/https?:\/\/maps\.[^\s)]+/gi, '[map link shared after booking confirmed]');
      // Generic address pattern: number + street name + postcode
      repaired = repaired.replace(
        /\b\d+\s+[A-Z][a-z]+\s+(Street|Road|Square|Mall)\b[^.]*\b[A-Z]{2}\d{1,2}\s*\d[A-Z]{2}\b/gi,
        'Central London (exact address shared after booking confirmed)',
      );
      if (repaired !== text) {
        return { content: repaired, description: 'Replaced address with safe location reference' };
      }
    }

    // Dual-account reference → remove offending sentence
    if (violation.includes('Dual-account') || violation.includes('Both account names')) {
      const sentences = text.split(/(?<=[.!?])\s+/);
      const cleaned = sentences.filter(s => {
        const hasBoth = /DB\s+Cinema/i.test(s) && /Leo\s+Adams/i.test(s);
        const hasConnection = /\b(same|shared|both|also|too|related|connected)\b/i.test(s);
        return !(hasBoth && hasConnection);
      });
      const repaired = cleaned.join(' ');
      if (repaired !== text) {
        return { content: repaired, description: 'Removed dual-account reference' };
      }
    }

    // API key / credential pattern → cannot safely repair, return null
    if (violation.includes('API key') || violation.includes('credential')) {
      return null; // Escalate — too risky to auto-fix
    }

    // Inventory hallucination → cannot auto-fix
    if (violation.includes('hallucination')) {
      return null; // Escalate
    }

    return null;
  }
}
