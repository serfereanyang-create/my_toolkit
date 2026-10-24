import type { AgentRuntime } from '../agent/agent.js';
import { createProvider } from '../providers/index.js';
import type { ResolvedTier } from './tierRouter.js';

/**
 * tierProvider.ts — run a turn on a dispatch tier's provider chain.
 *
 * Lifted out of the sub-agent runner when per-call dispatch arrived: the main
 * agent loop and the sub-agent runner now share one fail-over implementation,
 * because two copies of "walk the chain on 429 but not on 400" is exactly the
 * kind of policy that drifts. The sub-agent runner re-exports these names so
 * existing importers keep working.
 */

export function configForTier(parentConfig: AgentRuntime['config'], resolved: ResolvedTier): AgentRuntime['config'] {
  const { baseUrl: _parentBaseUrl, apiKey: _parentApiKey, ...sharedConfig } = parentConfig;
  return {
    ...sharedConfig,
    provider: resolved.provider as AgentRuntime['config']['provider'],
    model: resolved.model,
    ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
    ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
  };
}

/**
 * A provider that walks the tier's ordered chain.
 *
 * The settings UI promises "第一个是主选，其余在限流/失败时按顺序降级" and the
 * router resolves the whole chain, but only chain[0] was ever used — the
 * fallbacks were dead. Failing over is only correct for *availability* faults
 * (rate limit, 5xx, quota, network): a 400 from a request the fallback would
 * reject identically must surface instead of silently burning a second model.
 * User cancellation is never a reason to fail over.
 */
export function tierProvider(
  parentConfig: AgentRuntime['config'],
  chain: ResolvedTier[],
  onFallback?: (failed: ResolvedTier, next: ResolvedTier, error: unknown) => void,
): AgentRuntime['provider'] {
  const infos = chain.map((entry) => ({
    entry,
    provider: createProvider(configForTier(parentConfig, entry)),
  }));
  // Provider.name/model are read by the turn's usage bookkeeping, so whichever
  // chain member actually answered must be visible there.
  const identity = { name: infos[0].provider.name, model: infos[0].provider.model };
  const complete: AgentRuntime['provider']['complete'] = async (request) => {
    const answered = await completeWithFallback(
      infos,
      (provider) => provider.complete(request),
      onFallback,
    );
    identity.name = answered.provider.name;
    identity.model = answered.provider.model;
    return answered.value;
  };
  return new Proxy(identity as AgentRuntime['provider'], {
    get(target, prop, receiver) {
      if (prop === 'complete') return complete;
      return Reflect.get(target, prop, receiver);
    },
  }) as AgentRuntime['provider'];
}

/**
 * Walk an ordered provider chain until one answers.
 *
 * Split out from tierProvider so the fail-over policy can be tested without
 * standing up real providers: the caller supplies the actual call. Identity of
 * the provider that answered is returned alongside the value so callers can
 * keep name/model bookkeeping in sync.
 */
export async function completeWithFallback<T>(
  members: Array<{ entry: ResolvedTier; provider: AgentRuntime['provider'] }>,
  call: (provider: AgentRuntime['provider']) => Promise<T>,
  onFallback?: (failed: ResolvedTier, next: ResolvedTier, error: unknown) => void,
): Promise<{ value: T; provider: AgentRuntime['provider'] }> {
  let lastError: unknown;
  for (let index = 0; index < members.length; index += 1) {
    const { entry, provider } = members[index];
    try {
      const value = await call(provider);
      return { value, provider };
    } catch (error) {
      lastError = error;
      const next = members[index + 1];
      if (!next || !isFallbackWorthy(error)) throw error;
      onFallback?.(entry, next.entry, error);
    }
  }
  throw lastError;
}

/**
 * Whether a failure should move down the tier's fallback chain.
 *
 * 429 (rate limit), 5xx, auth/quota (401/402/403), 404 (a model a proxy does
 * not serve) and transport faults qualify. A 400/422 is a malformed request
 * that would fail identically on every member of the chain, so it must not
 * silently consume a second model.
 */
export function isFallbackWorthy(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'AbortError' || name === 'CancelledError' || name === 'AgentCancelledError') return false;
  const status = statusFromFallbackError(error);
  if (typeof status === 'number') {
    return [401, 402, 403, 404, 408, 429].includes(status) || (status >= 500 && status <= 599);
  }
  const message = String((error as { message?: string } | null)?.message ?? error ?? '').toLowerCase();
  return [
    'econnreset',
    'econnrefused',
    'etimedout',
    'epipe',
    'eai_again',
    'enotfound',
    'socket hang up',
    'fetch failed',
    'network',
    'premature close',
    'timed out',
    'timeout',
    'terminated',
  ].some((needle) => message.includes(needle));
}

function statusFromFallbackError(error: unknown): number | undefined {
  const direct = (error as { status?: number; statusCode?: number } | null)?.status
    ?? (error as { statusCode?: number } | null)?.statusCode;
  if (typeof direct === 'number') return direct;
  const message = String((error as { message?: string } | null)?.message ?? error ?? '');
  const match = message.match(/\b(?:HTTP\s+|status\s*[:=]\s*|failed\s*:\s*)(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}
