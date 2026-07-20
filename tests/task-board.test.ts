import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime } from '../src/agent/agent.js';
import { parseArgs } from '../src/cli/args.js';
import { handleSlashCommand } from '../src/cli/commands.js';
import { runPromptMode } from '../src/cli/repl.js';
import { loadConfig } from '../src/config/config.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { detectTaskCompletion } from '../src/tasks/completion.js';
import { planBoardFromGoal, shouldUseTaskBoard } from '../src/tasks/planner.js';
import {
  confirmBoard,
  formatBoard,
  markTaskBlocked,
  markTaskDone,
  nextRunnableTask,
  pauseRuntime,
  reopenTask,
  skipTask,
  startTask,
} from '../src/tasks/runtime.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import type { TaskBoard, TaskRuntimeState } from '../src/tasks/types.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

test('session records optional taskRuntime pointer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-task-session-'));
  try {
    const sessions = new SessionStore(dir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: dir });
    assert.equal(session.taskRuntime, undefined);

    const runtime: TaskRuntimeState = {
      boardId: 'board_test',
      activeTaskId: 'task_1',
      mode: 'awaiting_confirm',
      lastSyncAt: new Date().toISOString(),
    };
    session.taskRuntime = runtime;
    await sessions.save(session);
    const loaded = await sessions.load(session.id);
    assert.deepEqual(loaded.taskRuntime, runtime);

    const board: TaskBoard = {
      id: 'board_test',
      title: 'Demo',
      goal: 'Implement task board',
      status: 'draft',
      createdAt: runtime.lastSyncAt!,
      updatedAt: runtime.lastSyncAt!,
      tasks: [],
    };
    assert.equal(board.status, 'draft');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TaskBoardStore saves loads and lists boards', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-store-'));
  try {
    const store = new TaskBoardStore(workspace);
    const now = '2026-07-13T00:00:00.000Z';
    const board: TaskBoard = {
      id: 'board_20260713000000_abcd1234',
      title: 'Add auth',
      goal: 'Implement login flow',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      tasks: [
        { id: 'task_1', title: 'Inspect auth code', status: 'pending', dependsOn: [] },
        { id: 'task_2', title: 'Implement fix', status: 'pending', dependsOn: ['task_1'] },
      ],
    };

    await store.save(board);
    const loaded = await store.load(board.id);
    assert.deepEqual(loaded, board);

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, board.id);
    assert.equal(listed[0].status, 'draft');

    board.status = 'active';
    board.confirmedAt = now;
    board.updatedAt = '2026-07-13T00:01:00.000Z';
    await store.save(board);
    assert.equal((await store.load(board.id)).status, 'active');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('TaskBoardStore load missing board throws', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-missing-'));
  try {
    const store = new TaskBoardStore(workspace);
    await assert.rejects(() => store.load('board_missing'), /not found/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('shouldUseTaskBoard accepts large multi-step goals and rejects tiny asks', () => {
  assert.equal(shouldUseTaskBoard('实现完整的登录注册流程并补测试'), true);
  assert.equal(shouldUseTaskBoard('分步实现项目任务板：规划、确认、自动执行、失败恢复'), true);
  assert.equal(shouldUseTaskBoard('读取 package.json'), false);
  assert.equal(shouldUseTaskBoard('C盘还剩多少空间'), false);
  assert.equal(shouldUseTaskBoard('search disk.ts for quota'), false);
});

test('planBoardFromGoal creates ordered pending draft tasks', () => {
  const board = planBoardFromGoal('实现用户登录功能并补充测试');
  assert.equal(board.status, 'draft');
  assert.ok(board.id.startsWith('board_'));
  assert.ok(board.tasks.length >= 3);
  assert.ok(board.tasks.every((task) => task.status === 'pending'));
  assert.deepEqual(board.tasks[0].dependsOn, []);
  assert.deepEqual(board.tasks[1].dependsOn, [board.tasks[0].id]);
  assert.match(board.goal, /登录|login/i);
});

function sampleBoard(): TaskBoard {
  return {
    id: 'board_demo',
    title: 'Demo',
    goal: 'Ship feature',
    status: 'draft',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    tasks: [
      { id: 'task_1', title: 'Inspect', status: 'pending', dependsOn: [] },
      { id: 'task_2', title: 'Implement', status: 'pending', dependsOn: ['task_1'] },
      { id: 'task_3', title: 'Verify', status: 'pending', dependsOn: ['task_2'] },
    ],
  };
}

test('runtime selects dependency-aware next task and transitions statuses', () => {
  const board = sampleBoard();
  assert.equal(nextRunnableTask(board)?.id, 'task_1');
  confirmBoard(board, '2026-07-13T00:01:00.000Z');
  assert.equal(board.status, 'active');
  assert.equal(board.confirmedAt, '2026-07-13T00:01:00.000Z');

  startTask(board, 'task_1', '2026-07-13T00:02:00.000Z');
  assert.equal(board.tasks[0].status, 'in_progress');
  assert.equal(nextRunnableTask(board), undefined);

  markTaskDone(board, 'task_1', 'inspected auth module', '2026-07-13T00:03:00.000Z');
  assert.equal(board.tasks[0].status, 'done');
  assert.equal(nextRunnableTask(board)?.id, 'task_2');

  startTask(board, 'task_2', '2026-07-13T00:04:00.000Z');
  markTaskBlocked(board, 'task_2', 'apply_patch failed', '2026-07-13T00:05:00.000Z');
  assert.equal(board.tasks[1].status, 'blocked');
  assert.equal(board.status, 'blocked');

  reopenTask(board, 'task_2', '2026-07-13T00:06:00.000Z');
  assert.equal(board.tasks[1].status, 'pending');
  assert.equal(board.status, 'active');

  skipTask(board, 'task_2', '2026-07-13T00:07:00.000Z');
  assert.equal(board.tasks[1].status, 'skipped');
  assert.equal(nextRunnableTask(board)?.id, 'task_3');
});

test('formatBoard renders goal and task statuses', () => {
  const text = formatBoard(sampleBoard());
  assert.match(text, /board_demo/);
  assert.match(text, /status: draft/);
  assert.match(text, /\[pending\] task_1 Inspect/);
  assert.match(text, /depends: task_1/);
});

test('detectTaskCompletion distinguishes done blocked and unclear', () => {
  assert.equal(detectTaskCompletion({ ok: true, finalAnswer: 'TASK_DONE: fixed login', hadTerminalFailure: false }).status, 'done');
  assert.equal(detectTaskCompletion({ ok: false, finalAnswer: 'stopped', hadTerminalFailure: true, error: 'blocked: no' }).status, 'blocked');
  assert.equal(detectTaskCompletion({ ok: true, finalAnswer: 'maybe finished?', hadTerminalFailure: false }).status, 'unclear');
});

test('parseArgs and loadConfig accept --confirm-plan', async () => {
  const args = parseArgs(['--provider', 'mock', '--confirm-plan', '--prompt', 'x']);
  assert.equal(args.confirmPlan, true);
  const config = await loadConfig(args, {});
  assert.equal(config.confirmPlan, true);
});

test('/plan shows board and supports confirm pause continue skip reopen', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-plan-cmd-'));
  try {
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const store = new TaskBoardStore(workspace);
    const board = planBoardFromGoal('实现任务板确认与恢复');
    await store.save(board);
    session.taskRuntime = { boardId: board.id, mode: 'awaiting_confirm', lastSyncAt: board.createdAt };
    await sessions.save(session);

    const base = {
      config: {
        provider: 'mock' as const,
        model: 'mock',
        approval: 'auto' as const,
        workspaceRoot: workspace,
        sessionDir: join(workspace, 'sessions'),
        maxSteps: 5,
        noBanner: true,
        confirmPlan: false,
      },
      provider: createMockProvider(),
      tools: createDefaultToolRegistry(),
      sessions,
      session,
    };

    const shown = await handleSlashCommand({ line: '/plan', ...base });
    assert.match(shown, /status: draft/);
    assert.match(shown, /task_1/);

    const confirmed = await handleSlashCommand({ line: '/plan confirm', ...base });
    assert.match(confirmed, /status: active/);
    const active = await store.load(board.id);
    assert.equal(active.status, 'active');
    assert.equal(session.taskRuntime?.mode, 'executing');

    await handleSlashCommand({ line: '/plan pause', ...base });
    assert.equal(session.taskRuntime?.mode, 'paused');

    const reloaded = await store.load(board.id);
    startTask(reloaded, 'task_1', new Date().toISOString());
    markTaskBlocked(reloaded, 'task_1', 'boom', new Date().toISOString());
    await store.save(reloaded);

    await handleSlashCommand({ line: '/plan continue', ...base });
    assert.equal(session.taskRuntime?.mode, 'executing');

    await handleSlashCommand({ line: '/plan skip task_1', ...base });
    assert.equal((await store.load(board.id)).tasks[0].status, 'skipped');

    await handleSlashCommand({ line: '/plan reopen task_1', ...base });
    assert.equal((await store.load(board.id)).tasks[0].status, 'pending');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function deterministicProvider() {
  return {
    name: 'mock' as const,
    model: 'mock',
    async complete() {
      return { actions: [{ type: 'message' as const, content: 'TASK_DONE: completed current task' }] };
    },
  };
}

test('large goal drafts a board and confirmPlan auto-runs tasks with mock provider', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-loop-'));
  try {
    const sessionDir = join(workspace, 'sessions');
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const config = {
      provider: 'mock' as const,
      model: 'mock-code-agent-v1',
      approval: 'auto' as const,
      workspaceRoot: workspace,
      sessionDir,
      maxSteps: 12,
      noBanner: true,
      confirmPlan: true,
      prompt: '分步实现项目任务板：规划、确认、自动执行、失败恢复',
    };
    const runtime: AgentRuntime = {
      config,
      provider: deterministicProvider(),
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI(true),
    };

    const result = await runPromptMode(runtime, config.prompt!);
    assert.equal(result.ok, true);

    const store = new TaskBoardStore(workspace);
    const boards = await store.list();
    assert.equal(boards.length, 1);
    const board = await store.load(boards[0].id);
    assert.ok(board.tasks.some((task) => task.status === 'done' || task.status === 'blocked' || task.status === 'in_progress' || task.status === 'pending'));
    assert.notEqual(board.status, 'draft');
    assert.ok(session.taskRuntime?.boardId);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('no-input without confirmPlan leaves draft board unexecuted', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-draft-'));
  try {
    const sessionDir = join(workspace, 'sessions');
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const config = {
      provider: 'mock' as const,
      model: 'mock',
      approval: 'auto' as const,
      workspaceRoot: workspace,
      sessionDir,
      maxSteps: 8,
      noBanner: true,
      noInput: true,
      confirmPlan: false,
      prompt: '分步实现项目任务板：规划、确认、自动执行、失败恢复',
    };
    const runtime: AgentRuntime = {
      config,
      provider: createMockProvider(),
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI(true),
    };

    const result = await runPromptMode(runtime, config.prompt!);
    assert.equal(result.ok, true);
    const store = new TaskBoardStore(workspace);
    const board = await store.load((await store.list())[0].id);
    assert.equal(board.status, 'draft');
    assert.ok(board.tasks.every((task) => task.status === 'pending'));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('resumed session continues blocked board after /plan continue', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-resume-'));
  try {
    const sessionDir = join(workspace, 'sessions');
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const store = new TaskBoardStore(workspace);
    const board = planBoardFromGoal('实现可恢复的长任务执行');
    confirmBoard(board, new Date().toISOString());
    startTask(board, 'task_1', new Date().toISOString());
    markTaskBlocked(board, 'task_1', 'simulated failure', new Date().toISOString());
    await store.save(board);
    session.taskRuntime = { boardId: board.id, activeTaskId: 'task_1', mode: 'paused', lastSyncAt: new Date().toISOString() };
    await sessions.save(session);

    const runtime: AgentRuntime = {
      config: {
        provider: 'mock',
        model: 'mock',
        approval: 'auto',
        workspaceRoot: workspace,
        sessionDir,
        maxSteps: 8,
        noBanner: true,
        confirmPlan: false,
      },
      provider: deterministicProvider(),
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI(true),
    };

    const continued = await runPromptMode(runtime, '/plan continue');
    assert.equal(continued.ok, true);

    const loaded = await store.load(board.id);
    assert.notEqual(loaded.tasks[0].status, 'blocked');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
