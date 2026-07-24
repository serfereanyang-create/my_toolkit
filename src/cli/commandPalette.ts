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
    { id: '/sessions', keyword: '/sessions', detail: 'List recent sessions', tags: ['sessions'] },
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
