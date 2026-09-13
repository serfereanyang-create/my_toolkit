/**
 * Iteration 14 — transcript export to Markdown.
 *
 * Turns the live ChatItem[] into a structured Markdown document: user turns
 * as `## 用户`, assistant replies as `## 助手`, agent working rounds as
 * collapsed-able detail sections with their tool steps and file changes, and
 * errors as blockquotes. Approvals and tool-only rows fold into the round
 * they belong to so the export reads like a report, not a DOM dump.
 *
 * Pure function (plus a session-title argument) so both the command palette
 * clipboard export and the file-save menu entry share one implementation.
 */

import type { ChatItem, ToolChatItem, TurnFileChange } from '../types';

export type ExportOptions = {
  title?: string;
  workspaceRoot?: string;
  /** Include tool step detail rows inside each working round. */
  includeSteps?: boolean;
  /** Truncate tool outputs longer than this many characters (0 disables). */
  maxOutputChars?: number;
};

function formatClock(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusIcon(item: ToolChatItem): string {
  return item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : '…';
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function fileChangeLine(change: TurnFileChange): string {
  const marker = change.added > 0 || change.removed === 0 ? (change.removed > 0 && change.added === 0 ? '-' : change.added === 0 ? '~' : '+') : '-';
  return `- \`${marker}\` ${change.path}（+${change.added} / -${change.removed}）`;
}

/** Export a whole chat transcript as one Markdown string. */
export function transcriptToMarkdown(chat: ChatItem[], options: ExportOptions = {}): string {
  const includeSteps = options.includeSteps !== false;
  const maxOut = options.maxOutputChars ?? 400;
  const lines: string[] = [];
  const title = options.title?.trim() || 'YOYcode 会话记录';
  lines.push(`# ${title}`, '');
  if (options.workspaceRoot) {
    lines.push(`> 工作区：\`${options.workspaceRoot}\` · 导出于 ${formatClock(Date.now())}`, '');
  }

  let turnNo = 0;
  for (const item of chat) {
    switch (item.kind) {
      case 'user':
        lines.push('## 用户', '');
        if (item.ts) lines.push(`*${formatClock(item.ts)}*`, '');
        lines.push(item.text.trim(), '');
        break;
      case 'assistant':
        lines.push('## 助手', '');
        lines.push(item.text.trim(), '');
        break;
      case 'error':
        lines.push(`> ⚠️ **错误**：${item.text.trim()}`, '');
        break;
      case 'approval': {
        const decision = item.decided === 'allow_once' ? '已允许（本次）'
          : item.decided === 'allow_session' ? '已允许（本会话）'
          : item.decided === 'deny' ? '已拒绝'
          : '待决定';
        lines.push(`**审批** · \`${item.tool}\` · ${decision}`, '');
        break;
      }
      case 'tool':
        // A stray tool row outside a turn (session reload of old data):
        // render a compact single line so nothing is silently lost.
        lines.push(`- 工具 \`${item.tool}\` ${statusIcon(item)}`, '');
        break;
      case 'turn': {
        turnNo += 1;
        const seconds = item.endedAt ? Math.round((item.endedAt - item.startedAt) / 1000) : null;
        const headerBits = [
          `回合 ${turnNo}`,
          `${item.steps.length} 步`,
          `+${item.added} / -${item.removed}`,
          seconds !== null ? `${seconds}s` : null,
        ].filter(Boolean).join(' · ');
        lines.push(`### 🛠 工作回合 — ${headerBits}`, '');
        if (item.files.length) {
          lines.push('文件变更：', '');
          for (const change of item.files) lines.push(fileChangeLine(change));
          lines.push('');
        }
        if (includeSteps && item.steps.length) {
          lines.push('<details>', '<summary>工具步骤</summary>', '');
          for (const step of item.steps) {
            lines.push(`- ${statusIcon(step)} \`${step.tool}\`${step.durationMs ? `（${(step.durationMs / 1000).toFixed(1)}s）` : ''}`);
            if (step.output) {
              // maxOutputChars 0 disables truncation (full indented output).
              const out = maxOut > 0 ? oneLine(step.output, maxOut) : step.output;
              lines.push('  ```', ...out.split('\n').map((l) => `  ${l}`), '  ```');
            }
          }
          lines.push('', '</details>', '');
        }
        break;
      }
    }
  }
  // Collapse 3+ consecutive blanks to one.
  const compact: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === '') {
      blanks += 1;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    compact.push(line);
  }
  return `${compact.join('\n').trim()}\n`;
}

/** Filename suggestion for a downloaded export (safe for Windows). */
export function transcriptFileName(title: string | undefined, now = new Date()): string {
  const base = (title || 'yoycode-chat')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'yoycode-chat';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${base}-${stamp}.md`;
}

/** Count what an export contains — drives the confirmation toast text. */
export function summarizeTranscript(chat: ChatItem[]): { user: number; assistant: number; turns: number; tools: number } {
  const out = { user: 0, assistant: 0, turns: 0, tools: 0 };
  for (const item of chat) {
    if (item.kind === 'user') out.user += 1;
    else if (item.kind === 'assistant') out.assistant += 1;
    else if (item.kind === 'turn') { out.turns += 1; out.tools += item.steps.length; }
    else if (item.kind === 'tool') out.tools += 1;
  }
  return out;
}
