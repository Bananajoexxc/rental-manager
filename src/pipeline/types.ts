/**
 * Pipeline Types — Shared interfaces for the 7-layer intelligent agent pipeline.
 */

// Layer 1: Intent Classification (deterministic)
export enum Intent {
  PRICING_INQUIRY = 'pricing_inquiry',
  AVAILABILITY_CHECK = 'availability_check',
  LOGISTICS = 'logistics',
  EQUIPMENT_QUESTION = 'equipment_question',
  BOOKING_ACTION = 'booking_action',
  GREETING = 'greeting',
  NEGOTIATION = 'negotiation',
  ACKNOWLEDGMENT = 'acknowledgment',
  COMPLAINT = 'complaint',
  CANCELLATION = 'cancellation',
  DAMAGE_REPORT = 'damage_report',
  RETURN_CONFIRMATION = 'return_confirmation',
  GOODBYE = 'goodbye',
  GENERAL = 'general',
}

// Layer 1: Renter DNA Profile (evolves with every message)
export interface RenterDNA {
  style: 'formal' | 'casual' | 'terse';
  expertise: 'beginner' | 'intermediate' | 'pro';
  driver: 'price' | 'quality' | 'convenience';
  energy: 'enthusiastic' | 'neutral' | 'hesitant';
  decisionSpeed: 'fast' | 'deliberate';
}

// Cross-rental renter preferences (persisted on renter_profile)
export interface RenterPreferences {
  preferred_pickup_time?: string;      // "morning" | "evening" | "7pm" etc.
  preferred_items?: string[];           // top 3 by frequency
  shoot_types?: string[];               // "wedding", "documentary", etc.
  communication_style?: RenterDNA;      // persisted DNA from last rental
  price_sensitivity?: 'low' | 'medium' | 'high';
}

export const DEFAULT_RENTER_DNA: RenterDNA = {
  style: 'casual',
  expertise: 'intermediate',
  driver: 'convenience',
  energy: 'neutral',
  decisionSpeed: 'deliberate',
};

// Layer 1 output
export interface MessageClassification {
  intent: Intent;
  complexity: 'low' | 'medium' | 'high';
  suppressUpsell: boolean;
  renterDNA: RenterDNA;
  mentionedItems: string[];
  hasPricingIntent: boolean;
  hasDeliveryIntent: boolean;
  hasSchedulingIntent: boolean;
  isLogisticsMessage: boolean;
  isGoodbyeMessage: boolean;
  isSimpleAck: boolean;
  contextLevel: 'minimal' | 'standard' | 'comprehensive';
  momentum: 'accelerating' | 'steady' | 'decelerating';
  hasCompetitorMention: boolean;
}

// Layer 2: Inner Monologue
export interface InnerMonologue {
  want: string;
  know: string;
  missing: string;
  goal: string;
  plan: string[];
  avoid: string[];
  tone: string;
  salesAction: string;
}

// Layer 3: FactPack — only the facts needed for this specific message
export interface ItemPricing {
  itemName: string;
  dailyMin: number;
  dailyMax: number;
  renterPays?: number;
}

export interface ItemAvailability {
  item: string;
  available: boolean;
  booked: number;
  maxQuantity: number;
}

export interface FactPack {
  // Always loaded (mandatory)
  rental?: {
    id: number;
    title: string;
    status: string;
    startDate?: Date;
    endDate?: Date;
    renterName: string;
    isFirstTime: boolean;
    platform: string;
    account: string;
    rentalPrice?: number;
    renterPrice?: number;
    days?: number;
  };
  resolvedItems: string[];
  conversationState: Record<string, any>;
  renterDNA: RenterDNA;

  // On-demand (loaded based on intent/inner monologue)
  pricing?: {
    itemPrices: ItemPricing[];
    bundlePrices?: ItemPricing[];
    multiDayNote: string;
  };
  availability?: {
    items: ItemAvailability[];
  };
  delivery?: string;
  schedule?: string;
  compatibility?: string;
  inventoryContext?: string;
  upsellContext?: string;
  bundleContext?: string;
  accountTemplates?: string;
  stageGuidance?: string;
  conversationStage?: string;
  renterProfile?: string;
  welcomeBack?: boolean;
  urgency?: string;
  multiRental?: string;
  discountContext?: string;
  lowValueInstruction?: string;
  verifiedListingItem?: string;
  listingInventoryContext?: string;
  rules?: string;
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
  conversationSummary?: string;
  suppressUpsell: boolean;
}

// Layer 5: Verification result
export interface VerificationIssue {
  type: 'PRICE_MISMATCH' | 'ITEM_MISMATCH' | 'AVAILABILITY_LIE' | 'UPSELL_VIOLATION' | 'REPETITION';
  detail: string;
}

export interface VerificationResult {
  passed: boolean;
  issues: VerificationIssue[];
}

// Pipeline input — unified for both processMessage and processRenterConversation
export interface PipelineInput {
  message: string;
  account: 'dbcinema' | 'leo';
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];

  // Production mode (processMessage) provides rental context
  rental?: any; // Prisma rental record
  rentalId?: string; // listing_id for Hygglo operations

  // Simulation mode has no rental record
  isSimulation: boolean;

  // Optional overrides
  imageUrls?: string[];
}

// Pipeline output
export interface PipelineResult {
  response: string;
  innerMonologue?: InnerMonologue;
  classification: MessageClassification;
  factPack: FactPack;
  verification: VerificationResult;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stateUpdate?: Record<string, any>;
}
