'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, rm, writeFile } = require('node:fs/promises');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createWorkspaceFileWatcher, isIgnored } = require('../electron/file-watcher.cjs');

test('isIgnored filters ignored dirs and root dotfiles but not nested dotfiles', () => {
  const root = 'C:\\w';
  assert.equal(isIgnored(root, 'C:\\w\\node_modules\\x\\y.js'), true);
  assert.equal(isIgnored(root, 'C:\\w\\.aicode\\paste\\a.png'), true);
  assert.equal(isIgnored(root, 'C:\\w\\.secret'), true);
  assert.equal(isIgnored(root, 'C:\\w\\src\\config.json'), false);
  assert.equal(isIgnored(root, 'C:\\w\\src\\deep'), false);
});

test('coalesces bursts into one batch with relative paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-'));
  const watcher = createWorkspaceFileWatcher({ rootPath: root, debounceMs: 250 });
  const batches = [];
  try {
    await watcher.start();
    watcher.onBatch((batch) => batches.push(batch));

    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), '1');
    await writeFile(join(root, 'src', 'b.ts'), '2');
    await writeFile(join(root, 'src', 'c.ts'), '3');

    // Wait past the debounce quiet period plus chokidar settle time.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(batches.length, 1, `bursts coalesce, saw ${batches.length} batches`);
    const rels = batches[0].changed.map((c) => c.relativePath).sort();
    assert.ok(rels.includes('src/a.ts'), 'a.ts in batch');
    assert.ok(rels.includes('src/c.ts'), 'c.ts in batch');
    assert.ok(batches[0].changed.every((c) => ['added', 'modified', 'deleted'].includes(c.kind)));
  } finally {
    await watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('ignored directories never emit events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watch-ig-'));
  const watcher = createWorkspaceFileWatcher({ rootPath: root, debounceMs: 200 });
  const batches = [];
  try {
    await watcher.start();
    watcher.onBatch((batch) => batches.push(batch));

    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(join(root, 'real.ts'), 'x');

    await new Promise((r) => setTimeout(r, 2500));
    const all = batches.flatMap((b) => b.changed.map((c) => c.relativePath));
    assert.ok(all.includes('real.ts'), 'workspace file reported');
    assert.ok(!all.some((r) => r.startsWith('node_modules')), 'node_modules filtered');
  } finally {
    await watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});
