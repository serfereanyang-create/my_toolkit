import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeCacheHealth, classifyTurn, endpointKey, formatCacheHealth } from '../src/usage/cacheHealth.js';
import type { UsageLedgerEntry } from '../src/usage/ledger.js';

function entry(over: Partial<UsageLedgerEntry>): UsageLedgerEntry {
  return {
    ts: '2026-09-13T00:00:00.000Z',
    sessionId: 'sess_a',
    provider: 'anthropic',
    model: 'm',
    baseUrl: 'https://relay.example/v1',
    inputTokens: 10000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheEfficiency: 0,
    turnId: 'turn_1',
    toolCalls: 0,
    durationMs: 1000,
    ...over,
  } as UsageLedgerEntry;
}

async function withLedger(entries: UsageLedgerEntry[], fn: (logPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-cachehealth-'));
  const logPath = join(dir, 'usage.jsonl');
  await writeFile(logPath, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  try {
    await fn(logPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('endpointKey groups by provider and host only', () => {
  assert.equal(endpointKey(entry({ baseUrl: 'https://relay.example/v1' })), 'anthropic@relay.example');
  assert.equal(endpointKey(entry({ baseUrl: undefined })), 'anthropic');
});

test('classifyTurn: zero on both counters is no-cache-data, low read vs high write is rebuild', () => {
  assert.equal(classifyTurn(entry({}), false), 'no-cache-data');
  assert.equal(classifyTurn(entry({ cacheReadTokens: 100, cacheCreationTokens: 5000 }), false), 'prefix-rebuild');
  assert.equal(classifyTurn(entry({ cacheReadTokens: 9000 }), false), 'healthy');
  assert.equal(classifyTurn(entry({ cacheCreationTokens: 5000 }), false), 'unstable-prefix');
});

test('classifyTurn: a compaction-only row has no prompt of its own to classify', () => {
  // The summary request sends the packed history but is not part of the
  // conversation's prefix chain. Calling it "unstable-prefix" (cacheRead 0 on a
  // non-first turn) would invent a cache-killer that does not exist.
  const compactOnly = entry({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    autoCompact: { calls: 1, inputTokens: 9000, outputTokens: 300, outcome: 'completed' },
  });
  assert.equal(classifyTurn(compactOnly, false), 'no-cache-data');
  // Once the turn also has main-loop input, the normal rules apply again.
  const mixed = entry({
    inputTokens: 100,
    cacheCreationTokens: 5_000,
    autoCompact: { calls: 1, inputTokens: 9000, outputTokens: 300, outcome: 'completed' },
  });
  assert.equal(classifyTurn(mixed, false), 'unstable-prefix');
});

test('analyzeCacheHealth separates a not-reporting relay from a healthy endpoint', async () => {
  const entries = [
    // Healthy relay: first turn pays the write (cold-start), later turns hit.
    entry({ sessionId: 's1', baseUrl: 'https://good.example/v1', cacheCreationTokens: 9000, cacheEfficiency: 0 }),
    entry({ sessionId: 's1', baseUrl: 'https://good.example/v1', cacheReadTokens: 9500, cacheEfficiency: 0.95 }),
    entry({ sessionId: 's1', baseUrl: 'https://good.example/v1', cacheReadTokens: 9600, cacheEfficiency: 0.96 }),
    // Silent relay: never reports anything (the open.774966.xyz case).
    entry({ sessionId: 's2', baseUrl: 'https://silent.example/v1' }),
    entry({ sessionId: 's2', baseUrl: 'https://silent.example/v1' }),
    entry({ sessionId: 's2', baseUrl: 'https://silent.example/v1' }),
  ];
  await withLedger(entries, async (logPath) => {
    const report = await analyzeCacheHealth({ logPath });
    assert.equal(report.endpoints.length, 2);
    const good = report.endpoints.find((e) => e.endpoint.includes('good.example'))!;
    const silent = report.endpoints.find((e) => e.endpoint.includes('silent.example'))!;
    assert.equal(good.status, 'reporting');
    assert.equal(good.cacheReadTurns, 2);
    assert.ok(good.hitRate !== null && good.hitRate > 0.3);
    assert.equal(silent.status, 'not-reporting');
    assert.equal(silent.cacheReadTurns, 0);
    // The honest diagnosis fires per silent endpoint and only vouches for
    // prefix stability thanks to the GOOD endpoint's data.
    assert.ok(report.findings.some((f) => f.includes('silent.example') && f.includes('端点属性')));
    assert.ok(report.findings.some((f) => f.includes('回报缓存的端点')));
    assert.ok(!report.findings.some((f) => f === '前缀稳定性良好，滑动断点 + 尾置动态内容布局工作正常。'));
    const text = formatCacheHealth(report);
    assert.ok(text.includes('按端点'));
    assert.ok(text.includes('silent.example'));
    assert.ok(text.includes('[端点不回报缓存]'));
  });
});

test('all-silent ledger never claims stability', async () => {
  const entries = [entry({}), entry({}), entry({})];
  await withLedger(entries, async (logPath) => {
    const report = await analyzeCacheHealth({ logPath });
    assert.equal(report.endpoints[0]!.status, 'not-reporting');
    assert.ok(report.findings.some((f) => f.includes('全部不回报')));
    assert.ok(!report.findings.some((f) => f.includes('工作正常')));
  });
});

/*
 * The tool array is serialized before the system block and inside the cached
 * prompt prefix, so a mid-session change to it invalidates the cache from byte
 * 0 — stable system prompt or not. This is the fingerprint of that failure, and
 * it is reported separately because the existing system-prompt advice cannot
 * fix it.
 */
test('a mid-session tool-array change is reported as a cache killer', async () => {
  const entries = [
    entry({ turnId: 't1', toolCount: 232, toolScope: 'standard', cacheReadTokens: 0, cacheCreationTokens: 9000 }),
    entry({ turnId: 't2', toolCount: 196, toolScope: 'compact', cacheReadTokens: 100 }),
    entry({ turnId: 't3', toolCount: 232, toolScope: 'standard', cacheReadTokens: 200 }),
  ];
  await withLedger(entries, async (logPath) => {
    const report = await analyzeCacheHealth({ logPath });
    assert.equal(report.toolSurfaceShifts.length, 2, 'two changes: 232->196 and 196->232');
    assert.deepEqual(
      report.toolSurfaceShifts.map((s) => [s.fromCount, s.toCount]),
      [[232, 196], [196, 232]],
    );
    const shift = report.findings.find((f) => f.includes('工具面变化'));
    assert.ok(shift, 'expected a tool-surface finding');
    assert.match(shift, /232 → 196/);
    assert.match(shift, /standard → compact/);
    assert.match(shift, /第 0 字节/);
  });
});

test('a stable tool surface produces no shift finding', async () => {
  const entries = [
    entry({ turnId: 't1', toolCount: 232, toolScope: 'standard', cacheReadTokens: 0, cacheCreationTokens: 9000 }),
    entry({ turnId: 't2', toolCount: 232, toolScope: 'standard', cacheReadTokens: 8000 }),
    entry({ turnId: 't3', toolCount: 232, toolScope: 'standard', cacheReadTokens: 9000 }),
  ];
  await withLedger(entries, async (logPath) => {
    const report = await analyzeCacheHealth({ logPath });
    assert.deepEqual(report.toolSurfaceShifts, []);
    assert.ok(!report.findings.some((f) => f.includes('工具面变化')));
  });
});

test('tool-surface changes are tracked per session, not across sessions', async () => {
  // Two sessions each keeping a stable surface must not look like one session
  // that changed shape when the second began.
  const entries = [
    entry({ sessionId: 'sess_a', turnId: 'a1', toolCount: 232 }),
    entry({ sessionId: 'sess_b', turnId: 'b1', toolCount: 196 }),
    entry({ sessionId: 'sess_a', turnId: 'a2', toolCount: 232 }),
  ];
  await withLedger(entries, async (logPath) => {
    const report = await analyzeCacheHealth({ logPath });
    assert.deepEqual(report.toolSurfaceShifts, []);
  });
});
