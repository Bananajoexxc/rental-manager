import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Conversation stages - progressive funnel toward booking (6 active + DEAD + COMPLETED)
 */
export enum ConversationStage {
  INQUIRY = 'inquiry',           // Initial contact, browsing
  INTERESTED = 'interested',     // Showed intent — asked about availability/price/dates
  READY_TO_BOOK = 'ready_to_book', // Price/dates/availability all confirmed, ready to close
  BOOKED = 'booked',             // Booking request sent, verification pending, in progress
  CONFIRMED = 'confirmed',       // Booking verified and accepted
  COMPLETED = 'completed',       // Rental finished (end_date passed)
  DEAD = 'dead',                 // Conversation went cold or renter declined
}

/** Ordered stage progression — single source of truth for all stage comparisons */
export const STAGE_ORDER: ConversationStage[] = [
  ConversationStage.INQUIRY,
  ConversationStage.INTERESTED,
  ConversationStage.READY_TO_BOOK,
  ConversationStage.BOOKED,
  ConversationStage.CONFIRMED,
  ConversationStage.COMPLETED,
];

/** Actions that can be stage-gated */
export type StageActionType =
  | 'upsell_low_value'          // profit < £30 → upsell before other context
  | 'renter_notes'              // extract project type, special requests
  | 'verification_guidance'     // send verification help to renter
  | 'delivery_tcs'              // send delivery T&Cs
  | 'time_extraction_tentative' // regex-only time tracking (no AI call)
  | 'time_extraction_full'      // full extraction + proactive request + validation
  | 'time_followup'             // follow up on missing times
  | 'time_context'              // add "ACTION NEEDED: times" to AI context
  | 'auto_assign_times';        // cron: auto-assign missing times

export interface StageAction {
  type: StageActionType;
  priority: number;   // lower = runs first (0 = highest priority)
  enabled: boolean;   // allowed at current stage
}

/**
 * Stage action map — defines which actions are allowed at each stage and their priority.
 * Priority determines prompt injection order (0 = first/most prominent).
 *
 * Design principles:
 *   - Upsell (p:0) always fires first when enabled — profit < £30 must be addressed before anything else
 *   - Time extraction full (p:1) is high priority at CONFIRMED — logistics are critical
 *   - Verification guidance (p:3) fires after interest shown, never on first message
 *   - Delivery T&Cs (p:4) only after ready_to_book — don't discuss logistics prematurely
 *   - Renter notes (p:5) only early stages — project type matters upfront, not after booking
 *   - Tentative time tracking (p:6) runs passively mid-funnel
 */
const STAGE_ACTION_MAP: Record<string, Partial<Record<StageActionType, number>>> = {
  // Stage → { actionType → priority } (presence = enabled)
  [ConversationStage.INQUIRY]: {
    upsell_low_value: 0,
    renter_notes: 5,
  },
  [ConversationStage.INTERESTED]: {
    upsell_low_value: 0,
    renter_notes: 5,
    verification_guidance: 3,
    time_extraction_tentative: 6,
  },
  [ConversationStage.READY_TO_BOOK]: {
    upsell_low_value: 0,
    verification_guidance: 3,
    delivery_tcs: 4,
    time_extraction_tentative: 6,
  },
  [ConversationStage.BOOKED]: {
    verification_guidance: 3,
    delivery_tcs: 4,
    time_extraction_tentative: 6,
  },
  [ConversationStage.CONFIRMED]: {
    time_extraction_full: 1,
    time_followup: 2,
    time_context: 2,
    delivery_tcs: 4,
    auto_assign_times: 7,
  },
  [ConversationStage.COMPLETED]: {},
  [ConversationStage.DEAD]: {},
};

/**
 * Stage metadata - objectives and transitions
 */
interface StageDefinition {
  stage: ConversationStage;
  objective: string;
  nextSteps: string[];
  transitionTriggers: string[];
  prompt: string;
}

/**
 * Conversation state tracking
 */
export interface ConversationState {
  rentalId: string;
  currentStage: ConversationStage;
  previousStage?: ConversationStage;
  stageEnteredAt: Date;
  itemsDiscussed: string[];
  priceQuoted: boolean;
  datesDiscussed: boolean;
  availabilityConfirmed: boolean;
  deliveryDiscussed: boolean;
  lastMessageAt: Date;
  messageCount: number;
}

@Injectable()
export class ConversationStageService {
  private readonly logger = new Logger(ConversationStageService.name);
  private stageDefinitions: Map<ConversationStage, StageDefinition>;

  constructor(private prisma: PrismaService) {
    this.initializeStageDefinitions();
  }

  /**
   * Initialize stage definitions - sales funnel logic
   */
  private initializeStageDefinitions() {
    this.stageDefinitions = new Map([
      [
        ConversationStage.INQUIRY,
        {
          stage: ConversationStage.INQUIRY,
          objective: 'Understand what they need and confirm availability',
          nextSteps: [
            'Confirm item availability',
            'Ask what they\'re shooting',
            'Mention dates',
          ],
          transitionTriggers: [
            'asks about availability',
            'asks about price',
            'mentions dates',
          ],
          prompt: `STAGE: Initial Inquiry
OBJECTIVE: Understand what they need. Confirm availability fast.
NEXT STEP: Mention availability, ask what they're shooting.
Keep it conversational. Don't overwhelm with info.`,
        },
      ],
      [
        ConversationStage.INTERESTED,
        {
          stage: ConversationStage.INTERESTED,
          objective: 'Lock in dates and price — they\'re showing intent',
          nextSteps: [
            'Give clear pricing (single day + multi-day discount)',
            'Confirm specific dates',
            'Mention any relevant bundles',
          ],
          transitionTriggers: [
            'accepts price',
            'provides dates',
            'asks about booking process',
          ],
          prompt: `STAGE: Interested
OBJECTIVE: Lock in dates and price. They're showing intent.
NEXT STEP: Quote pricing, confirm dates, mention bundles if relevant.
Be assumptive: "Cool, [item] for [dates] — I'll hold that for you."`,
        },
      ],
      [
        ConversationStage.READY_TO_BOOK,
        {
          stage: ConversationStage.READY_TO_BOOK,
          objective: 'Close the deal — all details are confirmed',
          nextSteps: [
            'Direct ask to send booking request on Hygglo',
            'Handle final questions',
          ],
          transitionTriggers: [
            'says "sounds good"',
            'asks how to book',
            'no more questions',
          ],
          prompt: `STAGE: Ready to Book
OBJECTIVE: Close the deal. All details are confirmed.
NEXT STEP: Direct ask to send booking request on Hygglo.
"Go ahead and hit the booking button — I'll confirm within the hour."
If stalling: "Got another inquiry for that day, best to lock it in."`,
        },
      ],
      [
        ConversationStage.BOOKED,
        {
          stage: ConversationStage.BOOKED,
          objective: 'Guide through to confirmation — booking is in progress',
          nextSteps: [
            'Guide through verification if needed',
            'Confirm booking details',
          ],
          transitionTriggers: ['booking request received', 'verification complete'],
          prompt: `STAGE: Booking in Progress
OBJECTIVE: Guide through to confirmation. Booking request is in, may need verification.
NEXT STEP: If verification pending, guide them through it proactively.
"The platform needs a quick ID check before we can confirm — driving licence or
passport photo through the app, usually takes just a few minutes.
The sooner it's done, the sooner everything's locked in for your dates."
Don't discuss pickup details until verification is complete.
NOTE: Items in "BOOKED ITEMS FOR THIS RENTAL" are being held for this renter. Do NOT tell them these items are unavailable.`,
        },
      ],
      [
        ConversationStage.CONFIRMED,
        {
          stage: ConversationStage.CONFIRMED,
          objective: 'Great service — confirm times, handle logistics',
          nextSteps: [
            'Get exact pickup/return times if not yet confirmed',
            'Answer logistics questions',
            'Ensure smooth handoff',
          ],
          transitionTriggers: [],
          prompt: `STAGE: Confirmed Booking
OBJECTIVE: Great service. Confirm times, handle logistics.
CRITICAL: This booking is CONFIRMED. All items listed under "BOOKED ITEMS FOR THIS RENTAL" are RESERVED for this renter. Do NOT say any of these items are "booked", "out of stock", or "unavailable" — they ARE this renter's gear.
NEXT STEP: Get exact pickup/return times if not yet confirmed.
ARRIVAL RULE: When the renter says they've arrived / they're here / they're at the pickup point — ALWAYS reply that you'll be there in about 5 minutes (e.g. "Perfect, be with you in about 5 mins!" or "On my way, 5 minutes!"). NEVER say you are already there or at the location. Daniel needs time to get to the meeting point.
EARLY/UNSCHEDULED ARRIVAL: If the renter wants to come EARLIER than scheduled, on short notice, or at a different time than agreed (e.g. "finished early, can I come in 15 mins?", "can we do it now instead?") — NEVER just accept. Say "let me just check I can make that work — give me a moment" and escalate to Daniel. Only confirm after Daniel approves. This applies to ANY unscheduled time change, not just off-hours.
Be helpful and responsive — this is where repeat business is built.`,
        },
      ],
      [
        ConversationStage.COMPLETED,
        {
          stage: ConversationStage.COMPLETED,
          objective: 'Rental is finished',
          nextSteps: [],
          transitionTriggers: [],
          prompt: `STAGE: Completed
OBJECTIVE: Rental is finished. Only respond if they have questions about past rental.
Don't upsell or follow up — they're done.
RETURN CLOSURE: If the renter asks to mark the rental as returned or close it, explain that the equipment is still being inspected and we usually close open rentals within 24–72 hours after return, though in rare edge cases it may take a bit longer. Reassure them it's routine.`,
        },
      ],
      [
        ConversationStage.DEAD,
        {
          stage: ConversationStage.DEAD,
          objective: 'Conversation went cold',
          nextSteps: [],
          transitionTriggers: [],
          prompt: `STAGE: Dead Conversation
The renter went quiet after 3+ follow-ups or explicitly declined.
If they come back, welcome them warmly and pick up where you left off.
Don't reference the silence or sound disappointed.`,
        },
      ],
    ]);
  }

  /**
   * Get conversation state from database.
   * Uses DB-persisted stage when available; falls back to inference only for first-time setup.
   */
  async getConversationState(rentalId: string): Promise<ConversationState | null> {
    const rental = await this.prisma.rental.findUnique({
      where: { id: rentalId },
    });

    if (!rental) return null;

    // Check for persisted stage in follow_up_state
    const followUpState = await this.prisma.follow_up_state.findUnique({
      where: { rental_id: rentalId },
    });

    // Get conversation history for context attributes
    const history = await this.prisma.conversation.findMany({
      where: { chat_id: `rental:${rentalId}` },
      orderBy: { created_at: 'asc' },
    });

    if (history.length === 0) {
      return {
        rentalId,
        currentStage: ConversationStage.INQUIRY,
        stageEnteredAt: new Date(),
        itemsDiscussed: [],
        priceQuoted: false,
        datesDiscussed: false,
        availabilityConfirmed: false,
        deliveryDiscussed: false,
        lastMessageAt: new Date(),
        messageCount: 0,
      };
    }

    const messages = history.map(h => h.content.toLowerCase());
    const fullConversation = messages.join(' ');
    // Renter-only messages for interest signals (avoids bot's own "available" triggering stage advances)
    const renterMessages = history.filter(h => h.role === 'user').map(h => h.content.toLowerCase());
    const renterConversation = renterMessages.join(' ');

    const state: ConversationState = {
      rentalId,
      currentStage: ConversationStage.INQUIRY,
      stageEnteredAt: followUpState?.stage_changed_at || history[0].created_at,
      itemsDiscussed: this.extractItems(fullConversation),
      priceQuoted: /£\d+|price|cost|how much/.test(renterConversation),
      datesDiscussed: /\d{4}-\d{2}-\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week/.test(renterConversation),
      availabilityConfirmed: /available|free|yes.*can|got it/.test(renterConversation),
      deliveryDiscussed: /deliver|courier|postcode/.test(fullConversation),
      lastMessageAt: history[history.length - 1].created_at,
      messageCount: history.length,
    };

    // Use DB-persisted stage if available; otherwise infer once and persist
    if (followUpState?.conversation_stage) {
      const dbStage = followUpState.conversation_stage as ConversationStage;
      if (Object.values(ConversationStage).includes(dbStage)) {
        state.currentStage = dbStage;

        // Override with rental status — persist to DB so dashboard funnel stays in sync
        if ((rental.status === 'ongoing' || rental.status === 'upcoming') &&
            dbStage !== ConversationStage.CONFIRMED) {
          state.currentStage = ConversationStage.CONFIRMED;
          await this.persistStage(rentalId, ConversationStage.CONFIRMED);
          this.logger.log(`Stage ${dbStage} → CONFIRMED (rental status: ${rental.status}) for ${rentalId} [getConversationState sync]`);
        } else if (rental.end_date && new Date(rental.end_date) < new Date() &&
                   ['completed', 'ongoing'].includes(rental.status) &&
                   dbStage !== ConversationStage.COMPLETED) {
          state.currentStage = ConversationStage.COMPLETED;
          await this.persistStage(rentalId, ConversationStage.COMPLETED);
          this.logger.log(`Stage ${dbStage} → COMPLETED (rental finished) for ${rentalId} [getConversationState sync]`);
        } else if (['cancelled', 'obsolete'].includes(rental.status) &&
                   dbStage !== ConversationStage.DEAD) {
          state.currentStage = ConversationStage.DEAD;
          await this.persistStage(rentalId, ConversationStage.DEAD);
          this.logger.log(`Stage ${dbStage} → DEAD (rental ${rental.status}) for ${rentalId} [getConversationState sync]`);
        }

        return state;
      }
    }

    // First-time: infer stage and persist it
    state.currentStage = this.inferStage(state, rental, fullConversation);
    await this.persistStage(rentalId, state.currentStage);

    return state;
  }

  /**
   * Persist stage to DB via follow_up_state.
   * When transitioning to DEAD, stores the previous stage for smart revival.
   */
  private async persistStage(rentalId: string, stage: ConversationStage): Promise<void> {
    try {
      // If going to DEAD, capture the current stage so we can restore it on revival
      const updateData: any = { conversation_stage: stage, stage_changed_at: new Date() };
      if (stage === ConversationStage.DEAD) {
        const existing = await this.prisma.follow_up_state.findUnique({
          where: { rental_id: rentalId },
          select: { conversation_stage: true },
        });
        if (existing && existing.conversation_stage !== 'dead') {
          updateData.stage_before_dead = existing.conversation_stage;
        }
      }

      await this.prisma.follow_up_state.upsert({
        where: { rental_id: rentalId },
        update: updateData,
        create: {
          rental_id: rentalId,
          conversation_stage: stage,
          stage_changed_at: new Date(),
          status: 'active',
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to persist stage for ${rentalId}: ${err.message}`);
    }
  }

  /**
   * Infer conversation stage from state (used for first-time setup only)
   */
  private inferStage(
    state: ConversationState,
    rental: any,
    conversationText: string,
  ): ConversationStage {
    // Completed: rental end_date in the past
    if (rental.end_date && new Date(rental.end_date) < new Date() &&
        ['completed', 'ongoing'].includes(rental.status)) {
      return ConversationStage.COMPLETED;
    }

    // Check for confirmed booking
    if (rental.status === 'ongoing' || rental.status === 'upcoming') {
      return ConversationStage.CONFIRMED;
    }

    // Check for dead conversation (24+ hours since last message after showing interest)
    const hoursSinceLastMessage = (Date.now() - state.lastMessageAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastMessage > 24 && state.messageCount > 2 && state.priceQuoted) {
      return ConversationStage.DEAD;
    }

    // Check for booking in progress (request sent, verification pending)
    const bookingMentioned = /booking.*request|sent.*request|request.*sent|booking.*sent/.test(conversationText);
    const verificationMentioned = /\b(verification|verify|id check|identity)\b/.test(conversationText) &&
        /\b(required|needed|pending|waiting|upload)\b/.test(conversationText);
    if (bookingMentioned || verificationMentioned) {
      return ConversationStage.BOOKED;
    }

    // Check for ready to book (all info gathered, should close)
    const affirmative = /sounds good|perfect|great|ok|yes|sure|fine|works|deal|let'?s do|i'?ll take|book|go ahead/.test(conversationText);
    if (
      state.availabilityConfirmed &&
      state.priceQuoted &&
      state.datesDiscussed &&
      affirmative
    ) {
      return ConversationStage.READY_TO_BOOK;
    }

    // Check for interested (showed strong intent, discussed details)
    if (
      state.priceQuoted ||
      state.datesDiscussed ||
      state.availabilityConfirmed ||
      /available|price|cost|book|rent|hire/.test(conversationText)
    ) {
      return ConversationStage.INTERESTED;
    }

    // Default to inquiry
    return ConversationStage.INQUIRY;
  }

  /**
   * Get stage-specific prompt to guide AI
   */
  async getStagePrompt(rentalId: string): Promise<string> {
    const state = await this.getConversationState(rentalId);
    if (!state) return '';

    const definition = this.stageDefinitions.get(state.currentStage);
    if (!definition) return '';

    let prompt = `\n\n--- CONVERSATION STAGE GUIDANCE ---\n`;
    prompt += definition.prompt;
    prompt += `\n\nCONTEXT:\n`;
    prompt += `- Items discussed: ${state.itemsDiscussed.join(', ') || 'none yet'}\n`;
    prompt += `- Price quoted: ${state.priceQuoted ? 'Yes' : 'No'}\n`;
    prompt += `- Dates discussed: ${state.datesDiscussed ? 'Yes' : 'No'}\n`;
    prompt += `- Availability confirmed: ${state.availabilityConfirmed ? 'Yes' : 'No'}\n`;
    prompt += `- Message count: ${state.messageCount}\n`;
    prompt += `\nYour response should naturally move the conversation toward: ${definition.nextSteps[0] || 'wrapping up'}`;

    return prompt;
  }

  /**
   * Build stage prompt from an already-loaded ConversationState (no DB call).
   * Use this when you already have the state from getConversationState().
   */
  getStagePromptFromState(state: ConversationState): string {
    const definition = this.stageDefinitions.get(state.currentStage);
    if (!definition) return '';

    let prompt = `\n\n--- CONVERSATION STAGE GUIDANCE ---\n`;
    prompt += definition.prompt;
    prompt += `\n\nCONTEXT:\n`;
    prompt += `- Items discussed: ${state.itemsDiscussed.join(', ') || 'none yet'}\n`;
    prompt += `- Price quoted: ${state.priceQuoted ? 'Yes' : 'No'}\n`;
    prompt += `- Dates discussed: ${state.datesDiscussed ? 'Yes' : 'No'}\n`;
    prompt += `- Availability confirmed: ${state.availabilityConfirmed ? 'Yes' : 'No'}\n`;
    prompt += `- Message count: ${state.messageCount}\n`;
    prompt += `\nYour response should naturally move the conversation toward: ${definition.nextSteps[0] || 'wrapping up'}`;

    return prompt;
  }

  /**
   * Check if stage should transition based on latest message.
   * When a transition occurs, the new stage is persisted to DB.
   */
  async checkStageTransition(
    rentalId: string,
    latestMessage: string,
  ): Promise<{ shouldTransition: boolean; newStage?: ConversationStage; reason?: string }> {
    // Delegate to reassessStage which evaluates full context
    return this.reassessStage(rentalId);
  }

  /**
   * Reassess conversation stage based on full context.
   * Unlike the old single-step keyword approach, this evaluates the entire conversation
   * and jumps directly to the correct stage. Called after each message processing.
   */
  async reassessStage(
    rentalId: string,
  ): Promise<{ shouldTransition: boolean; newStage?: ConversationStage; reason?: string }> {
    const rental = await this.prisma.rental.findUnique({ where: { id: rentalId } });
    if (!rental) return { shouldTransition: false };

    const followUpState = await this.prisma.follow_up_state.findUnique({
      where: { rental_id: rentalId },
    });

    const currentStage = (followUpState?.conversation_stage || ConversationStage.INQUIRY) as ConversationStage;

    // --- Terminal state: COMPLETED — rental end_date passed ---
    if (rental.end_date && new Date(rental.end_date) < new Date() &&
        ['completed', 'ongoing'].includes(rental.status)) {
      if (currentStage !== ConversationStage.COMPLETED) {
        await this.persistStage(rentalId, ConversationStage.COMPLETED);
        this.logger.log(`Stage ${currentStage} → COMPLETED (rental finished) for ${rentalId}`);
        return { shouldTransition: true, newStage: ConversationStage.COMPLETED, reason: 'Rental finished' };
      }
      return { shouldTransition: false };
    }

    // --- Terminal state: rental accepted on Hygglo → CONFIRMED ---
    if (['ongoing', 'upcoming'].includes(rental.status)) {
      if (currentStage !== ConversationStage.CONFIRMED) {
        await this.persistStage(rentalId, ConversationStage.CONFIRMED);
        this.logger.log(`Stage ${currentStage} → CONFIRMED (rental status: ${rental.status}) for ${rentalId}`);
        return { shouldTransition: true, newStage: ConversationStage.CONFIRMED, reason: `Rental status: ${rental.status}` };
      }
      return { shouldTransition: false };
    }

    // --- Dead detection: rental cancelled/obsolete ---
    if (['cancelled', 'obsolete'].includes(rental.status)) {
      if (currentStage !== ConversationStage.DEAD) {
        await this.persistStage(rentalId, ConversationStage.DEAD);
        this.logger.log(`Stage ${currentStage} → DEAD (rental status: ${rental.status}) for ${rentalId}`);
        return { shouldTransition: true, newStage: ConversationStage.DEAD, reason: `Rental ${rental.status}` };
      }
      return { shouldTransition: false };
    }

    // Pending rental with VERIFIED or BOOKED_AFTER_VERIFIED order_step → BOOKED
    // Only these order_steps indicate the renter is actually in verification, which is what
    // the dashboard "verifying" funnel bar should show. Earlier order_steps (REQUEST, APPROVED,
    // FUNDS_RESERVED) keep their chat-derived stage to avoid inflating the funnel.
    if (rental.status === 'pending' && currentStage !== ConversationStage.DEAD &&
        ['VERIFIED', 'BOOKED_AFTER_VERIFIED'].includes(rental.order_step ?? '')) {
      const bookedIdx = STAGE_ORDER.indexOf(ConversationStage.BOOKED);
      const currentIdx2 = STAGE_ORDER.indexOf(currentStage);
      if (currentIdx2 >= 0 && currentIdx2 < bookedIdx) {
        await this.persistStage(rentalId, ConversationStage.BOOKED);
        this.logger.log(`Stage ${currentStage} → BOOKED (order_step=${rental.order_step}) for ${rentalId}`);
        return { shouldTransition: true, newStage: ConversationStage.BOOKED, reason: `Renter verification in progress (${rental.order_step})` };
      }
    }

    // Get conversation history
    const history = await this.prisma.conversation.findMany({
      where: { chat_id: `rental:${rentalId}` },
      orderBy: { created_at: 'asc' },
    });
    if (history.length === 0) return { shouldTransition: false };

    const messages = history.map(h => h.content.toLowerCase());
    const fullConversation = messages.join(' ');
    // Renter-only messages for interest signals (avoids bot's own "available"/"price" triggering stage advances)
    const renterMessages = history.filter(h => h.role === 'user').map(h => h.content.toLowerCase());
    const renterConversation = renterMessages.join(' ');
    const lastMessage = messages[messages.length - 1];
    const lastMessageAt = history[history.length - 1].created_at;
    const hoursSinceLastMessage = (Date.now() - lastMessageAt.getTime()) / (1000 * 60 * 60);
    const msgCount = history.length;

    // Detect conversation attributes — use renterConversation for interest signals to avoid bot self-triggering
    const priceQuoted = /£\d+|price|cost|how much|per day|total/.test(renterConversation);
    const datesDiscussed = /\d{4}-\d{2}-\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|\d{1,2}(st|nd|rd|th)/.test(renterConversation);
    const availabilityConfirmed = /available|free|yes.*can|got it|in stock/.test(renterConversation);
    const affirmative = /sounds good|perfect|great|ok|yes|sure|fine|works|deal|let'?s do|i'?ll take|book|go ahead/.test(renterConversation);
    // Booking/verification signals legitimately appear in bot messages too
    const verificationMentioned = /\b(verification|verify|id check|identity)\b/.test(fullConversation) && /\b(required|needed|pending|waiting|upload)\b/.test(fullConversation);
    const bookingMentioned = /booking.*request|sent.*request|request.*sent|booking.*sent/.test(fullConversation);
    const declinedOrGone = /no thanks|not interested|changed.*mind|cancel|never ?mind/.test(lastMessage);

    // --- Evaluate correct stage (highest matching, not sequential) ---
    let newStage: ConversationStage;
    let reason: string;

    if (bookingMentioned || verificationMentioned) {
      newStage = ConversationStage.BOOKED;
      reason = bookingMentioned ? 'Booking request mentioned' : 'Verification discussed';
    } else if (affirmative && priceQuoted && datesDiscussed && availabilityConfirmed && msgCount >= 4) {
      newStage = ConversationStage.READY_TO_BOOK;
      reason = 'All details confirmed, renter agreed';
    } else if ((priceQuoted || datesDiscussed) && availabilityConfirmed && msgCount >= 3) {
      newStage = ConversationStage.READY_TO_BOOK;
      reason = 'Details discussed, availability confirmed';
    } else if (priceQuoted || datesDiscussed || availabilityConfirmed || /available|price|cost|book|rent|hire/.test(renterConversation)) {
      newStage = ConversationStage.INTERESTED;
      reason = 'Showed interest (price/dates/availability mentioned)';
    } else {
      newStage = ConversationStage.INQUIRY;
      reason = 'Initial contact';
    }

    // DEAD trigger: flat rule — 3+ follow-ups AND 24h+ silence at any pre-CONFIRMED stage
    const followUpCount = followUpState?.followup_count || 0;
    const lastRenterMsgAt = followUpState?.last_renter_message_at;
    const hoursSinceRenter = lastRenterMsgAt
      ? (Date.now() - new Date(lastRenterMsgAt).getTime()) / (1000 * 60 * 60)
      : hoursSinceLastMessage;

    if (declinedOrGone) {
      newStage = ConversationStage.DEAD;
      reason = 'Renter declined';
    } else if (
      followUpCount >= 3 &&
      hoursSinceRenter >= 24 &&
      currentStage !== ConversationStage.CONFIRMED &&
      currentStage !== ConversationStage.COMPLETED
    ) {
      // Mark as DEAD (or keep DEAD) when follow-ups exhausted + renter silent 24h+
      newStage = ConversationStage.DEAD;
      reason = currentStage === ConversationStage.DEAD
        ? 'Still dead (no new renter message)'
        : `Follow-ups exhausted (${followUpCount}) + ${Math.round(hoursSinceRenter)}h silence`;
    }

    // Pending rental = booking request sent on Hygglo → minimum stage is BOOKED
    // (unless renter ghosted and we're marking DEAD)
    if (rental.status === 'pending' && newStage !== ConversationStage.DEAD) {
      const bookedIdx = STAGE_ORDER.indexOf(ConversationStage.BOOKED);
      const detectedIdx = STAGE_ORDER.indexOf(newStage);
      if (detectedIdx < bookedIdx) {
        newStage = ConversationStage.BOOKED;
        reason = 'Booking request sent on Hygglo';
      }
    }

    // Only persist if stage actually changed (and don't downgrade, except to DEAD)
    const currentIdx = STAGE_ORDER.indexOf(currentStage);
    const newIdx = STAGE_ORDER.indexOf(newStage);
    const isDead = newStage === ConversationStage.DEAD;
    const isUpgrade = newIdx > currentIdx;
    const isCurrentDead = currentStage === ConversationStage.DEAD;

    // Revival from DEAD: only if renter sent a message AFTER being marked dead
    const stageChangedAt = followUpState?.stage_changed_at;
    const hasNewRenterMessage = isCurrentDead && lastRenterMsgAt && stageChangedAt &&
      new Date(lastRenterMsgAt).getTime() > new Date(stageChangedAt).getTime();

    // No-op if stage didn't actually change
    if (newStage === currentStage) {
      return { shouldTransition: false };
    }

    // Allow: upgrade, or setting DEAD, or reviving from DEAD (with new renter message)
    if (isUpgrade || isDead || (isCurrentDead && hasNewRenterMessage && newIdx >= 0)) {
      // Don't downgrade from CONFIRMED/COMPLETED unless DEAD
      if ((currentStage === ConversationStage.CONFIRMED || currentStage === ConversationStage.COMPLETED) && !isDead) {
        return { shouldTransition: false };
      }

      await this.persistStage(rentalId, newStage);
      this.logger.log(`Stage ${currentStage} → ${newStage} (${reason}) for ${rentalId}`);
      return { shouldTransition: true, newStage, reason };
    }

    return { shouldTransition: false };
  }

  /**
   * Explicitly set conversation stage (for programmatic transitions like auto-accept, booking confirmed, etc.)
   */
  async setStage(rentalId: string, stage: ConversationStage): Promise<void> {
    await this.persistStage(rentalId, stage);
    this.logger.log(`Stage explicitly set to ${stage} for rental ${rentalId}`);
  }

  /**
   * Get next stage in funnel
   */
  private getNextStage(currentStage: ConversationStage): ConversationStage {
    const currentIndex = STAGE_ORDER.indexOf(currentStage);
    if (currentIndex >= 0 && currentIndex < STAGE_ORDER.length - 1) {
      return STAGE_ORDER[currentIndex + 1];
    }

    return currentStage;
  }

  /**
   * Check if message matches trigger
   */
  private matchesTrigger(message: string, trigger: string): boolean {
    const triggerLower = trigger.toLowerCase();

    // Direct phrase match
    if (message.includes(triggerLower)) return true;

    // Semantic patterns
    const patterns: Record<string, RegExp> = {
      'asks about availability': /\b(available|free|have|got|in stock)\b/,
      'asks about price': /\b(price|cost|how much|charge|rate)\b/,
      'mentions dates': /\b(\d{1,2}\/\d{1,2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|this weekend)\b/,
      'accepts price': /\b(sounds good|perfect|ok|yes|sure|fine|works|deal)\b/,
      'provides dates': /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}|from.*to|between.*and)\b/,
      'asks about booking process': /\b(how.*book|booking.*work|send.*request|reserve)\b/,
      'says "sounds good"': /\b(sounds good|looks good|perfect|great|ok then|alright)\b/,
      'asks how to book': /\b(how.*book|where.*book|booking button|send.*request)\b/,
      'no more questions': /\b(no.*question|that.*it|all set|ready|let.*do it)\b/,
      'booking request received': /\b(sent.*request|submitted|booked|requested)\b/,
      'booking verified': /\b(confirm|verified|accept)\b/,
      'verification complete': /\b(verified|verification\s+complete|identity\s+confirmed)\b/,
    };

    const pattern = patterns[triggerLower];
    if (pattern && pattern.test(message)) return true;

    return false;
  }

  /**
   * Extract item names from conversation
   */
  private extractItems(text: string): string[] {
    const commonItems = [
      'FX3', 'A7 III', 'A7 II', 'BMPCC', 'camera',
      '24-70', '70-200', '50mm', 'lens',
      'RS3', 'RS2', 'gimbal',
      'Aputure', 'light',
      'Mavic', 'drone',
    ];

    const foundItems: string[] = [];
    for (const item of commonItems) {
      if (new RegExp(item, 'i').test(text)) {
        foundItems.push(item);
      }
    }

    return [...new Set(foundItems)]; // Remove duplicates
  }

  /**
   * Get all stage definitions (for debugging/admin)
   */
  getAllStages(): StageDefinition[] {
    return Array.from(this.stageDefinitions.values());
  }

  // ══════════════════════════════════════════════
  // STAGE ACTION REGISTRY
  // ══════════════════════════════════════════════

  /**
   * Get all actions allowed at the given stage, sorted by priority (lowest first = highest priority).
   */
  getStageActions(stage: string): StageAction[] {
    const stageMap = STAGE_ACTION_MAP[stage] || {};
    const actions: StageAction[] = Object.entries(stageMap).map(([type, priority]) => ({
      type: type as StageActionType,
      priority: priority as number,
      enabled: true,
    }));
    return actions.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Check if a specific action is allowed at the given stage.
   */
  isActionAllowed(stage: string, action: StageActionType): boolean {
    const stageMap = STAGE_ACTION_MAP[stage];
    return !!stageMap && action in stageMap;
  }

  /**
   * Get the priority of an action at the given stage. Returns -1 if not allowed.
   */
  getActionPriority(stage: string, action: StageActionType): number {
    const stageMap = STAGE_ACTION_MAP[stage];
    if (!stageMap || !(action in stageMap)) return -1;
    return stageMap[action]!;
  }

  /**
   * Check if the current stage is at least the given minimum stage in the funnel.
   */
  isStageAtLeast(current: string, minimum: string): boolean {
    const currentIdx = STAGE_ORDER.indexOf(current as ConversationStage);
    const minimumIdx = STAGE_ORDER.indexOf(minimum as ConversationStage);
    if (currentIdx === -1 || minimumIdx === -1) return false;
    return currentIdx >= minimumIdx;
  }

  /**
   * Check if the current stage is before the given stage in the funnel.
   */
  isStageBefore(current: string, threshold: string): boolean {
    return !this.isStageAtLeast(current, threshold);
  }

  // ══════════════════════════════════════════════
  // PERIODIC STAGE RECONCILIATION
  // ══════════════════════════════════════════════

  /**
   * Cron: Every 5 minutes, reconcile conversation stages with rental status.
   * 1. Sync with Hygglo status changes (accepted/cancelled) without a new message.
   * 2. Mark conversations DEAD when renter engaged then ghosted (>48h silence after bot replied).
   */
  @Cron('*/5 * * * *')
  async reconcileStages(): Promise<void> {
    try {
      // Get all active follow_up_states that aren't already terminal
      const states = await this.prisma.follow_up_state.findMany({
        where: {
          status: 'active',
          conversation_stage: { not: 'completed' },
        },
        select: {
          rental_id: true,
          conversation_stage: true,
          last_renter_message_at: true,
          last_bot_message_at: true,
        },
      });

      if (states.length === 0) return;

      // Batch-fetch all related rentals
      const rentalIds = states.map(s => s.rental_id);
      const rentals = await this.prisma.rental.findMany({
        where: { id: { in: rentalIds } },
        select: { id: true, status: true, start_date: true, end_date: true, order_step: true, created_at: true },
      });
      const rentalMap = new Map(rentals.map(r => [r.id, r]));

      const now = new Date();
      let fixed = 0;
      for (const state of states) {
        const rental = rentalMap.get(state.rental_id);
        if (!rental) continue;

        const currentStage = (state.conversation_stage || 'inquiry') as ConversationStage;
        let newStage: ConversationStage | null = null;

        // Completed: end_date passed + accepted status
        if (rental.end_date && new Date(rental.end_date) < now &&
            ['completed', 'ongoing'].includes(rental.status) &&
            currentStage !== ConversationStage.COMPLETED) {
          newStage = ConversationStage.COMPLETED;
        }
        // Confirmed: rental accepted on Hygglo
        else if (['ongoing', 'upcoming'].includes(rental.status) &&
                 currentStage !== ConversationStage.CONFIRMED) {
          newStage = ConversationStage.CONFIRMED;
        }
        // Dead: rental cancelled/obsolete
        else if (['cancelled', 'obsolete'].includes(rental.status) &&
                 currentStage !== ConversationStage.DEAD) {
          newStage = ConversationStage.DEAD;
        }
        // Dead: renter engaged then ghosted — bot replied but renter never came back (>48h)
        else if (
          currentStage !== ConversationStage.DEAD &&
          rental.status === 'pending' &&
          state.last_renter_message_at &&
          state.last_bot_message_at &&
          state.last_bot_message_at > state.last_renter_message_at &&
          (now.getTime() - state.last_renter_message_at.getTime()) > 48 * 60 * 60 * 1000 &&
          // Only if start date is still in the future (expired ones are just excluded from funnel)
          rental.start_date && new Date(rental.start_date) >= now
        ) {
          newStage = ConversationStage.DEAD;
        }
        // Dead: chat-less pending rentals that are stale or expired
        // Catches Hygglo auto-requests with no actual conversation
        else if (
          currentStage !== ConversationStage.DEAD &&
          rental.status === 'pending' &&
          !state.last_renter_message_at &&
          !state.last_bot_message_at &&
          !['VERIFIED', 'BOOKED_AFTER_VERIFIED'].includes(rental.order_step ?? '') && (
            // Start date passed — rental window expired
            (rental.start_date && new Date(rental.start_date) < now) ||
            // No start date — incomplete rental, never going to happen
            !rental.start_date ||
            // Request is >48h old and no chat activity
            (rental.created_at && (now.getTime() - new Date(rental.created_at).getTime()) > 48 * 60 * 60 * 1000)
          )
        ) {
          newStage = ConversationStage.DEAD;
        }
        // Pending with VERIFIED/BOOKED_AFTER_VERIFIED order_step → BOOKED
        // Only these order_steps indicate actual renter verification in progress
        else if (
          rental.status === 'pending' &&
          currentStage !== ConversationStage.DEAD &&
          ['VERIFIED', 'BOOKED_AFTER_VERIFIED'].includes(rental.order_step ?? '') &&
          STAGE_ORDER.indexOf(currentStage) < STAGE_ORDER.indexOf(ConversationStage.BOOKED)
        ) {
          newStage = ConversationStage.BOOKED;
        }
        // Fix NULL stages
        else if (!state.conversation_stage) {
          newStage = ConversationStage.INQUIRY;
        }

        if (newStage) {
          await this.persistStage(state.rental_id, newStage);
          fixed++;
          this.logger.log(`Reconcile: ${currentStage} → ${newStage} for ${state.rental_id} (rental status: ${rental.status})`);
        }
      }

      if (fixed > 0) {
        this.logger.log(`Stage reconciliation: fixed ${fixed} stages`);
      }
    } catch (err) {
      this.logger.warn(`Stage reconciliation failed: ${err.message}`);
    }
  }
}
