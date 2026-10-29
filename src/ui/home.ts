import type { AppConfig } from '../config/types.js';
import type { Provider } from '../providers/types.js';
import { displayTokens, displayWidth, stripAnsi, truncateToWidth } from './width.js';

const c = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  blue: '\u001b[34m',
  white: '\u001b[37m',
  gray: '\u001b[90m',
};

/**
 * Wide and compact wordmarks. The compact one is 46 columns, still wider than
 * the minimum layout width (60 - 4 = 56 fits; a 40-column window does not), so
 * a fourth stop exists: no wordmark at all rather than horizontally scrolling
 * log lines. Framed card rows have fixed widths; their inner text is clipped.
 */
const LOGO_WIDE = [
  '               █████╗ ██╗ ██████╗ ██████╗ ██████╗ ███████╗',
  '              ██╔══██╗██║██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '              ███████║██║██║     ██║   ██║██║  ██║█████╗  ',
  '              ██╔══██║██║██║     ██║   ██║██║  ██║██╔══╝  ',
  '              ██║  ██║██║╚██████╗╚██████╔╝██████╔╝███████╗',
  '              ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

/** Compact wordmark for narrow terminals. */
const LOGO_COMPACT = [
  '  █████╗ ██╗ ██████╗ ██████╗ ██████╗ ███████╗',
  ' ██╔══██╗██║██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  ' ███████║██║██║     ██║   ██║██║  ██║█████╗  ',
  ' ██╔══██║██║██║     ██║   ██║██║  ██║██╔══╝  ',
  ' ██║  ██║██║╚██████╗╚██████╔╝██████╔╝███████╗',
  ' ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

export type HomeScreenOptions = {
  noColor?: boolean;
  version?: string;
  /**
   * When true (default for interactive Ask-card REPL), only paint the logo.
   * The single Ask input card is owned by readAskCardTurn — avoids stacked cards.
   */
  logoOnly?: boolean;
};

/**
 * OpenCode-like dark home.
 * Interactive mode uses logoOnly so there is exactly one Ask card (from askCard).
 */
export function renderHomeScreen(
  config: AppConfig,
  provider: Provider,
  options: HomeScreenOptions = {},
): string {
  const color = (name: keyof typeof c) => (options.noColor ? '' : c[name]);
  // Do not clamp the terminal width up to 60: in a 20- or 40-column window that
  // produced a 52-column logo and a 56-column card, i.e. guaranteed wrapping.
  // (Tests pin columns explicitly; `|| 100` only covers non-TTY output.)
  const cols = Math.max(process.stdout.columns || 100, 1);
  const rows = Math.max(process.stdout.rows || 28, 1);
  const wideWidth = displayWidth(LOGO_WIDE[0] ?? '');
  const compactWidth = displayWidth(LOGO_COMPACT[0] ?? '');
  const logo = wideWidth + 4 <= cols ? LOGO_WIDE
    : compactWidth + 2 <= cols ? LOGO_COMPACT
    : [];
  const logoOnly = options.logoOnly !== false;

  const pad = (line: string) => {
    const plain = stripAnsi(line);
    const left = Math.max(0, Math.floor((cols - displayWidth(plain)) / 2));
    return `${' '.repeat(left)}${line}`;
  };

  const lines: string[] = [];
  // Keep logo in the upper third; leave room below for the single Ask card.
  const topPad = Math.max(1, Math.floor(rows / 6));
  for (let i = 0; i < topPad; i += 1) lines.push('');

  for (const logoLine of logo) {
    lines.push(pad(`${color('white')}${color('bold')}${logoLine}${color('reset')}`));
  }

  if (!logoOnly) {
    // Legacy full home (non-interactive previews / tests that want the static card).
    // The framed rows are fixed-width chrome: shrink the card to the window and
    // clip the inner text, so a 20-column terminal gets a (tight) card instead
    // of rows spilling 30+ columns past the edge.
    const boxWidth = Math.min(72, Math.max(Math.min(48, cols), cols - 8));
    const agent = 'Build';
    const modelLabel = shortenModel(provider.model);
    const providerLabel = provider.name === 'openai' ? shortHost(config.baseUrl) : provider.name;
    const statusLine = `${color('blue')}${color('bold')}${agent}${color('reset')} ${color('dim')}·${color('reset')} ${color('white')}${modelLabel}${color('reset')}${providerLabel ? ` ${color('dim')}${providerLabel}${color('reset')}` : ''}`;
    const innerAsk = 'Ask anything...  "Fix broken tests"';
    // Chrome is `│ ` + text + ` │`: the row used to end in a single `│` with no
    // space before it, so every inner row was two columns narrower than the
    // top/bottom rules and the right edge never lined up with `┐`/`┘`.
    const innerWidth = Math.max(1, boxWidth - 4);
    // `innerAsk` is plain ASCII, so everything inside the 4-column chrome now
    // fits exactly. Clipping it as well keeps the `│` on the last row from
    // sitting 2 columns outside the frame when the box narrows below it.
    const askText = truncateToWidth(takeLeft(innerAsk, innerWidth), innerWidth);
    const askPad = Math.max(0, innerWidth - displayWidth(askText));
    const statusText = takeLeft(statusLine, innerWidth);
    const statusPad = Math.max(0, innerWidth - displayWidth(stripAnsi(statusText)));
    const accentTop = `${color('blue')}┌${color('gray')}${'─'.repeat(Math.max(0, boxWidth - 2))}┐${color('reset')}`;
    const askRow = `${color('blue')}│${color('reset')} ${color('gray')}${askText}${' '.repeat(askPad)} ${color('gray')}│${color('reset')}`;
    const statusRow = `${color('blue')}│${color('reset')} ${statusText}${' '.repeat(statusPad)} ${color('gray')}│${color('reset')}`;
    const accentBot = `${color('blue')}└${color('gray')}${'─'.repeat(Math.max(0, boxWidth - 2))}┘${color('reset')}`;
    lines.push('');
    lines.push(pad(accentTop));
    lines.push(pad(askRow));
    lines.push(pad(statusRow));
    lines.push(pad(accentBot));
  }

  lines.push('');
  lines.push(pad(`${color('dim')}${takeLeft('/help commands   enter submit', cols)}${color('reset')}`));
  if (options.version) {
    lines.push('');
    lines.push(`${' '.repeat(Math.max(0, cols - displayWidth(options.version) - 2))}${color('dim')}${options.version}${color('reset')}`);
  }
  // Keep provider referenced for future status chips without unused lint when logoOnly.
  void provider;
  void config;
  return lines.join('\n');
}

export function clearScreen() {
  // Visible area only — do NOT use \u001b[3J (wipes scrollback so users cannot 往前翻).
  process.stdout.write('\u001b[2J\u001b[H');
}

export function chatPromptLabel(options: { noColor?: boolean } = {}) {
  // chat_composer.rs prompt glyph: bold `›` at column 0 (was OpenCode's `│`).
  const color = (name: keyof typeof c) => (options.noColor ? '' : c[name]);
  return `${color('bold')}›${color('reset')} `;
}

function shortenModel(model: string) {
  if (!model) return 'model';
  const bare = model.includes('/') ? model.split('/').pop()! : model;
  return displayWidth(bare) > 18 ? `${takeLeftPlain(bare, 16)}…` : bare;
}

/**
 * Keep the leftmost `max` columns of a styled row, preserving the escape
 * sequences that were opened (a trailing reset is appended when one was cut),
 * so a clipped row never leaks its colour into the next line.
 */
function takeLeft(row: string, max: number): string {
  if (displayWidth(stripAnsi(row)) <= max) return row;
  let out = '';
  let width = 0;
  for (const token of displayTokens(row)) {
    if (!token.ansi) {
      if (width + token.width > max) break;
      width += token.width;
    }
    out += token.text;
  }
  return `${out}\u001b[0m`;
}

function takeLeftPlain(value: string, max: number): string {
  let out = '';
  let width = 0;
  for (const char of value) {
    const charWidth = displayWidth(char);
    if (width + charWidth > max) break;
    out += char;
    width += charWidth;
  }
  return out;
}

function shortHost(baseUrl: string | undefined) {
  if (!baseUrl) return '';
  try {
    const host = new URL(baseUrl).host;
    return displayWidth(host) > 22 ? `${takeLeftPlain(host, 20)}…` : host;
  } catch {
    return '';
  }
}

