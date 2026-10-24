import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime } from '../src/agent/agent.js';
import { runAgentTurn, supervisorFor } from '../src/agent/agent.js';
import { loadConfig } from '../src/config/config.js';
import { parseArgs } from '../src/cli/args.js';
import { SessionStore } from '../src/session/store.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { createSupervisorStatusTool } from '../src/tools/supervisorTools.js';
import { TerminalUI } from '../src/ui/terminal.js';

async function makeRuntime(workspace: string, provider: AgentRuntime['provider']) {
  const sessionDir = join(workspace, 'sessions');
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
  const runtime: AgentRuntime = {
    config: {
      provider: 'mock' as const,
      model: 'mock-code-agent-v1',
      approval: 'auto' as const,
      workspaceRoot: workspace,
      sessionDir,
      noBanner: true,
    },
    provider,
    tools: createDefaultToolRegistry(),
    sessions,
    session,
    ui: new TerminalUI(true),
  };
  return { runtime, sessions, session };
}

/*
 * The headline behavior: a turn is bounded by the model deciding it is done, not
 * by a step counter. A cap that cuts real work off mid-task and reports it as a
 * failure is worse than no cap, and the reference implementation (codex-rs) has
 * no such cap at all.
 */
test('a turn is not cut off by any step ceiling', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-nostepcap-'));
  try {
    // 250 tool round-trips — comfortably past the old 200 default.
    const TOTAL = 250;
    let calls = 0;
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete() {
        calls += 1;
        if (calls <= TOTAL) {
          // A distinct input each time so the duplicate-call guard does not skip
          // it — this is a genuinely long run, not a repeated no-op.
          return { actions: [{ type: 'tool' as const, tool: 'list_files', input: { pattern: `src/${calls}/**` }, callId: `c${calls}` }] };
        }
        return { actions: [{ type: 'message' as const, content: 'TASK_DONE: 全部完成' }] };
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);
    const result = await runAgentTurn(runtime, '长任务');

    assert.equal(result.ok, true);
    assert.equal(calls, TOTAL + 1, `expected ${TOTAL + 1} model calls, got ${calls}`);
    // The old failure mode must be gone entirely.
    assert.doesNotMatch(String(result.finalAnswer ?? ''), /max steps/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('maxSteps is not defaulted any more', async () => {
  const config = await loadConfig(parseArgs(['--provider', 'mock']), {});
  assert.equal(config.maxSteps, undefined, 'an absent --max-steps must stay absent (unlimited), not default to a number');
  assert.equal(config.maxTokens, undefined);
});

test('an explicit --max-steps is still honored', async () => {
  const config = await loadConfig(parseArgs(['--provider', 'mock', '--max-steps', '5']), {});
  assert.equal(config.maxSteps, 5);
});

test('a token budget stops the turn and says so', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-tokenbudget-'));
  try {
    let calls = 0;
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete() {
        calls += 1;
        // Report a large spend every step so the budget trips quickly.
        return {
          actions: [{ type: 'tool' as const, tool: 'list_files', input: { pattern: `src/${calls}/**` }, callId: `c${calls}` }],
          usage: { inputTokens: 500, outputTokens: 500 },
        };
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);
    runtime.config.maxTokens = 2_000;
    const result = await runAgentTurn(runtime, '烧钱任务');

    assert.equal(result.ok, false);
    assert.match(String(result.reason), /token budget/);
    // 2000 / 1000 per step = it must stop after a couple of steps, not run free.
    assert.ok(calls <= 4, `budget should have stopped it early, ran ${calls} calls`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

/*
 * The supervisor is what makes "超过了就新开" observable: it aggregates every
 * unit of work so a caller can see what is running without joining the
 * subagent/task/turn streams by hand.
 */
test('Supervisor tracks units, aggregates totals, and notifies on change', () => {
  const supervisor = new Supervisor();
  const snapshots: number[] = [];
  supervisor.onChange = (snapshot) => snapshots.push(snapshot.units.length);

  supervisor.start({ kind: 'subagent', id: 'a', label: 'A' });
  supervisor.start({ kind: 'subagent', id: 'b', label: 'B' });
  supervisor.progress('subagent', 'a', 7);
  supervisor.finish('subagent', 'a', 'done', { steps: 7 });

  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.units.length, 2);
  assert.equal(snapshot.running, 1);
  assert.equal(snapshot.done, 1);
  assert.equal(snapshot.steps, 7);
  assert.equal(snapshot.longestRunningMs !== undefined, true);
  assert.ok(snapshots.length >= 4, 'every mutation must notify');
});

test('Supervisor keeps a task and a subagent with the same id apart', () => {
  const supervisor = new Supervisor();
  // Both delegation paths name their first unit `task_1`; collapsing them would
  // lose one of the two from the progress list.
  supervisor.start({ kind: 'task', id: 'task_1', label: '板任务' });
  supervisor.start({ kind: 'subagent', id: 'task_1', label: '子智能体' });
  supervisor.finish('subagent', 'task_1', 'done');

  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.units.length, 2);
  assert.equal(snapshot.done, 1);
  assert.equal(snapshot.running, 1);
});

test('Supervisor records a finish that had no matching start', () => {
  const supervisor = new Supervisor();
  // Adopting a run whose start was missed must not silently drop a real failure.
  supervisor.finish('subagent', 'orphan', 'failed', { error: 'boom' });
  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.units.length, 1);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.units[0].error, 'boom');
});

test('Supervisor tracks a rollover segment on the same unit', () => {
  const supervisor = new Supervisor();
  supervisor.start({ kind: 'subagent', id: 's1', label: '长任务', segment: 1 });
  supervisor.progress('subagent', 's1', 40);
  // Segment 2 is the same logical unit continuing in a new session.
  supervisor.start({ kind: 'subagent', id: 's1', label: '长任务', segment: 2, sessionId: 'sess_2' });

  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.units.length, 1, 'a rollover must not add a second row');
  assert.equal(snapshot.units[0].segment, 2);
  assert.equal(snapshot.units[0].sessionId, 'sess_2');
  assert.equal(snapshot.units[0].steps, 40, 'steps carry across the segment boundary');
  assert.equal(snapshot.units[0].startedAt <= Date.now(), true);
});

test('supervisor_status reports an empty session without inventing rows', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-supstatus-'));
  try {
    const { runtime } = await makeRuntime(workspace, { name: 'mock', model: 'mock', async complete() { return { actions: [] }; } } as never);
    const tool = createSupervisorStatusTool(runtime);
    const result = await tool.execute({} as never, { workspaceRoot: workspace, approval: 'auto' });
    assert.equal(result.ok, true);
    assert.match(result.output, /还没有任何受监控的工作单元/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('supervisor_status lists running units with steps and elapsed time', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-supstatus2-'));
  try {
    const { runtime } = await makeRuntime(workspace, { name: 'mock', model: 'mock', async complete() { return { actions: [] }; } } as never);
    const supervisor = supervisorFor(runtime);
    supervisor.start({ kind: 'subagent', id: 'worker', label: '重构 tasks 模块', expert: 'code_edit' });
    supervisor.progress('subagent', 'worker', 12);

    const tool = createSupervisorStatusTool(runtime);
    const result = await tool.execute({} as never, { workspaceRoot: workspace, approval: 'auto' });
    assert.equal(result.ok, true);
    assert.match(result.output, /运行中 1/);
    assert.match(result.output, /worker/);
    assert.match(result.output, /12 步/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

/*
 * A board task that ran must report how many steps it took. Showing 0 for a task
 * that clearly executed makes the progress view useless precisely when someone
 * is trying to tell whether work is happening.
 */
test('a board task records its step count on the supervisor', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-tasksteps-'));
  try {
    const { runtime, sessions, session } = await makeRuntime(workspace, {
      name: 'mock', model: 'mock',
      async complete() { return { actions: [{ type: 'message', content: 'TASK_DONE: 完成' }] }; },
    } as never);
    const { TaskBoardStore } = await import('../src/tasks/store.js');
    const { planBoardFromGoal } = await import('../src/tasks/planner.js');
    const { runTaskBoardLoop, confirmBoard } = await import('../src/tasks/runtime.js');

    const store = new TaskBoardStore(workspace);
    const board = planBoardFromGoal('分步实现任务板：规划、确认、执行');
    confirmBoard(board, new Date().toISOString());
    await store.save(board);
    session.taskRuntime = { boardId: board.id, mode: 'executing', lastSyncAt: new Date().toISOString() };

    const runTurn = async () => ({
      ok: true,
      finalAnswer: 'TASK_DONE: 完成',
      hadTerminalFailure: false,
      steps: 6,
    });

    await runTaskBoardLoop({
      board, store, sessions, session, runtime,
      runTurn,
      verifyEnabled: false,
      maxTasks: 1,
    } as never);

    const unit = supervisorFor(runtime).snapshot().units.find((u) => u.kind === 'task');
    assert.ok(unit, 'the task must appear on the supervisor');
    assert.equal(unit.steps, 6, 'the task turn reported 6 steps and the supervisor must show them');
    assert.equal(unit.status, 'done');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
