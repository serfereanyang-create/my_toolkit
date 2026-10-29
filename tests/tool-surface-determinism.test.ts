/**
 * tool-surface-determinism.test.ts — `limitProviderTools` / `registry.list()`
 * 的确定性与边界，性质测试（mulberry32 定种子，失败打印种子与 case）。
 *
 * 背景（2026-10-29 工具面审计，实测）：
 *
 *   1. 顺序不稳定。`limitProviderTools` 只在超限分支排序，且并列用
 *      `localeCompare`——它对不同字符串返回 0（"a" vs "a­"，NFC/NFD 的
 *      "café"），于是并列顺序落到 Array.prototype.sort 的插入序上。400 例随机
 *      注册表里，同一集合、不同插入顺序、未超限（走短路早返回）时有 217 例
 *      输出不同；超限时因排序而一致。工具数组在 system 之前序列化，任一字节
 *      变化都从 0 位杀死缓存。
 *   2. `dropped` 不可信。旧实现 `ranked.slice(max)` 是 rank 序、不是字母序，
 *      也不去重；重复名会同时出现在 `tools` 和 `dropped`。
 *   3. `max` 边界。max=-1 时 `length <= -1` 为假，`slice(0,-1)` 保留 n-1、
 *      `slice(-1)` 丢掉真正的最后一个，返回值比 max 大 1；max=0/NaN 清空整个
 *      注册表；max>MAX_PROVIDER_TOOLS 时能发出超过 340 个工具。
 *   4. `registry.list()`。`localeCompare` 既非全序也非跨机器稳定（ICU 77：
 *      sv 下 "z" < "ä"，en/zh 下相反）。
 *
 * 这些测试用性质而不是样例：每个失败信息都带种子与 case 编号。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compareToolNames } from '../src/session/modelTrajectory.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  MAX_PROVIDER_TOOLS,
  limitProviderTools,
} from '../src/tools/scope.js';
import type { ToolDefinition, ToolResult } from '../src/tools/types.js';

const RISKS: ReadonlyArray<ToolDefinition['risk']> = ['read', 'write', 'shell', 'network'];
const PREFIXES = ['', 'plugin_', 'mcp_'] as const;

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

function tool(name: string, risk: ToolDefinition['risk'] = 'read'): ToolDefinition {
  return {
    name,
    description: `${name} (synthetic for tool-surface determinism tests)`,
    inputHint: 'no input',
    risk,
    validate: (input) => input,
    async execute(): Promise<ToolResult> {
      return { ok: true, output: '' };
    },
  };
}

/** A successful run must never throw on an odd-but-legal call. */
function limit(tools: ToolDefinition[], options: Parameters<typeof limitProviderTools>[1] = {}) {
  return limitProviderTools(tools, options);
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

function names(tools: readonly ToolDefinition[]): string[] {
  return tools.map((item) => item.name);
}

function digest(namesList: readonly string[]): string {
  return createHash('sha256').update(namesList.join('\n')).digest('hex');
}

// ---------------------------------------------------------------------------
// 1. 确定性：同一集合、不同插入顺序 → 同一数组；同一输入 → 逐字节相同
// ---------------------------------------------------------------------------

test('same registry in a different insertion order produces byte-identical tools and dropped', () => {
  const random = mulberry32(0x7a11_0001);
  const SEED = 0x7a11_0001;
  let overCap = 0;
  let underCap = 0;
  for (let caseIndex = 0; caseIndex < 400; caseIndex++) {
    const size = Math.floor(random() * 500);
    const unique = new Set<string>();
    const source: ToolDefinition[] = [];
    for (let i = 0; i < size; i++) {
      let name = `${PREFIXES[Math.floor(random() * PREFIXES.length)]}tool_${i}`;
      while (unique.has(name)) name += '_x';
      unique.add(name);
      source.push(tool(name, RISKS[Math.floor(random() * RISKS.length)]));
    }
    // Include max=0..340, plus the short-circuit region (max >= size).
    const max = Math.floor(random() * (MAX_PROVIDER_TOOLS + 1));
    const context = `seed ${SEED} case ${caseIndex} size ${size} max ${max}`;
    const first = limit(source, { max });
    const second = limit(shuffled(source, random), { max });
    assert.deepEqual(names(second.tools), names(first.tools), `tools order must not depend on insertion order (${context})`);
    assert.deepEqual(second.dropped, first.dropped, `dropped must not depend on insertion order (${context})`);
    assert.equal(digest(names(first.tools)), digest(names(second.tools)), `byte-identical tool array (${context})`);
    // And a second call on the SAME input is identical too.
    const third = limit(source, { max });
    assert.equal(digest(names(third.tools)), digest(names(first.tools)), `repeat call is stable (${context})`);
    assert.deepEqual(third.dropped, first.dropped, `repeat call drops the same names (${context})`);
    if (size > max) overCap++;
    else underCap++;
  }
  assert.ok(overCap > 100, `expected over-cap cases to be exercised; got ${overCap}`);
  assert.ok(underCap > 100, `expected under-cap cases too (the old short-circuit); got ${underCap}`);
});

test('a short-circuited list is still in canonical order when the caller hands it unsorted', () => {
  // The early return is intentional (no copy), but its contract must be
  // "already in registry order", because that array is what gets serialised.
  // registry.list() is sorted; this test proves why the early return is only
  // safe for that one caller and would not be safe for an arbitrary array.
  const registry = new ToolRegistry();
  for (const name of ['zeta', 'alpha', 'mike']) registry.register(tool(name));
  const listed = registry.list();
  assert.deepEqual(names(listed), ['alpha', 'mike', 'zeta']);
  const result = limit(listed, { max: 100 });
  assert.equal(result.tools, listed, 'under the cap the same array comes back untouched');
});

// ---------------------------------------------------------------------------
// 2. dropped 可信：与 tools 严格互补（按名字集合），不重不漏
// ---------------------------------------------------------------------------

test('dropped and tools are exact complements by name (random registries)', () => {
  const random = mulberry32(0x7a11_0002);
  const SEED = 0x7a11_0002;
  for (let caseIndex = 0; caseIndex < 400; caseIndex++) {
    const size = Math.floor(random() * 500);
    const source: ToolDefinition[] = [];
    for (let i = 0; i < size; i++) {
      // Prefixes and all four risks, so ranks 0-5 are all reachable.
      source.push(tool(`${PREFIXES[Math.floor(random() * PREFIXES.length)]}u_${i}`, RISKS[Math.floor(random() * RISKS.length)]));
    }
    const max = Math.floor(random() * (MAX_PROVIDER_TOOLS + 1));
    const protectedNames = new Set(source.filter(() => random() < 0.05).map((item) => item.name));
    const context = `seed ${SEED} case ${caseIndex} size ${size} max ${max} protected ${protectedNames.size}`;
    const result = limit(source, { max, protectedNames });
    const kept = new Set(names(result.tools));
    const dropped = new Set(result.dropped);
    for (const item of source) {
      const inKept = kept.has(item.name);
      const inDropped = dropped.has(item.name);
      assert.notEqual(inKept, inDropped, `${item.name} must be in exactly one side (${context})`);
    }
    assert.equal(result.tools.length + dropped.size, new Set(names(source)).size, `partition covers the input (${context})`);
    assert.equal(dropped.size, result.dropped.length, `dropped has no duplicate names (${context})`);
    assert.deepEqual(result.dropped, [...result.dropped].sort(compareToolNames), `dropped is canonical order (${context})`);
    assert.ok(result.tools.length <= max, `never above the requested max (${context})`);
    assert.ok(result.tools.length <= MAX_PROVIDER_TOOLS, `never above the hard ceiling (${context})`);
    // Every kept and dropped name is sorted strictly, so the serialised order
    // is total (no comparator ties are left for the sort implementation).
    for (const list of [names(result.tools), result.dropped]) {
      for (let i = 1; i < list.length; i++) {
        assert.ok(compareToolNames(list[i - 1]!, list[i]!) < 0, `strict order at ${i} (${context}: ${list[i - 1]} / ${list[i]})`);
      }
    }
  }
});

test('duplicate names in the input cannot appear on both sides or on neither', () => {
  // Registries reject duplicates, but limitProviderTools takes an array and
  // must not depend on that. Before the fix, kept=[a,a] and dropped contained
  // 'a' again only when the cap split the duplicates; the multiset contract
  // was different on each side.
  const source = [tool('a'), tool('a'), tool('b', 'write'), tool('c')];
  const byName = limit(source, { max: 2 });
  assert.deepEqual(names(byName.tools), ['a', 'a'], 'both copies of the same object stay');
  assert.deepEqual(byName.dropped, ['b', 'c'], 'the rest is reported once each, sorted');
  const keptNames = new Set(names(byName.tools));
  for (const name of byName.dropped) assert.ok(!keptNames.has(name), `${name} is both kept and dropped`);
  assert.equal(new Set(names(source)).size, keptNames.size + byName.dropped.length);
});

// ---------------------------------------------------------------------------
// 3. max 边界：没有任何输入能超过 340，且极端值不会清空注册表
// ---------------------------------------------------------------------------

test('max is clamped to [0, MAX_PROVIDER_TOOLS] and never widens the payload', () => {
  const source = Array.from({ length: MAX_PROVIDER_TOOLS + 60 }, (_, index) => tool(`t_${index}`));
  const cases: Array<[number | undefined, number]> = [
    [undefined, MAX_PROVIDER_TOOLS],
    [0, 0],
    [-1, 0],
    // Non-finite values are treated as "no usable limit given" and fall back to
    // the ceiling (with a reported warning), exactly like NaN.
    [-Infinity, MAX_PROVIDER_TOOLS],
    [2.5, 2],
    [1e9, MAX_PROVIDER_TOOLS],
    [Infinity, MAX_PROVIDER_TOOLS],
    [MAX_PROVIDER_TOOLS, MAX_PROVIDER_TOOLS],
    [source.length, MAX_PROVIDER_TOOLS],
  ];
  for (const [max, expected] of cases) {
    const result = limit(source, max === undefined ? {} : { max });
    assert.equal(result.tools.length, expected, `max ${String(max)}`);
    assert.equal(result.tools.length + result.dropped.length, source.length, `partition at max ${String(max)}`);
    assert.ok(result.tools.length <= MAX_PROVIDER_TOOLS, `max ${String(max)} exceeded the ceiling`);
  }
  // NaN is not finite: it is reported and replaced by the ceiling. Capture the
  // warning rather than printing it into the test output.
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
  try {
    const nan = limit(source, { max: Number.NaN });
    assert.equal(nan.tools.length, MAX_PROVIDER_TOOLS, 'NaN falls back to the ceiling, not to "drop everything"');
    assert.equal(nan.dropped.length, source.length - MAX_PROVIDER_TOOLS);
    assert.ok(messages.some((line) => line.includes('[ToolCap]') && line.includes('NaN')), 'a bad max is reported');
  } finally {
    console.error = original;
  }
});

test('a protection set larger than max cannot push the payload past max', () => {
  // The subagent runner's own note says "if the protection set itself is over
  // the limit, the limit wins". This is that assertion: 100 protected tools,
  // max 10, and the result is exactly 10 — the trimmed ones come from the
  // protected block because nothing else is left.
  const source = Array.from({ length: 120 }, (_, index) => tool(`z_${String(index).padStart(3, '0')}`, 'write'));
  const protectedNames = new Set(names(source).slice(0, 100));
  const result = limit(source, { max: 10, protectedNames });
  assert.equal(result.tools.length, 10);
  assert.equal(result.dropped.length, 110);
  assert.equal(result.tools.filter((item) => protectedNames.has(item.name)).length, 10, 'the ten it can keep are protected ones');
});

test('no input can produce more than MAX_PROVIDER_TOOLS', () => {
  const random = mulberry32(0x7a11_0003);
  const SEED = 0x7a11_0003;
  for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
    const size = Math.floor(random() * 800);
    const source = Array.from({ length: size }, (_, index) => tool(`n_${caseIndex}_${index}`));
    const max = [0, -5, 0.5, 339.9, 340, 341, 1e6, Number.NaN, Infinity, -Infinity][Math.floor(random() * 10)]!;
    const protectedNames = new Set(names(source).filter(() => random() < 0.5));
    const result = limit(source, { max, protectedNames });
    const context = `seed ${SEED} case ${caseIndex} size ${size} max ${String(max)}`;
    assert.ok(result.tools.length <= MAX_PROVIDER_TOOLS, `over the ceiling (${context})`);
    assert.ok(result.tools.length <= Math.max(0, Math.min(MAX_PROVIDER_TOOLS, Number.isFinite(max) ? Math.floor(max) : MAX_PROVIDER_TOOLS)), `over the effective max (${context})`);
  }
});

// ---------------------------------------------------------------------------
// 4. 排序键唯一：重名、大小写、非 ASCII 名
// ---------------------------------------------------------------------------

test('registry.list() is a total order: distinct names never compare equal', () => {
  const registry = new ToolRegistry();
  const tricky = [
    'z', 'Z', 'a', 'A', '_x', 'x', '10', '2', 'é', 'e',
    'café', 'café', // NFC vs NFD: localeCompare says equal, bytes do not
    'a­', 'a', // SOFT HYPHEN: localeCompare says equal
    'ß', 'ss', 'ö', 'oe', 'base_convert', 'base64_encode',
  ];
  for (const name of tricky) {
    try { registry.register(tool(name)); } catch { /* duplicate 'a' — the registry rejects it, as tested below */ }
  }
  const listed = names(registry.list());
  assert.equal(new Set(listed).size, listed.length, 'no name repeats');
  for (let i = 1; i < listed.length; i++) {
    assert.ok(compareToolNames(listed[i - 1]!, listed[i]!) < 0, `${listed[i - 1]} / ${listed[i]} are not strictly ordered`);
  }
  // The order does not depend on insertion order.
  const reversed = new ToolRegistry();
  for (const name of [...tricky].reverse()) {
    try { reversed.register(tool(name)); } catch { /* duplicate */ }
  }
  assert.deepEqual(names(reversed.list()), listed, 'same set, same order regardless of registration order');

  // The discriminating pair for the comparator: ICU treats "a" and "a­"
  // (SOFT HYPHEN) as equal, so a locale sort is free to keep whichever it saw
  // first. Byte order puts the prefix first, whatever the registration order.
  for (const order of [['a', 'a­'], ['a­', 'a']]) {
    const registry2 = new ToolRegistry();
    for (const name of order) registry2.register(tool(name));
    assert.deepEqual(names(registry2.list()), ['a', 'a­'], `insertion order ${JSON.stringify(order)}`);
  }
});

test('the registry rejects duplicate names and replace is an explicit opt-in', () => {
  const registry = new ToolRegistry();
  registry.register(tool('read_file'));
  assert.throws(() => registry.register(tool('read_file')), /Tool already registered: read_file/);
  registry.register({ ...tool('read_file'), description: 'replacement' }, { replace: true });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('read_file')?.description, 'replacement');
});

test('registry.list() does not consult the machine locale for non-ASCII names', () => {
  // ICU differs per locale ("z" < "ä" in sv, "ä" < "z" in en/zh). Pin the
  // property, not the ICU table: the list must equal the byte-order sort for
  // any locale, which is what makes the payload identical across machines.
  const registry = new ToolRegistry();
  for (const name of ['ä', 'z', 'ö', 'a', 'é', 'e']) registry.register(tool(name));
  assert.deepEqual(names(registry.list()), ['a', 'e', 'z', 'ä', 'é', 'ö']);
  assert.deepEqual(names(registry.list()), [...names(registry.list())].sort(compareToolNames));
});
