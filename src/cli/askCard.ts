import { stdin as input, stdout as output } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { assertUserTextWithinLimit } from './limits.js';
import type { ReadTurnResult } from './input.js';
import type { SessionRecord } from '../session/store.js';
import { formatSessionTranscript } from '../ui/sessionTranscript.js';

export type AskCardOptions = {
  model: string;
  baseUrl?: string;
  providerName?: string;
  noColor?: boolean;
  placeholder?: string;
  agentLabel?: string;
  session?: SessionRecord;
  /**
   * home: logo + card when session is empty.
   * dock: transcript + card (always full-screen redraw — never stacks).
   */
  mode?: 'home' | 'dock';
};

const c = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  blue: '\u001b[34m',
  white: '\u001b[37m',
  gray: '\u001b[90m',
};

const LOGO_COMPACT = [
  '  █████╗ ██╗ ██████╗ ██████╗ ██████╗ ███████╗',
  ' ██╔══██╗██║██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  ' ███████║██║██║     ██║   ██║██║  ██║█████╗  ',
  ' ██╔══██║██║██║     ██║   ██║██║  ██║██╔══╝  ',
  ' ██║  ██║██║╚██████╗╚██████╔╝██████╔╝███████╗',
  ' ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

/**
 * Read a turn inside ONE Ask card.
 * Every keystroke: full clear + (logo|transcript) + single card.
 * No relative cursor repaint — that was stacking ghosts on Windows Terminal.
 */
export async function readAskCardTurn(options: AskCardOptions): Promise<ReadTurnResult | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return null;
  }

  const mode = options.mode ?? 'home';
  let text = '';
  let closed = false;
  const wasRaw = Boolean((input as NodeJS.ReadStream & { isRaw?: boolean }).isRaw);
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  const paint = () => {
    const screen = renderFullAskScreen({
      text,
      model: options.model,
      baseUrl: options.baseUrl,
      providerName: options.providerName,
      noColor: options.noColor,
      placeholder: options.placeholder ?? 'Ask anything...  "Fix broken tests"',
      agentLabel: options.agentLabel ?? 'Build',
      mode,
      session: options.session,
    });
    // Atomic full redraw — guaranteed single card.
    output.write('\u001b[?25l');
    output.write('\u001b[2J\u001b[3J\u001b[H');
    output.write(screen.frame);
    output.write(`\u001b[${screen.caretRow};${screen.caretCol}H`);
    output.write('\u001b[?25h');
  };

  paint();

  return new Promise((resolve) => {
    const finish = (result: ReadTurnResult | null) => {
      if (closed) return;
      closed = true;
      input.off('keypress', onKey);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // ignore
      }
      output.write('\u001b[?25h');
      // Leave a clean screen for the turn renderer (user bubble + reply).
      output.write('\u001b[2J\u001b[3J\u001b[H');
      resolve(result);
    };

    const onKey = (_str: string, key: {
      name?: string;
      ctrl?: boolean;
      meta?: boolean;
      sequence?: string;
    }) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        finish(null);
        return;
      }
      if (key.name === 'escape' || key.name === 'esc') {
        if (text.length > 0) {
          text = '';
          paint();
          return;
        }
        finish({ text: '', bytes: 0, multiline: false });
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!normalized.trim()) {
          finish({ text: '', bytes: 0, multiline: false });
          return;
        }
        try {
          const bytes = assertUserTextWithinLimit(normalized);
          finish({ text: normalized, bytes, multiline: false });
        } catch (error) {
          // Keep editing; flash error in placeholder area via stderr then repaint.
          output.write(`\u001b[2J\u001b[3J\u001b[H${error instanceof Error ? error.message : String(error)}\n`);
          paint();
        }
        return;
      }
      if (key.name === 'backspace') {
        text = text.slice(0, -1);
        paint();
        return;
      }
      if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right') {
        return;
      }
      const ch = key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta ? key.sequence : '';
      if (ch && ch >= ' ' && ch !== '\u007f') {
        text += ch;
        paint();
      }
    };

    input.on('keypress', onKey);
  });
}

export function renderAskCardFrame(options: {
  text: string;
  model: string;
  baseUrl?: string;
  providerName?: string;
  noColor?: boolean;
  placeholder: string;
  agentLabel: string;
  mode?: 'home' | 'dock';
  fixedLines?: number;
}): string {
  // Back-compat for tests: card fragment only (no full screen).
  return renderCardOnly(options).join('\n') + '\n';
}

export function renderFullAskScreen(options: {
  text: string;
  model: string;
  baseUrl?: string;
  providerName?: string;
  noColor?: boolean;
  placeholder: string;
  agentLabel: string;
  mode?: 'home' | 'dock';
  session?: SessionRecord;
}): { frame: string; caretRow: number; caretCol: number } {
  const color = (name: keyof typeof c) => (options.noColor ? '' : c[name]);
  const cols = Math.max(output.columns || 88, 48);
  const rows = Math.max(output.rows || 24, 16);
  const mode = options.mode ?? 'home';
  const hasHistory = Boolean(options.session && options.session.messages.some((message) => message.role === 'user' || message.role === 'assistant'));

  const lines: string[] = [];
  if (mode === 'home' && !hasHistory) {
    const topPad = Math.max(1, Math.floor(rows / 8));
    for (let i = 0; i < topPad; i += 1) lines.push('');
    for (const logoLine of LOGO_COMPACT) {
      lines.push(center(logoLine, cols, `${color('white')}${color('bold')}`, color('reset')));
    }
    lines.push('');
  } else if (options.session && hasHistory) {
    const transcript = formatSessionTranscript(options.session, {
      maxLines: Math.max(8, rows - 12),
      noColor: options.noColor,
    });
    if (transcript) {
      for (const row of transcript.split('\n')) lines.push(row);
      lines.push('');
    }
  } else {
    lines.push('');
  }

  const card = renderCardOnly({
    text: options.text,
    model: options.model,
    baseUrl: options.baseUrl,
    providerName: options.providerName,
    noColor: options.noColor,
    placeholder: options.placeholder,
    agentLabel: options.agentLabel,
  });
  // Caret is on the ask row of the card (index 1 within card: top, ask, status, bot, blank, hint)
  const caretRow = lines.length + 2; // 1-based: after existing lines, top border is +1, ask is +2
  const caretCol = askCaretColumn(options.text, cols);
  lines.push(...card.map((row) => center(row, cols)));

  // Fit screen: if too tall, keep bottom (card) and trim top transcript.
  let frameLines = lines;
  if (frameLines.length > rows - 1) {
    frameLines = frameLines.slice(frameLines.length - (rows - 1));
  }

  return {
    frame: `${frameLines.join('\n')}\n`,
    caretRow: Math.min(rows, Math.max(1, caretRow - (lines.length - frameLines.length))),
    caretCol,
  };
}

function renderCardOnly(options: {
  text: string;
  model: string;
  baseUrl?: string;
  providerName?: string;
  noColor?: boolean;
  placeholder: string;
  agentLabel: string;
}): string[] {
  const color = (name: keyof typeof c) => (options.noColor ? '' : c[name]);
  const cols = Math.max(output.columns || 88, 48);
  const boxWidth = Math.min(72, Math.max(48, cols - 8));
  const inner = Math.max(8, boxWidth - 4);

  const modelLabel = shortenModel(options.model);
  const host = options.providerName === 'openai' || !options.providerName
    ? shortHost(options.baseUrl)
    : (options.providerName ?? '');
  const statusPlain = `${options.agentLabel} · ${modelLabel}${host ? ` ${host}` : ''}`;
  const statusColored = `${color('blue')}${color('bold')}${options.agentLabel}${color('reset')} ${color('dim')}·${color('reset')} ${color('white')}${modelLabel}${color('reset')}${host ? ` ${color('dim')}${host}${color('reset')}` : ''}`;

  const displayText = options.text.length > 0 ? options.text : options.placeholder;
  const textColor = options.text.length > 0 ? color('white') : color('gray');
  const clipped = takeByDisplayWidth(displayText.replace(/\n/g, '⏎'), inner);
  const textPad = Math.max(0, inner - displayWidth(clipped));
  const statusPad = Math.max(0, inner - displayWidth(statusPlain));

  return [
    `${color('blue')}┌${color('gray')}${'─'.repeat(boxWidth - 2)}┐${color('reset')}`,
    `${color('blue')}│${color('reset')} ${textColor}${clipped}${' '.repeat(textPad)}${color('reset')}`,
    `${color('blue')}│${color('reset')} ${statusColored}${' '.repeat(statusPad)}`,
    `${color('blue')}└${color('gray')}${'─'.repeat(boxWidth - 2)}┘${color('reset')}`,
    '',
    `${color('dim')}/help commands   enter submit   esc clear${color('reset')}`,
  ];
}

function center(line: string, cols: number, prefix = '', suffix = '') {
  // If line already has ANSI, measure plain width.
  const plain = stripAnsi(line);
  const left = Math.max(0, Math.floor((cols - displayWidth(plain)) / 2));
  if (prefix || suffix) {
    // logo path passes raw text + color wrappers
    return `${' '.repeat(left)}${prefix}${line}${suffix}`;
  }
  return `${' '.repeat(left)}${line}`;
}

function askCaretColumn(text: string, cols: number) {
  const boxWidth = Math.min(72, Math.max(48, cols - 8));
  const inner = Math.max(8, boxWidth - 4);
  const visible = takeByDisplayWidth(text.replace(/\n/g, '⏎'), inner);
  const cardLeft = Math.max(0, Math.floor((cols - boxWidth) / 2));
  return Math.min(cols, Math.max(1, cardLeft + 1 + 2 + displayWidth(visible) + 1));
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
    return host.length > 28 ? `${host.slice(0, 26)}…` : host;
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

function takeByDisplayWidth(value: string, max: number) {
  let out = '';
  let width = 0;
  for (const char of value) {
    const w = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
    if (width + w > max) break;
    out += char;
    width += w;
  }
  return out;
}
