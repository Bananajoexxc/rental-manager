import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RenterProfileService } from '../renter-profile/renter-profile.service';
import { PlaywrightService } from '../playwright/playwright.service';
import { TelegramService } from '../telegram/telegram.service';
import { HyggloService } from '../hygglo/hygglo.service';

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
    private hyggloService: HyggloService,
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
   * The v4 API uses a `steps` array where each step has {key, completed, active}.
   * Steps: REQUEST → APPROVED → FUNDS_RESERVED → VERIFIED → BOOKED_AFTER_VERIFIED → ...
   * If VERIFIED step is active=true, renter is being verified.
   * If BOOKED_AFTER_VERIFIED (or later) is completed, verification passed.
   */
  private inspectOrderDetailForVerification(detail: any): VerificationStatus {
    const result: VerificationStatus = {
      needsVerification: false,
      verificationComplete: false,
      method: 'api',
    };

    // Primary signal: steps array from Hygglo v4 API
    if (Array.isArray(detail.steps)) {
      const verifiedStep = detail.steps.find((s: any) => s.key === 'VERIFIED');
      const bookedStep = detail.steps.find((s: any) => s.key === 'BOOKED_AFTER_VERIFIED');

      if (verifiedStep?.active === true && verifiedStep?.completed === false) {
        result.needsVerification = true;
      }
      if (verifiedStep?.completed === true || bookedStep?.completed === true) {
        result.verificationComplete = true;
        result.needsVerification = false;
      }
    }

    // Fallback: labels.orderStatus.header
    const header = (detail.labels?.orderStatus?.header || '').toLowerCase();
    if (!result.needsVerification && !result.verificationComplete) {
      if (header.includes('waiting') && header.includes('document')) {
        result.needsVerification = true;
      } else if (header.includes('booked and ready') || header.includes('everything is booked')) {
        result.verificationComplete = true;
      }
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
      // Read previous verification status before updating
      let previousStatus: string | undefined;
      try {
        const profile = await this.renterProfileService.getProfile(profileId);
        previousStatus = profile?.verification_status;
      } catch {
        // Profile may not exist
      }

      if (status.verificationComplete) {
        await this.renterProfileService.updateVerificationStatus(profileId, 'verified');

        // Trigger post-verification auto-send if this is a new transition
        if (previousStatus && previousStatus !== 'verified') {
          try {
            await this.onVerificationTransition(orderId, profileId, account);
          } catch (transErr) {
            this.logger.warn(`Post-verification transition failed: ${transErr.message}`);
          }
        }
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

    // Calculate urgency based on rental start date
    let urgencyPrefix = '';
    if (rental.start_date) {
      const hoursUntilStart = (new Date(rental.start_date).getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntilStart > 0 && hoursUntilStart <= 24) {
        urgencyPrefix = 'Your rental starts tomorrow — verification is needed before we can hand over gear. ';
      } else if (hoursUntilStart > 0 && hoursUntilStart <= 48) {
        urgencyPrefix = 'Since your rental is coming up soon, best to complete verification now so we don\'t run into any delays. ';
      }
    }

    const rentalDates = rental.start_date
      ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
      : 'your dates';

    const guidanceMessage =
      `${urgencyPrefix}Just a heads up — the platform requires identity verification before the rental can go through. ` +
      `This usually takes a few minutes but can sometimes take longer depending on the checks needed. ` +
      `To keep things moving smoothly, best to get it done now:\n` +
      `1. Open the Hygglo app\n` +
      `2. Upload a clear photo of your driving licence or passport\n` +
      `3. Follow the prompts — it's usually quick\n\n` +
      `Once verified, I can confirm the booking straight away. ` +
      `The sooner you complete it, the sooner we can lock everything in for ${rentalDates}. ` +
      `Let me know if you hit any issues!`;

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
    // Guard: only increment if the renter profile shows an actual verification failure
    // (status must be 'failed' or 'pending' with evidence of a failed check).
    // This prevents the counter from ticking up on every processMessage call.
    const profile = await this.renterProfileService.getProfile(renterProfileId);
    if (!profile || (profile.verification_status !== 'failed' && profile.verification_status !== 'pending')) {
      return null;
    }

    // Check if we already sent failure guidance — skip increment to avoid pointless counter inflation
    const alreadyGuided = await this.renterProfileService.hasBeenSentVerificationFailureGuidance(renterProfileId);
    if (alreadyGuided) {
      return null;
    }

    const attemptCount = await this.renterProfileService.incrementVerificationAttempts(renterProfileId);

    if (attemptCount < 2) {
      this.logger.debug(`Verification attempt ${attemptCount} for profile ${renterProfileId}, threshold not reached`);
      return null;
    }

    await this.renterProfileService.markVerificationFailureGuidanceSent(renterProfileId);
    await this.renterProfileService.updateVerificationStatus(renterProfileId, 'failed');

    const failureMessage =
      `I can see you're having trouble with the verification process - that can be frustrating. ` +
      `A few things that might help:\n` +
      `- Make sure the photo of your ID is clear and well-lit\n` +
      `- Try using a passport if your driving licence isn't working\n` +
      `- Contact the Hygglo/Fat Llama support team directly - they can sometimes verify manually\n` +
      `- Alternatively, if you have a friend with a verified account (or one with the right documentation), they could place the rental request from their account instead - just have them mention in the chat that it's a continuation of your request so we know it's linked\n\n` +
      `If it's still not working, feel free to get in touch with the platform's support and they'll sort it out.`;

    // Notify Daniel of persistent verification issue
    await this.telegramService.sendRentalUpdate(rental.id, {
      type: 'verification_failure', priority: 'normal',
      data: { attemptCount },
    }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });

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
    await this.telegramService.sendRentalUpdate(rental.id, {
      type: 'info', priority: 'high',
      data: { text: `ON MY WAY but not verified (${profile.verification_status}) — handover blocked` },
    }, { rentalTitle: rental.title, renterName: rental.renter_info, account: rental.account });

    this.logger.warn(`On-my-way during verification: ${rental.title} (status: ${profile.verification_status})`);
    return warningMessage;
  }

  /**
   * Called when a renter transitions from non-verified to verified.
   * Sends booking info message and notifies Daniel with final summary.
   */
  async onVerificationTransition(
    orderId: string,
    profileId: string,
    account: HyggloAccount,
  ): Promise<void> {
    // Find rental by listing_id
    const rental = await this.prisma.rental.findFirst({
      where: { listing_id: orderId },
    });
    if (!rental) {
      this.logger.debug(`onVerificationTransition: no rental found for order ${orderId}`);
      return;
    }

    // Check if already sent (idempotency via ai_decision marker)
    const alreadySent = await this.prisma.ai_decision.findFirst({
      where: {
        rental_id: rental.id,
        input_summary: { contains: 'post_verification_auto_send' },
      },
    });
    if (alreadySent) {
      this.logger.debug(`Post-verification message already sent for rental ${rental.id}`);
      return;
    }

    // Get booking times
    const bookings = await this.prisma.booking.findMany({
      where: { rental_id: rental.id },
      take: 1,
    });
    const booking = bookings.length > 0 ? bookings[0] : null;

    const startDate = rental.start_date ? new Date(rental.start_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'TBC';
    const endDate = rental.end_date ? new Date(rental.end_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'TBC';
    const pickupTime = booking?.pickup_time || 'TBC';
    const returnTime = booking?.return_time || 'TBC';

    // Build info message
    const infoMessage =
      `Great news - your verification is complete and the booking is confirmed!\n\n` +
      `Here are the details:\n` +
      `- Dates: ${startDate} to ${endDate}\n` +
      `- Pickup time: ${pickupTime}\n` +
      `- Return time: ${returnTime}\n` +
      `- Location: Trafalgar Square area (exact address sent on the day)\n\n` +
      `A few things to note:\n` +
      `- Have your booking reference number ready for the handover\n` +
      `- Equipment should be returned in the same condition\n` +
      `- Please handle all gear with care\n\n` +
      `Let me know if you have any questions!`;

    // Send via Hygglo (sendMessage handles READ_ONLY_MODE with per-rental exceptions)
    try {
      await this.hyggloService.sendMessage(orderId, infoMessage);
    } catch (sendErr) {
      this.logger.warn(`Failed to send post-verification message: ${sendErr.message}`);
    }

    // Store ai_decision as idempotency marker
    await this.prisma.ai_decision.create({
      data: {
        rental_id: rental.id,
        decision_type: 'message',
        input_summary: `post_verification_auto_send for ${rental.title}`,
        output_summary: `Sent booking info after verification: ${infoMessage.substring(0, 300)}`,
        confidence: 1.0,
        action_taken: 'Post-verification info message sent',
        notified: true,
      },
    });

    // Extract renter notes from chat if times are confirmed
    if (booking?.pickup_time && booking?.return_time) {
      try {
        const chatMessages = await this.hyggloService.readMessages(orderId, account);
        const chatText = chatMessages.map(m => `${m.sender}: ${m.content}`).join('\n');
        const renterNotes = this.extractRenterNotesFromChat(chatText);
        if (renterNotes && profileId) {
          await this.renterProfileService.updateProgress(profileId, {
            rental_progress: renterNotes.substring(0, 1000),
          });
        }
      } catch (notesErr) {
        this.logger.debug(`Renter notes extraction failed: ${notesErr.message}`);
      }
    }

    this.logger.log(`Post-verification transition handled for ${rental.title}`);
  }

  /**
   * Extract renter notes from chat text using regex pattern matching.
   * Looks for project types, accessory requests, timing preferences, care requests.
   */
  private extractRenterNotesFromChat(chatText: string): string {
    const notes: string[] = [];

    const patterns: { pattern: RegExp; label: string }[] = [
      { pattern: /\b(wedding|music\s+video|short\s+film|feature\s+film|documentary|corporate|commercial|interview|event|production|photo\s*shoot)\b/i, label: 'project' },
      { pattern: /\b(tripod|case|bag|batteries|memory\s+card|sd\s+card|charger|adapter|lens|filter|monitor|mic|microphone|light|lighting)\b/i, label: 'accessory' },
      { pattern: /\b(careful|fragile|heavy|delicate|rain|weather|outdoor|travel|abroad|overseas|flight)\b/i, label: 'care' },
      { pattern: /\b(first\s+time|never\s+used|new\s+to|beginner)\b/i, label: 'experience' },
      { pattern: /\b(early\s+morning|late\s+evening|overnight|next\s+day|rush|urgent|asap)\b/i, label: 'timing' },
    ];

    for (const { pattern, label } of patterns) {
      const match = chatText.match(pattern);
      if (match) {
        notes.push(`${label}: ${match[0].trim()}`);
      }
    }

    return notes.join(' | ');
  }
}
