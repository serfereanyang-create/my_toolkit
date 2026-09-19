import type { AppConfig } from '../config/types.js';
import type { Provider } from '../providers/types.js';
import type { ToolResult } from '../tools/index.js';
import type { ApprovalRequest } from '../tools/types.js';
import type { TaskBoard } from '../tasks/types.js';
import { renderApprovalDiff } from './diffView.js';
import {
  contextWindowLine,
  fmtElapsedCompact,
  formatDoneClock,
  formatTokensCompact,
  paint,
  statusIndicatorLine,
  TOOL_CALL_MAX_LINES,
  TRANSCRIPT_HINT,
} from './codexTheme.js';
import { disableConsoleSoftWrap } from './consoleWrap.js';
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

const defaultBlockMaxLines = 80;

type TerminalUIOptions = {
  quiet?: boolean;
  json?: boolean;
  noColor?: boolean;
  /** When true, show full tool input/output. Default folds process details. */
  verbose?: boolean;
  /** OpenCode-like home screen for interactive REPL (not prompt/json/ci). */
  version?: string;
};

type ContextSnapshot = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheReported: boolean;
  categories: Record<string, number> | null;
};

/**
 * Pure Codex-style usage segments from real numbers (footer.rs
 * `context_window_line` token variant + cache extension). No leading
 * separator — callers join segments with ` · ` (footer.rs convention).
 * Cache segment is omitted when the provider never reported cache metrics
 * (never render absent data as 0%).
 */
export function formatContextFooter(
  ctx: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheReported: boolean },
  turnOutputTokens = ctx.outputTokens,
): string {
  if (!ctx.inputTokens) return '';
  const parts = [contextWindowLine(ctx.inputTokens, null)];
  if (turnOutputTokens > 0) parts.push(`out ${formatTokensCompact(turnOutputTokens)}`);
  if (ctx.cacheReported && ctx.inputTokens > 0) {
    parts.push(`cache ${Math.min(100, Math.round((ctx.cacheReadTokens / ctx.inputTokens) * 100))}%`);
  }
  return parts.join(' · ');
}

/**
 * Pure compact task-board progress line (Codex plan-panel style).
 * Example: `board 3/8 ✓ · ▶ integrate auth · ○2 pending`.
 */
export function formatBoardProgressLine(board: TaskBoard): string {
  const tasks = board.tasks ?? [];
  if (tasks.length === 0) return '';
  const done = tasks.filter((t) => t.status === 'done').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const current = tasks.find((t) => t.status === 'in_progress');
  const parts = [`board ${done}/${tasks.length}`];
  if (current) parts.push(`▶ ${current.title}`);
  if (pending > 0) parts.push(`○${pending} pending`);
  if (blocked > 0) parts.push(`✗${blocked} blocked`);
  if (board.status === 'completed') parts.push('✔ completed');
  return `▦ ${parts.join(' · ')}`;
}

function formatTokenCount(value: number): string {
  return formatTokensCompact(value);
}

export class TerminalUI {
  private toolIndex = 0;
  private activeSpinner?: NodeJS.Timeout;
  private activeSpinnerText = '';
  private activeSpinnerFrame = 0;
  private streamingAssistant = false;
  private streamCleaner = new MarkdownStreamCleaner();
  private readonly runningTools = new Map<string, number>();
  private readonly toolInputs = new Map<string, unknown>();
  private options: TerminalUIOptions;
  private modelHint = 'aicode';
  // Codex-style contextual footer: latest per-turn context/cache snapshot plus
  // running totals for the current turn, so the busy row and turn-end footer
  // can surface genuine context occupancy without a separate command.
  private lastContext: ContextSnapshot | null = null;
  private turnOutputTokens = 0;
  private busyHint = '';
  private turnStartedAt = Date.now();
  private spinnerStartedAt = Date.now();
  // Live reasoning stream (JSON/bridge mode): the first thinking delta of a
  // model call opens a thinking segment, modelEnd closes it. The desktop
  // renders these as a running `think` step and feeds its token growth into
  // the composer's live tok/s meter.
  private thinkingOpen = false;
  private thinkingStartedAt = 0;

  constructor(options: TerminalUIOptions | boolean = {}) {
    this.options = typeof options === 'boolean' ? { quiet: options } : options;
    // Prefer no soft-wrap in interactive human UI (Windows console otherwise reflows like bash).
    if (!this.options.quiet && !this.options.json) {
      disableConsoleSoftWrap();
    }
  }

  get verbose() {
    return Boolean(this.options.verbose);
  }

  /** Toggle verbose detail folding at runtime (Ctrl+O in the REPL). */
  setVerbose(verbose: boolean) {
    this.options = { ...this.options, verbose };
  }

  toggleVerbose(): boolean {
    this.setVerbose(!this.options.verbose);
    return this.options.verbose ?? false;
  }

  /** Keyboard hint shown on the busy spinner row, e.g. "esc stop · ctrl+o detail". */
  setBusyHint(hint: string) {
    this.busyHint = hint;
  }

  banner(config: AppConfig, provider: Provider) {
    if (this.options.quiet || this.options.json || config.noBanner) return;
    this.modelHint = provider.model || provider.name;
    // Upstream codex has no splash logo: interactive starts paint the session
    // header box directly (session.rs) — the old OpenCode full-screen logo is
    // retired so the codex design is what users actually see first.
    this.writeSessionHeader(config, provider);
  }

  turnStart(prompt: string) {
    this.stopSpinner();
    this.toolIndex = 0;
    this.runningTools.clear();
    this.turnOutputTokens = 0;
    this.turnStartedAt = Date.now();
    if (this.options.json) return this.jsonEvent('turn_start', { prompt });
    if (this.options.quiet) return;
    // Append only — never clear screen (preserves scrollback / 往前翻).
    this.writeUserBubble(prompt);
  }

  modelStart() {
    this.streamingAssistant = false;
    this.streamCleaner = new MarkdownStreamCleaner();
    if (this.options.json) return this.jsonEvent('model_start', { status: 'running' });
    this.startSpinner('Working');
  }

  /**
   * Stream a reasoning/thinking delta (JSON/bridge mode only). The first delta
   * of a model call opens the segment (`thinking_start`); every delta forwards
   * its text (`thinking_delta`); modelEnd closes it with the measured duration
   * (`thinking_end`). The desktop reducer renders this as a running `think`
   * step and counts its growth toward the live tok/s meter.
   */
  thinkingDelta(delta: string) {
    if (!delta || !this.options.json) return;
    if (!this.thinkingOpen) {
      this.thinkingOpen = true;
      this.thinkingStartedAt = Date.now();
      this.jsonEvent('thinking_start', { text: '' });
    }
    this.jsonEvent('thinking_delta', { text: delta });
  }

  modelEnd() {
    if (this.streamingAssistant && !this.options.json && !this.options.quiet) {
      const tail = this.streamCleaner.flush();
      if (tail) process.stdout.write(tail);
      process.stdout.write('\n');
    }
    this.streamingAssistant = false;
    this.streamCleaner = new MarkdownStreamCleaner();
    if (this.options.json) {
      if (this.thinkingOpen) {
        this.thinkingOpen = false;
        this.jsonEvent('thinking_end', { durationMs: Date.now() - this.thinkingStartedAt });
      }
      return this.jsonEvent('model_end', { status: 'done' });
    }
    this.stopSpinner();
  }

  /**
   * Emit a real per-turn context/cache snapshot (JSON mode only) and cache it
   * for the TTY footer. Carries the genuine token breakdown and cache-hit
   * numbers so the desktop can render the 上下文容量 / 缓存命中率 panel — and
   * the terminal can show a Codex-style context footer — without any estimation.
   */
  contextStats(stats: Record<string, unknown>) {
    const categories = stats.categories && typeof stats.categories === 'object'
      ? stats.categories as Record<string, number>
      : null;
    this.lastContext = {
      inputTokens: typeof stats.inputTokens === 'number' ? stats.inputTokens : 0,
      outputTokens: typeof stats.outputTokens === 'number' ? stats.outputTokens : 0,
      cacheReadTokens: typeof stats.cacheReadTokens === 'number' ? stats.cacheReadTokens : 0,
      cacheReported: stats.providerCacheReported === true,
      categories,
    };
    this.turnOutputTokens += this.lastContext.outputTokens;
    if (this.options.json) return this.jsonEvent('context_stats', stats);
  }

  /** Codex turn end (separators.rs): one dim row `Worked for … · done … ·
   *  <usage segments>` for turns over a minute; usage-only row otherwise. */
  turnEnd() {
    if (this.options.json || this.options.quiet || !process.stdout.isTTY) return;
    const usage = this.lastContext && this.lastContext.inputTokens > 0
      ? formatContextFooter(this.lastContext, this.turnOutputTokens)
      : '';
    const elapsed = Date.now() - this.turnStartedAt;
    if (elapsed > 60_000) {
      const segments = ['Worked for ' + fmtElapsedCompact(elapsed), `done ${formatDoneClock(new Date())}`];
      if (usage) segments.push(usage);
      this.write(`${this.color('dim')}${segments.join(' · ')}${this.color('reset')}`);
      return;
    }
    if (usage) this.write(`${this.color('dim')}· ${usage}${this.color('reset')}`);
  }

  /**
   * Render the structured before/after diff of an approval request (Codex
   * style). No-op when the request carries no diff or output is piped/quiet.
   * Printed before the y/N prompt so the user approves real changes, not prose.
   */
  approvalDiff(request?: ApprovalRequest) {
    if (!request?.diff || this.options.quiet) return;
    if (this.options.json) return; // desktop renders its own diff card from the event
    const block = renderApprovalDiff(request.diff, { noColor: this.options.noColor });
    if (block) process.stdout.write(`${block}\n`);
  }

  /** Compact task-board progress row (Codex plan-panel style, append-only safe). */
  boardProgress(board: TaskBoard) {
    if (this.options.json || this.options.quiet) return;
    const line = formatBoardProgressLine(board);
    if (line) this.write(`${this.color('dim')}${line}${this.color('reset')}`);
  }

  assistantDelta(delta: string) {
    if (!delta) return;
    if (this.options.json) return this.jsonEvent('assistant_delta', { content: delta });
    this.stopSpinner();
    if (!this.streamingAssistant) {
      this.streamingAssistant = true;
      if (!this.options.quiet) {
        // Streamed rows carry the same dim `• ` prefix as finalized cells;
        // continuation deltas continue at column 0 without an indent.
        process.stdout.write(`${this.color('dim')}• ${this.color('reset')}`);
      }
    }
    const cleaned = this.streamCleaner.push(delta);
    if (!cleaned) return;
    process.stdout.write(cleaned);
  }

  assistant(content: string) {
    this.stopSpinner();
    const plain = stripMarkdownDecorations(content);
    if (this.streamingAssistant) {
      const tail = this.streamCleaner.flush();
      if (tail && !this.options.json && !this.options.quiet) process.stdout.write(tail);
      this.streamingAssistant = false;
      this.streamCleaner = new MarkdownStreamCleaner();
      if (this.options.json) return this.jsonEvent('assistant', { content: plain });
      if (!this.options.quiet) process.stdout.write('\n');
      return;
    }
    if (this.options.json) return this.jsonEvent('assistant', { content: plain });
    if (this.options.quiet) return;
    // AgentMarkdownCell (history_cell/messages.rs): dim `• ` prefix on the
    // first row, two-space indent on continuation rows.
    const lines = plain.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const shown = lines.slice(0, defaultBlockMaxLines);
    this.write(`${this.color('dim')}• ${this.color('reset')}${shown[0] ?? ''}`.trimEnd());
    for (const line of shown.slice(1)) this.write(`  ${line}`.trimEnd());
    if (lines.length > shown.length) {
      const bytes = Buffer.byteLength(plain, 'utf8');
      const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
      this.write(`${this.color('dim')}  … ${lines.length - shown.length} more line(s), total ${size}${this.color('reset')}`);
    }
  }

  toolStart(tool: string, input: unknown) {
    this.stopSpinner();
    this.toolIndex += 1;
    this.runningTools.set(tool, Date.now());
    this.toolInputs.set(tool, input);

    if (this.options.json) return this.jsonEvent('tool_start', { index: this.toolIndex, tool, input, status: 'running' });
    if (this.options.quiet) return;
    // exec_cell/render.rs running row: `[•] Running <title>` — the bullet is
    // the activity indicator (static dim fallback without truecolor), the
    // title is bold, detail dim.
    const title = execTitle(tool, input);
    const runningLabel = this.options.verbose ? `Tool ${this.toolIndex}` : 'Running';
    this.write(
      `  ${this.style('•', 'dim')} ${this.style(runningLabel, 'bold')}${title ? ` ${this.color('dim')}${title}${this.color('reset')}` : ''}`,
    );
  }

  toolResult(tool: string, result: ToolResult) {
    this.stopSpinner();
    const startedAt = this.runningTools.get(tool);
    if (startedAt) this.runningTools.delete(tool);
    this.toolInputs.delete(tool);
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

    if (!this.options.verbose) {
      // exec_cell/render.rs completed row: green/red bold bullet + bold "Ran"
      // + title, then a dim `  └ ` output block capped at TOOL_CALL_MAX_LINES
      // with the ui_consts.rs transcript hint on overflow.
      const bullet = this.style('•', result.ok ? 'green' : 'red');
      const title = execTitle(tool, undefined, plainOutput);
      this.write(`  ${bullet} ${this.style('Ran', 'bold')}${title ? ` ${this.color('dim')}${title}${this.color('reset')}` : ''}`);
      if (plainOutput.trim()) {
        const lines = plainOutput.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        const shown = lines.slice(0, TOOL_CALL_MAX_LINES);
        for (const line of shown) {
          this.write(`${this.color('dim')}  └ ${line}${this.color('reset')}`.trimEnd());
        }
        if (lines.length > shown.length) {
          this.write(`${this.color('dim')}  └ … +${lines.length - shown.length} lines ${TRANSCRIPT_HINT}${this.color('reset')}`);
        }
      } else if (!result.ok) {
        this.write(`${this.color('dim')}  └ (no output)${this.color('reset')}`);
      }
      return;
    }

    const status = result.ok
      ? this.style(`✓ ok ${duration}`, 'green')
      : this.style(`✗ failed ${duration}`, 'red');
    this.writeKeyValue('result', status);
    if (plainOutput.trim()) {
      this.writeKeyValue('output', '');
      const bodyColor = result.ok ? this.color('dim') : this.color('red');
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
    this.spinnerStartedAt = Date.now();
    this.renderSpinner();
    // Upstream status_indicator_widget.rs animates at 32ms per frame.
    this.activeSpinner = setInterval(() => this.renderSpinner(), 32);
  }

  private stopSpinner() {
    if (!this.activeSpinner) return;
    clearInterval(this.activeSpinner);
    this.activeSpinner = undefined;
    process.stdout.write(`\r\u001b[K\r`);
  }

  /**
   * status_indicator_widget.rs status row: `• Working (12s • esc to interrupt)`
   * with the motion.rs bullet blink (600ms half-period) and optional inline
   * detail, all above the LIVE_PREFIX_COLS=2 baseline.
   */
  private renderSpinner() {
    const frame = this.activeSpinnerFrame;
    this.activeSpinnerFrame += 1;
    const elapsed = Date.now() - this.spinnerStartedAt;
    const line = statusIndicatorLine({
      frame,
      title: this.activeSpinnerText || 'Working',
      elapsedMs: elapsed,
      interruptHint: 'esc',
      detail: shortenModelLabel(this.modelHint),
      noColor: this.options.noColor ?? false,
    });
    process.stdout.write(`\r  ${line}\u001b[K   `);
  }

  /**
   * Session header banner (history_cell/session.rs): dim `╭─╮` box, inner
   * width capped at 56, `">_ " + bold name + dim "(v…)"`, then model and
   * directory rows.
   */
  private writeSessionHeader(config: AppConfig, provider: Provider) {
    const noColor = this.options.noColor ?? false;
    const dim = (value: string) => paint(value, ['dim'], noColor);
    const nameLine = `${dim('>_ ')}${this.style('aicode', 'bold')}${this.options.version ? dim(` (v${this.options.version})`) : ''}`;
    const modelRow = `${dim('model: ')}${provider.model || provider.name}`;
    const dirRow = `${dim('directory: ')}${config.workspaceRoot}`;
    const inner = Math.min(Math.max(
      displayWidth(stripAnsi(nameLine)),
      displayWidth(stripAnsi(modelRow)),
      displayWidth(stripAnsi(dirRow)),
    ) + 2, 56);
    this.write(dim(`╭${'─'.repeat(inner)}╮`));
    for (const row of [nameLine, '', modelRow, dirRow]) {
      const pad = ' '.repeat(Math.max(0, inner - 2 - displayWidth(stripAnsi(row))));
      this.write(`${dim('│ ')}${row}${pad}${dim(' │')}`);
    }
    this.write(dim(`╰${'─'.repeat(inner)}╯`));
  }

  /**
   * Codex user message (history_cell/messages.rs): `› ` bold+dim prefix with a
   * two-space continuation indent, no box. Upstream also tints the whole block
   * with the user-message background, but only when the terminal palette is
   * known — style.rs falls back to unstyled when it is not, and we cannot read
   * the palette from Node, so we take that fallback.
   */
  private writeUserBubble(prompt: string) {
    const lines = prompt
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .slice(0, 12);
    this.write('');
    this.write(`${this.style('›', 'bold', 'dim')} ${this.color('white')}${lines[0] ?? ''}${this.color('reset')}`.trimEnd());
    for (const line of lines.slice(1)) {
      this.write(`  ${line}`.trimEnd());
    }
    const total = prompt.split(/\r?\n/).length;
    if (total > lines.length) {
      this.write(`${this.color('dim')}  … ${total - lines.length} more line(s)${this.color('reset')}`);
    }
  }

  private writeKeyValue(key: string, value: string) {
    this.write(`  ${this.label(key)} ${value}`.trimEnd());
  }

  /**
   * First-session command list (session.rs first-run copy): dim intro line,
   * command names in normal color, dim descriptions, two-space indent.
   */
  welcomeCommands() {
    if (this.options.json || this.options.quiet) return;
    const noColor = this.options.noColor ?? false;
    const dim = (value: string) => paint(value, ['dim'], noColor);
    const rows: Array<[string, string]> = [
      ['/init', 'create AGENTS.md workspace instructions'],
      ['/model', 'show or switch the active model'],
      ['/plan', 'task board (confirm|pause|continue)'],
      ['/review', 'review the current changes'],
      ['/help', 'floating command palette'],
    ];
    this.write(dim('  To get started, describe a task or try one of these commands:'));
    this.write('');
    for (const [command, description] of rows) {
      this.write(`  ${command}${dim(` - ${description}`)}`);
    }
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

/**
 * exec_cell title summary: the tool name plus its primary target
 * (path / command / query), mirroring how upstream titles each exec row with
 * the command it ran.
 */
function execTitle(tool: string, input?: unknown, output?: string): string {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const target = record.path ?? record.command ?? record.query ?? record.pattern ?? record.url;
  if (typeof target === 'string' && target.trim()) {
    const text = target.replace(/\s+/g, ' ').trim();
    return `${tool} ${truncate(text, 60)}`;
  }
  if (output) {
    const firstLine = output.trim().split('\n')[0] ?? '';
    if (firstLine) return `${tool} · ${truncate(firstLine.replace(/\s+/g, ' ').trim(), 60)}`;
  }
  return tool;
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

function shortenModelLabel(model: string) {
  if (!model) return 'model';
  const bare = model.includes('/') ? model.split('/').pop()! : model;
  return bare.length > 18 ? `${bare.slice(0, 16)}…` : bare;
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
