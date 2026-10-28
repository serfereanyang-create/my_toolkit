import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runAgentTurn } from '../src/agent/agent.js';
import type { AgentRuntime } from '../src/agent/agent.js';
import type { AppConfig } from '../src/config/types.js';
import { expertById } from '../src/experts/profiles.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { isReadOnlyTool, limitProviderTools, MAX_PROVIDER_TOOLS, selectScopedTools } from '../src/tools/scope.js';
import { MAX_SUBAGENT_DEPTH as LEGACY_MAX_SUBAGENT_DEPTH } from '../src/tools/subagent.js';
import type { ToolDefinition } from '../src/tools/types.js';
import {
  DEFAULT_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENTS_PER_BATCH,
  MAX_SUBAGENT_CONCURRENCY,
  runSubAgentBatch,
} from '../src/subagent/orchestrator.js';
import { createSubAgentConfirm, expertIdForSubAgentRequest, runSubAgent, subAgentToolCeiling } from '../src/subagent/runner.js';
import { createSpawnSubagentTool, MAX_SUBAGENT_DEPTH } from '../src/subagent/tool.js';

/*
 * 子代理安全边界。
 *
 * 四件事在这里被钉死（都是实测，不是从注释推断）：
 *   1. 嵌套深度上限 = 3，判定是 `>=`；第 4 层的 spawn 调用被**拒绝**，
 *      不是静默剪枝（子代理仍然拿得到 spawn_subagent，拒绝发生在执行时）。
 *   2. 子代理的 confirm / toolConfirm 恒为 `() => Promise.resolve(true)`：
 *      ask / plan 模式下父的写操作会被拒绝，子代理的同一次写直接落盘；
 *      `alwaysPrompt` 的破坏性工具也被同一个恒真回调放行。
 *   3. 工具上限是父作用域（resolvedToolScope），expert profile 只会再收窄；
 *      子代理拿不到比父更多的东西，但 general 子代理仍拿得到 spawn_subagent
 *      —— 那条路由深度上限约束，不归工具作用域管。provider 侧的 340 上限是
 *      最后的保险，protected 的注入工具永不被裁。
 *   4. 子代理不继承父消息历史：新 SessionRecord + 只有构造出来的 prompt。
 *
 * 每条都先给一个不需要模型的断言，再给一个最小真实 runtime 的端到端断言。
 * 真实 runtime 用 mock provider，不联网。
 */

const baseConfig = (workspace: string, patch: Partial<AppConfig> = {}): AppConfig => ({
  provider: 'mock',
  model: 'mock-code-agent-v1',
  approval: 'auto',
  workspaceRoot: workspace,
  sessionDir: join(workspace, 'sessions'),
  noBanner: true,
  json: true,
  quiet: true,
  ...patch,
});

async function withRuntime(
  patch: Partial<AppConfig>,
  run: (created: Awaited<ReturnType<typeof createAgentRuntime>>, workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sub-boundary-'));
  const created = await createAgentRuntime(baseConfig(workspace, patch));
  try {
    await run(created, workspace);
  } finally {
    await created.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

// ── 1. 嵌套深度 ──────────────────────────────────────────────────────────────

test('depth constant is 3 in both spawn_subagent implementations', () => {
  assert.equal(MAX_SUBAGENT_DEPTH, 3);
  assert.equal(LEGACY_MAX_SUBAGENT_DEPTH, 3);
  // The two copies disagreeing is the failure this assertion is for: `/subagents`
  // and the depth gate would then tell different stories.
  assert.equal(MAX_SUBAGENT_DEPTH, LEGACY_MAX_SUBAGENT_DEPTH);
});

test('spawn_subagent refuses at depth >= 3 (>=, not >)', async () => {
  // A stub parent has no session store, so below the limit the batch runs and
  // fails for that unrelated reason; at the limit it must not run at all and the
  // output must be the depth refusal. That difference is the assertion.
  const runAt = async (depth: number | undefined) => {
    const parent = {
      subAgentDepth: depth,
      tools: { list: () => [] },
      allTools: { list: () => [] },
    } as unknown as AgentRuntime;
    const tool = createSpawnSubagentTool(parent);
    const input = tool.validate({
      subagents: [{ id: 'probe', goal: 'probe', expert: 'code_search' }],
      concurrency: 1,
    });
    const result = await tool.execute(input, { workspaceRoot: process.cwd(), approval: 'auto', signal: new AbortController().signal });
    return String(result.output);
  };

  for (const below of [0, 1, 2, undefined]) {
    const output = await runAt(below);
    assert.ok(!output.includes('嵌套深度上限'), `depth=${below} must be allowed to spawn`);
  }
  for (const atOrOver of [3, 4, 99]) {
    const output = await runAt(atOrOver);
    assert.ok(output.includes('嵌套深度上限'), `depth=${atOrOver} must be refused`);
  }
});

test('a real chain nests three levels and the fourth call is refused, not silently pruned', async () => {
  // computerAnyApp: spawn_subagent is risk 'shell' with no command string, so in
  // auto mode the policy layer refuses it ("command is not in auto approval
  // allowlist") unless this is on. The desktop runs with it, and without it the
  // chain would stop for an unrelated reason and prove nothing.
  await withRuntime({ computerAnyApp: true }, async (created) => {
    const emitted: string[] = [];
    created.runtime.subagentEmit = (payload) => emitted.push(String(payload.phase));
    const requests: ProviderRequest[] = [];
    const provider: Provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete(request) {
        requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
        const text = JSON.stringify(request.messages);
        // A refusal or a finished child ends this node's chain.
        if (text.includes('嵌套深度上限') || text.includes('子智能体执行完成')) {
          return { actions: [{ type: 'message', content: 'chain stopped' }] };
        }
        if (request.tools.some((tool) => tool.name === 'spawn_subagent')) {
          return {
            actions: [{
              type: 'tool',
              tool: 'spawn_subagent',
              input: { subagents: [{ id: `lv${requests.length}`, goal: 'DEPTH-CHAIN child', expert: 'general' }] },
            }],
          };
        }
        return { actions: [{ type: 'message', content: 'leaf' }] };
      },
    };
    created.runtime.provider = provider;

    await runAgentTurn(created.runtime, 'start the depth chain');

    const refusals = requests.filter((request) => JSON.stringify(request.messages).includes('嵌套深度上限'));
    assert.equal(refusals.length, 1, 'exactly one node reaches the limit and is refused');
    assert.match(JSON.stringify(refusals[0]!.messages), /已达嵌套深度上限（3 层，当前 3 层）/);
    // The refused node was still OFFERED spawn_subagent: the boundary is an
    // execution-time refusal, not a tool-list pruning. The model sees the tool,
    // calls it, and gets a readable refusal instead of a silently shorter list.
    assert.ok(refusals[0]!.tools.some((tool) => tool.name === 'spawn_subagent'));

    // Three nested sub-sessions actually ran, then stopped.
    assert.equal(emitted.filter((phase) => phase === 'started').length, MAX_SUBAGENT_DEPTH);
    assert.equal(emitted.filter((phase) => phase === 'done').length, MAX_SUBAGENT_DEPTH);
  });
});

// ── 2. 确认门 ────────────────────────────────────────────────────────────────

test('sub-agent writes bypass the parent ask-mode gate; the parent write is refused', async () => {
  // noInput keeps resolveConfirm from installing a stdin prompt when the test
  // happens to run on a TTY; the point is the parent has no handler and must
  // refuse, which is what the registry does with `needsPrompt` + no confirm.
  await withRuntime({ approval: 'ask', noInput: true, maxSteps: 1 }, async (created, workspace) => {
    let parentCalls = 0;
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete() {
        parentCalls += 1;
        if (parentCalls === 1) {
          return { actions: [{ type: 'tool', tool: 'write_file', input: { path: 'main.txt', content: 'main' } }] };
        }
        return { actions: [{ type: 'message', content: 'done' }] };
      },
    };

    const parentTurn = await runAgentTurn(created.runtime, 'write main.txt');
    assert.equal(parentTurn.ok, false, 'the parent cannot satisfy an ask-mode write');
    assert.equal(existsSync(join(workspace, 'main.txt')), false, 'the parent write must not land');
    assert.match(
      JSON.stringify(created.runtime.session.toolCalls.map((call) => call.output)),
      /interactive approval required/,
    );

    // Same approval mode, same runtime, same write — only the executor differs.
    let subCalls = 0;
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete() {
        subCalls += 1;
        if (subCalls === 1) {
          return { actions: [{ type: 'tool', tool: 'write_file', input: { path: 'sub.txt', content: 'sub' } }] };
        }
        return { actions: [{ type: 'message', content: 'sub wrote it' }] };
      },
    };
    const sub = await runSubAgent({ id: 'confirm-probe', expert: 'code_edit', goal: 'write sub.txt', maxSteps: 2 }, created.runtime, new Map());

    assert.equal(sub.ok, true);
    assert.equal(await readFile(join(workspace, 'sub.txt'), 'utf8'), 'sub', 'the sub-agent write lands with no confirmation');
  });
});

test('a raw true-confirm defeats alwaysPrompt — which is why the sub-runtime no longer supplies one', async () => {
  // `git_restore` without --staged discards uncommitted work and is marked
  // `alwaysPrompt: (input) => input.staged !== true`. The policy layer turns
  // that into needsPrompt in EVERY mode. The only thing between that decision
  // and the destruction is ToolContext.confirm, and any handler that answers
  // `true` satisfies it — the registry cannot tell an automated yes from a
  // human one. That is precisely why the sub-runtime's confirm now inspects the
  // approval request instead of resolving true unconditionally
  // (createSubAgentConfirm in src/subagent/runner.ts).
  const { gitRestoreTool } = await import('../src/tools/git-write.js');
  assert.equal(typeof gitRestoreTool.alwaysPrompt, 'function');
  assert.equal(
    (gitRestoreTool.alwaysPrompt as (input: Record<string, unknown>) => boolean)({ paths: ['work.txt'] }),
    true,
  );

  await withRuntime({}, async (_created, workspace) => {
    const probe: ToolDefinition<Record<string, never>> = {
      name: 'probe_destructive',
      description: 'test double standing in for a destructive tool',
      inputHint: '{}',
      risk: 'write',
      alwaysPrompt: true,
      validate: () => ({}),
      execute: async () => ({ ok: true, output: 'ran' }),
    };
    const tools = ToolRegistry.fromTools([probe]);
    const context = {
      workspaceRoot: workspace,
      approval: 'auto' as const,
      signal: new AbortController().signal,
    };

    // Auto mode, no confirmation handler: refused, because alwaysPrompt forces
    // the prompt and there is nobody to answer it.
    const refused = await tools.execute('probe_destructive', {}, context);
    assert.equal(refused.ok, false);
    assert.match(String(refused.output), /confirmation/);

    // The callback the sub-runtime USED to install. Still true of the registry:
    // a handler that answers yes without looking at the request runs the tool.
    const asSubAgent = await tools.execute('probe_destructive', {}, {
      ...context,
      confirm: () => Promise.resolve(true),
    });
    assert.equal(asSubAgent.ok, true, 'a bare true-confirm still satisfies the alwaysPrompt gate');

    // The callback it installs now: same call, but it reads the request.
    const guarded = await tools.execute('probe_destructive', {}, {
      ...context,
      confirm: createSubAgentConfirm(),
    });
    assert.equal(guarded.ok, false, 'the sub-agent confirm refuses destructive approvals');
  });
});

// This used to assert the opposite: the sub-runtime's hardcoded
// `confirm: () => Promise.resolve(true)` answered the `alwaysPrompt` gate, so a
// child could destroy uncommitted work with no prompt. `createSubAgentConfirm`
// (src/subagent/runner.ts) now refuses destructive confirmations only, so the
// expected outcome flipped. Keep the setup identical — it is the regression
// guard that a routine auto-confirm was not narrowed along with it.
test('a sub-agent cannot discard uncommitted work, and never prompts', async () => {
  const { execFileSync } = await import('node:child_process');
  await withRuntime({}, async (created, workspace) => {
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'probe@example.invalid'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'probe'], { cwd: workspace });
    await writeFile(join(workspace, 'work.txt'), 'committed\n', 'utf8');
    execFileSync('git', ['add', 'work.txt'], { cwd: workspace });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: workspace });
    await writeFile(join(workspace, 'work.txt'), 'UNCOMMITTED USER WORK\n', 'utf8');

    let calls = 0;
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { actions: [{ type: 'tool', tool: 'git_restore', input: { paths: ['work.txt'] } }] };
        }
        return { actions: [{ type: 'message', content: 'work tree cleaned' }] };
      },
    };
    // `general` keeps the widest toolset among the profiles a caller can name
    // without matching a role; it is what spawn_subagent falls back to when the
    // caller omits `expert`.
    const sub = await runSubAgent({ id: 'destroy', expert: 'general', goal: 'clean up the work tree', maxSteps: 3 }, created.runtime, new Map());

    const after = await readFile(join(workspace, 'work.txt'), 'utf8');
    assert.equal(after.replace(/\r\n/g, '\n'), 'UNCOMMITTED USER WORK\n', 'the destructive call was refused before touching disk');
    assert.notEqual(sub.sessionId, '');
  });
});

// ── 3. 工具上限 ──────────────────────────────────────────────────────────────

test('a standard-scope parent hands the child at most its own tools', () => {
  const allTools = createDefaultToolRegistry();
  const scoped = ToolRegistry.fromTools(selectScopedTools(allTools, 'standard'));
  const ceiling = subAgentToolCeiling({ tools: scoped, allTools, resolvedToolScope: 'standard' });
  const names = ceiling.list().map((tool) => tool.name);

  // The narrowed parent cannot see these, so neither may the child.
  for (const denied of ['delete_path', 'git_init']) {
    assert.ok(!names.includes(denied), `${denied} leaked past the parent scope`);
  }
  const keptFor = (id: string) => {
    const profile = expertById(id);
    assert.ok(profile, `fixture assumption: expert ${id} exists`);
    return ceiling.list()
      .filter((tool) => profile!.toolFilter({ name: tool.name, risk: tool.risk, description: tool.description }))
      .map((tool) => tool.name);
  };

  // write-capable expert keeps its write tools…
  assert.ok(keptFor('code_edit').includes('write_file'));
  // …the read-only one cannot write or delegate.
  for (const name of keptFor('code_search')) {
    assert.ok(!['write_file', 'spawn_subagent', 'review_loop'].includes(name), `code_search child offered ${name}`);
  }
  // `general` still gets spawn_subagent — nesting is bounded by depth, not by
  // the tool scope. If this becomes unreachable, delegation at level 2+ silently
  // stops working; if it becomes reachable from a read-only expert, that
  // expert's read-only promise breaks. Both directions are asserted.
  assert.ok(keptFor('general').includes('spawn_subagent'));
  // The ceiling only narrows: nothing appears that the parent lacks.
  for (const name of names) assert.ok(scoped.list().some((tool) => tool.name === name), `${name} exceeds the parent`);
});

test('provider payload cap is a last-resort trim that never drops spawn_subagent', () => {
  assert.equal(MAX_PROVIDER_TOOLS, 340);
  const allTools = createDefaultToolRegistry().list();
  const limited = limitProviderTools(allTools, { protectedNames: new Set(['spawn_subagent']) });
  assert.ok(limited.tools.length <= MAX_PROVIDER_TOOLS);
  assert.ok(limited.tools.some((tool) => tool.name === 'spawn_subagent'));
  if (allTools.length > MAX_PROVIDER_TOOLS) {
    assert.ok(limited.dropped.length > 0, 'over the cap, something must be dropped');
  }
});

// ── 4. 上下文隔离 ────────────────────────────────────────────────────────────

test('a sub-agent starts from a fresh session and does not inherit parent history', async () => {
  await withRuntime({ maxSteps: 2 }, async (created, workspace) => {
    const marker = 'PARENT-ONLY-SECRET-7f3a';
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete() {
        return { actions: [{ type: 'message', content: 'noted' }] };
      },
    };
    await runAgentTurn(created.runtime, `remember ${marker}`);

    const requests: ProviderRequest[] = [];
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete(request) {
        requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
        return { actions: [{ type: 'message', content: 'sub done' }] };
      },
    };
    const sub = await runSubAgent(
      { id: 'iso', expert: 'code_search', goal: 'inspect src', maxSteps: 1 },
      created.runtime,
      new Map(),
      '## 主任务背景：整体目标',
    );

    assert.ok(requests.length > 0);
    const sent = JSON.stringify(requests[0]!.messages);
    assert.equal(sent.includes(marker), false, 'parent transcript must not reach the child');
    // What does cross the boundary: the caller-built prompt (parent goal + role + task).
    assert.ok(sent.includes('inspect src'));
    assert.ok(sent.includes('整体目标'), 'parentGoal is injected as text, by construction');

    assert.notEqual(sub.sessionId, created.runtime.session.id);
    assert.equal(existsSync(join(workspace, 'sessions', `${sub.sessionId}.json`)), false, 'no record in the user session dir');
    assert.equal(existsSync(join(workspace, 'sessions-subagents', `${sub.sessionId}.json`)), true, 'sub-sessions live in the sibling dir');
  });
});

test('a sub-agent turn stops at the next checkpoint when the parent cancels', async () => {
  await withRuntime({ maxSteps: 5 }, async (created, workspace) => {
    let cancel = false;
    created.runtime.cancelRequested = () => cancel;
    const requests: ProviderRequest[] = [];
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete(request) {
        requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
        cancel = true; // cancel lands while the model call is in flight
        return { actions: [{ type: 'tool', tool: 'write_file', input: { path: 'cancelled.txt', content: 'x' } }] };
      },
    };

    const sub = await runSubAgent({ id: 'cancel', expert: 'code_edit', goal: 'write something', maxSteps: 5 }, created.runtime, new Map());

    assert.equal(requests.length, 1);
    assert.equal(sub.ok, false);
    assert.match(sub.answer, /停止/);
    assert.equal(existsSync(join(workspace, 'cancelled.txt')), false, 'the tool proposed in the cancelled step never ran');
  });
});

// ── 附加：并发上限是钳制不是拒绝 ─────────────────────────────────────────────

class CountingSessionStore extends SessionStore {
  active = 0;
  peak = 0;
  override async create(options: Parameters<SessionStore['create']>[0]) {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      return await super.create(options);
    } finally {
      this.active -= 1;
    }
  }
  override sibling(): SessionStore {
    return this;
  }
}

test('batch concurrency is clamped to the maximum instead of rejected', async () => {
  assert.equal(DEFAULT_SUBAGENT_CONCURRENCY, 4);
  assert.equal(MAX_SUBAGENT_CONCURRENCY, 16);
  assert.equal(MAX_SUBAGENTS_PER_BATCH, 64);

  await withRuntime({ maxSteps: 1 }, async (created) => {
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete() {
        return { actions: [{ type: 'message', content: 'done' }] };
      },
    };
    const counting = new CountingSessionStore(created.runtime.config.sessionDir);
    created.runtime.sessions = counting;
    // A sub-runtime is created by spreading the parent, so it picks the same
    // counting store through `sessions` and through `.sibling()`.

    const specs = Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      goal: `goal ${index}`,
      expert: 'code_search',
    }));
    const results = await runSubAgentBatch({ subagents: specs, concurrency: 999, timeoutMs: 60_000 }, created.runtime);

    assert.equal(results.length, 20);
    assert.ok(results.every((result) => result.ok));
    assert.ok(counting.peak <= MAX_SUBAGENT_CONCURRENCY, `requested 999, peak observed ${counting.peak}`);
    assert.ok(counting.peak > 1, 'the batch must actually run in parallel');
  });
});

test('readonly requests route to the read-only expert, and the read-only test excludes spawners', () => {
  assert.equal(expertIdForSubAgentRequest({ readonly: true }), 'code_search');
  assert.equal(expertIdForSubAgentRequest({ readonly: false }), 'code_edit');
  assert.equal(expertIdForSubAgentRequest(), 'code_edit');
  assert.equal(isReadOnlyTool({ name: 'spawn_subagent', risk: 'read' }), false);
  assert.equal(isReadOnlyTool({ name: 'read_file', risk: 'read' }), true);
});
