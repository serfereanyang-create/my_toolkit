import type { AppConfig } from '../config/types.js';
import type { Provider } from '../providers/types.js';
import type { ToolResult } from '../tools/index.js';
import { MarkdownStreamCleaner, stripMarkdownDecorations } from './markdown.js';

/**
 * Palette roles (when color is enabled):
 * - brand/border: cyan
 * - section Task: blue
 * - section Assistant: green (title only; body is plain/reset for readability)
 * - section Tool: cyan title, yellow input, gray labels
 * - success: green · failure: red · info/meta: gray/dim
 */
const colors = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  blue: '\u001b[34m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  gray: '\u001b[90m',
  white: '\u001b[37m',
};

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const defaultBlockMaxLines = 80;

type TerminalUIOptions = {
  quiet?: boolean;
  json?: boolean;
  noColor?: boolean;
};

export class TerminalUI {
  private toolIndex = 0;
  private activeSpinner?: NodeJS.Timeout;
  private activeSpinnerText = '';
  private activeSpinnerFrame = 0;
  private streamingAssistant = false;
  private streamCleaner = new MarkdownStreamCleaner();
  private readonly runningTools = new Map<string, number>();
  private readonly options: TerminalUIOptions;

  constructor(options: TerminalUIOptions | boolean = {}) {
    this.options = typeof options === 'boolean' ? { quiet: options } : options;
  }

  banner(config: AppConfig, provider: Provider) {
    if (this.options.quiet || this.options.json || config.noBanner) return;
    this.writeBox([
      `${this.style('aicode', 'bold', 'cyan')} ${this.color('dim')}cli mvp${this.color('reset')}`,
      `${this.label('provider')} ${this.color('white')}${provider.name}${this.color('reset')}`,
      `${this.label('model')} ${this.color('white')}${provider.model}${this.color('reset')}`,
      `${this.label('workspace')} ${this.color('dim')}${config.workspaceRoot}${this.color('reset')}`,
      `${this.label('approval')} ${this.color('dim')}${config.approval}${this.color('reset')}`,
    ]);
  }

  turnStart(prompt: string) {
    this.stopSpinner();
    this.toolIndex = 0;
    this.runningTools.clear();
    if (this.options.json) return this.jsonEvent('turn_start', { prompt });
    if (this.options.quiet) return;
    this.writeSectionTitle('Task', 'blue');
    // User paste: fold by real newlines only — never column-reflow like bash.
    this.writeBlock(prompt, this.color('dim'), { maxLines: 12, noWrap: true });
  }

  modelStart() {
    this.streamingAssistant = false;
    this.streamCleaner = new MarkdownStreamCleaner();
    if (this.options.json) return this.jsonEvent('model_start', { status: 'running' });
    this.startSpinner('thinking');
  }

  modelEnd() {
    if (this.streamingAssistant && !this.options.json && !this.options.quiet) {
      const tail = this.streamCleaner.flush();
      if (tail) process.stdout.write(tail);
      process.stdout.write('\n');
    }
    this.streamingAssistant = false;
    this.streamCleaner = new MarkdownStreamCleaner();
    if (this.options.json) return this.jsonEvent('model_end', { status: 'done' });
    this.stopSpinner();
  }

  assistantDelta(delta: string) {
    if (!delta) return;
    if (this.options.json) return this.jsonEvent('assistant_delta', { content: delta });
    this.stopSpinner();
    if (!this.streamingAssistant) {
      this.streamingAssistant = true;
      if (!this.options.quiet) this.writeSectionTitle('Assistant', 'green');
    }
    const cleaned = this.streamCleaner.push(delta);
    if (!cleaned) return;
    // Stream body in default foreground (not solid green) for long replies.
    process.stdout.write(cleaned);
  }

  assistant(content: string) {
    this.stopSpinner();
    const plain = stripMarkdownDecorations(content);
    if (this.streamingAssistant) {
      // Content was already streamed; avoid duplicate full reprint.
      const tail = this.streamCleaner.flush();
      if (tail && !this.options.json && !this.options.quiet) process.stdout.write(tail);
      this.streamingAssistant = false;
      this.streamCleaner = new MarkdownStreamCleaner();
      if (this.options.json) return this.jsonEvent('assistant', { content: plain });
      if (!this.options.quiet) process.stdout.write('\n');
      return;
    }
    if (this.options.json) return this.jsonEvent('assistant', { content: plain });
    if (this.options.quiet) return this.write(plain);
    this.writeSectionTitle('Assistant', 'green');
    // Never column-reflow assistant text; only real newlines (console may soft-wrap visually).
    this.writeBlock(plain, this.color('reset'), { noWrap: true });
  }

  toolStart(tool: string, input: unknown) {
    this.stopSpinner();
    this.toolIndex += 1;
    this.runningTools.set(tool, Date.now());
    if (this.options.json) return this.jsonEvent('tool_start', { index: this.toolIndex, tool, input, status: 'running' });
    if (this.options.quiet) return;
    this.writeSectionTitle(`Tool ${this.toolIndex}`, 'cyan', tool);
    this.writeKeyValue('input', formatInput(input, this.options.noColor ?? false));
    this.writeKeyValue('status', `${this.color('dim')}running${this.color('reset')}`);
    this.startSpinner(`${tool}`);
  }

  toolResult(tool: string, result: ToolResult) {
    this.stopSpinner();
    const startedAt = this.runningTools.get(tool);
    if (startedAt) this.runningTools.delete(tool);
    const duration = startedAt ? `${Date.now() - startedAt}ms` : 'done';
    const plainOutput = stripMarkdownDecorations(result.output ?? '');
    if (this.options.json) {
      return this.jsonEvent('tool_result', {
        tool,
        ok: result.ok,
        durationMs: startedAt ? Date.now() - startedAt : undefined,
        output: plainOutput,
        data: result.data,
      });
    }
    if (this.options.quiet) return;
    const status = result.ok
      ? this.style(`ok ${duration}`, 'green')
      : this.style(`failed ${duration}`, 'red');
    this.writeKeyValue('result', status);
    if (plainOutput.trim()) {
      this.writeKeyValue('output', '');
      // Success output: dim; failure: red. Keeps body quieter than titles.
      const bodyColor = result.ok ? this.color('dim') : this.color('red');
      // Tool dumps keep original line breaks; no bash-style force wrap.
      this.writeBlock(plainOutput, bodyColor, { indent: '    ', noWrap: true });
    }
  }

  info(content: string) {
    this.stopSpinner();
    const plain = stripMarkdownDecorations(content);
    if (this.options.json) return this.jsonEvent('info', { content: plain });
    if (this.options.quiet) return;
    this.write(`${this.color('dim')}${plain}${this.color('reset')}`);
  }

  error(content: string) {
    this.stopSpinner();
    const plain = stripMarkdownDecorations(content);
    if (this.options.json) {
      process.stderr.write(`${JSON.stringify({ type: 'error', content: plain })}\n`);
      return;
    }
    process.stderr.write(`${this.color('red')}${plain}${this.color('reset')}\n`);
  }

  final(ok: boolean, data: Record<string, unknown>) {
    this.stopSpinner();
    if (this.options.json) this.jsonEvent('final', { ok, ...data });
  }

  pauseSpinnerForPrompt() {
    this.stopSpinner();
  }

  resumeSpinnerAfterPrompt() {
    if (this.activeSpinnerText) this.startSpinner(this.activeSpinnerText);
  }

  private startSpinner(text: string) {
    if (this.options.quiet || this.options.json || !process.stdout.isTTY) return;
    this.stopSpinner();
    this.activeSpinnerText = text;
    this.activeSpinnerFrame = 0;
    this.renderSpinner();
    this.activeSpinner = setInterval(() => this.renderSpinner(), 80);
  }

  private stopSpinner() {
    if (!this.activeSpinner) return;
    clearInterval(this.activeSpinner);
    this.activeSpinner = undefined;
    process.stdout.write(`\r${' '.repeat(displayWidth(this.activeSpinnerText) + 16)}\r`);
  }

  private renderSpinner() {
    const frame = spinnerFrames[this.activeSpinnerFrame % spinnerFrames.length];
    this.activeSpinnerFrame += 1;
    process.stdout.write(
      `\r  ${this.color('cyan')}${frame}${this.color('reset')} ${this.color('dim')}${this.activeSpinnerText}…${this.color('reset')}`,
    );
  }

  private writeBox(lines: string[]) {
    const plainLengths = lines.map((line) => displayWidth(stripAnsi(line)));
    const width = Math.max(...plainLengths, 16);
    const edge = this.color('cyan');
    const reset = this.color('reset');
    this.write(`${edge}┌${'─'.repeat(width + 2)}┐${reset}`);
    for (const line of lines) {
      const padding = ' '.repeat(Math.max(0, width - displayWidth(stripAnsi(line))));
      this.write(`${edge}│${reset} ${line}${padding} ${edge}│${reset}`);
    }
    this.write(`${edge}└${'─'.repeat(width + 2)}┘${reset}`);
  }

  private writeSectionTitle(title: string, color: keyof typeof colors, detail?: string) {
    // ASCII marker avoids Windows code-page mojibake for ● in some consoles.
    const bar = `${this.color(color)}*${this.color('reset')}`;
    const head = this.style(title, 'bold', color);
    const suffix = detail ? ` ${this.color('dim')}${detail}${this.color('reset')}` : '';
    this.write(`\n${bar} ${head}${suffix}`);
  }

  private writeKeyValue(key: string, value: string) {
    this.write(`  ${this.label(key)} ${value}`.trimEnd());
  }

  private writeBlock(content: string, color: string, options: { indent?: string; maxLines?: number; noWrap?: boolean } = {}) {
    const indent = options.indent ?? '  ';
    const maxLines = options.maxLines ?? defaultBlockMaxLines;
    // Default noWrap: only split on real newlines. Column wrap is opt-in (legacy / rare).
    const noWrap = options.noWrap !== false;
    const width = Math.max(24, terminalColumns() - displayWidth(indent));
    const lines = noWrap
      ? content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
      : wrapLines(content, width);
    const shown = lines.slice(0, maxLines);
    for (const line of shown) {
      this.write(`${indent}${color}${line}${this.color('reset')}`.trimEnd());
    }
    if (lines.length > shown.length) {
      const bytes = Buffer.byteLength(content, 'utf8');
      const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
      this.write(`${indent}${this.color('dim')}… ${lines.length - shown.length} more line(s), total ${size}${this.color('reset')}`);
    }
  }

  private jsonEvent(type: string, payload: Record<string, unknown>) {
    process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`);
  }

  private write(content: string) {
    process.stdout.write(`${content}\n`);
  }

  private label(value: string) {
    return `${this.color('dim')}${value}:${this.color('reset')}`;
  }

  private style(value: string, ...names: Array<keyof typeof colors>) {
    return `${names.map((name) => this.color(name)).join('')}${value}${this.color('reset')}`;
  }

  private color(name: keyof typeof colors) {
    return this.options.noColor ? '' : colors[name];
  }
}

function formatInput(input: unknown, noColor: boolean) {
  const json = JSON.stringify(input);
  if (!json) return '{}';
  const value = truncate(json, 220);
  return noColor ? value : `${colors.yellow}${value}${colors.reset}`;
}

function truncate(value: string, max: number) {
  return displayWidth(value) > max ? `${takeByDisplayWidth(value, max - 3)}...` : value;
}

function terminalColumns() {
  return Math.min(Math.max(process.stdout.columns || 88, 32), 120);
}

function wrapLines(content: string, width: number) {
  return content.split(/\r?\n/).flatMap((line) => wrapLine(line, width));
}

function wrapLine(line: string, width: number) {
  if (line === '') return [''];
  const wrapped: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const char of line) {
    const charWidth = charDisplayWidth(char);
    if (current && currentWidth + charWidth > width) {
      wrapped.push(current);
      current = '';
      currentWidth = 0;
    }
    current += char;
    currentWidth += charWidth;
  }
  wrapped.push(current);
  return wrapped;
}

function takeByDisplayWidth(value: string, max: number) {
  let output = '';
  let width = 0;
  for (const char of value) {
    const nextWidth = width + charDisplayWidth(char);
    if (nextWidth > max) break;
    output += char;
    width = nextWidth;
  }
  return output;
}

function displayWidth(value: string) {
  let width = 0;
  for (const char of value) width += charDisplayWidth(char);
  return width;
}

function charDisplayWidth(char: string) {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return 0;
  // Rough CJK / fullwidth detection
  if (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
