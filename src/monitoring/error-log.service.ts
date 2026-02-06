import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ErrorLogService {
  private readonly logger = new Logger(ErrorLogService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Capture an error with context
   */
  captureError(error: Error, context?: Record<string, any>) {
    this.logger.error(`Error captured: ${error.message}`, error.stack);

    this.prisma.error_log
      .create({
        data: {
          error_type: 'exception',
          operation: context?.operation || 'unknown',
          message: error.message,
          stack_trace: error.stack,
          context: context || undefined,
        },
      })
      .catch((e) => this.logger.warn(`Failed to store error_log: ${e.message}`));
  }

  /**
   * Capture a message with severity level
   */
  captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info', context?: Record<string, any>) {
    const errorType = level === 'error' ? 'exception' : level === 'warning' ? 'quality_warning' : 'exception';

    this.prisma.error_log
      .create({
        data: {
          error_type: errorType,
          operation: context?.operation || 'unknown',
          message,
          context: context || undefined,
        },
      })
      .catch((e) => this.logger.warn(`Failed to store error_log: ${e.message}`));
  }

  /**
   * Monitor quality score drops
   */
  monitorQualityScore(score: number, rentalId: string, context?: Record<string, any>) {
    if (score < 0.7) {
      this.logger.warn(`Low quality score detected: ${score} for rental ${rentalId}`);

      this.prisma.error_log
        .create({
          data: {
            error_type: 'quality_warning',
            operation: 'quality_check',
            message: `Quality score below threshold: ${score}`,
            context: {
              score,
              rental_id: rentalId,
              threshold: 0.7,
              ...context,
            },
          },
        })
        .catch((e) => this.logger.warn(`Failed to store error_log: ${e.message}`));
    }
  }

  /**
   * Monitor validation failures
   */
  monitorValidationFailure(validatorName: string, reason: string, context?: Record<string, any>) {
    this.logger.warn(`Validation failed: ${validatorName} - ${reason}`);

    this.prisma.error_log
      .create({
        data: {
          error_type: 'validation_failure',
          operation: validatorName,
          message: reason,
          context: context || undefined,
        },
      })
      .catch((e) => this.logger.warn(`Failed to store error_log: ${e.message}`));
  }

  /**
   * Monitor API performance
   */
  monitorApiPerformance(operation: string, duration: number, context?: Record<string, any>) {
    if (duration > 10000) {
      this.logger.warn(`Slow API operation: ${operation} took ${duration}ms`);

      this.prisma.error_log
        .create({
          data: {
            error_type: 'slow_api',
            operation,
            message: `Slow API operation: ${duration}ms (threshold: 10000ms)`,
            context: {
              duration_ms: duration,
              threshold_ms: 10000,
              ...context,
            },
          },
        })
        .catch((e) => this.logger.warn(`Failed to store error_log: ${e.message}`));
    }
  }
}
