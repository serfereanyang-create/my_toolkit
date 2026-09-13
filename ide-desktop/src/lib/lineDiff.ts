/**
 * Iteration 8 — line-level diff engine (frontend, dependency-free).
 *
 * Computes the classic edit script between two texts: a minimal-ish sequence
 * of equal / insert / delete operations over lines. Strategy:
 *
 *  1. Trim the common prefix and suffix — real edits are local, and this
 *     collapses most real-world inputs to tiny cores before any DP runs.
 *  2. Run an LCS on the remaining cores using the O(N*D) Myers *linear space*
 *     fallback? No — simpler and fully adequate here: the Hirschberg-free DP
 *     with a cell budget. If the trimmed cores are <= MAX_DP_CELLS (4M cells,
 *     ~2000x2000 lines), an exact LCS DP runs in one pass.
 *  3. Beyond the budget, fall back to a patience-style anchor diff: unique
 *     matching lines act as anchors, and the gaps between anchors are
 *     classified wholesale as delete+insert. This keeps the UI responsive on
 *     whole-file rewrites where line identity is meaningless anyway.
 *
 * The result is grouped into hunks with configurable context lines, the same
 * shape the diff UI and the save-history comparison both consume.
 */

export type DiffOp = {
  kind: 'equal' | 'insert' | 'delete';
  /** 0-based line index in the old text (equal/delete rows). */
  oldLine?: number;
  /** 0-based line index in the new text (equal/insert rows). */
  newLine?: number;
  text: string;
};

export type DiffHunk = {
  /** 1-based first line in the old file this hunk covers. */
  oldStart: number;
  oldCount: number;
  /** 1-based first line in the new file this hunk covers. */
  newStart: number;
  newCount: number;
  ops: DiffOp[];
};

export type FileDiff = {
  ops: DiffOp[];
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the DP budget was exceeded and the anchor fallback ran. */
  approximated: boolean;
};

const MAX_DP_CELLS = 4_000_000; // ~2000 x 2000 line cores

/** Split text into lines; a trailing newline does not add an empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function buildOpList(oldLines: string[], newLines: string[]): { ops: DiffOp[]; approximated: boolean } {
  // 1. Common prefix / suffix trim.
  let prefix = 0;
  const maxPre = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPre && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuf = Math.min(oldLines.length, newLines.length) - prefix;
  while (
    suffix < maxSuf
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;

  const coreOld = oldLines.slice(prefix, oldLines.length - suffix);
  const coreNew = newLines.slice(prefix, newLines.length - suffix);
  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ kind: 'equal', oldLine: i, newLine: i, text: oldLines[i] });

  let approximated = false;
  const cellCount = (coreOld.length + 1) * (coreNew.length + 1);
  let coreOps: DiffOp[];
  if (cellCount <= MAX_DP_CELLS) {
    coreOps = lcsDiff(coreOld, coreNew, prefix);
  } else {
    approximated = true;
    coreOps = anchorDiff(coreOld, coreNew, prefix);
  }
  ops.push(...coreOps);

  for (let i = 0; i < suffix; i += 1) {
    const oldIdx = oldLines.length - suffix + i;
    const newIdx = newLines.length - suffix + i;
    ops.push({ kind: 'equal', oldLine: oldIdx, newLine: newIdx, text: oldLines[oldIdx] });
  }
  return { ops, approximated };
}

/** Exact LCS via row-by-row DP with a backtrack walk. */
function lcsDiff(a: string[], b: string[], offset: number): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] vs b[j..]; store as flat Int32Array.
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'equal', oldLine: offset + i, newLine: offset + j, text: a[i] });
      i += 1; j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ kind: 'delete', oldLine: offset + i, text: a[i] });
      i += 1;
    } else {
      out.push({ kind: 'insert', newLine: offset + j, text: b[j] });
      j += 1;
    }
  }
  while (i < n) { out.push({ kind: 'delete', oldLine: offset + i, text: a[i] }); i += 1; }
  while (j < m) { out.push({ kind: 'insert', newLine: offset + j, text: b[j] }); j += 1; }
  return out;
}

/**
 * Budget fallback: lines that occur exactly once in BOTH cores are anchors.
 * Between consecutive anchor pairs, everything is classified as delete+insert
 * (in original order), which mirrors how patience diff degrades to whole-block
 * changes. Equal anchor lines are emitted directly.
 */
function anchorDiff(a: string[], b: string[], offset: number): DiffOp[] {
  const countA = new Map<string, number>();
  for (const line of a) countA.set(line, (countA.get(line) ?? 0) + 1);
  const countB = new Map<string, number>();
  for (const line of b) countB.set(line, (countB.get(line) ?? 0) + 1);
  const unique = (line: string) => countA.get(line) === 1 && countB.get(line) === 1;

  const indexB = new Map<string, number>();
  for (let j = 0; j < b.length; j += 1) if (unique(b[j])) indexB.set(b[j], j);

  // Anchor pairs in increasing a-index order, filtered to increasing b-order.
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < a.length; i += 1) {
    const j = indexB.get(a[i]);
    if (j === undefined) continue;
    if (!pairs.length || pairs[pairs.length - 1][1] < j) pairs.push([i, j]);
  }

  const out: DiffOp[] = [];
  let ai = 0;
  let bj = 0;
  for (const [pa, pb] of pairs) {
    for (let k = ai; k < pa; k += 1) out.push({ kind: 'delete', oldLine: offset + k, text: a[k] });
    for (let k = bj; k < pb; k += 1) out.push({ kind: 'insert', newLine: offset + k, text: b[k] });
    out.push({ kind: 'equal', oldLine: offset + pa, newLine: offset + pb, text: a[pa] });
    ai = pa + 1;
    bj = pb + 1;
  }
  for (let k = ai; k < a.length; k += 1) out.push({ kind: 'delete', oldLine: offset + k, text: a[k] });
  for (let k = bj; k < b.length; k += 1) out.push({ kind: 'insert', newLine: offset + k, text: b[k] });
  return out;
}

/** Group an op list into display hunks carrying `context` equal lines around runs. */
export function groupHunks(ops: DiffOp[], context = 3): DiffHunk[] {
  const changed = ops.map((op) => op.kind !== 'equal');
  // Mark ranges worth showing: any op adjacent (within `context`) to a change.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i += 1) {
    if (!changed[i]) continue;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k += 1) keep[k] = true;
  }
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) { i += 1; continue; }
    let end = i;
    while (end + 1 < ops.length && keep[end + 1]) end += 1;
    const slice = ops.slice(i, end + 1);
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    for (const op of slice) {
      if (op.kind === 'equal') { oldCount += 1; newCount += 1; }
      else if (op.kind === 'delete') oldCount += 1;
      else newCount += 1;
    }
    const firstOld = slice.find((op) => op.oldLine !== undefined)?.oldLine ?? 0;
    const firstNew = slice.find((op) => op.newLine !== undefined)?.newLine ?? 0;
    oldStart = firstOld + 1;
    newStart = firstNew + 1;
    hunks.push({ oldStart, oldCount, newStart, newCount, ops: slice });
    i = end + 1;
  }
  return hunks;
}

/**
 * Full diff entry point.
 */
export function diffLines(oldText: string, newText: string, context = 3): FileDiff {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const { ops, approximated } = buildOpList(oldLines, newLines);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'insert') added += 1;
    else if (op.kind === 'delete') removed += 1;
  }
  return { ops, hunks: groupHunks(ops, context), added, removed, approximated };
}

/**
 * Word-level inline diff for a single changed line pair: tokenizes on
 * word/space boundaries and LCS-marks changed runs. Used to highlight *which
 * part* of a changed line actually moved.
 */
export function inlineWordDiff(oldLine: string, newLine: string): {
  oldParts: Array<{ text: string; changed: boolean }>;
  newParts: Array<{ text: string; changed: boolean }>;
} {
  const tokenize = (s: string): string[] => s.match(/\s+|[^\s]+/g) ?? [];
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  // Small DP again — a single line is tiny.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const aChanged = new Array<boolean>(a.length).fill(true);
  const bChanged = new Array<boolean>(b.length).fill(true);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { aChanged[i] = false; bChanged[j] = false; i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else j += 1;
  }
  return {
    oldParts: a.map((text, k) => ({ text, changed: aChanged[k] })),
    newParts: b.map((text, k) => ({ text, changed: bChanged[k] })),
  };
}

/** Render a unified-diff string (git style) — used by export + copy buttons. */
export function toUnifiedDiff(diff: FileDiff, oldName = 'a', newName = 'b'): string {
  const lines: string[] = [`--- ${oldName}`, `+++ ${newName}`];
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const op of hunk.ops) {
      const prefix = op.kind === 'equal' ? ' ' : op.kind === 'insert' ? '+' : '-';
      lines.push(prefix + op.text);
    }
  }
  return lines.join('\n');
}
