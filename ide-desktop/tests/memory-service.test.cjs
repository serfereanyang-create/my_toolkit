'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  listProjectMemories,
  readProjectMemoryFile,
  resolveWorkspaceLabel,
  isProjectMemoryFileName,
} = require('../electron/memory-service.cjs');

async function makeMemoriesRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-'));
  const projectA = path.join(root, 'my-project-0123456789abcdef');
  await fs.mkdir(path.join(projectA, 'memory'), { recursive: true });
  await fs.writeFile(path.join(projectA, 'MEMORY.md'), '# Project A index\n');
  await fs.writeFile(path.join(projectA, 'memory', 'user-prefs.md'), 'likes dark theme\n');
  await fs.writeFile(path.join(projectA, 'memory', 'notes.txt'), 'not markdown, skipped\n');

  const projectB = path.join(root, 'solo');
  await fs.mkdir(projectB, { recursive: true });
  await fs.writeFile(path.join(projectB, 'MEMORY.md'), '# Solo\n');
  return root;
}

test('listProjectMemories enumerates index+item files with labels', async () => {
  const root = await makeMemoriesRoot();
  try {
    const summaries = await listProjectMemories(root);
    assert.equal(summaries.length, 2);
    const a = summaries.find((s) => s.id === 'my-project-0123456789abcdef');
    assert.equal(a.label, 'my-project', 'hash suffix stripped for the label');
    assert.deepEqual(a.files.map((f) => f.kind), ['index', 'item'], 'index first, txt skipped');
    assert.ok(a.files.every((f) => f.size > 0 && f.updatedAt > 0));
    const b = summaries.find((s) => s.id === 'solo');
    assert.equal(b.label, 'solo', 'no suffix means the id is the label');
    assert.deepEqual(b.files.map((f) => f.kind), ['index']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('missing roots and empty projects come back empty rather than throwing', async () => {
  assert.deepEqual(await listProjectMemories(path.join(os.tmpdir(), 'no-such-memory-root-xyz')), []);
  const root = await makeMemoriesRoot();
  try {
    await fs.mkdir(path.join(root, 'bare-1111111111111111'), { recursive: true });
    const summaries = await listProjectMemories(root);
    assert.ok(!summaries.some((s) => s.id === 'bare-1111111111111111'), 'no files → not listed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('readProjectMemoryFile reads index and items, rejects traversal', async () => {
  const root = await makeMemoriesRoot();
  const workspaceId = 'my-project-0123456789abcdef';
  try {
    const index = await readProjectMemoryFile({ memoriesRoot: root, workspaceId, fileName: 'MEMORY.md' });
    assert.ok(index.content.startsWith('# Project A index'));
    assert.ok(index.updatedAt > 0);
    const item = await readProjectMemoryFile({ memoriesRoot: root, workspaceId, fileName: 'user-prefs.md' });
    assert.equal(item.content, 'likes dark theme\n');

    await assert.rejects(
      () => readProjectMemoryFile({ memoriesRoot: root, workspaceId, fileName: '..\\MEMORY.md' }),
      /Invalid memory file name/,
    );
    await assert.rejects(
      () => readProjectMemoryFile({ memoriesRoot: root, workspaceId, fileName: '../solo/MEMORY.md' }),
      /Invalid memory file name/,
    );
    await assert.rejects(
      () => readProjectMemoryFile({ memoriesRoot: root, workspaceId, fileName: 'notes.txt' }),
      /Invalid memory file name/,
    );
    await assert.rejects(
      () => readProjectMemoryFile({ memoriesRoot: root, workspaceId: '../other', fileName: 'MEMORY.md' }),
      /Invalid workspace id/,
    );
    await assert.rejects(
      () => readProjectMemoryFile({ memoriesRoot: root, workspaceId, fileName: 'nonexistent.md' }),
      /ENOENT|not found|Invalid/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('naming helpers follow the upstream conventions', () => {
  assert.equal(isProjectMemoryFileName('MEMORY.md'), true);
  assert.equal(isProjectMemoryFileName('MEMORY.md'), true);
  assert.equal(isProjectMemoryFileName('a.md'), true);
  assert.equal(isProjectMemoryFileName('a.txt'), false);
  assert.equal(resolveWorkspaceLabel('zcodeproject-b2c88be133bfd876'), 'zcodeproject');
  assert.equal(resolveWorkspaceLabel('plain'), 'plain');
});
