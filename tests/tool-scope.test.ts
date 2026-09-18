import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { MAX_PROVIDER_TOOLS, limitProviderTools, resolveToolScope, selectScopedTools } from '../src/tools/scope.js';

function names(scope: 'compact' | 'standard' | 'full') {
  return selectScopedTools(createDefaultToolRegistry(), scope).map((tool) => tool.name);
}

test('resolveToolScope maps auto mode from task size and reasoning effort', () => {
  assert.equal(resolveToolScope({ requested: 'auto', prompt: '读取 package.json', shouldUseTaskBoard: false, reasoningEffort: 'off' }), 'compact');
  assert.equal(resolveToolScope({ requested: 'auto', prompt: '实现完整登录流程并补测试', shouldUseTaskBoard: true, reasoningEffort: 'low' }), 'full');
  assert.equal(resolveToolScope({ requested: 'auto', prompt: 'update config and adjust docs', shouldUseTaskBoard: false, reasoningEffort: 'medium' }), 'standard');
  assert.equal(resolveToolScope({ requested: 'auto', prompt: 'open file', shouldUseTaskBoard: false, reasoningEffort: 'high' }), 'full');
});

test('manual tool scope override wins over auto mapping', () => {
  assert.equal(resolveToolScope({ requested: 'compact', prompt: '实现完整登录流程并补测试', shouldUseTaskBoard: true, reasoningEffort: 'max' }), 'compact');
  assert.equal(resolveToolScope({ requested: 'full', prompt: '读取 package.json', shouldUseTaskBoard: false, reasoningEffort: 'off' }), 'full');
});

test('compact and standard scopes expose progressively larger registries', () => {
  const compact = names('compact');
  const standard = names('standard');
  const full = names('full');

  assert.ok(compact.length < standard.length);
  assert.ok(standard.length < full.length);

  assert.ok(compact.includes('read_file'));
  assert.ok(compact.includes('git_status'));
  assert.ok(compact.includes('git_diff'));
  assert.ok(!compact.includes('run_command'));
  assert.ok(!compact.includes('git_commit'));

  assert.ok(standard.includes('write_file'));
  assert.ok(standard.includes('apply_patch'));
  assert.ok(standard.includes('git_commit'));
  assert.ok(standard.includes('git_add'));
  assert.ok(standard.includes('run_command'));

  assert.ok(full.includes('run_command'));
  assert.ok(full.includes('git_commit'));
});

test('limitProviderTools passes a small list through untouched', () => {
  const tools = createDefaultToolRegistry().list().slice(0, 5);
  const result = limitProviderTools(tools, 10);
  assert.equal(result.tools.length, 5);
  assert.deepEqual(result.dropped, []);
});

test('limitProviderTools caps oversized lists below the provider ceiling', () => {
  const all = createDefaultToolRegistry().list();
  assert.ok(all.length > MAX_PROVIDER_TOOLS, 'registry must exceed the cap for this test to be meaningful');
  const result = limitProviderTools(all);
  assert.equal(result.tools.length, MAX_PROVIDER_TOOLS);
  assert.equal(result.dropped.length, all.length - MAX_PROVIDER_TOOLS);
  assert.ok(MAX_PROVIDER_TOOLS < 350, 'must stay under the common 350 provider limit');
});

test('limitProviderTools keeps the working core instead of cutting alphabetically', () => {
  const all = createDefaultToolRegistry().list();
  const result = limitProviderTools(all);
  const kept = new Set(result.tools.map((tool) => tool.name));
  // Alphabetical truncation would drop these (late letters); the agent cannot
  // work without them, so they must survive the cap.
  for (const essential of ['write_file', 'apply_patch', 'run_command', 'search_text', 'read_file', 'git_commit', 'typecheck', 'web_search']) {
    assert.ok(kept.has(essential), `expected ${essential} to survive the cap`);
  }
});

test('limitProviderTools omits bridge tools before built-ins', () => {
  // The default registry has no plugin_/mcp_ tools, so synthesize a registry
  // where the bridge block is what pushes the count over the ceiling.
  const base = createDefaultToolRegistry().list();
  const bridge = Array.from({ length: 40 }, (_, index) => ({
    ...base[0]!,
    name: `plugin_extra_${String(index).padStart(2, '0')}`,
  }));
  const result = limitProviderTools([...base, ...bridge], base.length + 5);
  assert.equal(result.tools.length, base.length + 5);
  const droppedBridge = result.dropped.filter((name) => name.startsWith('plugin_') || name.startsWith('mcp_'));
  assert.equal(droppedBridge.length, result.dropped.length, 'every omitted tool should be a bridge tool');
  assert.equal(droppedBridge.length, bridge.length - 5);
});
