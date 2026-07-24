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
   * home: full clear + logo + card (first screen only).
   * dock: keep transcript; rewrite ONE fixed-height card in place.
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

/** Fixed paint height so every keystroke overwrites the same region (no ghost stacks). */
const DOCK_FRAME_LINES = 7; // blank + top + ask + status + bot + blank + hint
const HOME_EXTRA_LINES = LOGO_COMPACT.length + 2; // logo + blank after logo

/**
 * Read a turn with the caret inside ONE OpenCode-like Ask card.
 * Typing rewrites the same card in place — never stacks frames.
 */
export async function readAskCardTurn(options: AskCardOptions): Promise<ReadTurnResult | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return null;
  }

  const mode = options.mode ?? 'home';
  let text = '';
  let closed = false;
  let hasPainted = false;
  const frameLines = mode === 'home' ? HOME_EXTRA_LINES + DOCK_FRAME_LINES : DOCK_FRAME_LINES;
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
      fixedLines: frameLines,
    });

    output.write('\u001b[?25l');
    if (mode === 'home' || !hasPainted) {
      if (mode === 'home') {
        output.write('\u001b[2J\u001b[3J\u001b[H');
      } else {
        // First dock paint: new line under transcript, then fixed block.
        output.write('\n');
      }
      output.write(frame);
      hasPainted = true;
    } else {
      // In-place rewrite: go to top of previous fixed block, overwrite every line.
      moveToBlockTop(frameLines);
      output.write(frame);
    }

    // Caret on ask row (1-based within block).
    const askRowInBlock = mode === 'home' ? HOME_EXTRA_LINES + 2 : 2;
    const inputCol = askCaretColumn(text, options);
    moveToBlockTop(frameLines);
    if (askRowInBlock > 1) output.write(`\u001b[${askRowInBlock - 1}B`);
    output.write(`\u001b[${inputCol}G`);
    output.write('\u001b[?25h');
  };

  paint();

  return new Promise((resolve) => {
    const eraseBlock = () => {
      if (!hasPainted) return;
      moveToBlockTop(frameLines);
      for (let i = 0; i < frameLines; i += 1) {
        output.write('\u001b[2K');
        if (i < frameLines - 1) output.write('\n');
      }
      // Back to first wiped line so transcript continues cleanly.
      if (frameLines > 1) output.write(`\u001b[${frameLines - 1}A`);
      output.write('\u001b[1G');
      hasPainted = false;
    };

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

      const submitted = Boolean(result && result.text.trim());
      if (mode === 'home' && submitted) {
        // First message: clear home chrome entirely; turnStart draws the user bubble.
        output.write('\u001b[2J\u001b[3J\u001b[H');
        hasPainted = false;
      } else {
        // Remove ephemeral input card so it never becomes history / never stacks.
        eraseBlock();
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
          // Keep single card; show error above next paint.
          eraseBlock();
          output.write(`${error instanceof Error ? error.message : String(error)}\n`);
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

function moveToBlockTop(frameLines: number) {
  // After writing frameLines lines each ending with \n, cursor is on the line AFTER the block.
  // Move up frameLines to the first line of the block, column 1.
  if (frameLines > 0) output.write(`\u001b[${frameLines}A`);
  output.write('\u001b[1G');
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
  const color = (name: keyof typeof c) => (options.noColor ? '' : c[name]);
  const cols = Math.max(output.columns || 88, 48);
  const boxWidth = Math.min(72, Math.max(48, cols - 8));
  const inner = Math.max(8, boxWidth - 4);
  const mode = options.mode ?? 'home';
  const fixed = options.fixedLines ?? (mode === 'home' ? HOME_EXTRA_LINES + DOCK_FRAME_LINES : DOCK_FRAME_LINES);

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
  const hint = `${color('dim')}/help commands   enter submit   esc clear${color('reset')}`;

  const lines: string[] = [];
  if (mode === 'home') {
    for (const logoLine of LOGO_COMPACT) {
      lines.push(pad(`${color('white')}${color('bold')}${logoLine}${color('reset')}`));
    }
    lines.push('');
  } else {
    lines.push(''); // top spacer of dock block
  }

  lines.push(pad(accentTop));
  lines.push(pad(askRow));
  lines.push(pad(statusRow));
  lines.push(pad(accentBot));
  lines.push('');
  lines.push(pad(hint));

  // Pad / trim to exact fixed height so in-place redraw never leaves ghosts.
  while (lines.length < fixed) lines.push('');
  if (lines.length > fixed) lines.length = fixed;

  // Each line ends with \n → cursor ends one row below the block.
  return `${lines.join('\n')}\n`;
}

function askCaretColumn(text: string, options: AskCardOptions) {
  const cols = Math.max(output.columns || 88, 48);
  const boxWidth = Math.min(72, Math.max(48, cols - 8));
  const inner = Math.max(8, boxWidth - 4);
  const visible = takeByDisplayWidth(text.replace(/\n/g, '⏎'), inner);
  const cardLeft = Math.max(0, Math.floor((cols - boxWidth) / 2));
  // col: left pad + '│' + space + text + 1
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
