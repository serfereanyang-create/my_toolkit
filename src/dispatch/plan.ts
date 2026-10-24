import type { AgentRuntime } from '../agent/agent.js';
import { resolveTiers, TIER_ORDER } from './tierRouter.js';
import type { DispatchTier, ResolvedTiers } from './tierRouter.js';
import { deriveTiers } from './tierCatalog.js';
import { tierProvider } from './tierProvider.js';

/**
 * plan.ts — the per-turn dispatch plan: which tiers exist, and one provider per
 * tier (built once, reused by every call that lands on it).
 *
 * Resolving is deliberately done once per turn rather than once per call: it
 * reads a config file and builds provider clients, neither of which should
 * happen on every step, and a plan that changed mid-turn would make the ledger
 * lie about what actually ran.
 */

/** `AICODE_DISPATCH=0` turns the whole thing off (perf work, debugging, benchmarks). */
function dispatchEnabledByEnv(): boolean {
  const raw = (process.env.AICODE_DISPATCH ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

export type DispatchSource = 'session' | 'derived';

export type DispatchPlan = {
  source: DispatchSource;
  tiers: ResolvedTiers;
  /** Whether this plan can serve the given tier (directly or via its nearest). */
  has(tier: DispatchTier): boolean;
  /**
   * The tier actually used for a requested one.
   *
   * A plan may legitimately hold only two of three tiers (a machine with one
   * flagship and one small model has no "standard"). Dropping the call to the
   * parent model in that case would throw away the routing decision entirely,
   * so the request slides to the nearest configured tier — up first, because
   * being slightly over-provisioned is a cheaper mistake than a bad answer.
   */
  nearest(tier: DispatchTier): DispatchTier | undefined;
  providerFor(tier: DispatchTier): AgentRuntime['provider'] | undefined;
  labelFor(tier: DispatchTier): string;
  describe(): string;
};

/**
 * The tier selection in force: an explicit one wins, otherwise it is derived
 * from whatever providers are configured.
 *
 * Exported because the sub-agent runner asks the same question; two
 * implementations of "which tiers are live" is how the delegation path and the
 * main loop ended up disagreeing before.
 */
export function resolveDispatchSelection(
  runtime: Pick<AgentRuntime, 'session' | 'config' | 'provider'>,
): { tiers: ResolvedTiers; source: DispatchSource } | null {
  const explicit = runtime.session.dispatch;
  if (explicit) {
    const resolved = resolveTiers(explicit, runtime.config.dispatchConfigPath);
    if (!('error' in resolved) && Object.keys(resolved).length > 0) {
      return { tiers: resolved, source: 'session' };
    }
  }
  const derived = deriveTiers({
    activeModel: runtime.config.model,
    activeProviderName: runtime.provider.name,
    configPath: runtime.config.dispatchConfigPath,
  });
  if (!derived) return null;
  return { tiers: derived.tiers, source: 'derived' };
}

/**
 * Build this turn's plan, or null when dispatch is off / impossible.
 *
 * Off means off explicitly (env, config flag) or *structurally*: the mock
 * provider is a scripted fixture and must never be swapped for a real model, and
 * a plan with a single tier would add a ledger field without changing behaviour.
 */
export function createDispatchPlan(
  runtime: Pick<AgentRuntime, 'session' | 'config' | 'provider' | 'ui'>,
  options: { enabled?: boolean } = {},
): DispatchPlan | null {
  if (options.enabled === false) return null;
  if (!dispatchEnabledByEnv()) return null;
  if (runtime.config.dispatch === false) return null;
  // Opt-in at the runtime level. `resolveConfig` turns it on for a real run;
  // a runtime built by hand (tests, fixtures, embedders) stays on one model
  // unless it says otherwise — deriving tiers from the *user's* live provider
  // registry and then calling it would be a network dependency in every test.
  if (runtime.config.dispatch !== true && runtime.config.dispatchConfigPath === undefined) return null;
  // The mock provider is how tests and `--provider mock` drive the loop; routing
  // it to a real model would turn every smoke run into live API traffic.
  if (runtime.provider.name === 'mock') return null;

  const selection = resolveDispatchSelection(runtime);
  if (!selection) return null;
  const { tiers, source } = selection;
  if (Object.keys(tiers).length === 0) return null;

  const providers = new Map<DispatchTier, AgentRuntime['provider']>();
  const plan: DispatchPlan = {
    source,
    tiers,
    has: (tier) => (tiers[tier]?.length ?? 0) > 0,
    nearest(tier) {
      if (plan.has(tier)) return tier;
      const index = TIER_ORDER.indexOf(tier);
      // Try one rung up, then the rest downwards, then anything left.
      const order = [
        TIER_ORDER[index - 1],
        ...TIER_ORDER.slice(index + 1),
        ...TIER_ORDER.slice(0, index - 1),
      ].filter((candidate): candidate is DispatchTier => Boolean(candidate));
      return order.find((candidate) => plan.has(candidate));
    },
    providerFor(tier) {
      const cached = providers.get(tier);
      if (cached) return cached;
      const chain = tiers[tier];
      if (!chain || chain.length === 0) return undefined;
      // The chain walks on availability faults (429/5xx/auth/network) and
      // surfaces everything else: see tierProvider.
      const provider = tierProvider(runtime.config, chain, (failed, next, error) => {
        runtime.ui?.info(
          `[dispatch] ${failed.providerName}/${failed.model} 不可用（${error instanceof Error ? error.message : String(error)}），降级到 ${next.providerName}/${next.model}`,
        );
      });
      providers.set(tier, provider);
      return provider;
    },
    labelFor(tier) {
      const primary = tiers[tier]?.[0];
      if (!primary) return tier;
      return `${primary.providerName}/${primary.model}`;
    },
    describe() {
      return TIER_ORDER
        .filter((tier) => plan.has(tier))
        .map((tier) => `${tier}=${plan.labelFor(tier)}`)
        .join('，');
    },
  };
  return plan;
}
