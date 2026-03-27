import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';

@Injectable()
export class ConversationArchiveService {
  private readonly logger = new Logger(ConversationArchiveService.name);

  constructor(
    private prisma: PrismaService,
    private aiService: AiService,
  ) {}

  /**
   * Daily cron at 7am — archive completed/dead rentals older than 14 days.
   * Processes up to 20 per run to keep AI costs bounded.
   * Moved from 2am to avoid quiet hours (2-7 AM) since this calls AI API.
   */
  @Cron('0 7 * * *')
  async nightlyArchival() {
    this.logger.log('[Archival] Starting nightly conversation archival...');

    try {
      const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

      // Find completed/dead rentals with conversations that haven't been archived yet
      const candidates = await this.prisma.rental.findMany({
        where: {
          follow_up_state: {
            OR: [
              { conversation_stage: 'completed' },
              { conversation_stage: 'dead' },
            ],
            stage_changed_at: { lt: cutoff },
          },
          // Only archive if not already archived
          NOT: {
            id: {
              in: (await this.prisma.conversation_archive.findMany({
                select: { rental_id: true },
                distinct: ['rental_id'],
              })).map(a => a.rental_id),
            },
          },
        },
        include: {
          follow_up_state: true,
          renter_links: {
            include: { renter_profile: true },
          },
        },
        take: 20,
        orderBy: { updated_at: 'asc' },
      });

      this.logger.log(`[Archival] Found ${candidates.length} rentals to archive`);

      let archived = 0;
      for (const rental of candidates) {
        try {
          await this.archiveRental(rental);
          archived++;
        } catch (err) {
          this.logger.warn(`[Archival] Failed to archive rental ${rental.id}: ${err.message}`);
        }
      }

      this.logger.log(`[Archival] Completed — archived ${archived}/${candidates.length} rentals`);
    } catch (err) {
      this.logger.error(`[Archival] Nightly run failed: ${err.message}`);
    }
  }

  /**
   * Archive a single rental's conversation:
   * 1. Fetch all messages
   * 2. Use AI to extract insights
   * 3. Store archive + insights
   * 4. Trim messages to newest 500
   */
  async archiveRental(rental: any): Promise<void> {
    const chatId = rental.listing_id;

    // Get ALL messages for this conversation
    const messages = await this.prisma.conversation.findMany({
      where: { chat_id: chatId },
      orderBy: { created_at: 'asc' },
    });

    if (messages.length === 0) {
      this.logger.debug(`[Archival] No messages for rental ${rental.id} (${chatId}), skipping`);
      return;
    }

    const renterName = rental.renter_links?.[0]?.renter_profile?.name
      || rental.renter_info
      || 'Unknown';

    const stage = rental.follow_up_state?.conversation_stage || 'unknown';
    const rentalValue = rental.rental_price || null;

    // Build conversation text for AI analysis (cap at ~3000 chars to keep Haiku costs low)
    const convoText = this.buildConvoText(messages, 3000);

    // Extract insights via AI
    let insights: any = {};
    try {
      insights = await this.extractInsights(convoText, rental.title, renterName, stage);
    } catch (err) {
      this.logger.warn(`[Archival] AI insight extraction failed for ${rental.id}: ${err.message}`);
      // Continue with empty insights — we still want the archive
    }

    // Build compressed summary from the full conversation
    const compressedSummary = this.buildCompressedSummary(messages);

    // Create archive record
    const archive = await this.prisma.conversation_archive.create({
      data: {
        rental_id: rental.id,
        chat_id: chatId,
        message_count: messages.length,
        renter_name: renterName,
        items_requested: insights.items_requested || [],
        use_cases: insights.use_cases || [],
        renter_tone: insights.renter_tone || null,
        pricing_sensitivity: insights.pricing_sensitivity || null,
        engagement_level: messages.length > 20 ? 'high' : messages.length > 8 ? 'medium' : 'low',
        first_message_at: messages[0]?.created_at || null,
        last_message_at: messages[messages.length - 1]?.created_at || null,
        final_outcome: this.mapStageToOutcome(stage),
        final_rental_value: rentalValue,
        compressed_summary: compressedSummary,
        key_decisions: insights.key_decisions || null,
      },
    });

    // Store individual insights
    const insightRecords = this.buildInsightRecords(rental.id, archive.id, insights);
    if (insightRecords.length > 0) {
      await this.prisma.conversation_insight.createMany({ data: insightRecords });
    }

    // Trim conversation to newest 500 messages
    if (messages.length > 500) {
      const keepFrom = messages[messages.length - 500];
      const deleteCount = await this.prisma.conversation.deleteMany({
        where: {
          chat_id: chatId,
          created_at: { lt: keepFrom.created_at },
        },
      });
      this.logger.log(`[Archival] Trimmed ${deleteCount.count} old messages for ${chatId} (kept newest 500)`);
    }

    this.logger.log(`[Archival] Archived rental ${rental.id} — ${messages.length} msgs, ${insightRecords.length} insights`);
  }

  /**
   * Build conversation text for AI, capped at maxChars.
   * Takes a sample from beginning, middle, and end of conversation.
   */
  private buildConvoText(messages: any[], maxChars: number): string {
    if (messages.length <= 20) {
      // Short conversations — use all messages
      return messages.map(m =>
        `${m.role === 'user' ? 'Renter' : 'Bot'}: ${m.content.substring(0, 300)}`,
      ).join('\n');
    }

    // Long conversations — sample beginning (5), middle (5), end (10)
    const begin = messages.slice(0, 5);
    const midIdx = Math.floor(messages.length / 2);
    const middle = messages.slice(midIdx - 2, midIdx + 3);
    const end = messages.slice(-10);

    const parts = [
      '--- Start of conversation ---',
      ...begin.map(m => `${m.role === 'user' ? 'Renter' : 'Bot'}: ${m.content.substring(0, 200)}`),
      `--- ... ${messages.length - 20} messages omitted ... ---`,
      ...middle.map(m => `${m.role === 'user' ? 'Renter' : 'Bot'}: ${m.content.substring(0, 200)}`),
      '--- ... ---',
      ...end.map(m => `${m.role === 'user' ? 'Renter' : 'Bot'}: ${m.content.substring(0, 200)}`),
    ];

    let text = parts.join('\n');
    if (text.length > maxChars) {
      text = text.substring(0, maxChars) + '\n[truncated]';
    }
    return text;
  }

  /**
   * Use Haiku to extract structured insights from a conversation.
   */
  private async extractInsights(
    convoText: string,
    listingTitle: string,
    renterName: string,
    stage: string,
  ): Promise<any> {
    const prompt = `Analyze this camera equipment rental conversation and extract structured data.
Listing: "${listingTitle}"
Renter: "${renterName}"
Final stage: ${stage}

Conversation:
${convoText}

Return a JSON object with these fields:
- items_requested: string[] — all items the renter asked about or booked
- use_cases: string[] — what they're using it for (e.g. "wedding", "documentary", "content creation", "interview", "music video")
- renter_tone: string — one of: "professional", "casual", "urgent", "frustrated", "friendly"
- pricing_sensitivity: string — one of: "budget" (asks for discounts/cheaper), "moderate" (some price discussion), "premium" (price not an issue)
- key_objections: string[] — concerns or pushbacks the renter raised
- outcome_reason: string — brief reason for the final outcome (converted/lost/cancelled)
- key_decisions: object[] — max 3 important decision points: [{decision: string, reason: string}]
- marketing_angles: string[] — potential marketing hooks (e.g. "popular for weddings", "good bundle with 24-70mm")

RESPOND WITH ONLY VALID JSON. No markdown fences. No explanation.`;

    const result = await this.aiService.processExtraction(prompt, { maxTokens: 500 });

    try {
      // Parse JSON — handle common AI response quirks
      let jsonStr = result.content.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      }
      return JSON.parse(jsonStr);
    } catch {
      this.logger.warn(`[Archival] Failed to parse AI insights JSON: ${result.content.substring(0, 200)}`);
      return {};
    }
  }

  /**
   * Build a compressed summary from all messages — extracts key facts without AI.
   * Items, dates, prices, and decisions mentioned.
   */
  private buildCompressedSummary(messages: any[]): string {
    const renterMsgs = messages.filter(m => m.role === 'user');
    const botMsgs = messages.filter(m => m.role === 'assistant');

    const lines: string[] = [
      `Total: ${messages.length} messages (${renterMsgs.length} renter, ${botMsgs.length} bot)`,
      `Period: ${messages[0]?.created_at?.toISOString?.()?.split('T')[0] || '?'} to ${messages[messages.length - 1]?.created_at?.toISOString?.()?.split('T')[0] || '?'}`,
    ];

    // Extract price mentions from all messages
    const pricePattern = /£(\d+(?:\.\d{2})?)/g;
    const prices = new Set<string>();
    for (const m of messages) {
      const matches = m.content.matchAll(pricePattern);
      for (const match of matches) prices.add(match[1]);
    }
    if (prices.size > 0) {
      lines.push(`Prices mentioned: £${Array.from(prices).join(', £')}`);
    }

    // Extract date mentions
    const datePattern = /\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*(?:\s+\d{4})?)\b/gi;
    const dates = new Set<string>();
    for (const m of messages) {
      const matches = m.content.matchAll(datePattern);
      for (const match of matches) dates.add(match[1]);
    }
    if (dates.size > 0) {
      lines.push(`Dates mentioned: ${Array.from(dates).slice(0, 5).join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Convert conversation stage to outcome string.
   */
  private mapStageToOutcome(stage: string): string {
    switch (stage) {
      case 'completed':
      case 'confirmed':
      case 'booked':
        return 'converted';
      case 'dead':
        return 'lost';
      case 'cancelled':
        return 'cancelled';
      default:
        return 'ongoing';
    }
  }

  /**
   * Build conversation_insight records from extracted AI data.
   */
  private buildInsightRecords(rentalId: string, archiveId: string, insights: any): any[] {
    const records: any[] = [];

    // Item demand insights
    if (insights.items_requested?.length > 0) {
      for (const item of insights.items_requested) {
        records.push({
          rental_id: rentalId,
          archive_id: archiveId,
          insight_type: 'item_demand',
          category: 'requested',
          content: item,
          confidence: 0.9,
          is_actionable: false,
        });
      }
    }

    // Use case insights
    if (insights.use_cases?.length > 0) {
      for (const useCase of insights.use_cases) {
        records.push({
          rental_id: rentalId,
          archive_id: archiveId,
          insight_type: 'marketing_angle',
          category: 'use_case',
          content: useCase,
          confidence: 0.8,
          is_actionable: true,
          suggested_action: `Consider marketing gear bundles for ${useCase} projects`,
        });
      }
    }

    // Objection patterns
    if (insights.key_objections?.length > 0) {
      for (const objection of insights.key_objections) {
        records.push({
          rental_id: rentalId,
          archive_id: archiveId,
          insight_type: 'objection_pattern',
          category: 'renter_concern',
          content: objection,
          confidence: 0.75,
          is_actionable: true,
          suggested_action: 'Review pricing/policy to address this common concern',
        });
      }
    }

    // Marketing angles
    if (insights.marketing_angles?.length > 0) {
      for (const angle of insights.marketing_angles) {
        records.push({
          rental_id: rentalId,
          archive_id: archiveId,
          insight_type: 'marketing_angle',
          category: 'hook',
          content: angle,
          confidence: 0.7,
          is_actionable: true,
          suggested_action: angle,
        });
      }
    }

    // Renter behavior
    if (insights.renter_tone || insights.pricing_sensitivity) {
      records.push({
        rental_id: rentalId,
        archive_id: archiveId,
        insight_type: 'renter_behavior',
        category: 'profile',
        content: `Tone: ${insights.renter_tone || 'unknown'}, Price sensitivity: ${insights.pricing_sensitivity || 'unknown'}`,
        confidence: 0.7,
        is_actionable: false,
      });
    }

    return records;
  }
}
