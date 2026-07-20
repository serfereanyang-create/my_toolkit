import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn } from '../src/agent/agent.js';
import { formatProjectContext, readProjectContext } from '../src/agent/context.js';
import type { AppConfig } from '../src/config/types.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

test('project context cache keeps stable cache key until instruction files change', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-context-cache-'));
  await writeFile(join(workspace, 'AGENTS.md'), 'Prefer direct answers.');

  const first = await readProjectContext(workspace);
  const second = await readProjectContext(workspace);

  assert.equal(first?.cacheKey, second?.cacheKey);
  assert.match(formatProjectContext(first) ?? '', /cacheKey=/);

  await writeFile(join(workspace, 'AGENTS.md'), 'Prefer direct answers. Use tools for facts.');
  const third = await readProjectContext(workspace);
  assert.notEqual(first?.cacheKey, third?.cacheKey);

  await rm(workspace, { recursive: true, force: true });
});

test('agent continues after recoverable tool failure so the model can recover', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-recover-'));
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 4, noBanner: true };
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
  let calls = 0;
  const provider: Provider = {
    name: 'mock',
    model: 'mock-code-agent-v1',
    async complete() {
      calls += 1;
      if (calls === 1) return { actions: [{ type: 'tool', tool: 'git_log', input: {} }] };
      return { actions: [{ type: 'message', content: 'Recovered after failed git_log.' }] };
    },
  };

  const result = await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, 'recover');

  assert.equal(result.ok, true);
  assert.equal(session.toolCalls[0]?.ok, false);
  assert.match(session.finalAnswers.at(-1) ?? '', /Recovered/);

  await rm(workspace, { recursive: true, force: true });
});

test('agent passes formatted tool strategy to provider requests', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-tool-strategy-'));

  try {
    const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 4, noBanner: true };
    const sessions = new SessionStore(config.sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
    const capturedRequests: ProviderRequest[] = [];
    const provider: Provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete(request) {
        capturedRequests.push(request);
        if (capturedRequests.length === 1) {
          return { actions: [{ type: 'tool', tool: 'project_index', input: { path: '.', maxFiles: 10 } }] };
        }
        return { actions: [{ type: 'message', content: 'Done.' }] };
      },
    };

    await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, '修复登录按钮问题');

    assert.equal(capturedRequests.length, 2);
    assert.ok(capturedRequests.every((request) => (request.toolStrategy?.length ?? 0) > 0));
    assert.ok(capturedRequests.every((request) => request.toolStrategy === capturedRequests[0].toolStrategy));
    assert.match(capturedRequests[0].toolStrategy ?? '', /intent=code_edit/);
    assert.match(capturedRequests[0].toolStrategy ?? '', /recommended=project_index, search_text, read_file/);
    assert.equal(session.toolCalls[0]?.tool, 'project_index');
    assert.equal(session.toolCalls[0]?.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('agent records specific recovery hints after recoverable tool failure', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-recovery-hint-'));

  try {
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    let calls = 0;
    const provider: Provider = {
      name: 'mock',
      model: 'mock',
      async complete() {
        calls += 1;
        if (calls === 1) return { actions: [{ type: 'tool', tool: 'read_file', input: { path: 'missing.ts' } }] };
        return { actions: [{ type: 'message', content: 'recovered' }] };
      },
    };
    const config: AppConfig = { provider: 'mock', model: 'mock', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 3, noBanner: true };

    const result = await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, '读取 missing.ts');

    assert.equal(result.ok, true);
    assert.equal(session.toolCalls[0]?.ok, false);
    const toolMessage = session.messages.find((message) => message.role === 'tool' && message.content.includes('Recovery hint:'));
    assert.ok(toolMessage);
    assert.match(toolMessage.content, /locate the correct path/);
    assert.equal(session.toolCalls[0]?.output, toolMessage.content);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
