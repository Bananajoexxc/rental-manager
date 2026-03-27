// AutoLearn Engine — Types, Interfaces, Constants

export enum AnalyzerType {
  VIOLATION = 'violation',
  QUALITY = 'quality',
  CONVERSION = 'conversion',
  TOKEN = 'token',
  CORRECTION = 'correction',
}

export enum ChangeType {
  RULE_ADD = 'rule_add',
  RULE_EDIT = 'rule_edit',
  RULE_DEACTIVATE = 'rule_deactivate',
  PROMPT_EDIT = 'prompt_edit',
  THRESHOLD_ADJUST = 'threshold_adjust',
}

export enum ProposalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  VETOED = 'vetoed',
  APPLIED = 'applied',
  ROLLED_BACK = 'rolled_back',
  EXPIRED = 'expired',
  REWORK = 'rework',
  FAILED = 'failed',
}

export enum LogEventType {
  CYCLE_START = 'cycle_start',
  CYCLE_END = 'cycle_end',
  APPLIED = 'applied',
  VETOED = 'vetoed',
  ROLLBACK = 'rollback',
  DAILY_SUMMARY = 'daily_summary',
  REWORK_ATTEMPT = 'rework_attempt',
  REWORK_SUCCESS = 'rework_success',
  REWORK_EXHAUSTED = 'rework_exhausted',
  FINDINGS_SENT = 'findings_sent',
}

export interface ProposalDraft {
  analyzer: AnalyzerType;
  changeType: ChangeType;
  targetEntity: string; // e.g. 'rule:pricing:Bundle_Rec' or 'prompt:communication_style'
  description: string;
  changePayload: {
    before: any;
    after: any;
    metadata?: Record<string, any>;
  };
}

export interface ShadowTestResult {
  replayed: number;
  improved: number;
  degraded: number;
  neutral: number;
  avgQualityDelta: number;
}

export interface CycleData {
  unanalyzedDecisions: any[];
  qualityScores: any[];
  validationLogs: any[];
  errorLogs: any[];
  followUpStates: any[];
  danielCorrections: any[];
}

// Safety constraints
export const SAFETY = {
  MAX_PROPOSALS_PER_CYCLE: 5,
  MAX_PROPOSALS_PER_DAY: 15,
  VETO_WINDOW_MINUTES: 0, // Auto-apply: no veto window, shadow tests are the gate
  ROLLBACK_QUALITY_THRESHOLD: 0.10, // 10% drop triggers rollback
  SHADOW_TEST_SAMPLE_SIZE: 5, // Reduced from 20 — 5 samples sufficient for regression detection
  MIN_VIOLATIONS_FOR_RULE: 3,
  MAX_SNAPSHOTS_RETAINED: 50,
  PROTECTED_COMPONENTS: ['security_rules', 'critical_rules'] as readonly string[],
  MIN_PROTECTED_RULE_PRIORITY: 9,
  QUALITY_FLOOR: 0.7,
  MAX_REWORK_ATTEMPTS: 2, // Reduced from 10 — reject unimprovable proposals faster
  MAX_REWORKS_PER_RUN: 3, // Reduced from 10 — fewer reworks per cycle
} as const;

export interface CycleFinding {
  analyzer: string;
  description: string;
  shadowResult?: ShadowTestResult;
  status: 'passed' | 'failed_shadow' | 'blocked_safety' | 'error';
}

// Config keys with defaults
export const CONFIG_DEFAULTS: Record<string, string> = {
  'autolearn.enabled': 'true',
  'autolearn.paused': 'false',
  'autolearn.max_proposals_per_cycle': String(SAFETY.MAX_PROPOSALS_PER_CYCLE),
  'autolearn.max_proposals_per_day': String(SAFETY.MAX_PROPOSALS_PER_DAY),
  'autolearn.veto_window_minutes': String(SAFETY.VETO_WINDOW_MINUTES),
  'autolearn.rollback_quality_threshold': String(SAFETY.ROLLBACK_QUALITY_THRESHOLD),
  'autolearn.shadow_test_sample_size': String(SAFETY.SHADOW_TEST_SAMPLE_SIZE),
  'autolearn.max_rework_attempts': String(SAFETY.MAX_REWORK_ATTEMPTS),
  'autolearn.findings_notifications': 'true',
  'validation.price_floor': '5',
  'validation.price_ceiling': '500',
  'validation.quality_threshold': String(SAFETY.QUALITY_FLOOR),
  // Cron Claude defaults
  'cron_claude.enabled': 'false',
  'cron_claude.frequency_minutes': '240',
  'cron_claude.tasks': 'message_audit',
  'cron_claude.quiet_hours_start': '2',
  'cron_claude.quiet_hours_end': '7',
  'cron_claude.model': 'claude-sonnet-4-6-20250514',
};
