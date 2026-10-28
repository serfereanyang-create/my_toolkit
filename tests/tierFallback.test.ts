import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  isFallbackWorthy,
  applyTierOverride,
  configForTier,
  completeWithFallback,
} from '../src/subagent/runner.js';
import { createSpawnSubagentTool } from '../src/subagent/tool.js';
import { runAgentTurn } from '../src/agent/agent.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { readTrajectoryRecords } from '../src/session/modelTrajectory.js';
import type { AppConfig } from '../src/config/types.js';

const V2 = join(homedir(), '.zcode', 'v2', 'config.json');
const hasV2 = existsSync(V2);

test('isFallbackWorthy: availability faults fail over, malformed requests do not', () => {
  const err = (status?: number, name?: string) =>
    Object.assign(new Error('x'), status ? { status } : {}, name ? { name } : {});
  assert.equal(isFallbackWorthy(err(429)), true, 'rate limit fails over');
  assert.equal(isFallbackWorthy(err(500)), true, '5xx fails over');
  assert.equal(isFallbackWorthy(err(503)), true);
  assert.equal(isFallbackWorthy(err(401)), true, 'auth fails over');
  assert.equal(isFallbackWorthy(err(404)), true, 'model missing at this endpoint fails over');
  assert.equal(isFallbackWorthy(err(408)), true, 'upstream timeout fails over');
  assert.equal(isFallbackWorthy(err(400)), false, 'a malformed request would fail the same everywhere');
  assert.equal(isFallbackWorthy(err(409)), false, 'a conflicting request must surface');
  assert.equal(isFallbackWorthy(err(413)), false, 'an oversized payload must not burn a second model');
  assert.equal(isFallbackWorthy(err(422)), false);
  assert.equal(isFallbackWorthy(err(200)), false);
  assert.equal(isFallbackWorthy(err(600)), false);
  assert.equal(isFallbackWorthy(new Error('OpenAI request failed: 400 malformed request')), false, 'wrapped 400 must not fail over');
  assert.equal(isFallbackWorthy(new Error('OpenAI request failed: 429 rate limited')), true, 'wrapped 429 must fail over');
  assert.equal(isFallbackWorthy(new Error('OpenAI request failed: 503 upstream unavailable')), true, 'wrapped 5xx must fail over');
  assert.equal(isFallbackWorthy(err(undefined, 'CancelledError')), false, 'user cancel is never a fallback reason');
  assert.equal(isFallbackWorthy(err(undefined, 'AgentCancelledError')), false);
  assert.equal(isFallbackWorthy(err(undefined, 'AbortError')), false, 'provider cancellation must not fail over');
  for (const name of ['AbortError', 'CancelledError', 'AgentCancelledError']) {
    assert.equal(isFallbackWorthy(err(503, name)), false, 'cancellation takes priority over HTTP status');
  }
  assert.equal(isFallbackWorthy(new Error('socket hang up')), true, 'transport faults fail over');
  assert.equal(isFallbackWorthy(new Error('model rejected the request')), false, 'unknown application failures must surface');
});

test('spawn_subagent accepts all three tiers and rejects anything else', () => {
  const tool = createSpawnSubagentTool({} as never);
  const base = { id: 'a', goal: 'do', expert: 'code_search' };
  for (const tier of ['expensive', 'standard', 'cheap']) {
    const parsed = tool.validate({ subagents: [{ ...base, tier }] }) as {
      subagents: Array<{ tier?: string }>;
    };
    assert.equal(parsed.subagents[0].tier, tier, `${tier} must survive validation`);
  }
  const none = tool.validate({ subagents: [base] }) as { subagents: Array<{ tier?: string }> };
  assert.equal(none.subagents[0].tier, undefined, 'omitted tier still inherits the parent');
  assert.throws(
    () => tool.validate({ subagents: [{ ...base, tier: 'premium' }] }),
    /tier must be one of/,
  );
});

test('spawn_subagent infers a specialist when expert is omitted', () => {
  const tool = createSpawnSubagentTool({} as never);
  const parsed = tool.validate({
    subagents: [{ id: 'security', goal: 'Review security vulnerabilities in the auth flow' }],
  }) as { subagents: Array<{ expert: string }> };
  assert.equal(parsed.subagents[0].expert, 'security_review');
});

test('completeWithFallback walks the chain on an availability fault', async () => {
  const seen: string[] = [];
  const member = (model: string) => ({
    entry: { tier: 'cheap', providerName: model, provider: 'mock', model } as never,
    provider: { name: 'mock', model } as never,
  });
  const result = await completeWithFallback(
    [member('primary'), member('backup')],
    async (provider) => {
      seen.push((provider as { model: string }).model);
      if ((provider as { model: string }).model === 'primary') {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      return 'answered';
    },
  );
  assert.equal(result.value, 'answered');
  assert.equal((result.provider as { model: string }).model, 'backup', 'the answering member is reported');
  assert.deepEqual(seen, ['primary', 'backup']);
});

test('completeWithFallback does not fail over on a malformed request', async () => {
  const seen: string[] = [];
  const member = (model: string) => ({
    entry: { tier: 'cheap', providerName: model, provider: 'mock', model } as never,
    provider: { name: 'mock', model } as never,
  });
  await assert.rejects(
    completeWithFallback([member('primary'), member('backup')], async (provider) => {
      seen.push((provider as { model: string }).model);
      throw Object.assign(new Error('bad request'), { status: 400 });
    }),
    /bad request/,
  );
  assert.deepEqual(seen, ['primary'], 'a 400 must not burn a second model');
});

test('completeWithFallback stops on non-availability errors and cancellation without emitting a fallback', async () => {
  const member = (model: string) => ({
    entry: { tier: 'cheap', providerName: model, provider: 'mock', model } as never,
    provider: { name: 'mock', model } as never,
  });
  const errors = [
    Object.assign(new Error('conflict'), { status: 409 }),
    new Error('OpenAI request failed: 413 payload too large'),
    Object.assign(new Error('cancelled'), { name: 'AbortError', status: 503 }),
  ];
  for (const error of errors) {
    const seen: string[] = [];
    let fallbacks = 0;
    await assert.rejects(
      completeWithFallback([member('primary'), member('backup')], async (provider) => {
        seen.push(provider.model);
        throw error;
      }, () => { fallbacks += 1; }),
      (caught) => caught === error,
    );
    assert.deepEqual(seen, ['primary']);
    assert.equal(fallbacks, 0);
  }
});

test('completeWithFallback does not replay on a provider error after streamed output', async () => {
  const member = (model: string) => ({
    entry: { tier: 'cheap', providerName: model, provider: 'mock', model } as never,
    provider: { name: 'mock', model } as never,
  });
  const seen: string[] = [];
  let streamed = false;
  await assert.rejects(
    completeWithFallback(
      [member('primary'), member('backup')],
      async (provider) => {
        seen.push(provider.model);
        streamed = true;
        throw Object.assign(new Error('connection reset after delta'), { status: 503 });
      },
      undefined,
      () => !streamed,
    ),
  );
  assert.deepEqual(seen, ['primary']);
});

test('applyTierOverride resolves the full chain and reports the primary', { skip: !hasV2 }, () => {
  const runtime = {
    config: { provider: 'openai', model: 'parent-model', workspaceRoot: process.cwd() },
    session: { dispatch: { cheap: ['GLM-5.3-Flash', 'deepseek-v4.1-flash'] } },
  } as never;
  const override = applyTierOverride('cheap', runtime);
  assert.ok(override.chain && override.chain.length === 2, 'both chain members are returned');
  assert.equal(override.chain[0].model.toLowerCase(), 'glm-5.3-flash');
  assert.equal(override.config?.model.toLowerCase(), 'glm-5.3-flash', 'config carries the tier model');
  assert.notEqual(override.config?.model, 'parent-model');
});

test('configForTier folds baseUrl/apiKey in without dropping the rest', () => {
  const merged = configForTier(
    { provider: 'openai', model: 'parent', workspaceRoot: '/w', maxSteps: 7 } as never,
    {
      tier: 'cheap',
      providerName: 'x',
      provider: 'openai',
      model: 'cheap-model',
      baseUrl: 'https://e',
      apiKey: 'k',
    } as never,
  ) as Record<string, unknown>;
  assert.equal(merged.model, 'cheap-model');
  assert.equal(merged.baseUrl, 'https://e');
  assert.equal(merged.apiKey, 'k');
  assert.equal(merged.workspaceRoot, '/w', 'unrelated config is preserved');
  assert.equal(merged.maxSteps, 7);
});

test('configForTier does not inherit parent credentials or endpoint', () => {
  const merged = configForTier(
    {
      provider: 'openai',
      model: 'parent',
      baseUrl: 'https://parent.example/v1',
      apiKey: 'parent-secret',
      workspaceRoot: '/w',
    } as never,
    {
      tier: 'cheap',
      providerName: 'target',
      provider: 'anthropic',
      model: 'cheap-model',
    } as never,
  ) as Record<string, unknown>;
  assert.equal(merged.provider, 'anthropic');
  assert.equal(merged.model, 'cheap-model');
  assert.equal(Object.hasOwn(merged, 'baseUrl'), false, 'target without an endpoint must not use the parent endpoint');
  assert.equal(Object.hasOwn(merged, 'apiKey'), false, 'target without credentials must not use the parent key');
  assert.equal(merged.workspaceRoot, '/w');
});

test('trajectory records the fallback provider identity after a tier switch', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tier-trajectory-'));
  try {
    const config: AppConfig = {
      provider: 'mock',
      model: 'primary-model',
      approval: 'auto',
      workspaceRoot: workspace,
      sessionDir: join(workspace, 'sessions'),
      noBanner: true,
      quiet: true,
      json: true,
    };
    const sessions = new SessionStore(config.sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'primary-model', workspaceRoot: workspace });
    const provider = {
      name: 'mock' as const,
      model: 'primary-model',
      async complete() {
        provider.model = 'fallback-model';
        return { actions: [{ type: 'message' as const, content: 'done' }] };
      },
    };
    const runtime = {
      config,
      provider,
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI({ quiet: true, json: true, noColor: true }),
    } as never;

    const result = await runAgentTurn(runtime, 'record the model that answered');
    assert.equal(result.ok, true);
    const rows = readTrajectoryRecords(sessions.filePath(session.id));
    assert.equal(rows.at(-1)?.model, 'fallback-model');
    assert.equal(rows.at(-1)?.provider, 'mock');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
