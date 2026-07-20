import type { GitUnitContext, GitUnitResult } from './types.js';

export function formatGitSafetyStatus(context: GitUnitContext | GitUnitResult): string {
  if (context.protectionMode === 'file-checkpoint-only') {
    return `Git safety: file-checkpoint-only for ${context.unitId}`;
  }
  const baseline = context.baseline ? shortId(context.baseline.commit) : 'none';
  const result = 'result' in context && context.result ? shortId(context.result.commit) : 'pending';
  return `Git safety: git-protected ${context.unitId} baseline=${baseline} result=${result}`;
}

export function formatGitSafetyWarning(message: string): string {
  return `Git safety warning: ${message}`;
}

function shortId(value: string): string {
  return value.slice(0, 12);
}
