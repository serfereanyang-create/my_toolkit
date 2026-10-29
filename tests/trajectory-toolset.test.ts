/**
 * trajectory-toolset.test.ts — 发送工具数组（toolSetNames）的落盘与哈希语义。
 *
 * 这一组用**确定性种子**的伪随机生成器（mulberry32，自己写，无依赖）批量构造
 * 工具名序列，验证的是性质而不是样例：
 *
 *   1. 顺序保持   —— 写入什么顺序，读回就是什么顺序；记录侧的规范形（排序）
 *                    绝不改写发送数组本身。
 *   2. 哈希语义   —— toolSetOrderHash 顺序敏感（同集合不同序 → 不同），
 *                    toolNamesHash 顺序无关（重数保留）。
 *   3. 重数保留   —— [a,a,b] 与 [a,b] 不是同一个多重集合。
 *   4. 空与缺省   —— [] 是事实，undefined 是未知，老行不给字段；三者都不抛异常、
 *                    且各自落在明确的层上。
 *   5. 回退一致   —— 没有发送数组的行落在 called-tools，并明说自己不是 sent-tools。
 *   6. 单调性     —— turn 间工具集只增不减时，顺序哈希每轮必变、前缀必有变更证据。
 *   7. 确定性     —— 同一种子跑两次，生成的序列与判定结果完全一致。
 *
 * 每个随机用例失败时都会把触发的输入打印出来，便于定位。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildReport,
  diagnoseRoundPairs,
  surfaceOf,
  type RoundRow,
} from '../src/audit/contextLedger.js';
import {
  canonicalToolNames,
  recordTrajectoryRow,
  recordedToolSurface,
  readTrajectoryRecords,
  toolNamesHash,
  toolNamesOrderHash,
  withCanonicalToolNames,
  type TrajectoryRecord,
} from '../src/session/modelTrajectory.js';

// ---------------------------------------------------------------------------
// 确定性伪随机（mulberry32）：同一种子在任何机器上产生同一条流
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates，输入不被修改。 */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const TOOL_POOL = [
  'read_file',
  'write_file',
  'apply_patch',
  'search_text',
  'list_files',
  'run_command',
  'project_index',
  'propose_plan',
  'spawn_subagent',
  'review_loop',
  'mcp_filesystem__read',
  'mcp_github__search',
  'computer_click',
  'web_fetch',
] as const;

type ToolArray = string[];

/** 随机长度 0..maxLen、随机顺序（可含重名，重名合法：多重集合）。 */
function randomToolArray(random: () => number, maxLen = 12): ToolArray {
  const length = Math.floor(random() * (maxLen + 1));
  const out: ToolArray = [];
  for (let i = 0; i < length; i++) {
    out.push(TOOL_POOL[Math.floor(random() * TOOL_POOL.length)]!);
  }
  return out;
}

/** 同多重集合的一次随机重排，重数逐位保留。 */
function randomPermutationOf(array: ToolArray, random: () => number): ToolArray {
  return shuffle(array, random);
}

function tempSession() {
  const dir = mkdtempSync(join(tmpdir(), 'toolset-'));
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const sessionPath = join(dir, 'sessions', 'sess_toolset.json');
  writeFileSync(sessionPath, JSON.stringify({ id: 'sess_toolset', messages: [], toolCalls: [] }), 'utf-8');
  return { dir, sessionPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** diagnoseRoundPairs 需要的最小 RoundRow；口径与 contextLedger.test.ts 一致。 */
function roundRow(i: number, turn: number, step: number): RoundRow {
  const inputTokens = 100;
  const cacheReadTokens = 1900;
  return {
    i,
    turn,
    step,
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
    turnFirst: step === 1,
    surface: surfaceOf({ toolScope: 'standard', toolCount: 274 }),
    surfaceChanged: false,
  };
}

function baseRow(over: Record<string, unknown>): TrajectoryRecord {
  return {
    requestId: 'r',
    turnId: 't',
    step: 1,
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

// ---------------------------------------------------------------------------
// 1. 顺序保持：写入 → 读回，逐位相等（随机 250 例）
// ---------------------------------------------------------------------------

test('order is preserved verbatim through disk for 250 random sequences', () => {
  const { sessionPath, cleanup } = tempSession();
  try {
    const random = mulberry32(0x5eed_0001);
    const cases: ToolArray[] = [];
    for (let i = 0; i < 250; i++) {
      const names = randomToolArray(random);
      cases.push(names);
      recordTrajectoryRow(sessionPath, baseRow({ requestId: `r${i}`, step: i + 1, toolNames: ['read_file'], toolSetNames: names }));
    }
    const rows = readTrajectoryRecords(sessionPath);
    assert.equal(rows.length, cases.length, 'one row per case');
    cases.forEach((names, i) => {
      const row = rows[i]!;
      const context = `case ${i}: sent=${JSON.stringify(names)}`;
      assert.deepEqual(row.toolSetNames, names, `order must survive the round-trip (${context})`);
      assert.deepEqual(row.toolSetCanonical, canonicalToolNames(names), `canonical is sorted (${context})`);
      assert.equal(row.toolSetHash, toolNamesHash(names), `set hash is the multiset identity (${context})`);
      assert.equal(row.toolSetOrderHash, toolNamesOrderHash(names), `order hash is the raw sequence identity (${context})`);
      // The sorted form must not leak back into the sent array.
      assert.deepEqual(row.toolSetNames, names, `canonicalisation never rewrites what was sent (${context})`);
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. 哈希语义：顺序敏感 vs 顺序无关（随机排列 200 例 + 显式反例）
// ---------------------------------------------------------------------------

test('random permutations: order hash distinguishes, set hash does not', () => {
  const random = mulberry32(0x5eed_0002);
  let reordered = 0;
  for (let i = 0; i < 200; i++) {
    const base = randomToolArray(random);
    const permuted = randomPermutationOf(base, random);
    const context = `case ${i}: base=${JSON.stringify(base)} permuted=${JSON.stringify(permuted)}`;

    // Same multiset, by construction (sort drops to identical arrays).
    assert.deepEqual(canonicalToolNames(base), canonicalToolNames(permuted), `same multiset (${context})`);
    assert.equal(toolNamesHash(base), toolNamesHash(permuted), `multiset hash ignores order (${context})`);

    const baseOrder = toolNamesOrderHash(base);
    const permutedOrder = toolNamesOrderHash(permuted);
    if (JSON.stringify(base) === JSON.stringify(permuted)) {
      assert.equal(baseOrder, permutedOrder, `identical sequences hash equal (${context})`);
      continue;
    }
    reordered++;
    assert.notEqual(baseOrder, permutedOrder, `order-sensitive hash must differ for a real reorder (${context})`);
    assert.notEqual(
      withCanonicalToolNames(baseRow({ toolSetNames: base })).toolSetOrderHash,
      withCanonicalToolNames(baseRow({ toolSetNames: permuted })).toolSetOrderHash,
      `the recorded toolSetOrderHash must differ too (${context})`,
    );
  }
  // Guard against a degenerate generator: if nothing ever reordered, the test
  // above proves nothing. The pool + lengths make this essentially certain.
  assert.ok(reordered > 100, `expected most cases to reorder something; got ${reordered}/200`);
});

test('explicit counterexamples: reorder is a different prefix, same set', () => {
  const a = ['read_file', 'write_file'];
  const b = ['write_file', 'read_file'];
  assert.equal(toolNamesHash(a), toolNamesHash(b), 'multiset is identical');
  assert.notEqual(toolNamesOrderHash(a), toolNamesOrderHash(b), 'order-sensitive hash must not collide');

  // Recorded form: both hashes land on the row, and only one of them moves.
  const rowA = withCanonicalToolNames(baseRow({ toolSetNames: a }));
  const rowB = withCanonicalToolNames(baseRow({ toolSetNames: b }));
  assert.equal(rowA.toolSetHash, rowB.toolSetHash, 'the multiset hash is blind to the reorder — by design');
  assert.notEqual(rowA.toolSetOrderHash, rowB.toolSetOrderHash, 'the order hash is the witness of the reorder');
});

// ---------------------------------------------------------------------------
// 3. 重数保留
// ---------------------------------------------------------------------------

test('multiplicity is part of both identities', () => {
  const twice = ['a', 'a', 'b'];
  const once = ['a', 'b'];
  assert.notEqual(toolNamesHash(twice), toolNamesHash(once), 'set hash keeps repeats');
  assert.notEqual(toolNamesOrderHash(twice), toolNamesOrderHash(once), 'order hash keeps repeats');

  // Randomised: dropping one repeat from a random array always changes both.
  const random = mulberry32(0x5eed_0003);
  for (let i = 0; i < 200; i++) {
    const names = randomToolArray(random);
    if (names.length === 0) continue;
    const trimmed = names.slice(0, -1);
    const context = `case ${i}: full=${JSON.stringify(names)} trimmed=${JSON.stringify(trimmed)}`;
    assert.notEqual(toolNamesHash(names), toolNamesHash(trimmed), `a dropped repeat changes the multiset (${context})`);
    assert.notEqual(toolNamesOrderHash(names), toolNamesOrderHash(trimmed), `a dropped repeat changes the sequence (${context})`);
  }
});

// ---------------------------------------------------------------------------
// 4. 空与缺省：[] / undefined / 老行
// ---------------------------------------------------------------------------

test('empty, undefined and legacy rows each have a defined, non-throwing behaviour', () => {
  // [] is a fact: a request with no tools. It hashes, and it is not "unknown".
  assert.deepEqual(canonicalToolNames([]), []);
  assert.equal(typeof toolNamesHash([]), 'string');
  assert.equal(typeof toolNamesOrderHash([]), 'string');
  const enriched = withCanonicalToolNames(baseRow({ toolSetNames: [] }));
  assert.deepEqual(enriched.toolSetCanonical, []);
  assert.equal(typeof enriched.toolSetHash, 'string');
  assert.equal(typeof enriched.toolSetOrderHash, 'string');

  // undefined is unknown: no field is invented.
  const absent = withCanonicalToolNames(baseRow({ toolNames: [] }));
  assert.equal(absent.toolSetNames, undefined);
  assert.equal(absent.toolSetCanonical, undefined);
  assert.equal(absent.toolSetHash, undefined);
  assert.equal(absent.toolSetOrderHash, undefined);
  assert.equal(recordedToolSurface(baseRow({ toolNames: [] })).layer, 'called-tools');

  // Legacy row on disk: no toolSetNames at all → called-tools, order hash null.
  const legacy = recordedToolSurface(baseRow({ toolNames: ['read_file', 'write_file'] }));
  assert.equal(legacy.layer, 'called-tools');
  assert.equal(legacy.orderHash, null, 'a call log has no sent-order identity');
  assert.deepEqual(legacy.canonical, ['read_file', 'write_file']);

  // Legacy row with NEITHER array: layer none, nothing throws.
  assert.equal(recordedToolSurface(baseRow({ toolNames: undefined })).layer, 'none');
  assert.equal(toolNamesHash(undefined), null);
  assert.equal(toolNamesOrderHash(undefined), null);
});

// ---------------------------------------------------------------------------
// 5. 回退一致性：没有发送数组的行必须落在 called-tools 且明说不是 sent-tools
// ---------------------------------------------------------------------------

test('a row without toolSetNames is diagnosed on called-tools and says so', () => {
  const records = [
    baseRow({ step: 1, toolNames: ['read_file'], requestMessageCount: 4, promptChars: 1000 }),
    baseRow({ step: 2, toolNames: ['read_file', 'write_file'], requestMessageCount: 6, promptChars: 2000 }),
  ];
  const [pair] = diagnoseRoundPairs(records, [roundRow(0, 1, 1), roundRow(1, 1, 2)]);
  assert.equal(pair?.layer, 'called-tools');
  assert.equal(pair?.toolSetOrderHash, null, 'no sent-order evidence on the fallback layer');
  assert.equal(pair?.toolSetChanged, true);

  // With the sent array recorded the same content moves to sent-tools.
  const [sentPair] = diagnoseRoundPairs(
    records.map((record) => ({ ...record, toolSetNames: record.toolNames })),
    [roundRow(0, 1, 1), roundRow(1, 1, 2)],
  );
  assert.equal(sentPair?.layer, 'sent-tools');
  assert.equal(typeof sentPair?.toolSetOrderHash, 'string');
});

// ---------------------------------------------------------------------------
// 6. 单调性：widen-only 工具集，每轮哈希必变、前缀必有变更证据
// ---------------------------------------------------------------------------

test('a widen-only tool surface changes the order hash exactly when it grows', () => {
  const random = mulberry32(0x5eed_0006);
  const records: TrajectoryRecord[] = [];
  const rounds: RoundRow[] = [];
  // Start from a random subset, then only ever ADD (the resolveToolScope floor).
  // The pool is finite, so growth stops after 9 turns; the turns after that
  // must keep the SAME hash — that is the "never shrinks" half of the property.
  const remaining = shuffle(TOOL_POOL, random);
  const current: string[] = remaining.splice(0, 3).sort((x, y) => x.localeCompare(y));
  const grewByTurn: boolean[] = [false];
  let step = 0;
  let turnIndex = 0;
  for (let turn = 0; turn < 14; turn++) {
    if (turn > 0) {
      turnIndex++;
      const additions = 1 + Math.floor(random() * 2);
      let grew = false;
      for (let a = 0; a < additions && remaining.length > 0; a++) {
        current.push(remaining.shift()!);
        grew = true;
      }
      if (grew) current.sort((x, y) => x.localeCompare(y));
      grewByTurn.push(grew);
    }
    assert.ok(grewByTurn.length === turn + 1);
    const roundsInTurn = 1 + Math.floor(random() * 3);
    for (let r = 0; r < roundsInTurn; r++) {
      step++;
      records.push(baseRow({
        step: r === 0 ? 1 : step,
        requestMessageCount: 4 + step,
        promptChars: 1000 * (step + 1),
        toolNames: [], // recorded nothing distinct; the sent array is the evidence
        toolSetNames: [...current],
      }));
      rounds.push(roundRow(records.length - 1, turnIndex + 1, r === 0 ? 1 : r + 1));
    }
  }

  const pairs = diagnoseRoundPairs(records, rounds);
  assert.equal(pairs.length, records.length - 1);
  let crossing = 0;
  let grown = 0;
  for (const pair of pairs) {
    if (!pair.crossesTurn) {
      // Within a turn the array is the same every round: same hash, no change.
      assert.equal(pair.prevToolSetOrderHash, pair.toolSetOrderHash, `turn-internal arrays are identical (pair ${pair.prevRound}→${pair.round})`);
      continue;
    }
    crossing++;
    const context = `pair ${pair.prevRound}→${pair.round} (turn boundary)`;
    const thisTurn = rounds[pair.round]!.turn;
    if (grewByTurn[thisTurn - 1]) {
      grown++;
      assert.notEqual(pair.prevToolSetOrderHash, pair.toolSetOrderHash, `growing the set must change the order hash (${context})`);
      assert.equal(pair.prefixBytesChanged, true, `a changed sent array is prefix evidence (${context})`);
      assert.ok(pair.prefixEvidence.includes('sent-tool-set-changed'), `the set-change evidence is named (${context})`);
    } else {
      assert.equal(pair.prevToolSetOrderHash, pair.toolSetOrderHash, `no growth ⇒ same array, same hash (${context})`);
    }
    assert.equal(pair.layer, 'sent-tools', `the evidence comes from the sent layer (${context})`);
  }
  assert.ok(crossing >= 13, `expected a pair per turn boundary; got ${crossing}`);
  assert.ok(grown >= 5, `expected the generator to actually widen the set; grew ${grown} times`);
  assert.ok(grown < crossing, 'some turns must NOT grow, so the "no growth ⇒ same hash" half is exercised too');
});

// ---------------------------------------------------------------------------
// 7. 确定性：同一种子两次生成，序列与判定完全一致
// ---------------------------------------------------------------------------

type GeneratedCase = {
  sent: ToolArray;
  permuted: ToolArray;
  verdict: { setEqual: boolean; orderEqual: boolean };
};

function generateCases(seed: number): GeneratedCase[] {
  const random = mulberry32(seed);
  const out: GeneratedCase[] = [];
  for (let i = 0; i < 200; i++) {
    const sent = randomToolArray(random);
    const permuted = randomPermutationOf(sent, random);
    out.push({
      sent,
      permuted,
      verdict: {
        setEqual: toolNamesHash(sent) === toolNamesHash(permuted),
        orderEqual: toolNamesOrderHash(sent) === toolNamesOrderHash(permuted),
      },
    });
  }
  return out;
}

test('the same seed produces the same cases and verdicts twice', () => {
  const first = generateCases(0x5eed_0abc);
  const second = generateCases(0x5eed_0abc);
  assert.equal(first.length, 200);
  assert.deepEqual(
    first.map((entry) => JSON.stringify(entry)),
    second.map((entry) => JSON.stringify(entry)),
    'the generator itself must not be a source of flakiness',
  );
  // And the property it encodes holds for every generated pair.
  for (const [i, entry] of first.entries()) {
    const context = `case ${i}: ${JSON.stringify(entry.sent)} vs ${JSON.stringify(entry.permuted)}`;
    assert.equal(entry.verdict.setEqual, true, `multiset hash is order-free (${context})`);
    const sameSequence = JSON.stringify(entry.sent) === JSON.stringify(entry.permuted);
    assert.equal(entry.verdict.orderEqual, sameSequence, `order hash equals only for identical sequences (${context})`);
  }
});

// ---------------------------------------------------------------------------
// 8. 端到端：真实写盘 → buildReport，新会话必须落在 sent-tools 层
// ---------------------------------------------------------------------------

test('a session written with toolSetNames is reported on the sent-tools layer end to end', async () => {
  const { dir, sessionPath, cleanup } = tempSession();
  try {
    const random = mulberry32(0x5eed_e2e);
    const usageLogPath = join(dir, 'usage.jsonl');
    const rows = [
      baseRow({ step: 1, requestMessageCount: 4, promptChars: 1000, toolNames: ['read_file'], toolSetNames: ['read_file', 'write_file'], usage: { inputTokens: 5000, outputTokens: 10, cacheReadTokens: 0 } }),
      baseRow({ step: 2, requestMessageCount: 6, promptChars: 2000, toolNames: ['write_file'], toolSetNames: ['write_file', 'read_file'], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } }),
      baseRow({ step: 1, requestMessageCount: 8, promptChars: 3000, toolNames: ['read_file'], toolSetNames: ['apply_patch', 'read_file', 'write_file'], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1900 } }),
    ];
    writeFileSync(join(dir, 'sessions', 'sess_toolset.trajectory.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf-8');
    writeFileSync(
      usageLogPath,
      [
        { ts: 't1', sessionId: 'sess_toolset', provider: 'p', model: 'm', inputTokens: 5100, outputTokens: 20, cacheReadTokens: 0, toolScope: 'standard', toolCount: 2, turnId: 'turn_1' },
        { ts: 't2', sessionId: 'sess_toolset', provider: 'p', model: 'm', inputTokens: 100, outputTokens: 10, cacheReadTokens: 1900, toolScope: 'standard', toolCount: 3, turnId: 'turn_2' },
      ].map((row) => JSON.stringify(row)).join('\n'),
      'utf-8',
    );
    const report = await buildReport({ sessionPath, usageLogPath });
    assert.equal(report.pairs.length, 2);
    assert.equal(report.toolDiagnosis.layers['sent-tools'], 2, 'both pairs are diagnosed from the real sent array');
    // The reorder inside turn 1 is only visible on the sent layer.
    assert.deepEqual(report.pairs[0]?.prefixEvidence, ['sent-tool-order-changed']);
    assert.equal(report.pairs[0]?.toolSetOrderHash, toolNamesOrderHash(['write_file', 'read_file']));
    // Turn 2 added a tool: a set change, not a reorder.
    assert.equal(report.pairs[1]?.toolSetChanged, true);
    assert.ok(report.pairs[1]?.prefixEvidence.includes('sent-tool-set-changed'));
    // Headline cache arithmetic is untouched by the layer switch.
    assert.equal(report.cache.totalInputTokens, 5200);
    assert.equal(report.cache.totalCacheReadTokens, 1900);
    assert.equal(report.cache.weightedHitRate, 1900 / (5200 + 1900));
    // The generator is deterministic here too: same arrays, same hash.
    assert.equal(toolNamesOrderHash(['read_file', 'write_file']), toolNamesOrderHash(['read_file', 'write_file']));
    assert.ok(random() >= 0 && random() < 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. 回退链：空发送数组是事实，不能回退到 called-tools
// ---------------------------------------------------------------------------

test('an empty toolSetNames stays on sent-tools and never falls back to the call log', () => {
  // The writer (agent.ts) records `stepTools.list().map(t => t.name)`, which is
  // `[]` on a turn that sends no tools at all. `recordedToolSurface` must keep
  // that on the sent layer: the array was sent, it was empty. Falling back to
  // `toolNames` would relabel an empty sent array as "the tools the model
  // called", i.e. invent evidence the cache diagnostic then trusts.
  const row = baseRow({ toolNames: ['read_file', 'write_file'], toolSetNames: [] });
  const surface = recordedToolSurface(row);
  assert.equal(surface.layer, 'sent-tools');
  assert.deepEqual(surface.raw, []);
  assert.deepEqual(surface.canonical, []);
  assert.equal(typeof surface.orderHash, 'string', 'the empty array has an order hash — it is a known sequence');
  // ...and it differs from the call log, which would have canonicalised to
  // ['read_file','write_file'].
  assert.notDeepEqual(surface.canonical, canonicalToolNames(['read_file', 'write_file']));

  // Recorded form and legacy form agree: a row with [] on disk reads the same.
  const recorded = withCanonicalToolNames(row);
  assert.deepEqual(recorded.toolSetCanonical, []);
  assert.equal(recorded.toolSetOrderHash, surface.orderHash);

  // Only an ABSENT field takes the fallback.
  assert.equal(recordedToolSurface(baseRow({ toolNames: ['read_file'] })).layer, 'called-tools');
});

test('a corrupt cached canonical/hash is recomputed instead of trusted', () => {
  // Trajectory files are JSONL on disk; a hand-edited or half-repaired row can
  // carry a string where the type promises an array. `??` alone would hand that
  // string to every reader as if it were a name list.
  const row = baseRow({
    toolNames: ['read_file'],
    toolSetNames: ['write_file', 'read_file'],
    toolSetCanonical: 'write_file,read_file',
    toolSetOrderHash: 7,
  });
  const surface = recordedToolSurface(row);
  assert.equal(surface.layer, 'sent-tools');
  assert.deepEqual(surface.canonical, ['read_file', 'write_file'], 'recomputed canonical, never the raw string');
  assert.equal(surface.orderHash, toolNamesOrderHash(['write_file', 'read_file']), 'recomputed order hash');

  // A valid cached value IS trusted (the point of writing it).
  const trusted = recordedToolSurface(baseRow({
    toolSetNames: ['b', 'a'],
    toolSetCanonical: ['a', 'b'],
    toolSetOrderHash: 'deadbeef0000',
  }));
  assert.deepEqual(trusted.canonical, ['a', 'b']);
  assert.equal(trusted.orderHash, 'deadbeef0000');

  // Same guard on the called-tools layer.
  const called = recordedToolSurface(baseRow({ toolNames: ['b', 'a'], toolNamesCanonical: { length: 2 } }));
  assert.deepEqual(called.canonical, ['a', 'b']);
});
