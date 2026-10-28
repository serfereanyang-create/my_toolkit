import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildReport,
  diagnoseRoundPairs,
  findLatestSession,
  formatReport,
  isAppendDriven,
  observedReuseOf,
  parseArgs,
  surfaceOf,
  type RoundRow,
} from '../src/audit/contextLedger.js';
import type { TrajectoryRecord } from '../src/session/modelTrajectory.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { limitProviderTools } from '../src/tools/scope.js';
import type { ToolDefinition } from '../src/tools/types.js';

// ---------------------------------------------------------------------------
// 构造器
// ---------------------------------------------------------------------------

function rec(over: { step: number } & Record<string, unknown>): TrajectoryRecord {
  return {
    requestId: 'r',
    turnId: 't',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    model: 'm',
    provider: 'p',
    ok: true,
    requestMessageCount: 4,
    requestTail: [],
    responseText: '',
    toolNames: [],
    promptChars: 1000,
    ...over,
  } as unknown as TrajectoryRecord;
}

function round(i: number, over: Partial<RoundRow> = {}): RoundRow {
  const inputTokens = over.inputTokens ?? 100;
  const cacheReadTokens = over.cacheReadTokens ?? 1900;
  return {
    i,
    turn: 1,
    step: i + 1,
    requestMessageCount: 4 + i,
    promptChars: 1000 * (i + 1),
    inputTokens,
    outputTokens: 10,
    cacheReadTokens,
    promptTokens: inputTokens + cacheReadTokens,
    hitRate: cacheReadTokens / (inputTokens + cacheReadTokens),
    repayed: false,
    observedReuse: null,
    appendDriven: false,
    coldStart: i === 0,
    turnFirst: i === 0,
    surface: surfaceOf({ toolScope: 'standard', toolCount: 274 }),
    surfaceChanged: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 三向诊断
// ---------------------------------------------------------------------------

test('a pure reorder of the recorded tool names is not a tool-set change', () => {
  const records = [
    rec({ step: 1, toolNames: ['read_file', 'write_file'], requestMessageCount: 4, promptChars: 1000 }),
    rec({ step: 2, toolNames: ['write_file', 'read_file'], requestMessageCount: 6, promptChars: 2000 }),
  ];
  const pairs = diagnoseRoundPairs(records, [round(0), round(1)]);
  assert.equal(pairs.length, 1);
  const pair = pairs[0];
  assert.equal(pair.layer, 'called-tools');
  assert.equal(pair.toolSetChanged, false, 'the multiset is unchanged');
  assert.equal(pair.toolOrderOnlyChanged, true, 'only the sequence differs');
  assert.equal(pair.prefixBytesChanged, false, 'call order does not touch the prefix');
  assert.deepEqual(pair.added, []);
  assert.deepEqual(pair.removed, []);
  assert.equal(pair.crossesTurn, false);
  assert.equal(pair.scopeCountChanged, false);
});

test('a real tool-set change is reported as a set change, never as a reorder', () => {
  const records = [
    rec({ step: 1, toolNames: ['read_file'], requestMessageCount: 4, promptChars: 1000 }),
    rec({ step: 2, toolNames: ['read_file', 'write_file'], requestMessageCount: 6, promptChars: 2000 }),
  ];
  const [pair] = diagnoseRoundPairs(records, [round(0), round(1)]);
  assert.equal(pair.toolSetChanged, true);
  assert.equal(pair.toolOrderOnlyChanged, false);
  assert.deepEqual(pair.added, ['write_file']);
  assert.deepEqual(pair.removed, []);
});

test('when the sent array is recorded, a reorder is a real prefix change', () => {
  const records = [
    rec({ step: 1, toolSetNames: ['write_file', 'read_file'], requestMessageCount: 4, promptChars: 1000 }),
    rec({ step: 2, toolSetNames: ['read_file', 'write_file'], requestMessageCount: 6, promptChars: 2000 }),
  ];
  const [pair] = diagnoseRoundPairs(records, [round(0), round(1)]);
  assert.equal(pair.layer, 'sent-tools', 'the sent array wins over the called-tools list');
  assert.equal(pair.toolSetChanged, false);
  assert.equal(pair.toolOrderOnlyChanged, true);
  assert.equal(pair.prefixBytesChanged, true, 'the provider hashes the array in order, so a reorder kills the cache');
  assert.ok(pair.prefixEvidence.includes('sent-tool-order-changed'));
});

test('history that is not a pure append is a prefix change', () => {
  const dropped = diagnoseRoundPairs(
    [
      rec({ step: 1, requestMessageCount: 40, promptChars: 9000 }),
      rec({ step: 2, requestMessageCount: 5, promptChars: 3000 }),
    ],
    [round(0), round(1)],
  )[0];
  assert.equal(dropped.prefixBytesChanged, true);
  assert.ok(dropped.prefixEvidence.includes('compaction-drop'));

  const shrunk = diagnoseRoundPairs(
    [
      rec({ step: 1, requestMessageCount: 10, promptChars: 5000 }),
      rec({ step: 2, requestMessageCount: 12, promptChars: 4000 }),
    ],
    [round(0), round(1)],
  )[0];
  assert.equal(shrunk.prefixBytesChanged, true);
  assert.ok(shrunk.prefixEvidence.includes('prompt-chars-not-grown'));
  assert.ok(!shrunk.prefixEvidence.includes('compaction-drop'));
});

test('a turn boundary with a different tool count is a set change on the scope-count layer', () => {
  const records = [
    rec({ step: 3, requestMessageCount: 10, promptChars: 5000, toolNames: undefined }),
    rec({ step: 1, requestMessageCount: 12, promptChars: 6000, toolNames: undefined }),
  ];
  const pairs = diagnoseRoundPairs(records, [
    round(0, { turn: 1 }),
    round(1, {
      turn: 2,
      surface: surfaceOf({ toolScope: 'standard', toolCount: 260 }),
    }),
  ]);
  const [pair] = pairs;
  assert.equal(pair.crossesTurn, true);
  assert.equal(pair.layer, 'scope-count', 'no recorded names → the count probe is all there is');
  assert.equal(pair.scopeCountChanged, true);
  assert.equal(pair.toolSetChanged, true, 'a different count is proof that some name differs');
  assert.equal(pair.toolOrderOnlyChanged, null, 'order is invisible on this layer');
  assert.equal(pair.prefixBytesChanged, true);
  assert.ok(pair.prefixEvidence.includes('scope-count-changed'));
});

test('the same count across a turn boundary proves nothing about the names', () => {
  const records = [
    rec({ step: 3, requestMessageCount: 10, promptChars: 5000, toolNames: undefined }),
    rec({ step: 1, requestMessageCount: 12, promptChars: 6000, toolNames: undefined }),
  ];
  const [pair] = diagnoseRoundPairs(records, [round(0, { turn: 1 }), round(1, { turn: 2 })]);
  assert.equal(pair.crossesTurn, true);
  assert.equal(pair.scopeCountChanged, false);
  assert.equal(pair.toolSetChanged, null, '274→260→274 shows a stable count can hide a swap');
  assert.equal(pair.prefixBytesChanged, false, 'but there is no local evidence of a byte change');
});

test('the reuse ratio is the provider\'s answer, reported beside the three diagnoses', () => {
  const [pair] = diagnoseRoundPairs(
    [rec({ step: 1 }), rec({ step: 2 })],
    [
      round(0, { inputTokens: 5000, cacheReadTokens: 0 }),
      round(1, { inputTokens: 100, cacheReadTokens: 1900 }),
    ],
  );
  assert.equal(pair.observedReuse, 1900 / 5000);
  assert.equal(pair.providerSawBreak, true);
  assert.equal(pair.inputTokens, 100);
});

// ---------------------------------------------------------------------------
// REPAY 的两个子类：前缀真的重建 vs 一次性的大的追加
// ---------------------------------------------------------------------------

test('the reuse ratio is measured against the whole previous prompt', () => {
  assert.equal(observedReuseOf(0, 500), null, 'the first round has no previous prefix to reuse');
  assert.equal(observedReuseOf(10_000, 9_990), 0.999);
  assert.equal(observedReuseOf(10_000, 500), 0.05);
});

test('appendDriven = repaid AND the provider still reused ≥90% of the previous prefix', () => {
  assert.equal(isAppendDriven(true, 0.999), true, 'large one-off append: low hit rate, prefix was reused');
  assert.equal(isAppendDriven(true, 0.05), false, 'the prefix really was rebuilt');
  assert.equal(isAppendDriven(true, null), false, 'no previous round → cannot attribute it to an append');
  assert.equal(isAppendDriven(false, 1), false, 'not repaid at all, so it is not a REPAY sub-case');
  assert.equal(isAppendDriven(true, 0.9), true, 'the boundary is inclusive, same as HEALTHY_HIT_RATE');
});

function appendFixture(rows: Array<{ input: number; read: number }>): {
  sessionPath: string;
  usageLogPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'context-ledger-append-'));
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const sessionPath = join(dir, 'sessions', 'sess_append.json');
  writeFileSync(
    sessionPath,
    JSON.stringify({ id: 'sess_append', provider: 'openai', model: 'm', messages: [{ role: 'user', content: 'hi' }], toolCalls: [] }),
    'utf-8',
  );
  const records = rows.map((row, index) => rec({
    step: index + 1,
    requestMessageCount: 4 + index,
    promptChars: 1000 * (index + 1),
    toolNames: ['read_file'],
    usage: { inputTokens: row.input, outputTokens: 10, cacheReadTokens: row.read },
  }));
  writeFileSync(
    join(dir, 'sessions', 'sess_append.trajectory.jsonl'),
    `${records.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf-8',
  );
  const usageLogPath = join(dir, 'usage.jsonl');
  writeFileSync(
    usageLogPath,
    rows.map((row) => JSON.stringify({
      ts: 't', sessionId: 'sess_append', provider: 'openai', model: 'm',
      inputTokens: row.input, outputTokens: 10, cacheReadTokens: row.read,
      toolScope: 'standard', toolCount: 274, turnId: 'turn_1',
    })).join('\n'),
    'utf-8',
  );
  return { sessionPath, usageLogPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('REPAY splits three ways: real rebuild, large append, ordinary append', async () => {
  // 0: cold start. prompt 24,000, but input 4,000 < 5,000 so it is not a REPAY round.
  // 1: REAL REBUILD  — input 20,000 / cacheRead 5,000 against a 24,000 prompt → reuse 0.208.
  // 2: LARGE APPEND  — previous prompt 25,000; appends 8,000 fresh tokens; cacheRead 24,990
  //                    → hit 75.7% (< 90%) but reuse 0.9996 (prefix reused intact).
  // 3: ORDINARY APPEND — previous prompt 32,990; appends only 200 tokens; cacheRead 32,800
  //                    → hit 99.4%, not a repay at all.
  const { sessionPath, usageLogPath, cleanup } = appendFixture([
    { input: 4_000, read: 20_000 },
    { input: 20_000, read: 5_000 },
    { input: 8_000, read: 24_990 },
    { input: 200, read: 32_800 },
  ]);
  try {
    const report = await buildReport({ sessionPath, usageLogPath });
    assert.deepEqual(report.cache.repayedRounds, [1, 2], 'the headline list is unchanged in meaning');
    assert.deepEqual(report.cache.appendDrivenRounds, [2]);
    assert.deepEqual(
      report.rounds.map((row) => [row.i, row.repayed, row.appendDriven]),
      [[0, false, false], [1, true, false], [2, true, true], [3, false, false]],
    );
    assert.equal(report.rounds[0].observedReuse, null, 'the cold start has no previous prefix');
    assert.equal(report.rounds[1].observedReuse, 5_000 / 24_000);
    assert.equal(report.rounds[2].observedReuse, 24_990 / 25_000);
    assert.equal(report.rounds[3].hitRate >= 0.9, true);

    // The new fields only annotate: the headline arithmetic did not move.
    const totalInput = 4_000 + 20_000 + 8_000 + 200;
    const totalRead = 20_000 + 5_000 + 24_990 + 32_800;
    assert.equal(report.cache.totalInputTokens, totalInput);
    assert.equal(report.cache.totalCacheReadTokens, totalRead);
    assert.equal(report.cache.weightedHitRate, totalRead / (totalInput + totalRead));

    const text = formatReport(report);
    const appendRow = text.split('\n').find((line) => /^\s+2\s+3\s+1\s/.test(line));
    assert.ok(appendRow, 'the append round has a §2 row');
    assert.ok(appendRow.includes('REPAY') && appendRow.includes('APPEND'), 'both flags, not either/or');
    assert.ok(text.includes('其中大追加轮'));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 端到端：报告与聚合
// ---------------------------------------------------------------------------

function fixture(): {
  dir: string;
  sessionPath: string;
  usageLogPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'context-ledger-'));
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const sessionPath = join(dir, 'sessions', 'sess_test.json');
  writeFileSync(
    sessionPath,
    JSON.stringify({
      id: 'sess_test',
      provider: 'openai',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      toolCalls: [],
    }),
    'utf-8',
  );
  const rows = [
    // turn 1, round 0: cold start, nothing cached.
    rec({ step: 1, requestMessageCount: 4, promptChars: 1000, toolNames: ['read_file'], usage: { inputTokens: 5000, outputTokens: 10, cacheReadTokens: 0 } }),
    // turn 1, round 1: append-only history, same called set, but the provider reused nothing.
    rec({ step: 2, requestMessageCount: 6, promptChars: 2000, toolNames: ['read_file'], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } }),
    // turn 2, round 2: append-only, healthy reuse.
    rec({ step: 1, requestMessageCount: 8, promptChars: 3000, toolNames: ['write_file'], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1900 } }),
  ];
  writeFileSync(
    join(dir, 'sessions', 'sess_test.trajectory.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf-8',
  );
  const usageLogPath = join(dir, 'usage.jsonl');
  writeFileSync(
    usageLogPath,
    [
      { ts: 't1', sessionId: 'sess_test', provider: 'openai', model: 'm', inputTokens: 5100, outputTokens: 20, cacheReadTokens: 0, toolScope: 'standard', toolCount: 274, turnId: 'turn_1' },
      { ts: 't2', sessionId: 'sess_test', provider: 'openai', model: 'm', inputTokens: 100, outputTokens: 10, cacheReadTokens: 1900, toolScope: 'standard', toolCount: 274, turnId: 'turn_2' },
    ].map((row) => JSON.stringify(row)).join('\n'),
    'utf-8',
  );
  return { dir, sessionPath, usageLogPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('buildReport emits one row per adjacent round pair and keeps the cache numbers as they were', async () => {
  const { sessionPath, usageLogPath, cleanup } = fixture();
  try {
    const report = await buildReport({ sessionPath, usageLogPath });
    assert.equal(report.rounds.length, 3);
    assert.equal(report.turns.length, 2);
    assert.equal(report.pairs.length, 2, 'pairs = rounds - 1');
    assert.deepEqual(report.pairs.map((pair) => [pair.prevRound, pair.round]), [[0, 1], [1, 2]]);
    assert.equal(report.toolDiagnosis.pairs, 2);
    assert.equal(report.toolDiagnosis.layers['called-tools'], 2);
    // The headline cache arithmetic is untouched by the new diagnosis.
    assert.equal(report.cache.totalInputTokens, 5200);
    assert.equal(report.cache.totalCacheReadTokens, 1900);
    assert.equal(report.cache.weightedHitRate, 1900 / (5200 + 1900));
  } finally {
    cleanup();
  }
});

test('a break the local artifacts cannot explain is listed as unexplained', async () => {
  const { sessionPath, usageLogPath, cleanup } = fixture();
  try {
    const report = await buildReport({ sessionPath, usageLogPath });
    const d = report.toolDiagnosis;
    // Pair 0→1: append-only history, identical called set, yet cacheRead was 0.
    assert.deepEqual(d.unexplainedBreaks.map((pair) => [pair.prevRound, pair.round]), [[0, 1]]);
    // Pair 1→2: healthy reuse, not a break.
    assert.ok(!d.unexplainedBreaks.some((pair) => pair.round === 2));
    assert.equal(d.prefixChanged, 0, 'nothing in the artifacts moved the prefix');
    assert.equal(d.prefixNoEvidence, 2);
    const text = formatReport(report);
    assert.ok(text.includes('== 1b. 相邻轮次三向诊断'));
    assert.ok(text.includes('本地无变更证据、服务端却未复用'));
    assert.ok(text.includes('called-tools 2 对'));
  } finally {
    cleanup();
  }
});

test('a reordered sent array shows up in the pair table and not in the turn-level fingerprint', async () => {
  const { dir, sessionPath, usageLogPath, cleanup } = fixture();
  try {
    // Same tool count for both rounds of turn 1 (so the ledger-scope-count
    // fingerprint cannot see anything), but the recorded sent array is reordered.
    writeFileSync(
      join(dir, 'sessions', 'sess_test.trajectory.jsonl'),
      `${[
        rec({ step: 1, requestMessageCount: 4, promptChars: 1000, toolSetNames: ['write_file', 'read_file'] }),
        rec({ step: 2, requestMessageCount: 6, promptChars: 2000, toolSetNames: ['read_file', 'write_file'] }),
        rec({ step: 1, requestMessageCount: 8, promptChars: 3000, toolSetNames: ['read_file', 'write_file'] }),
      ].map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf-8',
    );
    const report = await buildReport({ sessionPath, usageLogPath });
    assert.equal(report.toolDiagnosis.layers['sent-tools'], 2);
    assert.deepEqual(report.toolDiagnosis.orderOnlyPairs, [{ prevRound: 0, round: 1, layer: 'sent-tools' }]);
    assert.equal(report.turns[0].surfaceChanged, null, 'the count-level fingerprint is blind here');
    assert.equal(report.pairs[0].prefixBytesChanged, true);
    assert.equal(report.pairs[1].toolOrderOnlyChanged, false, 'turn 2 kept the same order');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 发送顺序不受影响
// ---------------------------------------------------------------------------

function dummyTool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputHint: '',
    risk: 'read',
    validate: (input) => input,
    execute: async () => ({ ok: true, output: '' }),
  };
}

test('the payload keeps the registry alphabetical order — canonicalisation never reorders what is sent', () => {
  const scrambled = ['write_file', 'apply_patch', 'read_file', 'search_text'];
  const registry = new ToolRegistry();
  for (const name of scrambled) registry.register(dummyTool(name));
  assert.deepEqual(registry.list().map((tool) => tool.name), [...scrambled].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(
    registry.specs().map((spec) => spec.name),
    registry.list().map((tool) => tool.name),
    'specs() follows list(): the sent array is a function of names, not of registration order',
  );

  // The trim path sorts by usefulness and then restores the alphabetical order
  // that the provider caches, so it cannot emit a reordered array either.
  const many = Array.from({ length: 12 }, (_, index) => dummyTool(`tool_${String(index).padStart(2, '0')}`));
  const trimmed = limitProviderTools(many, { max: 5 });
  assert.deepEqual(
    trimmed.tools.map((tool) => tool.name),
    trimmed.tools.map((tool) => tool.name).slice().sort((a, b) => a.localeCompare(b)),
    'the trimmed array is still alphabetical',
  );
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('findLatestSession ignores trajectory sidecars and picks the newest session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-latest-'));
  try {
    const older = join(dir, 'sess_old.json');
    const newer = join(dir, 'sess_new.json');
    writeFileSync(older, '{}', 'utf-8');
    writeFileSync(newer, '{}', 'utf-8');
    writeFileSync(join(dir, 'sess_new.trajectory.jsonl'), '{}\n', 'utf-8');
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    utimesSync(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
    assert.equal(findLatestSession(dir), newer);
    assert.equal(findLatestSession(join(dir, 'nope')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--latest and --session-dir parse without a positional path', () => {
  const options = parseArgs(['--latest', '--session-dir', 'C:/tmp/sessions', '--index', '3']);
  assert.equal(options.latest, true);
  assert.equal(options.sessionDir, 'C:/tmp/sessions');
  assert.equal(options.index, 3);
  assert.equal(options.sessionPath, undefined);
  assert.throws(() => parseArgs(['--session-dir']), /需要一个目录/);
});
