import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../src/cli/args.js';
import { SessionStore } from '../src/session/store.js';

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
