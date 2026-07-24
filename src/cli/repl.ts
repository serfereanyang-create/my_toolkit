import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runAgentTurn, type AgentRuntime, type AgentTurnResult } from '../agent/agent.js';
import { handleLazyDevInput } from '../guard/lazyDevGuard.js';
import { formatMemories } from '../memory/format.js';
import { selectRelevantMemories } from '../memory/select.js';
import { ProjectMemoryStore } from '../memory/store.js';
import { commitBoardChanges, ensureBoardBranch, previewBoardCommit } from '../git-safety/workflow.js';
import type { MessagePart } from '../providers/types.js';
import { planBoardFromGoal, shouldUseTaskBoard } from '../tasks/planner.js';
import { confirmBoard, formatBoard, runTaskBoardLoop } from '../tasks/runtime.js';
import { TaskBoardStore } from '../tasks/store.js';
import { prepareUserContent, type Attachment } from './attachments.js';
import { runCommandPalette } from './commandPalette.js';
import { handleSlashCommand } from './commands.js';
import { isSlashCommandLine, readMultilineContinuation, readUserTurn } from './input.js';
import { assertUserTextWithinLimit, formatByteSize } from './limits.js';
import { runMessageActions } from './messageActions.js';
import { detectLocale, resolveSessionLocale } from '../i18n/locale.js';
import { formatGitConfirm } from '../i18n/messages.js';
import { chatPromptLabel } from '../ui/home.js';
import { restoreConsoleSoftWrap } from '../ui/consoleWrap.js';

type TurnExtras = { parts?: MessagePart[]; displayText?: string };

export async function runPromptMode(runtime: AgentRuntime, prompt: string): Promise<AgentTurnResult> {
  if (prompt.startsWith('/')) {
    const result = await handleSlashCommand({ line: prompt, ...runtime });
    if (result !== '__EXIT__') runtime.ui.info(result);
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

async function runGuardedAgentTurn(runtime: AgentRuntime, line: string, extras?: TurnExtras): Promise<AgentTurnResult> {
  const guard = runtime.session.guard?.lazyDev;
  if (guard?.enabled) {
    const guardResult = handleLazyDevInput(guard, line);
    if (guardResult.message) runtime.ui.info(guardResult.message);
    await runtime.sessions.save(runtime.session);
    if (!guardResult.allowDevelopment) {
      return { ok: true, session: runtime.session, reason: guardResult.reason };
    }
    return handleDevelopmentPrompt(runtime, guardResult.developmentPrompt ?? line, extras);
  }
  return handleDevelopmentPrompt(runtime, line, extras);
}

async function handleDevelopmentPrompt(runtime: AgentRuntime, prompt: string, extras?: TurnExtras): Promise<AgentTurnResult> {
  if (!shouldUseTaskBoard(prompt)) {
    return runAgentTurn(runtime, prompt, {
      parts: extras?.parts,
      displayText: extras?.displayText,
    });
  }

  const store = new TaskBoardStore(runtime.config.workspaceRoot);
  const board = planBoardFromGoal(prompt);
  await store.save(board);
  runtime.session.taskRuntime = {
    boardId: board.id,
    mode: 'awaiting_confirm',
    lastSyncAt: board.createdAt,
  };
  await runtime.sessions.save(runtime.session);
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
    runTurn: async (taskPrompt, gitSafetyUnit) => {
      const result = await runAgentTurn(runtime, taskPrompt, { gitSafetyUnit });
      return {
        ok: result.ok,
        reason: result.reason,
        finalAnswer: result.finalAnswer ?? result.reason,
        hadTerminalFailure: result.hadTerminalFailure,
        outcome: result.outcome,
      };
    },
    onInfo: (message) => runtime.ui.info(message),
    gitSafety: runtime.gitSafety,
    confirm: runtime.confirm,
  });

  runtime.ui.info(formatBoard(board));
  if (board.status === 'completed' && runtime.gitProcess) {
    await maybeCommitCompletedBoard(runtime, store, board);
  }
  return { ok: loopResult.ok, session: runtime.session, reason: loopResult.reason };
}

async function maybeCommitCompletedBoard(
  runtime: AgentRuntime,
  store: TaskBoardStore,
  board: Awaited<ReturnType<TaskBoardStore['load']>>,
) {
  if (!runtime.gitProcess) return;
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

export async function runRepl(runtime: AgentRuntime) {
  const rl = createInterface({ input, output });
  if (!runtime.pendingAttachments) runtime.pendingAttachments = [];
  if (!runtime.locale) runtime.locale = 'zh';
  const interactiveRuntime: AgentRuntime = {
    ...runtime,
    pendingAttachments: runtime.pendingAttachments,
    locale: runtime.locale,
    confirm: async (message) => {
      const locale = interactiveRuntime.locale ?? runtime.locale ?? 'zh';
      const suffix = locale === 'zh' ? ' [y是/N否] ' : ' [y/N] ';
      const prompt = /\[y\/N\]|\[y是\/N否\]/i.test(message) ? `${message} ` : `${message}${suffix}`;
      const answer = (await rl.question(prompt)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes' || answer === '是' || answer === '好' || answer === '确认';
    },
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
        if (line === '/help' || line === '/?' || line === '/commands') {
          rl.pause();
          try {
            const palette = await runCommandPalette(interactiveRuntime);
            if (palette.status === 'exit') break;
            if (palette.message) runtime.ui.info(palette.message);
            if (interactiveRuntime.session.taskRuntime?.mode === 'executing') {
              await continueTaskBoard(interactiveRuntime);
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
          await continueTaskBoard(interactiveRuntime);
        }
        continue;
      }

      try {
        await submitUserTurn(interactiveRuntime, turn.text);
      } catch (error) {
        runtime.ui.error(error instanceof Error ? error.message : String(error));
      }
      if (interactiveRuntime.session.taskRuntime?.mode === 'executing') {
        await continueTaskBoard(interactiveRuntime);
      }
    }
  } finally {
    rl.close();
    restoreConsoleSoftWrap();
  }
  return runtime.session;
}

async function submitUserTurn(runtime: AgentRuntime, text: string) {
  assertUserTextWithinLimit(text);
  runtime.locale = resolveSessionLocale({ text, previous: runtime.locale });
  const staged = runtime.pendingAttachments ?? [];
  runtime.pendingAttachments = [];

  const prepared = await prepareUserContent({
    text: text || (staged.length > 0 ? '(see attachments)' : ''),
    workspaceRoot: runtime.config.workspaceRoot,
    sessionId: runtime.session.id,
  });

  const attachments = mergeAttachments(prepared.attachments, staged);
  const parts = await buildParts(prepared.text, attachments);
  const displayText = attachments.length === 0
    ? text
    : `${text.trim() || '(attachments)'}\n(+${attachments.length} attachment(s): ${attachments.map((a) => a.name).join(', ')})`;

  if (attachments.length > 0) {
    runtime.ui.info(
      `Attached ${attachments.length} file(s): ${attachments.map((a) => a.name).join(', ')} (${formatByteSize(attachments.reduce((n, a) => n + a.bytes, 0))})`,
    );
  }

  await runGuardedAgentTurn(runtime, prepared.text, {
    parts,
    displayText,
  });
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
      notes.push('[attachments]');
      for (const item of missing) {
        notes.push(
          item.kind === 'image'
            ? `- image: ${item.name} (${item.bytes} bytes) stored at ${item.storedPath}`
            : `- file: ${item.name} path=${item.storedPath} (use read_file/list_files as needed)`,
        );
      }
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
