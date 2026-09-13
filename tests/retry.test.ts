import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { retryLastUserTurn, runPromptMode } from '../src/cli/repl.js';
import { runAgentTurn } from '../src/agent/agent.js';
import type { AppConfig } from '../src/config/types.js';
import type { AgentMessage, Provider, ProviderRequest } from '../src/providers/types.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

function lastUserContent(request: ProviderRequest): string {
  const message = [...request.messages].reverse().find((item): item is AgentMessage => item.role === 'user');
  return message?.content ?? '';
}

function lastUserParts(request: ProviderRequest): AgentMessage['parts'] {
  const message = [...request.messages].reverse().find((item): item is AgentMessage => item.role === 'user');
  return message?.parts;
}

function makeConfig(workspace: string): AppConfig {
  return {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    maxSteps: 2,
    noBanner: true,
    quiet: true,
    json: true,
  };
}

function makeRuntime(config: AppConfig, sessions: SessionStore, session: Awaited<ReturnType<SessionStore['create']>>, provider: Provider) {
  return {
    config,
    provider,
    tools: createDefaultToolRegistry(),
    sessions,
    session,
    ui: new TerminalUI({ quiet: true, json: true, noColor: true }),
  } as Parameters<typeof runAgentTurn>[0];
}

test('retry re-executes the persisted last user turn', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-retry-success-'));
  const config = makeConfig(workspace);
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: 'mock', model: config.model, workspaceRoot: workspace });
  let calls = 0;
  const prompts: string[] = [];
  const provider: Provider = {
    name: 'mock', model: config.model,
    async complete(request: ProviderRequest) {
      calls += 1;
      prompts.push(lastUserContent(request));
      return { actions: [{ type: 'message', content: `answer-${calls}` }] };
    },
  };
  const runtime = makeRuntime(config, sessions, session, provider);

  await runAgentTurn(runtime, 'original prompt', { displayText: 'Original prompt' });
  const result = await retryLastUserTurn(runtime);

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(prompts, ['original prompt', 'original prompt']);
  assert.equal(session.lastTurn?.prompt, 'original prompt');
  assert.equal(session.lastTurn?.status, 'done');
  assert.ok(session.messages.filter((message) => message.role === 'user' && message.content === 'original prompt').length >= 2);
  await rm(workspace, { recursive: true, force: true });
});

test('retry uses original prompt after a failed turn and clears continuation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-retry-failed-'));
  const config = makeConfig(workspace);
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: 'mock', model: config.model, workspaceRoot: workspace });
  let calls = 0;
  const prompts: string[] = [];
  const provider: Provider = {
    name: 'mock', model: config.model,
    async complete(request: ProviderRequest) {
      calls += 1;
      prompts.push(lastUserContent(request));
      if (calls === 1) throw new Error('temporary failure');
      return { actions: [{ type: 'message', content: 'recovered' }] };
    },
  };
  const runtime = makeRuntime(config, sessions, session, provider);

  const failed = await runAgentTurn(runtime, 'keep this prompt');
  assert.equal(failed.ok, false);
  assert.equal(session.lastTurn?.status, 'failed');
  session.providerContinuation = { responseId: 'stale-response', status: 'pending' };
  const result = await retryLastUserTurn(runtime);

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(prompts, ['keep this prompt', 'keep this prompt']);
  assert.equal(session.providerContinuation, undefined);
  assert.equal(session.lastTurn?.status, 'done');
  await rm(workspace, { recursive: true, force: true });
});

test('retry preserves multimodal parts and works through prompt mode', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-retry-parts-'));
  const config = makeConfig(workspace);
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: 'mock', model: config.model, workspaceRoot: workspace });
  const seenParts: Array<AgentMessage['parts']> = [];
  const provider: Provider = {
    name: 'mock', model: config.model,
    async complete(request: ProviderRequest) {
      seenParts.push(lastUserParts(request));
      return { actions: [{ type: 'message', content: 'ok' }] };
    },
  };
  const runtime = makeRuntime(config, sessions, session, provider);
  const parts = [
    { type: 'text' as const, text: 'look at this' },
    { type: 'image' as const, mediaType: 'image/png', data: 'aGVsbG8=', path: 'image.png' },
  ];

  await runAgentTurn(runtime, 'look at this', { parts, displayText: 'look at this (+1 attachment)' });
  const result = await runPromptMode(runtime, '/retry');

  assert.equal(result.ok, true);
  assert.equal(seenParts.length, 2);
  assert.deepEqual(seenParts[1], parts);
  assert.deepEqual(session.lastTurn?.parts, parts);
  await rm(workspace, { recursive: true, force: true });
});

test('retry on an empty session is a no-op', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-retry-empty-'));
  const config = makeConfig(workspace);
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: 'mock', model: config.model, workspaceRoot: workspace });
  let calls = 0;
  const provider: Provider = {
    name: 'mock', model: config.model,
    async complete() { calls += 1; return { actions: [{ type: 'message', content: 'unexpected' }] }; },
  };
  const runtime = makeRuntime(config, sessions, session, provider);

  const result = await runPromptMode(runtime, '/retry');
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
  assert.equal(result.reason, 'nothing-to-retry');
  await rm(workspace, { recursive: true, force: true });
});
