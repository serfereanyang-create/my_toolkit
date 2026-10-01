export type LazyDevStrictness = 'beginner' | 'standard' | 'experienced' | 'translationOnly';

export type GuardRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type RequirementStatus =
  | 'translating'
  | 'awaiting_translation_confirm'
  | 'checking'
  | 'passed'
  | 'blocked'
  | 'learning'
  | 'cancelled'
  | 'archived';

export type ProfessionalRequirementField = {
  name: string;
  value: string;
};

export type ProfessionalRequirement = {
  summary: string;
  fields: ProfessionalRequirementField[];
  incomplete: boolean;
  missingFields?: string[];
  assumptions?: string[];
};

export type DomainMatch = {
  adapterId: string;
  label: string;
  confidence: number;
  reasons: string[];
};

export type GuardQuestion = {
  id: string;
  prompt: string;
  kind: 'multiple-choice' | 'short-answer' | 'decision';
  concept: string;
  options?: Array<{ label: string; text: string; correct: boolean; explanation: string }>;
  expectedKeywords?: string[];
};

export type BlockedRecovery = {
  learningTasks: string[];
  resumeCondition: 'answer-new-question' | 'explain-in-own-words' | 'rewrite-requirement';
  resumeCommand: '/不准偷懒开发 继续';
};

export type LearningCredit = {
  concept: string;
  passedCount: number;
  lastPassedAt: string;
  domains: string[];
};

export type GuardMetrics = {
  totalChecks: number;
  passedFirstTry: number;
  passedAfterRetry: number;
  blocked: number;
  cancelled: number;
  archived: number;
  riskDistribution: Record<GuardRiskLevel, number>;
  domainDistribution: Record<string, number>;
};

export type LazyDevGuardConfig = {
  enabledByDefault: boolean;
  strictness: LazyDevStrictness;
  defaultMaxAttempts: number;
  domainConfidenceThreshold: number;
  allowPopupConfirmation: boolean;
  allowTerminalFallback: boolean;
  riskThresholds: Record<GuardRiskLevel, number>;
};

export type LazyDevPause = {
  reason: string;
  createdAt: string;
  resumeHint: string;
};

export type LazyDevRequirement = {
  id: string;
  originalPrompt: string;
  translatedRequirement: ProfessionalRequirement;
  domainMatches: DomainMatch[];
  riskLevel: GuardRiskLevel;
  status: RequirementStatus;
  attemptsUsed: number;
  maxAttempts: number;
  askedQuestionIds: string[];
  lastQuestion?: GuardQuestion;
  blockedReason?: string;
  recovery?: BlockedRecovery;
  createdAt: string;
  updatedAt: string;
};

export type LazyDevRequirementSummary = {
  id: string;
  originalPrompt: string;
  status: RequirementStatus;
  riskLevel: GuardRiskLevel;
  domainLabels: string[];
  createdAt: string;
  updatedAt: string;
};

export type LazyDevGuardState = {
  enabled: boolean;
  config: LazyDevGuardConfig;
  paused?: LazyDevPause;
  currentRequirement?: LazyDevRequirement;
  history: LazyDevRequirementSummary[];
  metrics: GuardMetrics;
  masteredConcepts: LearningCredit[];
};

/**
 * Confirmation channel types (design: popup first, terminal menu fallback).
 * They live here so both the guard core and the confirm module share one
 * definition; confirm.ts owns the transport, not the shape.
 */
export type GuardConfirmationOption = { label: string; description: string };

export type GuardConfirmationRequest = {
  title: string;
  question: string;
  options: GuardConfirmationOption[];
  /** How long to wait for a popup answer before falling back to the terminal. */
  popupTimeoutMs?: number;
};

export type GuardConfirmationResult = {
  selectedLabel: string;
  source: 'popup' | 'terminal' | 'auto';
};

/** Popup transport: emit a request, resolve with the picked option label. */
export type GuardConfirmationTransport = (
  request: GuardConfirmationRequest,
) => Promise<GuardConfirmationResult | null>;

export type GuardConfirmationChannelOptions = {
  /** Popup transport (desktop bridge). Absent in a plain terminal session. */
  popup?: GuardConfirmationTransport;
  /** Terminal reader: shows numbered options, resolves with the raw answer. */
  terminal?: (text: string) => Promise<string | null>;
  /** How long the popup may take before the terminal fallback takes over. */
  timeoutMs?: number;
  /** When true, unanswered popups resolve with the first option (default). */
  autoSelectFirstOnTimeout?: boolean;
};

/** Ask the user to pick one option; popup first, terminal as the fallback. */
export type GuardConfirmationChannel = {
  /** Resolves null when the popup went unanswered — the caller falls back. */
  confirm(request: GuardConfirmationRequest): Promise<GuardConfirmationResult | null>;
};
