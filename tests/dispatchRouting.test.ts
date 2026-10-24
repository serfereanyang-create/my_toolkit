import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn, type AgentRuntime } from '../src/agent/agent.js';
import { SessionStore } from '../src/session/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { classifyModelTier, deriveTiers } from '../src/dispatch/tierCatalog.js';
import { pickStepTier } from '../src/dispatch/stepRouter.js';
import { createDispatchPlan } from '../src/dispatch/plan.js';
import { loadConfig } from '../src/config/config.js';
import type { CliArgs } from '../src/config/types.js';

/*
 * Per-call tier dispatch.
 *
 * Two things are being pinned here, and they fail for different reasons:
 *
 *   1. The POLICY — which model id belongs to which tier, and which tier a given
 *      call runs on. Pure functions, so every branch is cheap to test.
 *   2. The WIRING — that a real turn actually switches provider between calls.
 *      That is the part that silently rots: the router can be perfect while the
 *      loop keeps calling the same model.
 */

test('classifyModelTier: cheap markers win, flagship generations are expensive', () => {
  // Cheap wins ties: a small variant of a flagship generation is still cheap.
  assert.equal(classifyModelTier('glm-5.3-flash'), 'cheap');
  assert.equal(classifyModelTier('gpt-5.5-mini'), 'cheap');
  assert.equal(classifyModelTier('claude-3-5-haiku'), 'cheap');
  assert.equal(classifyModelTier('qwen-turbo'), 'cheap');
  // Expensive: reasoning models and the top-end of a family.
  assert.equal(classifyModelTier('deepseek-v4-pro'), 'expensive');
  assert.equal(classifyModelTier('claude-opus-4'), 'expensive');
  assert.equal(classifyModelTier('glm-5.3'), 'expensive');
  assert.equal(classifyModelTier('gpt-5.5'), 'expensive');
  assert.equal(classifyModelTier('deepseek-r1-reasoner'), 'expensive');
  // Everything else is the working default, not a guess at either extreme.
  assert.equal(classifyModelTier('kimi-k2'), 'standard');
  assert.equal(classifyModelTier(''), 'standard');
});

test('pickStepTier: the rule table, branch by branch', () => {
  const base = { planning: false, complexity: 'standard' as const, step: 1, stepBudget: undefined as number | undefined, ranTool: false, lastStepFailed: false, consecutiveFailures: 0 };

  // Planning buys judgement: a plan is the cheapest place to spend the top model.
  assert.equal(pickStepTier({ ...base, planning: true, step: 0 }), 'expensive');

  // Step 0 is scaled to the task: a one-line question does not need the flagship.
  assert.equal(pickStepTier({ ...base, step: 0, complexity: 'small' }), 'cheap');
  assert.equal(pickStepTier({ ...base, step: 0, complexity: 'standard' }), 'standard');
  assert.equal(pickStepTier({ ...base, step: 0, complexity: 'large' }), 'expensive');

  // Follow-through on a tool result is the mechanical half, and the bulk of calls.
  assert.equal(pickStepTier({ ...base, ranTool: true }), 'cheap');

  // A failure escalates one rung, then goes to the top: repeating the same model
  // that just failed is not a recovery strategy.
  assert.equal(pickStepTier({ ...base, lastStepFailed: true, consecutiveFailures: 1 }), 'standard');
  assert.equal(pickStepTier({ ...base, lastStepFailed: true, consecutiveFailures: 2 }), 'expensive');

  // The last budgeted call is what the user reads: never a rushed cheap summary.
  assert.equal(pickStepTier({ ...base, step: 2, stepBudget: 3, ranTool: true }), 'expensive');

  // Nothing special: standard.
  assert.equal(pickStepTier(base), 'standard');
});

test('deriveTiers: groups the configured models, keyed providers only, active model pinned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-tiers-'));
  try {
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      provider: {
        keyed: {
          name: 'Keyed', kind: 'openai', enabled: true,
          options: { apiKey: 'k', baseURL: 'http://127.0.0.1:1' },
          models: { 'glm-5.3': {}, 'glm-5.3-flash': {} },
        },
        keyless: {
          name: 'Keyless', kind: 'openai', enabled: true,
          options: {},
          models: { 'deepseek-v4-pro': {} },
        },
      },
    }), 'utf8');

    const derived = deriveTiers({ activeModel: 'glm-5.3-flash', configPath });
    assert.ok(derived, 'two credentialed models in two tiers is enough to derive');
    // The keyless provider is skipped: dispatching to it fails auth at request
    // time, which is worse than not routing at all.
    assert.equal(derived.tiers.expensive?.[0]?.model, 'glm-5.3');
    assert.equal(derived.tiers.cheap?.[0]?.model, 'glm-5.3-flash');

    // A single tier cannot tier: no plan is better than a lie in the ledger.
    const single = join(dir, 'single.json');
    await writeFile(single, JSON.stringify({
      provider: { keyed: { name: 'Keyed', kind: 'openai', options: { apiKey: 'k' }, models: { 'glm-5.3': {} } } },
    }), 'utf8');
    assert.equal(deriveTiers({ configPath: single }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a real turn switches models between calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-dispatch-turn-'));
  const requested: string[] = [];
  // One local endpoint serving both tiers: the request body names the model, and
  // that is the whole assertion — which model actually answered each call.
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let model = 'unknown';
      try {
        model = String(JSON.parse(body).model ?? 'unknown');
      } catch { /* keep the placeholder, the assertion will show it */ }
      requested.push(model);
      // The openai adapter speaks SSE. Call 1: ask for a tool. Call 2: answer,
      // so the turn ends and both calls are attributable to a model.
      const delta = requested.length === 1
        ? { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }
        : { content: '改好了。' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  try {
    const configPath = join(dir, 'v2.json');
    await writeFile(configPath, JSON.stringify({
      provider: {
        local: {
          name: 'local', kind: 'openai', enabled: true,
          options: { apiKey: 'test', baseURL: `http://127.0.0.1:${port}` },
          models: { 'glm-5.3': {}, 'glm-5.3-flash': {} },
        },
      },
    }), 'utf8');

    const sessions = new SessionStore(join(dir, 'sessions'));
    const session = await sessions.create({ provider: 'openai', model: 'glm-5.3', workspaceRoot: dir });
    const readFile: ToolDefinition<Record<string, unknown>> = {
      name: 'read_file',
      description: 'reads a file',
      inputHint: '{"path":"string"}',
      risk: 'read',
      validate: (input) => (input ?? {}) as Record<string, unknown>,
      execute: async () => ({ ok: true, output: 'export const a = 1;' }),
    };
    const runtime = {
      config: {
        workspaceRoot: dir,
        approval: 'auto',
        maxSteps: 6,
        provider: 'openai',
        model: 'glm-5.3',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'test',
        sessionDir: join(dir, 'sessions'),
        dispatchConfigPath: configPath,
      },
      provider: {
        name: 'openai',
        model: 'glm-5.3',
        async complete() { throw new Error('the plan must replace this provider before the first call'); },
      },
      session,
      sessions,
      tools: ToolRegistry.fromTools([readFile]),
      ui: new TerminalUI({ quiet: true }),
      toolScope: 'full',
    } as unknown as AgentRuntime;

    const plan = createDispatchPlan(runtime);
    assert.ok(plan, 'two configured tiers must produce a plan');
    assert.equal(plan.source, 'derived');

    const result = await runAgentTurn(runtime, '把 a.ts 里的函数改成 async');
    assert.equal(result.ok, true);

    // Step 0 of a write-intent turn is 'standard' and there is no standard tier,
    // so it slides up to expensive; the follow-through after the tool result is
    // the mechanical half and runs cheap.
    assert.deepEqual(requested, ['glm-5.3', 'glm-5.3-flash'], `calls: ${requested.join(', ')}`);
    assert.equal(runtime.dispatchTier, 'cheap', 'the runtime reports the tier of the last call');
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit --base-url keeps the caller on exactly that endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-dispatch-endpoint-'));
  try {
    const live = await loadConfig({ workspace: dir } as CliArgs, {});
    assert.equal(live.dispatch, true, 'a normal run routes every call');
    const pinned = await loadConfig({ workspace: dir, baseUrl: 'http://127.0.0.1:9/v1' } as CliArgs, {});
    assert.equal(pinned.dispatch, false, 'a fixture or proxy endpoint must not be re-routed to registry models');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AICODE_DISPATCH=0 turns routing off entirely', async () => {
  const previous = process.env.AICODE_DISPATCH;
  process.env.AICODE_DISPATCH = '0';
  try {
    const dir = await mkdtemp(join(tmpdir(), 'aicode-dispatch-off-'));
    try {
      const configPath = join(dir, 'v2.json');
      await writeFile(configPath, JSON.stringify({
        provider: {
          local: {
            name: 'local', kind: 'openai',
            options: { apiKey: 'k' },
            models: { 'glm-5.3': {}, 'glm-5.3-flash': {} },
          },
        },
      }), 'utf8');
      const plan = createDispatchPlan({
        config: { dispatchConfigPath: configPath, model: 'glm-5.3' },
        provider: { name: 'openai', model: 'glm-5.3' },
        session: {},
        ui: undefined,
      } as unknown as AgentRuntime);
      assert.equal(plan, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.AICODE_DISPATCH;
    else process.env.AICODE_DISPATCH = previous;
  }
});
