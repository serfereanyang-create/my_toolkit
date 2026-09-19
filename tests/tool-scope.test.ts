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
  const result = limitProviderTools(tools, { max: 10 });
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
  const result = limitProviderTools([...base, ...bridge], { max: base.length + 5 });
  assert.equal(result.tools.length, base.length + 5);
  const droppedBridge = result.dropped.filter((name) => name.startsWith('plugin_') || name.startsWith('mcp_'));
  assert.equal(droppedBridge.length, result.dropped.length, 'every omitted tool should be a bridge tool');
  assert.equal(droppedBridge.length, bridge.length - 5);
});

test('limitProviderTools never trims a protected tool', () => {
  // spawn_subagent / review_loop / computer tools are registered AFTER scope
  // selection; the cap runs last and must keep them even when they sort late.
  const base = createDefaultToolRegistry().list();
  const injected = [
    { ...base[0]!, name: 'zzz_spawn_subagent' },
    { ...base[0]!, name: 'zzz_review_loop' },
  ];
  const result = limitProviderTools([...base, ...injected], {
    max: 20,
    protectedNames: new Set(['zzz_spawn_subagent', 'zzz_review_loop']),
  });
  const kept = new Set(result.tools.map((tool) => tool.name));
  assert.ok(kept.has('zzz_spawn_subagent'), 'protected tool must survive');
  assert.ok(kept.has('zzz_review_loop'), 'protected tool must survive');
  assert.equal(result.tools.length, 20);
});

test('capping after injection keeps the serialized count under the ceiling', () => {
  // Regression: the cap used to run BEFORE the post-scope injections, so those
  // tools pushed the outbound array back over the provider limit and every turn
  // 400'd. Simulate the real order: scope -> inject -> cap.
  const base = createDefaultToolRegistry().list();
  const injected = ['spawn_subagent', 'review_loop', 'computer_screenshot', 'computer_click']
    .map((name) => ({ ...base[0]!, name }));
  const protectedNames = new Set(injected.map((tool) => tool.name));
  const result = limitProviderTools([...base, ...injected], { protectedNames });
  assert.ok(result.tools.length <= MAX_PROVIDER_TOOLS, `serialized ${result.tools.length} exceeds cap`);
  assert.ok(MAX_PROVIDER_TOOLS < 350);
  const kept = new Set(result.tools.map((tool) => tool.name));
  for (const name of protectedNames) assert.ok(kept.has(name), `${name} must survive`);
});
