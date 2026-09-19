import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn, type AgentRuntime } from '../src/agent/agent.js';
import { SessionStore } from '../src/session/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { TerminalUI } from '../src/ui/terminal.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';

/*
 * Recovery behaviour when a tool call fails.
 *
 * The agent must treat an ordinary tool failure as information, not as the end
 * of the turn: it should feed the error back to the model and let it try
 * another path. Only failures that are genuinely terminal — a user cancel, or
 * a policy block — may end the turn, because retrying those is pointless.
 *
 * These tests pin that distinction.
 */

function failingTool(message: string, ok = false): ToolDefinition<Record<string, never>> {
  return {
    name: 'always_fails',
    description: 'always fails',
    inputHint: '{}',
    risk: 'read',
    validate(input) {
      return (input ?? {}) as Record<string, never>;
    },
    async execute() {
      return ok ? { ok: true, output: 'fine' } : { ok: false, output: message };
    },
  };
}

async function makeRuntime(root: string, provider: Provider, tool: ToolDefinition<Record<string, never>>) {
  const sessions = new SessionStore(join(root, 'sessions'));
  const session = await sessions.create({ provider: 'openai', model: 'test-model', workspaceRoot: root });
  const runtime: AgentRuntime = {
    config: { workspaceRoot: root, approval: 'auto', maxSteps: 8, provider: 'openai', model: 'test-model', sessionDir: join(root, 'sessions') },
    provider,
    session,
    sessions,
    tools: ToolRegistry.fromTools([tool]),
    ui: new TerminalUI({ quiet: true }),
    // Tool scope must be 'full', otherwise scope selection filters the custom
    // tool out of the registry and every call returns "Unknown tool" — which is
    // not a failure at all, making the test silently meaningless.
    toolScope: 'full',
  } as unknown as AgentRuntime;
  return runtime;
}

test('an ordinary tool failure does not end the turn; the model gets another step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-recover-'));
  let calls = 0;
  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete(_request: ProviderRequest) {
      calls += 1;
      if (calls === 1) {
        // First step: try something that fails.
        return { actions: [{ type: 'tool', tool: 'always_fails', input: {}, callId: 'c1' }] };
      }
      // Second step: the model must get the chance to react to the failure.
      return { actions: [{ type: 'message', content: 'Recovered: used another path.' }] };
    },
  };

  try {
    const runtime = await makeRuntime(root, provider, failingTool('read_file failed: no such file'));
    const result = await runAgentTurn(runtime, 'do the thing');
    assert.equal(calls, 2, 'the model must be called again after a recoverable failure');
    assert.equal(result.ok, true);
    assert.match(String(result.finalAnswer ?? ''), /Recovered/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a user-denied approval is reported but does not silently kill the turn', async () => {
  // Denying one approval means "not that way", not "abandon the task": the
  // model should be able to propose an alternative.
  const root = await mkdtemp(join(tmpdir(), 'aicode-recover-deny-'));
  let calls = 0;
  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete() {
      calls += 1;
      if (calls === 1) {
        return { actions: [{ type: 'tool', tool: 'always_fails', input: {}, callId: 'c1' }] };
      }
      return { actions: [{ type: 'message', content: 'Alternative proposed.' }] };
    },
  };

  try {
    const runtime = await makeRuntime(root, provider, failingTool('Tool always_fails cancelled by user'));
    const result = await runAgentTurn(runtime, 'do the thing');
    assert.equal(calls, 2, 'a denial must not end the turn');
    assert.match(String(result.finalAnswer ?? ''), /Alternative/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * Regression: reaching outside the workspace is an input mistake, not a policy
 * verdict. It used to be classified as a block, which ended the turn outright —
 * an agent that tried to read `../other-pkg/README.md` just stopped instead of
 * correcting the path.
 */
test('a path escape does not end the turn; the model gets to retry in-workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-recover-escape-'));
  let calls = 0;
  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete() {
      calls += 1;
      if (calls === 1) {
        return { actions: [{ type: 'tool', tool: 'always_fails', input: {}, callId: 'c1' }] };
      }
      return { actions: [{ type: 'message', content: 'Retried with an in-workspace path.' }] };
    },
  };

  try {
    const runtime = await makeRuntime(
      root,
      provider,
      failingTool('Tool read_file failed: Path escapes workspace: ../other-pkg/README.md'),
    );
    const result = await runAgentTurn(runtime, 'read the sibling package readme');
    assert.equal(calls, 2, 'a path escape must not end the turn');
    assert.equal(result.ok, true);
    assert.match(String(result.finalAnswer ?? ''), /in-workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a policy-blocked tool still stops the turn, since retrying cannot help', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-recover-blocked-'));
  let calls = 0;
  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete() {
      calls += 1;
      return { actions: [{ type: 'tool', tool: 'always_fails', input: {}, callId: 'c1' }] };
    },
  };

  try {
    const runtime = await makeRuntime(root, provider, failingTool('Tool always_fails blocked: read-only tool'));
    const result = await runAgentTurn(runtime, 'do the thing');
    assert.equal(result.ok, false);
    assert.equal(calls, 1, 'a blocked tool ends the turn immediately');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
