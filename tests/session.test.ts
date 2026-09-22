import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../src/cli/args.js';
import { SessionStore } from '../src/session/store.js';

async function createSessionStore(prefix: string) {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  const store = new SessionStore(join(workspace, '.aicode', 'sessions'));
  const session = await store.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
  return { workspace, store, session };
}

test('parseArgs supports --resume', () => {
  const args = parseArgs(['--resume', 'sess_20260706120000_abcdef12', '--prompt', 'continue']);
  assert.equal(args.resumeSessionId, 'sess_20260706120000_abcdef12');
  assert.equal(args.prompt, 'continue');
});

test('SessionStore loads a saved session for resume', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-session-'));
  const store = new SessionStore(join(workspace, '.aicode', 'sessions'));
  const session = await store.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
  await store.appendMessage(session, { role: 'user', content: 'first turn' });

  const loaded = await store.load(session.id);
  assert.equal(loaded.id, session.id);
  assert.equal(loaded.messages.at(-1)?.content, 'first turn');

  await store.appendMessage(loaded, { role: 'user', content: 'second turn' });
  const resumed = await store.load(session.id);
  assert.equal(resumed.messages.at(-1)?.content, 'second turn');
  assert.equal(resumed.messages.length, 2);

  await rm(workspace, { recursive: true, force: true });
});


test('SessionStore retries a transient Windows rename failure', async () => {
  const { workspace, store: initialStore, session } = await createSessionStore('aicode-session-retry-');
  const sessionDir = join(workspace, '.aicode', 'sessions');
  let attempts = 0;
  const delays: number[] = [];
  const resilientStore = new SessionStore(sessionDir, {
    renameRetries: 3,
    renameRetryDelayMs: 0,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    rename: async (from, to) => {
      attempts += 1;
      if (attempts <= 2) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      const { rename } = await import('node:fs/promises');
      await rename(from, to);
    },
  });

  session.messages.push({ role: 'user', content: 'survives a transient lock', createdAt: new Date().toISOString() });
  await resilientStore.save(session);

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [0, 0]);
  const loaded = await initialStore.load(session.id);
  assert.equal(loaded.messages.at(-1)?.content, 'survives a transient lock');
  await rm(workspace, { recursive: true, force: true });
});

test('SessionStore serializes concurrent saves and preserves each snapshot', async () => {
  const { workspace, session } = await createSessionStore('aicode-session-queue-');
  const sessionDir = join(workspace, '.aicode', 'sessions');
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const renamedSnapshots: string[] = [];
  let releaseFirst!: () => void;
  const firstRenameReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let signalFirstStarted!: () => void;
  const firstRenameStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const queuedStore = new SessionStore(sessionDir, {
    renameRetries: 0,
    rename: async (from, to) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) {
        signalFirstStarted();
        await firstRenameReleased;
      }
      const { readFile, rename } = await import('node:fs/promises');
      await rename(from, to);
      renamedSnapshots.push(JSON.parse(await readFile(to, 'utf8')).messages.at(-1)?.content ?? '');
      active -= 1;
    },
  });

  session.messages.push({ role: 'user', content: 'first snapshot', createdAt: new Date().toISOString() });
  const firstSave = queuedStore.save(session);
  await firstRenameStarted;
  session.messages.push({ role: 'user', content: 'second snapshot', createdAt: new Date().toISOString() });
  const secondSave = queuedStore.save(session);
  releaseFirst();
  await Promise.all([firstSave, secondSave]);

  assert.equal(maximumActive, 1);
  assert.equal(calls, 2);
  assert.deepEqual(renamedSnapshots, ['first snapshot', 'second snapshot']);
  const loaded = await new SessionStore(sessionDir).load(session.id);
  assert.equal(loaded.messages.at(-1)?.content, 'second snapshot');
  await rm(workspace, { recursive: true, force: true });
});

test('SessionStore queue recovers after a permanent save failure', async () => {
  const { workspace, session } = await createSessionStore('aicode-session-failure-');
  const sessionDir = join(workspace, '.aicode', 'sessions');
  let attempts = 0;
  const recoveringStore = new SessionStore(sessionDir, {
    renameRetries: 0,
    rename: async (from, to) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('permanent rename failure'), { code: 'EIO' });
      const { rename } = await import('node:fs/promises');
      await rename(from, to);
    },
  });

  session.messages.push({ role: 'user', content: 'failed snapshot', createdAt: new Date().toISOString() });
  await assert.rejects(recoveringStore.save(session), /permanent rename failure/);
  const namesAfterFailure = await readdir(sessionDir);
  assert.equal(namesAfterFailure.some((name) => name.endsWith('.tmp')), false);

  session.messages.push({ role: 'user', content: 'later snapshot', createdAt: new Date().toISOString() });
  await recoveringStore.save(session);
  const loaded = await new SessionStore(sessionDir).load(session.id);
  assert.equal(loaded.messages.at(-1)?.content, 'later snapshot');
  await rm(workspace, { recursive: true, force: true });
});

test('SessionStore fork carries the whole transcript and leaves the source untouched', async () => {
  const { workspace, store, session } = await createSessionStore('aicode-session-fork-');
  await store.appendMessage(session, { role: 'user', content: 'first request' });
  await store.appendMessage(session, { role: 'assistant', content: 'first answer' });
  await store.appendMessage(session, { role: 'user', content: 'second request' });
  const sourcePath = store.filePath(session.id);
  const sourceBytesBefore = await readFile(sourcePath, 'utf8');

  const forked = await store.fork(session.id, {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    workspaceRoot: workspace,
  });

  assert.notEqual(forked.id, session.id);
  // Every original message is present, in order, plus the fork marker.
  assert.equal(forked.messages.length, session.messages.length + 1);
  assert.deepEqual(
    forked.messages.slice(0, -1).map((m) => m.content),
    session.messages.map((m) => m.content),
  );
  assert.match(forked.messages.at(-1)?.content ?? '', /forked from/);
  assert.match(forked.messages.at(-1)?.content ?? '', new RegExp(session.id));

  // The key safety property: forking must not rewrite the conversation it forks.
  assert.equal(await readFile(sourcePath, 'utf8'), sourceBytesBefore);

  // The fork is a real, independently loadable session.
  const reloaded = await store.load(forked.id);
  assert.equal(reloaded.messages.length, forked.messages.length);
  await rm(workspace, { recursive: true, force: true });
});

test('SessionStore fork refuses an unknown session instead of creating an empty one', async () => {
  const { workspace, store } = await createSessionStore('aicode-session-fork-missing-');
  await assert.rejects(
    store.fork('sess_20260706120000_deadbeef', {
      provider: 'mock',
      model: 'mock-code-agent-v1',
      workspaceRoot: workspace,
    }),
  );
  await rm(workspace, { recursive: true, force: true });
});

test('SessionStore fork drops the source turn payload and task board', async () => {
  const { workspace, store, session } = await createSessionStore('aicode-session-fork-state-');
  await store.appendMessage(session, { role: 'user', content: 'do the thing' });
  await store.setLastTurn(session, {
    prompt: 'do the thing',
    status: 'done',
    startedAt: new Date().toISOString(),
  });
  session.taskRuntime = { mode: 'idle', boardId: 'board_20260706120000_abcdef12' };
  await store.save(session);

  const forked = await store.fork(session.id, {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    workspaceRoot: workspace,
  });

  // A fork must not replay the source's last turn or adopt its task board.
  assert.equal(forked.lastTurn, undefined);
  assert.equal(forked.taskRuntime, undefined);
  assert.equal(forked.messages.length, session.messages.length + 1);
  await rm(workspace, { recursive: true, force: true });
});
