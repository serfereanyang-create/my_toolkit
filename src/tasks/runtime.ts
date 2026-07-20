import type { GitSafetyService } from '../git-safety/service.js';
import type { GitUnitContext, GitUnitOutcome } from '../git-safety/types.js';
import { formatMemories } from '../memory/format.js';
import { maybeRecordTaskMemory } from '../memory/record.js';
import { selectRelevantMemories } from '../memory/select.js';
import { ProjectMemoryStore } from '../memory/store.js';
import type { ProjectMemoryEntry } from '../memory/types.js';
import type { SessionRecord, SessionStore } from '../session/store.js';
import { detectTaskCompletion } from './completion.js';
import type { TaskBoardStore } from './store.js';
import type { TaskBoard, TaskItem, TaskRuntimeState } from './types.js';

export function nextRunnableTask(board: TaskBoard): TaskItem | undefined {
  if (board.status === 'cancelled' || board.status === 'completed') return undefined;
  if (board.tasks.some((task) => task.status === 'in_progress')) return undefined;

  return board.tasks.find((task) => {
    if (task.status !== 'pending') return false;
    return task.dependsOn.every((dep) => {
      const parent = board.tasks.find((item) => item.id === dep);
      return parent?.status === 'done' || parent?.status === 'skipped';
    });
  });
}

export function confirmBoard(board: TaskBoard, nowIso: string) {
  board.status = 'active';
  board.confirmedAt = nowIso;
  board.updatedAt = nowIso;
}

export function startTask(board: TaskBoard, taskId: string, nowIso: string) {
  const task = requireTask(board, taskId);
  if (task.status !== 'pending' && task.status !== 'blocked') {
    throw new Error(`Task ${taskId} cannot start from status ${task.status}`);
  }
  for (const item of board.tasks) {
    if (item.status === 'in_progress') item.status = 'pending';
  }
  task.status = 'in_progress';
  task.startedAt = nowIso;
  task.error = undefined;
  board.status = 'active';
  board.updatedAt = nowIso;
}

export function markTaskDone(board: TaskBoard, taskId: string, summary: string, nowIso: string) {
  const task = requireTask(board, taskId);
  task.status = 'done';
  task.resultSummary = summary;
  task.finishedAt = nowIso;
  task.error = undefined;
  board.updatedAt = nowIso;
  refreshBoardStatus(board);
}

export function markTaskBlocked(board: TaskBoard, taskId: string, error: string, nowIso: string) {
  const task = requireTask(board, taskId);
  task.status = 'blocked';
  task.error = error;
  task.finishedAt = nowIso;
  board.status = 'blocked';
  board.updatedAt = nowIso;
}

export function skipTask(board: TaskBoard, taskId: string, nowIso: string) {
  const task = requireTask(board, taskId);
  if (task.status === 'done') throw new Error(`Task ${taskId} is already done`);
  task.status = 'skipped';
  task.finishedAt = nowIso;
  task.error = undefined;
  board.updatedAt = nowIso;
  refreshBoardStatus(board);
}

export function reopenTask(board: TaskBoard, taskId: string, nowIso: string) {
  const task = requireTask(board, taskId);
  task.status = 'pending';
  task.error = undefined;
  task.resultSummary = undefined;
  task.startedAt = undefined;
  task.finishedAt = undefined;
  board.updatedAt = nowIso;
  if (board.status === 'blocked' || board.status === 'completed') board.status = 'active';
}

export function pauseRuntime(runtime: TaskRuntimeState, nowIso: string): TaskRuntimeState {
  return { ...runtime, mode: 'paused', lastSyncAt: nowIso };
}

export function formatBoard(board: TaskBoard) {
  const lines = [
    `board: ${board.id}`,
    `title: ${board.title}`,
    `status: ${board.status}`,
    `goal: ${board.goal}`,
    board.confirmedAt ? `confirmedAt: ${board.confirmedAt}` : undefined,
    'tasks:',
    ...board.tasks.map((task) => {
      const depends = task.dependsOn.length ? `; depends: ${task.dependsOn.join(', ')}` : '';
      const error = task.error ? `; error: ${task.error}` : '';
      const summary = task.resultSummary ? `; result: ${task.resultSummary}` : '';
      return `- [${task.status}] ${task.id} ${task.title}${depends}${summary}${error}`;
    }),
  ].filter((line): line is string => typeof line === 'string');
  return lines.join('\n');
}

export function buildTaskPrompt(board: TaskBoard, task: TaskItem, memories: ProjectMemoryEntry[] = []) {
  const completed = board.tasks
    .filter((item) => item.status === 'done' || item.status === 'skipped')
    .map((item) => `- ${item.id} ${item.title}: ${item.resultSummary ?? item.status}`)
    .join('\n');

  return [
    `You are executing one task from an approved project board.`,
    `Board goal: ${board.goal}`,
    `Current task: ${task.id} ${task.title}`,
    task.detail ? `Detail: ${task.detail}` : undefined,
    task.acceptance ? `Acceptance: ${task.acceptance}` : undefined,
    completed ? `Completed tasks:\n${completed}` : 'Completed tasks: none',
    memories.length > 0 ? formatMemories(memories) : undefined,
    `Focus only on this task.`,
    `When finished successfully, end with: TASK_DONE: <short summary>`,
    `If blocked, explain the blocker clearly.`,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

export type TaskTurnResult = {
  ok: boolean;
  reason?: string;
  finalAnswer?: string;
  hadTerminalFailure?: boolean;
  outcome?: GitUnitOutcome;
};

export async function runTaskBoardLoop(options: {
  board: TaskBoard;
  store: TaskBoardStore;
  sessions: SessionStore;
  session: SessionRecord;
  maxTasks?: number;
  runTurn: (prompt: string, gitSafetyUnit?: GitUnitContext) => Promise<TaskTurnResult>;
  onInfo?: (message: string) => void;
  gitSafety?: GitSafetyService;
  confirm?: (message: string) => Promise<boolean>;
}) {
  const maxTasks = options.maxTasks ?? options.board.tasks.length + 2;
  let executed = 0;
  const memoryStore = new ProjectMemoryStore(options.session.workspaceRoot);

  while (executed < maxTasks) {
    if (options.session.taskRuntime?.mode === 'paused') {
      options.onInfo?.('Task board auto-run paused.');
      return { ok: true, status: options.board.status };
    }

    const task = nextRunnableTask(options.board);
    if (!task) {
      refreshBoardStatus(options.board);
      await options.store.save(options.board);
      options.session.taskRuntime = {
        boardId: options.board.id,
        activeTaskId: undefined,
        mode: options.board.status === 'completed' ? 'idle' : 'paused',
        lastSyncAt: new Date().toISOString(),
      };
      await options.sessions.save(options.session);
      return { ok: options.board.status !== 'blocked', status: options.board.status };
    }

    const nowIso = new Date().toISOString();
    startTask(options.board, task.id, nowIso);
    options.session.taskRuntime = {
      boardId: options.board.id,
      activeTaskId: task.id,
      mode: 'executing',
      lastSyncAt: nowIso,
    };
    await options.store.save(options.board);
    await options.sessions.save(options.session);

    let memories: ProjectMemoryEntry[] = [];
    try {
      memories = selectRelevantMemories({
        entries: await memoryStore.list({ includeInactive: true }),
        goal: options.board.goal,
        taskTitle: task.title,
        taskDetail: task.detail,
      });
    } catch (error) {
      options.onInfo?.(`Project memory load failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    options.onInfo?.(`Running ${task.id}: ${task.title}`);
    const unit = options.gitSafety
      ? await options.gitSafety.startUnit({
        kind: 'task',
        sessionId: options.session.id,
        boardId: options.board.id,
        taskId: task.id,
      }, {
        confirm: options.confirm,
        onWarning: options.onInfo,
      })
      : undefined;

    let turn: TaskTurnResult;
    let outcome: GitUnitOutcome = 'done';
    try {
      turn = await options.runTurn(buildTaskPrompt(options.board, task, memories), unit);
      const completion = detectTaskCompletion({
        ok: turn.ok,
        finalAnswer: turn.finalAnswer ?? turn.reason ?? '',
        hadTerminalFailure: Boolean(turn.hadTerminalFailure) || turn.ok === false,
        error: turn.reason,
      });
      const doneAt = new Date().toISOString();

      if (completion.status === 'done') {
        markTaskDone(options.board, task.id, completion.summary, doneAt);
        await options.store.save(options.board);
        await maybeRecordTaskMemory({
          store: memoryStore,
          boardId: options.board.id,
          task: options.board.tasks.find((item) => item.id === task.id)!,
          onWarn: options.onInfo,
        });
        await options.sessions.save(options.session);
        outcome = turn.outcome ?? 'done';
        if (unit && options.gitSafety) await options.gitSafety.finishUnit(unit, outcome);
        executed += 1;
        continue;
      }

      markTaskBlocked(options.board, task.id, completion.error, doneAt);
      options.session.taskRuntime = {
        boardId: options.board.id,
        activeTaskId: task.id,
        mode: 'paused',
        lastSyncAt: doneAt,
      };
      await options.store.save(options.board);
      await maybeRecordTaskMemory({
        store: memoryStore,
        boardId: options.board.id,
        task: options.board.tasks.find((item) => item.id === task.id)!,
        onWarn: options.onInfo,
      });
      await options.sessions.save(options.session);
      options.onInfo?.(`Blocked on ${task.id}: ${completion.error}`);
      outcome = turn.outcome ?? (turn.hadTerminalFailure ? 'failed' : 'blocked');
      if (unit && options.gitSafety) await options.gitSafety.finishUnit(unit, outcome);
      return { ok: false, status: 'blocked' as const, reason: completion.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const doneAt = new Date().toISOString();
      markTaskBlocked(options.board, task.id, message, doneAt);
      options.session.taskRuntime = {
        boardId: options.board.id,
        activeTaskId: task.id,
        mode: 'paused',
        lastSyncAt: doneAt,
      };
      await options.store.save(options.board);
      await options.sessions.save(options.session);
      if (unit && options.gitSafety) await options.gitSafety.finishUnit(unit, 'failed');
      options.onInfo?.(`Blocked on ${task.id}: ${message}`);
      return { ok: false, status: 'blocked' as const, reason: message };
    }
  }

  return { ok: false, status: options.board.status, reason: 'Task board max task iterations reached' };
}

function refreshBoardStatus(board: TaskBoard) {
  if (board.tasks.some((task) => task.status === 'blocked')) {
    board.status = 'blocked';
    return;
  }
  const remaining = board.tasks.some((task) => task.status === 'pending' || task.status === 'in_progress');
  board.status = remaining ? 'active' : 'completed';
}

function requireTask(board: TaskBoard, taskId: string) {
  const task = board.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return task;
}
