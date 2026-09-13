/**
 * Iteration 12 — Markdown outline extraction.
 *
 * Pulls the heading tree out of a Markdown document, the way an editor's
 * "Table of Contents" panel does. Correctness notes that drive the scanner
 * (implemented with plain character scanning — no regex state machines):
 *
 *  - Fenced code blocks (``` or ~~~) can contain `#` lines that are NOT
 *    headings; the fence state machine skips them.
 *  - ATX headings are `#..######` + space (or bare `#`) at line start.
 *  - Setext headings (`Title` + `===` / `---` underlines) are recognized.
 *  - A trailing-closed ATX heading (`# Title #`) drops the closing run.
 *  - Anchor ids follow the GitHub slug algorithm: lowercase, punctuation
 *    dropped, spaces -> hyphen, duplicates get `-1`, `-2` suffixes.
 *
 * `filterOutline` prunes the tree for the sidebar search box; `walkOutline`
 * flattens it in document order for the jump picker.
 */

export type OutlineEntry = {
  level: number;      // 1..6
  text: string;       // cleaned heading text (inline markup stripped for display)
  line: number;       // 1-based source line of the heading
  id: string;         // anchor id (slug)
  children: OutlineEntry[];
};

export type Outline = {
  entries: OutlineEntry[];      // top-level roots
  total: number;                // every heading, nested or not
  deepest: number;
};

/** Count leading repeats of `ch` starting at offset; returns the count. */
function countCharRun(text: string, start: number, ch: string): number {
  let n = 0;
  while (start + n < text.length && text[start + n] === ch) n += 1;
  return n;
}

/** Index after leading whitespace, or text.length when the line is blank. */
function firstNonSpace(text: string): number {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  return i;
}

function isBlank(text: string): boolean {
  return firstNonSpace(text) >= text.length;
}

/** A fence line: >=3 identical ` or ~ after optional <=3 spaces of indent. */
function fenceToken(line: string): string | null {
  const i = firstNonSpace(line);
  if (i > 3 || i >= line.length) return null;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  const run = countCharRun(line, i, ch);
  return run >= 3 ? ch.repeat(run) : null;
}

/** An ATX heading line -> { level, rest }; null when it isn't one. */
function atxHeading(line: string): { level: number; rest: string } | null {
  const i = firstNonSpace(line);
  if (i > 3 || i >= line.length || line[i] !== '#') return null;
  const level = countCharRun(line, i, '#');
  if (level > 6) return null;
  const after = i + level;
  // `#foo` (no space) is not a heading; `#` alone is an empty heading.
  if (after < line.length && line[after] !== ' ' && line[after] !== '\t') return null;
  return { level, rest: line.slice(after).trim() };
}

/** True when `line` is only = characters (setext H1 underline). */
function isSetextEq(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return [...t].every((ch) => ch === '=');
}

/** True when `line` is only - characters (setext H2 underline). */
function isSetextDash(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return [...t].every((ch) => ch === '-');
}

/** GitHub-flavored heading slug (codepoint-iterative, no regex). */
export function slugifyHeading(text: string): string {
  const out: string[] = [];
  let lastWasSpace = false;
  for (const ch of text.toLowerCase()) {
    if (ch === ' ' || ch === '\t') {
      if (!lastWasSpace && out.length) out.push('-');
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    // Keep letters (any script incl. CJK), digits, and hyphens/underscores;
    // drop punctuation and symbols.
    if (ch === '-' || ch === '_') { out.push(ch); continue; }
    if (ch >= '0' && ch <= '9') { out.push(ch); continue; }
    if (ch >= 'a' && ch <= 'z') { out.push(ch); continue; }
    const code = ch.codePointAt(0) ?? 0;
    // CJK ideographs + kana + hangul + accented Latin keep their char.
    if (code > 0x7f && /[^\p{P}\p{S}]/u.test(ch)) out.push(ch);
  }
  let slug = out.join('').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug;
}

/** Strip inline markdown from heading text for the outline display. */
function plainHeadingText(raw: string): string {
  let text = raw;
  // Closing ATX hashes: strip a trailing run of # that is space-separated.
  text = text.replace(/\s+#+\s*$/, '');
  // Images / links -> label; code spans -> inner; emphasis wrappers -> inner.
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  return text.trim();
}

/**
 * Extract the outline. Line numbers are 1-based against the original text.
 */
export function extractOutline(markdown: string): Outline {
  const lines = markdown.split(/\r?\n/);
  const flat: Array<{ level: number; text: string; line: number; id: string }> = [];
  const usedSlugs = new Map<string, number>();

  let fenceMarker: string | null = null;
  let pendingSetext = '';      // text line that may get an underline next
  let pendingSetextLine = 0;

  function pushHeading(level: number, raw: string, lineNo: number) {
    const display = plainHeadingText(raw);
    const base = slugifyHeading(display) || `heading-${lineNo}`;
    const seen = usedSlugs.get(base) ?? 0;
    usedSlugs.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen}`;
    flat.push({ level, text: display, line: lineNo, id });
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = fenceToken(line);
    if (fence) {
      const ch = fence[0];
      if (!fenceMarker) {
        fenceMarker = fence;
      } else if (ch === fenceMarker[0] && fence.length >= fenceMarker.length) {
        fenceMarker = null;
      }
      pendingSetext = '';
      continue;
    }
    if (fenceMarker) { pendingSetext = ''; continue; }

    const atx = atxHeading(line);
    if (atx) {
      if (atx.rest) pushHeading(atx.level, atx.rest, i + 1);
      pendingSetext = '';
      continue;
    }

    // Is THIS line a setext underline for the previous text line?
    if (pendingSetext && (isSetextEq(line) || isSetextDash(line))) {
      pushHeading(isSetextEq(line) ? 1 : 2, pendingSetext, pendingSetextLine);
      pendingSetext = '';
      continue;
    }
    if (isBlank(line)) { pendingSetext = ''; continue; }
    // Lines that are themselves thematic breaks, bullets, or quotes can't
    // serve as setext heading text.
    const t = line.trim();
    const isThematic = [...t].every((ch) => ch === '-') || [...t].every((ch) => ch === '=');
    const isListItem = /^([-*+]|\d+[.)])\s/.test(t) || t === '-' || t.startsWith('>') || t.startsWith('```');
    pendingSetext = isThematic || isListItem ? '' : t;
    pendingSetextLine = i + 1;
  }

  // Nest the flat list by level with a small stack.
  const roots: OutlineEntry[] = [];
  const stack: Array<OutlineEntry & { rawLevel: number }> = [];
  let deepest = 0;
  for (const h of flat) {
    deepest = Math.max(deepest, h.level);
    const entry: OutlineEntry & { rawLevel: number } = { level: h.level, text: h.text, line: h.line, id: h.id, children: [], rawLevel: h.level };
    while (stack.length && stack[stack.length - 1].rawLevel >= h.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(entry);
    else roots.push(entry);
    stack.push(entry);
  }
  return { entries: roots, total: flat.length, deepest };
}

/** Prune an outline to entries whose text matches `needle` (case-insensitive),
 *  keeping ancestors of matches. */
export function filterOutline(outline: Outline, needle: string): Outline {
  const q = needle.trim().toLowerCase();
  if (!q) return outline;
  const walk = (list: OutlineEntry[]): OutlineEntry[] => {
    const kept: OutlineEntry[] = [];
    for (const entry of list) {
      const children = walk(entry.children);
      if (entry.text.toLowerCase().includes(q) || children.length) {
        kept.push({ ...entry, children });
      }
    }
    return kept;
  };
  const entries = walk(outline.entries);
  const count = (list: OutlineEntry[]): number => list.reduce((sum, e) => sum + 1 + count(e.children), 0);
  return { entries, total: count(entries), deepest: outline.deepest };
}

/** Flatten depth-first (document order) — used by the jump-to-line picker. */
export function walkOutline(outline: Outline): Array<OutlineEntry & { depth: number }> {
  const out: Array<OutlineEntry & { depth: number }> = [];
  const visit = (list: OutlineEntry[], depth: number) => {
    for (const entry of list) {
      out.push({ ...entry, depth });
      visit(entry.children, depth + 1);
    }
  };
  visit(outline.entries, 0);
  return out;
}
