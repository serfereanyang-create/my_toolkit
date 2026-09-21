import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveReadablePath, resolveWorkspacePath } from '../src/safety/policy.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { extractDocxText } from '../src/tools/files.js';

test('resolveReadablePath accepts desktop alias and absolute Desktop path', () => {
  const workspace = process.cwd();
  const desktopFile = join(homedir(), 'Desktop', '测试.docx');
  assert.equal(resolveReadablePath(workspace, 'desktop/测试.docx'), desktopFile);
  assert.equal(resolveReadablePath(workspace, desktopFile), desktopFile);
  assert.throws(() => resolveWorkspacePath(workspace, desktopFile), /Path escapes workspace/);
});

test('resolveReadablePath rejects unrelated absolute paths', () => {
  assert.throws(
    () => resolveReadablePath(process.cwd(), 'C:\\Windows\\System32\\drivers\\etc\\hosts'),
    /not allowed for read/i,
  );
});

/*
 * The same file used to have two verdicts depending on how it was written:
 * a workspace-relative path went through resolveWorkspacePath (workspace only)
 * while an absolute path went through the read allowlist (workspace, Desktop,
 * Documents, Downloads, home). So `../cli/package.json` was refused while
 * `C:/.../cli/package.json` was allowed — both naming one file. Which form the
 * model happened to emit decided whether the read worked, which reads as an
 * unreliable tool rather than a rule.
 */
test('a path resolves the same however it is spelled', async () => {
  // A real sibling inside an allowed root: the workspace sits under the home
  // directory, so a climb out of the workspace but still under home is readable
  // — and must read the same written either way.
  const home = homedir();
  const dir = await mkdtemp(join(home, 'aicode-spell-'));
  const inner = join(dir, 'inner');
  const outer = join(dir, 'outer');
  await mkdir(inner, { recursive: true });
  await mkdir(outer, { recursive: true });
  await writeFile(join(outer, 'note.txt'), 'sibling-ok\n', 'utf8');
  try {
    const viaRelative = resolveReadablePath(inner, '../outer/note.txt');
    const viaAbsolute = resolveReadablePath(inner, join(outer, 'note.txt'));
    assert.equal(viaRelative, viaAbsolute);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a relative climb that leaves every allowed root is still refused', () => {
  // Same rule, both spellings: the verdict follows where the path LANDS.
  assert.throws(
    () => resolveReadablePath(process.cwd(), '../../../../../../Windows/win.ini'),
    /Path escapes workspace|not allowed for read/i,
  );
});

test('read_file reads desktop docx text via create_docx fixture', async () => {
  const registry = createDefaultToolRegistry();
  const name = `aicode-read-docx-${Date.now()}.docx`;
  const created = await registry.execute(
    'create_docx',
    { path: `desktop/${name}`, title: '标题', body: '正文内容-可读检测' },
    { workspaceRoot: process.cwd(), approval: 'auto' },
  );
  assert.equal(created.ok, true);

  try {
    const byAlias = await registry.execute(
      'read_file',
      { path: `desktop/${name}`, maxBytes: 50000 },
      { workspaceRoot: process.cwd(), approval: 'auto' },
    );
    assert.equal(byAlias.ok, true);
    assert.match(byAlias.output, /标题|正文内容-可读检测/);

    const absolute = join(homedir(), 'Desktop', name);
    const byAbs = await registry.execute(
      'read_file',
      { path: absolute, maxBytes: 50000 },
      { workspaceRoot: process.cwd(), approval: 'auto' },
    );
    assert.equal(byAbs.ok, true);
    assert.match(byAbs.output, /正文内容-可读检测/);

    const text = await extractDocxText(absolute);
    assert.match(text, /正文内容-可读检测/);
  } finally {
    await rm(join(homedir(), 'Desktop', name), { force: true });
  }
});

test('read_file still reads workspace text files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-read-ws-'));
  await writeFile(join(root, 'note.txt'), 'workspace-ok\n', 'utf8');
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'read_file',
    { path: 'note.txt' },
    { workspaceRoot: root, approval: 'auto' },
  );
  assert.equal(result.ok, true);
  assert.match(result.output, /workspace-ok/);
  await rm(root, { recursive: true, force: true });
});
