import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CheckpointStore } from '../src/session/checkpoint.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { applyUnifiedDiffTool } from '../src/workspace/unifiedPatchTool.js';

test('checkpoints undo the last write_file change', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-checkpoint-'));
  const checkpoints = new CheckpointStore(workspace);
  const registry = createDefaultToolRegistry();
  const target = join(workspace, '.smoke', 'undo.txt');
  await writeFile(target, 'before', { flag: 'w' }).catch(async () => {
    await registry.execute('write_file', { path: '.smoke/undo.txt', content: 'before' }, { workspaceRoot: workspace, approval: 'auto' });
  });

  const result = await registry.execute('write_file', { path: '.smoke/undo.txt', content: 'after' }, { workspaceRoot: workspace, approval: 'auto', checkpoints });
  assert.equal(result.ok, true);
  assert.equal(await readFile(target, 'utf8'), 'after');

  assert.match(await checkpoints.undoLast(), /Undid checkpoint/);
  assert.equal(await readFile(target, 'utf8'), 'before');

  await rm(workspace, { recursive: true, force: true });
});

test('write_file returns a checkpointId in its data', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cpid-'));
  const checkpoints = new CheckpointStore(workspace);
  const registry = createDefaultToolRegistry();
  const result = await registry.execute('write_file', { path: '.smoke/a.txt', content: 'hi' }, { workspaceRoot: workspace, approval: 'auto', checkpoints });
  assert.equal(result.ok, true);
  const data = result.data as { checkpointId?: string };
  assert.match(String(data.checkpointId), /^cp_/);
  await rm(workspace, { recursive: true, force: true });
});

test('undoByIds reverts a whole turn of writes newest-first', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-undo-turn-'));
  const checkpoints = new CheckpointStore(workspace);
  const registry = createDefaultToolRegistry();
  const ctx = { workspaceRoot: workspace, approval: 'auto' as const, checkpoints };

  // Turn writes two new files, then overwrites the first one.
  const r1 = await registry.execute('write_file', { path: '.smoke/one.txt', content: 'one-v1' }, ctx);
  const r2 = await registry.execute('write_file', { path: '.smoke/two.txt', content: 'two' }, ctx);
  const r3 = await registry.execute('write_file', { path: '.smoke/one.txt', content: 'one-v2' }, ctx);
  const ids = [r1, r2, r3].map((r) => (r.data as { checkpointId: string }).checkpointId);

  assert.equal(await readFile(join(workspace, '.smoke', 'one.txt'), 'utf8'), 'one-v2');

  const outcome = await checkpoints.undoByIds(ids);
  assert.equal(outcome.reverted, 3);
  // Both files should be gone: they did not exist before the turn.
  await assert.rejects(readFile(join(workspace, '.smoke', 'one.txt'), 'utf8'));
  await assert.rejects(readFile(join(workspace, '.smoke', 'two.txt'), 'utf8'));
  // Index is now empty.
  assert.equal((await checkpoints.list()).length, 0);

  await rm(workspace, { recursive: true, force: true });
});

test('undoByIds restores prior content for pre-existing files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-undo-restore-'));
  const checkpoints = new CheckpointStore(workspace);
  const registry = createDefaultToolRegistry();
  const ctx = { workspaceRoot: workspace, approval: 'auto' as const, checkpoints };

  // Seed a file, then let a turn overwrite it.
  await registry.execute('write_file', { path: '.smoke/keep.txt', content: 'original' }, { workspaceRoot: workspace, approval: 'auto' as const });
  const r = await registry.execute('write_file', { path: '.smoke/keep.txt', content: 'changed' }, ctx);
  const id = (r.data as { checkpointId: string }).checkpointId;
  assert.equal(await readFile(join(workspace, '.smoke', 'keep.txt'), 'utf8'), 'changed');

  await checkpoints.undoByIds([id]);
  assert.equal(await readFile(join(workspace, '.smoke', 'keep.txt'), 'utf8'), 'original');

  await rm(workspace, { recursive: true, force: true });
});

test('project_index reports key files and extensions', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-index-'));
  await writeFile(join(workspace, 'package.json'), '{}');
  await writeFile(join(workspace, 'README.md'), '# readme');
  const registry = createDefaultToolRegistry();

  const result = await registry.execute('project_index', { path: '.', maxFiles: 20 }, { workspaceRoot: workspace, approval: 'auto' });

  assert.equal(result.ok, true);
  assert.match(result.output, /files: 2/);
  assert.match(result.output, /package.json/);
  assert.match(result.output, /.md/);

  await rm(workspace, { recursive: true, force: true });
});
test('an operation that lands in a folder is recorded but never reverted', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cp-dir-'));
  const memory = join(workspace, 'memory-root');
  const checkpoints = new CheckpointStore(workspace, { globalMemoryRoot: memory });
  try {
    const entry = await checkpoints.beforeWrite(workspace);
    assert.equal(entry.directory, true, 'a directory target is labelled as such');
    assert.equal(entry.existed, true);
    assert.deepEqual(await checkpoints.list(), [], 'nothing is indexed: this store cannot snapshot a tree');
    assert.equal(await checkpoints.undoLast(), 'No checkpoint to undo.');

    // It still reaches the global memory ledger — the folder really was touched.
    const ledger = await readFile(join(memory, 'edits.jsonl'), 'utf8');
    assert.match(ledger, /"action":"write"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('extract_zip into the workspace root works with checkpoints wired', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-zip-cp-'));
  const checkpoints = new CheckpointStore(workspace);
  const registry = createDefaultToolRegistry();
  const context = { workspaceRoot: workspace, approval: 'auto' as const, checkpoints };
  try {
    await writeFile(join(workspace, 'a.txt'), 'hello');
    const made = await registry.execute('create_zip', { path: 'out.zip', files: [{ path: 'a.txt' }] }, context);
    assert.equal(made.ok, true, String(made.output));

    const extracted = await registry.execute('extract_zip', { path: 'out.zip', to: 'copy', maxFiles: 100 }, context);
    assert.equal(extracted.ok, true, String(extracted.output));

    // The default target is the workspace root itself — a directory.
    const intoRoot = await registry.execute('extract_zip', { path: 'out.zip', maxFiles: 100 }, context);
    assert.equal(intoRoot.ok, true, String(intoRoot.output));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('apply_unified_diff runs at all when checkpoints are wired', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-patch-cp-'));
  const checkpoints = new CheckpointStore(workspace);
  const registry = createDefaultToolRegistry();
  const context = { workspaceRoot: workspace, approval: 'auto' as const, checkpoints };
  try {
    await writeFile(join(workspace, 'a.txt'), 'one\n');
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-one',
      '+two',
    ].join('\n');
    // Direct call: the registry policy allowlist is a separate concern here.
    const applied = await applyUnifiedDiffTool.execute({ patch, atomic: true }, context);
    assert.equal(applied.ok, true, String(applied.output));
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'two\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
