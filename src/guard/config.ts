import type { GuardMetrics, LazyDevGuardConfig, LazyDevGuardState, LazyDevStrictness } from './types.js';

const DEFAULT_MAX_ATTEMPTS = 2;
const MIN_MAX_ATTEMPTS = 1;
const MAX_MAX_ATTEMPTS = 3;

export function defaultLazyDevGuardConfig(): LazyDevGuardConfig {
  return {
    enabledByDefault: false,
    strictness: 'standard',
    defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
    domainConfidenceThreshold: 0.55,
    allowPopupConfirmation: true,
    allowTerminalFallback: true,
    riskThresholds: {
      low: 0,
      medium: 0.35,
      high: 0.7,
      critical: 0.9,
    },
  };
}

export function createInitialLazyDevGuardState(config: Partial<LazyDevGuardConfig> = {}): LazyDevGuardState {
  const defaults = defaultLazyDevGuardConfig();
  const resolved = { ...defaults, ...config };
  return {
    enabled: true,
    config: resolved,
    history: [],
    masteredConcepts: [],
    metrics: createEmptyGuardMetrics(),
  };
}

export function createEmptyGuardMetrics(): GuardMetrics {
  return {
    totalChecks: 0,
    passedFirstTry: 0,
    passedAfterRetry: 0,
    blocked: 0,
    cancelled: 0,
    archived: 0,
    riskDistribution: {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    },
    domainDistribution: {},
  };
}

export function parseStrictness(value: string): LazyDevStrictness | undefined {
  switch (value) {
    case '新手':
    case 'beginner':
      return 'beginner';
    case '标准':
    case 'standard':
      return 'standard';
    case '老手':
    case 'experienced':
      return 'experienced';
    case '只翻译':
    case 'translationOnly':
    case 'translation-only':
      return 'translationOnly';
    default:
      return undefined;
  }
}

export function clampMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < MIN_MAX_ATTEMPTS || value > MAX_MAX_ATTEMPTS) {
    throw new Error(`max attempts must be an integer from ${MIN_MAX_ATTEMPTS} to ${MAX_MAX_ATTEMPTS}`);
  }
  return value;
}
