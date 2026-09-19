import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeProjectName, generateProject, resolveTargetInsideRoot } from '../src/scaffold/generate.js';

test('sanitizeProjectName normalizes unsafe names', () => {
  assert.equal(sanitizeProjectName('  My Cool Lib! '), 'my-cool-lib');
  assert.equal(sanitizeProjectName('中文项目'), 'my-project', '非 ASCII 全部替换成 -，全空时回退默认');
  assert.equal(sanitizeProjectName('a..b_c'), 'a..b_c');
});

test('resolveTargetInsideRoot rejects escape attempts', () => {
  const root = process.cwd();
  assert.ok(resolveTargetInsideRoot(root, 'sub/dir'));
  assert.ok(resolveTargetInsideRoot(root, '.'));
  assert.equal(resolveTargetInsideRoot(root, '../outside'), null);
});

test('generateProject creates files, skips existing, rejects escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scaffold-'));
  try {
    const first = await generateProject({
      workspaceRoot: root,
      targetDir: 'demo',
      presetId: 'node-lib',
      projectName: 'Demo Lib',
    });
    assert.equal(first.ok, true);
    assert.ok(first.created.includes('package.json'));
    assert.ok(first.created.includes('src/index.ts'));

    const pkg = JSON.parse(await readFile(join(root, 'demo', 'package.json'), 'utf-8'));
    assert.equal(pkg.name, 'demo-lib');

    // 第二次生成：全部跳过，绝不覆盖
    const second = await generateProject({
      workspaceRoot: root,
      targetDir: 'demo',
      presetId: 'node-lib',
      projectName: 'Demo Lib',
    });
    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, first.created.length);
    const pkgAfter = await readFile(join(root, 'demo', 'package.json'), 'utf-8');
    assert.equal(JSON.parse(pkgAfter).name, 'demo-lib', '内容未被改写');

    // 越界目标被拒绝
    const escaped = await generateProject({
      workspaceRoot: root,
      targetDir: '..',
      presetId: 'node-lib',
      projectName: 'x',
    });
    assert.equal(escaped.ok, false);
    assert.match(escaped.errors[0]!, /越出工作区/);

    // 未知模板被拒绝
    const unknown = await generateProject({
      workspaceRoot: root,
      targetDir: 'y',
      presetId: 'nope',
      projectName: 'x',
    });
    assert.equal(unknown.ok, false);
    assert.match(unknown.errors[0]!, /未知模板/);

    // 静态站点模板生成 index.html
    const site = await generateProject({
      workspaceRoot: root,
      targetDir: 'site',
      presetId: 'static-site',
      projectName: 'site',
    });
    assert.equal(site.ok, true);
    const html = await readFile(join(root, 'site', 'index.html'), 'utf-8');
    assert.ok(html.includes('<title>site</title>'));
    const cssStat = await stat(join(root, 'site', 'style.css'));
    assert.ok(cssStat.isFile());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
