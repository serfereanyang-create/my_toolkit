import type { ProjectMemoryEntry } from './types.js';

/**
 * How a memory summary and an incoming goal are cut into comparable tokens.
 *
 * Latin text splits on punctuation and keeps words of two or more characters.
 * Chinese has no spaces, so splitting the same way leaves a whole sentence as
 * one "word": "数据库连接池默认 5 个连接" became a single token, matched only by
 * an identical sentence, and a memory written in Chinese silently never
 * surfaced for its own topic. CJK runs are therefore cut into overlapping
 * character bigrams ("数据库" -> 数据, 据库), which is what makes 连接池 match
 * 连接池要调多大 without a dictionary.
 */

/** Latin words too common to mean anything: without this, every English goal matches every entry. */
const LATIN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from', 'into', 'about', 'over', 'under',
  'are', 'was', 'were', 'been', 'being', 'his', 'her', 'its', 'their', 'our', 'you', 'your', 'not',
  'but', 'all', 'any', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'have', 'has', 'had', 'does', 'did', 'doing', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
  'there', 'here', 'then', 'than', 'them', 'they', 'she', 'him', 'too', 'very', 'just', 'also', 'only',
  // Two-letter function words matter most: they are short enough to survive the
  // length filter, and one of them ("to", "of", "is") matches nearly every entry.
  'of', 'to', 'is', 'as', 'at', 'by', 'be', 'or', 'an', 'on', 'in', 'so', 'if', 'no', 'it', 'we', 'us',
  'my', 'me', 'he', 'do', 'up', 'off', 'out', 'per', 'via', 'vs', 'ok',
]);

const HAS_CJK = /[㐀-䶿一-鿿豈-﫿]/;

/** Tokens to compare memories and goals by. Order is preserved; duplicates removed. */
export function memoryTokens(value: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  for (const run of value.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!run) continue;
    if (!HAS_CJK.test(run)) {
      if (run.length >= 2 && !LATIN_STOPWORDS.has(run)) push(run);
      continue;
    }
    for (const chunk of splitCjkRuns(run)) {
      if (chunk.ascii) {
        if (chunk.text.length >= 2 && !LATIN_STOPWORDS.has(chunk.text)) push(chunk.text);
        continue;
      }
      const text = chunk.text;
      if (text.length < 2) continue;
      push(text);
      for (let i = 0; i + 1 < text.length; i += 1) push(text.slice(i, i + 2));
    }
  }
  return tokens;
}

/** Split a mixed run into ASCII and CJK pieces, so "sql数据库" yields both. */
function splitCjkRuns(run: string) {
  const chunks: Array<{ text: string; ascii: boolean }> = [];
  let current = '';
  let ascii = !HAS_CJK.test(run[0] ?? '');
  for (const char of run) {
    const isAscii = !HAS_CJK.test(char);
    if (isAscii === ascii) {
      current += char;
      continue;
    }
    if (current) chunks.push({ text: current, ascii });
    current = char;
    ascii = isAscii;
  }
  if (current) chunks.push({ text: current, ascii });
  return chunks;
}

export type RankedMemory = { entry: ProjectMemoryEntry; score: number; hits: number };

const KIND_WEIGHT: Record<ProjectMemoryEntry['kind'], number> = {
  convention: 3,
  decision: 3,
  pitfall: 2,
  note: 1,
};

/**
 * Score active entries against a goal. A keyword hit counts for more than a
 * word appearing in the summary, and a recent entry gets a small boost so two
 * equally relevant notes resolve to the one the user touched last.
 */
export function rankMemories(entries: ProjectMemoryEntry[], goal: string, now = Date.now()): RankedMemory[] {
  const queryTokens = new Set(memoryTokens(goal));
  return entries
    .filter((entry) => entry.active)
    .map((entry) => {
      const summaryTokens = new Set(memoryTokens(entry.summary));
      const keywordHits = entry.keywords.reduce((count, keyword) => count + (queryTokens.has(keyword) ? 1 : 0), 0);
      const summaryHits = [...queryTokens].reduce((count, token) => count + (summaryTokens.has(token) ? 1 : 0), 0);
      const score = keywordHits * 5 + summaryHits * 2 + KIND_WEIGHT[entry.kind] + recencyBoost(entry.updatedAt, now);
      return { entry, score, hits: keywordHits + summaryHits };
    });
}

function recencyBoost(updatedAt: string, now: number) {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (now - ts) / 86_400_000);
  return Math.max(0, 2 - ageDays / 30);
}
