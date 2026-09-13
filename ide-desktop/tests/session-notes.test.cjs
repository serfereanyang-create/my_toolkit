const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionNotesStore, sanitizeSessionId } = require('../electron/session-notes.cjs');

async function freshStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-notes-'));
  return { dir, store: createSessionNotesStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const SID = 'sess-abc123';

test('empty store lists nothing', async () => {
  const fx = await freshStore();
  try {
    assert.deepEqual(await fx.store.list(SID), []);
    assert.deepEqual(await fx.store.summary(), []);
  } finally { await fx.cleanup(); }
});

test('add stores a note with id and timestamps', async () => {
  const fx = await freshStore();
  try {
    const note = await fx.store.add(SID, { text: '记得回头补 e2e' });
    assert.match(note.id, /^note-/);
    assert.equal(note.text, '记得回头补 e2e');
    assert.equal(note.pinned, false);
    assert.ok(note.createdAt && note.updatedAt);
    const list = await fx.store.list(SID);
    assert.equal(list.length, 1);
  } finally { await fx.cleanup(); }
});

test('rejects empty notes and oversized notes', async () => {
  const fx = await freshStore();
  try {
    await assert.rejects(() => fx.store.add(SID, { text: '   ' }), /笔记不能为空/);
    await assert.rejects(() => fx.store.add(SID, { text: 'x'.repeat(5000) }), /笔记过长/);
  } finally { await fx.cleanup(); }
});

test('session ids are sanitized; traversal is rejected', async () => {
  const fx = await freshStore();
  try {
    await assert.rejects(() => fx.store.list('../evil'), /Invalid session id/);
    await assert.rejects(() => fx.store.add('', { text: 'x' }), /Invalid session id/);
    // Weird-but-safe ids keep only [A-Za-z0-9_.-].
    const id = sanitizeSessionId('a b/c\\d?e');
    assert.equal(id, 'abcde');
  } finally { await fx.cleanup(); }
});

test('pinned notes sort first; then newest updated', async () => {
  const fx = await freshStore();
  try {
    const a = await fx.store.add(SID, { text: 'a' });
    await new Promise((r) => setTimeout(r, 4));
    await fx.store.add(SID, { text: 'b' });
    await new Promise((r) => setTimeout(r, 4));
    const c = await fx.store.add(SID, { text: 'c' });
    await fx.store.update(SID, a.id, { pinned: true });
    const list = await fx.store.list(SID);
    assert.deepEqual(list.map((n) => n.text), ['a', 'c', 'b']);
    void c;
  } finally { await fx.cleanup(); }
});

test('update merges text/pinned and preserves createdAt', async () => {
  const fx = await freshStore();
  try {
    const note = await fx.store.add(SID, { text: 'v1' });
    await new Promise((r) => setTimeout(r, 4));
    const upd = await fx.store.update(SID, note.id, { text: 'v2', pinned: true });
    assert.equal(upd.text, 'v2');
    assert.equal(upd.pinned, true);
    assert.equal(upd.createdAt, note.createdAt);
    assert.notEqual(upd.updatedAt, note.updatedAt);
    await assert.rejects(() => fx.store.update(SID, 'missing', { text: 'x' }), /笔记不存在/);
  } finally { await fx.cleanup(); }
});

test('remove deletes one; index entry pruned when session empties', async () => {
  const fx = await freshStore();
  try {
    const n1 = await fx.store.add(SID, { text: 'one' });
    await fx.store.add(SID, { text: 'two' });
    assert.deepEqual(await fx.store.remove(SID, n1.id), { ok: true });
    assert.equal((await fx.store.list(SID)).length, 1);
    assert.deepEqual(await fx.store.remove(SID, n1.id), { ok: false });
    const second = (await fx.store.list(SID))[0];
    await fx.store.remove(SID, second.id);
    const raw = JSON.parse(await readFile(fx.store.storePath, 'utf8'));
    assert.equal(raw[SID], undefined); // empty bucket pruned
  } finally { await fx.cleanup(); }
});

test('clear wipes the whole session', async () => {
  const fx = await freshStore();
  try {
    await fx.store.add(SID, { text: 'x' });
    assert.deepEqual(await fx.store.clear(SID), { ok: true });
    assert.deepEqual(await fx.store.list(SID), []);
  } finally { await fx.cleanup(); }
});

test('sessions are isolated from each other', async () => {
  const fx = await freshStore();
  try {
    await fx.store.add('sess-1', { text: 'only in one' });
    assert.deepEqual(await fx.store.list('sess-2'), []);
  } finally { await fx.cleanup(); }
});

test('summary rolls up counts and pinned flags', async () => {
  const fx = await freshStore();
  try {
    const a = await fx.store.add('sess-1', { text: 'x' });
    await fx.store.add('sess-1', { text: 'y' });
    await new Promise((r) => setTimeout(r, 4));
    await fx.store.add('sess-2', { text: 'z' });
    await fx.store.update('sess-1', a.id, { pinned: true });
    const sum = await fx.store.summary();
    assert.deepEqual(sum.map((s) => s.sessionId), ['sess-1', 'sess-2']); // pinned update touched sess-1 last
    const s1 = sum.find((s) => s.sessionId === 'sess-1');
    assert.equal(s1.count, 2);
    assert.equal(s1.pinned, 1);
  } finally { await fx.cleanup(); }
});

test('enforces the per-session cap', async () => {
  const fx = await freshStore();
  try {
    for (let i = 0; i < 100; i += 1) await fx.store.add(SID, { text: `n${i}` });
    await assert.rejects(() => fx.store.add(SID, { text: 'overflow' }), /上限/);
  } finally { await fx.cleanup(); }
});

test('corrupt store heals on next mutation', async () => {
  const fx = await freshStore();
  try {
    await mkdir(path.dirname(fx.store.storePath), { recursive: true });
    await writeFile(fx.store.storePath, ']]not json[[', 'utf8');
    assert.deepEqual(await fx.store.list(SID), []);
    await fx.store.add(SID, { text: 'healed' });
    const list = await fx.store.list(SID);
    assert.equal(list.length, 1);
  } finally { await fx.cleanup(); }
});

test('concurrent adds do not lose notes', async () => {
  const fx = await freshStore();
  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => fx.store.add(SID, { text: `c-${i}` })));
    assert.equal((await fx.store.list(SID)).length, 12);
  } finally { await fx.cleanup(); }
});
