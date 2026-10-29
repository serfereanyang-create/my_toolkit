import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDispatchRows,
  foldCompactionOutcome,
  turnHasSpend,
  type CompactSpend,
  type DispatchRow,
  type TierBucket,
  type TierUsage,
} from '../src/usage/turnAccounting.js';
import type { DispatchTier } from '../src/dispatch/tierRouter.js';

/*
 * usage/turnAccounting.ts owns the only invariant that spans two ledgers:
 * every real provider call must land in the dispatch ledger exactly once.
 *
 * The turn's main-loop totals (`usageTotals`), the per-tier split
 * (`tierUsage`) and the auto-compaction block are three views over the same set
 * of provider requests. A view that forgets one under-reports; two views that
 * both claim one double-bills. Neither is visible until someone sums the ledger
 * against the provider's invoice, so it is checked by construction here.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TIERS: DispatchTier[] = ['expensive', 'standard', 'cheap'];

function rowsTotal(rows: DispatchRow[]): number {
  return rows.reduce((sum, row) => sum + row.totalTokens, 0);
}

function compactRows(rows: DispatchRow[]): number {
  return rows.filter((row) => row.autoCompact !== undefined).length;
}

const noTotals = { inputTokens: 0, outputTokens: 0 };

test('a turn with tiers writes one row per tier, stamped with the model that answered it', () => {
  // dispatch swaps `runtime.provider` on every step, so at turn end it only
  // remembers the LAST tier's model. A row stamped from it would name a model
  // that never answered the first tier — the bug this shape exists to prevent.
  const tiers: TierUsage = new Map<DispatchTier, TierBucket>([
    ['expensive', { inputTokens: 900, outputTokens: 100, calls: 1, provider: 'openai', model: 'big-model' }],
    ['cheap', { inputTokens: 40, outputTokens: 10, calls: 3, provider: 'openai', model: 'small-model' }],
  ]);
  const rows = buildDispatchRows({
    task: 't', stage: 'main', ok: true,
    totals: { inputTokens: 940, outputTokens: 110 },
    tiers,
    compact: { calls: 0, inputTokens: 0, outputTokens: 0, outcome: 'failed' },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.tier, r.model]), [['expensive', 'big-model'], ['cheap', 'small-model']]);
  assert.equal(rows[1].tierCalls, 3, 'multi-call buckets keep their call count');
  assert.equal(rows[0].tierCalls, undefined, 'a single call uses the historical shape');
  assert.equal(rowsTotal(rows), 1050);
});

test('compaction spend joins the last tier row exactly once', () => {
  const tiers: TierUsage = new Map<DispatchTier, TierBucket>([
    ['expensive', { inputTokens: 900, outputTokens: 100, calls: 1, provider: 'p', model: 'm1' }],
    ['cheap', { inputTokens: 40, outputTokens: 10, calls: 1, provider: 'p', model: 'm2' }],
  ]);
  const compact: CompactSpend = { calls: 1, inputTokens: 4000, outputTokens: 200, outcome: 'completed' };
  const rows = buildDispatchRows({
    task: 't', stage: 'main', ok: true,
    // `totals` deliberately EXCLUDES compaction: it is the main-loop sum. The
    // compaction block is a separate request and must add to the total.
    totals: { inputTokens: 940, outputTokens: 110 },
    tiers, compact,
  });
  assert.equal(rows.length, 2, 'no extra row when a tier row can carry the block');
  assert.equal(compactRows(rows), 1, 'exactly one row carries the block');
  const carrier = rows[1];
  assert.equal(carrier.autoCompact?.inputTokens, 4000);
  assert.equal(carrier.inputTokens, 40 + 4000);
  assert.equal(carrier.totalTokens, 40 + 10 + 4000 + 200);
  // Σ row totals = main loop + compaction: one provider call appears once.
  assert.equal(rowsTotal(rows), 940 + 110 + 4000 + 200);
});

test('a compaction-only turn gets a standalone row instead of vanishing', () => {
  const rows = buildDispatchRows({
    task: 't', stage: 'main', ok: false,
    totals: noTotals,
    tiers: new Map(),
    compact: { calls: 1, inputTokens: 9000, outputTokens: 300, outcome: 'failed' },
    compactIdentity: { provider: 'anthropic', model: 'claude-x' },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'compact');
  assert.equal(rows[0].provider, 'anthropic');
  assert.equal(rows[0].totalTokens, 9300);
  assert.equal(rows[0].ok, false, 'a failed summary is not a successful request');
});

test('the fallback single-tier stamp is only used when there is no tier split', () => {
  const fallback = { tier: 'standard' as const, provider: 'p', model: 'm' };
  const compact: CompactSpend = { calls: 0, inputTokens: 0, outputTokens: 0, outcome: 'failed' };
  const withSplit = buildDispatchRows({
    task: 't', stage: 'main', ok: true,
    totals: { inputTokens: 10, outputTokens: 1 },
    tiers: new Map([['cheap', { inputTokens: 10, outputTokens: 1, calls: 1, provider: 'p2', model: 'm2' }]]),
    fallback, compact,
  });
  assert.equal(withSplit.length, 1);
  assert.equal(withSplit[0].tier, 'cheap', 'the observed split wins over the legacy stamp');

  const withoutSplit = buildDispatchRows({
    task: 't', stage: 'main', ok: true,
    totals: { inputTokens: 10, outputTokens: 1 },
    tiers: new Map(), fallback, compact,
  });
  assert.equal(withoutSplit.length, 1);
  assert.equal(withoutSplit[0].tier, 'standard');
  assert.equal(withoutSplit[0].totalTokens, 11);
});

test('a spend-less turn never invents spend, even with a fallback stamp', () => {
  const rows = buildDispatchRows({
    task: 't', stage: 'main', ok: true,
    totals: noTotals, tiers: new Map(),
    compact: { calls: 0, inputTokens: 0, outputTokens: 0, outcome: 'failed' },
    fallback: { tier: 'cheap', provider: 'p', model: 'm' },
  });
  // The caller guards with `turnHasSpend`, so this shape is only reachable by a
  // direct call. Whatever the function emits, it must not claim tokens.
  assert.equal(rowsTotal(rows), 0);
  assert.ok(rows.length <= 1, 'at most a zero-token placeholder, never a phantom split');
});

test('foldCompactionOutcome distinguishes a user cancel from a provider failure', () => {
  const failed: CompactSpend = { calls: 1, inputTokens: 10, outputTokens: 1, outcome: 'failed' };
  assert.equal(foldCompactionOutcome(failed, true).outcome, 'cancelled');
  assert.equal(foldCompactionOutcome(failed, false).outcome, 'failed');
  const completed: CompactSpend = { calls: 1, inputTokens: 10, outputTokens: 1, outcome: 'completed' };
  assert.equal(foldCompactionOutcome(completed, true).outcome, 'completed', 'a finished summary is not retroactively cancelled');
  const untouched: CompactSpend = { calls: 0, inputTokens: 0, outputTokens: 0, outcome: 'failed' };
  assert.equal(foldCompactionOutcome(untouched, true).outcome, 'failed', 'no call, no cancel to report');
});

test('turnHasSpend covers a turn whose only spend was a summary', () => {
  assert.equal(turnHasSpend(noTotals, { calls: 0, inputTokens: 0, outputTokens: 0, outcome: 'failed' }), false);
  assert.equal(turnHasSpend(noTotals, { calls: 1, inputTokens: 0, outputTokens: 0, outcome: 'failed' }), true);
  assert.equal(turnHasSpend({ inputTokens: 1, outputTokens: 0 }, { calls: 0, inputTokens: 0, outputTokens: 0, outcome: 'failed' }), true);
});

test('randomized: rows partition the provider calls, compaction counted once', () => {
  // The billing invariant: Σ row.totalTokens === main-loop totals + compaction
  // totals, and the autoCompact block appears on exactly one row and matches
  // the compact spend. Any double count or omission fails the sum.
  const random = mulberry32(0x5eed);
  for (let trial = 0; trial < 200; trial++) {
    const tierCount = Math.floor(random() * 4); // 0..3 tiers
    const tiers: TierUsage = new Map();
    let mainIn = 0;
    let mainOut = 0;
    for (let i = 0; i < tierCount; i++) {
      const tier = TIERS[i % TIERS.length];
      const inputTokens = Math.floor(random() * 20_000);
      const outputTokens = Math.floor(random() * 2_000);
      const calls = 1 + Math.floor(random() * 4);
      tiers.set(tier, { inputTokens, outputTokens, calls, provider: `p${i}`, model: `m${i}` });
      mainIn += inputTokens;
      mainOut += outputTokens;
    }
    const compactCalls = random() < 0.45 ? 0 : 1 + Math.floor(random() * 2);
    const compact: CompactSpend = {
      calls: compactCalls,
      inputTokens: compactCalls === 0 ? 0 : Math.floor(random() * 100_000),
      outputTokens: compactCalls === 0 ? 0 : Math.floor(random() * 4_000),
      outcome: (['completed', 'failed', 'cancelled'] as const)[Math.floor(random() * 3)],
    };
    const useFallback = random() < 0.5;
    const rows = buildDispatchRows({
      task: 'task', stage: 'main', ok: random() < 0.5,
      totals: { inputTokens: mainIn, outputTokens: mainOut },
      tiers,
      ...(useFallback ? { fallback: { tier: 'standard' as const, provider: 'fp', model: 'fm' } } : {}),
      compact,
      compactIdentity: { provider: 'cp', model: 'cm' },
    });

    const expectedTotal = mainIn + mainOut + compact.inputTokens + compact.outputTokens;
    assert.equal(
      rowsTotal(rows), expectedTotal,
      `trial ${trial} (seed 0x5eed): rows must partition main-loop + compaction spend`,
    );
    if (compact.calls > 0) {
      assert.equal(compactRows(rows), 1, `trial ${trial}: compaction attached to exactly one row`);
      const block = rows.find((row) => row.autoCompact)!.autoCompact!;
      assert.deepEqual(
        [block.calls, block.inputTokens, block.outputTokens, block.outcome],
        [compact.calls, compact.inputTokens, compact.outputTokens, compact.outcome],
        `trial ${trial}: block mirrors the real spend`,
      );
    } else {
      assert.equal(compactRows(rows), 0, `trial ${trial}: no block when no compaction ran`);
    }
    // A tier row must never claim another tier's model.
    for (const row of rows) {
      if (row.tier === 'compact') continue;
      const bucket = tiers.get(row.tier);
      if (bucket) {
        assert.equal(row.model, bucket.model, `trial ${trial}: ${row.tier} stamped with its own model`);
        assert.equal(row.provider, bucket.provider, `trial ${trial}: ${row.tier} stamped with its own provider`);
      }
    }
  }
});
