import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runAgentTurn, type AgentRuntime, type AgentTurnResult } from '../agent/agent.js';
import { handleLazyDevInputWithChannel } from '../guard/lazyDevGuard.js';
import { GitProcess } from '../git-safety/git.js';
import { formatMemories } from '../memory/format.js';
import { selectRelevantMemories } from '../memory/select.js';
import { ProjectMemoryStore } from '../memory/store.js';
import { commitBoardChanges, ensureBoardBranch, previewBoardCommit } from '../git-safety/workflow.js';
import type { MessagePart } from '../providers/types.js';
import { runCodeReview, summarizeReview } from '../review/reviewer.js';
import { parseReviewTarget, resolveReviewTarget, type ResolvedTarget } from '../review/target.js';
import { recordReviewInHistory } from '../review/writeback.js';
import { planBoardFromGoal, shouldUseTaskBoard } from '../tasks/planner.js';
import { confirmBoard, formatBoard, runTaskBoardLoop } from '../tasks/runtime.js';
import { TaskBoardStore } from '../tasks/store.js';
import type { TaskBoard } from '../tasks/types.js';
import type { SessionRecord } from '../session/store.js';
import { buildAttachmentContextLines, prepareUserContent, type Attachment } from './attachments.js';
import { commandPaletteItems, runCommandPalette } from './commandPalette.js';
import { appendCliHistory, loadCliHistory, toReadlineHistory } from './history.js';
import { handleSlashCommand } from './commands.js';
import { isSlashCommandLine, readMultilineContinuation, readUserTurn } from './input.js';
import { assertUserTextWithinLimit, formatByteSize } from './limits.js';
import { runMessageActions } from './messageActions.js';
import { detectLocale, resolveSessionLocale } from '../i18n/locale.js';
import { formatGitConfirm } from '../i18n/messages.js';
import { chatPromptLabel } from '../ui/home.js';
import { restoreConsoleSoftWrap } from '../ui/consoleWrap.js';

type TurnExtras = { parts?: MessagePart[]; displayText?: string };
type ReplayPayload = { prompt: string; parts?: MessagePart[]; displayText?: string };

/** keymap/chords.rs KEY_CHORD_TIMEOUT — multi-press window for esc-esc etc. */
const KEY_CHORD_TIMEOUT_MS = 1000;

/**
 * app.copy (interaction.rs): copy the last agent reply. Upstream copies the
 * markdown to the system clipboard; on Windows we pipe to clip.exe and fail
 * soft elsewhere.
 */
function copyLastReplyToClipboard(source: AgentRuntime, ui: AgentRuntime): void {
  const lastAssistant = [...(source.session.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (!lastAssistant?.content?.trim()) {
    ui.ui.info('No agent reply to copy yet.');
    return;
  }
  try {
    execSync('clip', { input: lastAssistant.content, stdio: ['pipe', 'ignore', 'ignore'] });
    ui.ui.info(`Copied last reply (${lastAssistant.content.length} chars) to the clipboard.`);
  } catch {
    ui.ui.info('Clipboard copy is not available on this platform.');
  }
}

export type SubmittedUserTurn = {
  prompt: string;
  parts?: MessagePart[];
  displayText?: string;
  attachments: Attachment[];
};

export async function runPromptMode(runtime: AgentRuntime, prompt: string): Promise<AgentTurnResult> {
  if (prompt.trim() === '/retry') {
    return retryLastUserTurn(runtime);
  }
  // `/review` runs a real review in a separate read-only sub-session. It needs
  // the provider, the git process and the session store, none of which
  // `handleSlashCommand` receives — so it is intercepted here rather than
  // returning a prompt string the user would have to paste back.
  if (prompt === '/review' || prompt.startsWith('/review ')) {
    return runReviewCommand(runtime, prompt.slice('/review'.length).trim());
  }
  // `/computer use <goal>` arms the session AND immediately starts an agent
  // turn on the goal, so one composer line is enough to delegate a GUI task.
  if (prompt.startsWith('/computer use ') && prompt.slice('/computer use '.length).trim()) {
    const goal = prompt.slice('/computer use '.length).trim();
    runtime.session.computerUse = true;
    await runtime.sessions.save(runtime.session);
    runtime.ui.info(`Computer use armed. Working on: ${goal}`);
    return runGuardedAgentTurn(runtime, goal);
  }
  if (prompt.startsWith('/')) {
    const result = await handleSlashCommand({ line: prompt, ...runtime });
    if (result !== '__EXIT__') runtime.ui.info(result);
    if ((prompt === '/plan' || prompt.startsWith('/plan ')) && runtime.session.taskRuntime?.boardId) {
      runtime.taskBoardEmit?.(await new TaskBoardStore(runtime.config.workspaceRoot).load(runtime.session.taskRuntime.boardId));
    }
    if (runtime.session.taskRuntime?.mode === 'executing' && runtime.session.taskRuntime.boardId) {
      return continueTaskBoard(runtime);
    }
    return { ok: true, session: runtime.session };
  }
  assertUserTextWithinLimit(prompt);
  const prepared = await prepareUserContent({
    text: prompt,
    workspaceRoot: runtime.config.workspaceRoot,
    sessionId: runtime.session.id,
  });
  return runGuardedAgentTurn(runtime, prepared.text, {
    parts: prepared.parts,
    displayText: prepared.displaySummary,
  });
}

/**
 * `/review [target]` — run a review in a separate read-only sub-session and
 * write the findings back into this session's history.
 *
 * The turn result is `ok: true` even when the review finds defects: a review
 * that reports problems did its job, and marking it failed would tell the
 * desktop to raise an error banner for a successful review. A review that could
 * not *run* is the failure case, and carries its reason.
 *
 * `producedActivity` is true — a review genuinely ran a sub-session and read
 * code, even when it reports no findings, so the "只做了回复" toast must not fire.
 */
export async function runReviewCommand(runtime: AgentRuntime, argument: string): Promise<AgentTurnResult> {
  let target: ResolvedTarget;
  try {
    const parsed = parseReviewTarget(argument);
    target = await resolveReviewTarget({
      target: parsed,
      git: runtime.gitProcess ?? new GitProcess(runtime.config.workspaceRoot),
      repositoryRoot: runtime.config.workspaceRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.ui.info(`审查目标无法解析：${message}`);
    return { ok: false, session: runtime.session, reason: `审查目标无法解析：${message}` };
  }

  runtime.ui.info(`开始代码审查：${target.label}`);
  if (target.files.length === 0 && !target.diff.trim()) {
    runtime.ui.info('没有发现改动，审查仍会运行（审查者会自行查看工作区）。');
  }

  const result = await runCodeReview({ runtime, target });
  const { assistantMessage } = await recordReviewInHistory(runtime, result);
  runtime.ui.info(summarizeReview(result));
  runtime.ui.assistant(assistantMessage);

  // Surface the structured report to the embedding layer. The review is already
  // in session history; this is how the 审查 tab learns about it while the
  // session is live, without re-parsing the transcript.
  runtime.reviewEmit?.({
    label: result.label,
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(result.report.unparsed ? { unparsed: true } : {}),
    findings: result.report.findings,
    outcome: result.report.outcome,
    ...(result.report.explanation ? { explanation: result.report.explanation } : {}),
    ...(result.sessionId ? { subSessionId: result.sessionId } : {}),
    durationMs: result.durationMs,
  });

  if (!result.ok) {
    return {
      ok: false,
      session: runtime.session,
      reason: result.error ?? '审查未能完成，但没有返回原因。',
      finalAnswer: assistantMessage,
      producedActivity: true,
    };
  }
  return { ok: true, session: runtime.session, finalAnswer: assistantMessage, producedActivity: true };
}

export async function runGuardedAgentTurn(runtime: AgentRuntime, line: string, extras?: TurnExtras): Promise<AgentTurnResult> {
  // Inject the sub-agent runner so spawn_subagent can create nested agents
  // without a circular import. Set once on the root agent; sub-agents inherit
  // it via the spread in executeToolAction.
  if (!runtime.runSubAgentTurn) {
    runtime.runSubAgentTurn = async (subRuntime: AgentRuntime, goal: string): Promise<string> => {
      const result = await runGuardedAgentTurn(subRuntime, goal, {});
      // Return the final assistant message as the sub-agent's output
      const messages = result.session.messages ?? [];
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      return result.finalAnswer ?? lastAssistant?.content ?? '(no output)';
    };
  }

  const guard = runtime.session.guard?.lazyDev;
  if (guard?.enabled) {
    // Desktop sessions can answer the translation confirm in a popup; the
    // plain REPL keeps the numbered-text flow (channel is undefined there).
    const guardResult = await handleLazyDevInputWithChannel(guard, line, runtime.guardConfirmation);
    if (guardResult.message) runtime.ui.info(guardResult.message);
    await runtime.sessions.save(runtime.session);
    if (!guardResult.allowDevelopment) {
      return { ok: true, session: runtime.session, reason: guardResult.reason };
    }
    return handleDevelopmentPrompt(runtime, guardResult.developmentPrompt ?? line, extras);
  }
  return handleDevelopmentPrompt(runtime, line, extras);
}

/**
 * Replay the most recent real user turn as a fresh agent turn.
 *
 * Prefers the persisted `lastTurn` payload (exact prompt + parts + display
 * text), falling back to the last real user message for sessions saved by
 * older versions. The replayed prompt is submitted as a new user message, so
 * the full history (including the previous answer) stays in context — writing
 * tools may therefore run again and must pass approval as usual.
 */
export async function retryLastUserTurn(runtime: AgentRuntime): Promise<AgentTurnResult> {
  const session = runtime.session;
  const last = session.lastTurn;

  const replay = last
    ? { prompt: last.prompt, parts: last.parts, displayText: last.displayText }
    : findLastUserMessage(session);

  if (!replay) {
    runtime.ui.info('No previous user message found. Nothing to retry.');
    return { ok: true, session, reason: 'nothing-to-retry' };
  }

  // A retry is a brand-new user turn — never continue an old Responses chain.
  if (session.providerContinuation) {
    session.providerContinuation = undefined;
    await sessionSaveSafe(runtime);
  }

  runtime.ui.info('Retrying last user message…');
  return runGuardedAgentTurn(runtime, replay.prompt, {
    parts: replay.parts,
    displayText: replay.displayText,
  });
}

function findLastUserMessage(session: SessionRecord): ReplayPayload | undefined {
  const message = [...(session.messages ?? [])].reverse().find((m) => m.role === 'user');
  if (!message) return undefined;
  return { prompt: message.content, parts: message.parts, displayText: message.content };
}

async function sessionSaveSafe(runtime: AgentRuntime) {
  try {
    await runtime.sessions.save(runtime.session);
  } catch { /* best-effort: continuation clearing must not block retry */ }
}

async function handleDevelopmentPrompt(runtime: AgentRuntime, prompt: string, extras?: TurnExtras): Promise<AgentTurnResult> {
  if (!shouldUseTaskBoard(prompt)) {
    return runAgentTurn(runtime, prompt, {
      parts: extras?.parts,
      displayText: extras?.displayText,
    });
  }

  // A large task gets a planning turn first, so the model writes the plan
  // itself instead of the hardcoded template. When it does not call
  // propose_plan — a mock provider, a model that ignores the instruction, or a
  // refusal — fall back to the template so the board still exists and the
  // confirm/execute path is unchanged.
  const planning = await runPlanningTurn(runtime, prompt, extras);
  if (planning) {
    // --confirm-plan means "do not stop for approval", so a proposed plan is
    // confirmed and executed exactly like a template board would be. Returning
    // the planning result here would leave that flag silently ignored.
    if (!runtime.config.confirmPlan) return planning;
    const store = new TaskBoardStore(runtime.config.workspaceRoot);
    const board = await store.load(runtime.session.taskRuntime?.boardId ?? '');
    return confirmAndRunBoard(runtime, store, board);
  }

  runtime.ui.info(
    runtime.locale === 'zh'
      ? '模型没有提交计划，改用默认步骤模板。'
      : 'Model did not propose a plan; falling back to the default step template.',
  );
  return createAndMaybeRunTaskBoard(runtime, prompt);
}

/**
 * Run the planning turn and report whether the model actually proposed a plan.
 *
 * `runtime.planGoal` is what `propose_plan` records as the board's goal, and it
 * is also what makes the agent append the planning instruction to the turn — it
 * must be set before the turn starts and cleared after, or every later turn
 * would carry the instruction.
 */
async function runPlanningTurn(
  runtime: AgentRuntime,
  prompt: string,
  extras?: TurnExtras,
): Promise<AgentTurnResult | undefined> {
  const previousGoal = runtime.planGoal;
  const previousProposed = runtime.planProposed;
  runtime.planGoal = prompt;
  runtime.planProposed = false;
  try {
    const result = await runAgentTurn(runtime, prompt, {
      parts: extras?.parts,
      displayText: extras?.displayText,
    });
    return runtime.planProposed ? result : undefined;
  } finally {
    runtime.planGoal = previousGoal;
    runtime.planProposed = previousProposed;
  }
}

export async function runAutomationGoal(runtime: AgentRuntime, goal: string): Promise<AgentTurnResult> {
  const previousConfirmPlan = runtime.config.confirmPlan;
  try {
    runtime.config.confirmPlan = true;
    return await createAndMaybeRunTaskBoard(runtime, goal);
  } finally {
    runtime.config.confirmPlan = previousConfirmPlan;
  }
}

async function createAndMaybeRunTaskBoard(runtime: AgentRuntime, prompt: string): Promise<AgentTurnResult> {
  const store = new TaskBoardStore(runtime.config.workspaceRoot);
  const board = planBoardFromGoal(prompt);
  await store.save(board);
  runtime.session.taskRuntime = {
    boardId: board.id,
    mode: 'awaiting_confirm',
    lastSyncAt: board.createdAt,
  };
  await runtime.sessions.save(runtime.session);
  runtime.taskBoardEmit?.(board);
  runtime.ui.info(formatBoard(board));

  try {
    const memoryStore = new ProjectMemoryStore(runtime.config.workspaceRoot);
    const memories = selectRelevantMemories({
      entries: await memoryStore.list({ includeInactive: true }),
      goal: board.goal,
      limit: 5,
    });
    if (memories.length > 0) runtime.ui.info(formatMemories(memories));
  } catch (error) {
    runtime.ui.info(`Project memory load failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!runtime.config.confirmPlan) {
    runtime.ui.info('Draft task board created. Run /plan confirm to start auto-execution (or pass --confirm-plan).');
    return { ok: true, session: runtime.session };
  }

  return confirmAndRunBoard(runtime, store, board);
}

/**
 * Confirm a draft board and hand it to the task loop.
 *
 * Shared by the template path and the model-proposed path: both end the same
 * way, and duplicating the branch/lease bookkeeping here is how the two would
 * drift apart.
 */
async function confirmAndRunBoard(
  runtime: AgentRuntime,
  store: TaskBoardStore,
  board: TaskBoard,
): Promise<AgentTurnResult> {
  confirmBoard(board, new Date().toISOString());
  if (runtime.gitProcess && runtime.gitRepository) {
    const branchResult = await ensureBoardBranch({
      git: runtime.gitProcess,
      repository: runtime.gitRepository,
      board,
      confirm: runtime.confirm,
    });
    if (branchResult.branch) board.gitBranch = branchResult.branch;
    runtime.ui.info(branchResult.message);
  }
  await store.save(board);
  runtime.session.taskRuntime = {
    boardId: board.id,
    mode: 'executing',
    lastSyncAt: new Date().toISOString(),
  };
  await runtime.sessions.save(runtime.session);
  runtime.taskBoardEmit?.(board);
  return continueTaskBoard(runtime);
}

async function continueTaskBoard(runtime: AgentRuntime): Promise<AgentTurnResult> {
  const boardId = runtime.session.taskRuntime?.boardId;
  if (!boardId) return { ok: true, session: runtime.session };
  const store = new TaskBoardStore(runtime.config.workspaceRoot);
  const board = await store.load(boardId);
  if (board.status === 'draft') {
    runtime.ui.info('Board is still draft. Confirm before execution.');
    return { ok: true, session: runtime.session };
  }

  const loopResult = await runTaskBoardLoop({
    board,
    store,
    sessions: runtime.sessions,
    session: runtime.session,
    runtime,  // 新增：传入完整 runtime 以便专家路由访问 tools/provider
    runTurn: async (taskPrompt, gitSafetyUnit) => {
      const task = board.tasks.find(item => item.id === runtime.session.taskRuntime?.activeTaskId);
      const result = await runAgentTurn(runtime, taskPrompt, { gitSafetyUnit, displayText: task ? `执行任务：${task.title}` : '执行任务计划' });
      return {
        ok: result.ok,
        reason: result.reason,
        finalAnswer: result.finalAnswer ?? result.reason,
        hadTerminalFailure: result.hadTerminalFailure,
        outcome: result.outcome,
        steps: result.steps,
      };
    },
    onInfo: (message) => runtime.ui.info(message),
    onUpdate: (updatedBoard) => {
      runtime.taskBoardEmit?.(updatedBoard);
      runtime.ui.boardProgress(updatedBoard as TaskBoard);
    },
    gitSafety: runtime.gitSafety,
    confirm: runtime.confirm,
  });

  runtime.ui.info(formatBoard(board));
  if (loopResult.status === 'busy') {
    runtime.session.taskRuntime = { ...runtime.session.taskRuntime, boardId: board.id, mode: 'paused', lastSyncAt: new Date().toISOString() };
    await runtime.sessions.save(runtime.session);
    runtime.taskBoardEmit?.(board);
  }
  if (loopResult.ok && board.status === 'completed' && !runtime.cancelRequested?.() && runtime.gitProcess) {
    await maybeCommitCompletedBoard(runtime, store, board);
  }
  return { ok: loopResult.ok, session: runtime.session, reason: loopResult.reason, outcome: loopResult.outcome, finalAnswer: loopResult.finalAnswer };
}

async function maybeCommitCompletedBoard(
  runtime: AgentRuntime,
  store: TaskBoardStore,
  board: Awaited<ReturnType<TaskBoardStore['load']>>,
) {
  if (!runtime.gitProcess) return;
  if (runtime.gitRepository && !await runtime.gitRepository.discover()) {
    runtime.ui.info('任务板已完成；工作区未启用 Git，跳过提交预览。');
    return;
  }
  if (board.gitCommitSha) {
    runtime.ui.info(`Board already committed as ${board.gitCommitSha.slice(0, 12)}.`);
    return;
  }
  const preview = await previewBoardCommit({ git: runtime.gitProcess, board });
  if (!preview.hasChanges) {
    runtime.ui.info(`Board completed on ${preview.branch} with a clean worktree.`);
    return;
  }
  runtime.ui.info([
    `Board completed on ${preview.branch}. Commit preview:`,
    preview.status,
    preview.diffStat,
    'Suggested message:',
    preview.suggestedMessage,
  ].join('\n'));

  if (!runtime.confirm) {
    runtime.ui.info('No confirm handler available; skip auto commit. Use interactive /git commit later.');
    return;
  }
  const locale = detectLocale(board.goal ?? board.title);
  const accepted = await runtime.confirm(formatGitConfirm({
    locale,
    kind: 'board_commit',
    boardId: board.id,
    branch: preview.branch,
  }));
  if (!accepted) {
    runtime.ui.info(locale === 'zh' ? '已取消任务板提交。' : 'Board commit declined.');
    return;
  }
  const result = await commitBoardChanges({ git: runtime.gitProcess, board });
  runtime.ui.info(result.message);
  if (result.ok && result.sha) {
    board.gitCommitSha = result.sha;
    board.updatedAt = new Date().toISOString();
    await store.save(board);
  }
}

/** Slash-command Tab completer (Codex-style: type / then Tab to complete). */
function slashCommandCompleter(line: string): [string[], string] {
  const trimmed = line.replace(/^/, '');
  if (!trimmed.startsWith('/')) return [[], line];
  const items = commandPaletteItems();
  if (trimmed === '/') {
    return [items.map((i) => i.id), trimmed];
  }
  const matches = items
    .map((i) => i.id)
    .filter((id) => id !== '/' && id.startsWith(trimmed));
  return [matches, trimmed];
}

export async function runRepl(runtime: AgentRuntime) {
  const rl = createInterface({ input, output, completer: slashCommandCompleter });
  // Persistent input history: seed from disk, newest-first for readline.
  const seeded = toReadlineHistory(await loadCliHistory(runtime.config.workspaceRoot));
  if (seeded.length > 0) {
    (rl as unknown as { history: string[] }).history = seeded;
  }
  if (!runtime.pendingAttachments) runtime.pendingAttachments = [];
  if (!runtime.locale) runtime.locale = 'zh';

  // Codex-style cooperative cancellation. A single flag drives both Esc
  // (via keypress) and Ctrl+C (via SIGINT); the agent loop polls
  // cancelRequested at safe boundaries. During a turn the first signal asks
  // it to stop at the next checkpoint; a second one says we are still trying.
  // While idle, Ctrl+C behaves like every normal CLI and exits.
  let cancelRequested = false;
  let turnActive = false;
  let exiting = false;
  // approval_overlay.rs "don't ask again": per (risk, tool, directory) cache
  // for write tools, mirroring the desktop approval broker.
  const sessionAllows = new Set<string>();
  let pendingAllowKey: string | undefined;
  // Codex interaction.rs on_ctrl_c with DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED at
  // its upstream default (false): a running turn is interrupted at the next
  // safe boundary; an idle composer quits immediately.
  const requestStop = () => {
    if (turnActive) {
      if (cancelRequested) {
        runtime.ui.info('Already stopping at next safe point — wait for the current tool to finish.');
        return;
      }
      cancelRequested = true;
      interactiveRuntime.cancelCurrentTurn?.();
      runtime.ui.info('Stopping at next safe point…');
      return;
    }
    if (exiting) return;
    exiting = true;
    output.write('\n');
    rl.close();
  };
  const interactiveRuntime: AgentRuntime = {
    ...runtime,
    pendingAttachments: runtime.pendingAttachments,
    locale: runtime.locale,
    cancelRequested: () => cancelRequested,
    confirm: async (message, request) => {
      runtime.ui.pauseSpinnerForPrompt();
      // approval_overlay.rs `a` option: "don't ask again" caches per
      // (risk, tool, directory) for write tools, mirroring the desktop broker.
      if (request && request.risk === 'write') {
        const rawPath = request.input && typeof request.input.path === 'string' ? request.input.path : '';
        const normalized = rawPath.replace(/\\/g, '/');
        const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
        const allowKey = dir ? `${request.risk}:${request.tool}:${dir}` : `${request.risk}:${request.tool}`;
        if (sessionAllows.has(allowKey)) {
          runtime.ui.resumeSpinnerAfterPrompt();
          return true;
        }
        pendingAllowKey = allowKey;
      }
      runtime.ui.approvalDiff(request);
      // approval_overlay.rs wording: patch edits vs command execution get
      // their own headline, followed by the y/n/a option list.
      const writeTool = request?.tool === 'write_file' || request?.tool === 'apply_patch' || request?.tool === 'edit_lines';
      runtime.ui.info(writeTool
        ? 'Would you like to make the following edits?'
        : 'Would you like to run the following command?');
      runtime.ui.info(request?.risk === 'write'
        ? '  y = Yes, proceed · a = Yes, and don\'t ask again this session · n = No, and tell Codex what to do differently'
        : '  y = Yes, proceed · n = No, and tell Codex what to do differently');
      const locale = interactiveRuntime.locale ?? runtime.locale ?? 'zh';
      const suffix = locale === 'zh' ? ' [y是/N否] ' : ' [y/N] ';
      const prompt = /\[y\/N\]|\[y是\/N否\]/i.test(message) ? `${message} ` : `${message}${suffix}`;
      const answer = (await rl.question(prompt)).trim().toLowerCase();
      runtime.ui.resumeSpinnerAfterPrompt();
      if ((answer === 'a' || answer === 'all') && pendingAllowKey) {
        sessionAllows.add(pendingAllowKey);
        return true;
      }
      return answer === 'y' || answer === 'yes' || answer === '是' || answer === '好' || answer === '确认';
    },
  };

  // Codex reserved keymap (keymap.rs MAIN_RESERVED_BINDINGS + built_in_defaults):
  // esc = interrupt the running turn (chat.interrupt_turn); idle `esc esc` =
  // backtrack to edit the previous message; ctrl+o = copy the last agent reply
  // (app.copy); ctrl+t = transcript (app.open_transcript). ctrl+r history
  // search ships with readline's emacs mode; ctrl+c idle quits (see above).
  if (input.isTTY) {
    emitKeypressEvents(input);
    let backtrackPrimedAt = 0;
    const onKey = (_str: string, key?: { name?: string; ctrl?: boolean }) => {
      if (!key) return;
      if (key.name === 'escape') {
        if (turnActive) { requestStop(); return; }
        // app_backtrack.rs backtrack precondition: composer must be EMPTY —
        // never clobber a draft the user is still typing.
        const draftLine = (rl as unknown as { line?: string }).line ?? '';
        if (draftLine.trim()) return;
        const now = Date.now();
        if (now - backtrackPrimedAt <= KEY_CHORD_TIMEOUT_MS) {
          backtrackPrimedAt = 0;
          const lastUser = [...(interactiveRuntime.session.messages ?? [])]
            .reverse()
            .find((message) => message.role === 'user');
          if (lastUser?.content?.trim()) {
            (rl as unknown as { write: (text: string) => void }).write(lastUser.content);
            runtime.ui.info('Editing previous message — Enter resubmits it through the normal approval flow.');
          }
        } else {
          backtrackPrimedAt = now;
          runtime.ui.info('esc again to edit previous message');
        }
        return;
      }
      if (key.ctrl && key.name === 'o') {
        copyLastReplyToClipboard(interactiveRuntime, runtime);
        return;
      }
      if (key.ctrl && key.name === 't') {
        runtime.ui.info(`Transcript: ${interactiveRuntime.sessions.filePath(interactiveRuntime.session.id)}`);
        return;
      }
    };
    input.on('keypress', onKey);
    rl.on('SIGINT', () => requestStop());
  }
  // Board execution also runs agent turns — keep it cancellable the same way.
  const runBoardLoop = async () => {
    turnActive = true;
    cancelRequested = false;
    try {
      await continueTaskBoard(interactiveRuntime);
    } finally {
      turnActive = false;
      cancelRequested = false;
    }
  };

  try {
    while (true) {
      let turn;
      try {
        // Stable input: normal readline only. Fancy home is painted once by banner().
        // No per-keystroke full-screen paints (those stacked logos and killed scrollback).
        const prompt = process.stdout.isTTY && !runtime.config.noColor
          ? chatPromptLabel({ noColor: runtime.config.noColor })
          : 'aicode> ';
        turn = await readUserTurn(rl, prompt);
      } catch (error) {
        // rl.close() from Ctrl+C rejects the pending question (AbortError).
        // Treat that as a clean exit, not an error loop.
        if (exiting || (error instanceof Error && error.name === 'AbortError')) break;
        runtime.ui.error(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (!turn) break;
      if (!turn.multiline) {
        const marker = turn.text.trim();
        if (marker === '"""' || marker === '/paste') {
          try {
            turn = await readMultilineContinuation(rl, marker === '/paste' ? 'paste' : 'triple');
          } catch (error) {
            runtime.ui.error(error instanceof Error ? error.message : String(error));
            continue;
          }
        }
      }
      if (!turn) break;
      if (!turn.text.trim() && (interactiveRuntime.pendingAttachments?.length ?? 0) === 0) continue;

      if (isSlashCommandLine(turn.text) && !turn.multiline) {
        const line = turn.text.trim();
        if (line === '/retry') {
          turnActive = true;
          cancelRequested = false;
          try {
            await retryLastUserTurn(interactiveRuntime);
          } catch (error) {
            runtime.ui.error(error instanceof Error ? error.message : String(error));
          } finally {
            turnActive = false;
            cancelRequested = false;
          }
          if (interactiveRuntime.session.taskRuntime?.mode === 'executing') {
            await continueTaskBoard(interactiveRuntime);
          }
          continue;
        }
        if (line === '/help' || line === '/?' || line === '/commands') {
          rl.pause();
          try {
            const palette = await runCommandPalette(interactiveRuntime);
            if (palette.status === 'exit') break;
            if (palette.message) runtime.ui.info(palette.message);
            if (interactiveRuntime.session.taskRuntime?.mode === 'executing') {
              await runBoardLoop();
            }
          } finally {
            rl.resume();
          }
          continue;
        }
        if (line === '/actions' || line === '/menu') {
          rl.pause();
          try {
            const status = await runMessageActions({
              config: interactiveRuntime.config,
              provider: interactiveRuntime.provider,
              sessions: interactiveRuntime.sessions,
              session: interactiveRuntime.session,
              checkpoints: interactiveRuntime.checkpoints,
              onSessionForked: (session) => {
                interactiveRuntime.session = session;
                runtime.session = session;
              },
            });
            runtime.ui.info(status);
          } finally {
            rl.resume();
          }
          continue;
        }
        const result = await handleSlashCommand({ line, ...interactiveRuntime });
        if (result === '__EXIT__') break;
        runtime.ui.info(result);
        if (interactiveRuntime.session.taskRuntime?.mode === 'executing') {
          await runBoardLoop();
        }
        continue;
      }

      turnActive = true;
      cancelRequested = false;
      try {
        await submitUserTurn(interactiveRuntime, turn.text);
        if (turn.text.trim()) {
          await appendCliHistory(runtime.config.workspaceRoot, turn.text);
        }
      } catch (error) {
        runtime.ui.error(error instanceof Error ? error.message : String(error));
      } finally {
        turnActive = false;
        cancelRequested = false;
      }
      if (interactiveRuntime.session.taskRuntime?.mode === 'executing') {
        await runBoardLoop();
      }
    }
  } finally {
    rl.close();
    restoreConsoleSoftWrap();
  }
  return runtime.session;
}

async function submitUserTurn(runtime: AgentRuntime, text: string) {
  const submission = await prepareSubmittedUserTurn(runtime, text);

  if (submission.attachments.length > 0) {
    runtime.ui.info(
      `Attached ${submission.attachments.length} file(s): ${submission.attachments.map((a) => a.name).join(', ')} (${formatByteSize(submission.attachments.reduce((n, a) => n + a.bytes, 0))})`,
    );
  }

  await runGuardedAgentTurn(runtime, submission.prompt, {
    parts: submission.parts,
    displayText: submission.displayText,
  });
}

export async function prepareSubmittedUserTurn(
  runtime: AgentRuntime,
  text: string,
  extraPaths: string[] = [],
): Promise<SubmittedUserTurn> {
  assertUserTextWithinLimit(text);
  runtime.locale = resolveSessionLocale({ text, previous: runtime.locale });
  const staged = runtime.pendingAttachments ?? [];
  runtime.pendingAttachments = [];

  const prepared = await prepareUserContent({
    text: text || (staged.length > 0 || extraPaths.length > 0 ? '(see attachments)' : ''),
    workspaceRoot: runtime.config.workspaceRoot,
    sessionId: runtime.session.id,
    extraPaths,
  });

  const attachments = mergeAttachments(prepared.attachments, staged);
  const parts = await buildParts(prepared.text, attachments);
  const displayText = attachments.length === 0
    ? text
    : `${text.trim() || '(attachments)'}\n(+${attachments.length} attachment(s): ${attachments.map((a) => a.name).join(', ')})`;

  return {
    prompt: prepared.text,
    parts,
    displayText,
    attachments,
  };
}

function mergeAttachments(fromText: Attachment[], staged: Attachment[]) {
  const byPath = new Map<string, Attachment>();
  for (const item of [...fromText, ...staged]) byPath.set(item.storedPath, item);
  return [...byPath.values()];
}

async function buildParts(text: string, attachments: Attachment[]): Promise<MessagePart[]> {
  const notes = [text.trimEnd()];
  if (attachments.length > 0) {
    const missing = attachments.filter((a) => !text.includes(a.storedPath));
    if (missing.length > 0) {
      notes.push('');
      notes.push(...await buildAttachmentContextLines(missing));
    }
  }
  const fullText = notes.join('\n');
  const parts: MessagePart[] = [{ type: 'text', text: fullText }];
  for (const item of attachments.filter((a) => a.kind === 'image')) {
    const raw = await readFile(item.storedPath);
    parts.push({
      type: 'image',
      mediaType: item.mediaType ?? 'image/png',
      data: raw.toString('base64'),
      path: item.storedPath,
    });
  }
  return parts;
}
