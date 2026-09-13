/**
 * Iteration 5 — prompt template variables.
 *
 * Snippets and slash-command prompts support inline placeholders:
 *
 *   帮我把 {{module|登录模块}} 的 {{fn}} 函数加上错误处理。
 *
 * - `{{name}}`            — required variable, no fallback.
 * - `{{name|fallback}}`   — optional; `fallback` is offered as the default.
 * - `{{name|}}`           — explicitly optional with an empty default.
 * - Escaped braces: a backslash before `{{` renders the pair literally.
 *
 * `parseTemplate` extracts the unique variable list (first occurrence wins,
 * preserving order) plus the positions for the UI to highlight.
 * `expandTemplate` substitutes values; a required variable missing a value is
 * reported rather than silently dropped, so the form can keep focus on what
 * still needs input. Implemented as a plain character scanner (no regex
 * exec loops) — it runs on every keystroke in the composer.
 */

export type TemplateVariable = {
  name: string;
  /** Default offered to the user (null when the variable is required). */
  fallback: string | null;
  /** True when at least one occurrence supplies a fallback. */
  optional: boolean;
  /** Character offsets of every `{{...}}` occurrence, half-open [start,end). */
  occurrences: Array<{ start: number; end: number }>;
};

export type ParsedTemplate = {
  variables: TemplateVariable[];
  /** True when the source contains any placeholder. */
  hasPlaceholders: boolean;
};

function isNameStart(ch: string): boolean {
  const c = ch.charCodeAt(0);
  // ASCII letters, underscore, and CJK Unified Ideographs as name starts.
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (c >= 0x4e00 && c <= 0x9fff);
}

function isNameChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return isNameStart(ch) || (c >= 48 && c <= 57) || ch === '-' || ch === '.';
}

type PlaceholderHit = {
  start: number;
  end: number;
  name: string;
  /** null when no `|` section; '' means an explicit empty fallback. */
  fallback: string | null;
};

/**
 * Find every well-formed placeholder in `text`. A backslash immediately before
 * `{{` escapes the opening pair and is kept as a literal backslash.
 */
function findPlaceholders(text: string): PlaceholderHit[] {
  const hits: PlaceholderHit[] = [];
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf('{{', pos);
    if (open < 0) break;
    // Escaped opening: skip both braces (keeping the source backslash).
    if (open > 0 && text[open - 1] === '\\') { pos = open + 2; continue; }
    let i = open + 2;
    let nameStart = i;
    while (i < text.length && isNameChar(text[i])) i += 1;
    const name = text.slice(nameStart, i);
    // Reject: empty name, or name doesn't start with a letter/underscore/CJK.
    if (!name || !isNameStart(name[0])) { pos = open + 2; continue; }
    let fallback: string | null = null;
    if (text[i] === '|') {
      const closePipe = text.indexOf('}}', i + 1);
      if (closePipe < 0) { pos = open + 2; continue; }
      fallback = text.slice(i + 1, closePipe);
      i = closePipe + 2;
    } else if (text[i] === '}' && text[i + 1] === '}') {
      i += 2;
    } else {
      pos = open + 2;
      continue;
    }
    hits.push({ start: open, end: i, name, fallback });
    pos = i;
  }
  return hits;
}

export function parseTemplate(source: string): ParsedTemplate {
  const hits = findPlaceholders(source);
  const byName = new Map<string, TemplateVariable>();
  for (const hit of hits) {
    let entry = byName.get(hit.name);
    if (!entry) {
      entry = { name: hit.name, fallback: null, optional: false, occurrences: [] };
      byName.set(hit.name, entry);
    }
    if (hit.fallback !== null) {
      entry.optional = true;
      // Keep the FIRST non-empty fallback; an explicit '' still counts as "has
      // a declared default" when nothing else supplies text.
      if (entry.fallback === null || entry.fallback === '') entry.fallback = hit.fallback;
    }
    entry.occurrences.push({ start: hit.start, end: hit.end });
  }
  return { variables: [...byName.values()], hasPlaceholders: hits.length > 0 };
}

export type ExpandResult = {
  /** Expanded text; unresolved required vars keep their placeholder. */
  text: string;
  /** Variable names that were required and had no value supplied. */
  missing: string[];
} ;

/**
 * Substitute `values` into the template. Optional variables without a value
 * fall back to their declared default. Required variables without a value are
 * left in place and reported so the caller can prompt again.
 */
export function expandTemplate(source: string, values: Record<string, string>): ExpandResult {
  const hits = findPlaceholders(source);
  const missing: string[] = [];
  const parts: string[] = [];
  let cursor = 0;
  for (const hit of hits) {
    parts.push(source.slice(cursor, hit.start));
    const given = values[hit.name];
    if (typeof given === 'string' && given.length > 0) {
      parts.push(given);
    } else if (hit.fallback !== null) {
      parts.push(hit.fallback);
    } else {
      parts.push(source.slice(hit.start, hit.end)); // keep placeholder
      if (!missing.includes(hit.name)) missing.push(hit.name);
    }
    cursor = hit.end;
  }
  parts.push(source.slice(cursor));
  return { text: parts.join(''), missing };
}

/**
 * First placeholder position, for cursor placement after insertion: the UI
 * selects the first variable so the user can type over it immediately.
 */
export function firstPlaceholderRange(source: string): { start: number; end: number } | null {
  const first = findPlaceholders(source)[0];
  return first ? { start: first.start, end: first.end } : null;
}
