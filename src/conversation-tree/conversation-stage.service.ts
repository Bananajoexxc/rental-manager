import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Conversation stages - progressive funnel toward booking
 */
export enum ConversationStage {
  INQUIRY = 'inquiry',           // Initial contact, browsing
  INTEREST = 'interest',         // Asked about availability/price - showing intent
  QUALIFIED = 'qualified',       // Confirmed: item available, price acceptable, dates discussed
  BOOKING_READY = 'booking_ready', // All info gathered, ready to request booking
  BOOKING_SENT = 'booking_sent', // Booking request sent on Hygglo
  AWAITING_VERIFICATION = 'awaiting_verification', // Booking sent, waiting for renter verification
  CONFIRMED = 'confirmed',       // Booking verified and accepted
  DEAD = 'dead',                 // Conversation went cold or renter declined
}

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
interface ConversationState {
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
            'Check if they have specific dates in mind',
            'Qualify interest level',
          ],
          transitionTriggers: [
            'asks about availability',
            'asks about price',
            'mentions dates',
          ],
          prompt: `STAGE: Initial Inquiry
OBJECTIVE: Understand what they need. Confirm availability quickly.
NEXT STEP: If available, mention it's free for their dates and naturally ask "When were you looking to use it?"
If the renter hasn't mentioned what they're shooting, naturally ask what the project is -- this helps recommend the right gear.
Keep it conversational, not salesy.`,
        },
      ],
      [
        ConversationStage.INTEREST,
        {
          stage: ConversationStage.INTEREST,
          objective: 'Quote price and confirm dates',
          nextSteps: [
            'Give clear pricing (single day + multi-day discount)',
            'Ask for specific dates if not given',
            'Mention any relevant bundles',
          ],
          transitionTriggers: [
            'accepts price',
            'provides dates',
            'asks about booking process',
          ],
          prompt: `STAGE: Interest Shown
OBJECTIVE: They're interested. Lock in dates and price.
NEXT STEP: Once dates confirmed, naturally progress: "Cool, so [item] for [dates] - I'll hold that for you. Send the booking request and we're set."
Be assumptive but casual. Make it easy to say yes.`,
        },
      ],
      [
        ConversationStage.QUALIFIED,
        {
          stage: ConversationStage.QUALIFIED,
          objective: 'Gather any remaining info and push for booking',
          nextSteps: [
            'Confirm pickup location (general area only)',
            'Ask if delivery needed',
            'Check if any questions remain',
            'Push for booking request',
          ],
          transitionTriggers: [
            'says "sounds good"',
            'asks how to book',
            'no more questions',
          ],
          prompt: `STAGE: Qualified Lead
OBJECTIVE: They're ready. Close the deal.
NEXT STEP: Direct ask: "Sounds good? Go ahead and send the booking request on Hygglo and I'll confirm it right away."
Use social proof if stalling: "Got another rental that day too, so best to lock it in."
Assumptive close. Make it feel like the natural next step.`,
        },
      ],
      [
        ConversationStage.BOOKING_READY,
        {
          stage: ConversationStage.BOOKING_READY,
          objective: 'Get booking request submitted',
          nextSteps: [
            'Remind them to send booking request',
            'Explain booking button is on listing page',
            'Reassure fast confirmation',
          ],
          transitionTriggers: ['booking request received'],
          prompt: `STAGE: Booking Ready
OBJECTIVE: They're committed but haven't sent request yet.
NEXT STEP: Gentle nudge: "Just hit that booking request button on the listing and you're all set. I'll confirm within the hour."
If they're hesitant, remove friction: "No charge til confirmed, so no risk."`,
        },
      ],
      [
        ConversationStage.BOOKING_SENT,
        {
          stage: ConversationStage.BOOKING_SENT,
          objective: 'Confirm booking and send details',
          nextSteps: [
            'Send booking confirmation template',
            'Provide pickup details',
            'Confirm times',
          ],
          transitionTriggers: ['booking verified'],
          prompt: `STAGE: Booking Request Received
OBJECTIVE: Verify and confirm. Welcome them.
NEXT STEP: Use booking confirmation template. Be welcoming: "Booked! Looking forward to it."`,
        },
      ],
      [
        ConversationStage.AWAITING_VERIFICATION,
        {
          stage: ConversationStage.AWAITING_VERIFICATION,
          objective: 'Help renter complete identity verification',
          nextSteps: [
            'Guide through verification process if first time',
            'Check verification status periodically',
            'Suggest alternatives if verification keeps failing',
          ],
          transitionTriggers: ['verification complete', 'verified'],
          prompt: `STAGE: Awaiting Verification
OBJECTIVE: The booking request has been sent but the renter needs to complete identity verification first.
NEXT STEP: If they haven't been guided yet, explain the verification process clearly. If they're struggling, offer help.
Do NOT proceed with pickup details or handover arrangements until verification is confirmed.
If they say they're "on their way" — inform them we cannot hand over gear without verification.`,
        },
      ],
      [
        ConversationStage.CONFIRMED,
        {
          stage: ConversationStage.CONFIRMED,
          objective: 'Maintain relationship, handle questions',
          nextSteps: [
            'Answer any logistics questions',
            'Confirm pickup times',
            'Ensure smooth handoff',
          ],
          transitionTriggers: [],
          prompt: `STAGE: Confirmed Booking
OBJECTIVE: Deliver great service. Set up for future rentals.
Be helpful and responsive. This is where you build repeat business.`,
        },
      ],
      [
        ConversationStage.DEAD,
        {
          stage: ConversationStage.DEAD,
          objective: 'Try to revive or let go',
          nextSteps: ['Send follow-up if appropriate', 'Mark conversation as closed'],
          transitionTriggers: [],
          prompt: `STAGE: Dead Conversation
Either: 1) They went quiet for 24+ hours after being interested
        2) They explicitly declined
If recently dead, one tasteful follow-up: "Hey, still need [item] for [dates]? Happy to hold it."
Otherwise, let it go. Don't be pushy.`,
        },
      ],
    ]);
  }

  /**
   * Get conversation state from database
   */
  async getConversationState(rentalId: string): Promise<ConversationState | null> {
    const rental = await this.prisma.rental.findUnique({
      where: { id: rentalId },
    });

    if (!rental) return null;

    // Get conversation history to infer state
    const history = await this.prisma.conversation.findMany({
      where: { chat_id: `rental:${rentalId}` },
      orderBy: { created_at: 'asc' },
    });

    if (history.length === 0) {
      // New conversation
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

    // Analyze conversation to determine state
    const messages = history.map(h => h.content.toLowerCase());
    const fullConversation = messages.join(' ');

    const state: ConversationState = {
      rentalId,
      currentStage: ConversationStage.INQUIRY, // Will be updated
      stageEnteredAt: history[0].created_at,
      itemsDiscussed: this.extractItems(fullConversation),
      priceQuoted: /£\d+|price|cost|how much/.test(fullConversation),
      datesDiscussed: /\d{4}-\d{2}-\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week/.test(fullConversation),
      availabilityConfirmed: /available|free|yes.*can|got it/.test(fullConversation),
      deliveryDiscussed: /deliver|courier|postcode/.test(fullConversation),
      lastMessageAt: history[history.length - 1].created_at,
      messageCount: history.length,
    };

    // Determine current stage based on conversation content
    state.currentStage = this.inferStage(state, rental, fullConversation);

    return state;
  }

  /**
   * Infer conversation stage from state
   */
  private inferStage(
    state: ConversationState,
    rental: any,
    conversationText: string,
  ): ConversationStage {
    // Check for dead conversation (24+ hours since last message after showing interest)
    const hoursSinceLastMessage = (Date.now() - state.lastMessageAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastMessage > 24 && state.messageCount > 2 && state.priceQuoted) {
      return ConversationStage.DEAD;
    }

    // Check for confirmed booking
    if (rental.status === 'ongoing' || rental.status === 'upcoming') {
      // Check if there's a follow-up state with auto_accepted = true
      // (auto-accept sets CONFIRMED automatically)
      return ConversationStage.CONFIRMED;
    }

    // Check for awaiting verification
    if (/\b(verification|verify|id check|identity)\b/.test(conversationText) &&
        /\b(required|needed|pending|waiting|upload)\b/.test(conversationText)) {
      return ConversationStage.AWAITING_VERIFICATION;
    }

    // Check for booking sent (rental request exists but not confirmed)
    if (/booking.*request|sent.*request/.test(conversationText)) {
      return ConversationStage.BOOKING_SENT;
    }

    // Check for booking ready (all info gathered, should close)
    if (
      state.availabilityConfirmed &&
      state.priceQuoted &&
      state.datesDiscussed &&
      /sounds good|perfect|great|ok|yes/.test(conversationText)
    ) {
      return ConversationStage.BOOKING_READY;
    }

    // Check for qualified (showed strong interest, discussed details)
    if (
      (state.priceQuoted || state.datesDiscussed) &&
      state.availabilityConfirmed &&
      state.messageCount >= 3
    ) {
      return ConversationStage.QUALIFIED;
    }

    // Check for interest (asked about availability or price)
    if (
      state.priceQuoted ||
      state.datesDiscussed ||
      state.availabilityConfirmed ||
      /available|price|cost|book|rent/.test(conversationText)
    ) {
      return ConversationStage.INTEREST;
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
    prompt += `\nYour response should naturally move the conversation toward: ${definition.nextSteps[0]}`;

    return prompt;
  }

  /**
   * Check if stage should transition based on latest message
   */
  async checkStageTransition(
    rentalId: string,
    latestMessage: string,
  ): Promise<{ shouldTransition: boolean; newStage?: ConversationStage; reason?: string }> {
    const state = await this.getConversationState(rentalId);
    if (!state) return { shouldTransition: false };

    const currentDefinition = this.stageDefinitions.get(state.currentStage);
    if (!currentDefinition) return { shouldTransition: false };

    const messageLower = latestMessage.toLowerCase();

    // Check if any transition trigger is met
    for (const trigger of currentDefinition.transitionTriggers) {
      if (this.matchesTrigger(messageLower, trigger)) {
        // Determine new stage
        const newStage = this.getNextStage(state.currentStage);
        return {
          shouldTransition: true,
          newStage,
          reason: `Trigger met: ${trigger}`,
        };
      }
    }

    return { shouldTransition: false };
  }

  /**
   * Get next stage in funnel
   */
  private getNextStage(currentStage: ConversationStage): ConversationStage {
    const progression = [
      ConversationStage.INQUIRY,
      ConversationStage.INTEREST,
      ConversationStage.QUALIFIED,
      ConversationStage.BOOKING_READY,
      ConversationStage.BOOKING_SENT,
      ConversationStage.AWAITING_VERIFICATION,
      ConversationStage.CONFIRMED,
    ];

    const currentIndex = progression.indexOf(currentStage);
    if (currentIndex >= 0 && currentIndex < progression.length - 1) {
      return progression[currentIndex + 1];
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
}
