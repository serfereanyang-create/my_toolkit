import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import {
  MAX_PROVIDER_TOOLS,
  isReadOnlyTool,
  limitProviderTools,
  selectScopedTools,
} from '../src/tools/scope.js';
import { compareToolNames } from '../src/session/modelTrajectory.js';
import type { ToolDefinition, ToolResult } from '../src/tools/types.js';

/*
 * The cap used to rank every built-in that was not in an allowlist as one
 * bucket, then cut that bucket alphabetically. With the desktop switches on,
 * `full` reaches 399 tools and the trim dropped 59 — 49 of them read-only
 * analysis tools, chosen by letter rather than by what the session loses.
 *
 * These tests pin the property the ranking now guarantees: a read-only tool is
 * cut only after every non-read-only built-in is gone, and the output stays a
 * plain alphabetical list.
 */

function tool(name: string, risk: ToolDefinition['risk'] = 'read'): ToolDefinition {
  return {
    name,
    description: `${name} (synthetic for cap ranking tests)`,
    inputHint: 'no input',
    risk,
    validate: (input) => input,
    async execute(): Promise<ToolResult> {
      return { ok: true, output: '' };
    },
  };
}

function syntheticPair(readCount: number, writeCount: number): ToolDefinition[] {
  // Names chosen so the tool that *should* survive sorts late: every read-only
  // name is past every write name alphabetically. Plain alphabetical truncation
  // would have dropped exactly the read-only half.
  const reads = Array.from({ length: readCount }, (_, i) => tool(`zz_read_${String(i).padStart(2, '0')}`));
  const writes = Array.from({ length: writeCount }, (_, i) => tool(`aa_write_${String(i).padStart(2, '0')}`, 'write'));
  return [...reads, ...writes];
}

test('cap never drops a read-only tool while write tools are still available to cut', () => {
  const tools = syntheticPair(60, 60);
  const result = limitProviderTools(tools, { max: 80 });
  assert.equal(result.tools.length, 80);
  assert.equal(result.dropped.length, 40);

  const dropped = new Set(result.dropped);
  const kept = new Set(result.tools.map((t) => t.name));
  for (const t of tools) {
    if (isReadOnlyTool(t)) {
      assert.ok(kept.has(t.name), `read-only ${t.name} was dropped while write tools remained`);
      assert.ok(!dropped.has(t.name), `read-only ${t.name} must not be dropped`);
    }
  }
  assert.equal(result.dropped.filter((name) => !name.startsWith('aa_write_')).length, 0, 'only write tools should be cut');
});

test('read-only tools are cut only after every non-read-only tool is gone', () => {
  const tools = syntheticPair(60, 20);
  const result = limitProviderTools(tools, { max: 50 });
  // 80 tools, cap 50: all 20 writes go first, then 30 read-only.
  const droppedWrites = result.dropped.filter((name) => name.startsWith('aa_write_'));
  const droppedReads = result.dropped.filter((name) => name.startsWith('zz_read_'));
  assert.equal(droppedWrites.length, 20);
  assert.equal(droppedReads.length, 10);
});

test('capped output is still plain alphabetical', () => {
  const tools = syntheticPair(60, 60);
  const names = limitProviderTools(tools, { max: 80 }).tools.map((t) => t.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('plugin_/mcp_ bridge tools are still cut before any built-in', () => {
  const base = syntheticPair(40, 40);
  const bridge = ['plugin_alpha', 'mcp_alpha', 'plugin_zeta', 'mcp_zeta'].map((name) => tool(name, 'read'));
  const result = limitProviderTools([...base, ...bridge], { max: 80 });
  assert.deepEqual(result.dropped, bridge.map((t) => t.name).sort((a, b) => a.localeCompare(b)));
});

test('protected tools survive even when they sort last', () => {
  const base = syntheticPair(40, 40);
  const injected = [tool('zzz_spawn_subagent'), tool('zzz_review_loop')];
  const protectedNames = new Set(injected.map((t) => t.name));
  const result = limitProviderTools([...base, ...injected], { max: 50, protectedNames });
  const kept = new Set(result.tools.map((t) => t.name));
  assert.ok(kept.has('zzz_spawn_subagent'));
  assert.ok(kept.has('zzz_review_loop'));
  assert.equal(result.tools.length, 50);
});

test('a list at or under the cap keeps the caller’s array when it is already canonical', () => {
  // The no-copy path is kept on purpose, but only for an array that is already
  // in canonical order — that is what every live caller passes (registry.list()
  // or ToolRegistry.fromTools). An unsorted array under the cap is copied and
  // sorted instead: returning it verbatim made the serialised payload depend on
  // insertion order (2026-10-29 tool-surface audit; see
  // tests/tool-surface-determinism.test.ts).
  const tools = [...syntheticPair(3, 2)].sort((a, b) => compareToolNames(a.name, b.name));
  const result = limitProviderTools(tools, { max: 10 });
  assert.equal(result.tools, tools, 'must return the caller’s array, not a copy');
  assert.deepEqual(result.dropped, []);

  const unsorted = syntheticPair(3, 2);
  const sorted = limitProviderTools(unsorted, { max: 10 });
  assert.notEqual(sorted.tools, unsorted, 'an unsorted under-cap list is copied');
  assert.deepEqual(sorted.tools.map((t) => t.name), [...sorted.tools.map((t) => t.name)].sort(compareToolNames));
  assert.deepEqual(sorted.dropped, []);
});

test('real registry over the cap: every cut is a writable tool', () => {
  // `full` on this registry is already over MAX_PROVIDER_TOOLS, so the cap
  // applies with no injections at all. Measured: 363 tools, 23 dropped, and
  // with the read-only split all 23 are write/shell/network tools. Under the
  // previous alphabetical ranking 19 of the 23 were read-only analysis tools.
  const all = selectScopedTools(createDefaultToolRegistry(), 'full');
  const result = limitProviderTools(all);
  assert.equal(result.tools.length, MAX_PROVIDER_TOOLS);
  if (result.dropped.length === 0) return; // registry shrunk below the cap; the other tests still cover the rule
  const droppedReadOnly = result.dropped.filter((name) => isReadOnlyTool(all.find((t) => t.name === name)!));
  assert.equal(droppedReadOnly.length, 0, `read-only tools dropped at real scale: ${droppedReadOnly.join(', ')}`);
});

test('real registry plus desktop injections: read-only cuts only after writable ones run out', () => {
  // Mirrors the agent.ts chain (scope -> post-scope injections -> cap). The
  // injected tools are the computer/background block, whose risks are the real
  // ones (screenshots/inspection are read, input actions are shell).
  const base = selectScopedTools(createDefaultToolRegistry(), 'full');
  const injected = [
    tool('computer_screenshot', 'read'),
    tool('computer_list_windows', 'read'),
    tool('computer_click', 'shell'),
    tool('computer_type', 'shell'),
    tool('computer_key', 'shell'),
    ...Array.from({ length: 40 }, (_, i) => tool(`zz_extra_write_${String(i).padStart(2, '0')}`, 'write')),
  ];
  const all = [...base, ...injected];
  // Only the computer/background block is protected, as in agent.ts; the
  // synthetic writes stand in for the rest of the writable built-ins.
  const result = limitProviderTools(all, {
    protectedNames: new Set(injected.filter((t) => t.name.startsWith('computer_')).map((t) => t.name)),
  });
  assert.ok(result.dropped.length > 0, 'the real registry plus injections must exceed the cap');

  const nonReadOnly = all.filter((t) => !isReadOnlyTool(t) && !t.name.startsWith('plugin_') && !t.name.startsWith('mcp_'));
  const droppedReadOnly = result.dropped.filter((name) => isReadOnlyTool(all.find((t) => t.name === name)!)).length;
  const spillover = Math.max(0, result.dropped.length - nonReadOnly.length);
  assert.equal(droppedReadOnly, spillover, 'read-only cuts must equal the spillover after every writable tool is spent');
});
