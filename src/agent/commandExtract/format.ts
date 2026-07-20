import type { CommandPlan, ExtractionResult } from './types.js';

export function formatCommandStrategy(plan: CommandPlan, extraction: ExtractionResult): string {
  const slotEntries = Object.entries(extraction.slots)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}:${String(value)}`);
  return [
    'Tool strategy:',
    `intent=${extraction.intent}`,
    `confidence=${extraction.confidence}`,
    plan.recommendedTools.length ? `recommended=${plan.recommendedTools.join(', ')}` : undefined,
    plan.avoidTools.length ? `avoid=${plan.avoidTools.join(', ')}` : undefined,
    `reason=${plan.reason}`,
    slotEntries.length ? `slots=${slotEntries.join(', ')}` : undefined,
    extraction.reasons.length ? `extractReasons=${extraction.reasons.join(' | ')}` : undefined,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}
