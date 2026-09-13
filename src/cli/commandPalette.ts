import type { AgentRuntime } from '../agent/agent.js';
import { handleSlashCommand } from './commands.js';
import { runMessageActions } from './messageActions.js';
import type { OverlayItem } from '../ui/overlay.js';
import { showOverlayMenu } from '../ui/overlay.js';

/**
 * All interactive slash commands as OpenCode-style overlay rows.
 * keyword = command, detail = short description.
 */
export function commandPaletteItems(): OverlayItem[] {
  return [
    // ── Dialogue management ──────────────────────────────────────────────────
    { id: '/compact', keyword: '/compact [N]', detail: 'Compact context, keep last N messages + summary stub', tags: ['compact', 'context', 'memory'] },
    { id: '/clear', keyword: '/clear', detail: 'Clear session history, start fresh context', tags: ['clear', 'reset', 'history'] },
    { id: '/retry', keyword: '/retry', detail: 'Re-send the last user message', tags: ['retry', 'resend'] },
    { id: '/history', keyword: '/history [N]', detail: 'Show last N conversation messages (default 10)', tags: ['history', 'messages'] },
    { id: '/tokens', keyword: '/tokens', detail: 'Show context size in chars and estimated tokens', tags: ['tokens', 'context', 'usage'] },

    // ── Project setup ────────────────────────────────────────────────────────
    { id: '/init', keyword: '/init [desc]', detail: 'Create or update workspace AGENTS.md instructions', tags: ['init', 'agents', 'setup'] },
    { id: '/goal', keyword: '/goal [text]', detail: 'Set or show current session goal (/goal clear to reset)', tags: ['goal', 'objective'] },
    { id: '/computer', keyword: '/computer use [goal]', detail: 'Arm desktop computer control (screenshot/mouse/keyboard) for this session', tags: ['computer', 'screenshot', 'mouse', 'keyboard', 'gui'] },
    { id: '/doctor', keyword: '/doctor', detail: 'Check workspace environment health (node/git/package.json)', tags: ['doctor', 'health', 'check'] },
    { id: '/env', keyword: '/env', detail: 'Show workspace environment variables (redacted)', tags: ['env', 'environment', 'vars'] },

    // ── Code analysis ────────────────────────────────────────────────────────
    { id: '/review', keyword: '/review [file]', detail: 'Code review prompt for file or current workspace', tags: ['review', 'code', 'quality'] },
    { id: '/security', keyword: '/security', detail: 'Run a security review via agent or Mimosa plugin', tags: ['security', 'audit', 'scan'] },
    { id: '/lint', keyword: '/lint [file]', detail: 'Run eslint / tsc and display results', tags: ['lint', 'eslint', 'typecheck'] },
    { id: '/diff', keyword: '/diff', detail: 'Show git diff --stat for working tree', tags: ['diff', 'git', 'changes'] },
    { id: '/complexity', keyword: '/complexity [path]', detail: 'Analyse file complexity and line/function counts', tags: ['complexity', 'metrics', 'analysis'] },
    { id: '/deps', keyword: '/deps', detail: 'Show project dependency summary from package.json', tags: ['deps', 'dependencies', 'packages'] },

    // ── Model control ────────────────────────────────────────────────────────
    { id: '/models', keyword: '/models', detail: 'Show active provider and model', tags: ['models', 'provider', 'model'] },
    { id: '/thinking', keyword: '/thinking [level]', detail: 'Set reasoning effort: off|low|medium|high|max', tags: ['thinking', 'reasoning', 'effort'] },
    { id: '/scope', keyword: '/scope [level]', detail: 'Set tool scope: auto|compact|standard|full', tags: ['scope', 'tools', 'permissions'] },

    // ── Search ───────────────────────────────────────────────────────────────
    { id: '/find', keyword: '/find <pattern>', detail: 'Find files by name pattern in workspace', tags: ['find', 'search', 'files'] },
    { id: '/grep', keyword: '/grep <pattern>', detail: 'Grep source files for a pattern (git grep)', tags: ['grep', 'search', 'text'] },

    // ── Quick tools ──────────────────────────────────────────────────────────
    { id: '/run', keyword: '/run <cmd>', detail: 'Run a shell command in the workspace', tags: ['run', 'shell', 'exec', 'terminal'] },
    { id: '/ls', keyword: '/ls [path]', detail: 'List workspace directory contents', tags: ['ls', 'list', 'directory', 'files'] },
    { id: '/read', keyword: '/read <file>', detail: 'Read and display a file (first 100 lines)', tags: ['read', 'file', 'view', 'cat'] },

    // ── Session management ───────────────────────────────────────────────────
    { id: '/rename', keyword: '/rename <title>', detail: 'Rename the current session', tags: ['rename', 'session', 'title'] },
    { id: '/pin', keyword: '/pin', detail: 'Toggle pin on current session', tags: ['pin', 'session', 'bookmark'] },
    { id: '/share', keyword: '/share', detail: 'Show session export path (JSON transcript)', tags: ['share', 'export', 'session'] },
    { id: '/load', keyword: '/load <id>', detail: 'Load a session by ID', tags: ['load', 'session', 'resume'] },
    { id: '/sessions', keyword: '/sessions', detail: 'List recent sessions', tags: ['sessions'] },
    { id: '/subagents', keyword: '/subagents', detail: '列出当前会话的子智能体执行记录', tags: ['subagent', 'agent', 'spawn'] },

    // ── Existing commands ────────────────────────────────────────────────────
    { id: '/status', keyword: '/status', detail: 'Show session and workspace status', tags: ['status', 'session'] },
    { id: '/provider', keyword: '/provider', detail: 'Show active provider', tags: ['provider'] },
    { id: '/model', keyword: '/model', detail: 'Show active model', tags: ['model'] },
    { id: '/config', keyword: '/config', detail: 'Show effective redacted configuration', tags: ['config'] },
    { id: '/tools', keyword: '/tools', detail: 'List available tools', tags: ['tools'] },
    { id: '/cache', keyword: '/cache', detail: 'Cache probe: average hit rate', tags: ['cache', 'probe', 'hit'] },
    { id: '/mcp', keyword: '/mcp', detail: 'Show MCP servers (reload: /mcp reload)', tags: ['mcp'] },
    { id: '/attach', keyword: '/attach', detail: 'Stage files/images for next message', tags: ['attach', 'file', 'image'] },
    { id: '/paste-image', keyword: '/paste-image', detail: 'Capture screenshot from clipboard', tags: ['clipboard', 'image', 'paste'] },
    { id: '/attachments', keyword: '/attachments', detail: 'List staged attachments', tags: ['attachments'] },
    { id: '/paste', keyword: '/paste', detail: 'Multiline paste mode (end with . or /end)', tags: ['paste', 'multiline'] },
    { id: '/summary', keyword: '/summary', detail: 'Summarize the current session', tags: ['summary'] },
    { id: '/plan', keyword: '/plan', detail: 'Show task board (confirm|pause|continue|…)', tags: ['plan', 'board', 'tasks'] },
    { id: '/memory', keyword: '/memory', detail: 'Project memory (add|list|forget)', tags: ['memory'] },
    { id: '/rollback', keyword: '/rollback', detail: 'Git safety unit rollbacks', tags: ['rollback', 'git'] },
    { id: '/git', keyword: '/git', detail: 'Board-linked Git status|commit|publish', tags: ['git'] },
    { id: '/export', keyword: '/export', detail: 'Show transcript file path', tags: ['export'] },
    { id: '/actions', keyword: '/actions', detail: 'Message actions (Revert / Copy / Fork)', tags: ['actions', 'menu', 'overlay'] },
    { id: '/undo', keyword: '/undo', detail: 'Undo the last checkpointed file change', tags: ['undo', 'checkpoint'] },
    { id: '/不准偷懒开发', keyword: '/不准偷懒开发', detail: '开启学习守门模式', tags: ['guard', 'lazy'] },
    { id: '/不准偷懒开发 状态', keyword: '/不准偷懒开发 状态', detail: '查看守门状态', tags: ['guard', 'status'] },
    { id: '/exit', keyword: '/exit', detail: 'Exit interactive mode', tags: ['exit', 'quit'] },
  ];
}

/** Plain-text help for --prompt / non-TTY. */
export function formatHelpText(): string {
  return [
    'Commands:',
    ...commandPaletteItems().map((item) => `${item.keyword.padEnd(14)} ${item.detail}`),
    '',
    'In interactive TTY: /help opens a floating menu (↑/↓ Enter Esc).',
    'Multiline: """ … """ or /paste · Text limit ~25KB',
  ].join('\n');
}

export type CommandPaletteResult =
  | { status: 'continue'; message?: string }
  | { status: 'exit' };

/**
 * OpenCode-like command palette for /help.
 * Select with ↑/↓, filter by typing, Enter runs the command.
 */
export async function runCommandPalette(runtime: AgentRuntime): Promise<CommandPaletteResult> {
  const result = await showOverlayMenu({
    title: 'Commands',
    items: commandPaletteItems(),
    noColor: runtime.config.noColor,
  });

  if (result.status === 'cancelled') {
    return { status: 'continue', message: 'Help closed.' };
  }
  if (result.status === 'unavailable') {
    return { status: 'continue', message: formatHelpText() };
  }

  const command = result.item.id;

  // Nested overlays / special handlers.
  if (command === '/actions') {
    const status = await runMessageActions({
      config: runtime.config,
      provider: runtime.provider,
      sessions: runtime.sessions,
      session: runtime.session,
      checkpoints: runtime.checkpoints,
      onSessionForked: (session) => {
        runtime.session = session;
      },
    });
    return { status: 'continue', message: status };
  }

  if (command === '/paste') {
    return {
      status: 'continue',
      message: 'Paste mode: type /paste at the prompt, then paste text and end with a line containing only . or /end.',
    };
  }

  if (command === '/attach') {
    return {
      status: 'continue',
      message: 'Usage: /attach <path> [path2 …]  (quote paths with spaces; drag path into terminal then /attach).',
    };
  }

  const output = await handleSlashCommand({ line: command, ...runtime });
  if (output === '__EXIT__') return { status: 'exit' };
  return { status: 'continue', message: output };
}
