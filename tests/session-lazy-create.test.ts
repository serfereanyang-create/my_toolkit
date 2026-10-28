import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionStore } from '../src/session/store.js';

/*
 * A launched process creates a session record before it knows whether the user
 * will say anything. Writing that record eagerly left an empty conversation in
 * the sidebar for every launch — every app start, every spawned child, every
 * harness run — so `createRuntime` asks for the lazy form and the file appears
 * with the first real turn instead.
 */

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

test('create({ persist: false }) leaves nothing on disk', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-session-lazy-'));
  const dir = join(workspace, '.aicode', 'sessions');
  const store = new SessionStore(dir);
  const session = await store.create({
    provider: 'mock',
    model: 'mock-code-agent-v1',
    workspaceRoot: workspace,
    persist: false,
  });

  assert.deepEqual(await listDir(dir), []);
  assert.ok(session.id.startsWith('sess_'));
  // Nothing to list yet: the sidebar reads this directory.
  assert.deepEqual(await store.list(), []);
});

test('the first turn persists the lazily created session', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-session-lazy-'));
  const dir = join(workspace, '.aicode', 'sessions');
  const store = new SessionStore(dir);
  const session = await store.create({
    provider: 'mock',
    model: 'mock-code-agent-v1',
    workspaceRoot: workspace,
    persist: false,
  });

  await store.appendMessage(session, { role: 'user', content: '你好' });

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, session.id);
  assert.equal(listed[0]?.messages.at(-1)?.content, '你好');
});

test('create() still writes immediately by default', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-session-eager-'));
  const dir = join(workspace, '.aicode', 'sessions');
  const store = new SessionStore(dir);
  const session = await store.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });

  assert.deepEqual(await listDir(dir), [`${session.id}.json`]);
});
