import { execFileSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { emitKeypressEvents } from 'node:readline';

export type OverlayItem = {
  id: string;
  /** Leading keyword shown in white (e.g. Revert / Copy / Fork). */
  keyword: string;
  /** Rest of the label in dim gray. */
  detail: string;
  /** Optional search haystack extras. */
  tags?: string[];
};

export type OverlayChoice = {
  id: string;
  keyword: string;
  detail: string;
};

export type OverlayResult =
  | { status: 'selected'; item: OverlayChoice }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: string };

type OverlayOptions = {
  title?: string;
  items: OverlayItem[];
  noColor?: boolean;
  /** Initial filter text. */
  query?: string;
};

const c = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  italic: '\u001b[3m',
  white: '\u001b[37m',
  gray: '\u001b[90m',
  black: '\u001b[30m',
  // style.rs accent_style: cyan on dark/unknown terminals.
  cyan: '\u001b[36m',
};

/**
 * OpenCode-like floating action menu:
 * - title + esc
 * - Search box
 * - full-width highlight bar on selected row
 * - ↑/↓ or j/k, type to filter, Enter select, Esc cancel
 *
 * Falls back to numbered list when stdin is not a TTY / raw mode unavailable.
 */
export async function showOverlayMenu(options: OverlayOptions): Promise<OverlayResult> {
  const items = options.items;
  if (items.length === 0) {
    return { status: 'unavailable', reason: 'No actions available.' };
  }

  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return showNumberedFallback(options);
  }

  return showInteractiveOverlay(options);
}

async function showInteractiveOverlay(options: OverlayOptions): Promise<OverlayResult> {
  const color = !options.noColor;
  let query = options.query ?? '';
  let index = 0;
  let closed = false;

  const wasRaw = Boolean((input as NodeJS.ReadStream & { isRaw?: boolean }).isRaw);
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  const paint = () => {
    const filtered = filterItems(options.items, query);
    if (index >= filtered.length) index = Math.max(0, filtered.length - 1);
    const frame = renderOverlayFrame({
      title: options.title ?? 'Message Actions',
      query,
      items: filtered,
      selected: index,
      color,
    });
    // Clear screen region and draw floating panel near top-left (OpenCode style).
    output.write('\u001b[?25l'); // hide cursor
    output.write('\u001b[2J\u001b[H');
    output.write(frame);
  };

  paint();

  return new Promise((resolve) => {
    const finish = (result: OverlayResult) => {
      if (closed) return;
      closed = true;
      input.off('keypress', onKey);
      try {
        input.setRawMode(wasRaw ?? false);
      } catch {
        // ignore
      }
      output.write('\u001b[?25h'); // show cursor
      output.write('\u001b[2J\u001b[H');
      resolve(result);
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string; ch?: string }) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        finish({ status: 'cancelled' });
        return;
      }
      if (key.name === 'escape' || key.name === 'esc') {
        finish({ status: 'cancelled' });
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const filtered = filterItems(options.items, query);
        const item = filtered[index];
        if (!item) {
          finish({ status: 'cancelled' });
          return;
        }
        finish({ status: 'selected', item: { id: item.id, keyword: item.keyword, detail: item.detail } });
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        index = Math.max(0, index - 1);
        paint();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        const filtered = filterItems(options.items, query);
        index = Math.min(filtered.length - 1, index + 1);
        paint();
        return;
      }
      if (key.name === 'backspace') {
        query = query.slice(0, -1);
        index = 0;
        paint();
        return;
      }
      // Printable character → search filter (OpenCode search box).
      const ch = key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta ? key.sequence : '';
      if (ch && ch >= ' ' && ch !== '\u007f') {
        query += ch;
        index = 0;
        paint();
      }
    };

    input.on('keypress', onKey);
  });
}

function showNumberedFallback(options: OverlayOptions): OverlayResult {
  // Non-interactive environments cannot show a real overlay.
  const lines = [
    options.title ?? 'Message Actions',
    ...options.items.map((item, i) => `${i + 1}. ${item.keyword} ${item.detail}`),
    'Use interactive TTY for floating menu (↑/↓ Enter Esc).',
  ];
  output.write(`${lines.join('\n')}\n`);
  return { status: 'unavailable', reason: 'Interactive overlay requires a TTY.' };
}

export function renderOverlayFrame(options: {
  title: string;
  query: string;
  items: OverlayItem[];
  selected: number;
  color: boolean;
}): string {
  const cols = Math.max(output.columns || 72, 48);
  const width = Math.min(64, cols - 4);
  const paint = (code: string, text: string) => (options.color ? `${code}${text}${c.reset}` : text);

  const lines: string[] = [];
  // Floating card top padding
  lines.push('');
  lines.push(`  ${paint(c.white + c.bold, options.title)}${' '.repeat(Math.max(1, width - options.title.length - 6))}${paint(c.gray, 'esc')}`);
  lines.push('');
  // Composer-style prompt row: bold `›` caret, dim italic placeholder (upstream
  // popups filter inline from the composer rather than owning a search box).
  const searchLabel = options.query.length > 0 ? options.query : 'Search';
  const caret = paint(c.bold, '›');
  const labelText = options.query.length > 0 ? paint(c.white, ` ${searchLabel}`) : paint(c.dim + c.italic, ` ${searchLabel}`);
  lines.push(`  ${caret}${labelText}`);
  lines.push('');

  if (options.items.length === 0) {
    // Upstream selection_popup_common: dim + italic "no matches".
    lines.push(`  ${paint(c.dim + c.italic, '(no matches)')}`);
  } else {
    for (const [i, item] of options.items.entries()) {
      const selected = i === options.selected;
      const row = formatActionRow(item, width - 2);
      if (selected) {
        // style.rs accent_style: cyan + bold on dark/unknown terminals.
        if (options.color) {
          lines.push(`  ${c.cyan}${c.bold}${row}${c.reset}`);
        } else {
          lines.push(`  > ${row}`);
        }
      } else {
        lines.push(`  ${formatActionRowColored(item, options.color, width - 2)}`);
      }
    }
  }

  lines.push('');
  lines.push(`  ${paint(c.dim, '↑/↓ move   enter select   type to filter   esc close')}`);
  lines.push('');
  return lines.join('\n');
}

function formatActionRow(item: OverlayItem, maxWidth: number) {
  const text = `${item.keyword} ${item.detail}`.trim();
  return text.length > maxWidth ? `${text.slice(0, Math.max(0, maxWidth - 1))}…` : text;
}

function formatActionRowColored(item: OverlayItem, color: boolean, maxWidth: number) {
  if (!color) return formatActionRow(item, maxWidth);
  const keyword = `${c.white}${item.keyword}${c.reset}`;
  const detail = `${c.dim}${item.detail}${c.reset}`;
  const plain = `${item.keyword} ${item.detail}`.trim();
  if (plain.length > maxWidth) {
    return `${keyword} ${c.dim}${item.detail.slice(0, Math.max(0, maxWidth - item.keyword.length - 2))}…${c.reset}`;
  }
  return `${keyword} ${detail}`;
}

function padRow(text: string, width: number) {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  if (plain.length >= width) return plain.slice(0, width);
  return `${plain}${' '.repeat(width - plain.length)}`;
}

function filterItems(items: OverlayItem[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    const hay = `${item.keyword} ${item.detail} ${(item.tags ?? []).join(' ')}`.toLowerCase();
    return hay.includes(q);
  });
}

export function copyTextToClipboard(text: string): { ok: boolean; detail: string } {
  if (!text) return { ok: false, detail: 'Nothing to copy.' };
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard -Value $input'], {
        input: text,
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { ok: true, detail: `Copied ${Buffer.byteLength(text, 'utf8')} bytes to clipboard.` };
    }
    // Best-effort macOS / Linux.
    try {
      execFileSync('pbcopy', [], { input: text, timeout: 5000 });
      return { ok: true, detail: `Copied ${Buffer.byteLength(text, 'utf8')} bytes to clipboard.` };
    } catch {
      execFileSync('xclip', ['-selection', 'clipboard'], { input: text, timeout: 5000 });
      return { ok: true, detail: `Copied ${Buffer.byteLength(text, 'utf8')} bytes to clipboard.` };
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Default Message Actions matching the OpenCode screenshot. */
export function defaultMessageActions(): OverlayItem[] {
  return [
    {
      id: 'revert',
      keyword: 'Revert',
      detail: 'undo messages and file changes',
      tags: ['undo', 'rollback', 'checkpoint'],
    },
    {
      id: 'copy',
      keyword: 'Copy',
      detail: 'message text to clipboard',
      tags: ['clipboard'],
    },
    {
      id: 'fork',
      keyword: 'Fork',
      detail: 'create a new session',
      tags: ['session', 'branch'],
    },
  ];
}
