import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeAutoCompact, maybeMidTurnCompact, type CompactUsageSink } from '../src/agent/autoCompact.js';
import { appendUsage, type UsageLedgerEntry } from '../src/usage/ledger.js';

/*
 * Auto-compaction is the only model call in the CLI that does not go through
 * the turn loop: it calls `provider.complete` directly to get the handoff
 * summary, so its usage never joined `usageTotals`. The ledger therefore had a
 * hole exactly where the money is largest — a cross-window compaction sends the
 * packed full history as input. These tests pin the accounting, not the
 * compaction behaviour (that lives in tests/autoCompact.test.ts).
 */

/** Deterministic PRNG so the randomized cases are reproducible on failure. */
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

function makeRuntime(response: { usage?: { inputTokens: number; outputTokens: number }; fail?: boolean }) {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: 'x'.repeat(60),
    createdAt: 't',
  }));
  const runtime: any = {
    session: { id: 's', messages, finalAnswers: [] },
    config: { workspaceRoot: '.' },
    provider: {
      model: 'gpt-5.5',
      complete: async () => {
        if (response.fail) throw new Error('provider exploded');
        return {
          actions: [{ type: 'message', content: 'handoff summary here' }],
          usage: response.usage,
        };
      },
    },
    ui: { info: () => {} },
    compactEmit: () => {},
  };
  return runtime;
}

function freshSink(): CompactUsageSink {
  return { calls: 0, inputTokens: 0, outputTokens: 0, outcome: 'failed' };
}

function withSmallWindow<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.AICODE_CONTEXT_WINDOW;
  process.env.AICODE_CONTEXT_WINDOW = '150';
  return run().finally(() => {
    if (previous === undefined) delete process.env.AICODE_CONTEXT_WINDOW;
    else process.env.AICODE_CONTEXT_WINDOW = previous;
  });
}

test('a successful compaction records the real provider usage', async () => {
  await withSmallWindow(async () => {
    const sink = freshSink();
    await maybeAutoCompact(makeRuntime({ usage: { inputTokens: 12_345, outputTokens: 678 } }), sink);
    assert.deepEqual(sink, { calls: 1, inputTokens: 12_345, outputTokens: 678, outcome: 'completed' });
  });
});

test('a failed compaction still records what the provider billed', async () => {
  // The provider is charged for the round-trip even when the summary is empty
  // or the request throws after the response arrived; dropping those numbers
  // under-reports spend exactly when something is going wrong.
  await withSmallWindow(async () => {
    const sink = freshSink();
    await maybeAutoCompact(makeRuntime({ fail: true }), sink);
    assert.equal(sink.calls, 1, 'the attempt still counts');
    assert.equal(sink.outcome, 'failed');
  });
});

test('mid-turn compaction accumulates into the same sink', async () => {
  await withSmallWindow(async () => {
    const sink = freshSink();
    await maybeMidTurnCompact(makeRuntime({ usage: { inputTokens: 100, outputTokens: 10 } }), sink);
    await maybeMidTurnCompact(makeRuntime({ usage: { inputTokens: 1, outputTokens: 2 } }), sink);
    assert.equal(sink.calls, 2);
    assert.equal(sink.inputTokens, 101);
    assert.equal(sink.outputTokens, 12);
    assert.equal(sink.outcome, 'completed');
  });
});

test('a compaction that never fires leaves the sink empty', async () => {
  const previous = process.env.AICODE_CONTEXT_WINDOW;
  process.env.AICODE_CONTEXT_WINDOW = '1000000';
  try {
    const sink = freshSink();
    await maybeAutoCompact(makeRuntime({ usage: { inputTokens: 5, outputTokens: 5 } }), sink);
    assert.equal(sink.calls, 0);
  } finally {
    if (previous === undefined) delete process.env.AICODE_CONTEXT_WINDOW;
    else process.env.AICODE_CONTEXT_WINDOW = previous;
  }
});

test('a provider that reports no usage records the call but zero tokens', async () => {
  await withSmallWindow(async () => {
    const sink = freshSink();
    await maybeAutoCompact(makeRuntime({}), sink);
    assert.equal(sink.calls, 1);
    assert.equal(sink.inputTokens, 0);
    assert.equal(sink.outputTokens, 0);
  });
});

test('randomized: the sink always equals the sum of what the provider reported', async () => {
  // The invariant that matters for billing: whatever the mix of successes and
  // failures, calls must equal the number of provider invocations and the
  // token totals must equal the sum of the successful responses.
  await withSmallWindow(async () => {
    const random = mulberry32(0xc0ffee);
    for (let trial = 0; trial < 40; trial++) {
      const sink = freshSink();
      let expectedCalls = 0;
      let expectedIn = 0;
      let expectedOut = 0;
      const rounds = 1 + Math.floor(random() * 5);
      for (let round = 0; round < rounds; round++) {
        const fail = random() < 0.3;
        const input = Math.floor(random() * 50_000);
        const output = Math.floor(random() * 2_000);
        // Restore the threshold each round: a successful compaction rewrites
        // history, so the next call has to be re-armed to fire again.
        process.env.AICODE_CONTEXT_WINDOW = '150';
        await maybeMidTurnCompact(makeRuntime(fail ? { fail: true } : { usage: { inputTokens: input, outputTokens: output } }), sink);
        expectedCalls += 1;
        if (!fail) { expectedIn += input; expectedOut += output; }
      }
      assert.equal(sink.calls, expectedCalls, `trial ${trial}: every attempt counted`);
      assert.equal(sink.inputTokens, expectedIn, `trial ${trial}: input tokens summed`);
      assert.equal(sink.outputTokens, expectedOut, `trial ${trial}: output tokens summed`);
    }
  });
});

test('a turn whose only spend was compaction still reaches the ledger', async () => {
  // The old appendUsage guard dropped entries with zero main-loop tokens, which
  // is exactly the shape of a turn that only paid for a summary.
  const dir = await mkdtemp(join(tmpdir(), 'aicode-usage-'));
  const logPath = join(dir, 'usage.jsonl');
  try {
    const entry: UsageLedgerEntry = {
      ts: '2026-10-29T00:00:00.000Z',
      sessionId: 's',
      provider: 'mock',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      autoCompact: { calls: 1, inputTokens: 900, outputTokens: 40, outcome: 'completed' },
    };
    await appendUsage(logPath, entry);
    const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.autoCompact.inputTokens, 900);
    assert.equal(parsed.autoCompact.outcome, 'completed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty entry is still not written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-usage-'));
  const logPath = join(dir, 'usage.jsonl');
  try {
    await appendUsage(logPath, {
      ts: 't', sessionId: 's', provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0,
      autoCompact: { calls: 0, inputTokens: 0, outputTokens: 0, outcome: 'failed' },
    });
    await assert.rejects(readFile(logPath, 'utf8'), 'no file is created for an empty entry');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
