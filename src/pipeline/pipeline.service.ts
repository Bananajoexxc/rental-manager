/**
 * Pipeline Service — Main orchestrator for the grounded generation agent.
 *
 * Replaces inline context assembly in both processMessage and processRenterConversation.
 * Both code paths call pipeline.process() for unified intelligence.
 *
 * Layers:
 * 1. CLASSIFY + Renter DNA (code, <1ms)
 * 2. THINK — Inner Monologue (Haiku, ~100 tokens)
 * 3. GATHER — FactPack assembly (parallel DB/service calls)
 * 4. FENCE — Knowledge boundary in prompt (code, <1ms)
 * 5. TALK — Prompt assembly + AI call
 * 6. FILTER — Hard filters: physical presence, fabricated quotes, internal actions (code, <1ms)
 * 7. CONTRACT — Intent-based response validation (code, <1ms)
 * 8. GROUND — Semantic grounding verification (Haiku, ~80 tokens)
 * 9. CHECK — Fact verification for prices/items/availability (code, <1ms)
 * 10. STATE — Update conversation memory
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { RulesService } from '../rules/rules.service';
import { MemoryService } from '../memory/memory.service';
import { CalendarService } from '../calendar/calendar.service';
import { DeliveryService } from '../delivery/delivery.service';
import { RecommendationService } from '../recommendations/recommendation.service';
import { DemandService } from '../demand/demand.service';
import { ConversationStageService } from '../conversation-tree/conversation-stage.service';
import { FollowUpService } from '../follow-up/follow-up.service';
import { ContentionService } from '../contention/contention.service';
import { RenterProfileService } from '../renter-profile/renter-profile.service';

import { PipelineInput, PipelineResult, InnerMonologue, RenterDNA, DEFAULT_RENTER_DNA, Intent } from './types';
import { classifyMessage, profileRenter, shouldSuppressUpsell } from './classify';
import { generateInnerMonologue, generateQuickMonologue } from './think';
import { gatherFacts, GatherServices } from './gather';
import { assemblePrompt } from './assemble';
import { verifyResponse, buildCorrectionPrompt } from './verify';
import { filterResponse } from './filter';
import { enforceContract, surgicalContractFix } from './contract';
import { verifyGrounding } from './ground';
import { getInventoryItemNames } from '../utils/item-matcher';
import { DiagnosticService } from '../monitoring/diagnostic.service';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private prisma: PrismaService,
    private aiService: AiService,
    private rulesService: RulesService,
    private memoryService: MemoryService,
    private calendarService: CalendarService,
    private deliveryService: DeliveryService,
    private recommendationService: RecommendationService,
    private demandService: DemandService,
    private conversationStageService: ConversationStageService,
    private followUpService: FollowUpService,
    @Optional() private contentionService?: ContentionService,
    @Optional() private renterProfileService?: RenterProfileService,
    @Optional() private diagnosticService?: DiagnosticService,
  ) {}

  /**
   * Main pipeline entry point — unified for both production and simulation paths.
   */
  async process(input: PipelineInput): Promise<PipelineResult> {
    const startTime = Date.now();

    // --- Pre-load shared context (single load, passed through all layers) ---
    // Eliminates 5 redundant DB calls per message.
    let preConversationState: Record<string, any> = {};
    let preRentalStage = 'inquiry';
    let preConvState: any = null; // Full conversation stage state (for stage guidance)
    let preExtractedItems: string[] = [];
    let existingDNA: RenterDNA | undefined;
    if (input.rental) {
      try {
        preConversationState = await this.followUpService.getStructuredState(input.rental.id);
        if ((preConversationState as any)?.renterDNA) existingDNA = (preConversationState as any).renterDNA as RenterDNA;
      } catch { /* non-critical */ }
      try {
        preConvState = await this.conversationStageService.getConversationState(input.rental.id);
        preRentalStage = preConvState?.currentStage || 'inquiry';
      } catch { /* non-critical */ }
      try {
        const extracted = await this.prisma.extracteditem.findMany({
          where: { rental_id: input.rental.id },
          select: { item_name: true, source: true },
        });
        if (extracted.length > 0) {
          const seen = new Map<string, string>();
          for (const e of extracted) {
            const existing = seen.get(e.item_name);
            if (!existing || e.source === 'photo_reference') {
              seen.set(e.item_name, e.source);
            }
          }
          preExtractedItems = [...seen.keys()];
        }
      } catch { /* non-critical */ }
    } else {
      const msgCount = input.conversationHistory.length / 2;
      if (msgCount === 0) preRentalStage = 'inquiry';
      else if (msgCount <= 2) preRentalStage = 'interest';
      else preRentalStage = 'qualified';
    }

    // --- Layer 1: CLASSIFY ---

    const classification = classifyMessage(
      input.message,
      input.conversationHistory,
      existingDNA || DEFAULT_RENTER_DNA,
      preConversationState,
      preRentalStage,
    );

    this.logger.debug(
      `[Pipeline] L1 CLASSIFY: intent=${classification.intent}, complexity=${classification.complexity}, ` +
      `momentum=${classification.momentum}, suppressUpsell=${classification.suppressUpsell}, ` +
      `DNA=${classification.renterDNA.style}/${classification.renterDNA.expertise}/${classification.renterDNA.driver}, ` +
      `items=${classification.mentionedItems.join(',') || 'none'}`,
    );

    // --- Stage reassessment: ensure monologue + gather use current stage ---
    let rentalStage = preRentalStage;
    let freshConvState = preConvState;
    if (input.rental) {
      try {
        await this.conversationStageService.reassessStage(input.rental.id);
        freshConvState = await this.conversationStageService.getConversationState(input.rental.id);
        rentalStage = freshConvState?.currentStage || rentalStage;
        if (rentalStage !== preRentalStage) {
          this.logger.log(`[Pipeline] Stage reassessed: ${preRentalStage} → ${rentalStage}`);
          classification.suppressUpsell = shouldSuppressUpsell(input.message, preConversationState, rentalStage);
        }
      } catch { /* non-critical */ }
    }

    // --- Layer 2: THINK ---
    let monologue: InnerMonologue;

    if (classification.contextLevel === 'minimal' ||
        classification.intent === Intent.ACKNOWLEDGMENT ||
        classification.intent === Intent.GOODBYE ||
        classification.intent === Intent.RETURN_CONFIRMATION ||
        classification.intent === Intent.DAMAGE_REPORT ||
        (classification.intent === Intent.LOGISTICS && classification.complexity === 'low') ||
        (classification.intent === Intent.PRICING_INQUIRY && classification.complexity === 'low') ||
        (classification.intent === Intent.AVAILABILITY_CHECK && classification.complexity === 'low') ||
        (classification.intent === Intent.BOOKING_ACTION && classification.complexity === 'low') ||
        (classification.intent === Intent.EQUIPMENT_QUESTION && classification.complexity === 'low')) {
      // Skip AI call for simple/terminal messages — GATHER facts have all the data needed
      monologue = generateQuickMonologue(input.message, classification);
      this.logger.debug(`[Pipeline] L2 THINK: quick monologue (no AI call, intent=${classification.intent})`);
    } else {
      // Use pre-loaded extracted items (no redundant DB call)
      let resolvedItems = preExtractedItems.length > 0
        ? [...new Set([...preExtractedItems, ...classification.mentionedItems])]
        : classification.mentionedItems;

      // Use pre-fetched conversation state (already loaded above)
      const conversationState = preConversationState;

      monologue = await generateInnerMonologue(
        this.aiService,
        input.message,
        classification,
        resolvedItems,
        conversationState,
        rentalStage,
      );

      this.logger.debug(
        `[Pipeline] L2 THINK: want="${monologue.want}", goal="${monologue.goal}", ` +
        `missing="${monologue.missing}", plan=${monologue.plan.length} steps, ` +
        `salesAction="${monologue.salesAction}"`,
      );
    }

    // --- Layer 3: GATHER ---
    const gatherServices: GatherServices = {
      rulesService: this.rulesService,
      memoryService: this.memoryService,
      calendarService: this.calendarService,
      deliveryService: this.deliveryService,
      recommendationService: this.recommendationService,
      demandService: this.demandService,
      conversationStageService: this.conversationStageService,
      followUpService: this.followUpService,
      contentionService: this.contentionService,
      renterProfileService: this.renterProfileService,
      prisma: this.prisma,
    };

    const factPack = await gatherFacts(
      classification,
      monologue,
      gatherServices,
      {
        ...input,
        preloadedState: preConversationState,
        preloadedStage: rentalStage,
        preloadedConvState: freshConvState,
        preloadedExtractedItems: preExtractedItems,
      },
    );

    this.logger.debug(
      `[Pipeline] L3 GATHER: items=${factPack.resolvedItems.length}, ` +
      `pricing=${factPack.pricing ? factPack.pricing.itemPrices.length + ' items' : 'no'}, ` +
      `delivery=${factPack.delivery ? 'yes' : 'no'}, schedule=${factPack.schedule ? 'yes' : 'no'}`,
    );

    // --- Layer 4+5: FENCE + TALK ---
    // Knowledge Fence is built into assemblePrompt (numbered facts + boundary instruction)
    const { userMessage, context } = assemblePrompt(
      input.message,
      classification,
      monologue,
      factPack,
    );

    // Inject simulation rental context if provided
    if (input.simulationRentalContext) {
      context.rentalContext = (context.rentalContext || '') + ' ' + input.simulationRentalContext;
    }

    // Add tool handlers for production mode
    if (input.rental) {
      context.toolHandlers = {
        checkAvailability: async (itemName, startDate, endDate) => {
          const result = await this.calendarService.checkAvailability(
            itemName, new Date(startDate), new Date(endDate),
          );
          return result.available
            ? `${result.matchedItem || itemName} is available (${result.booked}/${result.maxQuantity} booked)`
            : `${result.matchedItem || itemName} is NOT available (${result.booked}/${result.maxQuantity} booked)`;
        },
        lookupPricing: async (itemName, days) => {
          const { getItemPrice } = await import('../data/pricing-catalog.js');
          const entry = getItemPrice(itemName);
          if (!entry) return `Pricing not found for ${itemName}`;
          const dailyRate = entry.daily_price_max;
          let total = dailyRate * days;
          if (days >= 7) total = dailyRate * 5;
          else if (days === 3) total = dailyRate * 2.5;
          // else: total stays at dailyRate * days (no discount for 1,2,4,5,6 days)
          const ownerEarnings = Math.round(total * 0.64);
          return `${itemName} for ${days} day(s): ~£${Math.round(total)} (renter pays), ~£${ownerEarnings} (owner earnings)`;
        },
        checkCompatibility: async (items) => {
          const { checkCompatibilityConflicts, detectMissingEssentials, formatCompatibilityForAI } = await import('../data/item-compatibility.js');
          const conflicts = checkCompatibilityConflicts(items);
          const missing = detectMissingEssentials(items);
          const parts: string[] = [];
          if (conflicts.conflicts.length > 0) {
            parts.push('CONFLICTS: ' + conflicts.conflicts.map((c: any) => c.reason).join('; '));
          }
          if (missing.missing.length > 0) {
            parts.push('MISSING: ' + missing.missing.map((m: any) => `${m.camera} needs ${m.category}: ${m.suggestions.join(', ')}`).join('; '));
          }
          const compatInfo = formatCompatibilityForAI(items);
          if (compatInfo) parts.push(compatInfo);
          return parts.length > 0 ? parts.join('\n') : 'All items compatible.';
        },
      };
    }

    // Model routing (stakes-gated):
    //   Sonnet 4.6 + thinking  -> sensitive + high complexity + high-stakes signal
    //                             (refund demand, damage on shipped rental, legal threat,
    //                              sarcasm, >=200 GBP negotiation)
    //   Haiku 4.5 + thinking   -> sensitive + (high complexity w/o stakes OR medium complexity)
    //   Haiku 4.5 routine      -> all substantive non-sensitive intents (GATHER pre-fetches facts)
    //   Haiku 4.5 lightweight  -> greetings/goodbyes/acknowledgments/return confirmations
    const sensitiveIntents = new Set([
      'negotiation', 'complaint', 'damage_report', 'cancellation',
    ]);
    const isSensitive = sensitiveIntents.has(classification.intent);

    // Stakes detection — only these warrant Sonnet premium
    const hasRefundDemand = /\b(refund|compensat|money back|my money|reimburse|chargeback)\b/i.test(userMessage);
    const rentalStatus = String(input.rental?.status || '').toLowerCase();
    const orderStep = String(input.rental?.order_step || '').toLowerCase();
    const shippedStatuses = ['verified', 'booked_after_verified', 'ongoing', 'delivered'];
    const rentalShipped = shippedStatuses.some(st => orderStep.includes(st) || rentalStatus.includes(st));
    const damageKeywords = /\b(scratched|broke|broken|damaged|dropped|not working|won'?t turn on|cracked|smashed|shattered|malfunction|faulty)\b/i.test(userMessage);
    const hasDamageOnShipped = damageKeywords && rentalShipped;
    const rentalValue = Number(input.rental?.rental_price || 0);
    const hasBigNegotiation = classification.intent === Intent.NEGOTIATION && rentalValue >= 200;
    const hasSarcasm = /🙄|😒|😤|\b(oh (great|wonderful|fantastic|perfect|brilliant)|really professional|wow.*service|sure.*take your time|not like I need)\b/i.test(userMessage);
    const hasLegalThreat = /\b(lawyer|sue|legal action|court|trading standards|small.?claims|ombudsman|paypal dispute|chargeback|dispute)\b/i.test(userMessage);
    const isHighStakes = hasRefundDemand || hasDamageOnShipped || hasBigNegotiation || hasSarcasm || hasLegalThreat;

    const needsSonnet = isSensitive && classification.complexity === 'high' && isHighStakes;
    const needsHaikuThinking = isSensitive && !needsSonnet && (
      classification.complexity === 'high' || classification.complexity === 'medium'
    );

    // Lightweight: simple terminal messages where minimal reasoning is needed
    const lightweightIntents = new Set([
      'greeting', 'acknowledgment', 'goodbye', 'return_confirmation',
    ]);
    const isLightweight = !isSensitive
      && classification.complexity === 'low'
      && lightweightIntents.has(classification.intent);

    let response;
    let routedTier: string;
    if (needsSonnet) {
      // Sonnet + extended thinking — genuine high-stakes incidents
      const { toolHandlers, ...adaptiveCtx } = context;
      response = await this.aiService.processAdaptive(userMessage, { ...adaptiveCtx, maxTokens: 1000 });
      routedTier = 'sonnet+thinking';
    } else if (needsHaikuThinking) {
      // Haiku 4.5 + extended thinking — reasoning quality without Sonnet premium.
      // Covers >=90% of previously-escalated sensitive interactions.
      const { toolHandlers, ...haikuThinkCtx } = context;
      response = await this.aiService.processRoutineWithThinking(userMessage, { ...haikuThinkCtx, maxTokens: 800 });
      routedTier = 'haiku+thinking';
    } else if (isLightweight) {
      // Haiku for trivial messages (greetings, goodbyes)
      const { toolHandlers, ...haikuCtx } = context;
      response = await this.aiService.processLightweight(userMessage, haikuCtx);
      routedTier = 'haiku-lightweight';
    } else {
      // Haiku for all substantive intents (pricing, equipment, availability, booking,
      // logistics, low-complexity sensitive intents). Full context from GATHER ensures
      // accuracy — Haiku 4.5 handles these well with complete pre-fetched data.
      const { toolHandlers, ...routineCtx } = context;
      response = await this.aiService.processRoutine(userMessage, routineCtx);
      routedTier = 'haiku-routine';
    }

    this.logger.debug(
      `[Pipeline] L5 ROUTE: tier=${routedTier}, intent=${classification.intent}, ` +
      `complexity=${classification.complexity}, sensitive=${isSensitive}, highStakes=${isHighStakes}, value=GBP${rentalValue}`,
    );

    let responseContent = response.content;

    this.logger.debug(
      `[Pipeline] L5 TALK: model=${response.model}, in=${response.inputTokens}, out=${response.outputTokens}`,
    );

    // --- Layer 6: FILTER (hard filters — code-enforced, <1ms) ---
    const filterResult = filterResponse(
      responseContent,
      input.conversationHistory,
      input.message,
      input.account,
      rentalStage,
      factPack,
    );
    responseContent = filterResult.response;

    if (filterResult.issues.length > 0) {
      const stripped = filterResult.issues.filter(i => i.action === 'stripped').length;
      const flagged = filterResult.issues.filter(i => i.action === 'flagged').length;
      this.logger.warn(
        `[Pipeline] L6 FILTER: ${filterResult.issues.length} issues (${stripped} stripped, ${flagged} flagged): ` +
        filterResult.issues.map(i => `${i.type}`).join(', '),
      );
    } else {
      this.logger.debug(`[Pipeline] L6 FILTER: CLEAN`);
    }

    // --- Layer 7: CONTRACT (intent-based validation — code-enforced, <1ms) ---
    const contractResult = enforceContract(
      responseContent,
      classification,
      !!factPack.pricing,
    );

    if (!contractResult.passed) {
      this.logger.warn(
        `[Pipeline] L7 CONTRACT: ${contractResult.violations.length} violations: ` +
        contractResult.violations.map(v => `${v.rule}(${v.severity})`).join(', '),
      );

      // Attempt surgical fix for block-severity violations
      const blockViolations = contractResult.violations.filter(v => v.severity === 'block');
      if (blockViolations.length > 0) {
        const surgicalFix = surgicalContractFix(responseContent, contractResult.violations);
        if (surgicalFix) {
          responseContent = surgicalFix;
          this.logger.log(`[Pipeline] L7 CONTRACT: Surgical fix applied (removed ${blockViolations.length} violating sentences)`);
        } else {
          // Surgical fix failed — try AI correction with contract hints
          try {
            const correctionPrompt = `Your response violated these rules:\n${contractResult.correctionHints.join('\n')}\n\nRewrite this response following the rules. Keep the same core message but fix violations. Reply with ONLY the corrected message:\n\n${responseContent}`;
            const corrected = await this.aiService.processExtraction(correctionPrompt, { maxTokens: 200 });
            const cleanedCorrection = corrected.content
              .replace(/\]\]+/g, '').replace(/\n{3,}/g, '\n\n')
              .replace(/(\*{2,}|_{2,}|#{1,})/g, '').replace(/^\s+|\s+$/g, '');
            // Re-check the correction
            const recheck = enforceContract(cleanedCorrection, classification, !!factPack.pricing);
            const recheckBlocks = recheck.violations.filter(v => v.severity === 'block');
            if (recheckBlocks.length < blockViolations.length) {
              responseContent = cleanedCorrection;
              this.logger.log(`[Pipeline] L7 CONTRACT: AI correction reduced violations (${blockViolations.length}→${recheckBlocks.length})`);
            }
          } catch { /* correction is best-effort */ }
        }
      }
    } else {
      this.logger.debug(`[Pipeline] L7 CONTRACT: PASSED`);
    }

    // --- Layer 8: GROUND (semantic grounding — AI-powered) ---
    // Only run grounding for flagged responses (physical presence, fabricated quotes, etc.)
    const hasGroundingFlags = filterResult.issues.some(i =>
      i.action === 'flagged' && ['PHYSICAL_PRESENCE', 'FABRICATED_QUOTE', 'SELF_CONTRADICTION', 'TIME_LOGIC'].includes(i.type),
    );

    // Also run grounding if the response contains spec-like claims — but ONLY when pricing
    // is involved (where hallucinated specs cause real harm). Saves ~1 Haiku call on 60-70% of messages.
    const hasSpecClaims = /\b(\d+\s*(?:cm|mm|kg|gb|tb|w|watt|hour|mah)|4k|8k|120fps|60fps|full frame|aps-c|10-bit|12-bit|dual card|phase detect|ibis|eye.?af)\b/i.test(responseContent);
    const specClaimsNeedGrounding = hasSpecClaims && (classification.hasPricingIntent || classification.intent === Intent.PRICING_INQUIRY);

    if (hasGroundingFlags || specClaimsNeedGrounding) {
      try {
        const groundingResult = await verifyGrounding(this.aiService, responseContent, factPack);

        if (!groundingResult.grounded) {
          this.logger.warn(
            `[Pipeline] L8 GROUND: ${groundingResult.ungroundedClaims.length} ungrounded claims: ` +
            groundingResult.ungroundedClaims.join('; '),
          );
          this.diagnosticService?.log('pipeline', 'grounding_failure', `Grounding found ${groundingResult.ungroundedClaims.length} ungrounded claims`, { claims: groundingResult.ungroundedClaims, rentalId: input.rentalId }, input.rentalId);

          if (groundingResult.correctedResponse) {
            responseContent = groundingResult.correctedResponse;
            this.logger.log(`[Pipeline] L8 GROUND: Applied corrected response`);
          }
        } else {
          this.logger.debug(`[Pipeline] L8 GROUND: VERIFIED`);
        }
      } catch (groundErr) {
        this.logger.debug(`[Pipeline] L8 GROUND: Skipped (${(groundErr as Error).message})`);
      }
    } else {
      this.logger.debug(`[Pipeline] L8 GROUND: SKIPPED (no flags/spec claims)`);
    }

    // --- Layer 9: CHECK (price/item/availability verification — code, <1ms) ---
    let verification = verifyResponse(responseContent, factPack);

    // Late-binding availability check: if bot claims unavailability but no formal check was done,
    // perform a real availability check now and either confirm or correct the claim.
    const unverifiedUnavail = verification.issues.find(i => i.type === 'UNVERIFIED_UNAVAILABILITY');
    if (unverifiedUnavail && input.rental?.start_date && input.rental?.end_date) {
      try {
        const itemsInResponse = getInventoryItemNames().filter(item => {
          const parts = item.toLowerCase().split(' ').filter(p => p.length > 2);
          const respLower = responseContent.toLowerCase();
          return parts.length >= 2
            ? parts.filter(p => respLower.includes(p)).length >= Math.min(2, parts.length)
            : respLower.includes(item.toLowerCase());
        });

        if (itemsInResponse.length > 0) {
          const lateAvailItems: import('./types').ItemAvailability[] = [];
          for (const itemName of itemsInResponse.slice(0, 5)) {
            const result = await this.calendarService.checkAvailability(
              itemName, new Date(input.rental.start_date), new Date(input.rental.end_date), input.rental.id,
            );
            if (result.matchedItem) {
              lateAvailItems.push({
                item: result.matchedItem,
                available: result.available,
                booked: result.booked,
                maxQuantity: result.maxQuantity,
                availableFrom: result.availableFrom,
                unavailableAfter: result.unavailableAfter,
              });
            }
          }

          if (lateAvailItems.length > 0) {
            // Inject real availability data into factPack for re-verification
            factPack.availability = { items: lateAvailItems };
            const anyWronglyUnavailable = lateAvailItems.some(i => i.available);

            if (anyWronglyUnavailable) {
              // Bot claimed unavailable but items ARE available — critical error
              this.logger.warn(
                `[Pipeline] LATE AVAIL CHECK: Bot falsely claimed unavailability! ` +
                `Available items: ${lateAvailItems.filter(i => i.available).map(i => i.item).join(', ')}`,
              );
              // Re-run verification with real data to get proper AVAILABILITY_LIE issues
              verification = verifyResponse(responseContent, factPack);
            } else {
              // Items genuinely unavailable — remove the unverified issue
              verification.issues = verification.issues.filter(i => i.type !== 'UNVERIFIED_UNAVAILABILITY');
              verification.passed = verification.issues.length === 0;
              this.logger.debug(`[Pipeline] LATE AVAIL CHECK: Unavailability confirmed correct`);
            }
          }
        }
      } catch (lateErr) {
        this.logger.debug(`[Pipeline] Late availability check failed: ${(lateErr as Error).message}`);
      }
    }

    if (!verification.passed && verification.issues.length > 0) {
      this.logger.warn(
        `[Pipeline] L9 CHECK FAILED: ${verification.issues.map(i => `${i.type}: ${i.detail}`).join('; ')}`,
      );

      // One corrective retry
      try {
        const correctionPrompt = buildCorrectionPrompt(responseContent, verification.issues);
        const corrected = await this.aiService.processExtraction(correctionPrompt, { maxTokens: 300 });
        const correctedContent = corrected.content
          .replace(/\]\]+/g, '').replace(/\n{3,}/g, '\n\n')
          .replace(/(\*{2,}|_{2,}|#{1,})/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/^\s+|\s+$/g, '').replace(/  +/g, ' ');

        // Re-verify the corrected response
        const reVerification = verifyResponse(correctedContent, factPack);
        if (reVerification.passed || reVerification.issues.length < verification.issues.length) {
          responseContent = correctedContent;
          verification = reVerification;
          this.logger.log(`[Pipeline] L9 CHECK: Corrective retry succeeded (${reVerification.issues.length} remaining issues)`);
        } else {
          this.logger.debug(`[Pipeline] L9 CHECK: Corrective retry did not improve (keeping original)`);
        }
      } catch (corrErr) {
        this.logger.debug(`[Pipeline] L9 CHECK: Corrective retry failed: ${(corrErr as Error).message}`);
      }
    } else {
      this.logger.debug(`[Pipeline] L9 CHECK: PASSED`);
    }

    // --- Correction feedback loop ---
    // Track what was corrected so next THINK can avoid the same mistakes
    const corrections: string[] = [];
    if (filterResult.issues.length > 0) {
      corrections.push(...filterResult.issues.map(i => `filter:${i.type}`));
    }
    if (!contractResult.passed) {
      corrections.push(...contractResult.violations.map(v => `contract:${v.rule}`));
    }

    // --- Layer 10: STATE UPDATE ---
    // Skip for intents that won't meaningfully change conversation state
    // Saves ~300 tokens + 1 Haiku call per simple message
    const skipStateExtraction =
      classification.intent === Intent.ACKNOWLEDGMENT ||
      classification.intent === Intent.GOODBYE ||
      classification.intent === Intent.GREETING ||
      classification.intent === Intent.RETURN_CONFIRMATION ||
      (classification.intent === Intent.LOGISTICS && classification.complexity === 'low') ||
      classification.contextLevel === 'minimal';
    let stateUpdate: Record<string, any> | undefined;
    if (input.rental && !skipStateExtraction) {
      try {
        const parsed: Record<string, any> = {};

        // Items: track from classification + accumulate with previous confirmed items.
        // This replaces the AI extraction — mentionedItems comes from classify.ts's
        // 4-stage matching against MASTER_INVENTORY (direct, token, n-gram, single-word).
        // Order changes are detected naturally: new items appear in mentionedItems each message.
        if (classification.mentionedItems.length > 0) {
          const prevItems: string[] = (preConversationState as any).confirmedItems || [];
          parsed.confirmedItems = [...new Set([...prevItems, ...classification.mentionedItems])];
        }

        // Price quoted: extract last £ amount from bot response
        const priceMatches = responseContent.match(/£(\d+(?:\.\d{2})?)/g);
        if (priceMatches) {
          const lastPrice = priceMatches[priceMatches.length - 1].replace('£', '');
          parsed.priceQuoted = parseFloat(lastPrice);
        }

        // Delivery discussed: detect from renter message or bot response
        if (/\b(deliver|delivery|courier|shipping|postcode)\b/i.test(input.message) ||
            /\b(deliver|delivery|courier)\b/i.test(responseContent)) {
          parsed.deliveryDiscussed = true;
        }

        // Questions asked: detect questions in bot response (for repetition prevention)
        const questions = responseContent.match(/[^.!?\n]*\?/g);
        if (questions && questions.length > 0) {
          parsed.questionsAsked = questions.map(q => q.trim()).filter(q => q.length > 10).slice(0, 3);
        }

        // Upsell attempted: detect from response patterns
        if (/\b(also available|might also|could add|would complement|goes great with|pair nicely|bundle|add-on|accessory)\b/i.test(responseContent)) {
          parsed.upsellAttempted = true;
        }

        // Shoot type: extract from renter message
        const shootMatch = input.message.match(/\b(wedding|event|film|documentary|music video|commercial|corporate|interview|short film|feature|youtube|vlog|podcast|photoshoot|photo shoot|concert|live stream|livestream|property|real estate|fashion)\b/i);
        if (shootMatch) {
          parsed.renterShootType = shootMatch[1].toLowerCase();
        }

        // Persist RenterDNA in state too
        parsed.renterDNA = classification.renterDNA;
        parsed.lastGoal = monologue.goal;
        parsed.lastMissing = monologue.missing;

        // Store corrections for feedback loop (cleared after 2 messages)
        if (corrections.length > 0) {
          parsed.lastCorrections = corrections;
          parsed.correctionAge = 0;
        } else if (preConversationState.lastCorrections) {
          const age = (preConversationState.correctionAge || 0) + 1;
          if (age >= 2) {
            parsed.lastCorrections = null;
            parsed.correctionAge = null;
          } else {
            parsed.correctionAge = age;
          }
        }

        // Track if bot mentioned unavailability (prevents broken-record warnings)
        if (/\b(not available|unavailable|out of stock|isn't available|aren't available|fully booked|no longer available)\b/i.test(responseContent)) {
          parsed.unavailabilityMentioned = true;
        }

        // Negotiation intelligence: track price objections + competitor mentions
        if (classification.intent === Intent.NEGOTIATION || classification.hasCompetitorMention) {
          const currentObjections = (preConversationState as any).priceObjectionCount || 0;
          parsed.priceObjectionCount = currentObjections + 1;
          parsed.negotiationStance = currentObjections >= 2 ? 'yield' : currentObjections >= 1 ? 'flexible' : 'firm';
          if (classification.hasCompetitorMention) {
            parsed.competitorMentioned = true;
          }
          const negPriceMatch = responseContent.match(/£(\d+(?:\.\d{2})?)/);
          if (negPriceMatch) {
            parsed.lastPriceOffered = parseFloat(negPriceMatch[1]);
          }
        }

        await this.followUpService.mergeStructuredState(input.rental.id, parsed);
        stateUpdate = parsed;
      } catch { /* non-critical — state extraction is best-effort */ }
    }

    const elapsed = Date.now() - startTime;
    const filterIssueCount = filterResult.issues.length;
    const contractIssueCount = contractResult.violations.length;
    this.logger.log(
      `[Pipeline] Complete in ${elapsed}ms | intent=${classification.intent} | ` +
      `model=${response.model} | tokens=${response.inputTokens}→${response.outputTokens} | ` +
      `filter=${filterIssueCount === 0 ? 'CLEAN' : `${filterIssueCount} issues`} | ` +
      `contract=${contractResult.passed ? 'PASS' : `FAIL(${contractIssueCount})`} | ` +
      `verify=${verification.passed ? 'PASS' : `FAIL(${verification.issues.length})`} | ` +
      `DNA=${classification.renterDNA.style}/${classification.renterDNA.driver}`,
    );

    return {
      response: responseContent,
      innerMonologue: monologue,
      classification,
      factPack,
      verification,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      stateUpdate,
    };
  }
}
