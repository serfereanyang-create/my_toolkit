import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runAgentTurn } from '../src/agent/agent.js';
import type { AgentRuntime } from '../src/agent/agent.js';
import { AutoReviewGate } from '../src/safety/autoReview.js';
import { DesktopApprovalBroker } from '../src/cli/approvalBroker.js';
import type { AppConfig } from '../src/config/types.js';
import type { ProviderRequest } from '../src/providers/types.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ApprovalRequest, ToolDefinition } from '../src/tools/types.js';
import {
  createSubAgentConfirm,
  DESTRUCTIVE_CONFIRM_REASON,
  isDestructiveApprovalRequest,
  runSubAgent,
} from '../src/subagent/runner.js';

/*
 * 子 agent 的破坏性工具守卫。
 *
 * 缺陷：`policy.ts` 对 `alwaysPrompt` 工具在**任何模式**下都返回
 * needsPrompt（注释写着「从不静默批准」），但 `registry.ts` 只在
 * `context.confirm` 缺失时才拒绝；子 runtime 过去给它一个恒为 true 的
 * confirm，于是 `git_restore`（不带 --staged，丢弃未提交改动）和
 * `computer_close` 在子 agent 里被静默执行。
 *
 * 修复后的约定（本文件逐条钉死）：
 *   1. 子 agent 的普通确认（write 等）仍然自动放行 —— 不能修过头；
 *   2. 子 agent 的破坏性确认（reason 为 alwaysPrompt 固定文案）一律拒绝，
 *      得到的是拒绝结果，不是静默成功；
 *   3. 父 agent 有真实 confirm 时行为不变：确认被询问，且决定被尊重。
 *
 * 每个断言都走真实 registry / 真实 runSubAgent + mock provider，不联网。
 */

const CANCELLED = /cancelled by user|已由用户取消/;

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

async function withWorkspace(run: (workspace: string, runtime: AgentRuntime, close: () => Promise<void>) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sub-guard-'));
  const created = await createAgentRuntime(baseConfig(workspace, { approval: 'ask', noInput: true, maxSteps: 3 }));
  try {
    await run(workspace, created.runtime, created.close);
  } finally {
    await created.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

/** 一个可丢弃的 git 仓库：a.txt 有未提交改动。 */
function initRepoWithUnsavedEdit(workspace: string) {
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'guard@example.invalid'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'guard'], { cwd: workspace });
  return (async () => {
    await writeFile(join(workspace, 'a.txt'), 'committed\n', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: workspace });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: workspace });
    await writeFile(join(workspace, 'a.txt'), 'UNCOMMITTED USER WORK\n', 'utf8');
  })();
}

// ── 1. 确认回调本身 ──────────────────────────────────────────────────────────

test('sub-agent confirm distinguishes destructive requests from ordinary ones', async () => {
  const refused: string[] = [];
  const confirm = createSubAgentConfirm((tool) => refused.push(tool));

  const destructive: ApprovalRequest = {
    tool: 'git_restore',
    risk: 'write',
    input: { paths: ['a.txt'] },
    reason: DESTRUCTIVE_CONFIRM_REASON,
    message: 'Approve write tool git_restore paths=a.txt?',
  };
  assert.equal(isDestructiveApprovalRequest(destructive), true);
  assert.equal(await confirm(destructive.message, destructive), false);
  assert.deepEqual(refused, ['git_restore']);

  const ordinary: ApprovalRequest = {
    tool: 'write_file',
    risk: 'write',
    input: { path: 'notes.md' },
    reason: 'interactive approval required',
    message: 'Approve write tool write_file?',
  };
  assert.equal(isDestructiveApprovalRequest(ordinary), false);
  assert.equal(await confirm(ordinary.message, ordinary), true);

  // 没有 ApprovalRequest 的调用（git safety / task board 等非工具路径）沿用
  // headless 的自动放行，不掉回交互。
  assert.equal(await confirm('commit this board?'), true);
  assert.equal(refused.length, 1);
});

test('registry + sub-agent confirm: alwaysPrompt tool is refused, ordinary write runs', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sub-guard-registry-'));
  try {
    let destructiveRuns = 0;
    const probe: ToolDefinition<Record<string, never>> = {
      name: 'probe_destructive',
      description: 'test double standing in for a destructive tool',
      inputHint: '{}',
      risk: 'write',
      alwaysPrompt: true,
      validate: () => ({}),
      execute: async () => {
        destructiveRuns += 1;
        return { ok: true, output: 'ran' };
      },
    };
    const registry = ToolRegistry.fromTools([...createDefaultToolRegistry().list(), probe]);
    const context = {
      workspaceRoot: workspace,
      approval: 'ask' as const,
      signal: new AbortController().signal,
      confirm: createSubAgentConfirm(),
    };

    const refused = await registry.execute('probe_destructive', {}, context);
    assert.equal(refused.ok, false, 'alwaysPrompt must not execute in a sub-agent context');
    assert.match(refused.output, CANCELLED);
    assert.equal(destructiveRuns, 0, 'a refusal must have zero side effects');

    // 普通写：同一个子 agent confirm，仍然自动确认并落盘。
    const wrote = await registry.execute('write_file', { path: 'ordinary.md', content: 'ok' }, context);
    assert.equal(wrote.ok, true);
    assert.equal(await readFile(join(workspace, 'ordinary.md'), 'utf8'), 'ok');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('computer_close, the other alwaysPrompt tool, is refused before it can run', async () => {
  // 拒绝发生在 execute 之前，所以这里不会真的去关任何窗口。
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sub-guard-close-'));
  try {
    // computer_close 只在 computer-use 注入后才注册，所以直接取工具定义跑真实
    // registry.execute —— 拒绝必须发生在 execute（关窗口）之前。
    const { computerCloseTool } = await import('../src/tools/computer.js');
    const registry = ToolRegistry.fromTools([computerCloseTool]);
    const result = await registry.execute('computer_close', { window: 'no-such-window-4f2a' }, {
      workspaceRoot: workspace,
      approval: 'auto',
      signal: new AbortController().signal,
      confirm: createSubAgentConfirm(),
    });
    assert.equal(result.ok, false);
    assert.match(result.output, CANCELLED);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ── 2. 真实子 agent：git_restore 被拒 ────────────────────────────────────────

test('a sub-agent cannot discard uncommitted work through git_restore', async () => {
  await withWorkspace(async (workspace, runtime) => {
    await initRepoWithUnsavedEdit(workspace);

    const requests: ProviderRequest[] = [];
    let calls = 0;
    runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete(request) {
        requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
        calls += 1;
        if (calls === 1) {
          return { actions: [{ type: 'tool', tool: 'git_restore', input: { paths: ['a.txt'] } }] };
        }
        return { actions: [{ type: 'message', content: 'work tree untouched' }] };
      },
    };

    // general 是唯一不额外收窄工具集的专家，确保 tool ceiling 不是拒绝的原因。
    const sub = await runSubAgent(
      { id: 'guard-restore', expert: 'general', goal: 'clean up the work tree', maxSteps: 3 },
      runtime,
      new Map(),
    );

    // 拒绝结果必须真的回到模型上下文里，而不是静默成功。
    const delivered = requests
      .map((request) => JSON.stringify(request.messages))
      .find((text) => text.includes('git_restore'));
    assert.ok(delivered, 'the tool result must be sent back to the child model');
    assert.match(delivered!, CANCELLED);
    const ran = requests.some((request) => JSON.stringify(request.messages).includes('UNCOMMITTED USER WORK'));
    assert.equal(ran, false, 'the tool never ran, so git output must not exist');

    const after = await readFile(join(workspace, 'a.txt'), 'utf8');
    assert.equal(after.replace(/\r\n/g, '\n'), 'UNCOMMITTED USER WORK\n', 'uncommitted work must survive');
    assert.equal(sub.ok, true, 'the refusal is a tool denial, not a failed sub-agent turn');
  });
});

test('a sub-agent still writes ordinary files without a prompt (no over-fixing)', async () => {
  await withWorkspace(async (workspace, runtime) => {
    let calls = 0;
    runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { actions: [{ type: 'tool', tool: 'write_file', input: { path: 'sub.txt', content: 'sub' } }] };
        }
        return { actions: [{ type: 'message', content: 'sub wrote it' }] };
      },
    };
    const sub = await runSubAgent(
      { id: 'guard-write', expert: 'code_edit', goal: 'write sub.txt', maxSteps: 2 },
      runtime,
      new Map(),
    );
    assert.equal(sub.ok, true);
    assert.equal(await readFile(join(workspace, 'sub.txt'), 'utf8'), 'sub');
  });
});

// ── 3. 父 agent 路径不变 ────────────────────────────────────────────────────

test('the parent turn still asks a real confirm and honours its answer', async () => {
  const seen: ApprovalRequest[] = [];
  for (const approve of [false, true]) {
    await withWorkspace(async (workspace, runtime) => {
      await initRepoWithUnsavedEdit(workspace);
      let calls = 0;
      runtime.provider = {
        name: 'mock',
        model: 'mock-code-agent-v1',
        async complete() {
          calls += 1;
          if (calls === 1) {
            return { actions: [{ type: 'tool', tool: 'git_restore', input: { paths: ['a.txt'] } }] };
          }
          return { actions: [{ type: 'message', content: 'done' }] };
        },
      };
      runtime.toolConfirm = async (_message, request) => {
        if (request) seen.push(request);
        return approve;
      };

      await runAgentTurn(runtime, 'clean up the work tree');

      const after = await readFile(join(workspace, 'a.txt'), 'utf8');
      if (approve) {
        assert.equal(after.replace(/\r\n/g, '\n'), 'committed\n', 'an approving parent still discards the edit');
      } else {
        assert.equal(after.replace(/\r\n/g, '\n'), 'UNCOMMITTED USER WORK\n', 'a denying parent keeps the edit');
      }
    });
  }
  // The parent asked the destructive prompt (not a generic one), and its answer decided.
  assert.equal(seen.length, 2);
  assert.ok(seen.every((request) => request.reason === DESTRUCTIVE_CONFIRM_REASON));
  assert.ok(seen.every((request) => request.tool === 'git_restore'));
  assert.ok(seen.every((request) => Array.isArray(request.input.paths) && String(request.input.paths).includes('a.txt')));
});

// ── 4. 已知残余路径（交接项，故意钉住当前行为）────────────────────────────────

test('autoReview is not even consulted for a destructive call', async () => {
  // isReviewable() used to exclude only risk === 'read', so an auto-review
  // verdict of "allow" answered the prompt before confirm was ever reached —
  // no human saw the targets, in the parent session or the child. It now
  // excludes the same reason the sub-agent guard matches on. The reviewer is
  // made to say allow here precisely to prove it never gets the chance.
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sub-guard-review-'));
  try {
    let destructiveRuns = 0;
    let reviewConsulted = 0;
    const probe: ToolDefinition<Record<string, never>> = {
      name: 'probe_destructive',
      risk: 'write',
      alwaysPrompt: true,
      description: 'probe',
      inputHint: '{}',
      validate: () => ({}),
      execute: async () => {
        destructiveRuns += 1;
        return { ok: true, output: 'ran' };
      },
    };
    const registry = ToolRegistry.fromTools([probe]);
    // Drive the reviewer the way agent.ts does: through AutoReviewGate, which
    // is the only caller of isReviewable. Handing `autoReview` straight to the
    // registry would skip that filter and prove nothing about the real path.
    const gate = new AutoReviewGate();
    const result = await registry.execute('probe_destructive', {}, {
      workspaceRoot: workspace,
      approval: 'ask',
      signal: new AbortController().signal,
      confirm: createSubAgentConfirm(),
      autoReview: async (request) => {
        if (!gate.shouldConsult(request, true)) {
          return { decision: 'abstain' as const, reason: 'not reviewable' };
        }
        reviewConsulted += 1;
        return { decision: 'allow' as const, riskLevel: 'low' as const, rationale: 'reviewer said yes' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(destructiveRuns, 0);
    assert.equal(reviewConsulted, 0, 'the destructive prompt must never reach a model reviewer');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ── 5. allow_session 缓存不得吞掉破坏性确认 ──────────────────────────────────

test('a session-wide allow from an ordinary write does not answer a destructive call', async () => {
  // The cache key is `risk:tool:dir`, so `write:write_file:src` and
  // `write:git_restore` never collided — but `git_restore`'s targets live in
  // input.paths, not input.path, so its own key degenerates to
  // `write:git_restore` and one grant covered every directory. Rather than
  // widen the key (a cached yes still cannot mean "these exact targets"), the
  // broker now refuses to cache destructive approvals at all. This drives the
  // real broker to prove both halves: the yes is not remembered, and a later
  // destructive call is asked again.
  const events: Record<string, unknown>[] = [];
  const broker = new DesktopApprovalBroker('test-session', { emit: (e) => events.push(e), timeoutMs: 0 });

  const ordinary: ApprovalRequest = {
    tool: 'write_file',
    risk: 'write',
    input: { path: 'src/a.ts' },
    reason: 'approval required',
    message: 'write src/a.ts',
  };
  const first = broker.confirm('write src/a.ts', ordinary);
  broker.resolve(broker.lastRequestId(), 'allow_session');
  assert.equal(await first, 'allow_session');

  // Same tool, same directory: answered from the cache, no second event.
  const before = events.filter((e) => e.type === 'approval_needed').length;
  assert.equal(await broker.confirm('write src/a.ts', ordinary), true);
  assert.equal(events.filter((e) => e.type === 'approval_needed').length, before, 'cached write is not re-asked');

  const destructive: ApprovalRequest = {
    tool: 'git_restore',
    risk: 'write',
    input: { paths: ['work.txt'] },
    reason: DESTRUCTIVE_CONFIRM_REASON,
    message: 'restore work.txt',
  };
  const second = broker.confirm('restore work.txt', destructive);
  const askedAgain = events.filter((e) => e.type === 'approval_needed').length;
  broker.resolve(broker.lastRequestId(), 'allow_session');
  assert.equal(await second, 'allow_session');
  assert.equal(askedAgain, before + 1, 'a destructive call is always asked');

  // The grant just given must not have been stored: a third call asks again.
  const third = broker.confirm('restore work.txt', destructive);
  assert.equal(events.filter((e) => e.type === 'approval_needed').length, askedAgain + 1, 'the destructive yes is not cached');
  broker.resolve(broker.lastRequestId(), 'deny');
  assert.equal(await third, false);
});

// ── 6. 导出面与文案耦合 ──────────────────────────────────────────────────────

test('the guard is exported so the built module offers the same predicate', () => {
  assert.equal(typeof createSubAgentConfirm, 'function');
  assert.equal(DESTRUCTIVE_CONFIRM_REASON, 'destructive tool requires explicit confirmation');
});

test('the policy reason the guard matches on is pinned (drift must fail loudly)', async () => {
  // 守卫靠 reason 文案区分破坏性确认。policy.ts 改了这句话而这里没改，
  // 守卫会静默失效——所以把两边钉在一起：任何一边改动都会让本测试失败。
  const { decideApproval } = await import('../src/safety/policy.js');
  const decision = decideApproval({
    mode: 'auto',
    risk: 'write',
    workspaceRoot: tmpdir(),
    alwaysPrompt: true,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.needsPrompt, true);
  assert.equal(decision.reason, DESTRUCTIVE_CONFIRM_REASON);
});
