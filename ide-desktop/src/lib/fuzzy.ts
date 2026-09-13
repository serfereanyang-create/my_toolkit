/**
 * Iteration 2 — fuzzy matching for the command palette.
 *
 * Scoring model (higher is better):
 *  - Exact substring hit: strong bonus, scaled by position (prefix hits beat
 *    mid-string hits) and by case fidelity.
 *  - Fuzzy subsequence: every matched char adds a small score; consecutive
 *    runs get a growing streak bonus; matches at word boundaries (/ - _ .
 *    after lowercase->uppercase) get a camel/path bonus; a match at index 0
 *    or right after a separator is worth double.
 *  - Distance penalty: the span between first and last matched char dilutes
 *    the streak bonus so scattered matches rank below compact ones.
 *  - Length normalization: longer candidates are penalized logarithmically so
 *    "open settings" still outranks "open settings from the workspace
 *    configuration dialog" on an equal-quality prefix match.
 *
 * The result carries the matched indices so the UI can highlight them.
 */

export type FuzzyMatch = {
  /** Candidate index in the input list. */
  index: number;
  score: number;
  /** Matched character positions in the target string. */
  ranges: Array<[number, number]>;
};

const BOUNDARY_CHARS = /[/\\\-_.: ]/;

function isBoundary(text: string, idx: number): boolean {
  if (idx === 0) return true;
  if (BOUNDARY_CHARS.test(text[idx - 1])) return true;
  // camelCase / PascalCase boundary: lowercase|digit followed by uppercase.
  const prev = text[idx - 1];
  const cur = text[idx];
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(cur);
}

/** Collapse sorted index list into inclusive [start,end] ranges for marking. */
function toRanges(indices: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const i of indices) {
    const last = ranges[ranges.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else ranges.push([i, i]);
  }
  return ranges;
}

/**
 * Score a single candidate. Returns null when the query is not a subsequence.
 */
export function scoreFuzzy(query: string, target: string): { score: number; ranges: Array<[number, number]> } | null {
  const q = query.trim();
  if (!q) return { score: 0, ranges: [] };
  const ql = q.toLowerCase();
  const tl = target.toLowerCase();

  // Fast path: contiguous substring match dominates.
  const sub = tl.indexOf(ql);
  if (sub >= 0) {
    const prefixBonus = sub === 0 ? 1000 : 600 - Math.min(sub * 2, 300);
    // Case fidelity: how many matched chars were exactly cased.
    let exact = 0;
    for (let i = 0; i < ql.length; i += 1) if (target[sub + i] === q[i]) exact += 1;
    const caseBonus = (exact / ql.length) * 80;
    const lenPenalty = Math.log2(Math.max(2, target.length)) * 6;
    return {
      score: 1200 + prefixBonus + caseBonus + ql.length * 10 - lenPenalty,
      ranges: toRanges(Array.from({ length: ql.length }, (_, i) => sub + i)),
    };
  }

  // Subsequence walk with greedy best-boundary preference: for each query
  // char, take the earliest match, but peek ahead — if a later match at a
  // word boundary is available within the same word, prefer it.
  const indices: number[] = [];
  let cursor = -1;
  for (let qi = 0; qi < ql.length; qi += 1) {
    const ch = ql[qi];
    let found = -1;
    for (let i = cursor + 1; i < tl.length; i += 1) {
      if (tl[i] === ch) { found = i; break; }
    }
    if (found < 0) return null; // not a subsequence
    indices.push(found);
    cursor = found;
  }

  let score = ql.length * 8; // base: matched everything
  let streak = 0;
  for (let k = 0; k < indices.length; k += 1) {
    const idx = indices[k];
    const boundary = isBoundary(target, idx);
    score += boundary ? 24 : 4;
    if (k > 0 && indices[k - 1] === idx - 1) {
      streak += 1;
      score += Math.min(streak * 6, 40); // consecutive-run bonus, capped
    } else {
      streak = 0;
    }
    if (target[idx] === q[k]) score += 3; // exact case
  }
  const span = indices[indices.length - 1] - indices[0] + 1;
  const density = indices.length / span; // 1 == fully contiguous
  score = score * (0.55 + 0.45 * density);
  const lenPenalty = Math.log2(Math.max(2, target.length)) * 6;
  const startPenalty = Math.min(indices[0] * 1.5, 120);
  return { score: score - lenPenalty - startPenalty, ranges: toRanges(indices) };
}

/**
 * Rank a list of strings against a query. O(n * m) with small m; fine for
 * command lists (dozens) and file pickers (thousands stay under a few ms).
 */
export function fuzzyRank(query: string, targets: string[]): FuzzyMatch[] {
  const out: FuzzyMatch[] = [];
  if (!query.trim()) {
    return targets.map((_, index) => ({ index, score: 0, ranges: [] }));
  }
  for (let i = 0; i < targets.length; i += 1) {
    const hit = scoreFuzzy(query, targets[i]);
    if (hit) out.push({ index: i, score: hit.score, ranges: hit.ranges });
  }
  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return out;
}

export type WeightedItem<T> = {
  item: T;
  /** The string the query is matched against. */
  key: string;
  /** Optional searchable keywords merged into scoring as a second field. */
  keywords?: string;
  /** Static prior (recency, usage count) multiplied into the final score. */
  prior?: number;
};

/**
 * Rank structured items. Keywords give a secondary match field so "关闭标签"
 * can still find the command whose title is "Close Editor" when the user
 * types in Chinese and the keyword list holds both languages.
 */
export function fuzzyRankItems<T>(query: string, items: WeightedItem<T>[]): Array<{ item: T; score: number; ranges: Array<[number, number]> }> {
  const out: Array<{ item: T; score: number; ranges: Array<[number, number]> }> = [];
  const trimmed = query.trim();
  for (const entry of items) {
    if (!trimmed) {
      out.push({ item: entry.item, score: entry.prior ?? 0, ranges: [] });
      continue;
    }
    const primary = scoreFuzzy(trimmed, entry.key);
    if (primary) {
      out.push({
        item: entry.item,
        score: primary.score * (entry.prior ?? 1),
        ranges: primary.ranges,
      });
      continue;
    }
    if (entry.keywords) {
      const secondary = scoreFuzzy(trimmed, entry.keywords);
      if (secondary) {
        out.push({
          item: entry.item,
          score: secondary.score * 0.6 * (entry.prior ?? 1),
          ranges: [],
        });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Split a target into alternating plain/marked fragments for rendering,
 * based on match ranges. Used by the palette rows to <mark> hits.
 */
export function highlightRanges(text: string, ranges: Array<[number, number]>): Array<{ text: string; hit: boolean }> {
  if (!ranges.length) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start > pos) parts.push({ text: text.slice(pos, start), hit: false });
    parts.push({ text: text.slice(start, end + 1), hit: true });
    pos = end + 1;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), hit: false });
  return parts;
}
