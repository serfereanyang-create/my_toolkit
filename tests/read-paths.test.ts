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
