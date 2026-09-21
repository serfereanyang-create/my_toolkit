import { createInterface } from 'node:readline';
import type { AgentRuntime } from '../agent/agent.js';
import { prepareSubmittedUserTurn, runAutomationGoal, runGuardedAgentTurn, runPromptMode } from './repl.js';
import { DesktopApprovalBroker } from './approvalBroker.js';
import type { ReasoningEffort } from '../providers/types.js';
import type { ToolScope } from '../tools/scope.js';

type BridgeCommand =
  | { type: 'user_message'; text: string; sessionId?: string; reasoningEffort?: ReasoningEffort; toolScope?: ToolScope; files?: Array<{ path: string; name: string; size: number }> }
  | { type: 'automation_task'; taskId: string; goal: string }
  | { type: 'approval_response'; requestId: string; decision: 'allow_once' | 'allow_session' | 'deny' }
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
 * Injecting `input`/`emit` lets tests drive the whole bridge in-process; the
 * production entry passes nothing and uses stdin/stdout.
 */
export async function runDesktopBridge(runtime: AgentRuntime, options: BridgeRunOptions = {}) {
  const emitEvent = options.emit ?? emit;
  const broker = new DesktopApprovalBroker(runtime.session.id, { emit: emitEvent, timeoutMs: options.approvalTimeoutMs });
  runtime.toolConfirm = broker.confirm.bind(broker);
  // Cooperative cancel. A denied approval is NOT a terminal failure (the model
  // may propose another way), so a turn cannot be stopped by the deny itself.
  // Turn-level aborts — an explicit `cancel`, or EOF while a turn is in flight —
  // set this flag instead, and the agent loop honors it at the next safe
  // boundary. Without it, denying pending approvals on shutdown would let the
  // turn keep running (and keep prompting) after nobody is left to answer.
  let cancelRequested = false;
  runtime.cancelRequested = () => cancelRequested;
  runtime.taskBoardEmit = (board: any) => {
    const tasks = Array.isArray(board.tasks) ? board.tasks : [];
    emitEvent({
      type: 'task_board_updated',
      sessionId: runtime.session.id,
      boardId: board.id,
      title: board.title,
      goal: board.goal,
      status: board.status,
      runtimeMode: runtime.session.taskRuntime?.mode ?? 'idle',
      activeTaskId: tasks.find((task: any) => task.status === 'in_progress')?.id,
      tasks,
    });
  };
  // Context compaction divider (Codex "正在压缩上下文 / 上下文已自动压缩").
  // The renderer keeps the 'started' row pending until completed/failed arrives.
  runtime.compactEmit = (payload) => {
    emitEvent({ type: 'context_compaction', sessionId: runtime.session.id, ...payload });
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
  // The in-flight turn runs detached from the read loop so that
  // `approval_response` lines can still be read and delivered to the broker
  // while a turn is awaiting an interactive approval. Awaiting the turn inside
  // the loop would deadlock: the turn blocks on an approval that can only
  // arrive on a line this same loop must read.
  let activeTurn: Promise<void> = Promise.resolve();

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let command: BridgeCommand;
      try {
        command = JSON.parse(trimmed) as BridgeCommand;
      } catch (error) {
        emitEvent({ type: 'error', sessionId: runtime.session.id, message: `Invalid bridge JSON: ${errorMessage(error)}` });
        continue;
      }

      if (command.type === 'shutdown') break;
      if (command.type === 'ping') {
        emitEvent({ type: 'pong', sessionId: runtime.session.id });
        continue;
      }
      if (command.type === 'approval_response') {
        broker.resolve(command.requestId, command.decision);
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
        if (busy) { emitEvent({ type: 'error', sessionId: runtime.session.id, message: 'Agent turn already running' }); continue; }
        cancelRequested = false;
        busy = true;
        activeTurn = (async () => {
          try {
            await runPromptMode(runtime, slash);
            // Pair the renderer-facing turn lifecycle: runPromptMode may run
            // agent turns internally (each emitting its own turn_start) but
            // never emits turn_done itself. Without this the UI would keep a
            // turn card "running" forever after a task-board action.
            emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'ok' });
          } catch (error) {
            emitEvent({ type: 'error', sessionId: runtime.session.id, message: errorMessage(error) });
            emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'error' });
          } finally { busy = false; }
        })();
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
        cancelRequested = true;
        broker.denyAll('已取消当前执行');
        emitEvent({
          type: 'cancel_ack',
          sessionId: runtime.session.id,
          note: 'Desktop should terminate and restart the child process for active turns.',
        });
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
        cancelRequested = false;
        busy = true;
        emitEvent({ type: 'automation_start', sessionId: runtime.session.id, taskId: command.taskId, goal: command.goal });
        activeTurn = (async () => {
          try {
            const result = await runAutomationGoal(runtime, command.goal);
            emitEvent({
              type: 'automation_done',
              sessionId: runtime.session.id,
              taskId: command.taskId,
              status: result.ok ? 'ok' : 'error',
              reason: result.reason,
            });
            // Same pairing rationale as task_board_action: the automation goal
            // runs agent turns internally; close the renderer-facing turn here.
            emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: result.ok ? 'ok' : 'error' });
          } catch (error) {
            emitEvent({ type: 'automation_done', sessionId: runtime.session.id, taskId: command.taskId, status: 'error', reason: errorMessage(error) });
            emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'error' });
          } finally {
            busy = false;
          }
        })();
        continue;
      }
      if (command.type === 'user_message') {
        if (busy) {
          emitEvent({ type: 'error', sessionId: runtime.session.id, message: 'Agent turn already running' });
          continue;
        }
        // A fresh turn clears any cancel left over from a previous one.
        cancelRequested = false;
        busy = true;
        const filePaths = (command.files ?? []).map((file) => file.path).filter((value): value is string => Boolean(value && value.trim()));
        activeTurn = handleUserMessage(command, runtime, filePaths, emitEvent).finally(() => { busy = false; });
      }
    }
    // The read loop ended (EOF or `shutdown`). Deny any approvals still pending
    // BEFORE awaiting the turn — otherwise a turn blocked on an approval that
    // can never be answered would keep `await activeTurn` (and this process)
    // alive forever.
    cancelRequested = true;
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
    emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: result.ok ? 'ok' : 'error', reason: result.reason });
  } catch (error) {
    emitEvent({ type: 'error', sessionId: runtime.session.id, message: errorMessage(error) });
    emitEvent({ type: 'turn_done', sessionId: runtime.session.id, status: 'error' });
  }
}

function emit(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
