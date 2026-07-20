import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRuntime } from '../src/agent/agent.js';
import { runPromptMode } from '../src/cli/repl.js';
import type { AppConfig } from '../src/config/types.js';
import { createInitialLazyDevGuardState } from '../src/guard/config.js';
import type { AgentAction, Provider, ProviderRequest } from '../src/providers/types.js';
import { SessionStore } from '../src/session/store.js';
import { ToolRegistry, type ToolContext, type ToolDefinition, type ToolResult } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

type Fixture = {
  workspace: string;
  providerCalls: ProviderRequest[];
  toolCalls: Array<{ input: unknown; context: ToolContext }>;
  runtime: AgentRuntime;
  cleanup: () => Promise<void>;
};

async function createFixture(actions: AgentAction[] = [{ type: 'message', content: 'provider reached' }]): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-lazy-integration-'));
  const sessionDir = join(workspace, '.aicode', 'sessions');
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir,
    prompt: '',
    maxSteps: 4,
    noBanner: true,
  };
  const providerCalls: ProviderRequest[] = [];
  const toolCalls: Array<{ input: unknown; context: ToolContext }> = [];
  const provider: Provider = {
    name: 'mock',
    model: config.model,
    async complete(request) {
      providerCalls.push(request);
      return { actions };
    },
  };
  const tools = new ToolRegistry();
  tools.register(createSpyTool(toolCalls));
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
  session.guard = { lazyDev: createInitialLazyDevGuardState() };
  await sessions.save(session);

  return {
    workspace,
    providerCalls,
    toolCalls,
    runtime: {
      config,
      provider,
      tools,
      sessions,
      session,
      ui: new TerminalUI({ quiet: true, noColor: true }),
    },
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

function createSpyTool(calls: Array<{ input: unknown; context: ToolContext }>): ToolDefinition {
  return {
    name: 'spy_tool',
    description: 'Records calls for lazy dev guard integration tests.',
    inputHint: '{}',
    risk: 'read',
    validate(input: unknown) {
      return input;
    },
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      calls.push({ input, context });
      return { ok: true, output: 'spy ok' };
    },
  };
}

async function loadSavedLazyDev(fixture: Fixture) {
  return (await fixture.runtime.sessions.load(fixture.runtime.session.id)).guard?.lazyDev;
}

function latestUserMessage(request: ProviderRequest): string | undefined {
  return request.messages.filter((message) => message.role === 'user').at(-1)?.content;
}

test('prompt mode passes non-development chat through without creating requirement', async () => {
  const fixture = await createFixture([]);
  try {
    const result = await runPromptMode(fixture.runtime, '你好');
    const saved = await loadSavedLazyDev(fixture);

    assert.equal(result.ok, true);
    assert.equal(fixture.providerCalls.length, 1);
    assert.equal(latestUserMessage(fixture.providerCalls.at(-1)!), '你好');
    assert.equal(fixture.runtime.session.guard?.lazyDev?.currentRequirement, undefined);
    assert.equal(saved?.currentRequirement, undefined);
    assert.equal(saved?.metrics.totalChecks, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('prompt mode guard blocks development before provider and tools', async () => {
  const fixture = await createFixture([{ type: 'tool', tool: 'spy_tool', input: {} }, { type: 'message', content: 'done' }]);
  try {
    const result = await runPromptMode(fixture.runtime, '做一个保存按钮，失败时提醒用户');
    const saved = await loadSavedLazyDev(fixture);

    assert.equal(result.ok, true);
    assert.equal(fixture.providerCalls.length, 0);
    assert.equal(fixture.toolCalls.length, 0);
    assert.deepEqual(fixture.runtime.session.toolCalls, []);
    assert.deepEqual(fixture.runtime.session.finalAnswers, []);
    assert.equal(fixture.runtime.session.guard?.lazyDev?.currentRequirement?.status, 'awaiting_translation_confirm');
    assert.equal(saved?.currentRequirement?.status, 'awaiting_translation_confirm');
  } finally {
    await fixture.cleanup();
  }
});

test('prompt mode enters development allow path after low-risk translation confirmation', async () => {
  const fixture = await createFixture([]);
  const originalPrompt = '写一个 hello world demo';
  try {
    await runPromptMode(fixture.runtime, originalPrompt);
    const result = await runPromptMode(fixture.runtime, 'A');
    const saved = await loadSavedLazyDev(fixture);

    assert.equal(result.ok, true);
    assert.equal(fixture.providerCalls.length, 1);
    assert.equal(latestUserMessage(fixture.providerCalls.at(-1)!), originalPrompt);
    assert.notEqual(latestUserMessage(fixture.providerCalls.at(-1)!), 'A');
    assert.equal(fixture.runtime.session.guard?.lazyDev?.currentRequirement?.status, 'passed');
    assert.equal(saved?.currentRequirement?.status, 'passed');
  } finally {
    await fixture.cleanup();
  }
});

test('prompt mode enters development with original requirement after correct guard answer', async () => {
  const fixture = await createFixture([]);
  const originalPrompt = '做一个保存按钮，失败时提醒用户';
  const correctAnswer = '用户会看到失败原因和重试提示';
  try {
    await runPromptMode(fixture.runtime, originalPrompt);
    await runPromptMode(fixture.runtime, 'A');
    const result = await runPromptMode(fixture.runtime, correctAnswer);
    const saved = await loadSavedLazyDev(fixture);

    assert.equal(result.ok, true);
    assert.equal(fixture.providerCalls.length, 1);
    assert.equal(latestUserMessage(fixture.providerCalls.at(-1)!), originalPrompt);
    assert.notEqual(latestUserMessage(fixture.providerCalls.at(-1)!), correctAnswer);
    assert.equal(fixture.runtime.session.guard?.lazyDev?.currentRequirement?.status, 'passed');
    assert.equal(saved?.currentRequirement?.status, 'passed');
  } finally {
    await fixture.cleanup();
  }
});

test('prompt mode does not call tools after wrong guard answer', async () => {
  const fixture = await createFixture([{ type: 'tool', tool: 'spy_tool', input: {} }, { type: 'message', content: 'done' }]);
  try {
    await runPromptMode(fixture.runtime, '做一个保存按钮，失败时提醒用户');
    await runPromptMode(fixture.runtime, 'A');
    const result = await runPromptMode(fixture.runtime, 'B');
    const saved = await loadSavedLazyDev(fixture);

    assert.equal(result.ok, true);
    assert.equal(fixture.providerCalls.length, 0);
    assert.equal(fixture.toolCalls.length, 0);
    assert.deepEqual(fixture.runtime.session.toolCalls, []);
    assert.equal(fixture.runtime.session.guard?.lazyDev?.currentRequirement?.status, 'checking');
    assert.equal(saved?.currentRequirement?.status, 'checking');
  } finally {
    await fixture.cleanup();
  }
});
