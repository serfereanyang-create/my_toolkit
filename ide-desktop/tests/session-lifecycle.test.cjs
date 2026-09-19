const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createWorkspaceService } = require('../electron/workspace.cjs');

// Build a minimal CLI-shaped session record on disk.
async function seedSession(root, id, messages, updatedAt) {
  const dir = path.join(root, '.aicode', 'sessions');
  await mkdir(dir, { recursive: true });
  const record = {
    id,
    createdAt: updatedAt || '2026-01-01T00:00:00.000Z',
    updatedAt: updatedAt || '2026-01-01T00:00:00.000Z',
    provider: 'mock',
    model: 'mock-code-agent-v1',
    workspaceRoot: root,
    messages: messages || [],
    toolCalls: [],
    finalAnswers: [],
  };
  await writeFile(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

test('listSessions returns metadata with title derived from first user message', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_a', [
    { role: 'user', content: '帮我重构登录模块', createdAt: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', content: '好的', createdAt: '2026-01-01T00:00:01.000Z' },
  ], '2026-01-02T00:00:00.000Z');

  const list = await service.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'sess_a');
  assert.equal(list[0].title, '帮我重构登录模块');
  assert.equal(list[0].messageCount, 2);
  assert.equal(list[0].pinned, false);

  await rm(root, { recursive: true, force: true });
});

test('an unused session gets a readable fallback title, never its raw id', async () => {
  // A session created but never used has no user text, and the sidebar used to
  // fall back to the raw id (`sess_20260918154818_ddd042a6`) — an internal
  // identifier shown as a title.
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_20260918154818_ddd042a6', [], '2026-09-18T15:48:18.000Z');
  const list = await service.listSessions();

  assert.equal(list.length, 1);
  assert.ok(!list[0].title.includes('sess_'), `title leaked the raw id: ${list[0].title}`);
  assert.equal(list[0].title, '未命名会话 · 2026-09-18 15:48');

  await rm(root, { recursive: true, force: true });
});

test('a non-standard session id falls back to its timestamp, not the id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'legacy-session-1', [], '2026-05-06T07:08:09.000Z');
  const list = await service.listSessions();

  assert.equal(list[0].title, '未命名会话 · 2026-05-06 07:08');

  await rm(root, { recursive: true, force: true });
});

test('listSessions sorts pinned first, then by updatedAt desc', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_old', [{ role: 'user', content: 'old', createdAt: '' }], '2026-01-01T00:00:00.000Z');
  await seedSession(root, 'sess_new', [{ role: 'user', content: 'new', createdAt: '' }], '2026-03-01T00:00:00.000Z');
  await seedSession(root, 'sess_pin', [{ role: 'user', content: 'pin', createdAt: '' }], '2026-02-01T00:00:00.000Z');

  await service.pinSession('sess_pin', true);
  const list = await service.listSessions();

  assert.equal(list[0].id, 'sess_pin', 'pinned session comes first');
  assert.equal(list[1].id, 'sess_new', 'then newest');
  assert.equal(list[2].id, 'sess_old');

  await rm(root, { recursive: true, force: true });
});

test('loadSession returns the full record', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_load', [{ role: 'user', content: 'hello', createdAt: '' }]);
  const record = await service.loadSession('sess_load');
  assert.equal(record.id, 'sess_load');
  assert.equal(record.messages[0].content, 'hello');

  await rm(root, { recursive: true, force: true });
});

test('renameSession + pinSession persist in the sidecar overlay without mutating the session file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  const original = await seedSession(root, 'sess_meta', [{ role: 'user', content: 'x', createdAt: '' }]);
  await service.renameSession('sess_meta', '自定义标题');
  await service.pinSession('sess_meta', true);

  const list = await service.listSessions();
  assert.equal(list[0].title, '自定义标题');
  assert.equal(list[0].pinned, true);

  // The CLI's own session JSON must be untouched by desktop metadata.
  const raw = await service.loadSession('sess_meta');
  assert.deepEqual(raw.messages, original.messages);
  assert.equal(raw.title, undefined, 'title lives in the sidecar, not the session record');

  // Sidecar file exists alongside the session.
  const files = await readdir(path.join(root, '.aicode', 'sessions'));
  assert.ok(files.includes('.desktop-meta.json'));

  await rm(root, { recursive: true, force: true });
});

test('deleteSession removes the file and its overlay entry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_del', [{ role: 'user', content: 'x', createdAt: '' }]);
  await service.renameSession('sess_del', '待删除');
  await service.deleteSession('sess_del');

  const list = await service.listSessions();
  assert.equal(list.length, 0);

  await rm(root, { recursive: true, force: true });
});

test('session ids are guarded against path traversal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await assert.rejects(() => service.loadSession('../../etc/passwd'), /Invalid session id/);
  await assert.rejects(() => service.deleteSession('..\\..\\secret'), /Invalid session id/);

  await rm(root, { recursive: true, force: true });
});

test('corrupt session files are skipped, not fatal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  const dir = path.join(root, '.aicode', 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'broken.json'), '{ not valid json', 'utf8');
  await seedSession(root, 'sess_ok', [{ role: 'user', content: 'ok', createdAt: '' }]);

  const list = await service.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'sess_ok');

  await rm(root, { recursive: true, force: true });
});
