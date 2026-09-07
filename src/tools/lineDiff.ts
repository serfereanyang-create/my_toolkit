/**
 * Real line-level diff counting for file writes.
 *
 * Computes how many lines were added and removed between two versions of a
 * file using a line-based longest-common-subsequence (LCS). This backs the
 * desktop "更改 +N −M" turn summary, so the numbers must be genuine — no
 * estimation or char-length heuristics.
 */
export type LineDiff = { added: number; removed: number };

function splitLines(text: string): string[] {
  if (text === '') return [];
  // Normalise CRLF so a line-ending style change alone is not counted as an
  // edit. Trailing newline does not create a spurious empty final line.
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalised.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Count added/removed lines between `before` and `after`.
 *
 * A pure insertion (no prior content) counts every new line as added; a full
 * deletion counts every old line as removed. Unchanged lines that appear in
 * both, in order, are matched via LCS and cost nothing.
 */
export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  if (n === 0) return { added: m, removed: 0 };
  if (m === 0) return { added: 0, removed: n };

  // Classic LCS length table over lines. n and m are file line counts, so an
  // O(n*m) table is fine for realistic edits; extreme files degrade
  // gracefully rather than crash.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { added: m - common, removed: n - common };
}
