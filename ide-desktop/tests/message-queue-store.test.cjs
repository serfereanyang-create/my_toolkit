'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MessageQueueStore } = require('../electron/message-queue-store.cjs');
const base = path.resolve(__dirname, '..', 'out', 'interrupt-review', 'queue-store');
const message = (id, sessionId = 'session-a') => ({ id, sessionId, text: `message ${id}`, createdAt: 1, files: [{ path: 'C:/fixture/context.txt', name: 'context.txt', size: 12 }] });

test('workspace queues and attachments survive a new store instance and load in paused state', async () => {
  const owner = path.join(base, 'roundtrip'); await fs.mkdir(owner, { recursive: true });
  const store = new MessageQueueStore(path.join(owner, 'queues'));
  const root = path.join(base, 'project-a');
  await store.save(root, { messages: [message('first'), message('second')], pausedSessions: [] });
  const loaded = await new MessageQueueStore(path.join(owner, 'queues')).load(root);
  assert.deepEqual(loaded.messages, [message('first'), message('second')]);
  assert.deepEqual(loaded.pausedSessions, ['session-a']);
  const other = await store.load(path.join(base, 'project-b'));
  assert.deepEqual(other.messages, []);
});

test('serialized writes keep the newest snapshot, including removal, without leftover temporary files', async () => {
  const owner = path.join(base, 'serialized'); await fs.mkdir(owner, { recursive: true });
  const store = new MessageQueueStore(path.join(owner, 'queues')); const root = path.join(base, 'project');
  await Promise.all([
    store.save(root, { messages: [message('first')], pausedSessions: [] }),
    store.save(root, { messages: [message('second')], pausedSessions: ['session-a'] }),
    store.save(root, { messages: [], pausedSessions: [] }),
  ]);
  await store.flush();
  assert.deepEqual((await store.load(root)).messages, []);
  assert.equal((await fs.readdir(path.join(owner, 'queues'))).some(name => name.endsWith('.tmp')), false);
});

test('a corrupt queue is reported and remains byte-for-byte intact', async () => {
  const owner = path.join(base, 'corrupt'); await fs.mkdir(owner, { recursive: true });
  const store = new MessageQueueStore(path.join(owner, 'queues')); const root = path.join(base, 'project');
  const file = await store.file(root); const original = '{ broken queue'; await fs.writeFile(file, original);
  await assert.rejects(store.load(root));
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('queue files cannot follow a link outside the owned queue directory', async () => {
  const owner = path.join(base, 'links'); await fs.mkdir(owner, { recursive: true });
  const store = new MessageQueueStore(path.join(owner, 'queues')); const root = path.join(base, 'project');
  const file = await store.file(root); const outside = path.join(owner, 'outside.json'); await fs.writeFile(outside, '{}');
  try { await fs.symlink(outside, file, process.platform === 'win32' ? 'file' : undefined); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await assert.rejects(store.load(root), /outside workspace/);
  assert.equal(await fs.readFile(outside, 'utf8'), '{}');
});

test('malformed snapshots fail without replacing a valid queue', async () => {
  const owner = path.join(base, 'validation'); await fs.mkdir(owner, { recursive: true });
  const store = new MessageQueueStore(path.join(owner, 'queues')); const root = path.join(base, 'project');
  await store.save(root, { messages: [message('valid')], pausedSessions: [] });
  assert.throws(() => store.save(root, { messages: [{ text: 'missing ids' }], pausedSessions: [] }));
  assert.throws(() => store.save(root, { messages: [message('duplicate'), message('duplicate')], pausedSessions: [] }));
  assert.deepEqual((await store.load(root)).messages.map(entry => entry.id), ['valid']);
});
