import type { GitSafetyService } from '../git-safety/service.js';
import type { GitUnitContext, GitUnitOutcome } from '../git-safety/types.js';
import { formatMemories } from '../memory/format.js';
import { maybeRecordTaskMemory } from '../memory/record.js';
import { selectRelevantMemories } from '../memory/select.js';
import { ProjectMemoryStore } from '../memory/store.js';
import type { ProjectMemoryEntry } from '../memory/types.js';
import type { SessionRecord, SessionStore } from '../session/store.js';
import { CancelledError, supervisorFor } from '../agent/agent.js';
import { throwIfAborted } from '../utils/cancellation.js';
import { detectTaskCompletion } from './completion.js';
import type { TaskBoardStore } from './store.js';
import type { TaskBoard, TaskItem, TaskRuntimeState } from './types.js';
import { buildRepairPrompt, type VerifyRunner } from './verify.js';
import { verifyTask } from './verification-record.js';
import { inspectTaskGraph } from './graph.js';

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
    if (item && item.status === 'in_progress') item.status = 'pending';
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
  if (board.status === 'blocked' || board.status === 'completed' || board.status === 'cancelled') board.status = 'active';
  delete board.error;
}

export function pauseRuntime(runtime: TaskRuntimeState, nowIso: string): TaskRuntimeState {
  return { ...runtime, mode: 'paused', lastSyncAt: nowIso };
}

export function formatBoard(board: TaskBoard) {
  const lines = [
    `board: ${board.id}`,
    `title: ${board.title}`,
    `status: ${board.status}`,
    board.error ? `error: ${board.error}` : undefined,
    `goal: ${board.goal}`,
    board.confirmedAt ? `confirmedAt: ${board.confirmedAt}` : undefined,
    'tasks:',
    ...(Array.isArray(board.tasks) ? board.tasks : []).filter((task) => task && typeof task === 'object').map((task) => {
      const depends = Array.isArray(task.dependsOn) && task.dependsOn.length ? `; depends: ${task.dependsOn.join(', ')}` : '';
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
  /** Model round-trips the task's turn made, for the supervisor's step count. */
  steps?: number;
};

type TaskBoardLoopOptions = {
  signal?: AbortSignal;
  board: TaskBoard;
  store: TaskBoardStore;
  sessions: SessionStore;
  session: SessionRecord;
  runtime?: import('../agent/agent.js').AgentRuntime;
  maxTasks?: number;
  runTurn: (prompt: string, gitSafetyUnit?: GitUnitContext) => Promise<TaskTurnResult>;
  onInfo?: (message: string) => void;
  gitSafety?: GitSafetyService;
  confirm?: (message: string) => Promise<boolean>;
  verifyRunner?: VerifyRunner;
  verifyEnabled?: boolean;
  onUpdate?: (board: TaskBoard) => void;
};

type TaskBoardLoopResult = { ok: boolean; status: string; reason?: string; outcome?: GitUnitOutcome; finalAnswer?: string };

export async function runTaskBoardLoop(options: TaskBoardLoopOptions): Promise<TaskBoardLoopResult> {
  const runtime = options.runtime;
  const previousSignal = runtime?.requestSignal;
  const previousCancel = runtime?.cancelCurrentTurn;
  const controller = new AbortController();
  const signals = [controller.signal, previousSignal, options.signal].filter((signal): signal is AbortSignal => Boolean(signal));
  const signal = AbortSignal.any(signals);
  if (runtime) { runtime.requestSignal = signal; runtime.cancelCurrentTurn = () => controller.abort(new CancelledError()); }
  try {
    const result = await runControlledTaskBoardLoop({ ...options, signal });
    if (result.outcome === 'cancelled') controller.abort(new CancelledError());
    return result;
  } finally {
    try { if (signal.aborted) await runtime?.commandJobs?.settleCancellation?.(signal); }
    finally { if (runtime) { runtime.requestSignal = previousSignal; runtime.cancelCurrentTurn = previousCancel; } }
  }
}

function throwIfBoardCancelled(options: Pick<TaskBoardLoopOptions, 'signal' | 'runtime'>) {
  throwIfAborted(options.signal);
  if (options.runtime?.cancelRequested?.()) throw new CancelledError();
}

async function runControlledTaskBoardLoop(options: TaskBoardLoopOptions): Promise<TaskBoardLoopResult> {
  if (await options.store.isLeaseLive(options.board.id)) return { ok: false, status: 'busy', reason: '任务计划已有有效执行租约，未覆盖运行中的执行者。' };
  const graph = inspectTaskGraph(options.board.tasks);
  if (graph.issues.length) return blockUnrunnableBoard(options, graph.issues.join('；'));
  if (options.board.status === 'cancelled') {
    options.session.taskRuntime = { boardId: options.board.id, mode: 'paused', lastSyncAt: new Date().toISOString() };
    await options.sessions.save(options.session);
    options.onUpdate?.(options.board);
    return { ok: false, status: 'cancelled', outcome: 'cancelled', reason: '任务计划已取消，请明确重新打开需要执行的任务。' };
  }
  if (options.board.status === 'draft') return { ok: false, status: 'draft', reason: '任务计划尚未确认。' };
  if (options.board.status === 'completed' && options.board.tasks.some(task => task.status !== 'done' && task.status !== 'skipped')) return blockUnrunnableBoard(options, '任务计划的完成标记与未完成任务不一致，请重新打开任务后继续。');
  delete options.board.error;
  const maxTasks = options.maxTasks ?? options.board.tasks.length + 2;
  let executed = 0;
  const memoryStore = new ProjectMemoryStore(options.session.workspaceRoot);

  // 运行租约：让崩溃恢复能区分"本进程仍在执行"与"进程崩溃遗留"。
  // 租约在每个任务开始时刷新（pid + 时间戳），循环退出时清除。
  await options.store.writeLease(options.board.id, options.board.tasks.find((task) => task.status === 'in_progress')?.id ?? 'startup');
  try {
    return await runLoop();
  } finally {
    await options.store.clearLease(options.board.id);
  }

  async function runLoop(): Promise<TaskBoardLoopResult> {
  while (executed < maxTasks) {
    if (options.signal?.aborted || options.runtime?.cancelRequested?.()) {
      return pauseCancelledTask({ ...options, task: options.board.tasks.find(task => task.status === 'in_progress'), reason: '任务板已暂停，已完成的任务仍保留。' });
    }
    if (options.session.taskRuntime?.mode === 'paused') {
      options.onInfo?.('Task board auto-run paused.');
      return { ok: true, status: options.board.status };
    }

    const task = nextRunnableTask(options.board);
    if (!task) {
      refreshBoardStatus(options.board);
      if (options.board.status !== 'completed') {
        const unfinished = options.board.tasks.filter(item => item.status !== 'done' && item.status !== 'skipped');
        const detail = unfinished.map(item => `${item.id}（${item.status === 'cancelled' ? '已取消' : item.status === 'in_progress' ? '未结束的执行' : item.status === 'blocked' ? '已阻塞' : `等待依赖：${item.dependsOn.join('、')}`}）`).join('；');
        return blockUnrunnableBoard(options, `没有可执行任务，计划尚未完成：${detail}`);
      }
      await options.store.save(options.board);
      options.session.taskRuntime = {
        boardId: options.board.id,
        activeTaskId: undefined,
        mode: options.board.status === 'completed' ? 'idle' : 'paused',
        lastSyncAt: new Date().toISOString(),
      };
      await options.sessions.save(options.session);
      options.onUpdate?.(options.board);
      return { ok: true, status: 'completed' };
    }

    const nowIso = new Date().toISOString();
    startTask(options.board, task.id, nowIso);
    // Board tasks are units of work too: tracking them here is what lets the
    // supervisor answer "what is running" across both delegation paths.
    if (options.runtime) {
      supervisorFor(options.runtime).start({
        kind: 'task',
        id: task.id,
        label: task.title,
        parentId: options.board.id,
      });
    }
    options.session.taskRuntime = {
      boardId: options.board.id,
      activeTaskId: task.id,
      mode: 'executing',
      lastSyncAt: nowIso,
    };
    await options.store.writeLease(options.board.id, task.id);
    await options.store.save(options.board);
    await options.sessions.save(options.session);
    options.onUpdate?.(options.board);

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
    
    // 专家路由与工具集定制
    let expertRouting: import('../experts/types.js').ExpertRoutingResult | undefined;
    let savedTools: import('../tools/registry.js').ToolRegistry | undefined;
    let savedScope: import('../tools/scope.js').ResolvedToolScope | undefined;
    const previousAllTools = options.runtime?.allTools;
    const previousToolScope = options.runtime?.toolScope;
    const previousFloor = options.runtime?.sessionToolScopeFloor;
    const previousFilter = options.runtime?.toolFilter;
    
    if (options.runtime) {
      const { routeTaskToExpert } = await import('../experts/router.js');
      const { ToolRegistry } = await import('../tools/registry.js');
      
      expertRouting = routeTaskToExpert({
        task,
        board: options.board,
        workspaceRoot: options.session.workspaceRoot,
      });
      
      options.onInfo?.(`[Expert: ${expertRouting.profile.name}, confidence: ${expertRouting.confidence.toFixed(2)}]`);
      
      // 定制工具集
      const allTools = (options.runtime.allTools ?? options.runtime.tools).list();
      const expertTools = allTools.filter(expertRouting.profile.toolFilter);
      const expertToolRegistry = ToolRegistry.fromTools(expertTools);
      
      // 临时覆盖 runtime
      savedTools = options.runtime.tools;
      savedScope = options.runtime.resolvedToolScope;
      options.runtime.tools = expertToolRegistry;
      options.runtime.allTools = expertToolRegistry;
      options.runtime.toolFilter = tool => expertRouting!.profile.toolFilter(tool) && (previousFilter?.(tool) ?? true);
      if (expertRouting.profile.toolScopeOverride) {
        options.runtime.toolScope = expertRouting.profile.toolScopeOverride;
        options.runtime.resolvedToolScope = expertRouting.profile.toolScopeOverride;
      }
    }
    
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
    let unitFinished = false;
    try {
      throwIfBoardCancelled(options);
      // 构建任务 prompt，如果有专家则追加专家系统提示
      const basePrompt = buildTaskPrompt(options.board, task, memories);
      const taskPrompt = expertRouting
        ? `${basePrompt}\n\n${expertRouting.profile.systemPrompt}`
        : basePrompt;
      
      turn = await options.runTurn(taskPrompt, unit);
      // Recorded as soon as the turn returns: a task that later fails or blocks
      // still spent these steps, and a progress view that shows 0 for a task
      // which clearly ran is worse than showing nothing.
      if (options.runtime && typeof turn.steps === 'number') {
        supervisorFor(options.runtime).progress('task', task.id, turn.steps);
      }
      
      // 记录专家信息
      if (expertRouting) {
        task.expertId = expertRouting.profile.id;
        task.expertConfidence = expertRouting.confidence;
      }
      
      if (turn.outcome === 'cancelled') {
        return await pauseCancelledTask({
          board: options.board,
          store: options.store,
          sessions: options.sessions,
          session: options.session,
          task,
          unit,
          gitSafety: options.gitSafety,
          runtime: options.runtime,
          onInfo: options.onInfo,
          onUpdate: options.onUpdate,
          reason: turn.finalAnswer ?? '任务已暂停，继续执行时会从当前任务重新开始。',
        });
      }

      const completion = detectTaskCompletion({
        ok: turn.ok,
        finalAnswer: turn.finalAnswer ?? turn.reason ?? '',
        hadTerminalFailure: Boolean(turn.hadTerminalFailure) || turn.ok === false,
        error: turn.reason,
      });
      const doneAt = new Date().toISOString();
      throwIfBoardCancelled(options);

      if (completion.status === 'done') {
        const verified = await completeWithVerification({
          signal: options.signal,
          checkCancelled: () => throwIfBoardCancelled(options),
          unit,
          onUnitFinished: () => { unitFinished = true; },
          onUpdate: options.onUpdate,
          board: options.board,
          store: options.store,
          sessions: options.sessions,
          session: options.session,
          memoryStore,
          taskId: task.id,
          summary: completion.summary,
          runTurn: options.runTurn,
          onInfo: options.onInfo,
          gitSafety: options.gitSafety,
          confirm: options.confirm,
          verifyRunner: options.verifyRunner,
          verifyEnabled: options.verifyEnabled,
        });
        if (!verified.ok) {
          if (options.runtime) {
            supervisorFor(options.runtime).finish('task', task.id, 'failed', { error: verified.reason });
          }
          return { ok: false, status: 'blocked' as const, reason: verified.reason };
        }
        executed += 1;
        if (options.runtime) {
          supervisorFor(options.runtime).finish('task', task.id, 'done');
        }
        options.onUpdate?.(options.board);
        continue;
      }

      markTaskBlocked(options.board, task.id, completion.error, doneAt);
      if (options.runtime) {
        supervisorFor(options.runtime).finish('task', task.id, 'failed', { error: completion.error });
      }
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
      options.onUpdate?.(options.board);
      outcome = turn.outcome ?? (turn.hadTerminalFailure ? 'failed' : 'blocked');
      if (unit && options.gitSafety) await options.gitSafety.finishUnit(unit, outcome);
      return { ok: false, status: 'blocked' as const, reason: completion.error };
    } catch (error) {
      if (options.signal?.aborted || options.runtime?.cancelRequested?.() || (error instanceof Error && error.name === 'AgentCancelledError')) {
        return await pauseCancelledTask({
          board: options.board,
          store: options.store,
          sessions: options.sessions,
          session: options.session,
          task,
          unit: unitFinished ? undefined : unit,
          gitSafety: options.gitSafety,
          runtime: options.runtime,
          onInfo: options.onInfo,
          onUpdate: options.onUpdate,
          reason: '任务已暂停，继续执行时会从当前任务重新开始。',
        });
      }
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
      if (unit && options.gitSafety && !unitFinished) await options.gitSafety.finishUnit(unit, 'failed');
      options.onInfo?.(`Blocked on ${task.id}: ${message}`);
      return { ok: false, status: 'blocked' as const, reason: message };
    } finally {
      // 恢复原 tools/scope
      if (options.runtime && savedTools) {
        options.runtime.tools = savedTools;
        options.runtime.allTools = previousAllTools;
        options.runtime.toolFilter = previousFilter;
        options.runtime.toolScope = previousToolScope;
        options.runtime.sessionToolScopeFloor = previousFloor;
        options.runtime.resolvedToolScope = savedScope;
      }
      // Every exit from the turn — done, blocked, or thrown — must settle the
      // running unit. A task whose turn returns without `TASK_DONE` and then
      // throws used to leave `task:<id>` stuck at `running` in the supervisor
      // snapshot for the rest of the session. `finish` is idempotent once the
      // unit is settled; only a still-running one is closed here.
      if (options.runtime && task.status !== 'in_progress') {
        const supervisor = supervisorFor(options.runtime);
        const unit = supervisor.snapshot().units
          .find((candidate) => candidate.kind === 'task' && candidate.id === task.id);
        if (unit?.status === 'running') {
          supervisor.finish('task', task.id, task.status === 'done' ? 'done' : task.status === 'blocked' ? 'failed' : 'cancelled');
        }
      }
    }
  }

  return { ok: false, status: options.board.status, reason: 'Task board max task iterations reached' };
  }
}

async function blockUnrunnableBoard(options: TaskBoardLoopOptions, reason: string): Promise<TaskBoardLoopResult> {
  options.board.status = 'blocked';
  options.board.error = reason;
  options.board.updatedAt = new Date().toISOString();
  options.session.taskRuntime = { boardId: options.board.id, activeTaskId: Array.isArray(options.board.tasks) ? options.board.tasks.find(task => task && task.status !== 'done' && task.status !== 'skipped')?.id : undefined, mode: 'paused', lastSyncAt: options.board.updatedAt };
  await options.store.save(options.board);
  await options.sessions.save(options.session);
  options.onInfo?.(reason);
  options.onUpdate?.(options.board);
  return { ok: false, status: 'blocked', outcome: 'blocked', reason };
}

async function pauseCancelledTask(options: {
  board: TaskBoard;
  store: TaskBoardStore;
  sessions: SessionStore;
  session: SessionRecord;
  task?: TaskItem;
  unit?: GitUnitContext;
  gitSafety?: GitSafetyService;
  runtime?: import('../agent/agent.js').AgentRuntime;
  onInfo?: (message: string) => void;
  onUpdate?: (board: TaskBoard) => void;
  reason: string;
}) {
  const nowIso = new Date().toISOString();
  if (options.task && options.task.status !== 'done' && options.task.status !== 'skipped') {
    options.task.status = 'pending';
    options.task.error = undefined;
    options.task.finishedAt = undefined;
  }
  options.board.status = 'active';
  options.board.updatedAt = nowIso;
  options.session.taskRuntime = {
    boardId: options.board.id,
    activeTaskId: options.task?.id,
    mode: 'paused',
    lastSyncAt: nowIso,
  };
  if (options.unit && options.gitSafety) await options.gitSafety.finishUnit(options.unit, 'cancelled');
  if (options.runtime && options.task) supervisorFor(options.runtime).finish('task', options.task.id, 'cancelled');
  await options.store.save(options.board);
  await options.sessions.save(options.session);
  options.onInfo?.(`任务已暂停${options.task ? `：${options.task.title}` : ''}。${options.reason}`);
  options.onUpdate?.(options.board);
  return { ok: false as const, status: 'paused' as const, outcome: 'cancelled' as const, reason: options.reason, finalAnswer: options.reason };
}

async function completeWithVerification(options: {
  signal?: AbortSignal;
  checkCancelled: () => void;
  unit?: GitUnitContext;
  onUnitFinished: () => void;
  onUpdate?: (board: TaskBoard) => void;
  board: TaskBoard;
  store: TaskBoardStore;
  sessions: SessionStore;
  session: SessionRecord;
  memoryStore: ProjectMemoryStore;
  taskId: string;
  summary: string;
  runTurn: (prompt: string, gitSafetyUnit?: GitUnitContext) => Promise<TaskTurnResult>;
  onInfo?: (message: string) => void;
  gitSafety?: GitSafetyService;
  confirm?: (message: string) => Promise<boolean>;
  verifyRunner?: VerifyRunner;
  verifyEnabled?: boolean;
}) {
  const task = requireTask(options.board, options.taskId);
  // A builder/persistence gap (e.g. a renamed task) must not turn into an
  // unhandled rejection: `completeWithVerification` runs inside a `try` whose
  // own failure path calls `markTaskBlocked`, which would `requireTask` the same
  // missing id and loop. Fail the task board cleanly instead.
  if (!task) return { ok: false as const, reason: `Unknown task: ${options.taskId}` };
  const env = options.verifyEnabled === false
    ? { ...process.env, AICODE_VERIFY_TASKS: '0' }
    : process.env;

  const saveEvidence = async () => { await options.store.save(options.board); options.onUpdate?.(options.board); };
  const first = await verifyTask({
    task, phase: 'initial', onUpdate: saveEvidence,
    signal: options.signal,
    workspaceRoot: options.session.workspaceRoot,
    runner: options.verifyRunner,
    env,
  });
  options.checkCancelled();
  if (options.unit && options.gitSafety) { await options.gitSafety.finishUnit(options.unit, first.ok ? 'done' : 'failed'); options.onUnitFinished(); }
  options.checkCancelled();
  if (first.ok) {
    const doneAt = new Date().toISOString();
    const verified = first.results.some(check => check.status === 'passed');
    markTaskDone(options.board, task.id, `${options.summary} [${verified ? 'verified' : 'verification skipped'}]`, doneAt);
    await options.store.save(options.board);
    await maybeRecordTaskMemory({
      store: options.memoryStore,
      boardId: options.board.id,
      task: requireTask(options.board, task.id),
      onWarn: options.onInfo,
    });
    await options.sessions.save(options.session);
    options.onInfo?.(first.summary);
    return { ok: true as const };
  }

  options.onInfo?.(`Verification failed for ${task.id}; attempting one repair turn. ${first.summary}`);
  const repairUnit = options.gitSafety
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

  let repairUnitFinished = false;
  try {
    options.checkCancelled();
    const repairTurn = await options.runTurn(buildRepairPrompt(task, first), repairUnit);
    if (repairTurn.outcome === 'cancelled') throw new CancelledError();
    options.checkCancelled();
    const repairCompletion = detectTaskCompletion({
      ok: repairTurn.ok,
      finalAnswer: repairTurn.finalAnswer ?? repairTurn.reason ?? '',
      hadTerminalFailure: Boolean(repairTurn.hadTerminalFailure) || repairTurn.ok === false,
      error: repairTurn.reason,
    });
    if (repairCompletion.status !== 'done') {
      if (repairUnit && options.gitSafety) { await options.gitSafety.finishUnit(repairUnit, repairTurn.outcome ?? 'blocked'); repairUnitFinished = true; }
      const doneAt = new Date().toISOString();
      const reason = `${first.summary}; repair did not complete: ${repairCompletion.status === 'blocked' || repairCompletion.status === 'unclear' ? repairCompletion.error : 'unknown'}`;
      markTaskBlocked(options.board, task.id, reason, doneAt);
      options.session.taskRuntime = {
        boardId: options.board.id,
        activeTaskId: task.id,
        mode: 'paused',
        lastSyncAt: doneAt,
      };
      await options.store.save(options.board);
      await maybeRecordTaskMemory({
        store: options.memoryStore,
        boardId: options.board.id,
        task: requireTask(options.board, task.id),
        onWarn: options.onInfo,
      });
      await options.sessions.save(options.session);
      options.onInfo?.(`Blocked on ${task.id}: ${reason}`);
      return { ok: false as const, reason };
    }

    const second = await verifyTask({
      task, phase: 'repair', onUpdate: saveEvidence,
      signal: options.signal,
      workspaceRoot: options.session.workspaceRoot,
      runner: options.verifyRunner,
      env,
    });
    options.checkCancelled();
    const passedChecks = new Set(second.results.filter(check => check.status === 'passed').map(check => check.name));
    const missingChecks = first.results.filter(check => check.status === 'failed' && (check.name === 'configuration' ? !passedChecks.size : !passedChecks.has(check.name)));
    if (second.ok && missingChecks.length) {
      const attempt = task.verification?.at(-1);
      if (attempt) { attempt.status = 'incomplete'; attempt.summary = `Required checks did not pass after repair: ${missingChecks.map(check => check.name).join(', ')}`; await saveEvidence(); }
    }
    const repaired = second.ok && missingChecks.length === 0;
    if (repairUnit && options.gitSafety) { await options.gitSafety.finishUnit(repairUnit, repaired ? 'done' : 'failed'); repairUnitFinished = true; }
    options.checkCancelled();
    if (repaired) {
      const doneAt = new Date().toISOString();
      markTaskDone(options.board, task.id, `${repairCompletion.summary} [verified after repair]`, doneAt);
      await options.store.save(options.board);
      await maybeRecordTaskMemory({
        store: options.memoryStore,
        boardId: options.board.id,
        task: requireTask(options.board, task.id),
        onWarn: options.onInfo,
      });
      await options.sessions.save(options.session);
      options.onInfo?.(second.summary);
      return { ok: true as const };
    }

    const doneAt = new Date().toISOString();
    const reason = missingChecks.length && second.ok ? `Verification incomplete after repair: required checks did not pass (${missingChecks.map(check => check.name).join(', ')}).` : `${second.summary} (after one repair attempt)`;
    markTaskBlocked(options.board, task.id, reason, doneAt);
    options.session.taskRuntime = {
      boardId: options.board.id,
      activeTaskId: task.id,
      mode: 'paused',
      lastSyncAt: doneAt,
    };
    await options.store.save(options.board);
    await maybeRecordTaskMemory({
      store: options.memoryStore,
      boardId: options.board.id,
      task: requireTask(options.board, task.id),
      onWarn: options.onInfo,
    });
    await options.sessions.save(options.session);
    options.onInfo?.(`Blocked on ${task.id}: ${reason}`);
    return { ok: false as const, reason };
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AgentCancelledError')) {
      if (repairUnit && options.gitSafety && !repairUnitFinished) await options.gitSafety.finishUnit(repairUnit, 'cancelled');
      throw error;
    }
    if (repairUnit && options.gitSafety && !repairUnitFinished) {
      await options.gitSafety.finishUnit(repairUnit, 'failed');
    }
    const doneAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const reason = `${first.summary}; repair turn failed: ${message}`;
    markTaskBlocked(options.board, task.id, reason, doneAt);
    options.session.taskRuntime = {
      boardId: options.board.id,
      activeTaskId: task.id,
      mode: 'paused',
      lastSyncAt: doneAt,
    };
    await options.store.save(options.board);
    await options.sessions.save(options.session);
    options.onInfo?.(`Blocked on ${task.id}: ${reason}`);
    return { ok: false as const, reason };
  }
}

function refreshBoardStatus(board: TaskBoard) {
  if (board.status === 'cancelled') return;
  if (board.tasks.some((task) => task.status === 'blocked')) {
    board.status = 'blocked';
    return;
  }
  board.status = board.tasks.length > 0 && board.tasks.every(task => task.status === 'done' || task.status === 'skipped') ? 'completed' : 'active';
}

function requireTask(board: TaskBoard, taskId: string) {
  const task = board.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return task;
}
