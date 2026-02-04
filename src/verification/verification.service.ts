import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RenterProfileService } from '../renter-profile/renter-profile.service';
import { PlaywrightService } from '../playwright/playwright.service';
import { TelegramService } from '../telegram/telegram.service';

type HyggloAccount = 'dbcinema' | 'leo';

export interface VerificationStatus {
  needsVerification: boolean;
  verificationComplete: boolean;
  method: 'api' | 'chat_activity' | 'playwright' | 'unknown';
}

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private prisma: PrismaService,
    private renterProfileService: RenterProfileService,
    private playwrightService: PlaywrightService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
  ) {}

  /**
   * Check verification status for an order.
   * Strategy: API data first -> chat activities -> Playwright fallback.
   */
  async checkVerificationStatus(
    orderId: string,
    account: HyggloAccount,
    orderDetail?: any,
  ): Promise<VerificationStatus> {
    // 1. Try API data from order detail
    if (orderDetail) {
      const apiResult = this.inspectOrderDetailForVerification(orderDetail);
      if (apiResult.needsVerification || apiResult.verificationComplete) {
        return apiResult;
      }
    }

    // 2. Try parsing system messages from chat activities
    if (orderDetail?.activities) {
      const chatResult = this.inspectChatActivitiesForVerification(orderDetail.activities);
      if (chatResult.needsVerification || chatResult.verificationComplete) {
        return chatResult;
      }
    }

    // 3. Last resort: Playwright browser scraping
    try {
      const playwrightResult = await this.playwrightService.readVerificationStatus(orderId, account);
      return {
        needsVerification: playwrightResult.needsVerification,
        verificationComplete: playwrightResult.verificationComplete,
        method: 'playwright',
      };
    } catch (error) {
      this.logger.debug(`Playwright verification check failed for ${orderId}: ${error.message}`);
    }

    return { needsVerification: false, verificationComplete: false, method: 'unknown' };
  }

  /**
   * Inspect order detail response for verification-related fields.
   */
  private inspectOrderDetailForVerification(detail: any): VerificationStatus {
    const result: VerificationStatus = {
      needsVerification: false,
      verificationComplete: false,
      method: 'api',
    };

    // Check status labels
    const status = detail.status?.toLowerCase?.() || '';
    const statusLabel = detail.statusLabel?.toLowerCase?.() || '';

    if (status.includes('verification') || statusLabel.includes('verification')) {
      result.needsVerification = true;
    }

    if (status === 'verified' || statusLabel.includes('verified')) {
      result.verificationComplete = true;
      result.needsVerification = false;
    }

    // Check for verification fields directly
    if (detail.verificationRequired === true) {
      result.needsVerification = true;
    }
    if (detail.verificationComplete === true || detail.verified === true) {
      result.verificationComplete = true;
      result.needsVerification = false;
    }

    // Check renter verification status
    const renterVerification = detail.users?.otherPart?.verified;
    if (renterVerification === true) {
      result.verificationComplete = true;
    } else if (renterVerification === false && detail.status === 'pending') {
      result.needsVerification = true;
    }

    return result;
  }

  /**
   * Inspect chat activities for verification-related system messages.
   */
  private inspectChatActivitiesForVerification(activities: any[]): VerificationStatus {
    const result: VerificationStatus = {
      needsVerification: false,
      verificationComplete: false,
      method: 'chat_activity',
    };

    if (!Array.isArray(activities)) return result;

    for (const activity of activities) {
      // System messages about verification
      const content = activity.chatMessage?.text?.content?.toLowerCase?.() || '';
      const type = activity.type?.toLowerCase?.() || '';
      const label = activity.label?.toLowerCase?.() || '';

      const allText = `${content} ${type} ${label}`;

      if (
        allText.includes('verification required') ||
        allText.includes('verify your identity') ||
        allText.includes('id verification') ||
        allText.includes('waiting for verification')
      ) {
        result.needsVerification = true;
      }

      if (
        allText.includes('verification complete') ||
        allText.includes('identity verified') ||
        allText.includes('has been verified')
      ) {
        result.verificationComplete = true;
        result.needsVerification = false;
      }
    }

    return result;
  }

  /**
   * Called during rental scanning to inspect order details for verification clues.
   * Updates the renter profile verification status accordingly.
   */
  async onOrderDetailReceived(
    orderId: string,
    detail: any,
    account: HyggloAccount,
    profileId?: string,
  ): Promise<VerificationStatus> {
    const status = await this.checkVerificationStatus(orderId, account, detail);

    if (profileId) {
      if (status.verificationComplete) {
        await this.renterProfileService.updateVerificationStatus(profileId, 'verified');
      } else if (status.needsVerification) {
        await this.renterProfileService.updateVerificationStatus(profileId, 'pending');
      }
    }

    return status;
  }

  /**
   * Rule 4: Send verification guidance to a renter (first time only per profile).
   * Returns the guidance message if it should be sent, null if already sent.
   */
  async handleVerificationNeeded(
    rental: any,
    renterProfileId: string,
  ): Promise<string | null> {
    const alreadyGuided = await this.renterProfileService.hasBeenSentVerificationGuidance(renterProfileId);

    if (alreadyGuided) {
      this.logger.debug(`Verification guidance already sent to profile ${renterProfileId}, skipping`);
      return null;
    }

    // Mark as guided
    await this.renterProfileService.markVerificationGuidanceSent(renterProfileId);

    const guidanceMessage =
      `Just a heads up - the platform requires identity verification before the rental can be confirmed. ` +
      `It's a quick process: you'll need to upload a photo of your ID (driving licence or passport) ` +
      `through the app. Once verified, I can accept the booking right away. ` +
      `Let me know if you need any help with it!`;

    // Notify Daniel
    await this.telegramService.sendProactiveMessage(
      `🔐 *Verification Guidance Sent*\n\n` +
      `├ 📦 ${rental.title}\n` +
      `├ 👤 ${rental.renter_info || 'Unknown'}\n` +
      `└ First-time guidance message queued`,
    );

    this.logger.log(`Verification guidance prepared for rental ${rental.title}`);
    return guidanceMessage;
  }

  /**
   * Rule 5: After 3+ verification failures, suggest alternatives.
   * Returns the failure guidance message if threshold reached, null otherwise.
   */
  async handleVerificationFailure(
    rental: any,
    renterProfileId: string,
  ): Promise<string | null> {
    const attemptCount = await this.renterProfileService.incrementVerificationAttempts(renterProfileId);

    if (attemptCount < 3) {
      this.logger.debug(`Verification attempt ${attemptCount} for profile ${renterProfileId}, threshold not reached`);
      return null;
    }

    // Check if we already sent failure guidance
    const alreadyGuided = await this.renterProfileService.hasBeenSentVerificationFailureGuidance(renterProfileId);
    if (alreadyGuided) {
      return null;
    }

    await this.renterProfileService.markVerificationFailureGuidanceSent(renterProfileId);
    await this.renterProfileService.updateVerificationStatus(renterProfileId, 'failed');

    const failureMessage =
      `I can see you're having trouble with the verification process - that can be frustrating. ` +
      `A few things that might help:\n` +
      `- Make sure the photo of your ID is clear and well-lit\n` +
      `- Try using a passport if your driving licence isn't working\n` +
      `- Contact the Hygglo/Fat Llama support team directly - they can sometimes verify manually\n\n` +
      `If it's still not working, feel free to get in touch with the platform's support and they'll sort it out.`;

    // Notify Daniel of persistent verification issue
    await this.telegramService.sendProactiveMessage(
      `⚠️ *Verification Failures (${attemptCount}x)*\n\n` +
      `├ 📦 ${rental.title}\n` +
      `├ 👤 ${rental.renter_info || 'Unknown'}\n` +
      `├ ❌ ${attemptCount} failed attempts\n` +
      `└ Suggested alternatives sent`,
    );

    this.logger.log(`Verification failure guidance prepared for rental ${rental.title} (${attemptCount} attempts)`);
    return failureMessage;
  }

  /**
   * Rule 8: Detect "on my way" type messages from renter.
   * Returns true if the message indicates the renter is heading to the pickup location.
   */
  detectOnMyWayMessage(message: string): boolean {
    const patterns = [
      /\bon\s+my\s+way\b/i,
      /\bcoming\s+now\b/i,
      /\bheading\s+(there|over|to\s+you)\b/i,
      /\bomw\b/i,
      /\bon\s+the\s+way\b/i,
      /\bnearly\s+there\b/i,
      /\balmost\s+there\b/i,
      /\bheading\s+to\s+trafalgar\b/i,
      /\bheading\s+to\s+pall\s+mall\b/i,
      /\bcoming\s+to\s+(pick|collect)\b/i,
      /\bleaving\s+now\b/i,
      /\bsetting\s+off\b/i,
      /\bon\s+route\b/i,
      /\ben\s+route\b/i,
      /\bbe\s+there\s+(in|soon)\b/i,
      /\b(5|10|15|20|30)\s+min(ute)?s?\s+away\b/i,
    ];

    return patterns.some((pattern) => pattern.test(message));
  }

  /**
   * Rule 8: Handle "on my way" message when verification is incomplete.
   * Returns a warning message to send to the renter, or null if verification is done.
   */
  async handleOnMyWayDuringVerification(
    rental: any,
    renterProfileId: string,
  ): Promise<string | null> {
    const profile = await this.renterProfileService.getProfile(renterProfileId);
    if (!profile) return null;

    // If verified, no need to block
    if (profile.verification_status === 'verified') {
      return null;
    }

    // If unknown, we can't confirm so we err on the side of caution
    if (profile.verification_status === 'unknown') {
      // Don't block if we don't know - just log
      this.logger.debug(`On-my-way detected but verification status unknown for ${rental.title}`);
      return null;
    }

    // Verification is pending or failed - block handover
    const warningMessage =
      `Hold on - before we can do the handover, the platform verification needs to be completed first. ` +
      `Without it, there's no insurance cover for either of us and I won't be able to hand over the gear. ` +
      `Can you check your app and complete the verification? Once it's done, we're good to go!`;

    // Urgent notification to Daniel
    await this.telegramService.sendProactiveMessage(
      `🚨 *ON MY WAY - VERIFICATION INCOMPLETE*\n\n` +
      `├ 📦 ${rental.title}\n` +
      `├ 👤 ${rental.renter_info || 'Unknown'}\n` +
      `├ 🔐 Status: ${profile.verification_status}\n` +
      `└ ⛔ Renter says they're coming but not verified!\n\n` +
      `_Handover block message queued_`,
    );

    this.logger.warn(`On-my-way during verification: ${rental.title} (status: ${profile.verification_status})`);
    return warningMessage;
  }
}
