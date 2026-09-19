import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn, type AgentRuntime } from '../src/agent/agent.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { TerminalUI } from '../src/ui/terminal.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';

test('parallelSafe read actions run concurrently but append records in action order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-parallel-read-'));
  const sessionDir = join(root, 'sessions');
  let active = 0;
  let maxActive = 0;
  const executionOrder: string[] = [];
  const makeTool = (name: string, parallelSafe?: boolean): ToolDefinition<{ id: string }> => ({
    name,
    description: name,
    inputHint: '{}',
    risk: 'read',
    parallelSafe,
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('expected object');
      return input as { id: string };
    },
    async execute(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, input.id === 'first' ? 25 : 5));
      active -= 1;
      executionOrder.push(input.id);
      return { ok: true, output: input.id };
    },
  });
  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete() {
      return {
        actions: [
          { type: 'tool', tool: 'safe_read_a', input: { id: 'first' }, callId: 'call-first' },
          { type: 'tool', tool: 'safe_read_b', input: { id: 'second' }, callId: 'call-second' },
          { type: 'tool', tool: 'unsafe_read', input: { id: 'third' }, callId: 'call-third' },
        ],
      };
    },
  };

  try {
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'openai', model: 'test-model', workspaceRoot: root });
    const tools = ToolRegistry.fromTools([
      makeTool('safe_read_a', true),
      makeTool('safe_read_b', true),
      makeTool('unsafe_read'),
    ]);
    const result = await runAgentTurn({
      config: {
        provider: 'openai', model: 'test-model', approval: 'auto', workspaceRoot: root, sessionDir,
        maxSteps: 1, noBanner: true, quiet: true,
        toolScope: 'full',      },
      provider,
      tools,
      sessions,
      session,
      ui: new TerminalUI({ quiet: true }),
    }, 'inspect files');

    assert.equal(result.ok, false);
    assert.equal(maxActive, 2);
    assert.deepEqual(executionOrder.slice(0, 2).sort(), ['first', 'second']);
    assert.deepEqual(session.toolCalls.map((call) => call.tool), ['safe_read_a', 'safe_read_b', 'unsafe_read']);
    assert.deepEqual(session.toolCalls.map((call) => call.providerCallId), ['call-first', 'call-second', 'call-third']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('create_docx success stops the agent loop instead of re-calling the tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-docx-loop-'));
  const sessionDir = join(root, 'sessions');
  const fileName = `loop-once-${Date.now()}.docx`;
  let providerTurns = 0;

  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete(_request: ProviderRequest) {
      providerTurns += 1;
      // Keep trying to create forever if the agent loop does not stop.
      return {
        actions: [
          {
            type: 'tool',
            tool: 'create_docx',
            input: {
              path: `desktop/${fileName}`,
              title: 'once',
              body: 'should only create once',
            },
          },
        ],
      };
    },
  };

  try {
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({
      provider: 'openai',
      model: 'test-model',
      workspaceRoot: root,
    });
    const runtime: AgentRuntime = {
      config: {
        provider: 'openai',
        model: 'test-model',
        approval: 'auto',
        workspaceRoot: root,
        sessionDir,
        maxSteps: 8,
        noBanner: true,
        quiet: true,
      },
      provider,
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI({ quiet: true }),
      locale: 'zh',
    };

    const result = await runAgentTurn(runtime, '写个word放到桌面');
    assert.equal(result.ok, true);
    // One provider turn is enough; must not burn maxSteps re-creating.
    assert.equal(providerTurns, 1);
    assert.equal(session.toolCalls.filter((call) => call.tool === 'create_docx').length, 1);
    assert.match(result.finalAnswer ?? '', /已完成|Created Word document|Word 文档/);

    const desktopPath = join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', fileName);
    await access(desktopPath);
    await rm(desktopPath, { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('duplicate create_docx with same path is skipped after success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-docx-dup-'));
  const sessionDir = join(root, 'sessions');
  const fileName = `loop-dup-${Date.now()}.docx`;
  let providerTurns = 0;

  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete() {
      providerTurns += 1;
      if (providerTurns === 1) {
        return {
          actions: [
            {
              type: 'tool',
              tool: 'create_docx',
              input: { path: `desktop/${fileName}`, title: 'a', body: '1' },
            },
            {
              type: 'tool',
              tool: 'create_docx',
              input: { path: `desktop/${fileName}`, title: 'a', body: '1' },
            },
          ],
        };
      }
      return { actions: [{ type: 'message', content: 'should not reach second model turn' }] };
    },
  };

  try {
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({
      provider: 'openai',
      model: 'test-model',
      workspaceRoot: root,
    });
    const result = await runAgentTurn(
      {
        config: {
          provider: 'openai',
          model: 'test-model',
          approval: 'auto',
          workspaceRoot: root,
          sessionDir,
          maxSteps: 6,
          noBanner: true,
          quiet: true,
        },
        provider,
        tools: createDefaultToolRegistry(),
        sessions,
        session,
        ui: new TerminalUI({ quiet: true }),
        locale: 'zh',
      },
      '创建 word',
    );
    assert.equal(result.ok, true);
    assert.equal(providerTurns, 1);
    // Only one real execution; second action skipped as duplicate.
    assert.equal(session.toolCalls.filter((call) => call.tool === 'create_docx' && call.ok).length, 1);
    await rm(join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', fileName), { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
