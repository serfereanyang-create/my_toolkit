const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createWorkspaceService } = require('../electron/workspace.cjs');

async function seedSession(root, id, messages) {
  const dir = path.join(root, '.aicode', 'sessions');
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const record = {
    id,
    createdAt: now,
    updatedAt: now,
    provider: 'mock',
    model: 'mock-code-agent-v1',
    workspaceRoot: root,
    messages: messages || [],
    toolCalls: [],
    finalAnswers: [],
  };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2), 'utf8');
}

test('archived sessions are excluded from the active list and appear in the archived list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-arch-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_a', [{ role: 'user', content: 'first chat' }]);
  await seedSession(root, 'sess_b', [{ role: 'user', content: 'second chat' }]);

  // Both active initially.
  let active = await service.listSessions();
  assert.equal(active.length, 2);
  let archived = await service.listArchivedSessions();
  assert.equal(archived.length, 0);

  // Archive one.
  const result = await service.archiveSession('sess_a', true);
  assert.equal(result.archived, true);

  active = await service.listSessions();
  assert.deepEqual(active.map((s) => s.id), ['sess_b']);

  archived = await service.listArchivedSessions();
  assert.deepEqual(archived.map((s) => s.id), ['sess_a']);
  assert.equal(archived[0].archived, true);
  assert.equal(archived[0].title, 'first chat');

  // Restore it.
  await service.archiveSession('sess_a', false);
  active = await service.listSessions();
  assert.equal(active.length, 2);
  archived = await service.listArchivedSessions();
  assert.equal(archived.length, 0);

  await rm(root, { recursive: true, force: true });
});

test('archive flag survives in the sidecar without mutating the session file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-arch-'));
  const service = createWorkspaceService();
  service.setRoot(root);
  await seedSession(root, 'sess_x', [{ role: 'user', content: 'hello' }]);

  const before = await service.loadSession('sess_x');
  await service.archiveSession('sess_x', true);
  const after = await service.loadSession('sess_x');

  // The CLI's session record must be untouched by desktop archive metadata.
  assert.deepEqual(after, before);

  await rm(root, { recursive: true, force: true });
});
