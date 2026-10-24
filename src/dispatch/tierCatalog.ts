import { listTierOptions, resolveTierSelector, TIER_ORDER } from './tierRouter.js';
import type { DispatchTier, ResolvedTier, ResolvedTiers } from './tierRouter.js';

/**
 * tierCatalog.ts — derive the 贵/中/便宜 tiers from the models that are already
 * configured, with no UI and no stored selection.
 *
 * Why this exists: the tiers used to be filled in by hand (a settings panel, or
 * `/省钱分级 贵=… 便宜=…`). Once the panel is gone there is no honest way to keep
 * demanding that input — the machine already knows its providers, their keys and
 * their model ids. So the mapping is derived from the registry, and an explicit
 * selection (the CLI command, or a caller passing tiers in) still wins when it
 * exists.
 *
 * The classifier is deliberately dumb and auditable: a table of naming patterns
 * over model ids, cheap matches first (a `…-flash-mini` is cheap, not
 * expensive), then expensive, else standard. Prices are not in
 * `~/.zcode/v2/config.json`, so a name table is the only signal available
 * without inventing numbers — and a wrong guess here costs a little quality or a
 * little money, never correctness: every tier is a real, credentialed model and
 * the chain fails over on availability faults.
 */

/**
 * Naming patterns, cheap first. The order is the policy: `glm-5.3-flash` must
 * land in `cheap` even though `5.3` is a flagship generation, and
 * `deepseek-v4-pro` must land in `expensive` even though `deepseek` also
 * publishes cheap models.
 */
const CHEAP_PATTERNS: RegExp[] = [
  /(^|[-_.\s])(flash|lite|air|mini|nano|small|tiny|light|instant)([-_.\s]|$)/i,
  /\bhaiku\b/i,
  /[a-z]+\d*[-_.]?turbo\b/i,
  /(^|[-_.\s])fast([-_.\s]|$)/i,
  /(^|[-_.\s])cheap([-_.\s]|$)/i,
];

const EXPENSIVE_PATTERNS: RegExp[] = [
  /\bopus\b/i,
  /\bultra\b/i,
  /(^|[-_.\s])max([-_.\s]|$)/i,
  /(^|[-_.\s])pro([-_.\s]|$)/i,
  /\bthinking\b/i,
  /\breasoner\b/i,
  /(^|[-_.\s])o[134]([-_.\s]|$)/i,
  /\bsonnet\b/i,
  /\b(glm|gpt|qwen|deepseek|kimi|doubao|claude)[-_.]?([5-9](\.[0-9]+)?)([-_.\s]|$)/i,
];

/**
 * Which tier a model id belongs to.
 *
 * Exported for tests and for the doctor output; pure, no IO.
 */
export function classifyModelTier(model: string): DispatchTier {
  const id = model.trim();
  if (!id) return 'standard';
  // Cheap wins ties: `gpt-5.5-mini` is cheap even though `5.5` looks flagship.
  if (CHEAP_PATTERNS.some((pattern) => pattern.test(id))) return 'cheap';
  if (EXPENSIVE_PATTERNS.some((pattern) => pattern.test(id))) return 'expensive';
  return 'standard';
}

export type DerivedTiers = {
  tiers: ResolvedTiers;
  /** Human-readable one-liner per tier, for the CLI's `/status` and tests. */
  notes: string[];
};

/** How many fallbacks a derived chain keeps. Enough to survive a rate limit. */
const MAX_CHAIN = 3;

/**
 * Derive the tier chains from configured providers.
 *
 * Rules, in order:
 *   1. Only credentialed providers are used — dispatch to a keyless entry fails
 *      authentication at request time, which is worse than not dispatching.
 *   2. A model that appears under several providers is kept once (the first,
 *      i.e. the credentialed one), because the tier is about the model, not the
 *      reseller.
 *   3. `active` (the model the user actually selected) is pinned to the front of
 *      its own tier: a user who picked GLM-5.3 must not silently be served by
 *      something else just because derivation ranked it second.
 *   4. Nothing is derived unless at least two tiers and two distinct models are
 *      available — one model across three tiers is not tiering, it is a lie in
 *      the ledger.
 */
export function deriveTiers(options: { activeModel?: string; activeProviderName?: string; activeProviderId?: string; configPath?: string } = {}): DerivedTiers | null {
  const options_ = listTierOptions(options.configPath).filter((option) => option.hasKey);
  if (options_.length === 0) return null;

  const byTier = new Map<DispatchTier, typeof options_>();
  const seenModels = new Set<string>();
  for (const option of options_) {
    const key = option.model.trim().toLowerCase();
    if (seenModels.has(key)) continue;
    seenModels.add(key);
    const tier = classifyModelTier(option.model);
    const bucket = byTier.get(tier) ?? [];
    bucket.push(option);
    byTier.set(tier, bucket);
  }

  // Pin the active model to the front of its own tier.
  const activeModel = options.activeModel?.trim().toLowerCase();
  if (activeModel) {
    for (const [tier, bucket] of byTier) {
      const index = bucket.findIndex((option) => option.model.trim().toLowerCase() === activeModel);
      if (index > 0) {
        const [pinned] = bucket.splice(index, 1);
        if (pinned) bucket.unshift(pinned);
      }
      byTier.set(tier, bucket);
    }
  }

  const tiers: ResolvedTiers = {};
  const notes: string[] = [];
  for (const tier of TIER_ORDER) {
    const bucket = byTier.get(tier);
    if (!bucket || bucket.length === 0) continue;
    const chain: ResolvedTier[] = [];
    for (const option of bucket.slice(0, MAX_CHAIN)) {
      const resolved = resolveTierSelector(`${option.providerId}/${option.model}`, tier, options.configPath);
      // A model the /status list just showed must resolve; if it does not, the
      // registry changed under us and skipping it is better than failing the tier.
      if ('error' in resolved) continue;
      chain.push(resolved);
    }
    if (chain.length === 0) continue;
    tiers[tier] = chain;
    notes.push(`${tier}: ${chain.map((entry) => `${entry.providerName}/${entry.model}`).join(' → ')}`);
  }

  const tierCount = Object.keys(tiers).length;
  const distinctModels = new Set(Object.values(tiers).flatMap((chain) => chain.map((entry) => entry.model))).size;
  if (tierCount < 2 || distinctModels < 2) return null;
  return { tiers, notes };
}
