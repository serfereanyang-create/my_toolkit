import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { TaskBoardStore } from '../tasks/store.js';
import type { AgentRuntime } from '../agent/agent.js';
import { supervisorFor } from '../agent/agent.js';
import { prepareSubmittedUserTurn, runAutomationGoal, runGuardedAgentTurn, runPromptMode } from './repl.js';
import { DesktopApprovalBroker } from './approvalBroker.js';
import { createGuardConfirmationBroker } from './guardConfirmationBroker.js';
import { DesktopHostToolBroker, validateHostToolResult } from './hostToolBroker.js';
import { BACKGROUND_BROWSER_TOOL_NAMES, backgroundBrowserDownloadApprovalMessage, backgroundBrowserOpenApprovalMessage, createBackgroundBrowserTools } from '../tools/backgroundBrowser.js';
import { BACKGROUND_APP_TOOL_NAMES, createBackgroundAppTools } from '../tools/backgroundApp.js';
import { BACKGROUND_NATIVE_TOOL_NAMES, createBackgroundNativeTools } from '../tools/backgroundNative.js';
import type { ToolResult } from '../tools/types.js';
import type { ReasoningEffort } from '../providers/types.js';
import type { ToolScope } from '../tools/scope.js';

type BridgeCommand =
  | { type: 'user_message'; text: string; sessionId?: string; reasoningEffort?: ReasoningEffort; toolScope?: ToolScope; files?: Array<{ path: string; name: string; size: number }> }
  | { type: 'automation_task'; taskId: string; goal: string }
  | { type: 'approval_response'; requestId: string; decision: 'allow_once' | 'allow_session' | 'deny' }
  | { type: 'guard_confirmation_response'; requestId: string; selectedLabel: string }
  | { type: 'host_tool_response'; requestId: string; result: ToolResult }
  | { type: 'set_effort'; reasoningEffort: ReasoningEffort }
  | { type: 'set_tool_scope'; toolScope: ToolScope }
  | { type: 'cancel'; sessionId?: string }
  | { type: 'undo'; undoId: string; checkpointIds: string[] }
  | { type: 'shutdown' }
  | { type: 'task_board_action'; action: 'confirm' | 'pause' | 'continue' | 'skip' | 'reopen'; taskId?: string }
  | { type: 'ping' };

export type BridgeRunOptions = {
  /** Readable stream carrying newline-delimited bridge commands. Defaults to stdin. */
  input?: NodeJS.ReadableStream;
  /** Event sink. Defaults to writing newline-delimited JSON to stdout. */
  emit?: (event: Record<string, unknown>) => void;
  /**
   * Approval deadline in milliseconds. Tests inject a short value; production
   * falls back to the broker default (2 minutes). 0 disables the deadline.
   */
  approvalTimeoutMs?: number;
  /** Desktop host RPC deadline (60 seconds by default). */
  hostToolTimeoutMs?: number;
  /** Guard popup deadline; 0 keeps the old no-deadline test/embedding option. */
  guardTimeoutMs?: number;
};

/**
 * Run the CLI in desktop bridge mode.
 *
 * Wire protocol (both directions are newline-delimited JSON):
 *
 *   stdin  commands:  user_message, approval_response, cancel, shutdown, ping
 *   stdout events:    bridge_ready, turn_start, assistant_delta, assistant,
 *                     tool_start, tool_result, approval_needed, turn_done,
 *                     pong, cancel_ack, error, and all existing TerminalUI
 *                     `--json` events (info/final/model_start/model_end/...).
 *
 * The runner installs a `toolConfirm` on the runtime that emits
 * `approval_needed` events and blocks until the desktop shell posts a
 * matching `approval_response`. It reuses `runPromptMode` so slash commands
 * behave identically to the CLI REPL.
 *
 * `assistant_delta` and `assistant` carry the model text exactly as written —
 * markdown decorations and ``` fences included. The desktop transcript renders
 * markdown itself, and stripping it here (as the ANSI terminal path does) used
 * to flatten every streamed code block into prose the moment a turn finished.
 *
 * Injecting `input`/`emit` lets tests drive the whole bridge in-process; the
 * production entry passes nothing and uses stdin/stdout.
 */
/**
 * Build the `task_board_updated` payload.
 *
 * The renderer stores this payload as a board object and reads the id as
 * `board.id`, while the event contract named it `boardId`. Both keys are sent so
 * neither reader breaks; a missing `id` silently disabled the renderer's
 * startedAt preservation, resetting the elapsed timer on every update.
 */
export function taskBoardEventPayload(
  board: {
    id?: unknown;
    title?: unknown;
    goal?: unknown;
    status?: unknown;
    error?: unknown;
    planMarkdown?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    tasks?: unknown;
  },
  options: { sessionId: string; runtimeMode: string; activeTaskId?: string },
) {
  const tasks = Array.isArray(board.tasks) ? board.tasks : [];
  const boardId = typeof board.id === 'string' ? board.id : undefined;
  return {
    type: 'task_board_updated' as const,
    sessionId: options.sessionId,
    id: boardId,
    boardId,
    title: board.title,
    goal: board.goal,
    status: board.status,
    ...(typeof board.error === 'string' ? { error: board.error } : {}),
    runtimeMode: options.runtimeMode,
    activeTaskId: tasks.find((task: any) => task?.status === 'in_progress')?.id ?? (options.runtimeMode === 'paused' ? tasks.find((task: any) => task?.id === options.activeTaskId)?.id : undefined),
    planMarkdown: typeof board.planMarkdown === 'string' ? board.planMarkdown : undefined,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    tasks,
  };
}

export async function runDesktopBridge(runtime: AgentRuntime, options: BridgeRunOptions = {}) {
  const emitEvent = options.emit ?? emit;
  const broker = new DesktopApprovalBroker(runtime.session.id, { emit: emitEvent, timeoutMs: options.approvalTimeoutMs });
  runtime.toolConfirm = (message, request) => {
    if (request?.tool === 'background_app_open') {
      const appMessage = `在后台运行工作区 Electron 项目：${String(request.input.path ?? '')}。执行真实项目代码，使用独立数据目录，不显示应用窗口。`;
      return broker.confirm(appMessage, { ...request, message: appMessage });
    }
    if (request?.tool === 'background_browser_open') {
      const browserMessage = backgroundBrowserOpenApprovalMessage(request.input);
      return broker.confirm(browserMessage, { ...request, message: browserMessage });
    }
    if (request?.tool === 'background_browser_download') {
      // "网络请求" is the wrong question for a download: what the user is
      // deciding is whether an arbitrary file from a site may land in their
      // workspace. Name the source and say the file is treated as data.
      const downloadMessage = backgroundBrowserDownloadApprovalMessage(request.input);
      return broker.confirm(downloadMessage, { ...request, message: downloadMessage });
    }
    return broker.confirm(message, request);
  };
  const hostBroker = new DesktopHostToolBroker(runtime.session.id, {
    emit: emitEvent,
    timeoutMs: options.hostToolTimeoutMs,
    allowedTools: new Set([...BACKGROUND_BROWSER_TOOL_NAMES, ...BACKGROUND_APP_TOOL_NAMES, ...BACKGROUND_NATIVE_TOOL_NAMES]),
  });
  const backgroundBrowserEnabled = runtime.config.backgroundBrowser === true || runtime.config.backgroundBrowserOnly === true;
  if (backgroundBrowserEnabled) {
    runtime.hostToolInvoke = hostBroker.request;
    // Keep the complete source registry stable even after agent.ts replaces the
    // per-turn scoped registry. Post-scope injection uses these exact names.
    runtime.allTools ??= runtime.tools;
    for (const tool of [...createBackgroundBrowserTools(hostBroker.request), ...createBackgroundAppTools(hostBroker.request), ...createBackgroundNativeTools(hostBroker.request)]) {
      runtime.allTools.register(tool, { replace: true });
      if (runtime.tools !== runtime.allTools) runtime.tools.register(tool, { replace: true });
    }
  }
  // The lazy-dev guard asks the same way: popup first, terminal fallback. The
  // channel stays undefined for headless runs so the guard degrades to text.
  const guardBroker = createGuardConfirmationBroker({ sessionId: runtime.session.id, emit: emitEvent, timeoutMs: options.guardTimeoutMs });
  runtime.guardConfirmation = guardBroker;
  // Cooperative cancel. A denied approval is NOT a terminal failure (the model
  // may propose another way), so a turn cannot be stopped by the deny itself.
  // Turn-level aborts — an explicit `cancel`, or EOF while a turn is in flight —
  // set this flag instead, and the agent loop honors it at the next safe
  // boundary. Without it, denying pending approvals on shutdown would let the
  // turn keep running (and keep prompting) after nobody is left to answer.
  let cancelRequested = false;
  runtime.cancelRequested = () => cancelRequested;
  runtime.taskBoardEmit = (board: any) => {
    emitEvent(taskBoardEventPayload(board ?? {}, {
      sessionId: runtime.session.id,
      runtimeMode: runtime.session.taskRuntime?.mode ?? 'idle',
      activeTaskId: runtime.session.taskRuntime?.activeTaskId,
    }));
  };
  // Context compaction divider (Codex "正在压缩上下文 / 上下文已自动压缩").
  // The renderer keeps the 'started' row pending until completed/failed arrives.
  runtime.compactEmit = (payload) => {
    emitEvent({ type: 'context_compaction', sessionId: runtime.session.id, ...payload });
  };
  // A finished code review, as structured findings. The review is also written
  // into session history (review/writeback.ts) so the next turn can act on it;
  // this event is what lets the 审查 tab render it without parsing prose.
  runtime.reviewEmit = (payload) => {
    emitEvent({ type: 'review_report', sessionId: runtime.session.id, ...payload });
  };
  // Subagent runs feed the desktop 子智能体目录. `sessionId` here is the PARENT
  // session — the subagent's own session id travels as `subSessionId` — so the
  // directory can group runs per conversation.
  runtime.subagentEmit = (payload) => {
    emitEvent({
      type: payload.phase === 'done' ? 'subagent_done' : 'subagent_started',
      sessionId: runtime.session.id,
      ...payload,
    });
  };
  // One aggregate progress event per unit-of-work change, so the desktop can show
  // "what is running and is any of it stuck" without reconstructing it from the
  // subagent/task/turn streams. Emitted on every start/finish, which is low
  // volume — the supervisor's own state is the coalescing layer.
  const supervisor = supervisorFor(runtime);
  supervisor.onChange = (snapshot) => {
    emitEvent({ type: 'supervisor_updated', sessionId: runtime.session.id, ...snapshot });
  };

  if (runtime.session.taskRuntime?.boardId) {
    try { runtime.taskBoardEmit(await new TaskBoardStore(runtime.config.workspaceRoot).load(runtime.session.taskRuntime.boardId)); }
    catch (error) { emitEvent({ type: 'info', sessionId: runtime.session.id, message: `无法恢复任务计划：${errorMessage(error)}` }); }
  }

  emitEvent({
    type: 'bridge_ready',
    sessionId: runtime.session.id,
    provider: runtime.provider.name,
    model: runtime.provider.model,
    approval: runtime.config.approval,
    workspaceRoot: runtime.config.workspaceRoot,
  });

  const rl = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
  let busy = false;
  /**
   * Messages that arrived while a turn was running, in submission order.
   *
   * The desktop queues on its side too, so this catches the race between the
   * status flip and the send. Dropping them (the old behaviour) lost whatever
   * the user had typed.
   */
  const pendingMessages: Array<Extract<BridgeCommand, { type: 'user_message' }>> = [];
  let shuttingDown = false;
  /**
   * The in-flight turn, plus every message queued behind it.
   *
   * It runs detached from the read loop so that `approval_response` lines can
   * still be read and delivered to the broker while a turn is awaiting an
   * interactive approval. Awaiting the turn inside the loop would deadlock: the
   * turn blocks on an approval that can only arrive on a line this same loop
   * must read.
   *
   * `startTurn` is its ONLY writer. Every turn entry point — a user message, a
   * task-board action, an automation goal — goes through it, so `busy` and
   * `pendingMessages` have one owner. Two owners is what let a queued message be
   * dropped when a turn finished while the other drain was still in flight.
   */
  let activeTurn: Promise<void> = Promise.resolve();

  function resetTurnCancellation() {
    cancelRequested = false;
    hostBroker.resume();
    guardBroker.resume();
  }

  function cancelActiveWork() {
    cancelRequested = true;
    runtime.cancelCurrentTurn?.();
    hostBroker.cancelAll('已取消当前执行');
    guardBroker.cancelAll('已取消当前执行');
    broker.denyAll('已取消当前执行');
    const queued = pendingMessages.splice(0);
    emitEvent({
      type: 'cancel_ack', sessionId: runtime.session.id, cancelId: `cancel_${randomUUID()}`,
      ...(queued.length ? { queued: queued.map(message => ({ text: message.text, ...(message.files?.length ? { files: message.files } : {}) })) } : {}),
      note: 'The active turn is being cancelled; the bridge remains available.',
    });
  }

  function runUserMessage(command: Extract<BridgeCommand, { type: 'user_message' }>) {
    const filePaths = (command.files ?? []).map((file) => file.path).filter((value) => value.trim());
    return handleUserMessage(command, runtime, filePaths, emitEvent);
  }

  /** One tracked promise owns the original turn AND every queued turn. */
  function startTurn(work: () => Promise<void>) {
    resetTurnCancellation();
    busy = true;
    activeTurn = (async () => {
      let nextWork: (() => Promise<void>) | undefined = work;
      try {
        // Compare against undefined explicitly: after the assignment at the end
        // of the body TypeScript narrows the union away, and `nextWork &&` then
        // reads as a function that is always defined.
        while (nextWork !== undefined && !shuttingDown) {
          try {
            await nextWork();
          } catch (error) {
            // Preparation/file errors occur before handleUserMessage's own
            // try block. Never let a detached rejection kill the read loop.
            emitEvent({ type: 'error', sessionId: runtime.session.id, message: errorMessage(error) });
            emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'error', reason: errorMessage(error) });
          }
          if (shuttingDown) break;
          const next = pendingMessages.shift();
          if (!next) break;
          resetTurnCancellation();
          nextWork = () => runUserMessage(next);
        }
      } finally {
        busy = false;
      }
    })();
  }

  function stopBridge() {
    shuttingDown = true;
    pendingMessages.length = 0;
    cancelRequested = true;
    runtime.cancelCurrentTurn?.();
    broker.denyAll('桥接正在关闭');
    guardBroker.close('桥接正在关闭');
    hostBroker.close('桥接正在关闭');
  }

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let command: BridgeCommand;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        emitEvent({ type: 'error', sessionId: runtime.session.id, message: `Invalid bridge JSON: ${errorMessage(error)}` });
        continue;
      }
      try {
        command = validateBridgeCommand(parsed);
      } catch (error) {
        emitEvent({ type: 'error', sessionId: runtime.session.id, message: `Invalid bridge command: ${errorMessage(error)}` });
        continue;
      }

      if (command.type === 'shutdown') {
        stopBridge();
        break;
      }
      if (command.type === 'ping') {
        emitEvent({ type: 'pong', sessionId: runtime.session.id });
        continue;
      }
      if (command.type === 'approval_response') {
        broker.resolve(command.requestId, command.decision);
        continue;
      }
      if (command.type === 'host_tool_response') {
        // Unknown/late/duplicate responses are ignored, never queued for a
        // future call. Strict validation above leaves malformed replies pending
        // so the host may correct them before the same deadline.
        hostBroker.resolve(command.requestId, command.result);
        continue;
      }
      if (command.type === 'guard_confirmation_response') {
        // Same round-trip as approvals: the renderer answers the guard dialog
        // and the pending confirm() promise resolves with the picked label.
        if (!guardBroker.resolveFromDesktop(command.requestId, command.selectedLabel)) {
          emitEvent({ type: 'error', sessionId: runtime.session.id, message: 'Unknown or invalid guard confirmation response' });
        }
        continue;
      }
      if (command.type === 'set_effort') {
        // Live-update the reasoning effort for subsequent turns without
        // respawning the child. Applied to the runtime the agent loop reads.
        runtime.reasoningEffort = command.reasoningEffort;
        emitEvent({ type: 'effort_set', sessionId: runtime.session.id, reasoningEffort: command.reasoningEffort });
        continue;
      }
      if (command.type === 'task_board_action') {
        emitEvent({ type: 'info', sessionId: runtime.session.id, message: `任务计划操作：${command.action}${command.taskId ? ` ${command.taskId}` : ''}` });
        // TaskBoard command execution is routed through the existing slash-command
        // implementation to keep one authoritative state machine.
        const slash = command.action === 'confirm' ? '/plan confirm'
          : command.action === 'pause' ? '/plan pause'
          : command.action === 'continue' ? '/plan continue'
          : command.action === 'skip' ? `/plan skip ${command.taskId ?? ''}`
          : `/plan reopen ${command.taskId ?? ''}`;
        if (busy && command.action === 'pause' && runtime.session.taskRuntime?.mode === 'executing') { cancelActiveWork(); continue; }
        if (busy) { emitEvent({ type: 'error', sessionId: runtime.session.id, message: '当前操作仍在执行，请先暂停后再修改任务计划。' }); continue; }
        startTurn(async () => {
          // A slash command's outcome is not a single turn result, so activity
          // is measured by what the session actually did. `/plan confirm` starts
          // a board and genuinely works; `/plan` alone only prints a board and
          // does not.
          const callsBefore = runtime.session.toolCalls.length;
          const boardBefore = runtime.session.taskRuntime?.mode;
          try {
            const result = await runPromptMode(runtime, slash);
            // Pair the renderer-facing turn lifecycle: runPromptMode may run
            // agent turns internally (each emitting its own turn_start) but
            // never emits turn_done itself. Without this the UI would keep a
            // turn card "running" forever after a task-board action.
            const changed = runtime.session.toolCalls.length > callsBefore
              || runtime.session.taskRuntime?.mode !== boardBefore;
            const status = completionStatus(runtime, result);
            emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status, ...(status === 'cancelled' ? { cancelledReply: result.finalAnswer ?? '任务板已暂停，继续执行时会从当前任务重新开始。' } : {}), reason: result.reason, producedActivity: changed });
          } catch (error) {
            if (runtime.cancelRequested?.() || runtime.requestSignal?.aborted) {
              emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'cancelled', cancelledReply: '任务板已暂停，继续执行时会从当前任务重新开始。' });
              return;
            }
            emitEvent({ type: 'error', sessionId: runtime.session.id, message: errorMessage(error) });
            emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'error', reason: errorMessage(error) });
          }
        });
        continue;
      }
      if (command.type === 'set_tool_scope') {
        runtime.toolScope = command.toolScope;
        // The session floor exists to stop the scope drifting on its own, not to
        // override the user. Clear it so an explicit pick takes effect
        // immediately instead of being widened back by the previous turns.
        runtime.sessionToolScopeFloor = undefined;
        emitEvent({ type: 'tool_scope_set', sessionId: runtime.session.id, toolScope: command.toolScope });
        continue;
      }
      if (command.type === 'cancel') {
        // Stop the in-flight turn at its next safe boundary, then deny pending
        // approvals so nothing is left waiting on an answer that can no longer
        // arrive. The desktop may still kill the child; this makes the cancel
        // itself take effect even when it does not.
        cancelActiveWork();
        continue;
      }
      if (command.type === 'undo') {
        // Revert one turn's worth of file writes by their checkpoint ids. This
        // uses the real CheckpointStore backups, so files are restored to their
        // exact pre-turn state (or deleted if they were newly created).
        try {
          const outcome = runtime.checkpoints
            ? await runtime.checkpoints.undoByIds(command.checkpointIds)
            : { reverted: 0, files: [] as string[] };
          emitEvent({
            type: 'undo_done',
            sessionId: runtime.session.id,
            undoId: command.undoId,
            ok: outcome.reverted > 0,
            reverted: outcome.reverted,
            files: outcome.files,
          });
        } catch (error) {
          emitEvent({ type: 'undo_done', sessionId: runtime.session.id, undoId: command.undoId, ok: false, reverted: 0, files: [], message: errorMessage(error) });
        }
        continue;
      }
      if (command.type === 'automation_task') {
        if (busy) {
          emitEvent({ type: 'automation_done', sessionId: runtime.session.id, taskId: command.taskId, status: 'busy', reason: 'Agent turn already running' });
          continue;
        }
        startTurn(async () => {
          // `automation_start` is not the renderer-facing turn marker, so it is
          // emitted here rather than by startTurn. Everything after it — the
          // busy flag, cancellation reset, error → turn_done pairing, and
          // draining the message queue afterwards — is startTurn's job, which is
          // why this is not a detached promise of its own any more: two owners
          // of `busy` and `pendingMessages` is how a queued message got dropped.
          emitEvent({ type: 'automation_start', sessionId: runtime.session.id, taskId: command.taskId, goal: command.goal });
          try {
            const result = await runAutomationGoal(runtime, command.goal);
            emitEvent({
              type: 'automation_done',
              sessionId: runtime.session.id,
              taskId: command.taskId,
              status: completionStatus(runtime, result),
              reason: result.reason,
            });
            // Same pairing rationale as task_board_action: the automation goal
            // runs agent turns internally; close the renderer-facing turn here.
            emitEvent({
              type: 'turn_done',
              sessionId: runtime.session.id,
              status: completionStatus(runtime, result),
              ...(completionStatus(runtime, result) === 'cancelled' ? { cancelledReply: result.finalAnswer } : {}),
              reason: result.ok ? result.reason : (result.reason ?? '自动化任务失败，但没有返回具体原因。'),
              producedActivity: result.producedActivity === true,
            });
          } catch (error) {
            emitEvent({ type: 'automation_done', sessionId: runtime.session.id, taskId: command.taskId, status: 'error', reason: errorMessage(error) });
            emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'error', reason: errorMessage(error) });
          }
        });
        continue;
      }
      if (command.type === 'user_message') {
        if (busy) {
          // Queue it rather than dropping it. The desktop already queues while a
          // turn runs, so this is the race case: the status flip and the send
          // are separate messages, and a message that arrives in the gap used to
          // be rejected outright with "Agent turn already running" — losing
          // whatever the user typed.
          pendingMessages.push(command);
          emitEvent({
            type: 'info',
            sessionId: runtime.session.id,
            message: `当前回合进行中，已排队第 ${pendingMessages.length} 条消息。`,
          });
          continue;
        }
        startTurn(() => runUserMessage(command));
        continue;
      }
    }

    // The read loop ended (EOF or `shutdown`). Deny any approvals still pending
    // BEFORE awaiting the turn — otherwise a turn blocked on an approval that
    // can never be answered would keep `await activeTurn` (and this process)
    // alive forever.
    shuttingDown = true;
    pendingMessages.length = 0;
    cancelRequested = true;
    runtime.cancelCurrentTurn?.();
    broker.denyAll('桥接正在关闭');
    // Let any in-flight turn settle before tearing down stdin on EOF/shutdown.
    await activeTurn;
  } finally {
    // Closing readline releases the loop so a `shutdown` command (or EOF) lets
    // the child process exit cleanly. Only pause/unref the REAL stdin — test
    // streams must stay untouched for the caller.
    rl.close();
    if ((options.input ?? process.stdin) === process.stdin) {
      process.stdin.pause();
      if (typeof process.stdin.unref === 'function') process.stdin.unref();
    }
  }
}

/**
 * Desktop-side bridge turn handler. The approval broker itself lives in
 * `approvalBroker.ts` so its timeout/denyAll/session-scope behavior is unit
 * testable without a real bridge process.
 */
async function handleUserMessage(command: Extract<BridgeCommand, { type: 'user_message' }>, runtime: AgentRuntime, filePaths: string[], emitEvent: (event: Record<string, unknown>) => void) {
  if (command.reasoningEffort) runtime.reasoningEffort = command.reasoningEffort;
  if (command.toolScope) {
    runtime.toolScope = command.toolScope;
    // Same reasoning as set_tool_scope: an explicit per-message choice is the
    // user's, so drop the session floor rather than widening it back.
    runtime.sessionToolScopeFloor = undefined;
  }
  const submission = await prepareSubmittedUserTurn(runtime, command.text, filePaths);
  emitEvent({ type: 'turn_start', sessionId: runtime.session.id, prompt: submission.displayText ?? submission.prompt });
  if (submission.attachments.length > 0) emitEvent({ type: 'info', sessionId: runtime.session.id, message: `Attached ${submission.attachments.length} file(s): ${submission.attachments.map((item) => item.name).join(', ')}` });
  try {
    const result = submission.prompt.startsWith('/')
      ? await runPromptMode(runtime, submission.prompt)
      : await runGuardedAgentTurn(runtime, submission.prompt, { parts: submission.parts, displayText: submission.displayText });
    // A failed turn always carries a reason. `result.reason` can be undefined
    // even when ok is false, and an unexplained failure is the one thing the
    // user cannot act on.
    emitEvent({
      type: 'turn_done',
      sessionId: runtime.session.id,
      status: completionStatus(runtime, result),
      ...(completionStatus(runtime, result) === 'cancelled' ? { cancelledReply: result.finalAnswer } : {}),
      reason: result.ok ? result.reason : (result.reason ?? result.finalAnswer ?? '本轮执行失败，但没有返回具体原因。'),
      // `ok` is an execution-liveness status, not a success one: a model that
      // answers a question or declines a request ends the turn with ok and no
      // work done. The renderer needs this to avoid announcing 任务完成 for a
      // turn that changed nothing.
      producedActivity: result.producedActivity === true,
    });
  } catch (error) {
    if (runtime.cancelRequested?.() || runtime.requestSignal?.aborted) {
      emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'cancelled', cancelledReply: '本轮已停止，已完成的操作和输出仍保留。' });
      return;
    }
    emitEvent({ type: 'error', sessionId: runtime.session.id, message: errorMessage(error) });
    emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'error', reason: errorMessage(error) });
  }
}

function emit(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function completionStatus(runtime: AgentRuntime, result: { ok: boolean; outcome?: unknown }): 'ok' | 'error' | 'cancelled' {
  return result.outcome === 'cancelled' || runtime.cancelRequested?.() ? 'cancelled' : result.ok ? 'ok' : 'error';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const REASONING_EFFORTS: ReadonlySet<string> = new Set(['auto', 'off', 'low', 'medium', 'high', 'max']);
const TOOL_SCOPES: ReadonlySet<string> = new Set(['auto', 'compact', 'standard', 'full']);
const TASK_BOARD_ACTIONS: ReadonlySet<string> = new Set(['confirm', 'pause', 'continue', 'skip', 'reopen']);
const APPROVAL_DECISIONS: ReadonlySet<string> = new Set(['allow_once', 'allow_session', 'deny']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (!options.allowEmpty && value.trim() === '') throw new Error(`${field} must not be empty`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, { allowEmpty: true });
}

function requireMember(value: unknown, allowed: ReadonlySet<string>, field: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${field} must be one of: ${[...allowed].join(', ')}`);
  }
  return value;
}

/**
 * Validate one decoded bridge line.
 *
 * The bridge is an IPC boundary, so an unknown `type` is rejected rather than
 * ignored: a line this process cannot honour is a version or wiring bug, and
 * silently dropping it looks to the user like the app doing nothing.
 *
 * `host_tool_response` is validated here and *before* the broker sees it, so a
 * malformed reply throws while the request is still pending. That ordering is
 * the point: a host that answered badly can send a corrected reply within the
 * same deadline, instead of the tool call failing on the spot.
 */
export function validateBridgeCommand(value: unknown): BridgeCommand {
  if (!isRecord(value)) throw new Error('command must be an object');
  const type = requireString(value.type, 'type');

  switch (type) {
    case 'user_message': {
      const text = requireString(value.text, 'text', { allowEmpty: true });
      const command: Extract<BridgeCommand, { type: 'user_message' }> = { type, text };
      const sessionId = optionalString(value.sessionId, 'sessionId');
      if (sessionId !== undefined) command.sessionId = sessionId;
      if (value.reasoningEffort !== undefined) {
        command.reasoningEffort = requireMember(value.reasoningEffort, REASONING_EFFORTS, 'reasoningEffort') as ReasoningEffort;
      }
      if (value.toolScope !== undefined) {
        command.toolScope = requireMember(value.toolScope, TOOL_SCOPES, 'toolScope') as ToolScope;
      }
      if (value.files !== undefined) {
        if (!Array.isArray(value.files)) throw new Error('files must be an array');
        command.files = value.files.map((file, index) => {
          if (!isRecord(file)) throw new Error(`files[${index}] must be an object`);
          const path = requireString(file.path, `files[${index}].path`);
          return {
            path,
            name: typeof file.name === 'string' && file.name ? file.name : path.split(/[\\/]/).pop() ?? path,
            size: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0,
          };
        });
      }
      return command;
    }
    case 'automation_task':
      return { type, taskId: requireString(value.taskId, 'taskId'), goal: requireString(value.goal, 'goal', { allowEmpty: true }) };
    case 'approval_response':
      return {
        type,
        requestId: requireString(value.requestId, 'requestId'),
        decision: requireMember(value.decision, APPROVAL_DECISIONS, 'decision') as 'allow_once' | 'allow_session' | 'deny',
      };
    case 'guard_confirmation_response':
      return { type, requestId: requireString(value.requestId, 'requestId'), selectedLabel: requireString(value.selectedLabel, 'selectedLabel') };
    case 'host_tool_response':
      return { type, requestId: requireString(value.requestId, 'requestId'), result: validateHostToolResult(value.result) };
    case 'set_effort':
      return { type, reasoningEffort: requireMember(value.reasoningEffort, REASONING_EFFORTS, 'reasoningEffort') as ReasoningEffort };
    case 'set_tool_scope':
      return { type, toolScope: requireMember(value.toolScope, TOOL_SCOPES, 'toolScope') as ToolScope };
    case 'cancel': {
      const sessionId = optionalString(value.sessionId, 'sessionId');
      return sessionId === undefined ? { type } : { type, sessionId };
    }
    case 'undo': {
      if (!Array.isArray(value.checkpointIds)) throw new Error('checkpointIds must be an array');
      return {
        type,
        undoId: requireString(value.undoId, 'undoId'),
        checkpointIds: value.checkpointIds.map((id, index) => requireString(id, `checkpointIds[${index}]`)),
      };
    }
    case 'shutdown':
    case 'ping':
      return { type };
    case 'task_board_action': {
      const action = requireMember(value.action, TASK_BOARD_ACTIONS, 'action') as 'confirm' | 'pause' | 'continue' | 'skip' | 'reopen';
      const taskId = optionalString(value.taskId, 'taskId');
      return taskId === undefined ? { type, action } : { type, action, taskId };
    }
    default:
      throw new Error(`unknown command type: ${type}`);
  }
}
