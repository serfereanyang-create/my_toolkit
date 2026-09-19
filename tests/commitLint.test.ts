import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintCommitMessage, lintHistory, parseHeader } from '../src/prreview/commitLint.js';

test('parseHeader extracts type scope breaking subject', () => {
  const ok = parseHeader('feat(auth): 支持扫码登录');
  assert.equal(ok.valid, true);
  assert.equal(ok.type, 'feat');
  assert.equal(ok.scope, 'auth');
  assert.equal(ok.subject, '支持扫码登录');
  const bang = parseHeader('fix(core)!: 修复竞态');
  assert.equal(bang.breakingFlag, true);
  assert.equal(parseHeader('随便写点什么').valid, false);
  assert.equal(parseHeader('Feat(x): 大写开头').valid, false, 'type 必须小写');
});

test('lintCommitMessage passes a well-formed header', () => {
  const r = lintCommitMessage('docs(readme): 更新安装步骤');
  assert.equal(r.ok, true);
  assert.equal(r.issues.filter((i) => i.level === 'error').length, 0);
});

test('lintCommitMessage flags format and unknown type', () => {
  const r1 = lintCommitMessage('add stuff');
  assert.equal(r1.ok, false);
  assert.ok(r1.issues.some((i) => i.rule === 'header-format'));
  const r2 = lintCommitMessage('feature(x): 新能力');
  assert.ok(r2.issues.some((i) => i.rule === 'type-unknown'));
});

test('lintCommitMessage warns scope style and length', () => {
  const r = lintCommitMessage('fix(UI_Kit): 按钮对齐');
  assert.ok(r.issues.some((i) => i.rule === 'scope-style'));
  const r2 = lintCommitMessage('fix: 太短');
  assert.ok(r2.issues.some((i) => i.rule === 'subject-too-short'));
  const r3 = lintCommitMessage('chore: 升级依赖。');
  assert.ok(r3.issues.some((i) => i.rule === 'no-trailing-period'));
});

test('lintCommitMessage checks BREAKING consistency', () => {
  const bangNoFooter = lintCommitMessage('feat(api)!: 移除 v1 端点');
  assert.ok(bangNoFooter.issues.some((i) => i.rule === 'breaking-missing'));
  const footerOk = lintCommitMessage('feat(api)!: 移除 v1 端点', 'BREAKING CHANGE: v1 端点下线');
  assert.equal(footerOk.issues.some((i) => i.rule === 'breaking-missing'), false);
  const footerOnly = lintCommitMessage('fix: 修复崩溃', 'BREAKING CHANGE: 行为改变');
  assert.ok(footerOnly.issues.some((i) => i.rule === 'breaking-flag'));
});

test('lintHistory aggregates error and warning counts', () => {
  const a = lintHistory(['feat: 正常功能', 'bad header', 'fix(x): 太短']);
  assert.equal(a.errorCount, 1, '仅 "bad header" 是 error');
  assert.equal(a.results[2]!.ok, true, '描述短是 warning 不算失败');
  assert.ok(a.warningCount >= 2);
});
