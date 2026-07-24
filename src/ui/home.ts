import type { AppConfig } from '../config/types.js';
import type { Provider } from '../providers/types.js';

const c = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  blue: '\u001b[34m',
  white: '\u001b[37m',
  gray: '\u001b[90m',
};

/** Wide wordmark (OpenCode-like). */
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
  const cols = Math.max(process.stdout.columns || 100, 60);
  const rows = Math.max(process.stdout.rows || 28, 20);
  const logo = displayWidth(LOGO_WIDE[0] ?? '') + 4 <= cols ? LOGO_WIDE : LOGO_COMPACT;
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
    const boxWidth = Math.min(72, Math.max(48, cols - 8));
    const agent = 'Build';
    const modelLabel = shortenModel(provider.model);
    const providerLabel = provider.name === 'openai' ? shortHost(config.baseUrl) : provider.name;
    const statusPlain = `${agent} · ${modelLabel}${providerLabel ? `  ${providerLabel}` : ''}`;
    const statusLine = `${color('blue')}${color('bold')}${agent}${color('reset')} ${color('dim')}·${color('reset')} ${color('white')}${modelLabel}${color('reset')}${providerLabel ? ` ${color('dim')}${providerLabel}${color('reset')}` : ''}`;
    const innerAsk = 'Ask anything...  "Fix broken tests"';
    const askPad = Math.max(0, boxWidth - 4 - displayWidth(innerAsk));
    const statusPad = Math.max(0, boxWidth - 4 - displayWidth(statusPlain));
    const accentTop = `${color('blue')}┌${color('gray')}${'─'.repeat(boxWidth - 2)}┐${color('reset')}`;
    const askRow = `${color('blue')}│${color('reset')} ${color('gray')}${innerAsk}${' '.repeat(askPad)}${color('reset')}`;
    const statusRow = `${color('blue')}│${color('reset')} ${statusLine}${' '.repeat(statusPad)}`;
    const accentBot = `${color('blue')}└${color('gray')}${'─'.repeat(boxWidth - 2)}┘${color('reset')}`;
    lines.push('');
    lines.push(pad(accentTop));
    lines.push(pad(askRow));
    lines.push(pad(statusRow));
    lines.push(pad(accentBot));
  }

  lines.push('');
  lines.push(pad(`${color('dim')}/help commands   enter submit${color('reset')}`));
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
  const color = (name: keyof typeof c) => (options.noColor ? '' : c[name]);
  return `${color('blue')}│${color('reset')} `;
}

function shortenModel(model: string) {
  if (!model) return 'model';
  const bare = model.includes('/') ? model.split('/').pop()! : model;
  return bare.length > 18 ? `${bare.slice(0, 16)}…` : bare;
}

function shortHost(baseUrl: string | undefined) {
  if (!baseUrl) return '';
  try {
    const host = new URL(baseUrl).host;
    return host.length > 22 ? `${host.slice(0, 20)}…` : host;
  } catch {
    return '';
  }
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function displayWidth(value: string) {
  let width = 0;
  for (const char of value) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
  }
  return width;
}
