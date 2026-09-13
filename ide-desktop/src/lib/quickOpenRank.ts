/**
 * Pure ranking helpers for the Ctrl+P quick-open palette (iteration 17).
 * Lives outside the component so vitest can exercise it without a DOM.
 */
import { fuzzyRankItems, type WeightedItem } from './fuzzy';

export type QuickOpenFileInput = { path: string; mtimeMs: number };

export type RankedQuickFile = {
  file: QuickOpenFileInput;
  /** Match ranges into the full relative path, empty for the no-query case. */
  ranges: Array<[number, number]>;
};

/** Half-life, in ms, of the recency prior used when ranking with a query. */
export const QOPEN_RECENCY_HALFLIFE_MS = 7 * 24 * 3600 * 1000;

/**
 * Split a relative path into directory + name parts for two-line rendering.
 * Backslashes are normalised first. "src/App.tsx" -> { dir:"src", name:"App.tsx" }.
 */
export function splitQuickPath(rel: string): { dir: string; name: string } {
  const norm = rel.replace(/\\/g, '/');
  const cut = norm.lastIndexOf('/');
  if (cut < 0) return { dir: '', name: norm };
  return { dir: norm.slice(0, cut), name: norm.slice(cut + 1) };
}

/**
 * Rank index entries for a query.
 * - Empty query: pure recency order (most recently saved first).
 * - With a query: fuzzy subsequence scoring over the full path, with a small
 *   exponential recency prior so equal-quality matches favour fresh files.
 */
export function rankQuickFiles(
  files: QuickOpenFileInput[],
  query: string,
  now: number,
  limit = 50,
): RankedQuickFile[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [...files]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((file) => ({ file, ranges: [] }));
  }
  const weighted: WeightedItem<QuickOpenFileInput>[] = files.map((file) => ({
    item: file,
    key: file.path,
    prior: Math.pow(0.5, Math.max(0, now - file.mtimeMs) / QOPEN_RECENCY_HALFLIFE_MS),
  }));
  return fuzzyRankItems(trimmed, weighted)
    .slice(0, limit)
    .map((row) => ({ file: row.item, ranges: row.ranges }));
}

/**
 * Shift full-path match ranges into file-name coordinates for highlighting.
 * Ranges that start inside the directory segment are dropped.
 */
export function nameRanges(path: string, ranges: Array<[number, number]>): Array<[number, number]> {
  const { name } = splitQuickPath(path);
  const nameStart = path.length - name.length;
  return ranges
    .filter(([a]) => a >= nameStart)
    .map(([a, b]) => [a - nameStart, b - nameStart] as [number, number]);
}
