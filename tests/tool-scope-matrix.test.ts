import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import {
  AGENT_SPAWNING_TOOLS,
  DELEGATION_TOOLS,
  MAX_PROVIDER_TOOLS,
  isReadOnlyTool,
  limitProviderTools,
  resolveToolScope,
  selectScopedTools,
  type ResolvedToolScope,
} from '../src/tools/scope.js';
import { compareToolNames } from '../src/session/modelTrajectory.js';

/*
 * A recomputable table of "which tools a scope actually shows".
 *
 * tests/tool-scope.test.ts already pins the *rules* (compact is read-only,
 * standard admits read-only + delegation + HIGH_VALUE_EXTRA, the cap ranks by
 * usefulness). This file pins the *numbers*: one row per scope, plus the chain
 * that produces them, so a change in the registry or in an allowlist moves a
 * number that has to be consciously updated instead of silently drifting.
 *
 * The chain (src/agent/agent.ts:716-809):
 *   registry.list()            -> sorted by compareToolNames (UTF-16 code
 *                                 unit), the whole registry
 *   selectScopedTools()        -> filter only, order preserved
 *   [post-scope injections]    -> spawn/computer/plan/supervisor tools
 *   limitProviderTools()       -> rank + truncate at MAX_PROVIDER_TOOLS, then
 *                                 restore order
 *   ToolRegistry.specs()       -> map to provider payload, order preserved
 *
 * The numbers below were measured on this tree and are the reason the file
 * exists; they are not a target. When one changes, update the row *and* say in
 * the commit what changed the surface.
 */
const REGISTRY_SIZE = 363;
const REGISTRY_READ_ONLY = 294;

const MATRIX: Record<ResolvedToolScope, { all: number; readOnly: number; sent: number }> = {
  compact: { all: 200, readOnly: 197, sent: 200 },
  // 333 since run_script joined STANDARD_EXTRA_ALLOW (2026-10-29, tool-surface
  // audit): it is shell-risk, so the standard read-only rule could never reach
  // it, and its absence pushed the agent to hand-written `run_command`.
  standard: { all: 333, readOnly: 294, sent: 333 },
  full: { all: 363, readOnly: 294, sent: 340 },
};

/*
 * Injected by agent.ts AFTER selectScopedTools (agent.ts:733-791, cap at
 * 802-804), so they are not in any scope's count. propose_plan /
 * supervisor_status / open_pull_request are not pre-registered; spawn_subagent
 * and review_loop are (and are replaced in place), so they are already counted
 * by the scoped selection.
 */
const POST_SCOPE_ONLY = ['propose_plan', 'supervisor_status', 'open_pull_request'] as const;

function registry() {
  return createDefaultToolRegistry();
}

function scopedNames(scope: ResolvedToolScope) {
  return selectScopedTools(registry(), scope).map((tool) => tool.name);
}

test('the registry chain starts from one sorted list of 363 tools', () => {
  const all = registry().list();
  assert.equal(all.length, REGISTRY_SIZE);
  assert.equal(all.filter(isReadOnlyTool).length, REGISTRY_READ_ONLY);

  // registry.list() sorts with compareToolNames (UTF-16 code unit). It used
  // to be localeCompare, which is neither total nor machine-stable; the
  // registry only ever holds `[a-z][a-z0-9_]*` names today, but the sort must
  // not start depending on ICU or on insertion order the moment it does not.
  assert.deepEqual(
    all.map((tool) => tool.name),
    all.map((tool) => tool.name).sort(compareToolNames),
    'registry.list() must stay deterministically sorted',
  );

  // The risk histogram the read-only count is derived from. `read` is 295 but
  // one of those (spawn_subagent) can start a writing sub-agent, which is why
  // the read-only count is 294 and not 295.
  const byRisk = new Map<string, number>();
  for (const tool of all) byRisk.set(tool.risk, (byRisk.get(tool.risk) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...byRisk].sort()), { network: 4, read: 295, shell: 7, write: 57 });
  assert.equal(all.filter((tool) => tool.risk === 'read').length - all.filter((tool) => isReadOnlyTool(tool)).length, 1);
});

test('the two comparators disagree on three names, which is why sent order is byte order', () => {
  // 'base_convert' sorts before 'base64_*' under localeCompare because ICU
  // weighs '_' and digits differently; code-unit order puts 'base64_*' first.
  // Until 2026-10-29 registry.list() used the locale comparator and the ledger
  // canonicalised with the code-unit one, so the two disagreed here; the sent
  // array is now canonical order, and this test keeps the ICU difference
  // visible so nobody "restores" localeCompare thinking it is equivalent.
  const names = registry().list().map((tool) => tool.name);
  const locale = [...names].sort((a, b) => a.localeCompare(b));
  const codeUnit = [...names].sort(compareToolNames);
  const differing = names.map((_, index) => index).filter((index) => locale[index] !== codeUnit[index]);
  assert.deepEqual(
    differing.map((index) => [locale[index], codeUnit[index]]),
    [
      ['base_convert', 'base64_decode'],
      ['base64_decode', 'base64_encode'],
      ['base64_encode', 'base_convert'],
    ],
  );
});

test('every scope matches the matrix: total, read-only subset, sent count', () => {
  for (const scope of ['compact', 'standard', 'full'] as const) {
    const tools = selectScopedTools(registry(), scope);
    const expected = MATRIX[scope];
    assert.equal(tools.length, expected.all, `${scope}: selected count`);
    assert.equal(tools.filter(isReadOnlyTool).length, expected.readOnly, `${scope}: read-only subset`);

    const limited = limitProviderTools(tools);
    assert.equal(limited.tools.length, expected.sent, `${scope}: sent count after the cap`);
    assert.equal(limited.dropped.length, expected.all - expected.sent, `${scope}: dropped count`);
    // The cap exists for the provider hard limit; nothing may be sent above it.
    assert.ok(limited.tools.length <= MAX_PROVIDER_TOOLS);
  }
});

test('the sent array is in the canonical (byte) order for every scope', () => {
  // Every scope is sorted with the same comparator the registry and the ledger
  // use, including after the cap. The evidence is checked against a
  // comparator that is total (0 only for equal strings): a locale sort would
  // leave the base64 block in the other order, and on ties would be free to
  // follow insertion order.
  for (const scope of ['compact', 'standard', 'full'] as const) {
    const sent = limitProviderTools(selectScopedTools(registry(), scope)).tools.map((tool) => tool.name);
    assert.deepEqual(sent, [...sent].sort(compareToolNames), `${scope}: sent order`);
    for (let i = 1; i < sent.length; i++) {
      assert.ok(compareToolNames(sent[i - 1]!, sent[i]!) < 0, `${scope}: ${sent[i - 1]} and ${sent[i]} are not strictly ordered`);
    }
  }
});

test('scopes nest: compact ⊆ standard ⊆ full', () => {
  const compact = new Set(scopedNames('compact'));
  const standard = new Set(scopedNames('standard'));
  const full = new Set(scopedNames('full'));
  for (const name of compact) assert.ok(standard.has(name), `${name} is in compact but not standard`);
  for (const name of standard) assert.ok(full.has(name), `${name} is in standard but not full`);

  // selectScopedTools filters; it never re-sorts. Compact/standard therefore
  // arrive in exactly registry.list() order.
  const registryOrder = registry().list().map((tool) => tool.name);
  for (const scope of ['compact', 'standard'] as const) {
    const filtered = registryOrder.filter((name) => (scope === 'compact' ? compact : standard).has(name));
    assert.deepEqual(scopedNames(scope), filtered, `${scope} must preserve registry order`);
  }
  // full is the whole list, unchanged.
  assert.deepEqual(scopedNames('full'), registryOrder);
});

test('read-only means risk read minus every agent-spawning tool', () => {
  const byName = new Map(registry().list().map((tool) => [tool.name, tool]));
  // All four spawners are registered; only spawn_subagent is labelled read, so
  // it is the single name the subtraction actually removes.
  for (const name of AGENT_SPAWNING_TOOLS) assert.ok(byName.has(name), `${name} must be registered`);
  assert.equal(byName.get('spawn_subagent')?.risk, 'read');
  assert.equal(isReadOnlyTool(byName.get('spawn_subagent')!), false);
  for (const name of ['review_loop', 'workflow_execute', 'workflow_resume']) {
    assert.equal(isReadOnlyTool(byName.get(name)!), false, `${name} must never count as read-only`);
  }

  // Every genuinely read-only tool is reachable at standard: the default scope
  // has to be able to read anything the full scope can read.
  const standard = new Set(scopedNames('standard'));
  const unreachable = registry().list().filter((tool) => isReadOnlyTool(tool) && !standard.has(tool.name));
  assert.deepEqual(unreachable.map((tool) => tool.name), []);
});

test('compact exposes no spawner and no write; standard exposes exactly the delegation pair', () => {
  const compact = new Set(scopedNames('compact'));
  for (const name of AGENT_SPAWNING_TOOLS) assert.ok(!compact.has(name), `compact must not expose ${name}`);
  // compact's three non-read-only tools are network reads (fetch_url,
  // web_search, download_file), admitted deliberately so a "small" web-reading
  // request can still be carried out. No write and no shell may appear.
  const compactMutating = registry().list()
    .filter((tool) => compact.has(tool.name) && (tool.risk === 'write' || tool.risk === 'shell'))
    .map((tool) => tool.name);
  assert.deepEqual(compactMutating, []);

  const standard = new Set(scopedNames('standard'));
  const standardSpawners = [...AGENT_SPAWNING_TOOLS].filter((name) => standard.has(name)).sort();
  assert.deepEqual(standardSpawners, [...DELEGATION_TOOLS].sort());
});

test('the full-scope cap drops rank-3 built-ins, never a protected or working-core tool', () => {
  const tools = selectScopedTools(registry(), 'full');
  const limited = limitProviderTools(tools);
  assert.equal(limited.tools.length, MAX_PROVIDER_TOOLS);
  assert.equal(limited.dropped.length, 23);

  // Rank order (scope.ts:277-283): 0 protected, 1 mutating core, 2 read
  // allowlist + HIGH_VALUE_EXTRA, 3 other built-ins, 4 plugin_/mcp_. This
  // registry has no plugin_/mcp_ tools, so rank 4 is empty and the trim can
  // only ever reach rank 3 — every dropped name must be a plain built-in.
  for (const name of limited.dropped) {
    const tool = tools.find((candidate) => candidate.name === name)!;
    assert.ok(tool, `${name} must exist in the full scope`);
    assert.ok(!name.startsWith('plugin_') && !name.startsWith('mcp_'), `${name} is a bridge tool and must outrank rank 3`);
  }
  for (const essential of ['write_file', 'apply_patch', 'run_command', 'search_text', 'read_file', 'git_commit', 'typecheck', 'web_search']) {
    assert.ok(limited.tools.some((tool) => tool.name === essential), `${essential} must survive the cap`);
  }
  // The split used to be 19 read-only / 4 mutating: rank 3 lumped every
  // non-core built-in together, so the alphabetical tie-break decided who got
  // trimmed and read-only analysis tools lost to write tools purely by name.
  // Rank order is now 0 protected, 1 mutating core, 2 read allowlist +
  // HIGH_VALUE_EXTRA, 3 read-only built-ins, 4 other built-ins, 5
  // plugin_/mcp_ — so a cap that has to reach past the core drops the tools
  // that cannot change anything last of all. This registry has no bridge
  // tools, so all 23 dropped rows are built-ins and none is read-only.
  const droppedReadOnly = limited.dropped.filter((name) => isReadOnlyTool(tools.find((tool) => tool.name === name)!)).length;
  assert.equal(droppedReadOnly, 0, 'no read-only tool may be trimmed while a mutating one survives');
  assert.equal(limited.dropped.length - droppedReadOnly, 23);
});

test('a protected name is never trimmed even when it sorts late', () => {
  const tools = selectScopedTools(registry(), 'full');
  const late = { ...tools[0]!, name: 'zzz_injected_after_scope' };
  const limited = limitProviderTools([...tools, late], { protectedNames: new Set([late.name]) });
  assert.ok(limited.tools.some((tool) => tool.name === late.name));
  assert.equal(limited.tools.length, MAX_PROVIDER_TOOLS);
  assert.equal(limited.dropped.length, tools.length + 1 - MAX_PROVIDER_TOOLS);
});

test('an unknown scope fails closed to compact, the defect this file used to report', () => {
  // selectScopedTools used to have no runtime check on `scope`: anything not
  // 'full' took the allowlist branch, and anything not 'compact' got the union
  // (COMPACT_ALLOW + STANDARD_EXTRA_ALLOW) — the read-only, delegation and
  // HIGH_VALUE_EXTRA rules are gated on 'standard' exactly, so an unknown value
  // got the *pre-widening* standard set: 236 tools, writes included. That was
  // wider than compact, so it failed open. scope.ts now normalises every
  // entrance (normalizeToolScope) to compact and warns on stderr; this test
  // pins the safe half — an unknown value is exactly compact, never the union
  // and never the whole registry.
  //
  // NOTE (2026-10-29): this file was written by another agent, which asked not
  // to be edited. Two assertions below pinned the old fail-open behaviour (the
  // 236-tool union) as a recorded defect; they were changed here to the fixed
  // behaviour, with this note so the owner can see why. Full contract lives in
  // tests/tool-scope-normalize.test.ts; see
  // audit-notes/cli/tool-scope-failopen.md.
  const compact = scopedNames('compact');
  for (const bogus of ['readonly', 'bogus', 'FULL', '']) {
    const names = selectScopedTools(registry(), bogus as ResolvedToolScope).map((tool) => tool.name);
    assert.notEqual(names.length, REGISTRY_SIZE, `scope ${JSON.stringify(bogus)} must not pass through`);
    assert.deepEqual(names, compact, `scope ${JSON.stringify(bogus)} falls back to compact`);
  }
  // The asymmetry is gone: no write tool is reachable through an unknown scope.
  const unknown = new Set(selectScopedTools(registry(), 'readonly' as ResolvedToolScope).map((tool) => tool.name));
  assert.ok(!unknown.has('write_file'));
  assert.ok(!unknown.has('git_commit'));
  assert.ok(!unknown.has('run_tests'), 'unknown scope is not standard either');
});

test('post-scope injections push standard to 336 outbound, still under the cap', () => {
  // selectScopedTools counts 333 for standard, but the request carries three
  // tools it cannot see (agent.ts:777-791). The headroom the cap leaves must
  // cover them; this is the arithmetic that keeps 336 < 340.
  const standard = scopedNames('standard');
  const absent = POST_SCOPE_ONLY.filter((name) => !standard.includes(name));
  assert.deepEqual([...absent], [...POST_SCOPE_ONLY], 'these three are not pre-registered');
  assert.equal(standard.length + absent.length, 336);
  assert.ok(336 <= MAX_PROVIDER_TOOLS);
});

test('the ledger counts belong to an older tree, not to a scope this one produces', () => {
  // The context ledger (out/context-ledger/sess_20261026115924_c6ffef29.json)
  // recorded compact 238, standard 274, a dip to 260, then 340. Those are
  // reproducible — but from the tree of 2026-10-26, where standard was the
  // allowlist union (235) and computer_press had 14 tools, not from this one.
  // See audit-notes/cli/tool-scope-matrix.md §3.1. The point of this test is
  // that no *current* scope may claim them; the mapping lives in the report,
  // not in a silent reinterpretation of today's numbers.
  const reproducible = new Set([
    ...['compact', 'standard', 'full'].map((scope) => scopedNames(scope as ResolvedToolScope).length),
    ...Object.values(MATRIX).map((row) => row.sent),
  ]);
  assert.deepEqual([...reproducible].sort((a, b) => a - b), [200, 333, 340, 363]);
  for (const recorded of [238, 274, 260]) {
    assert.ok(!reproducible.has(recorded), `${recorded} must not be claimed as a current scope count`);
  }
});

test('desktop switches explain why live counts differ from the static matrix', () => {
  // Static selection + the post-scope tools that are not pre-registered is the
  // live surface. On this tree, with every desktop switch on:
  //   compact  200 + 39 = 239
  //   standard 333 + 37 = 370 -> capped to 340
  //   full     363 + 37 = 400 -> capped to 340
  // compact is missing the two delegation tools as well (they are not in
  // COMPACT_ALLOW), which is why its post-scope delta is 39 and not 37.
  // The same formula on the 2026-10-26 tree gives 238 / 274 (260 without
  // computer) / 340 — the ledger's numbers (report §3.1).
  const POST_SCOPE = [
    ...POST_SCOPE_ONLY,
    'spawn_subagent', 'review_loop',
    'background_browser_open', 'background_browser_navigate', 'background_browser_inspect',
    'background_browser_click', 'background_browser_fill', 'background_browser_key',
    'background_browser_download', 'background_browser_screenshot', 'background_browser_close',
    'background_app_open', 'background_app_windows', 'background_app_inspect',
    'background_app_click', 'background_app_fill', 'background_app_type',
    'background_app_key', 'background_app_screenshot', 'background_app_close',
    'background_native_window_screenshot',
    'computer_elements', 'computer_press', 'computer_screenshot', 'computer_window_shot',
    'computer_click', 'computer_drag', 'computer_type', 'computer_key', 'computer_scroll',
    'computer_list_windows', 'computer_activate', 'computer_open', 'computer_close',
    'computer_wait_window',
    'excel_automate',
  ];
  const delta = (scope: ResolvedToolScope) => {
    const present = new Set(scopedNames(scope));
    return POST_SCOPE.filter((name) => !present.has(name)).length;
  };
  assert.equal(delta('compact'), 39);
  assert.equal(delta('standard'), 37);
  assert.equal(delta('full'), 37);

  const live = (scope: ResolvedToolScope) => scopedNames(scope).length + delta(scope);
  assert.equal(live('compact'), 239);
  assert.equal(live('standard'), 370);
  assert.equal(live('full'), 400);

  // The cap is what makes a desktop-loaded standard and a full both land on 340.
  for (const scope of ['standard', 'full'] as const) {
    const scoped = selectScopedTools(registry(), scope);
    const base = scoped[0]!;
    const injected = [...Array(delta(scope))].map((_, index) => ({ ...base, name: `zz_injected_${String(index).padStart(2, '0')}` }));
    const limited = limitProviderTools([...scoped, ...injected], { protectedNames: new Set(injected.map((tool) => tool.name)) });
    assert.equal(limited.tools.length, MAX_PROVIDER_TOOLS);
    assert.ok(injected.every((tool) => limited.tools.some((kept) => kept.name === tool.name)), 'protected injections survive');
  }
});

test('an explicit request is validated, not passed through verbatim', () => {
  // resolveToolScope used to special-case only 'auto' and return everything
  // else as-is, so a hand-written config value (or a cast upstream) reached
  // selectScopedTools unchanged and took the fail-open union branch. It now
  // normalises unknown values to compact and warns. Changed by the
  // tool-scope-failopen fix; see the note on the unknown-scope test above.
  const requested = resolveToolScope({ requested: 'readonly' as never, prompt: 'x', shouldUseTaskBoard: false });
  assert.equal(requested, 'compact');
  for (const value of ['compact', 'standard', 'full'] as const) {
    assert.equal(resolveToolScope({ requested: value, prompt: 'x', shouldUseTaskBoard: false }), value);
  }
  // 'auto' is the only value that is interpreted rather than passed through.
  assert.equal(resolveToolScope({ requested: 'auto', prompt: '读一下 package.json', shouldUseTaskBoard: false }), 'compact');
  assert.equal(resolveToolScope({ requested: 'auto', prompt: 'x', shouldUseTaskBoard: false }), 'standard');
});
