import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeTaskComplexity, classifyTaskComplexity } from '../src/tasks/complexity.js';
import { autoReasoningEffort } from '../src/providers/capabilities.js';
import { resolveToolScope } from '../src/tools/scope.js';

test('shared classifier maps small, standard, and large prompts consistently', () => {
  assert.equal(classifyTaskComplexity('读取 package.json'), 'small');
  assert.equal(classifyTaskComplexity('修复 login handler'), 'standard');
  assert.equal(classifyTaskComplexity('实现完整登录流程并补测试'), 'large');

  assert.equal(autoReasoningEffort('读取 package.json'), 'low');
  assert.equal(autoReasoningEffort('修复 login handler'), 'medium');
  assert.equal(autoReasoningEffort('实现完整登录流程并补测试'), 'high');

  assert.equal(resolveToolScope({ requested: 'auto', prompt: '读取 package.json', reasoningEffort: 'off', shouldUseTaskBoard: false }), 'compact');
  assert.equal(resolveToolScope({ requested: 'auto', prompt: '修复 login handler', reasoningEffort: 'off', shouldUseTaskBoard: false }), 'standard');
  assert.equal(resolveToolScope({ requested: 'auto', prompt: '实现完整登录流程并补测试', reasoningEffort: 'off', shouldUseTaskBoard: false }), 'full');
});

test('classifier handles attachments, CJK-adjacent paths, and real multi-step work', () => {
  assert.equal(classifyTaskComplexity('总结这个文件\n[attachments]\n- code file app.ts'), 'small');
  assert.equal(classifyTaskComplexity({ prompt: '分析这些文件', attachments: 3 }), 'large');
  assert.equal(classifyTaskComplexity('搜索disk.ts中的quota'), 'small');
  assert.equal(classifyTaskComplexity('读取 config.ts 并写入修复后的内容'), 'standard');
  assert.equal(classifyTaskComplexity('1. inspect code 2. implement fix 3. run tests'), 'large');
  assert.equal(classifyTaskComplexity('/plan'), 'large');

  const analysis = analyzeTaskComplexity('读取 config.ts 并写入修复后的内容');
  assert.equal(analysis.hasReadIntent, true);
  assert.equal(analysis.hasWriteIntent, true);
  assert.equal(analysis.complexity, 'standard');
});

test('classifier uses English word boundaries and avoids complexity/deepseek false positives', () => {
  assert.equal(classifyTaskComplexity('search README.md for complexity'), 'small');
  assert.equal(classifyTaskComplexity('explain the complexity of this function'), 'small');
  assert.equal(classifyTaskComplexity('inspect deepseek-chat configuration'), 'small');
  assert.equal(classifyTaskComplexity('search updateFile in the README'), 'small');
  assert.equal(classifyTaskComplexity('implement a deepseek integration'), 'standard');
});
