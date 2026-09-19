/**
 * Codex TUI design tokens, ported from the open-source OpenAI Codex CLI
 * (github.com/openai/codex, codex-rs/tui/src — Apache-2.0).
 *
 * Sources (upstream files noted per section):
 * - style.rs: semantic tones, accent style, user-message background blend
 * - status_indicator_widget.rs / motion.rs: status row layout, bullet blink
 * - history_cell/messages.rs + exec_cell/render.rs: `›` user prefix, `•`
 *   assistant/exec bullets, `  └ ` output prefix, TOOL_CALL_MAX_LINES
 * - footer.rs + status/helpers.rs: ` · ` separator, context_window_line,
 *   format_tokens_compact, "Worked for … · done …" separator row
 * - ui_consts.rs: LIVE_PREFIX_COLS = 2, TRANSCRIPT_HINT
 *
 * Where the upstream style depends on terminal palette detection we do not
 * have (background luminance), style.rs explicitly falls back to unstyled
 * output — we take that same fallback.
 */

export const codex = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  italic: '\u001b[3m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  white: '\u001b[37m',
  gray: '\u001b[90m',
} as const;

export type CodexColor = keyof typeof codex;

/** style.rs accent_style: cyan + bold on dark/unknown terminals. */
export const ACCENT: CodexColor[] = ['bold', 'cyan'];
/** style.rs status_style: success/failure/attention tones (all bold upstream). */
export const SUCCESS: CodexColor[] = ['bold', 'green'];
export const FAILURE: CodexColor[] = ['bold', 'red'];
export const ATTENTION: CodexColor[] = ['bold', 'yellow'];

/** ui_consts.rs LIVE_PREFIX_COLS — global indent baseline. */
export const LIVE_PREFIX_COLS = 2;
/** exec_cell/render.rs TOOL_CALL_MAX_LINES. */
export const TOOL_CALL_MAX_LINES = 5;
/** ui_consts.rs TRANSCRIPT_HINT. */
export const TRANSCRIPT_HINT = '(ctrl + t to view transcript)';
/** motion.rs blink half-period for the non-truecolor activity bullet. */
export const ACTIVITY_BLINK_MS = 600;
/** status_indicator_widget.rs animation frame interval. */
export const STATUS_FRAME_MS = 32;

export function paint(value: string, names: CodexColor[], noColor: boolean): string {
  if (noColor || names.length === 0) return value;
  return `${names.map((name) => codex[name]).join('')}${value}${codex.reset}`;
}

/**
 * status/helpers.rs format_tokens_compact: uppercase K/M/B/T, decimals
 * (scaled<10 → 2, <100 → 1, else 0) with trailing zeros trimmed.
 * 1234→"1.23K", 14200→"14.2K", 1500000→"1.5M".
 */
export function formatTokensCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1000) return String(Math.round(tokens));
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (tokens >= scale) {
      const scaled = tokens / scale;
      const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
      let text = scaled.toFixed(decimals);
      if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
      return `${text}${suffix}`;
    }
  }
  return String(tokens);
}

/**
 * status_indicator_widget.rs fmt_elapsed_compact: "<1m" → "42s",
 * "<1h" → "3m 05s", else "1h 02m 03s".
 */
export function fmtElapsedCompact(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * footer.rs context_window_line: percentage variant preferred, token-count
 * variant fallback, "100% context left" when neither. We rarely know the
 * window size, so the token variant is the common path.
 */
export function contextWindowLine(usedTokens: number, percentLeft: number | null): string {
  if (percentLeft !== null) return `${Math.min(100, Math.max(0, percentLeft))}% context left`;
  if (usedTokens > 0) return `${formatTokensCompact(usedTokens)} used`;
  return '100% context left';
}

/**
 * separators.rs turn-end row: `Worked for 1m 30s · done 10:45 PM`, dim,
 * only shown for turns longer than 60 seconds.
 */
export function turnSeparatorLine(elapsedMs: number, endedAt: Date, noColor: boolean): string {
  if (elapsedMs <= 60_000) return '';
  const text = `Worked for ${fmtElapsedCompact(elapsedMs)} · done ${formatClock(endedAt)}`;
  return paint(text, ['dim'], noColor);
}

function formatClock(date: Date): string {
  return formatDoneClock(date);
}

/**
 * separators.rs "done %-I:%M %p": 12-hour clock without leading zero.
 */
export function formatDoneClock(date: Date): string {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${suffix}`;
}

/**
 * status_indicator_widget.rs status row (non-truecolor branch):
 * `• Working (12s • esc to interrupt)` with a blinking bullet (motion.rs:
 * 600ms half-period, "•"/"◦") and a dim suffix.
 */
export function statusIndicatorLine(options: {
  frame: number;
  title?: string;
  elapsedMs: number;
  interruptHint?: string | null;
  detail?: string;
  noColor: boolean;
}): string {
  const bullet = Math.floor(options.elapsedMs / ACTIVITY_BLINK_MS) % 2 === 0 ? '•' : '◦';
  const title = options.title ?? 'Working';
  const elapsed = fmtElapsedCompact(options.elapsedMs);
  const suffix = options.interruptHint === null
    ? `(${elapsed})`
    : `(${elapsed} • ${options.interruptHint ?? 'esc'} to interrupt)`;
  const inline = options.detail ? ` · ${options.detail}` : '';
  return [
    paint(bullet, ['bold'], options.noColor),
    ' ',
    paint(title, ['bold'], options.noColor),
    paint(` ${suffix}`, ['dim'], options.noColor),
    paint(inline, ['dim'], options.noColor),
  ].join('');
}
