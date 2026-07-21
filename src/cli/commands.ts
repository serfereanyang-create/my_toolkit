import { safeConfig } from '../config/config.js';
import type { AppConfig } from '../config/types.js';
import { archiveCurrentRequirement, cancelCurrentRequirement, ensureLazyDevGuard, resumeBlockedRequirement } from '../guard/lazyDevGuard.js';
import { clampMaxAttempts, parseStrictness } from '../guard/config.js';
import type { LazyDevGuardState, LazyDevRequirement } from '../guard/types.js';
import { formatMemoryList } from '../memory/format.js';
import { ProjectMemoryStore } from '../memory/store.js';
import type { MemoryKind } from '../memory/types.js';
import type { GitProcess } from '../git-safety/git.js';
import type { GitRemotePublisher } from '../git-safety/publisher.js';
import type { GitRepository } from '../git-safety/repository.js';
import type { GitRollbackService } from '../git-safety/rollback.js';
import { formatGitSafetyStatus } from '../git-safety/format.js';
import { commitBoardChanges, ensureBoardBranch, previewBoardCommit } from '../git-safety/workflow.js';
import type { Provider } from '../providers/types.js';
import type { CheckpointStore } from '../session/checkpoint.js';
import type { SessionRecord, SessionStore } from '../session/store.js';
import {
  confirmBoard,
  formatBoard,
  pauseRuntime,
  reopenTask,
  skipTask,
} from '../tasks/runtime.js';
import { TaskBoardStore } from '../tasks/store.js';
import type { ToolRegistry } from '../tools/index.js';

export async function handleSlashCommand(options: {
  line: string;
  config: AppConfig;
  provider: Provider;
  tools: ToolRegistry;
  sessions: SessionStore;
  checkpoints?: CheckpointStore;
  session: SessionRecord;
  confirm?: (message: string) => Promise<boolean>;
  gitRollback?: GitRollbackService;
  gitPublisher?: GitRemotePublisher;
  gitProcess?: GitProcess;
  gitRepository?: GitRepository;
}) {
  const command = options.line.trim();
  if (command === '/不准偷懒开发' || command.startsWith('/不准偷懒开发 ')) {
    return handleLazyDevGuardCommand(command, options.session, options.sessions);
  }
  if (command === '/plan' || command.startsWith('/plan ')) {
    return handlePlanCommand(command, options);
  }
  if (command === '/memory' || command.startsWith('/memory ')) {
    return handleMemoryCommand(command, options);
  }
  if (command === '/rollback' || command.startsWith('/rollback ')) {
    return handleRollbackCommand(command, options);
  }
  if (command === '/git' || command.startsWith('/git ')) {
    return handleGitCommand(command, options);
  }

  switch (command) {
    case '/help':
      return [
        'Commands:',
        '/help       Show this help',
        '/status     Show session and workspace status',
        '/provider   Show active provider',
        '/model      Show active model',
        '/config     Show effective redacted configuration',
        '/tools      List available tools',
        '/summary    Summarize the current session',
        '/plan       Show task board (use /plan confirm|pause|continue|skip|reopen|show)',
        '/memory     Show project memory (use /memory add|list|forget)',
        '/rollback   List/show/preview/apply Git safety unit rollbacks',
        '/git status|commit|publish   Board-linked Git workflow (commit is confirmed)',
        '/git publish <remote> <local-ref> <remote-branch>  Confirmed non-force push',
        '/export     Show transcript file path',
        '/sessions   List recent sessions',
        '/undo       Undo the last checkpointed file change',
        '/不准偷懒开发       开启学习守门模式',
        '/不准偷懒开发 状态  查看守门状态',
        '/exit       Exit interactive mode',
      ].join('\n');
    case '/status': {
      const checkpoints = (await options.checkpoints?.list()) ?? [];
      return [`session: ${options.session.id}`, `workspace: ${options.config.workspaceRoot}`, `approval: ${options.config.approval}`, `tool calls: ${options.session.toolCalls.length}`, `checkpoints: ${checkpoints.length}`].join('\n');
    }
    case '/provider':
      return options.provider.name;
    case '/model':
      return options.provider.model;
    case '/config':
      return JSON.stringify(safeConfig(options.config), null, 2);
    case '/tools':
      return options.tools.list().map((tool) => `${tool.name} [${tool.risk}] - ${tool.description}`).join('\n');
    case '/summary':
      return sessionSummary(options.session);
    case '/export':
      return options.sessions.filePath(options.session.id);
    case '/sessions': {
      const sessions = await options.sessions.list();
      return sessions.slice(0, 10).map((session) => `${session.id} ${session.updatedAt} ${session.provider}/${session.model}`).join('\n') || '(no sessions)';
    }
    case '/undo':
      return options.checkpoints ? options.checkpoints.undoLast() : 'No checkpoint store is available.';
    case '/exit':
      return '__EXIT__';
    default:
      return `Unknown command: ${command}. Try /help.`;
  }
}

async function handleRollbackCommand(
  command: string,
  options: {
    gitRollback?: GitRollbackService;
  },
) {
  if (!options.gitRollback) return 'Git rollback service is unavailable.';
  const args = command.slice('/rollback'.length).trim();
  const [action, unitId] = args.split(/\s+/).filter(Boolean);

  if (!action || action === 'list') {
    const units = await options.gitRollback.list();
    if (units.length === 0) return 'No completed Git safety units.';
    return units.map((unit) => formatGitSafetyStatus(unit)).join('\n');
  }

  if (!unitId) return 'Usage: /rollback show|preview|apply <unit-id>';
  if (action === 'show') {
    const unit = await options.gitRollback.show(unitId);
    return unit ? formatGitSafetyStatus(unit) : `Unknown unit: ${unitId}`;
  }
  if (action === 'preview') {
    const preview = await options.gitRollback.preview(unitId);
    if (!preview.allowed) {
      return [`Rollback blocked for ${unitId}:`, ...preview.conflicts.map((item) => `- ${item.path}: ${item.reason}`)].join('\n');
    }
    return [
      `Rollback preview for ${unitId}:`,
      ...preview.changes.map((change) => `- ${change.kind} ${change.path}${change.sourcePath ? ` (from ${change.sourcePath})` : ''}`),
    ].join('\n');
  }
  if (action === 'apply') {
    const result = await options.gitRollback.apply(unitId);
    if (!result.ok) {
      const conflicts = result.preview.conflicts.map((item) => `- ${item.path}: ${item.reason}`);
      return [`Rollback failed for ${unitId}: ${result.reason ?? 'unknown error'}`, ...conflicts].join('\n');
    }
    return `Rollback applied for ${unitId}${result.snapshot ? ` (snapshot ${result.snapshot.ref})` : ''}.`;
  }
  return 'Unknown /rollback action. Try /rollback list|show|preview|apply.';
}

async function handleGitCommand(
  command: string,
  options: {
    config: AppConfig;
    session: SessionRecord;
    sessions: SessionStore;
    confirm?: (message: string) => Promise<boolean>;
    gitPublisher?: GitRemotePublisher;
    gitProcess?: GitProcess;
    gitRepository?: GitRepository;
  },
) {
  const args = command.slice('/git'.length).trim().split(/\s+/).filter(Boolean);
  const [action, remote, localRef, remoteBranch] = args;

  if (!action || action === 'status') {
    if (!options.gitProcess) return 'Git process is unavailable.';
    try {
      const branch = (await options.gitProcess.text(['branch', '--show-current'])).trim() || '(detached)';
      const status = (await options.gitProcess.text(['status', '--short'])).trim() || '(clean)';
      const board = await loadCurrentBoard(new TaskBoardStore(options.config.workspaceRoot), options.session);
      return [
        `branch: ${branch}`,
        board?.gitBranch ? `boardBranch: ${board.gitBranch}` : undefined,
        board?.gitCommitSha ? `boardCommit: ${board.gitCommitSha}` : undefined,
        'status:',
        status,
      ].filter((line): line is string => typeof line === 'string').join('\n');
    } catch (error) {
      return `Git status failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (action === 'commit') {
    if (!options.gitProcess) return 'Git process is unavailable.';
    const store = new TaskBoardStore(options.config.workspaceRoot);
    const board = await loadCurrentBoard(store, options.session);
    if (!board) return 'No task board attached. Use /plan show <boardId> first.';
    const preview = await previewBoardCommit({ git: options.gitProcess, board });
    if (!preview.hasChanges) return `No changes to commit on ${preview.branch}.`;
    if (!options.confirm) {
      return [
        `Commit requires confirmation. Preview on ${preview.branch}:`,
        preview.status,
        preview.diffStat,
        'Suggested message:',
        preview.suggestedMessage,
        'Re-run interactively to confirm, or provide a confirm handler.',
      ].join('\n');
    }
    const accepted = await options.confirm(`Commit board changes on ${preview.branch}?`);
    if (!accepted) return 'Commit declined.';
    const result = await commitBoardChanges({ git: options.gitProcess, board });
    if (result.ok && result.sha) {
      board.gitCommitSha = result.sha;
      board.updatedAt = new Date().toISOString();
      await store.save(board);
    }
    return result.message;
  }

  if (action !== 'publish') {
    return 'Unknown /git action. Try /git status, /git commit, /git publish <remote> <local-ref> <remote-branch>.';
  }
  if (!options.gitPublisher) return 'Git publisher is unavailable.';
  if (!remote || !localRef || !remoteBranch || args.length !== 4) {
    return 'Usage: /git publish <remote> <local-ref> <remote-branch>';
  }
  try {
    const result = await options.gitPublisher.publish({
      remote,
      localRef,
      remoteBranch,
      sessionId: options.session.id,
    }, options.confirm);
    return result.ok ? result.reason : `Publish declined or failed: ${result.reason}`;
  } catch (error) {
    return `Publish rejected: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function handleMemoryCommand(
  command: string,
  options: {
    config: AppConfig;
  },
) {
  const store = new ProjectMemoryStore(options.config.workspaceRoot);
  const args = command.slice('/memory'.length).trim();
  const [action, ...rest] = args.split(/\s+/).filter(Boolean);

  if (!action || action === 'list') {
    return formatMemoryList(await store.list());
  }

  if (action === 'add') {
    const kind = rest[0] as MemoryKind | undefined;
    const summary = rest.slice(1).join(' ').trim();
    if (!kind || !['convention', 'decision', 'pitfall', 'note'].includes(kind) || !summary) {
      return 'Usage: /memory add <convention|decision|pitfall|note> <text>';
    }
    const entry = await store.add({ kind, summary, source: { type: 'user' } });
    return `Added ${entry.id} [${entry.kind}] ${entry.summary}`;
  }

  if (action === 'forget') {
    const target = rest.join(' ').trim();
    if (!target) return 'Usage: /memory forget <id|query>';
    const entry = await store.forget(target);
    if (!entry) return `No active memory matched: ${target}`;
    return `Forgot ${entry.id} [${entry.kind}] ${entry.summary}`;
  }

  return 'Unknown /memory action. Try /memory, /memory list, /memory add <kind> <text>, /memory forget <id|query>.';
}

async function handlePlanCommand(
  command: string,
  options: {
    config: AppConfig;
    sessions: SessionStore;
    session: SessionRecord;
    confirm?: (message: string) => Promise<boolean>;
    gitProcess?: GitProcess;
    gitRepository?: GitRepository;
  },
) {
  const store = new TaskBoardStore(options.config.workspaceRoot);
  const args = command.slice('/plan'.length).trim();
  const [action, ...rest] = args.split(/\s+/).filter(Boolean);
  const nowIso = new Date().toISOString();

  if (!action) {
    const board = await loadCurrentBoard(store, options.session);
    if (!board) {
      const legacy = sessionPlan(options.session);
      return `No task board attached.\nLegacy tool progress:\n${legacy}`;
    }
    return formatBoard(board);
  }

  if (action === 'show') {
    const boardId = rest[0];
    if (!boardId) return 'Usage: /plan show <boardId>';
    const board = await store.load(boardId);
    options.session.taskRuntime = {
      boardId: board.id,
      activeTaskId: board.tasks.find((task) => task.status === 'in_progress')?.id,
      mode: board.status === 'draft' ? 'awaiting_confirm' : options.session.taskRuntime?.mode === 'paused' ? 'paused' : 'executing',
      lastSyncAt: nowIso,
    };
    await options.sessions.save(options.session);
    return formatBoard(board);
  }

  const board = await loadCurrentBoard(store, options.session);
  if (!board) return 'No task board attached. Create one from a large requirement or /plan show <boardId>.';

  switch (action) {
    case 'confirm': {
      if (board.status !== 'draft' && board.status !== 'active') {
        return `Board ${board.id} cannot be confirmed from status ${board.status}`;
      }
      confirmBoard(board, nowIso);
      let branchNote = '';
      if (options.gitProcess && options.gitRepository) {
        const branchResult = await ensureBoardBranch({
          git: options.gitProcess,
          repository: options.gitRepository,
          board,
          confirm: options.confirm,
        });
        if (branchResult.branch) board.gitBranch = branchResult.branch;
        branchNote = `\n${branchResult.message}`;
      }
      await store.save(board);
      options.session.taskRuntime = {
        boardId: board.id,
        activeTaskId: undefined,
        mode: 'executing',
        lastSyncAt: nowIso,
      };
      await options.sessions.save(options.session);
      return `${formatBoard(board)}\nConfirmed. Auto-execution enabled.${branchNote}`;
    }
    case 'pause': {
      options.session.taskRuntime = pauseRuntime(options.session.taskRuntime ?? { mode: 'idle', boardId: board.id }, nowIso);
      options.session.taskRuntime.boardId = board.id;
      await options.sessions.save(options.session);
      return `Paused board ${board.id}.`;
    }
    case 'continue': {
      options.session.taskRuntime = {
        boardId: board.id,
        activeTaskId: board.tasks.find((task) => task.status === 'blocked' || task.status === 'in_progress')?.id,
        mode: 'executing',
        lastSyncAt: nowIso,
      };
      if (board.status === 'blocked') {
        const blocked = board.tasks.find((task) => task.status === 'blocked');
        if (blocked) {
          reopenTask(board, blocked.id, nowIso);
          await store.save(board);
        }
      }
      await options.sessions.save(options.session);
      return `${formatBoard(board)}\nContinue enabled.`;
    }
    case 'skip': {
      const taskId = rest[0];
      if (!taskId) return 'Usage: /plan skip <taskId>';
      skipTask(board, taskId, nowIso);
      await store.save(board);
      await options.sessions.save(options.session);
      return formatBoard(board);
    }
    case 'reopen': {
      const taskId = rest[0];
      if (!taskId) return 'Usage: /plan reopen <taskId>';
      reopenTask(board, taskId, nowIso);
      await store.save(board);
      await options.sessions.save(options.session);
      return formatBoard(board);
    }
    default:
      return `Unknown /plan action: ${action}. Try /plan, /plan confirm, /plan pause, /plan continue, /plan skip <id>, /plan reopen <id>, /plan show <boardId>.`;
  }
}

async function loadCurrentBoard(store: TaskBoardStore, session: SessionRecord) {
  const boardId = session.taskRuntime?.boardId;
  if (!boardId) return undefined;
  try {
    return await store.load(boardId);
  } catch {
    return undefined;
  }
}

function sessionSummary(session: SessionRecord) {
  const lastUser = [...session.messages].reverse().find((message) => message.role === 'user')?.content ?? '(none)';
  const lastAnswer = session.finalAnswers.at(-1) ?? '(none)';
  const okTools = session.toolCalls.filter((call) => call.ok).length;
  const failedTools = session.toolCalls.length - okTools;
  return [
    `session: ${session.id}`,
    `messages: ${session.messages.length}`,
    `tool calls: ${session.toolCalls.length} (${okTools} ok, ${failedTools} failed)`,
    `last user: ${truncate(lastUser, 180)}`,
    `last answer: ${truncate(lastAnswer, 180)}`,
  ].join('\n');
}

function sessionPlan(session: SessionRecord) {
  const recent = session.toolCalls.slice(-8);
  if (recent.length === 0) return 'No tool calls yet.';
  return recent.map((call, index) => `${index + 1}. ${call.ok ? 'done' : 'failed'} ${call.tool}`).join('\n');
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function handleLazyDevGuardCommand(command: string, session: SessionRecord, sessions: SessionStore) {
  const args = command.slice('/不准偷懒开发'.length).trim().split(/\s+/).filter(Boolean);
  const subcommand = args[0];
  const existingState = session.guard?.lazyDev;

  if (!subcommand) {
    const state = ensureLazyDevGuard(session);
    state.enabled = true;
    state.paused = undefined;
    await sessions.save(session);
    return lazyDevRulesSummary(state);
  }

  switch (subcommand) {
    case '状态':
      return existingState ? lazyDevStatus(existingState) : lazyDevStatusUnavailable();
    case '继续': {
      const state = ensureLazyDevGuard(session);
      if (state.paused) {
        state.paused = undefined;
        await sessions.save(session);
        return '不准偷懒开发已恢复。';
      }
      const message = resumeBlockedRequirement(state);
      await sessions.save(session);
      return message;
    }
    case '归档': {
      const state = ensureLazyDevGuard(session);
      const message = archiveCurrentRequirement(state);
      await sessions.save(session);
      return message;
    }
    case '取消': {
      const state = ensureLazyDevGuard(session);
      const message = cancelCurrentRequirement(state);
      await sessions.save(session);
      return message;
    }
    case '暂停': {
      const state = ensureLazyDevGuard(session);
      const reason = args.slice(1).join(' ') || '用户暂停守门';
      state.paused = {
        reason,
        createdAt: new Date().toISOString(),
        resumeHint: '/不准偷懒开发 继续',
      };
      await sessions.save(session);
      return `不准偷懒开发已暂停：${reason}`;
    }
    case '关闭': {
      const state = ensureLazyDevGuard(session);
      if (hasActiveUnpassedRequirement(state)) {
        return '当前需求尚未通过、归档或取消，不能关闭不准偷懒开发。请先通过检查，或使用 /不准偷懒开发 归档 / 取消。';
      }
      return '关闭不准偷懒开发需要二次确认。若确认关闭，请输入：/不准偷懒开发 确认关闭不准偷懒开发';
    }
    case '确认关闭不准偷懒开发': {
      const state = ensureLazyDevGuard(session);
      if (hasActiveUnpassedRequirement(state)) {
        return '当前需求尚未通过、归档或取消，不能关闭不准偷懒开发。请先通过检查，或使用 /不准偷懒开发 归档 / 取消。';
      }
      state.enabled = false;
      state.paused = undefined;
      await sessions.save(session);
      return '不准偷懒开发已关闭。';
    }
    case '设置': {
      const state = ensureLazyDevGuard(session);
      return configureLazyDevGuard(args.slice(1), state, session, sessions);
    }
    default:
      return lazyDevUnknownCommand(command);
  }
}

async function configureLazyDevGuard(args: string[], state: LazyDevGuardState, session: SessionRecord, sessions: SessionStore) {
  const key = args[0];
  const value = args[1];

  if (key === '强度') {
    if (!value) return '请提供强度：新手、标准、老手、只翻译。';
    if (hasActiveUnpassedRequirement(state)) return '当前存在未通过需求，不能修改强度。请先通过检查，或归档/取消当前需求。';

    const strictness = parseStrictness(value);
    if (!strictness) return `无效强度：${value}。可用：新手、标准、老手、只翻译。`;

    state.config.strictness = strictness;
    await sessions.save(session);
    return `强度：${strictness}`;
  }

  if (key === '最大补答次数') {
    const parsed = Number(value);
    try {
      state.config.defaultMaxAttempts = clampMaxAttempts(parsed);
    } catch {
      return '请提供最大补答次数：1、2 或 3。';
    }
    await sessions.save(session);
    return `最大补答次数：${state.config.defaultMaxAttempts}`;
  }

  return '可设置项：强度 <新手|标准|老手|只翻译>，最大补答次数 <1|2|3>。';
}

function lazyDevUnknownCommand(command: string) {
  return `未知的不准偷懒开发命令：${command}。可用：/不准偷懒开发、/不准偷懒开发 状态、/不准偷懒开发 设置。`;
}

function lazyDevStatusUnavailable() {
  return ['状态：关闭', '不准偷懒开发尚未开启。使用 /不准偷懒开发 开启学习守门模式。'].join('\n');
}

function lazyDevRulesSummary(state: LazyDevGuardState) {
  return [
    '不准偷懒开发已开启。',
    `强度：${state.config.strictness}`,
    `最大补答次数：${state.config.defaultMaxAttempts}`,
    '规则：先把需求转换成专业描述，再通过入门检查；未通过会阻塞开发。',
    '查看状态：/不准偷懒开发 状态',
  ].join('\n');
}

function lazyDevStatus(state: LazyDevGuardState) {
  const current = state.currentRequirement;
  return [
    `状态：${state.enabled ? '开启' : '关闭'}${state.paused ? `（暂停：${state.paused.reason}）` : ''}`,
    `强度：${state.config.strictness}`,
    `当前需求：${formatCurrentRequirement(current)}`,
    `剩余补答：${remainingAttempts(current)}`,
    `检查次数：${state.metrics.totalChecks}`,
    `阻塞次数：${state.metrics.blocked}`,
  ].join('\n');
}

function formatCurrentRequirement(requirement: LazyDevRequirement | undefined) {
  if (!requirement) return '无';
  return `${requirement.status}，风险：${requirement.riskLevel}，${truncate(requirement.translatedRequirement.summary, 80)}`;
}

function remainingAttempts(requirement: LazyDevRequirement | undefined) {
  if (!requirement || requirement.status === 'passed' || requirement.status === 'archived' || requirement.status === 'cancelled') return '无';
  return Math.max(0, requirement.maxAttempts - requirement.attemptsUsed).toString();
}

function hasActiveUnpassedRequirement(state: LazyDevGuardState) {
  const status = state.currentRequirement?.status;
  return Boolean(status && status !== 'passed' && status !== 'archived' && status !== 'cancelled');
}
