const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createWorkspaceService } = require('../electron/workspace.cjs');

test('workspace service reads files inside root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-ws-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;');
  const service = createWorkspaceService();
  service.setRoot(root);

  assert.equal(await service.readFile('src/index.ts'), 'export const value = 1;');
  await rm(root, { recursive: true, force: true });
});

test('workspace service rejects paths outside root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-ws-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await assert.rejects(() => service.readFile('../outside.txt'), /escapes workspace/);
  await rm(root, { recursive: true, force: true });
});
