/**
 * Approval diff rendering for the terminal UI.
 *
 * Design ported from the open-source OpenAI Codex CLI TUI
 * (github.com/openai/codex, codex-rs/tui + the archived TypeScript CLI's
 * `cli/diff.ts`, Apache-2.0): a unified-style hunk view with green added
 * lines, red removed lines, dim context lines, per-hunk line-number headers,
 * long unchanged runs folded away, and a hard line budget so a huge rewrite
 * can never flood the approval prompt.
 *
 * Pure functions only (no stdout writes) so rendering is unit-testable.
 */

export type DiffLineOp = {
  kind: 'context' | 'add' | 'del';
  text: string;
  /** 1-based line number in the before file (context/del). */
  beforeLine?: number;
  /** 1-based line number in the after file (context/add). */
  afterLine?: number;
};

export type DiffRenderOptions = {
  noColor?: boolean;
  /** Max +/- lines rendered before the diff is folded with a truncation note. */
  maxChangedLines?: number;
  /** Context lines kept around each change cluster. */
  contextLines?: number;
};

const palette = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
};

/**
 * Full-row tinted backgrounds ported from upstream diff_render.rs (dark
 * truecolor palette): add #213A2B, delete #4A221D. Rendered as 24-bit
 * background SGR so Windows Terminal / modern consoles show the GitHub-style
 * row tint; terminals without truecolor usually degrade gracefully.
 */
const ADD_BG = '\u001b[48;2;33;58;43m';
const DEL_BG = '\u001b[48;2;74;34;29m';

function splitLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // A trailing newline yields a final empty string; keep it out so counts match editors.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS cell budget for the quadratic middle diff; larger inputs fall back to block replace. */
const MAX_LCS_CELLS = 640_000;

/**
 * Line-level diff with common prefix/suffix trimming.
 * The middle section uses a classic LCS DP; very large middles degrade to a
 * single delete+insert block (Codex's TUI applies the same safety valve).
 */
export function diffLineOps(beforeRaw: string, afterRaw: string): DiffLineOp[] {
  const before = splitLines(beforeRaw);
  const after = splitLines(afterRaw);

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midBefore = before.slice(prefix, before.length - suffix);
  const midAfter = after.slice(prefix, after.length - suffix);
  const ops: DiffLineOp[] = [];

  const pushContext = (index: number, text: string) => {
    ops.push({ kind: 'context', text, beforeLine: index + 1, afterLine: index + 1 });
  };
  for (let i = 0; i < prefix; i += 1) pushContext(i, before[i]);

  if (midBefore.length * midAfter.length > MAX_LCS_CELLS) {
    midBefore.forEach((text, i) => ops.push({ kind: 'del', text, beforeLine: prefix + i + 1 }));
    midAfter.forEach((text, i) => ops.push({ kind: 'add', text, afterLine: prefix + i + 1 }));
  } else {
    // LCS over the middle section.
    const n = midBefore.length;
    const m = midAfter.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = midBefore[i] === midAfter[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midBefore[i] === midAfter[j]) {
        ops.push({
          kind: 'context',
          text: midBefore[i],
          beforeLine: prefix + i + 1,
          afterLine: prefix + j + 1,
        });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ kind: 'del', text: midBefore[i], beforeLine: prefix + i + 1 });
        i += 1;
      } else {
        ops.push({ kind: 'add', text: midAfter[j], afterLine: prefix + j + 1 });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ kind: 'del', text: midBefore[i], beforeLine: prefix + i + 1 });
      i += 1;
    }
    while (j < m) {
      ops.push({ kind: 'add', text: midAfter[j], afterLine: prefix + j + 1 });
      j += 1;
    }
  }

  const tailStart = before.length - suffix;
  const tailAfterStart = after.length - suffix;
  for (let k = 0; k < suffix; k += 1) {
    ops.push({
      kind: 'context',
      text: before[tailStart + k],
      beforeLine: tailStart + k + 1,
      afterLine: tailAfterStart + k + 1,
    });
  }
  return ops;
}

/**
 * Select which ops to display (Codex-style: changed budget + context runs),
 * returning render rows: diff lines plus '… N unchanged' fold rows.
 */
export function selectVisibleOps(ops: DiffLineOp[], options: Required<DiffRenderOptions>): DiffLineOp[] {
  const changedIndexes: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== 'context') changedIndexes.push(index);
  });
  if (changedIndexes.length === 0) return [];

  const shown = new Set<number>();
  const capped = changedIndexes.slice(0, options.maxChangedLines);
  const truncated = changedIndexes.length > options.maxChangedLines;
  if (truncated) {
    // Keep the first budget of changes; mark overflow via a trailing note row.
    for (const index of capped) {
      for (let k = index - options.contextLines; k <= index + options.contextLines; k += 1) {
        if (k >= 0 && k < ops.length) shown.add(k);
      }
    }
  } else {
    for (const index of changedIndexes) {
      for (let k = index - options.contextLines; k <= index + options.contextLines; k += 1) {
        if (k >= 0 && k < ops.length) shown.add(k);
      }
    }
  }

  const sorted = [...shown].sort((a, b) => a - b);
  const visible: DiffLineOp[] = [];
  let previous = -2;
  for (const index of sorted) {
    if (previous >= 0 && index > previous + 1) {
      const gap = index - previous - 1;
      visible.push({ kind: 'context', text: `\u2423${String(gap)} unchanged` });
    }
    visible.push(ops[index]);
    previous = index;
  }
  if (truncated) {
    visible.push({
      kind: 'context',
      text: `\u2423${String(changedIndexes.length - options.maxChangedLines)} more change(s) hidden`,
    });
  }
  return visible;
}

/**
 * Render an approval diff block for `{ path, originalContent, modifiedContent }`
 * the shape carried by ApprovalRequest.diff. Returns ANSI-styled lines joined
 * by \n (no trailing newline). Returns '' when there is nothing to show.
 */
export function renderApprovalDiff(
  diff: { path: string; originalContent: string; modifiedContent: string },
  options: DiffRenderOptions = {},
): string {
  const noColor = options.noColor ?? false;
  const maxChangedLines = options.maxChangedLines ?? 40;
  const contextLines = options.contextLines ?? 3;
  const ops = diffLineOps(diff.originalContent, diff.modifiedContent);
  const added = ops.filter((op) => op.kind === 'add').length;
  const removed = ops.filter((op) => op.kind === 'del').length;
  if (added === 0 && removed === 0) return '';

  const c = (name: keyof typeof palette) => (noColor ? '' : palette[name]);
  const bg = (code: string) => (noColor ? '' : code);

  // Summary chrome (upstream): dim "• " prefix, then "(+N -M)" with green/red
  // counts next to the bold path.
  const header = `${c('dim')}• ${c('reset')}${c('bold')}${c('cyan')}${diff.path}${c('reset')} ${c('dim')}(${c('reset')}${c('green')}+${added}${c('reset')} ${c('red')}-${removed}${c('reset')}${c('dim')})${c('reset')}`;
  const lines: string[] = [header];

  const visible = selectVisibleOps(ops, { noColor, maxChangedLines, contextLines });
  // Gutter width = digit count of the largest displayed line number, exactly
  // like upstream's `{ln_str:>gutter_width$} `.
  const numbersShown = visible.map((op) => op.beforeLine ?? op.afterLine ?? 0);
  const gutterWidth = Math.max(1, String(Math.max(...numbersShown, 1)).length);
  const gutter = (lineNumber: number | undefined) =>
    lineNumber === undefined ? ' '.repeat(gutterWidth) : String(lineNumber).padStart(gutterWidth);

  for (const op of visible) {
    const body = op.text ?? '';
    if (op.kind === 'add') {
      // Update-file convention (upstream): insert/context rows show the NEW file line number.
      const row = `${bg(ADD_BG)}${c('green')}${gutter(op.afterLine)} +${body}${c('reset')}`;
      lines.push(row);
    } else if (op.kind === 'del') {
      // Delete rows keep the OLD file line number.
      const row = `${bg(DEL_BG)}${c('red')}${gutter(op.beforeLine)} -${body}${c('reset')}`;
      lines.push(row);
    } else if (op.beforeLine === undefined) {
      // Fold marker between separated runs (upstream renders a dim "⋮" spacer;
      // we keep a count because the approval view folds for size).
      lines.push(`${c('dim')} ${' '.repeat(gutterWidth)} ⋮ ${body.replace('\u2423', '')} unchanged${c('reset')}`);
    } else {
      // Context rows show the new-file number with a blank sign column.
      lines.push(`${c('dim')}${gutter(op.afterLine)} ${c('reset')} ${body}`);
    }
  }
  return lines.join('\n');
}
