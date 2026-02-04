import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class SentryService {
  private readonly logger = new Logger(SentryService.name);

  /**
   * Capture an error with context
   */
  captureError(error: Error, context?: Record<string, any>) {
    this.logger.error(`Error captured: ${error.message}`, error.stack);

    Sentry.captureException(error, {
      extra: context,
    });
  }

  /**
   * Capture a message with severity level
   */
  captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info', context?: Record<string, any>) {
    Sentry.captureMessage(message, {
      level: level,
      extra: context,
    });
  }

  /**
   * Monitor quality score drops
   */
  monitorQualityScore(score: number, rentalId: string, context?: Record<string, any>) {
    if (score < 0.7) {
      this.logger.warn(`Low quality score detected: ${score} for rental ${rentalId}`);

      Sentry.captureMessage('Quality score below threshold', {
        level: 'warning',
        extra: {
          score,
          rental_id: rentalId,
          threshold: 0.7,
          ...context,
        },
      });
    }
  }

  /**
   * Monitor validation failures
   */
  monitorValidationFailure(validatorName: string, reason: string, context?: Record<string, any>) {
    this.logger.warn(`Validation failed: ${validatorName} - ${reason}`);

    Sentry.captureMessage('Validation failure', {
      level: 'warning',
      extra: {
        validator: validatorName,
        reason,
        ...context,
      },
    });
  }

  /**
   * Monitor API performance
   */
  monitorApiPerformance(operation: string, duration: number, context?: Record<string, any>) {
    // Alert if operation takes longer than 10 seconds
    if (duration > 10000) {
      this.logger.warn(`Slow API operation: ${operation} took ${duration}ms`);

      Sentry.captureMessage('Slow API operation', {
        level: 'warning',
        extra: {
          operation,
          duration_ms: duration,
          threshold_ms: 10000,
          ...context,
        },
      });
    }
  }

  /**
   * Track custom breadcrumb
   */
  addBreadcrumb(message: string, category: string, data?: Record<string, any>) {
    Sentry.addBreadcrumb({
      message,
      category,
      data,
      level: 'info',
      timestamp: Date.now() / 1000,
    });
  }

  /**
   * Set user context for tracking
   */
  setUserContext(rentalId: string, renterName?: string) {
    Sentry.setUser({
      id: rentalId,
      username: renterName,
    });
  }

  /**
   * Clear user context
   */
  clearUserContext() {
    Sentry.setUser(null);
  }

  /**
   * Add tags for filtering in Sentry
   */
  setTags(tags: Record<string, string>) {
    Sentry.setTags(tags);
  }
}
