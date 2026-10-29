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

import { symlink, mkdir } from 'node:fs/promises';
import { writeDocFile } from '../src/docs/tools.js';

test('sanitizeProjectName never yields a dot path segment', () => {
  // Probe: projectName '.' produced `"name": "."`, and with targetDir '.' the
  // scaffold landed directly on the workspace root.
  assert.equal(sanitizeProjectName('.'), 'my-project');
  assert.equal(sanitizeProjectName('..'), 'my-project');
  assert.equal(sanitizeProjectName('  ...  '), 'my-project');
  assert.equal(sanitizeProjectName('a.b'), 'a.b');
});

test('resolveTargetInsideRoot is not case-sensitive on Windows paths', () => {
  if (process.platform !== 'win32') return;
  const root = process.cwd();
  // `startsWith` compared case-sensitively, so an upper-cased root looked
  // "outside" — and the reverse accepted look-alikes.
  assert.ok(resolveTargetInsideRoot(root.toUpperCase(), 'sub/dir'));
  assert.equal(resolveTargetInsideRoot(root, '../outside'), null);
});

test('generateProject refuses to follow a junction out of the workspace', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('junction escape is a Windows path feature');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'scaffold-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'scaffold-outside-'));
  try {
    await mkdir(join(root, 'demo'), { recursive: true });
    await symlink(outside, join(root, 'demo', 'src'), 'junction');
    const result = await generateProject({ workspaceRoot: root, targetDir: 'demo', presetId: 'node-lib', projectName: 'x' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /符号链接/.test(error)), JSON.stringify(result.errors));
    await assert.rejects(() => readFile(join(outside, 'index.ts'), 'utf-8'));
    // Files that do not pass through the link are still generated.
    assert.ok(result.created.includes('package.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('writeDocFile keeps generated documents inside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docs-write-'));
  try {
    const inside = await writeDocFile(root, 'docs/API.md', '# api\n');
    assert.equal(inside, join(root, 'docs', 'API.md'));
    assert.equal(await readFile(inside, 'utf-8'), '# api\n');
    // Probe before the fix: auto mode wrote ../../pwn-escape.md with no prompt,
    // because outputFile is not a field the approval layer treats as a target.
    await assert.rejects(() => writeDocFile(root, '../../pwn-escape.md', 'x'), /拒绝写入工作区之外/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
