import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn } from '../src/agent/agent.js';
import type { AppConfig } from '../src/config/types.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';
import { ProjectMemoryStore } from '../src/memory/store.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

test('ordinary agent turn injects relevant project memory into the prompt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-agent-memory-'));
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 2, noBanner: true };
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });

  // Seed a project memory that should surface for a prompt about database code.
  const memory = new ProjectMemoryStore(workspace);
  await memory.add({ kind: 'convention', summary: 'Always use parameterized SQL queries for the database layer.', keywords: ['database', 'sql', 'query'], source: { type: 'user' } });

  let capturedContext: string | undefined;
  let capturedMessages: ProviderRequest['messages'] = [];
  const provider: Provider = {
    name: 'mock',
    model: 'mock-code-agent-v1',
    async complete(request: ProviderRequest) {
      capturedContext = request.projectContext;
      capturedMessages = request.messages;
      return { actions: [{ type: 'message', content: 'ok' }] };
    },
  };

  const result = await runAgentTurn(
    { config, provider, tools: createDefaultToolRegistry(), sessions, session, memory, ui: new TerminalUI(true) },
    'How should I write the database query layer?',
  );

  assert.equal(result.ok, true);
  // Cache-stable layout: the project context (system-side) must stay free of
  // per-session memory, and relevant memory is injected as a message instead.
  assert.doesNotMatch(capturedContext ?? '', /parameterized SQL/);
  const memoryInjected = capturedMessages.some(
    (message) => typeof message.content === 'string' && message.content.includes('parameterized SQL'),
  );
  assert.ok(memoryInjected, 'relevant project memory should be injected into the model messages');

  await rm(workspace, { recursive: true, force: true });
});

test('successful agent turn auto-records a useful final answer into memory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-agent-mem-record-'));
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 2, noBanner: true };
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
  const memory = new ProjectMemoryStore(workspace);

  const provider: Provider = {
    name: 'mock',
    model: 'mock-code-agent-v1',
    async complete() {
      return { actions: [{ type: 'message', content: 'You must always use parameterized queries for database access.' }] };
    },
  };

  const result = await runAgentTurn(
    { config, provider, tools: createDefaultToolRegistry(), sessions, session, memory, ui: new TerminalUI(true) },
    'database query best practice',
  );
  assert.equal(result.ok, true);

  // recordTurnMemory is fire-and-forget; poll briefly instead of sleeping a
  // fixed amount so the assertion is robust under parallel test load.
  let entries = await memory.list();
  const deadline = Date.now() + 2000;
  while (entries.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    entries = await memory.list();
  }

  assert.ok(entries.length >= 1, 'at least one memory entry should be recorded');
  assert.ok(entries.some((e) => e.summary.includes('parameterized queries')));

  await rm(workspace, { recursive: true, force: true });
});

test('short or trivial final answers are not recorded as memory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-agent-mem-trivial-'));
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 2, noBanner: true };
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
  const memory = new ProjectMemoryStore(workspace);

  const provider: Provider = {
    name: 'mock',
    model: 'mock-code-agent-v1',
    async complete() { return { actions: [{ type: 'message', content: 'ok' }] }; },
  };

  await runAgentTurn(
    { config, provider, tools: createDefaultToolRegistry(), sessions, session, memory, ui: new TerminalUI(true) },
    'hello',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  const entries = await memory.list();
  assert.equal(entries.length, 0, 'trivial "ok" answer should not be recorded');

  await rm(workspace, { recursive: true, force: true });
});

test('empty memory store leaks no memory block into the prompt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-agent-memory-empty-'));
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 2, noBanner: true };
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
  const memory = new ProjectMemoryStore(workspace);

  let capturedContext: string | undefined;
  const provider: Provider = {
    name: 'mock',
    model: 'mock-code-agent-v1',
    async complete(request: ProviderRequest) {
      capturedContext = request.projectContext;
      return { actions: [{ type: 'message', content: 'ok' }] };
    },
  };

  await runAgentTurn(
    { config, provider, tools: createDefaultToolRegistry(), sessions, session, memory, ui: new TerminalUI(true) },
    'hello',
  );

  // No memories seeded → no memory block leaks into the context.
  assert.doesNotMatch(capturedContext ?? '', /项目记忆|Project memory/i);

  await rm(workspace, { recursive: true, force: true });
});
