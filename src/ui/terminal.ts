import type { AppConfig } from '../config/types.js';
import type { Provider } from '../providers/types.js';
import type { ToolResult } from '../tools/index.js';

const colors = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  gray: '\u001b[90m',
};

const spinnerFrames = ['-', '\\', '|', '/'];
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
  private readonly runningTools = new Map<string, number>();
  private readonly options: TerminalUIOptions;

  constructor(options: TerminalUIOptions | boolean = {}) {
    this.options = typeof options === 'boolean' ? { quiet: options } : options;
  }

  banner(config: AppConfig, provider: Provider) {
    if (this.options.quiet || this.options.json || config.noBanner) return;
    this.writeBox([
      `${this.style('aicode cli mvp', 'bold', 'cyan')}`,
      `${this.label('provider')} ${provider.name}`,
      `${this.label('model')} ${provider.model}`,
      `${this.label('workspace')} ${config.workspaceRoot}`,
      `${this.label('approval')} ${config.approval}`,
    ]);
  }

  turnStart(prompt: string) {
    this.stopSpinner();
    this.toolIndex = 0;
    this.runningTools.clear();
    if (this.options.json) return this.jsonEvent('turn_start', { prompt });
    if (this.options.quiet) return;
    this.writeSectionTitle('Task', 'magenta');
    this.writeBlock(prompt, this.color('gray'), { maxLines: 6 });
  }

  modelStart() {
    if (this.options.json) return this.jsonEvent('model_start', { status: 'running' });
    this.startSpinner('model thinking');
  }

  modelEnd() {
    if (this.options.json) return this.jsonEvent('model_end', { status: 'done' });
    this.stopSpinner();
  }

  assistant(content: string) {
    this.stopSpinner();
    if (this.options.json) return this.jsonEvent('assistant', { content });
    if (this.options.quiet) return this.write(content);
    this.writeSectionTitle('Assistant', 'green');
    this.writeBlock(content, this.color('green'));
  }

  toolStart(tool: string, input: unknown) {
    this.stopSpinner();
    this.toolIndex += 1;
    this.runningTools.set(tool, Date.now());
    if (this.options.json) return this.jsonEvent('tool_start', { index: this.toolIndex, tool, input, status: 'running' });
    if (this.options.quiet) return;
    this.writeSectionTitle(`Tool ${this.toolIndex}`, 'cyan', tool);
    this.writeKeyValue('input', formatInput(input, this.options.noColor ?? false));
    this.writeKeyValue('status', `${this.color('gray')}running${this.color('reset')}`);
    this.startSpinner(`${tool} running`);
  }

  toolResult(tool: string, result: ToolResult) {
    this.stopSpinner();
    const startedAt = this.runningTools.get(tool);
    if (startedAt) this.runningTools.delete(tool);
    const duration = startedAt ? `${Date.now() - startedAt}ms` : 'done';
    if (this.options.json) return this.jsonEvent('tool_result', { tool, ok: result.ok, durationMs: startedAt ? Date.now() - startedAt : undefined, output: result.output, data: result.data });
    if (this.options.quiet) return;
    const status = result.ok ? this.style(`ok ${duration}`, 'green') : this.style(`failed ${duration}`, 'red');
    this.writeKeyValue('result', status);
    if (result.output.trim()) {
      this.writeKeyValue('output', '');
      this.writeBlock(result.output, result.ok ? this.color('reset') : this.color('red'), { indent: '    ' });
    }
  }

  info(content: string) {
    this.stopSpinner();
    if (this.options.json) return this.jsonEvent('info', { content });
    if (this.options.quiet) return;
    this.write(`${content}\n`);
  }

  error(content: string) {
    this.stopSpinner();
    if (this.options.json) {
      process.stderr.write(`${JSON.stringify({ type: 'error', content })}\n`);
      return;
    }
    process.stderr.write(`${content}\n`);
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
    this.activeSpinner = setInterval(() => this.renderSpinner(), 120);
  }

  private stopSpinner() {
    if (!this.activeSpinner) return;
    clearInterval(this.activeSpinner);
    this.activeSpinner = undefined;
    process.stdout.write(`\r${' '.repeat(displayWidth(this.activeSpinnerText) + 12)}\r`);
  }

  private renderSpinner() {
    const frame = spinnerFrames[this.activeSpinnerFrame % spinnerFrames.length];
    this.activeSpinnerFrame += 1;
    process.stdout.write(`\r  ${this.color('cyan')}${frame}${this.color('reset')} ${this.color('gray')}${this.activeSpinnerText}...${this.color('reset')}`);
  }

  private writeBox(lines: string[]) {
    const plainLengths = lines.map((line) => displayWidth(line));
    const width = Math.max(...plainLengths, 16);
    this.write(`${this.color('cyan')}┌${'─'.repeat(width + 2)}┐${this.color('reset')}`);
    for (const line of lines) {
      const padding = ' '.repeat(width - displayWidth(line));
      this.write(`${this.color('cyan')}│${this.color('reset')} ${line}${padding} ${this.color('cyan')}│${this.color('reset')}`);
    }
    this.write(`${this.color('cyan')}└${'─'.repeat(width + 2)}┘${this.color('reset')}`);
  }

  private writeSectionTitle(title: string, color: keyof typeof colors, detail?: string) {
    const suffix = detail ? ` ${this.color('gray')}${detail}${this.color('reset')}` : '';
    this.write(`\n${this.style(title, 'bold', color)}${suffix}`);
  }

  private writeKeyValue(key: string, value: string) {
    this.write(`  ${this.label(key)} ${value}`.trimEnd());
  }

  private writeBlock(content: string, color: string, options: { indent?: string; maxLines?: number } = {}) {
    const indent = options.indent ?? '  ';
    const maxLines = options.maxLines ?? defaultBlockMaxLines;
    const width = Math.max(24, terminalColumns() - displayWidth(indent));
    const lines = wrapLines(content, width);
    const shown = lines.slice(0, maxLines);
    for (const line of shown) {
      this.write(`${indent}${color}${line}${this.color('reset')}`.trimEnd());
    }
    if (lines.length > shown.length) {
      this.write(`${indent}${this.color('gray')}... ${lines.length - shown.length} more line(s)${this.color('reset')}`);
    }
  }

  private jsonEvent(type: string, payload: Record<string, unknown>) {
    process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`);
  }

  private write(content: string) {
    process.stdout.write(`${content}\n`);
  }

  private label(value: string) {
    return `${this.color('gray')}${value}:${this.color('reset')}`;
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
  for (const char of stripAnsi(value)) width += charDisplayWidth(char);
  return width;
}

function charDisplayWidth(char: string) {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )) return 2;
  return 1;
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
