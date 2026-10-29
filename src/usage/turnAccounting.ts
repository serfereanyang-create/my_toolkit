import type { DispatchTier } from '../dispatch/tierRouter.js';

/**
 * usage/turnAccounting.ts — the per-turn ledger rows, as pure functions.
 *
 * They live here rather than inline in `agent.ts` because the invariant they
 * have to satisfy is a cross-file one and it needs to be testable without
 * standing up an agent: **every real provider call lands in each ledger exactly
 * once**. The turn's main-loop totals, the per-tier split and the auto-compaction
 * block are three buckets over the same set of calls, and a bucket that forgets
 * one — or two buckets that both claim one — is invisible until someone sums the
 * ledger against the provider's own invoice.
 */

/**
 * Spend from automatic context compaction.
 *
 * Structurally identical to `CompactUsageSink` (agent/autoCompact.ts) on
 * purpose, without importing it: `usage/` is the lower layer and must not grow
 * a dependency on `agent/` just for a type.
 */
export type CompactSpend = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * `failed` is the initial value and also means "no compaction ran at all";
   * callers that fold compaction into a ledger only look at `calls`, so the two
   * are not confused. `cancelled` is only set by the turn loop (see
   * `foldCompactionOutcome`) and means the user stopped while the summary was
   * in flight — a different cost story from a provider defect.
   */
  outcome: 'completed' | 'failed' | 'cancelled';
};

/** One tier's slice of a turn's main-loop spend. */
export type TierBucket = {
  inputTokens: number;
  outputTokens: number;
  /** Provider round-trips attributed to this tier (each reports usage). */
  calls: number;
  /**
   * Which provider/model answered this tier's calls.
   *
   * Recorded per bucket, not read from `runtime.provider` at turn end: dispatch
   * swaps the provider every step, so at the end of a two-tier turn the runtime
   * only remembers the LAST tier's model. A row for the first tier stamped from
   * that would name a model that never answered it.
   */
  provider: string;
  model: string;
};

export type TierUsage = Map<DispatchTier, TierBucket>;

export type UsageRow = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  localCachePredictedRate?: number;
};

export type ProviderIdentity = { provider: string; model: string };

/** True when a turn spent anything at all — main loop or compaction. */
export function turnHasSpend(totals: UsageRow, compact: CompactSpend): boolean {
  return totals.inputTokens > 0 || totals.outputTokens > 0 || compact.calls > 0;
}

/**
 * Record that the user cancelled the turn while a compaction request was in
 * flight.
 *
 * `runAutoCompact` cannot tell "the provider failed" from "the user pressed
 * Ctrl-C" — it reports both as `failed` and then rethrows the abort. Their cost
 * meaning differs (a cancel is not a broken provider and does not repeat on the
 * next turn), so the state is kept apart in the ledger instead of being folded
 * into `failed`. Only a turn that was cancelled AND did spend compaction money
 * gets here: the sink's initial `failed` must not be relabelled otherwise.
 */
export function foldCompactionOutcome(
  compact: CompactSpend,
  turnCancelled: boolean,
): CompactSpend {
  if (!turnCancelled || compact.calls <= 0 || compact.outcome === 'completed') return compact;
  return { ...compact, outcome: 'cancelled' };
}

/**
 * A row of the 省钱分级 ledger.
 *
 * `inputTokens`/`outputTokens` are the TOTAL this row accounts for. When
 * `autoCompact` is present its tokens are already included in them — the block
 * is a labelled breakdown, not extra spend. That keeps one rule for readers:
 * summing every row's `totalTokens` equals the provider's own total for the
 * turn, and subtracting `autoCompact` gives the tier's ordinary calls.
 */
export type DispatchRow = {
  task: string;
  stage: string;
  tier: DispatchTier | 'compact';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  ok: boolean;
  /** Provider round-trips this row's tier/calls cover. Absent = 1 (legacy shape). */
  tierCalls?: number;
  autoCompact?: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    outcome: 'completed' | 'failed' | 'cancelled';
  };
};

/**
 * The rows a turn writes to the dispatch ledger.
 *
 * Rules, in order:
 *  1. Every tier that reported usage gets its own row (a turn may have run on
 *     several), carrying the provider/model that actually answered it.
 *  2. A turn with no tier split but a legacy `dispatchTier` stamp (the sub-agent
 *     runner sets one) gets a single row for the main-loop totals.
 *  3. Auto-compaction spend is attached to exactly ONE row and never counted
 *     twice:
 *       - rows exist      → the last row. Its tokens are added to that row and
 *                           mirrored in `autoCompact`, so the sum over rows is
 *                           still a partition of all provider calls. `rows[0]`
 *                           would be as arbitrary; the last row is chosen
 *                           because the summary usually fires right before the
 *                           next step, i.e. near the end of the turn.
 *       - no rows at all  → a standalone `compact` row, because a turn billed
 *                           only for a summary has no tier to hang it on and
 *                           dropping it is what made the spend invisible.
 *  4. A failed compaction still counts: `calls` was incremented before the
 *     request was made, so the money is real even when no summary came back.
 */
export function buildDispatchRows(input: {
  task: string;
  stage: string;
  ok: boolean;
  totals: UsageRow;
  tiers: TierUsage;
  /** Single-tier stamp used only when `tiers` is empty. */
  fallback?: ProviderIdentity & { tier: DispatchTier };
  /** Who ran the compaction, for the standalone `compact` row. */
  compactIdentity?: ProviderIdentity;
  compact: CompactSpend;
}): DispatchRow[] {
  const { task, stage, ok, totals, tiers, fallback, compactIdentity, compact } = input;
  const rows: DispatchRow[] = [];

  if (tiers.size > 0) {
    for (const [tier, bucket] of tiers) {
      rows.push({
        task,
        stage,
        tier,
        provider: bucket.provider,
        model: bucket.model,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        totalTokens: bucket.inputTokens + bucket.outputTokens,
        ok,
        ...(bucket.calls !== 1 ? { tierCalls: bucket.calls } : {}),
      });
    }
  } else if (fallback) {
    rows.push({
      task,
      stage,
      tier: fallback.tier,
      provider: fallback.provider,
      model: fallback.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.inputTokens + totals.outputTokens,
      ok,
    });
  }

  if (compact.calls > 0) {
    const block: NonNullable<DispatchRow['autoCompact']> = {
      calls: compact.calls,
      inputTokens: compact.inputTokens,
      outputTokens: compact.outputTokens,
      outcome: compact.outcome,
    };
    if (rows.length > 0) {
      const row = rows[rows.length - 1];
      row.inputTokens += compact.inputTokens;
      row.outputTokens += compact.outputTokens;
      row.totalTokens = row.inputTokens + row.outputTokens;
      row.autoCompact = block;
    } else {
      rows.push({
        task,
        stage,
        tier: 'compact',
        provider: compactIdentity?.provider ?? '',
        model: compactIdentity?.model ?? '',
        inputTokens: compact.inputTokens,
        outputTokens: compact.outputTokens,
        totalTokens: compact.inputTokens + compact.outputTokens,
        ok: compact.outcome === 'completed',
        autoCompact: block,
      });
    }
  }
  return rows;
}
