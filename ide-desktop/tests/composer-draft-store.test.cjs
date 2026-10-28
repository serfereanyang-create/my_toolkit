'use strict';
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ComposerDraftStore, normalizeDrafts } = require('../electron/composer-draft-store.cjs');
const basePromise = fs.mkdtemp(path.join(os.tmpdir(), 'yoy-composer-drafts-'));

after(async () => {
  const base = path.resolve(await basePromise);
  const relative = path.relative(path.resolve(os.tmpdir()), base);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(base, { recursive: true, force: true });
});

async function fixture(name) {
  const base = await basePromise;
  const owner = path.join(base, name);
  await fs.mkdir(owner, { recursive: true });
  return { store: new ComposerDraftStore(path.join(owner, 'drafts')), owner, root: path.join(base, 'project') };
}

const draft = (sessionId = null, text = '尚未发送\n保留换行') => ({
  sessionId, text,
  files: [{ path: 'src/截图.png', name: '截图.png', size: 71, category: 'image', icon: 'image', preview: 'data:image/png;base64,not-persisted' }],
  mentions: [{ id: 'terminal:current', label: '终端输出', type: 'terminal', content: 'terminal snapshot' }],
});

test('a new store instance restores independent conversations and omits inline thumbnails', async () => {
  const { store, owner, root } = await fixture('roundtrip');
  const records = [draft(), draft('session-a', '会话 A')];
  await store.save(root, records);
  const restored = await new ComposerDraftStore(path.join(owner, 'drafts')).load(root);
  assert.deepEqual(restored, normalizeDrafts(records));
  assert.equal(restored[0].files[0].preview, undefined);
  assert.deepEqual(await store.load(path.join(owner, 'other-workspace')), []);
});

test('failed first-delivery recovery ownership survives a new main-process store', async () => {
  const { store, root, owner } = await fixture('recovery-ownership');
  const source = JSON.stringify([root, null]);
  const original = draft(null, 'unaccepted first message');
  const assigned = { ...draft('assigned-session', original.text), recoverySource: source };
  await store.save(root, [original, assigned]);
  const restored = await new ComposerDraftStore(path.join(owner, 'drafts')).load(root);
  assert.equal(restored[1].recoverySource, source);
  assert.equal(restored[0].text, original.text);
});

test('rapid snapshots and deletion reach disk in order and flush leaves no temporary files', async () => {
  const { store, root, owner } = await fixture('serialized');
  const writes = [store.save(root, [draft(null, 'first')]), store.save(root, [draft(null, 'second')]), store.save(root, [])];
  await store.flush();
  await Promise.all(writes);
  assert.deepEqual(await store.load(root), []);
  assert.equal((await fs.readdir(path.join(owner, 'drafts'))).some(name => name.endsWith('.tmp')), false);
});

test('corrupt stored drafts are reported and no later save overwrites their bytes', async () => {
  const { store, root } = await fixture('corrupt');
  const file = await store.file(root);
  const original = '{ incomplete user draft';
  await fs.writeFile(file, original);
  await assert.rejects(store.load(root));
  await assert.rejects(store.save(root, [draft()]));
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('foreign ownership and unsupported schema versions remain intact', async () => {
  const { store, root } = await fixture('ownership');
  const file = await store.file(root);
  for (const stored of [{ version: 999, root, drafts: [] }, { version: 1, root: 'foreign-workspace', drafts: [] }]) {
    const original = JSON.stringify(stored);
    await fs.writeFile(file, original);
    await assert.rejects(store.load(root), /归属或版本/);
    await assert.rejects(store.save(root, []));
    assert.equal(await fs.readFile(file, 'utf8'), original);
  }
});

test('malformed snapshots fail before touching a valid draft and terminal quotes stay bounded', async () => {
  const { store, root } = await fixture('validation');
  await store.save(root, [draft()]);
  assert.throws(() => store.save(root, [draft('duplicate'), draft('duplicate')]));
  assert.throws(() => store.save(root, [{ ...draft(), text: null }]));
  assert.throws(() => store.save(root, [{ ...draft(), files: [{ ...draft().files[0], size: -1 }] }]));
  assert.equal((await store.load(root))[0].text, '尚未发送\n保留换行');
  const bounded = normalizeDrafts([{ ...draft(), mentions: [{ id: 'terminal', type: 'terminal', label: '终端输出', content: 'x'.repeat(7000) }] }]);
  assert.equal(bounded[0].mentions[0].content.length, 6000);
});

test('a draft file cannot redirect reads or writes outside its storage directory', async () => {
  const { store, root, owner } = await fixture('symlink');
  const file = await store.file(root);
  const outside = path.join(owner, 'outside.json');
  await fs.writeFile(outside, 'preserve outside bytes');
  await fs.symlink(outside, file, process.platform === 'win32' ? 'file' : undefined);
  await assert.rejects(store.load(root), /outside workspace/);
  await assert.rejects(store.save(root, [draft()]));
  assert.equal(await fs.readFile(outside, 'utf8'), 'preserve outside bytes');
});
