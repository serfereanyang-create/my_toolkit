/**
 * bm25.ts — Zero-dependency BM25 search over the nav symbol index.
 *
 * Improvements over the previous `scoreSymbol`:
 *  - camelCase / snake_case / kebab-case token splitting
 *    ("getUserById" → ["get","user","by","id"])
 *  - Multi-field scoring: name tokens (high weight) + signature tokens (medium)
 *    + file path tokens (low)
 *  - BM25 Okapi formula with corpus-level IDF
 *  - Fuzzy prefix fallback when no tokens intersect exactly
 *  - Kind / exported boosts preserved
 *
 * Build a BM25Index once from a NavIndexFile, then call `.search(query)`.
 */
import type { NavIndexFile, SymbolHit, SymbolKind, SymbolRecord } from './types.js';

// ─── Tokenisation ─────────────────────────────────────────────────────────────

const STOP = new Set([
  'a','an','the','is','in','on','at','of','or','and','for','to','be','it',
  'by','do','get','set','use','new','add','has','can','may','not',
]);

/** Split a camelCase / snake_case / kebab-case / dotted identifier into tokens. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    // split on non-alphanumeric boundaries
    .replace(/([a-z])([A-Z])/g, '$1 $2')       // camelCase
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ABCDef → ABC Def
    .replace(/[^a-zA-Z0-9]+/g, ' ')             // symbols / underscores
    .toLowerCase()
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t));
}

// ─── BM25 parameters ─────────────────────────────────────────────────────────

const K1 = 1.5;   // term frequency saturation
const B  = 0.75;  // length normalisation
const FIELD_WEIGHTS = { name: 3, signature: 1.5, path: 0.8 } as const;

type FieldKey = keyof typeof FIELD_WEIGHTS;

// ─── Document representation ─────────────────────────────────────────────────

type Doc = {
  symbol: SymbolRecord;
  filePath: string;
  /** tokenised fields */
  fields: Record<FieldKey, string[]>;
};

// ─── BM25 index ───────────────────────────────────────────────────────────────

export class BM25Index {
  private docs: Doc[] = [];
  /** df[term] = number of documents that contain the term */
  private df: Map<string, number> = new Map();
  private avgLen: Record<FieldKey, number> = { name: 0, signature: 0, path: 0 };

  constructor(index: NavIndexFile) {
    this.build(index);
  }

  private build(index: NavIndexFile) {
    this.docs = [];
    this.df   = new Map();

    for (const file of index.files) {
      const pathTokens = tokenize(file.path);
      for (const symbol of file.symbols) {
        const fields: Record<FieldKey, string[]> = {
          name:      tokenize(symbol.name),
          signature: tokenize(symbol.signature ?? ''),
          path:      pathTokens,
        };
        this.docs.push({ symbol, filePath: file.path, fields });
      }
    }

    // Compute average field lengths
    for (const field of Object.keys(FIELD_WEIGHTS) as FieldKey[]) {
      const total = this.docs.reduce((s, d) => s + d.fields[field].length, 0);
      this.avgLen[field] = this.docs.length > 0 ? total / this.docs.length : 1;
    }

    // Build document-frequency table (presence per doc, not count)
    for (const doc of this.docs) {
      const seen = new Set<string>();
      for (const field of Object.keys(FIELD_WEIGHTS) as FieldKey[]) {
        for (const tok of doc.fields[field]) {
          if (!seen.has(tok)) { seen.add(tok); this.df.set(tok, (this.df.get(tok) ?? 0) + 1); }
        }
      }
    }
  }

  search(
    query: string,
    options?: { kind?: SymbolKind; pathPrefix?: string; maxResults?: number },
  ): SymbolHit[] {
    const maxResults = options?.maxResults ?? 20;
    const qTokens    = tokenize(query);
    const N          = this.docs.length;

    if (N === 0 || qTokens.length === 0) return legacyFallback(query, N === 0 ? [] : this.docs.map((d) => d.symbol), options);

    // Pre-compute IDF for query tokens
    const idf = new Map<string, number>();
    for (const tok of qTokens) {
      const df = this.df.get(tok) ?? 0;
      // BM25 IDF (Robertson–Spärck Jones, with a floor to avoid negatives on common terms)
      idf.set(tok, Math.max(0.1, Math.log((N - df + 0.5) / (df + 0.5) + 1)));
    }

    const hits: SymbolHit[] = [];

    for (const doc of this.docs) {
      // Filters
      if (options?.kind && doc.symbol.kind !== options.kind) continue;
      if (options?.pathPrefix) {
        const norm = options.pathPrefix.replace(/\\/g, '/');
        if (!doc.filePath.replace(/\\/g, '/').startsWith(norm)) continue;
      }

      let score = 0;
      for (const tok of qTokens) {
        const termIdf = idf.get(tok) ?? 0;
        for (const field of Object.keys(FIELD_WEIGHTS) as FieldKey[]) {
          const fieldTokens = doc.fields[field];
          const tf          = fieldTokens.filter((t) => t === tok).length;
          if (tf === 0) continue;
          const fieldLen    = fieldTokens.length;
          const avgLen      = this.avgLen[field] || 1;
          const w           = FIELD_WEIGHTS[field];
          // BM25 term-frequency component
          const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (fieldLen / avgLen)));
          score += w * termIdf * tfNorm;
        }
      }

      // Prefix-match bonus (bridges gap when query is a partial word)
      for (const qTok of qTokens) {
        for (const nameTok of doc.fields.name) {
          if (nameTok !== qTok && nameTok.startsWith(qTok) && qTok.length >= 3) {
            score += 0.5;
          }
        }
      }

      // Symbol-quality boosts (preserved from original scorer)
      if (score > 0) {
        if (doc.symbol.exported) score += 0.3;
        if (doc.symbol.kind === 'function' || doc.symbol.kind === 'class') score += 0.2;
      }

      if (score > 0) hits.push({ ...doc.symbol, score });
    }

    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
    return hits.slice(0, maxResults);
  }
}

// ─── Backward-compat wrapper ─────────────────────────────────────────────────

/**
 * Drop-in replacement for the old `findSymbols`.
 * Uses BM25 when the query has recognisable tokens; falls back to the original
 * substring scorer for very short or single-char queries.
 */
export function findSymbolsBM25(
  index: NavIndexFile,
  query: string,
  options?: { kind?: SymbolKind; pathPrefix?: string; maxResults?: number },
): SymbolHit[] {
  const needle = query.trim();
  if (!needle) return [];

  const idx = new BM25Index(index);
  const results = idx.search(needle, options);

  // If BM25 found nothing (e.g. very short query), fall back to legacy substring
  if (results.length === 0) {
    const allSymbols = index.files.flatMap((f) => f.symbols);
    return legacyFallback(needle, allSymbols, options);
  }
  return results;
}

// Legacy substring scorer — kept as fallback for 1-2 char queries
function legacyFallback(
  query: string,
  symbols: SymbolRecord[],
  options?: { kind?: SymbolKind; maxResults?: number },
): SymbolHit[] {
  const lower = query.toLowerCase();
  const max   = options?.maxResults ?? 20;
  return symbols
    .filter((s) => !options?.kind || s.kind === options.kind)
    .map((s) => {
      const n = s.name.toLowerCase();
      let score = 0;
      if (n === lower) score = 100;
      else if (n.startsWith(lower)) score = 70;
      else if (n.includes(lower)) score = 40;
      if (score && s.exported) score += 10;
      if (score && (s.kind === 'function' || s.kind === 'class')) score += 5;
      return { ...s, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}
