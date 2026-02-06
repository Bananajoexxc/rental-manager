import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RulesService } from '../rules/rules.service';
import { PromptManagerService } from '../prompts/prompt-manager.service';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigManagerService } from './config-manager.service';
import { ProposalStatus, LogEventType, SAFETY } from './autolearn.types';

@Injectable()
export class RollbackManagerService {
  private readonly logger = new Logger(RollbackManagerService.name);

  constructor(
    private prisma: PrismaService,
    private rulesService: RulesService,
    private promptManager: PromptManagerService,
    @Inject(forwardRef(() => TelegramService)) private telegramService: TelegramService,
    private configManager: ConfigManagerService,
  ) {}

  /**
   * Apply a proposal: snapshot current state, then execute the change
   */
  async apply(proposalId: string): Promise<void> {
    const proposal = await this.prisma.autolearn_proposal.findUnique({
      where: { id: proposalId },
    });

    if (!proposal || proposal.status !== ProposalStatus.PENDING) {
      this.logger.warn(`Cannot apply proposal ${proposalId}: not found or not pending (status: ${proposal?.status})`);
      return;
    }

    const payload = proposal.change_payload as any;

    try {
      // Create snapshot of current state
      await this.createSnapshot(proposalId, proposal.change_type, proposal.target_entity);

      // Execute the change
      switch (proposal.change_type) {
        case 'rule_add': {
          const { category, name, content, priority } = payload.after;
          await this.rulesService.addRule(category, name, content, priority ?? 50);
          break;
        }

        case 'rule_edit': {
          // Find and update the rule
          const rules = await this.rulesService.getAllActive();
          const targetRule = rules.find(r =>
            proposal.target_entity.includes(r.name) || proposal.target_entity.includes(r.id),
          );
          if (targetRule) {
            await this.prisma.rule.update({
              where: { id: targetRule.id },
              data: { content: payload.after.content || payload.after },
            });
          }
          break;
        }

        case 'rule_deactivate': {
          const rules = await this.rulesService.getAllActive();
          const targetRule = rules.find(r =>
            proposal.target_entity.includes(r.name) || proposal.target_entity.includes(r.id),
          );
          if (targetRule) {
            await this.rulesService.deactivateRule(targetRule.id);
          }
          break;
        }

        case 'prompt_edit': {
          const componentName = proposal.target_entity.replace('prompt:', '');
          await this.promptManager.updateComponent(componentName, payload.after);
          break;
        }

        case 'threshold_adjust': {
          const key = proposal.target_entity.replace('config:', '');
          await this.configManager.set(key, String(payload.after));
          break;
        }
      }

      // Update proposal status
      await this.prisma.autolearn_proposal.update({
        where: { id: proposalId },
        data: { status: ProposalStatus.APPLIED, applied_at: new Date() },
      });

      // Log
      await this.prisma.autolearn_log.create({
        data: {
          proposal_id: proposalId,
          event_type: LogEventType.APPLIED,
          details: { change_type: proposal.change_type, target: proposal.target_entity },
        },
      });

      this.logger.log(`Applied proposal ${proposalId}: ${proposal.description}`);
    } catch (err) {
      this.logger.error(`Failed to apply proposal ${proposalId}: ${err.message}`);
    }
  }

  /**
   * Rollback a proposal: restore from snapshot
   */
  async rollback(proposalId: string, reason: string): Promise<void> {
    const snapshots = await this.prisma.autolearn_snapshot.findMany({
      where: { proposal_id: proposalId },
    });

    const proposal = await this.prisma.autolearn_proposal.findUnique({
      where: { id: proposalId },
    });

    if (!proposal) return;

    try {
      for (const snapshot of snapshots) {
        const data = snapshot.snapshot_data as any;

        switch (snapshot.entity_type) {
          case 'rule': {
            if (proposal.change_type === 'rule_add') {
              // Deactivate the added rule
              const rules = await this.rulesService.getAllActive();
              const addedRule = rules.find(r => {
                const payload = proposal.change_payload as any;
                return r.name === payload.after?.name;
              });
              if (addedRule) {
                await this.rulesService.deactivateRule(addedRule.id);
              }
            } else if (proposal.change_type === 'rule_deactivate') {
              // Re-activate the deactivated rule
              await this.prisma.rule.update({
                where: { id: snapshot.entity_id },
                data: { is_active: true, content: data.content },
              });
            } else {
              // Restore original content
              await this.prisma.rule.update({
                where: { id: snapshot.entity_id },
                data: { content: data.content },
              });
            }
            break;
          }

          case 'prompt_component': {
            await this.promptManager.updateComponent(data.name, data.content);
            break;
          }

          case 'bot_config': {
            await this.configManager.set(data.key, data.value);
            break;
          }
        }
      }

      // Update proposal status
      await this.prisma.autolearn_proposal.update({
        where: { id: proposalId },
        data: { status: ProposalStatus.ROLLED_BACK, rolled_back_at: new Date() },
      });

      // Log
      await this.prisma.autolearn_log.create({
        data: {
          proposal_id: proposalId,
          event_type: LogEventType.ROLLBACK,
          details: { reason },
        },
      });

      // Notify Daniel
      await this.telegramService.sendProactiveMessage(
        `*AutoLearn Rollback*\n\n` +
        `Proposal: ${proposal.description}\n` +
        `Reason: ${reason}\n` +
        `Status: Rolled back successfully`,
      );

      this.logger.log(`Rolled back proposal ${proposalId}: ${reason}`);
    } catch (err) {
      this.logger.error(`Rollback failed for ${proposalId}: ${err.message}`);
    }
  }

  /**
   * Check quality degradation for recently applied proposals
   */
  async checkDegradation(): Promise<void> {
    const threshold = await this.configManager.getFloat('autolearn.rollback_quality_threshold');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    // Check proposals applied in the last 2 hours (gives enough time for data to accumulate)
    const recentlyApplied = await this.prisma.autolearn_proposal.findMany({
      where: {
        status: ProposalStatus.APPLIED,
        applied_at: { gte: twoHoursAgo },
      },
    });

    if (recentlyApplied.length === 0) return;

    for (const proposal of recentlyApplied) {
      const appliedAt = proposal.applied_at!;
      const timeSinceApply = Date.now() - appliedAt.getTime();

      // Only check if at least 15 minutes have passed since apply
      if (timeSinceApply < 15 * 60 * 1000) continue;

      // Get quality scores before and after application
      const [beforeScores, afterScores] = await Promise.all([
        this.prisma.response_quality.findMany({
          where: {
            created_at: {
              gte: new Date(appliedAt.getTime() - 2 * 60 * 60 * 1000),
              lt: appliedAt,
            },
          },
        }),
        this.prisma.response_quality.findMany({
          where: {
            created_at: { gte: appliedAt },
          },
        }),
      ]);

      if (beforeScores.length < 2 || afterScores.length < 2) continue; // Need at least 2 data points

      const avgBefore = beforeScores.reduce((s, q) => s + q.overall_quality, 0) / beforeScores.length;
      const avgAfter = afterScores.reduce((s, q) => s + q.overall_quality, 0) / afterScores.length;
      const drop = avgBefore - avgAfter;

      if (drop > threshold) {
        this.logger.warn(
          `Quality drop detected after proposal ${proposal.id}: ${avgBefore.toFixed(3)} → ${avgAfter.toFixed(3)} (drop: ${drop.toFixed(3)})`,
        );
        await this.rollback(proposal.id, `Quality degradation: ${avgBefore.toFixed(2)} → ${avgAfter.toFixed(2)} (${(drop * 100).toFixed(1)}% drop)`);
      }
    }
  }

  /**
   * Cleanup old snapshots (retain last N)
   */
  async cleanupSnapshots(): Promise<void> {
    const maxSnapshots = SAFETY.MAX_SNAPSHOTS_RETAINED;
    const count = await this.prisma.autolearn_snapshot.count();

    if (count > maxSnapshots) {
      const oldSnapshots = await this.prisma.autolearn_snapshot.findMany({
        orderBy: { created_at: 'asc' },
        take: count - maxSnapshots,
        select: { id: true },
      });

      await this.prisma.autolearn_snapshot.deleteMany({
        where: { id: { in: oldSnapshots.map(s => s.id) } },
      });

      this.logger.log(`Cleaned up ${oldSnapshots.length} old snapshots`);
    }
  }

  private async createSnapshot(proposalId: string, changeType: string, targetEntity: string): Promise<void> {
    switch (changeType) {
      case 'rule_add': {
        // No prior state to snapshot for new rules, record empty
        await this.prisma.autolearn_snapshot.create({
          data: {
            proposal_id: proposalId,
            entity_type: 'rule',
            entity_id: 'new',
            snapshot_data: { was_new: true },
          },
        });
        break;
      }

      case 'rule_edit':
      case 'rule_deactivate': {
        const rules = await this.rulesService.getAllActive();
        const targetRule = rules.find(r =>
          targetEntity.includes(r.name) || targetEntity.includes(r.id),
        );
        if (targetRule) {
          await this.prisma.autolearn_snapshot.create({
            data: {
              proposal_id: proposalId,
              entity_type: 'rule',
              entity_id: targetRule.id,
              snapshot_data: { name: targetRule.name, category: targetRule.category, content: targetRule.content, priority: targetRule.priority },
            },
          });
        }
        break;
      }

      case 'prompt_edit': {
        const componentName = targetEntity.replace('prompt:', '');
        const component = await this.prisma.prompt_component.findFirst({
          where: { name: componentName, active: true },
        });
        if (component) {
          await this.prisma.autolearn_snapshot.create({
            data: {
              proposal_id: proposalId,
              entity_type: 'prompt_component',
              entity_id: component.id,
              snapshot_data: { name: component.name, content: component.content, version: component.version },
            },
          });
        }
        break;
      }

      case 'threshold_adjust': {
        const key = targetEntity.replace('config:', '');
        const value = await this.configManager.get(key);
        await this.prisma.autolearn_snapshot.create({
          data: {
            proposal_id: proposalId,
            entity_type: 'bot_config',
            entity_id: key,
            snapshot_data: { key, value },
          },
        });
        break;
      }
    }
  }
}
