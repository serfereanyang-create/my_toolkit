import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChecklistFromDiff, renderChecklist } from '../src/prreview/reviewChecklist.js';

const SECURITY_DIFF = [
  'diff --' + 'git a/src/auth/login.ts b/src/auth/login.ts',
  '@@ -1,2 +1,4 @@',
  ' import { hash } from "./crypto";',
  '+export async function login(req) {',
  '+  const api_key = process.env.API_KEY;',
  '+  return req.body;',
  '+}',
].join('\n');

const TESTS_DIFF = [
  'diff --' + 'git a/src/util/date.ts b/src/util/date.ts',
  '@@ -1,2 +1,2 @@',
  '-export const fmt = (d) => d.toISOString();',
  '+export const fmt = (d: Date) => d.toISOString().slice(0, 10);',
  'diff --' + 'git a/tests/date.test.ts b/tests/date.test.ts',
  'new file mode 100644',
  '@@ -0,0 +1,2 @@',
  "+import { fmt } from '../src/util/date';",
  '+// test placeholder',
].join('\n');

test('buildChecklist flags security surfaces and hardcoded key style', () => {
  const result = buildChecklistFromDiff(SECURITY_DIFF);
  const p0 = result.items.filter((i) => i.priority === 'P0');
  assert.ok(p0.some((i) => i.area === '安全'));
  assert.ok(p0.some((i) => i.item.includes('硬编码')), 'api_key 赋值应触发凭据检查项');
  assert.ok(result.riskScore >= 30);
});

test('buildChecklist skips missing-test item when tests included', () => {
  const withTests = buildChecklistFromDiff(TESTS_DIFF);
  assert.equal(withTests.items.some((i) => i.area === '测试' && i.item.includes('未包含测试')), false);
  const onlySrc = buildChecklistFromDiff(TESTS_DIFF.split('diff --' + 'git a/tests')[0]!);
  assert.ok(onlySrc.items.some((i) => i.area === '测试'));
});

test('renderChecklist outputs checkable markdown', () => {
  const result = buildChecklistFromDiff(SECURITY_DIFF);
  const md = renderChecklist(result);
  assert.match(md, /^## 评审清单（风险 \d+\/100/);
  assert.ok(md.includes('- [ ]'));
  assert.ok(md.includes('P0 · 安全'));
});
