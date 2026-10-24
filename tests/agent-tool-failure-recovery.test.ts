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
 * another path. A user cancel is terminal — retrying a stop request is nonsense.
 * A policy block is not: it usually means the model reached for the shell where a
 * dedicated tool does the same job, so it gets one attempt at an alternative and
 * ends the turn if the next call is blocked too. Chasing blocked variants for
 * longer stops being a correction and starts being a probe of the policy.
 *
 * These tests pin those distinctions.
 */

/**
 * Each test gets its own tool NAME on purpose: the tool circuit breaker
 * (`globalToolHealth`) is process-wide, so a single fixture name reused across
 * these tests would still be cooling down from the previous test's failures and
 * the call would be refused before it ever reached the failure under test.
 */
function failingTool(name: string, message: string, ok = false): ToolDefinition<Record<string, never>> {
  return {
    name,
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
        return { actions: [{ type: 'tool', tool: 'fails_plain', input: {}, callId: 'c1' }] };
      }
      // Second step: the model must get the chance to react to the failure.
      return { actions: [{ type: 'message', content: 'Recovered: used another path.' }] };
    },
  };

  try {
    const runtime = await makeRuntime(root, provider, failingTool('fails_plain', 'read_file failed: no such file'));
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
        return { actions: [{ type: 'tool', tool: 'fails_denied', input: {}, callId: 'c1' }] };
      }
      return { actions: [{ type: 'message', content: 'Alternative proposed.' }] };
    },
  };

  try {
    const runtime = await makeRuntime(root, provider, failingTool('fails_denied', 'Tool fails_denied cancelled by user'));
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
        return { actions: [{ type: 'tool', tool: 'fails_escape', input: {}, callId: 'c1' }] };
      }
      return { actions: [{ type: 'message', content: 'Retried with an in-workspace path.' }] };
    },
  };

  try {
    const runtime = await makeRuntime(
      root,
      provider,
      failingTool('fails_escape', 'Tool read_file failed: Path escapes workspace: ../other-pkg/README.md'),
    );
    const result = await runAgentTurn(runtime, 'read the sibling package readme');
    assert.equal(calls, 2, 'a path escape must not end the turn');
    assert.equal(result.ok, true);
    assert.match(String(result.finalAnswer ?? ''), /in-workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a policy block gets one attempt at an alternative, then ends the turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-recover-blocked-'));
  let calls = 0;
  const hints: string[] = [];
  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete(request: ProviderRequest) {
      calls += 1;
      const last = request.messages.at(-1);
      if (typeof last?.content === 'string' && last.content.includes('<tool-blocked')) hints.push(last.content);
      return { actions: [{ type: 'tool', tool: 'fails_blocked', input: {}, callId: `c${calls}` }] };
    },
  };

  try {
    const runtime = await makeRuntime(root, provider, failingTool('fails_blocked', 'Tool fails_blocked blocked: read-only tool'));
    const result = await runAgentTurn(runtime, 'do the thing');
    assert.equal(result.ok, false);
    assert.equal(calls, 2, 'one retry after a block, then the turn stops');
    assert.equal(hints.length, 1, 'the model was told why it was blocked, once');
    // The instruction must forbid circumvention and name the tools that do the
    // job legitimately — that is the whole recovery path for a block. The
    // wording follows the runtime locale, so match either language.
    assert.match(hints[0] ?? '', /不要绕过拦截|Do not evade the block/);
    assert.match(hints[0] ?? '', /read_file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a block is recoverable when the model switches to a dedicated tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-recover-blocked-alt-'));
  let calls = 0;
  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete() {
      calls += 1;
      if (calls === 1) {
        return { actions: [{ type: 'tool', tool: 'run_command', input: { command: 'type secret.env' }, callId: 'c1' }] };
      }
      if (calls === 2) {
        return { actions: [{ type: 'tool', tool: 'read_file', input: { path: 'package.json' }, callId: 'c2' }] };
      }
      // The model finishes once it has the content — without this step the
      // provider would keep re-issuing the same successful read, which the
      // stuck-step guard treats as a stall (its own test covers that path).
      return { actions: [{ type: 'message', content: 'Config read through read_file.' }] };
    },
  };

  const tools: ToolDefinition<Record<string, unknown>>[] = [
    {
      name: 'run_command',
      description: 'blocked by policy',
      inputHint: '{"command":"string"}',
      risk: 'shell',
      validate: (input) => (input ?? {}) as Record<string, unknown>,
      execute: async () => ({ ok: false, output: 'Blocked: command is not in the auto approval allowlist' }),
    },
    {
      name: 'read_file',
      description: 'reads a file',
      inputHint: '{"path":"string"}',
      risk: 'read',
      validate: (input) => (input ?? {}) as Record<string, unknown>,
      execute: async () => ({ ok: true, output: '{"name":"fixture"}' }),
    },
  ];

  try {
    const sessions = new SessionStore(join(root, 'sessions'));
    const session = await sessions.create({ provider: 'openai', model: 'test-model', workspaceRoot: root });
    const runtime: AgentRuntime = {
      config: { workspaceRoot: root, approval: 'auto', maxSteps: 8, provider: 'openai', model: 'test-model', sessionDir: join(root, 'sessions') },
      provider,
      session,
      sessions,
      tools: ToolRegistry.fromTools(tools),
      ui: new TerminalUI({ quiet: true }),
      toolScope: 'full',
    } as unknown as AgentRuntime;
    const result = await runAgentTurn(runtime, 'read the config by an allowed route');
    assert.equal(calls, 3, 'the block must not end the turn before the model can switch tools');
    assert.equal(result.ok, true, JSON.stringify(result.reason ?? ''));
    const toolsCalled = session.toolCalls.map((call) => `${call.tool}:${call.ok}`);
    assert.deepEqual(toolsCalled, ['run_command:false', 'read_file:true']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
