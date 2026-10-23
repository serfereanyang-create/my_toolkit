import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
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
    await checkpoints.confirm(entry);
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

/** The index cap in src/session/checkpoint.ts. */
const INDEX_CAP = 400;

test('a batch of concurrent writes keeps every checkpoint and its backup', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cp-parallel-'));
  const backups = join(workspace, '.aicode', 'checkpoints', 'backups');
  try {
    // agent.ts runs a step's tool calls through Promise.all: they all try to
    // read-modify-write index.json at once, which used to lose entries and
    // fail the write outright on Windows.
    for (let i = 0; i < 20; i += 1) await writeFile(join(workspace, `f${i}.txt`), 'v0');
    const checkpoints = new CheckpointStore(workspace, { recordGlobalMemory: false });
    const rounds = 5;
    let rejected = 0;
    for (let round = 0; round < rounds; round += 1) {
      const settled = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => checkpoints.beforeWrite(join(workspace, `f${i}.txt`))),
      );
      rejected += settled.filter((outcome) => outcome.status === 'rejected').length;
    }
    assert.equal(rejected, 0, 'no write is aborted by a racing index update');
    const entries = await checkpoints.list();
    assert.equal(entries.length, rounds * 20);
    assert.equal(new Set(entries.map((entry) => entry.id)).size, rounds * 20, 'no id is lost or duplicated');
    assert.equal((await readdir(backups)).length, rounds * 20, 'every entry has the backup undo needs');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('the undo history is capped and the dropped backups are deleted', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cp-cap-'));
  const root = join(workspace, '.aicode', 'checkpoints');
  try {
    for (let i = 0; i < 10; i += 1) await writeFile(join(workspace, `f${i}.txt`), 'v0');
    const checkpoints = new CheckpointStore(workspace, { recordGlobalMemory: false });
    const rounds = Math.ceil((INDEX_CAP + 10) / 10);
    for (let round = 0; round < rounds; round += 1) {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => checkpoints.beforeWrite(join(workspace, `f${i}.txt`))),
      );
    }
    const entries = await checkpoints.list();
    assert.equal(entries.length, INDEX_CAP, 'the index stops growing');
    assert.equal((await readdir(join(root, 'backups'))).length, INDEX_CAP, 'disk use stops growing with it');
    // Pruning keeps the newest entries, so undo still works on recent history.
    assert.match(await checkpoints.undoLast(), /^Undid checkpoint/);
    assert.equal((await checkpoints.list()).length, INDEX_CAP - 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a stale orphan backup is swept, a backup from a write still in flight is not', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cp-orphan-'));
  const backups = join(workspace, '.aicode', 'checkpoints', 'backups');
  try {
    await writeFile(join(workspace, 'a.txt'), 'content');
    const checkpoints = new CheckpointStore(workspace, { recordGlobalMemory: false });
    await mkdir(backups, { recursive: true });
    // A backup whose entry never made it into the index.
    await writeFile(join(backups, 'cp_orphan.bak'), 'gone');
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(join(backups, 'cp_orphan.bak'), stale, stale);
    // A sibling write in a batch may have created its backup but not yet
    // indexed it; sweeping that window would break its undo.
    await writeFile(join(backups, 'cp_inflight.bak'), 'kept');

    await checkpoints.beforeWrite(join(workspace, 'a.txt'));

    const names = await readdir(backups);
    assert.equal(names.includes('cp_orphan.bak'), false, 'the orphan is cleaned up');
    assert.equal(names.includes('cp_inflight.bak'), true, 'a fresh backup is left alone');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
