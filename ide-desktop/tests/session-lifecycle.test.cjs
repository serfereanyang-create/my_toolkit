const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } = require('node:fs/promises');
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

  // A session with content but no user text (e.g. one that only ran a review)
  // still needs a readable title. A record with no messages at all is not
  // listed any more — see the empty-shell test below.
  await seedSession(root, 'sess_20260918154818_ddd042a6', [
    { role: 'assistant', content: '（空回合）', createdAt: '2026-09-18T15:48:18.000Z' },
  ], '2026-09-18T15:48:18.000Z');
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

  await seedSession(root, 'legacy-session-1', [
    { role: 'assistant', content: '（空回合）', createdAt: '2026-05-06T07:08:09.000Z' },
  ], '2026-05-06T07:08:09.000Z');
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

test('a session with no messages is not listed as a conversation', async () => {
  // Every spawned CLI child writes its session file on startup, before the
  // user has typed anything — aborting a chat left one behind. 68 such records
  // in a real workspace filled the list with identical 未命名会话 rows and,
  // since the 50-row cap is applied after sorting, hid older real chats.
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_empty_shell', [], '2026-10-18T00:51:03.000Z');
  await seedSession(root, 'sess_real', [
    { role: 'user', content: '列出文件', createdAt: '2026-10-18T00:40:00.000Z' },
  ], '2026-10-18T00:40:00.000Z');

  const list = await service.listSessions();
  assert.deepEqual(list.map((s) => s.id), ['sess_real']);

  await rm(root, { recursive: true, force: true });
});

test('a pinned session with no messages stays listed', async () => {
  // An explicit pin is the user's decision; hiding the row would look like
  // the pin failed.
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_pinned_empty', [], '2026-10-18T00:51:03.000Z');
  await service.pinSession('sess_pinned_empty', true);

  const list = await service.listSessions();
  assert.deepEqual(list.map((s) => s.id), ['sess_pinned_empty']);

  await rm(root, { recursive: true, force: true });
});

test('sessions sharing a title are stamped so the rows stay distinguishable', async () => {
  // "你好" typed eighteen times produced eighteen identical rows in the
  // sidebar; there was no way to tell which one to open. Only the clashing
  // rows get a stamp, and the rename box keeps the original title.
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_hi_1', [
    { role: 'user', content: '你好', createdAt: '' },
  ], '2026-10-17T15:28:50.000Z');
  await seedSession(root, 'sess_hi_2', [
    { role: 'user', content: '你好', createdAt: '' },
  ], '2026-10-18T09:05:00.000Z');
  await seedSession(root, 'sess_unique', [
    { role: 'user', content: '重构登录模块', createdAt: '' },
  ], '2026-10-16T08:00:00.000Z');

  const list = await service.listSessions();
  const byId = new Map(list.map((s) => [s.id, s]));

  assert.equal(byId.get('sess_hi_1').title, '你好 · 10-17 15:28');
  assert.equal(byId.get('sess_hi_2').title, '你好 · 10-18 09:05');
  assert.equal(byId.get('sess_hi_1').baseTitle, '你好');
  // A title with no clash is left exactly as it was.
  assert.equal(byId.get('sess_unique').title, '重构登录模块');
  assert.equal(byId.get('sess_unique').baseTitle, undefined);

  await rm(root, { recursive: true, force: true });
});

test('loadSession falls back to the sub-agent store for a sub-session id', async () => {
  // The 子智能体目录 shows the sub-session id. Those live beside the chat
  // sessions now, so the click must still resolve rather than fail with ENOENT.
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  const subDir = path.join(root, '.aicode', 'sessions-subagents');
  await mkdir(subDir, { recursive: true });
  await writeFile(path.join(subDir, 'sess_sub_1.json'), JSON.stringify({
    id: 'sess_sub_1', createdAt: '', updatedAt: '', provider: 'mock', model: 'mock',
    workspaceRoot: root, messages: [{ role: 'user', content: '子任务', createdAt: '' }],
    toolCalls: [], finalAnswers: [],
  }), 'utf8');

  const record = await service.loadSession('sess_sub_1');
  assert.equal(record.id, 'sess_sub_1');
  assert.equal(record.messages[0].content, '子任务');

  // Sub-sessions are not conversations and must not be listed.
  assert.deepEqual(await service.listSessions(), []);

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

test('forkSession copies the whole transcript and leaves the source byte-identical', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_src', [
    { role: 'user', content: '第一个问题', createdAt: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', content: '第一个回答', createdAt: '2026-01-01T00:00:01.000Z' },
    { role: 'user', content: '第二个问题', createdAt: '2026-01-01T00:00:02.000Z' },
  ], '2026-01-02T00:00:00.000Z');
  const sourcePath = service.sessionAbsolutePath('sess_src');
  const sourceBefore = await readFile(sourcePath, 'utf8');

  const result = await service.forkSession('sess_src');
  assert.equal(result.ok, true);
  assert.equal(result.sourceId, 'sess_src');
  assert.notEqual(result.id, 'sess_src');

  const forked = await service.loadSession(result.id);
  const source = await service.loadSession('sess_src');

  // The whole conversation is inherited, in order, plus a fork marker.
  assert.equal(forked.messages.length, source.messages.length + 1);
  assert.deepEqual(
    forked.messages.slice(0, -1).map((m) => m.content),
    source.messages.map((m) => m.content),
  );
  assert.match(forked.messages.at(-1).content, /forked from sess_src/);

  // The key safety property: forking must not rewrite the conversation it forks.
  assert.equal(await readFile(sourcePath, 'utf8'), sourceBefore);

  await rm(root, { recursive: true, force: true });
});

test('a forked session is titled as a copy, never as 未命名会话', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_named', [
    { role: 'user', content: '帮我重构登录模块', createdAt: '' },
  ], '2026-01-01T00:00:00.000Z');

  const { id } = await service.forkSession('sess_named');
  const list = await service.listSessions();
  const copy = list.find((s) => s.id === id);

  assert.equal(copy.title, '帮我重构登录模块（副本）');
  assert.ok(!copy.title.includes('未命名'), `copy fell back to a placeholder title: ${copy.title}`);

  await rm(root, { recursive: true, force: true });
});

test('a copy of a desktop-renamed session keeps the custom title', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_renamed', [{ role: 'user', content: 'raw first message', createdAt: '' }]);
  await service.renameSession('sess_renamed', '自定义标题');

  const { id } = await service.forkSession('sess_renamed');
  const list = await service.listSessions();
  const copy = list.find((s) => s.id === id);

  // The overlay title wins over the first user message, exactly as in the list.
  assert.equal(copy.title, '自定义标题（副本）');

  await rm(root, { recursive: true, force: true });
});

test('forking an unknown session fails instead of creating an empty one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await assert.rejects(() => service.forkSession('sess_does_not_exist'));

  // Nothing was written: a failed fork must not leave a stray session behind.
  const list = await service.listSessions();
  assert.equal(list.length, 0);

  await rm(root, { recursive: true, force: true });
});

test('forkSession refuses a path-traversal id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await assert.rejects(() => service.forkSession('../../etc/passwd'), /Invalid session id/);

  await rm(root, { recursive: true, force: true });
});

test('forkSession drops the source turn payload and task board', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_state', [{ role: 'user', content: 'go', createdAt: '' }]);
  const dir = path.join(root, '.aicode', 'sessions');
  const record = JSON.parse(await readFile(path.join(dir, 'sess_state.json'), 'utf8'));
  record.lastTurn = { prompt: 'go', status: 'done', startedAt: '2026-01-01T00:00:00.000Z' };
  record.taskRuntime = { mode: 'executing', boardId: 'board_20260101000000_aaaaaaaa' };
  record.providerContinuation = { id: 'resp_123' };
  await writeFile(path.join(dir, 'sess_state.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const { id } = await service.forkSession('sess_state');
  const forked = await service.loadSession(id);

  // A fork is a new conversation: replaying the source's turn, adopting its
  // task board, or continuing its provider response chain would all be wrong.
  assert.equal(forked.lastTurn, undefined);
  assert.equal(forked.taskRuntime, undefined);
  assert.equal(forked.providerContinuation, undefined);
  assert.equal(forked.messages.length, 2);

  await rm(root, { recursive: true, force: true });
});

// The sidecar overlay holds every session's title, pin and archive flag at
// once, so it is the one file whose loss is both silent and total. It used to
// be written with a plain in-place writeFile and read with a catch-all that
// answered `{}`: a torn or unreadable document made the next rename replace the
// whole map with a single entry, taking every other chat's name with it, and two
// edits in the same tick could interleave into invalid JSON.
test('a corrupt overlay is preserved instead of being overwritten by the next rename', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_corrupt', [{ role: 'user', content: 'x', createdAt: '' }]);
  const dir = path.join(root, '.aicode', 'sessions');
  const overlayPath = path.join(dir, '.desktop-meta.json');
  const torn = '{"sess_other": {"title": "标题';
  await writeFile(overlayPath, torn, 'utf8');

  await service.renameSession('sess_corrupt', '新标题');

  const files = await readdir(dir);
  const quarantined = files.filter((name) => name.includes('.desktop-meta.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'the unreadable copy is moved aside, not destroyed');
  assert.equal(await readFile(path.join(dir, quarantined[0]), 'utf8'), torn);

  const overlay = JSON.parse(await readFile(overlayPath, 'utf8'));
  assert.equal(overlay.sess_corrupt.title, '新标题');

  await rm(root, { recursive: true, force: true });
});

test('concurrent overlay edits are serialised: none is lost and the file stays valid JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await seedSession(root, 'sess_one', [{ role: 'user', content: 'x', createdAt: '' }]);
  await seedSession(root, 'sess_two', [{ role: 'user', content: 'x', createdAt: '' }]);
  await seedSession(root, 'sess_three', [{ role: 'user', content: 'x', createdAt: '' }]);

  await Promise.all([
    service.renameSession('sess_one', '并发标题'),
    service.pinSession('sess_two', true),
    service.archiveSession('sess_three', true),
  ]);

  const dir = path.join(root, '.aicode', 'sessions');
  const raw = await readFile(path.join(dir, '.desktop-meta.json'), 'utf8');
  const overlay = JSON.parse(raw);
  assert.equal(overlay.sess_one.title, '并发标题');
  assert.equal(overlay.sess_two.pinned, true);
  assert.equal(overlay.sess_three.archived, true);

  await rm(root, { recursive: true, force: true });
});

// Two writers share the session record: the CLI's `/rename` and `/pin` write on
// the record itself, while the desktop keeps its title and pin in the sidecar
// overlay. The sidebar used to read only the overlay, so a rename or pin made in
// the CLI was invisible here.
test('a title and pin written by the CLI on the record are honoured by the sidebar', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  const record = await seedSession(root, 'sess_cli_meta', [{ role: 'user', content: '第一个问题', createdAt: '' }]);
  const dir = path.join(root, '.aicode', 'sessions');
  await writeFile(path.join(dir, 'sess_cli_meta.json'), `${JSON.stringify({ ...record, title: 'CLI 改的名字', pinned: true }, null, 2)}\n`, 'utf8');

  const row = (await service.listSessions()).find((item) => item.id === 'sess_cli_meta');
  assert.equal(row.title, 'CLI 改的名字');
  assert.equal(row.pinned, true);

  // Unpinning from the desktop must win over the record, or the row would snap back.
  await service.pinSession('sess_cli_meta', false);
  const after = (await service.listSessions()).find((item) => item.id === 'sess_cli_meta');
  assert.equal(after.pinned, false);

  await rm(root, { recursive: true, force: true });
});

test('a pin an older CLI build hid in guard.pinned still counts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-sess-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  const record = await seedSession(root, 'sess_guard_pin', [{ role: 'user', content: 'x', createdAt: '' }]);
  const dir = path.join(root, '.aicode', 'sessions');
  await writeFile(path.join(dir, 'sess_guard_pin.json'), `${JSON.stringify({ ...record, guard: { pinned: true } }, null, 2)}\n`, 'utf8');

  const row = (await service.listSessions()).find((item) => item.id === 'sess_guard_pin');
  assert.equal(row.pinned, true);

  await rm(root, { recursive: true, force: true });
});
