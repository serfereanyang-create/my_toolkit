/**
 * Iteration 1 — CJK-aware token estimation.
 *
 * The API only reports real token counts at turn end, so everything that has
 * to reason about size *while the user types* (composer budget, context
 * warnings, attachment trimming) needs a local estimator. The rules below
 * mirror how modern BPE tokenizers actually behave on mixed text:
 *
 *  - CJK ideographs / kana / hangul / fullwidth forms tokenize at roughly
 *    1 token per character (each glyph carries a full morpheme).
 *  - Latin text tokenizes at roughly 1 token per 4 characters, but word
 *    boundaries cost an extra merge token on average, so we count words at
 *    len/3.5 and floor them.
 *  - Digit runs are split into groups of 3 (BPEs cut numbers thousands-wise).
 *  - URLs, paths and long identifier runs are denser than prose: chars/3.
 *
 * `estimateTokens` returns an integer. The function is pure and allocation
 * light so the composer can call it on every keystroke.
 */

const CJK_RANGES = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯＀-￯]/;

/** Characters per token for a Latin-ish prose run (BPE average). */
const LATIN_CHARS_PER_TOKEN = 3.5;
/** Characters per token for URLs / paths / identifiers. */
const DENSE_CHARS_PER_TOKEN = 3;
/** A digit run contributes a token per this many digits. */
const DIGITS_PER_TOKEN = 3;

export type TokenSegment = {
  /** Which estimator class claimed this span. */
  kind: 'cjk' | 'latin' | 'digit' | 'dense' | 'symbol';
  /** Token count contributed by the span. */
  tokens: number;
  /** Character span, inclusive start, exclusive end. */
  start: number;
  end: number;
};

function isCjk(ch: string): boolean {
  return CJK_RANGES.test(ch);
}

/**
 * True when the run looks like a URL, absolute/relative path, or a long
 * camel/snake identifier — cases where BPE merges are shorter than prose.
 */
function isDenseRun(run: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(run)) return true;          // scheme://
  if (/^https?:\/\//i.test(run)) return true;
  if (/^\.{0,2}\//.test(run) || /^[A-Za-z]:[\\/]/.test(run)) return true; // paths
  if (run.length >= 12 && /[_.\\/]|(?<=[a-z])(?=[A-Z])/.test(run)) return true; // identifiers
  return false;
}

/**
 * Split text into contiguous class runs so each run can use the right
 * chars-per-token ratio. Exposed for tests and for the budget UI, which
 * shows a per-kind breakdown tooltip.
 */
export function tokenizeRuns(text: string): TokenSegment[] {
  const segments: TokenSegment[] = [];
  if (!text) return segments;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (isCjk(ch)) {
      const start = i;
      while (i < text.length && isCjk(text[i])) i += 1;
      segments.push({ kind: 'cjk', tokens: i - start, start, end: i });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < text.length && /[0-9.,:_-]/.test(text[i])) i += 1;
      const digits = text.slice(start, i).replace(/[^0-9]/g, '').length;
      segments.push({ kind: 'digit', tokens: Math.max(1, Math.ceil(digits / DIGITS_PER_TOKEN)), start, end: i });
      continue;
    }
    // Word run: letters plus common intra-word characters.
    const start = i;
    while (i < text.length && !/\s/.test(text[i]) && !isCjk(text[i])) i += 1;
    const run = text.slice(start, i);
    if (/^[^\w]+$/.test(run)) {
      // Pure punctuation (brackets, operators, quotes): 1 token each pair-ish.
      segments.push({ kind: 'symbol', tokens: Math.max(1, Math.ceil(run.length / 2)), start, end: i });
    } else if (isDenseRun(run)) {
      segments.push({ kind: 'dense', tokens: Math.max(1, Math.ceil(run.length / DENSE_CHARS_PER_TOKEN)), start, end: i });
    } else {
      segments.push({ kind: 'latin', tokens: Math.max(1, Math.ceil(run.length / LATIN_CHARS_PER_TOKEN)), start, end: i });
    }
  }
  return segments;
}

/**
 * Estimate the BPE token count of an arbitrary string. Never undercounts an
 * empty string below 0 and handles code-heavy input reasonably.
 */
export function estimateTokens(text: string): number {
  let total = 0;
  for (const seg of tokenizeRuns(text)) total += seg.tokens;
  return total;
}

/** Breakdown by estimator class — used by the composer budget tooltip. */
export function tokenBreakdown(text: string): Record<TokenSegment['kind'], number> {
  const acc: Record<TokenSegment['kind'], number> = { cjk: 0, latin: 0, digit: 0, dense: 0, symbol: 0 };
  for (const seg of tokenizeRuns(text)) acc[seg.kind] += seg.tokens;
  return acc;
}

export type ContextBudget = {
  /** Tokens available after reserving the reply window. */
  usable: number;
  /** How many tokens the current draft consumes. */
  used: number;
  /** 0..1 fraction of the usable budget consumed. */
  ratio: number;
  /** 'ok' < 60%, 'warn' < 85%, 'critical' beyond that. */
  level: 'ok' | 'warn' | 'critical';
};

/**
 * Compute the effective context budget for a provider model. The reply window
 * is reserved at min(4096, 25% of the context) — matching what the CLI asks
 * providers for by default — so the composer can warn *before* sending.
 */
export function contextBudget(draftTokens: number, contextWindow: number | null | undefined): ContextBudget {
  const win = contextWindow && contextWindow > 0 ? contextWindow : 128_000;
  const replyReserve = Math.min(4096, Math.floor(win * 0.25));
  const usable = Math.max(1, win - replyReserve);
  const used = draftTokens;
  const ratio = used / usable;
  const level: ContextBudget['level'] = ratio >= 0.85 ? 'critical' : ratio >= 0.6 ? 'warn' : 'ok';
  return { usable, used, ratio, level };
}

/**
 * Trim a list of message texts so their combined estimate fits a budget,
 * dropping oldest first but always keeping the newest message and any pinned
 * ones. Returns the kept indices. Used by the export and side-chat paths.
 */
export function fitToBudget(texts: string[], budgetTokens: number, pinned: Set<number> = new Set()): number[] {
  const tokens = texts.map(estimateTokens);
  let total = tokens.reduce((a, b) => a + b, 0);
  const keep = texts.map((_, idx) => true);
  // Walk oldest-first; never drop pinned or the newest message.
  for (let idx = 0; idx < texts.length && total > budgetTokens; idx += 1) {
    if (idx === texts.length - 1 || pinned.has(idx)) continue;
    if (!keep[idx]) continue;
    keep[idx] = false;
    total -= tokens[idx];
  }
  const kept: number[] = [];
  for (let idx = 0; idx < texts.length; idx += 1) if (keep[idx]) kept.push(idx);
  return kept;
}
