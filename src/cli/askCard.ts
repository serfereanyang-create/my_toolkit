import { stdin as input, stdout as output } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { assertUserTextWithinLimit } from './limits.js';
import type { ReadTurnResult } from './input.js';

export type AskCardOptions = {
  model: string;
  baseUrl?: string;
  providerName?: string;
  noColor?: boolean;
  placeholder?: string;
  agentLabel?: string;
  /**
   * home: full clear + logo + centered card (first screen only).
   * dock: do NOT clear transcript; redraw only a bottom input card.
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
 * Read a turn with the caret inside the OpenCode-like Ask card.
 * home mode clears once and shows logo; dock mode keeps conversation history.
 */
export async function readAskCardTurn(options: AskCardOptions): Promise<ReadTurnResult | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return null;
  }

  const mode = options.mode ?? 'home';
  let text = '';
  let closed = false;
  let paintedLines = 0;
  const wasRaw = Boolean((input as NodeJS.ReadStream & { isRaw?: boolean }).isRaw);
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  const paint = () => {
    const frame = renderAskCardFrame({
      text,
      model: options.model,
      baseUrl: options.baseUrl,
      providerName: options.providerName,
      noColor: options.noColor,
      placeholder: options.placeholder ?? 'Ask anything...  "Fix broken tests"',
      agentLabel: options.agentLabel ?? 'Build',
      mode,
    });
    const lines = frame.replace(/\n$/, '').split('\n');
    output.write('\u001b[?25l');
    if (mode === 'home') {
      // First screen only: wipe and show logo + card.
      output.write('\u001b[2J\u001b[3J\u001b[H');
      output.write(frame);
      paintedLines = lines.length;
    } else {
      // Dock: keep transcript above. On repaint, move up previous card height and redraw.
      if (paintedLines > 0) {
        output.write(`\u001b[${paintedLines}A`);
        for (let i = 0; i < paintedLines; i += 1) {
          output.write('\u001b[2K\u001b[1B');
        }
        output.write(`\u001b[${paintedLines}A`);
      } else {
        output.write('\n');
      }
      output.write(frame);
      paintedLines = lines.length;
    }
    const { inputRow, inputCol } = caretPosition(text, { ...options, mode }, paintedLines, mode);
    if (mode === 'home') {
      output.write(`\u001b[${inputRow};${inputCol}H`);
    } else {
      // Relative caret on the input row of the docked card.
      const relRow = inputRow; // already 1-based within painted block
      output.write(`\u001b[${paintedLines}A`);
      if (relRow > 1) output.write(`\u001b[${relRow - 1}B`);
      output.write(`\u001b[${inputCol}G`);
    }
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
      if (mode === 'home') {
        // Leave home card; conversation will clear once when the turn starts.
        output.write('\n');
      } else if (paintedLines > 0) {
        // Keep the final docked card as the last lines of the transcript.
        output.write('\n');
      }
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
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
          paintedLines = 0;
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
}): string {
  const color = (name: keyof typeof c) => (options.noColor ? '' : c[name]);
  const cols = Math.max(output.columns || 88, 48);
  const rows = Math.max(output.rows || 24, 16);
  const boxWidth = Math.min(72, Math.max(48, cols - 8));
  const inner = Math.max(8, boxWidth - 4);
  const mode = options.mode ?? 'home';

  const pad = (line: string) => {
    const plain = stripAnsi(line);
    const left = Math.max(0, Math.floor((cols - displayWidth(plain)) / 2));
    return `${' '.repeat(left)}${line}`;
  };

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

  const accentTop = `${color('blue')}┌${color('gray')}${'─'.repeat(boxWidth - 2)}┐${color('reset')}`;
  const askRow = `${color('blue')}│${color('reset')} ${textColor}${clipped}${' '.repeat(textPad)}${color('reset')}`;
  const statusRow = `${color('blue')}│${color('reset')} ${statusColored}${' '.repeat(statusPad)}`;
  const accentBot = `${color('blue')}└${color('gray')}${'─'.repeat(boxWidth - 2)}┘${color('reset')}`;

  const lines: string[] = [];
  if (mode === 'home') {
    // Logo + single centered card.
    const logo = LOGO_COMPACT;
    const content = logo.length + 8;
    const topPad = Math.max(1, Math.floor((rows - content) / 4));
    for (let i = 0; i < topPad; i += 1) lines.push('');
    for (const logoLine of logo) {
      lines.push(pad(`${color('white')}${color('bold')}${logoLine}${color('reset')}`));
    }
    lines.push('');
  } else {
    // Docked under transcript: small gap only.
    lines.push('');
  }

  lines.push(pad(accentTop));
  lines.push(pad(askRow));
  lines.push(pad(statusRow));
  lines.push(pad(accentBot));
  lines.push('');
  lines.push(pad(`${color('dim')}/help commands   enter submit   esc clear${color('reset')}`));
  return `${lines.join('\n')}\n`;
}

function caretPosition(
  text: string,
  options: AskCardOptions,
  paintedLines: number,
  mode: 'home' | 'dock',
) {
  const cols = Math.max(output.columns || 88, 48);
  const boxWidth = Math.min(72, Math.max(48, cols - 8));
  const inner = Math.max(8, boxWidth - 4);
  const visible = takeByDisplayWidth(text.replace(/\n/g, '⏎'), inner);
  const cardLeft = Math.max(0, Math.floor((cols - boxWidth) / 2));
  const inputCol = cardLeft + 1 + 2 + displayWidth(visible) + 1;

  // Find the ask row index within the painted frame (1-based).
  // Frame ends with: border, ask, status, border, empty, hint  => ask is paintedLines - 4
  // home has logo above; dock has one empty line above.
  const inputRow = Math.max(1, paintedLines - 4);
  void options;
  void mode;
  return { inputRow, inputCol: Math.min(cols, Math.max(1, inputCol)) };
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
