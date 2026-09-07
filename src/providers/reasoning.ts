import type { ReasoningEffort } from './types.js';

/*
 * Provider-agnostic reasoning/thinking effort → native parameter mapping.
 *
 * The desktop UI offers four visible tiers (极高/高/中/低) plus an implicit
 * "off". Each provider has a different native knob:
 *   - Anthropic: extended thinking via `thinking: { type: 'enabled',
 *     budget_tokens: N }`. Requires `max_tokens > budget_tokens`.
 *   - OpenAI: `reasoning_effort: 'low' | 'medium' | 'high'` (no numeric budget).
 *
 * These mappings are best-effort: a custom/proxy endpoint may not support the
 * parameter at all. The providers send it and, on a 4xx that names the
 * thinking/reasoning field, retry once WITHOUT it (see each provider's
 * downgrade path). This keeps real behaviour honest — we never pretend a tier
 * took effect when the endpoint rejected it.
 */

/** Anthropic thinking budget in tokens for each tier. 0/undefined = disabled. */
export function anthropicThinkingBudget(effort: ReasoningEffort | undefined): number | undefined {
  switch (effort) {
    case 'low':
      return 2_048;
    case 'medium':
      return 6_144;
    case 'high':
      return 12_288;
    case 'max':
      return 24_576;
    case 'off':
    case undefined:
    default:
      return undefined;
  }
}

/**
 * Anthropic requires max_tokens > budget_tokens. Given a thinking budget, return
 * a max_tokens that leaves room for a real answer on top of the thinking.
 */
export function anthropicMaxTokensFor(budget: number | undefined, base = 2_048): number {
  if (!budget) return base;
  return budget + base;
}

/**
 * Ready-to-send Anthropic `thinking` object for a tier, or undefined to omit the
 * parameter entirely. The provider spreads this straight into the request body.
 */
export function anthropicThinking(
  effort: ReasoningEffort | undefined,
): { type: 'enabled'; budget_tokens: number } | undefined {
  const budget = anthropicThinkingBudget(effort);
  if (!budget) return undefined;
  return { type: 'enabled', budget_tokens: budget };
}

/** OpenAI reasoning_effort value for each tier, or undefined to omit. */
export function openaiReasoningEffort(effort: ReasoningEffort | undefined): 'low' | 'medium' | 'high' | undefined {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'max':
      // OpenAI has no tier above 'high'; 极高 maps to 'high' (highest real value).
      return 'high';
    case 'off':
    case undefined:
    default:
      return undefined;
  }
}

/**
 * Detect whether an API error body is complaining specifically about the
 * thinking/reasoning parameter, so the provider can retry once without it
 * instead of failing the whole turn. Conservative: only matches when the error
 * text names the field.
 */
export function isReasoningParamRejection(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes('thinking') ||
    lower.includes('budget_tokens') ||
    lower.includes('reasoning_effort') ||
    lower.includes('reasoning')
  );
}
