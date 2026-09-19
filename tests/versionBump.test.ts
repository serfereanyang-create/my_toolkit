import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  formatVersion,
  decideBump,
  applyBump,
  planVersionBump,
  renderBumpReport,
} from '../src/prreview/versionBump.js';

test('parseVersion handles v-prefix and prerelease', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3, prerelease: 'beta.1' });
  assert.equal(parseVersion('1.x'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(formatVersion({ major: 2, minor: 0, patch: 1 }), '2.0.1');
});

test('decideBump maps commits to bump kind', () => {
  assert.equal(decideBump(['feat(api)!: 移除 v1']).bump, 'major');
  assert.equal(decideBump(['feat: 新按钮', 'fix: 修个样式']).bump, 'minor');
  assert.equal(decideBump(['fix: 崩溃', 'chore: 依赖']).bump, 'patch');
  assert.equal(decideBump(['随便写的提交', 'fix: 正常']).bump, 'patch');
  assert.equal(decideBump([]).bump, 'none');
});

test('applyBump resets lower components', () => {
  assert.equal(formatVersion(applyBump({ major: 1, minor: 4, patch: 2 }, 'major')), '2.0.0');
  assert.equal(formatVersion(applyBump({ major: 1, minor: 4, patch: 2 }, 'minor')), '1.5.0');
  assert.equal(formatVersion(applyBump({ major: 1, minor: 4, patch: 2 }, 'patch')), '1.4.3');
  assert.equal(formatVersion(applyBump({ major: 1, minor: 4, patch: 2, prerelease: 'rc.1' }, 'none')), '1.4.2');
});

test('planVersionBump produces suggestion and grouped changelog', () => {
  const d = planVersionBump('1.4.2', [
    'feat(auth): 扫码登录',
    'fix(cart)!: 修正数量溢出',
    'docs: 更新 README',
    'fix(cart): 空车提示',
  ]);
  assert.equal(d.bump, 'major');
  assert.equal(d.suggested, '2.0.0');
  assert.equal(d.counts.feat, 1);
  assert.equal(d.counts.fix, 2);
  const breaking = d.changelogDraft.find((s) => s.type.includes('BREAKING'));
  assert.ok(breaking);
  assert.ok(breaking.entries.some((e) => e.includes('修正数量溢出')));
  const featSection = d.changelogDraft.find((s) => s.type.includes('新功能'));
  assert.ok(featSection?.entries.some((e) => e.includes('扫码登录') && e.includes('**auth**')));
});

test('renderBumpReport shows current → suggested', () => {
  const d = planVersionBump('0.9.0', ['feat: 大功能']);
  const md = renderBumpReport(d);
  assert.match(md, /## 版本建议：0\.9\.0 → \*\*0\.10\.0\*\*/);
  assert.match(md, /bump: \*\*minor\*\*/);
  assert.match(md, /提交分布/);
});
