import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runAgentTurn, type AgentRuntime, type AgentTurnResult } from '../agent/agent.js';
import { handleLazyDevInput } from '../guard/lazyDevGuard.js';
import { formatMemories } from '../memory/format.js';
import { selectRelevantMemories } from '../memory/select.js';
import { ProjectMemoryStore } from '../memory/store.js';
import { commitBoardChanges, ensureBoardBranch, previewBoardCommit } from '../git-safety/workflow.js';
import { planBoardFromGoal, shouldUseTaskBoard } from '../tasks/planner.js';
import { confirmBoard, formatBoard, runTaskBoardLoop } from '../tasks/runtime.js';
import { TaskBoardStore } from '../tasks/store.js';
import { handleSlashCommand } from './commands.js';

export async function runPromptMode(runtime: AgentRuntime, prompt: string): Promise<AgentTurnResult> {
  if (prompt.startsWith('/')) {
    const result = await handleSlashCommand({ line: prompt, ...runtime });
    if (result !== '__EXIT__') runtime.ui.info(result);
    if (runtime.session.taskRuntime?.mode === 'executing' && runtime.session.taskRuntime.boardId) {
      return continueTaskBoard(runtime);
    }
    return { ok: true, session: runtime.session };
  }
  return runGuardedAgentTurn(runtime, prompt);
}

async function runGuardedAgentTurn(runtime: AgentRuntime, line: string): Promise<AgentTurnResult> {
  const guard = runtime.session.guard?.lazyDev;
  if (guard?.enabled) {
    const guardResult = handleLazyDevInput(guard, line);
    if (guardResult.message) runtime.ui.info(guardResult.message);
    await runtime.sessions.save(runtime.session);
    if (!guardResult.allowDevelopment) {
      return { ok: true, session: runtime.session, reason: guardResult.reason };
    }
    return handleDevelopmentPrompt(runtime, guardResult.developmentPrompt ?? line);
  }
  return handleDevelopmentPrompt(runtime, line);
}

async function handleDevelopmentPrompt(runtime: AgentRuntime, prompt: string): Promise<AgentTurnResult> {
  if (!shouldUseTaskBoard(prompt)) {
    return runAgentTurn(runtime, prompt);
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
  const accepted = await runtime.confirm(`Commit completed board ${board.id} on ${preview.branch}?`);
  if (!accepted) {
    runtime.ui.info('Board commit declined.');
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
  const interactiveRuntime: AgentRuntime = {
    ...runtime,
    confirm: async (message) => {
      const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    },
  };
  runtime.ui.info('Type /help for commands. Type /exit to quit.');
  try {
    while (true) {
      const line = (await rl.question('aicode> ')).trim();
      if (!line) continue;
      if (line.startsWith('/')) {
        const result = await handleSlashCommand({ line, ...interactiveRuntime });
        if (result === '__EXIT__') break;
        runtime.ui.info(result);
        if (interactiveRuntime.session.taskRuntime?.mode === 'executing') {
          await continueTaskBoard(interactiveRuntime);
        }
        continue;
      }
      await runGuardedAgentTurn(interactiveRuntime, line);
    }
  } finally {
    rl.close();
  }
  return runtime.session;
}
