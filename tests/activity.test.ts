import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockProvider } from '../src/providers/mock.js';
import { buildToolSystemPrompt } from '../src/providers/protocol.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('recent_activity summarizes sessions and files without git', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-activity-'));
  await mkdir(join(workspace, '.aicode', 'sessions'), { recursive: true });
  await writeFile(join(workspace, 'note.txt'), 'recent');
  const sessions = new SessionStore(join(workspace, '.aicode', 'sessions'));
  const session = await sessions.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
  await sessions.appendMessage(session, { role: 'user', content: 'hello activity' });
  await sessions.appendToolCall(session, { tool: 'project_index', input: {}, ok: true, output: 'files: 1' });

  const result = await createDefaultToolRegistry().execute('recent_activity', { maxSessions: 3, maxFiles: 5 }, { workspaceRoot: workspace, approval: 'auto' });

  assert.equal(result.ok, true);
  assert.match(result.output, /sessions:/);
  assert.match(result.output, /hello activity/);
  assert.match(result.output, /recent files:/);
  assert.match(result.output, /git: not a git repository/);

  await rm(workspace, { recursive: true, force: true });
});

test('mock provider uses recent_activity for recent activity questions', async () => {
  const response = await createMockProvider().complete({
    messages: [{ role: 'user', content: '你看看zcode最近在干嘛', createdAt: new Date().toISOString() }],
    tools: [],
    workspaceRoot: process.cwd(),
  });

  assert.equal(response.actions[0]?.type, 'tool');
  if (response.actions[0]?.type === 'tool') assert.equal(response.actions[0].tool, 'recent_activity');
});

test('tool system prompt tells models to use recent_activity for history questions', () => {
  const prompt = buildToolSystemPrompt([{ name: 'recent_activity', description: 'activity', inputHint: '{}', risk: 'read' }]);

  assert.match(prompt, /recent_activity/);
  assert.match(prompt, /recent activity\/session\/history/);
});
