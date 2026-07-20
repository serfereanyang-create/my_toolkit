import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CheckpointStore } from '../src/session/checkpoint.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

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
