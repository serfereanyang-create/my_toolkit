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
import type { AgentRuntime } from '../agent/agent.js';
import type { AutomationManager } from '../automation/manager.js';
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
import { formatMcpStatus, type McpManager } from '../mcp/manager.js';
import {
  captureClipboardImage,
  registerAttachment,
  type Attachment,
} from './attachments.js';
import { formatByteSize, MAX_USER_TEXT_BYTES_HARD } from './limits.js';
import { formatHelpText } from './commandPalette.js';
import { formatCacheProbe } from '../probe/cacheProbe.js';
import { detectLocale } from '../i18n/locale.js';
import { formatApprovalOutcome, formatApprovalPrompt, formatGitConfirm } from '../i18n/messages.js';
import { decideApproval } from '../safety/policy.js';
import { formatSandboxResult, runSandboxedCommand } from '../safety/sandbox.js';
import type { ApprovalDecision, ApprovalRequest } from '../tools/types.js';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { checkEnvContract } from '../config/envContract.js';
import { ReflectionStore } from '../reflection/store.js';
import { planVersionBump, renderBumpReport } from '../prreview/versionBump.js';

/** /version — 基于最近提交的版本升级建议（conventional 分析）。 */
async function handleVersionCommand(workspaceRoot: string): Promise<string> {
  let current = 'unknown';
  try {
    const raw = await readFile(join(workspaceRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === 'string') current = pkg.version;
  } catch { /* 无 package.json 时保持 unknown */ }
  const titles = await readRecentCommitTitles(workspaceRoot);
  if (titles.length === 0) {
    return `当前版本: ${current}；没有可分析的提交历史。`;
  }
  return renderBumpReport(planVersionBump(current, titles));
}

/** 读取最近 50 条非 merge 提交标题；git 不可用时返回空。 */
async function readRecentCommitTitles(workspaceRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '--max-count=50', '--no-merges', '--pretty=format:%s'], {
      cwd: workspaceRoot,
    });
    const lines = stdout.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
    return lines;
  } catch {
    return [];
  }
}

/**
 * /subagents — list this session's spawn_subagent runs.
 *
 * There is no dedicated subagent index: each run is recorded as a
 * `spawn_subagent` tool call on the parent session, whose `data` holds the
 * SubAgentResult[] (id, expert, ok, answer, sub-session id, duration, steps).
 * Reading those back is what makes the command possible without a new store.
 */
function formatSubagentRuns(session: SessionRecord): string {
  const runs: Array<{
    id: string; expert: string; ok: boolean; answer: string;
    sessionId?: string; durationMs?: number; steps?: number;
  }> = [];
  for (const call of session.toolCalls) {
    if (call.tool !== 'spawn_subagent' || !Array.isArray(call.data)) continue;
    for (const item of call.data as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object') continue;
      runs.push({
        id: String(item.id ?? '?'),
        expert: String(item.expert ?? 'general'),
        ok: item.ok !== false,
        answer: String(item.answer ?? ''),
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : undefined,
        durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
        steps: typeof item.steps === 'number' ? item.steps : undefined,
      });
    }
  }
  if (runs.length === 0) {
    return '本次会话还没有子智能体运行记录。主智能体通过 spawn_subagent 派发子任务后会出现在这里。';
  }
  const lines = [`子智能体运行记录（${runs.length} 条）:`];
  for (const run of runs) {
    const status = run.ok ? '✔ 完成' : '✘ 失败';
    const meta = [
      run.expert,
      run.steps != null ? `${run.steps} 步` : '',
      run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '',
      run.sessionId ? `会话 ${run.sessionId}` : '',
    ].filter(Boolean).join(' · ');
    lines.push(`- [${run.id}] ${status} ${meta}`);
    if (run.answer) lines.push(`  ${run.answer.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return lines.join('\n');
}

/** /reflect — 查看最近沉淀的失败教训（按命中次数排序）。 */
async function handleReflectCommand(workspaceRoot: string): Promise<string> {
  const store = new ReflectionStore(workspaceRoot);
  const entries = await store.list();
  if (entries.length === 0) {
    return '还没有失败教训。任务终态失败（异常或步数耗尽）时会自动沉淀到这里。';
  }
  const sorted = [...entries].sort((a, b) => b.hits - a.hits || b.at.localeCompare(a.at)).slice(0, 10);
  const lines = [`失败教训（${entries.length} 条，显示最近高频 ${sorted.length} 条）:`];
  for (const entry of sorted) {
    lines.push(`- [${entry.kind}] ${entry.topic}`);
    lines.push(`  失败: ${entry.failure.slice(0, 80)}`);
    lines.push(`  教训: ${entry.lesson}`);
  }
  return lines.join('\n');
}

/** /env-check — .env.example / 源码读取 / 本地 .env 三方键对账（只报键名，不触碰值）。 */
async function handleEnvCheckCommand(workspaceRoot: string): Promise<string> {
  const report = await checkEnvContract(workspaceRoot);
  const lines: string[] = [
    `env.example: ${report.exampleFile ?? 'missing'} (${report.exampleKeys.length} keys)`,
    `code reads: ${report.codeKeys.length} keys`,
    `local .env: ${report.localKeys.length} keys`,
  ];
  if (report.issues.length === 0) {
    lines.push('OK: env contract consistent.');
    return lines.join('\n');
  }
  const byKind = new Map<string, string[]>();
  for (const issue of report.issues) {
    const bucket = byKind.get(issue.kind) ?? [];
    bucket.push(issue.key);
    byKind.set(issue.kind, bucket);
  }
  for (const [kind, keys] of byKind) {
    lines.push(`${kind} (${keys.length}): ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? ' ...' : ''}`);
  }
  return lines.join('\n');
}

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
  mcp?: McpManager;
  reloadMcp?: () => Promise<McpManager>;
  pendingAttachments?: Attachment[];
  /** Desktop compaction divider hook (see AgentRuntime.compactEmit). */
  compactEmit?: (payload: {
    phase: 'started' | 'completed' | 'failed';
    auto: boolean;
    before?: number;
    after?: number;
    reason?: string;
  }) => void;
}) {
  const command = options.line.trim();
  if (command === '/不准偷懒开发' || command.startsWith('/不准偷懒开发 ')) {
    return handleLazyDevGuardCommand(command, options.session, options.sessions);
  }
  // ── New commands ────────────────────────────────────────────────────────────
  if (command === '/compact' || command.startsWith('/compact ')) {
    return handleCompactCommand(command, options);
  }
  if (command === '/goal' || command.startsWith('/goal ')) {
    return handleGoalCommand(command, options);
  }
  if (command === '/computer' || command.startsWith('/computer ')) {
    return handleComputerCommand(command, options);
  }
  if (command === '/init' || command.startsWith('/init ')) {
    return handleInitCommand(command, options);
  }
  if (command === '/clear') {
    options.session.messages = [];
    options.session.finalAnswers = [];
    await options.sessions.save(options.session);
    return 'Session history cleared. The next message starts a fresh context.';
  }
  if (command === '/history' || command.startsWith('/history ')) {
    return handleHistoryCommand(command, options);
  }
  if (command === '/tokens') {
    const chars = options.session.messages.reduce((s, m) => s + m.content.length, 0);
    const estTokens = Math.round(chars / 4);
    return `Context: ${chars.toLocaleString()} chars ≈ ${estTokens.toLocaleString()} tokens | Messages: ${options.session.messages.length}`;
  }
  if (command === '/retry') {
    // Real replay lives in repl.ts (retryLastUserTurn) — the interactive loop
    // special-cases /retry before reaching here. This branch only serves
    // non-TTY/desktop callers that bypass runPromptMode and expect an explicit
    // status instead of a silent no-op.
    const lastUser = [...options.session.messages].reverse().find((m) => m.role === 'user');
    return lastUser
      ? 'Retry is executed by the interactive loop (use /retry in the REPL or --prompt /retry).'
      : 'No previous user message found.';
  }
  if (command === '/doctor') {
    return handleDoctorCommand(options);
  }
  if (command === '/env') {
    return handleEnvCommand(options);
  }
  if (command === '/models') {
    return handleModelsCommand(options);
  }
  if (command === '/thinking' || command.startsWith('/thinking ')) {
    return handleThinkingCommand(command, options);
  }
  if (command === '/scope' || command.startsWith('/scope ')) {
    return handleScopeCommand(command, options);
  }
  if (command === '/review' || command.startsWith('/review ')) {
    return handleReviewCommand(command);
  }
  if (command === '/security') {
    return 'Run a security review with: ask the agent "Please do a security review of this project".\nOr use /mimosa-scan (Mimosa plugin) if installed.';
  }
  if (command === '/lint' || command.startsWith('/lint ')) {
    return handleLintCommand(command, options);
  }
  if (command === '/diff') {
    return handleDiffCommand(options);
  }
  if (command === '/complexity' || command.startsWith('/complexity ')) {
    return handleComplexityCommand(command, options);
  }
  if (command === '/deps') {
    return handleDepsCommand(options);
  }
  if (command === '/find' || command.startsWith('/find ')) {
    return handleFindCommand(command, options);
  }
  if (command === '/grep' || command.startsWith('/grep ')) {
    return handleGrepCommand(command, options);
  }
  if (command === '/run' || command.startsWith('/run ')) {
    return handleRunCommand(command, options);
  }
  if (command === '/ls' || command.startsWith('/ls ')) {
    return handleLsCommand(command, options);
  }
  if (command === '/read' || command.startsWith('/read ')) {
    return handleReadCommand(command, options);
  }
  if (command === '/rename' || command.startsWith('/rename ')) {
    return handleRenameCommand(command, options);
  }
  if (command === '/pin') {
    return handlePinCommand(options);
  }
  if (command === '/share') {
    return `Session export path:\n${options.sessions.filePath(options.session.id)}`;
  }
  if (command === '/load' || command.startsWith('/load ')) {
    return handleLoadCommand(command, options);
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
  if (command === '/mcp' || command.startsWith('/mcp ')) {
    return handleMcpCommand(command, options);
  }
  if (command === '/attach' || command.startsWith('/attach ')) {
    return handleAttachCommand(command, options);
  }
  if (command === '/automate' || command.startsWith('/automate ')) {
    return handleAutomateCommand(command, options);
  }
  if (command === '/paste-image' || command === '/clip') {
    return handlePasteImageCommand(options);
  }
  if (command === '/attachments') {
    const pending = options.pendingAttachments ?? [];
    if (pending.length === 0) return 'No staged attachments. Use /attach <path> or /paste-image.';
    return [
      `Staged attachments (${pending.length}):`,
      ...pending.map((item) => `- [${item.kind}] ${item.name} ${formatByteSize(item.bytes)} → ${item.storedPath}`),
      'Send a normal message (or empty with only attachments not supported—type a short note) to submit with the next turn.',
    ].join('\n');
  }
  if (command === '/cache' || command === '/probe' || command === '/probe cache' || command.startsWith('/cache ')) {
    return formatCacheProbe();
  }

  switch (command) {
    case '/help':
    case '/?':
    case '/commands':
      // Interactive REPL intercepts /help for the floating palette; this is the text fallback.
      return formatHelpText();
    case '/status': {
      const checkpoints = (await options.checkpoints?.list()) ?? [];
      return [
        `session: ${options.session.id}`,
        `workspace: ${options.config.workspaceRoot}`,
        `approval: ${options.config.approval}`,
        `tool calls: ${options.session.toolCalls.length}`,
        `checkpoints: ${checkpoints.length}`,
        formatCacheProbe().split('\n').slice(0, 2).join(' | '),
      ].join('\n');
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
    case '/actions':
    case '/menu':
      return 'Open Message Actions with /actions in interactive mode (floating menu).';
    case '/undo':
      return options.checkpoints ? options.checkpoints.undoLast() : 'No checkpoint store is available.';
    case '/env-check':
      return handleEnvCheckCommand(options.config.workspaceRoot);
    case '/subagents':
      return formatSubagentRuns(options.session);
    case '/reflect':
      return handleReflectCommand(options.config.workspaceRoot);
    case '/version':
      return handleVersionCommand(options.config.workspaceRoot);
    case '/exit':
      return '__EXIT__';
    default:
      return `Unknown command: ${command}. Try /help.`;
  }
}

async function handleAttachCommand(
  command: string,
  options: {
    config: AppConfig;
    session: SessionRecord;
    pendingAttachments?: Attachment[];
  },
) {
  const raw = command.slice('/attach'.length).trim();
  if (!raw) return 'Usage: /attach <path> [path2 …]  (quote paths with spaces)';
  const paths = tokenizePaths(raw);
  if (paths.length === 0) return 'Usage: /attach <path> [path2 …]';
  if (!options.pendingAttachments) return 'Attachment staging is only available in interactive mode.';
  const added: string[] = [];
  for (const path of paths) {
    try {
      const attachment = await registerAttachment({
        workspaceRoot: options.config.workspaceRoot,
        sessionId: options.session.id,
        sourcePath: path,
      });
      options.pendingAttachments.push(attachment);
      added.push(`${attachment.name} (${attachment.kind}, ${formatByteSize(attachment.bytes)})`);
    } catch (error) {
      added.push(`${path}: FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [`Staged ${added.length} path(s):`, ...added.map((line) => `- ${line}`), 'Next chat message will include them (images → vision).'].join('\n');
}

async function handlePasteImageCommand(options: {
  config: AppConfig;
  session: SessionRecord;
  pendingAttachments?: Attachment[];
}) {
  if (!options.pendingAttachments) return 'Clipboard image capture is only available in interactive mode.';
  try {
    const attachment = await captureClipboardImage({
      workspaceRoot: options.config.workspaceRoot,
      sessionId: options.session.id,
    });
    options.pendingAttachments.push(attachment);
    return `Staged clipboard image: ${attachment.name} (${formatByteSize(attachment.bytes)}) at ${attachment.storedPath}. Send a message to submit.`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function tokenizePaths(raw: string): string[] {
  const paths: string[] = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    paths.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return paths.filter(Boolean);
}

async function handleMcpCommand(
  command: string,
  options: {
    mcp?: McpManager;
    reloadMcp?: () => Promise<McpManager>;
  },
) {
  const args = command.slice('/mcp'.length).trim();
  const action = args.split(/\s+/).filter(Boolean)[0] ?? 'status';
  if (action === 'reload') {
    if (!options.reloadMcp) return 'MCP reload is unavailable in this mode.';
    const manager = await options.reloadMcp();
    return formatMcpStatus(manager.statuses);
  }
  if (action === 'status' || action === '') {
    return formatMcpStatus(options.mcp?.statuses ?? []);
  }
  return 'Unknown /mcp action. Try /mcp or /mcp reload.';
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
    const locale = detectLocale(board.goal ?? board.title);
    const accepted = await options.confirm(formatGitConfirm({
      locale,
      kind: 'board_commit',
      boardId: board.id,
      branch: preview.branch,
    }));
    if (!accepted) return locale === 'zh' ? '已取消提交。' : 'Commit declined.';
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

async function handleAutomateCommand(
  command: string,
  options: {
    config: AppConfig;
    sessions: SessionStore;
    session: SessionRecord;
  } & Partial<AgentRuntime>,
): Promise<string> {
  const parts = command.split(/\s+/);
  const subcommand = parts[1];

  if (!subcommand || subcommand === 'help') {
    return [
      'Automation commands:',
      '  /automate list                    - List all automation tasks',
      '  /automate create                  - Create a new automation task (interactive)',
      '  /automate start <task-id>         - Start an automation task',
      '  /automate stop <task-id>          - Stop an automation task',
      '  /automate delete <task-id>        - Delete an automation task',
      '  /automate status <task-id>        - Show task status and history',
      '  /automate run <task-id>           - Manually trigger task execution',
    ].join('\n');
  }

  // Read-only lookups work without a live runtime. Mutating operations (start/
  // stop/delete/run) must reuse a runtime-scoped manager so watchers and git
  // monitors are tracked and closed with the session instead of leaking.
  const needsRuntime = ['start', 'stop', 'delete', 'run'].includes(subcommand);
  const runtime = options as AgentRuntime;
  let manager: AutomationManager | undefined = runtime.automationManager;
  if (!manager) {
    if (needsRuntime && !(runtime.provider && runtime.ui)) {
      return `Automation "${subcommand}" requires an interactive session with a configured provider.`;
    }
    const { AutomationManager: Manager } = await import('../automation/manager.js');
    if (runtime.provider && runtime.ui) {
      manager = new Manager(runtime.config.workspaceRoot, runtime);
      runtime.automationManager = manager;
    } else {
      manager = new Manager(runtime.config.workspaceRoot);
    }
  }

  if (subcommand === 'list') {
    const tasks = await manager.listTasks();
    if (tasks.length === 0) {
      return 'No automation tasks found. Use /automate create to create one.';
    }
    
    const activeWatchers = manager.getActiveFileWatchers();
    
    return tasks.map((t) => {
      const status = t.enabled ? '✓ enabled' : '✗ disabled';
      const triggerType = t.trigger.type === 'file_watch' ? '📁 watch' : 
                         t.trigger.type === 'cron' ? '⏰ cron' : 
                         t.trigger.type === 'git_event' ? '🔀 git' : '🖱️ manual';
      const watching = activeWatchers.includes(t.id) ? ' [watching]' : '';
      const lastRun = t.lastRunAt ? ` | last: ${t.lastRunStatus} at ${t.lastRunAt}` : '';
      return `${t.id} - ${t.name} [${status}] ${triggerType}${watching}${lastRun}`;
    }).join('\n');
  }

  if (subcommand === 'start') {
    const taskId = parts[2];
    if (!taskId) return 'Usage: /automate start <task-id>';
    
    await manager.startTask(taskId);
    return `Started automation task: ${taskId}`;
  }

  if (subcommand === 'stop') {
    const taskId = parts[2];
    if (!taskId) return 'Usage: /automate stop <task-id>';
    
    await manager.stopTask(taskId);
    return `Stopped automation task: ${taskId}`;
  }

  if (subcommand === 'delete') {
    const taskId = parts[2];
    if (!taskId) return 'Usage: /automate delete <task-id>';
    
    const deleted = await manager.deleteTask(taskId);
    return deleted ? `Deleted automation task: ${taskId}` : `Task not found: ${taskId}`;
  }

  if (subcommand === 'status') {
    const taskId = parts[2];
    if (!taskId) return 'Usage: /automate status <task-id>';
    
    const task = await manager.getTask(taskId);
    if (!task) return `Task not found: ${taskId}`;
    
    const history = await manager.getTaskHistory(taskId, 5);
    const historyText = history.length > 0
      ? '\nRecent executions:\n' + history.map((h) => `  ${h.status} at ${h.executedAt}`).join('\n')
      : '\nNo execution history';
    
    let triggerDetails = '';
    if (task.trigger.type === 'file_watch') {
      const fw = task.trigger as any;
      triggerDetails = `\nWatching: ${fw.patterns.join(', ')}\nEvents: ${fw.events.join(', ')}\nDebounce: ${fw.debounceMs || 1000}ms`;
    } else if (task.trigger.type === 'cron') {
      const ct = task.trigger as any;
      triggerDetails = `\nCron: ${ct.expression}`;
    }
    
    const activeWatchers = manager.getActiveFileWatchers();
    const isWatching = activeWatchers.includes(taskId) ? ' (actively watching)' : '';
    
    return [
      `Task: ${task.name}`,
      `ID: ${task.id}`,
      `Status: ${task.enabled ? 'enabled' : 'disabled'}${isWatching}`,
      `Trigger: ${task.trigger.type}${triggerDetails}`,
      `Goal: ${task.action.goal}`,
      `Last run: ${task.lastRunAt || 'never'} (${task.lastRunStatus || 'N/A'})`,
      `Consecutive failures: ${task.consecutiveFailures || 0}`,
      historyText,
    ].join('\n');
  }

  if (subcommand === 'run') {
    const taskId = parts[2];
    if (!taskId) return 'Usage: /automate run <task-id>';

    const task = await manager.getTask(taskId);
    if (!task) return `Task not found: ${taskId}`;

    runtime.ui.info(`Running automation task "${task.name}" (${taskId})…`);
    const result = await manager.runTask(taskId, runtime);
    const lines = [`Task ${taskId} finished: ${result.status} at ${result.executedAt}`];
    if (result.boardId) lines.push(`Task board: ${result.boardId}`);
    if (result.error) lines.push(`Error: ${result.error}`);
    return lines.join('\n');
  }

  if (subcommand === 'create') {
    const { InteractiveTaskCreator } = await import('../automation/interactive.js');
    const creator = new InteractiveTaskCreator();
    
    const templateArg = parts[2];
    
    if (!templateArg) {
      // 显示创建指南和模板
      const templates = creator.getQuickTemplates();
      const templateList = templates.map((t, i) => 
        `${i + 1}. ${t.name} - ${t.description}`
      ).join('\n');
      
      return [
        'Automation Task Creation',
        '',
        'Quick Templates:',
        templateList,
        '',
        'To use a template: /automate create <number>',
        'For detailed guide: /automate create guide',
        '',
        'Or create tasks programmatically using AutomationManager API.',
      ].join('\n');
    }
    
    if (templateArg === 'guide') {
      return creator.getCreationGuide();
    }
    
    // 如果是数字，显示模板详情
    const templateIndex = parseInt(templateArg, 10) - 1;
    const templates = creator.getQuickTemplates();
    
    if (templateIndex >= 0 && templateIndex < templates.length) {
      const template = templates[templateIndex];
      return [
        `Template: ${template.name}`,
        `Description: ${template.description}`,
        '',
        'Configuration:',
        JSON.stringify(template.config, null, 2),
        '',
        'To create this task, use the AutomationManager API:',
        `await manager.createTask(${JSON.stringify(template.config, null, 2)});`,
        'await manager.startTask(task.id);',
      ].join('\n');
    }
    
    return 'Invalid template number. Use /automate create to see available templates.';
  }

  return `Unknown subcommand: ${subcommand}. Try /automate help.`;
}

// ── New command handlers ───────────────────────────────────────────────────────

async function handleCompactCommand(
  command: string,
  options: {
    session: SessionRecord;
    sessions: SessionStore;
    compactEmit?: (payload: { phase: 'started' | 'completed' | 'failed'; auto: boolean; before?: number; after?: number; reason?: string }) => void;
  },
): Promise<string> {
  const arg = command.slice('/compact'.length).trim();
  const keepLast = arg ? Math.max(2, parseInt(arg, 10) || 20) : 20;
  const { session, sessions } = options;
  const total = session.messages.length;
  if (total <= keepLast) {
    return `Nothing to compact — session has ${total} message(s) (keep-last: ${keepLast}).`;
  }
  options.compactEmit?.({ phase: 'started', auto: false, before: total });
  const dropped = total - keepLast;
  const summaryHint = session.finalAnswers.at(-1)?.slice(0, 200) ?? 'Earlier context has been compacted.';
  session.messages = [
    {
      role: 'assistant',
      content: `[Compacted — ${dropped} message(s) removed. Summary: ${summaryHint}]`,
      createdAt: new Date().toISOString(),
    },
    ...session.messages.slice(-keepLast),
  ];
  await sessions.save(session);
  options.compactEmit?.({ phase: 'completed', auto: false, before: total, after: session.messages.length });
  return `Compacted: kept last ${keepLast} of ${total} message(s) (${dropped} removed). Summary stub injected.`;
}

async function handleGoalCommand(
  command: string,
  options: { session: SessionRecord; sessions: SessionStore },
): Promise<string> {
  const text = command.slice('/goal'.length).trim();
  if (text === 'clear') {
    options.session.goal = undefined;
    await options.sessions.save(options.session);
    return 'Session goal cleared.';
  }
  if (!text) {
    return options.session.goal
      ? `Current goal: ${options.session.goal}`
      : 'No goal set. Usage: /goal <text>  |  /goal clear';
  }
  options.session.goal = text;
  await options.sessions.save(options.session);
  return `Goal set: ${text}`;
}

async function handleComputerCommand(
  command: string,
  options: { session: SessionRecord; sessions: SessionStore; config: AppConfig },
): Promise<string> {
  const sub = command.slice('/computer'.length).trim();
  const armed = options.session.computerUse === true;
  const autoWake = options.config.approval === 'auto' && options.config.computerAnyApp === true;
  if (!sub || sub === 'status') {
    const state = armed ? 'armed (explicitly enabled for this session)' : autoWake ? 'auto-armed (full access + any-app)' : 'off';
    return [
      `Computer use: ${state}.`,
      'Usage: /computer use [goal]  |  /computer off  |  /computer status',
      'When armed the agent can see the screen and drive mouse/keyboard: computer_elements (accessibility tree), computer_press (press by index), computer_screenshot, computer_click, computer_type, computer_key, computer_scroll, computer_list_windows, computer_activate.',
    ].join('\n');
  }
  if (sub === 'off') {
    options.session.computerUse = false;
    await options.sessions.save(options.session);
    return autoWake
      ? 'Computer use disarmed for this session. Note: full access + any-app will still auto-wake it on the next turn.'
      : 'Computer use disarmed for this session.';
  }
  if (sub === 'use' || sub.startsWith('use ')) {
    options.session.computerUse = true;
    await options.sessions.save(options.session);
    const goal = sub.slice(3).trim();
    return goal
      ? `Computer use armed. Working on: ${goal}`
      : 'Computer use armed for this session. Describe the task in your next message.';
  }
  return `Unknown /computer subcommand "${sub}". Usage: /computer use [goal] | /computer off | /computer status`;
}

async function handleInitCommand(
  command: string,
  options: { config: AppConfig },
): Promise<string> {
  const extra = command.slice('/init'.length).trim();
  const agentsPath = join(options.config.workspaceRoot, 'AGENTS.md');
  let existing = '';
  try { existing = await readFile(agentsPath, 'utf8'); } catch { /* new file */ }
  const header = existing || [
    '# AGENTS.md',
    '',
    `Workspace: ${options.config.workspaceRoot}`,
    `Created: ${new Date().toISOString()}`,
    '',
    '## Project Instructions',
    '',
    '<!-- Add project-specific instructions for the AI agent here -->',
    '',
  ].join('\n');
  const append = extra ? `\n## Note (${new Date().toISOString()})\n${extra}\n` : '';
  await writeFile(agentsPath, header + append, 'utf8');
  return existing
    ? `Updated ${agentsPath}${extra ? ' with new note.' : '.'}`
    : `Created ${agentsPath} — edit it to add project instructions.`;
}

async function handleHistoryCommand(
  command: string,
  options: { session: SessionRecord },
): Promise<string> {
  const n = Math.min(50, parseInt(command.slice('/history'.length).trim() || '10', 10) || 10);
  const msgs = options.session.messages.slice(-n);
  if (!msgs.length) return 'No conversation history yet.';
  return msgs.map((m, i) => {
    const role = m.role.padEnd(9);
    const preview = m.content.replace(/\n+/g, ' ').slice(0, 120);
    return `${String(i + 1).padStart(2)}. [${role}] ${preview}`;
  }).join('\n');
}

async function handleDoctorCommand(
  options: { config: AppConfig },
): Promise<string> {
  const root = options.config.workspaceRoot;
  const checks: string[] = [];
  // Node
  try {
    const v = process.version;
    checks.push(`✓ Node.js ${v}`);
  } catch { checks.push('✗ Node.js: unknown'); }
  // Git
  try {
    await new Promise<void>((res, rej) =>
      execFile('git', ['--version'], { cwd: root }, (err) => err ? rej(err) : res()));
    checks.push('✓ git: available');
  } catch { checks.push('✗ git: not found in PATH'); }
  // package.json
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    checks.push(`✓ package.json: ${pkg.name ?? '(unnamed)'} v${pkg.version ?? '?'}`);
  } catch { checks.push('  package.json: not found'); }
  // AGENTS.md
  try {
    await readFile(join(root, 'AGENTS.md'), 'utf8');
    checks.push('✓ AGENTS.md: present');
  } catch { checks.push('  AGENTS.md: not found (run /init to create)'); }
  // .aicode
  try {
    await stat(join(root, '.aicode'));
    checks.push('✓ .aicode/: present');
  } catch { checks.push('  .aicode/: not found'); }
  return ['Workspace health check:', ...checks].join('\n');
}

function handleEnvCommand(options: { config: AppConfig }): string {
  const sensitive = /key|token|secret|password|auth|credential/i;
  const vars = Object.entries(process.env)
    .filter(([k]) => /^(NODE|PATH|HOME|PWD|SHELL|LANG|TERM|AICODE|OPENAI|ANTHROPIC|GITHUB|GIT)/i.test(k))
    .map(([k, v]) => `${k}=${sensitive.test(k) ? '***' : (v ?? '').slice(0, 80)}`);
  return [`Workspace: ${options.config.workspaceRoot}`, '', ...vars].join('\n');
}

function handleModelsCommand(options: { config: AppConfig; provider: Provider }): string {
  const lines = [
    `Active: ${options.provider.name}/${options.provider.model}`,
    `Workspace: ${options.config.workspaceRoot}`,
    '',
    'Configure additional providers in settings (Desktop) or --provider / --model CLI flags.',
  ];
  return lines.join('\n');
}

function handleThinkingCommand(command: string, options: { config: AppConfig }): string {
  const tier = command.slice('/thinking'.length).trim();
  const valid = ['off', 'low', 'medium', 'high', 'max'];
  if (!tier) return `Reasoning effort: set via --reasoning-effort or Desktop settings.\nValid: ${valid.join(' | ')}`;
  if (!valid.includes(tier)) return `Invalid tier "${tier}". Valid: ${valid.join(' | ')}`;
  return `Set reasoning effort to "${tier}" in Desktop settings → Preferences → Reasoning Effort.`;
}

function handleScopeCommand(command: string, options: { config: AppConfig }): string {
  const scope = command.slice('/scope'.length).trim();
  const valid = ['auto', 'compact', 'standard', 'full'];
  if (!scope) return `Tool scope: set via --tool-scope or Desktop settings.\nValid: ${valid.join(' | ')}`;
  if (!valid.includes(scope)) return `Invalid scope "${scope}". Valid: ${valid.join(' | ')}`;
  return `Set tool scope to "${scope}" in Desktop settings → Preferences → Tool Scope.`;
}

// `/review` is NOT handled here: it runs a real review in a separate read-only
// sub-session, which needs the provider, the git process and the session store.
// `handleSlashCommand` receives none of those, so `/review` is intercepted in
// `runPromptMode` (cli/repl.ts, runReviewCommand). This branch only catches the
// callers that reach commands.ts directly (e.g. the REPL's own dispatch) and
// points them at the real implementation instead of returning a prompt string
// the user would have to paste back by hand.
async function handleReviewCommand(command: string): Promise<string> {
  const target = command.slice('/review'.length).trim();
  return target
    ? `审查需要在会话里运行，请把这条命令发给智能体：/review ${target}`
    : '审查需要在会话里运行，请把这条命令发给智能体：/review';
}

async function handleLintCommand(
  command: string,
  options: { config: AppConfig },
): Promise<string> {
  const target = command.slice('/lint'.length).trim() || '.';
  const root = options.config.workspaceRoot;
  // Try eslint, then tsc, then report
  for (const [bin, args] of [
    ['npx', ['eslint', '--max-warnings=0', target]],
    ['npx', ['tsc', '--noEmit']],
  ] as [string, string[]][]) {
    try {
      const output = await new Promise<string>((res, rej) =>
        execFile(bin, args, { cwd: root, timeout: 30_000 }, (err, stdout, stderr) => {
          res(((stdout || '') + (stderr || '')).trim() || (err ? err.message : '(no output)'));
        }));
      return `[${bin} ${args.join(' ')}]\n${output.slice(0, 2000)}`;
    } catch { continue; }
  }
  return 'No lint tool found. Install eslint or typescript to use /lint.';
}

async function handleDiffCommand(options: { config: AppConfig }): Promise<string> {
  return new Promise((res) =>
    execFile('git', ['diff', '--stat'], { cwd: options.config.workspaceRoot, timeout: 10_000 }, (err, stdout, stderr) => {
      const out = (stdout || stderr || '').trim();
      res(err ? `git diff failed: ${err.message}` : (out || 'Working tree is clean.'));
    }));
}

async function handleComplexityCommand(
  command: string,
  options: { config: AppConfig },
): Promise<string> {
  const target = command.slice('/complexity'.length).trim() || '.';
  const root = options.config.workspaceRoot;
  const abs = resolve(root, target);
  // Walk files and compute simple metrics
  const results: string[] = [];
  async function walk(dir: string, depth = 0) {
    if (depth > 3 || results.length > 15) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      const ext = extname(entry.name);
      if (!['.ts','.tsx','.js','.jsx','.py','.go','.rs'].includes(ext)) continue;
      const content = await readFile(full, 'utf8').catch(() => '');
      const lines = content.split('\n').length;
      const funcs = (content.match(/\bfunction\b|\bdef\b|\bfn\b/g) || []).length;
      const rel = relative(root, full);
      results.push(`${rel}: ${lines} lines, ~${funcs} functions`);
    }
  }
  await walk(abs);
  return results.length
    ? ['Complexity overview:', ...results].join('\n')
    : 'No source files found in target.';
}

async function handleDepsCommand(options: { config: AppConfig }): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(options.config.workspaceRoot, 'package.json'), 'utf8'));
    const deps = Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    const depList = deps.slice(0, 30).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    return [`Dependencies (${deps.length} total):`, depList, deps.length > 30 ? `  … and ${deps.length - 30} more` : ''].filter(Boolean).join('\n');
  } catch { return 'No package.json found. Try Cargo.toml, requirements.txt, or go.mod manually.'; }
}

async function handleFindCommand(
  command: string,
  options: { config: AppConfig },
): Promise<string> {
  const pattern = command.slice('/find'.length).trim();
  if (!pattern) return 'Usage: /find <pattern>';
  const lower = pattern.toLowerCase();
  const results: string[] = [];
  async function walk(dir: string, depth = 0) {
    if (depth > 5 || results.length >= 20) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      const rel  = relative(options.config.workspaceRoot, full);
      if (entry.name.toLowerCase().includes(lower) || rel.toLowerCase().includes(lower)) results.push(rel);
      if (entry.isDirectory()) await walk(full, depth + 1);
    }
  }
  await walk(options.config.workspaceRoot);
  return results.length ? results.join('\n') : `No files matching "${pattern}".`;
}

async function handleGrepCommand(
  command: string,
  options: { config: AppConfig },
): Promise<string> {
  const args = command.slice('/grep'.length).trim().split(/\s+/);
  const pattern = args[0];
  if (!pattern) return 'Usage: /grep <pattern> [path]';
  return new Promise((res) =>
    execFile('git', ['grep', '-n', '-l', '--', pattern], {
      cwd: options.config.workspaceRoot, timeout: 15_000,
    }, (err, stdout) => {
      const files = stdout.trim().split('\n').filter(Boolean);
      res(files.length
        ? `Files matching "${pattern}":\n${files.join('\n')}`
        : `No matches for "${pattern}".`);
    }));
}

async function handleRunCommand(
  command: string,
  options: {
    config: AppConfig;
    confirm?: (message: string, request?: ApprovalRequest) => Promise<ApprovalDecision>;
  },
): Promise<string> {
  const cmd = command.slice('/run'.length).trim();
  if (!cmd) return 'Usage: /run <shell command>';
  // `/run` used to call execFile directly, with `shell: true` and no policy
  // check at all: it bypassed the destructive-command blocklist, the auto-mode
  // allowlist, secret scrubbing, and the approval prompt — so a slash command
  // could do what `run_command` refuses. Route it through the same policy and
  // sandbox as the tool so the two paths cannot disagree.
  const locale = detectLocale(cmd);
  const decision = decideApproval({
    mode: options.config.approval,
    risk: 'shell',
    command: cmd,
    workspaceRoot: options.config.workspaceRoot,
    computerAnyApp: options.config.computerAnyApp === true,
    allowedApps: options.config.allowedApps,
  });
  if (!decision.allowed) {
    return formatApprovalOutcome({ locale, kind: 'blocked', tool: 'run_command', reason: decision.reason });
  }
  if (decision.needsPrompt) {
    if (!options.confirm) {
      return formatApprovalOutcome({ locale, kind: 'no_confirm', tool: 'run_command', reason: decision.reason });
    }
    const message = formatApprovalPrompt({ locale, tool: 'run_command', risk: 'shell', command: cmd });
    if (!(await options.confirm(message))) {
      return formatApprovalOutcome({ locale, kind: 'cancelled', tool: 'run_command' });
    }
  }

  try {
    const result = await runSandboxedCommand({
      command: cmd,
      cwd: options.config.workspaceRoot,
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return formatSandboxResult(result, cmd).output.trim().slice(0, 3000) || '(no output)';
  } catch (error) {
    return `Command failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function handleLsCommand(
  command: string,
  options: { config: AppConfig },
): Promise<string> {
  const target = command.slice('/ls'.length).trim() || '.';
  const abs = resolve(options.config.workspaceRoot, target);
  const entries = await readdir(abs, { withFileTypes: true }).catch((e) => { throw new Error(String(e.message)); });
  return entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.aicode')
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
    .join('\n') || '(empty directory)';
}

async function handleReadCommand(
  command: string,
  options: { config: AppConfig },
): Promise<string> {
  const target = command.slice('/read'.length).trim();
  if (!target) return 'Usage: /read <file>';
  const abs = resolve(options.config.workspaceRoot, target);
  const rel = relative(options.config.workspaceRoot, abs);
  if (rel.startsWith('..')) return 'Path escapes workspace.';
  const content = await readFile(abs, 'utf8').catch((e) => { throw new Error(String(e.message)); });
  const lines = content.split('\n');
  const preview = lines.slice(0, 100).join('\n');
  const suffix = lines.length > 100 ? `\n… (${lines.length - 100} more lines)` : '';
  return `--- ${rel} ---\n${preview}${suffix}`;
}

async function handleRenameCommand(
  command: string,
  options: { session: SessionRecord; sessions: SessionStore },
): Promise<string> {
  const title = command.slice('/rename'.length).trim();
  if (!title) return 'Usage: /rename <new title>';
  // Store title as first finalAnswer acting as title (desktop overlay reads this)
  if (!options.session.finalAnswers.length) options.session.finalAnswers.push(title);
  else options.session.finalAnswers[0] = title;
  await options.sessions.save(options.session);
  return `Session renamed to: ${title}`;
}

async function handlePinCommand(
  options: { session: SessionRecord; sessions: SessionStore },
): Promise<string> {
  // Use a guard field to store pin state since SessionRecord has no pinned field
  const guard = options.session.guard ?? {};
  const pinned = !((guard as Record<string, unknown>).pinned as boolean);
  (guard as Record<string, unknown>).pinned = pinned;
  options.session.guard = guard;
  await options.sessions.save(options.session);
  return pinned ? 'Session pinned.' : 'Session unpinned.';
}

async function handleLoadCommand(
  command: string,
  options: { sessions: SessionStore },
): Promise<string> {
  const id = command.slice('/load'.length).trim();
  if (!id) return 'Usage: /load <session-id>\nUse /sessions to list available sessions.';
  const list = await options.sessions.list();
  const match = list.find((s) => s.id === id || s.id.endsWith(id));
  if (!match) return `Session not found: ${id}`;
  return `To load session "${match.id}", use --resume ${match.id} at startup, or select it from the sessions panel in the Desktop.`;
}
