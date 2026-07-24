import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn, type AgentRuntime } from '../src/agent/agent.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';

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
