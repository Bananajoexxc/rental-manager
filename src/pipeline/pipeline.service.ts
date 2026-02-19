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

import { PipelineInput, PipelineResult, InnerMonologue, RenterDNA, DEFAULT_RENTER_DNA } from './types';
import { classifyMessage, profileRenter, shouldSuppressUpsell } from './classify';
import { generateInnerMonologue, generateQuickMonologue } from './think';
import { gatherFacts, GatherServices } from './gather';
import { assemblePrompt } from './assemble';
import { verifyResponse, buildCorrectionPrompt } from './verify';
import { filterResponse } from './filter';
import { enforceContract, surgicalContractFix } from './contract';
import { verifyGrounding } from './ground';

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
  ) {}

  /**
   * Main pipeline entry point — unified for both production and simulation paths.
   */
  async process(input: PipelineInput): Promise<PipelineResult> {
    const startTime = Date.now();

    // --- Layer 1: CLASSIFY ---
    // Recover existing RenterDNA from conversation state (if available)
    let existingDNA: RenterDNA | undefined;
    if (input.rental) {
      try {
        const state = await this.followUpService.getStructuredState(input.rental.id) as any;
        if (state?.renterDNA) existingDNA = state.renterDNA as RenterDNA;
      } catch { /* non-critical */ }
    }

    // Pre-fetch conversation state + stage for classify (needed for upsell logic)
    let preConversationState: Record<string, any> = {};
    let preRentalStage = 'inquiry';
    if (input.rental) {
      try {
        preConversationState = await this.followUpService.getStructuredState(input.rental.id);
      } catch { /* non-critical */ }
      try {
        const convState = await this.conversationStageService.getConversationState(input.rental.id);
        preRentalStage = convState?.currentStage || 'inquiry';
      } catch { /* non-critical */ }
    } else {
      const msgCount = input.conversationHistory.length / 2;
      if (msgCount === 0) preRentalStage = 'inquiry';
      else if (msgCount <= 2) preRentalStage = 'interest';
      else preRentalStage = 'qualified';
    }

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
    if (input.rental) {
      try {
        await this.conversationStageService.reassessStage(input.rental.id);
        const freshState = await this.conversationStageService.getConversationState(input.rental.id);
        rentalStage = freshState?.currentStage || rentalStage;
        if (rentalStage !== preRentalStage) {
          this.logger.log(`[Pipeline] Stage reassessed: ${preRentalStage} → ${rentalStage}`);
          // Re-evaluate upsell with fresh stage
          classification.suppressUpsell = shouldSuppressUpsell(input.message, preConversationState, rentalStage);
        }
      } catch { /* non-critical */ }
    }

    // --- Layer 2: THINK ---
    let monologue: InnerMonologue;

    if (classification.contextLevel === 'minimal') {
      // Skip AI call for simple messages
      monologue = generateQuickMonologue(input.message, classification);
      this.logger.debug(`[Pipeline] L2 THINK: quick monologue (no AI call)`);
    } else {
      // Get resolved items for the inner monologue
      let resolvedItems = classification.mentionedItems;
      if (input.rental) {
        try {
          const extracted = await this.prisma.extracteditem.findMany({
            where: { rental_id: input.rental.id },
            select: { item_name: true },
          });
          if (extracted.length > 0) {
            resolvedItems = [...new Set([...extracted.map((e: any) => e.item_name), ...resolvedItems])];
          }
        } catch { /* non-critical */ }
      }

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
      prisma: this.prisma,
    };

    const factPack = await gatherFacts(
      classification,
      monologue,
      gatherServices,
      input,
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
          else if (days >= 3) total = dailyRate * 2.5;
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

    // Choose model based on complexity + inner monologue assessment
    const useAdaptive = classification.complexity === 'high'
      || monologue.plan.length > 2
      || (monologue.missing && monologue.missing.length > 50);

    const response = useAdaptive
      ? await this.aiService.processAdaptive(userMessage, context)
      : await this.aiService.processRoutine(userMessage, context);

    let responseContent = response.content;

    this.logger.debug(
      `[Pipeline] L5 TALK: model=${response.model}, in=${response.inputTokens}, out=${response.outputTokens}`,
    );

    // --- Layer 6: FILTER (hard filters — code-enforced, <1ms) ---
    const filterResult = filterResponse(
      responseContent,
      input.conversationHistory,
      input.message,
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

    // Also run grounding if the response contains spec-like claims not in the fact pack
    const hasSpecClaims = /\b\d+\s*(?:cm|mm|kg|gb|tb|w|watt|hour|mah)\b/i.test(responseContent);

    if (hasGroundingFlags || hasSpecClaims) {
      try {
        const groundingResult = await verifyGrounding(this.aiService, responseContent, factPack);

        if (!groundingResult.grounded) {
          this.logger.warn(
            `[Pipeline] L8 GROUND: ${groundingResult.ungroundedClaims.length} ungrounded claims: ` +
            groundingResult.ungroundedClaims.join('; '),
          );

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

    // --- Layer 10: STATE UPDATE ---
    let stateUpdate: Record<string, any> | undefined;
    if (input.rental) {
      try {
        const stateExtraction = await this.aiService.processExtraction(
          `Extract conversation state from this exchange. Reply in JSON only, no markdown fences.
Bot response: "${responseContent.substring(0, 500)}"
Renter message: "${input.message.substring(0, 300)}"

Return ONLY a JSON object with changed fields (omit unchanged):
{"confirmedItems":["item1"],"agreedPickupTime":"Fri 2pm","agreedReturnTime":null,"renterShootType":"wedding","questionsAsked":["what's the shoot for?"],"upsellAttempted":false,"priceQuoted":150,"deliveryDiscussed":false}`,
          { maxTokens: 150 },
        );
        const jsonStr = stateExtraction.content.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        // Persist RenterDNA in state too
        parsed.renterDNA = classification.renterDNA;
        parsed.lastGoal = monologue.goal;
        parsed.lastMissing = monologue.missing;

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
