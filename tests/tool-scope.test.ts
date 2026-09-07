import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { resolveToolScope, selectScopedTools } from '../src/tools/scope.js';

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
