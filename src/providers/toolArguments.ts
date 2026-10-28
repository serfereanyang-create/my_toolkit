/**
 * Tool-call argument parsing, shared by every provider.
 *
 * Models that are not strict JSON emitters send what we call quasi-JSON: the
 * structure is right, the string values are bare. A real capture:
 *
 *   {"path": "desktop/CAD.pptx", "title": 计算机辅助设计（CAD）概述}
 *
 * `JSON.parse` rejects that on the unquoted Chinese value, and the old fallback
 * in all four providers was `return { raw: value }`. Nothing downstream ever
 * reads a `raw` key, so the tool received an object with no expected field and
 * answered "path is required" — an error that says nothing about the actual
 * mistake, so the model could not correct it and retried the same shape. In the
 * captured ledger that was 102 calls, 53 of which hard-failed.
 *
 * So: repair before giving up. The repair only turns things JSON already cannot
 * parse into the shape the model obviously meant, and it is deliberately
 * conservative — anything it cannot make sense of still yields `{ raw: value }`
 * so the registry can report it verbatim.
 */
export type ToolArgumentParse =
  | { ok: true; input: unknown; repaired: boolean }
  | { ok: false; input: { raw: string }; error: string };

/** Strip a ```json fence and any prose around the outermost object. */
function isolateObject(text: string): string | null {
  let body = text.trim();
  const fence = body.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{');
  if (start < 0) return null;
  // Walk to the brace that closes the first object, ignoring braces in strings.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  return null;
}

const WHITESPACE = /\s/;
const IDENTIFIER_CHAR = /[\w$一-龥-]/;

/** Case-insensitive spellings that mean a JSON literal, with the spelling to
 *  emit. `none` is Python's null. */
const CONSTANTS: ReadonlyArray<readonly [string, string]> = [
  ['true', 'true'],
  ['false', 'false'],
  ['null', 'null'],
  ['none', 'null'],
];

/** Deeper than any real tool call, shallow enough never to overflow the stack.
 *  A payload nested thousands of levels arrives from a broken model, and the
 *  walk used to throw RangeError out of `parseToolArguments` — a function whose
 *  contract is to return a union, not to throw. */
const MAX_DEPTH = 64;

/**
 * Recursive descent over the quasi-JSON, re-emitting strict JSON.
 *
 * The earlier version was a single left-to-right pass that decided "the model
 * meant a string here" from one character of lookahead. That test is wrong in
 * both directions: `npm test` starts with `n` so it was read as `null`, and
 * `todo later` with `t` as `true` — both then failed to parse and fell back to
 * `{ raw }`. Bare values inside arrays (`{"paths": [a.ts, b.ts]}`) were never
 * looked at at all, because only the text after a `:` was examined. Walking the
 * structure instead of the characters means every value position is handled the
 * same way, wherever it appears.
 *
 * Anything it cannot follow aborts the whole repair: a half-rewritten payload
 * must never reach a tool.
 */
class QuasiJsonRepairer {
  private index = 0;
  private depth = 0;
  /** Set once the walk hits MAX_DEPTH, so the array fallback can tell "this is a
   *  character class" from "this is unparseable nesting". */
  private tooDeep = false;

  constructor(private readonly text: string) {}

  repair(): string | null {
    const repaired = this.value();
    if (repaired === null) return null;
    this.skipWhitespace();
    return this.index === this.text.length ? repaired : null;
  }

  private peek(): string | undefined {
    return this.text[this.index];
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && WHITESPACE.test(this.text[this.index])) this.index += 1;
  }

  private string(): string | null {
    if (this.peek() !== '"') return null;
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      this.index += 1;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') return this.text.slice(start, this.index);
    }
    return null;
  }

  /** true / false / null — but only when the word ends there.
   *
   *  Models that were trained on Python spell these `True` / `False` / `None`,
   *  and the case matters: the first version only recognised the lowercase
   *  JSON spelling, so `{"caseSensitive": True}` fell through to the bare-string
   *  path and the tool received the *string* `"True"`. A tool checking
   *  `input.caseSensitive === true` then silently did the opposite of what was
   *  asked — and unlike the old `{ raw }` failure, nothing errored, so the model
   *  never got a chance to correct it. `None` maps to null for the same reason.
   *
   *  A word that merely starts with those letters (`todo later`, `nothing`,
   *  `trueish`) is still a string. */
  private constant(): string | null {
    for (const [word, literal] of CONSTANTS) {
      if (this.text.slice(this.index, this.index + word.length).toLowerCase() !== word) continue;
      const end = this.index + word.length;
      const after = this.text[end];
      if (after !== undefined && IDENTIFIER_CHAR.test(after)) continue;
      let probe = end;
      while (probe < this.text.length && WHITESPACE.test(this.text[probe])) probe += 1;
      const following = this.text[probe];
      if (following !== undefined && following !== ',' && following !== '}' && following !== ']') continue;
      this.index = end;
      return literal;
    }
    return null;
  }

  /** Returns null for anything that is not a JSON number, restoring the cursor
   *  so dates like 2024-01-01 fall through to the bare-string path. */
  private number(): string | null {
    const first = this.peek();
    if (first === undefined || (first !== '-' && !/[0-9]/.test(first))) return null;
    const start = this.index;
    while (this.index < this.text.length && /[-+0-9.eE]/.test(this.text[this.index])) this.index += 1;
    const token = this.text.slice(start, this.index);
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(token)) {
      this.index = start;
      return null;
    }
    // JSON has no leading zeros, and `JSON.parse` rejects them, so `0644` — a
    // file mode a model writes without thinking — used to invalidate the whole
    // repair and send the call back out as `{ raw }`. The digits are what
    // mattered; keep them and drop the padding.
    const normalized = token.replace(/^(-?)0+(?=\d)/, '$1');
    return normalized;
  }

  /** An unquoted value: everything up to the next comma or closer at this
   *  level. Quoted fragments inside it are kept verbatim. */
  private bare(): string | null {
    const start = this.index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === ',' && depth === 0) break;
      this.index += 1;
    }
    const trimmed = this.text.slice(start, this.index).trim();
    return trimmed ? JSON.stringify(trimmed) : null;
  }

  private value(): string | null {
    this.skipWhitespace();
    const char = this.peek();
    if (char === '"') return this.string();
    if (char === '{') return this.nested(() => this.object());
    if (char === '[') {
      if (this.depth >= MAX_DEPTH) {
        this.tooDeep = true;
        return null;
      }
      // `[tj]s` is a glob, not an array: a single bare element with no comma is
      // a string, or the character class would be silently rewritten into
      // `["tj"]` and the tool would search for something the model never wrote.
      if (!this.looksLikeArray()) return this.bare();
      const start = this.index;
      const array = this.nested(() => this.array());
      if (array !== null) return array;
      // Nesting past the guard is not a character class — do not stringify it.
      if (this.tooDeep) return null;
      this.index = start;
      return this.bare();
    }
    return this.constant() ?? this.number() ?? this.bare();
  }

  private nested(parse: () => string | null): string | null {
    if (this.depth >= MAX_DEPTH) {
      this.tooDeep = true;
      return null;
    }
    this.depth += 1;
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  /** True when the bracket at the cursor opens a real array: it is empty, its
   *  first element is self-describing (quoted, numeric, nested), or a comma
   *  separates it from a second element. */
  private looksLikeArray(): boolean {
    let probe = this.index + 1;
    while (probe < this.text.length && WHITESPACE.test(this.text[probe])) probe += 1;
    const first = this.text[probe];
    if (first === undefined) return false;
    if (first === ']' || first === '"' || first === '{' || first === '[' || first === '-' || /[0-9]/.test(first)) return true;
    if (/^(?:true|false|null|none)\s*[,\]]/i.test(this.text.slice(probe))) return true;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = this.index + 1; cursor < this.text.length; cursor += 1) {
      const char = this.text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        if (depth === 0) return false;
        depth -= 1;
      } else if (char === ',' && depth === 0) return true;
    }
    return false;
  }

  private key(): string | null {
    if (this.peek() === '"') return this.string();
    const start = this.index;
    while (this.index < this.text.length && IDENTIFIER_CHAR.test(this.text[this.index])) this.index += 1;
    if (this.index === start) return null;
    return JSON.stringify(this.text.slice(start, this.index));
  }

  private object(): string | null {
    if (this.peek() !== '{') return null;
    this.index += 1;
    const members: string[] = [];
    this.skipWhitespace();
    if (this.peek() === '}') {
      this.index += 1;
      return '{}';
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.key();
      if (key === null) return null;
      this.skipWhitespace();
      if (this.peek() !== ':') return null;
      this.index += 1;
      const value = this.value();
      if (value === null) return null;
      members.push(`${key}:${value}`);
      this.skipWhitespace();
      const separator = this.peek();
      if (separator === ',') {
        this.index += 1;
        this.skipWhitespace();
        // A trailing comma before the closer is not JSON, but it is obvious.
        if (this.peek() === '}') {
          this.index += 1;
          return `{${members.join(',')}}`;
        }
        continue;
      }
      if (separator === '}') {
        this.index += 1;
        return `{${members.join(',')}}`;
      }
      return null;
    }
  }

  private array(): string | null {
    if (this.peek() !== '[') return null;
    this.index += 1;
    const items: string[] = [];
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.index += 1;
      return '[]';
    }
    for (;;) {
      const item = this.value();
      if (item === null) return null;
      items.push(item);
      this.skipWhitespace();
      const separator = this.peek();
      if (separator === ',') {
        this.index += 1;
        this.skipWhitespace();
        if (this.peek() === ']') {
          this.index += 1;
          return `[${items.join(',')}]`;
        }
        continue;
      }
      if (separator === ']') {
        this.index += 1;
        return `[${items.join(',')}]`;
      }
      return null;
    }
  }
}

/**
 * Repair quasi-JSON into strict JSON. Returns null when the payload is not an
 * object, or when the walk cannot follow it — guessing would be worse than
 * reporting the raw payload.
 */
export function repairQuasiJson(text: string): string | null {
  const body = isolateObject(text);
  if (!body) return null;
  let repaired: string | null;
  try {
    repaired = new QuasiJsonRepairer(body).repair();
  } catch {
    // The walk has a depth guard, so this is belt and braces: a throw here must
    // not escape as anything other than "could not repair".
    return null;
  }
  if (repaired === null) return null;
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

export function parseToolArguments(value: string | undefined): ToolArgumentParse {
  // Providers are supposed to hand over a JSON string, but a SDK that decodes
  // arguments itself can hand over the object. Passing it through is the honest
  // reading; calling `.trim()` on it used to throw TypeError.
  if (value === undefined || value === null) return { ok: true, input: {}, repaired: false };
  if (typeof value !== 'string') {
    return { ok: true, input: value as unknown, repaired: false };
  }
  if (!value.trim()) return { ok: true, input: {}, repaired: false };
  try {
    return { ok: true, input: JSON.parse(value), repaired: false };
  } catch (error) {
    const repaired = repairQuasiJson(value);
    if (repaired !== null) {
      try {
        return { ok: true, input: JSON.parse(repaired), repaired: true };
      } catch {
        // fall through to the failure shape
      }
    }
    return {
      ok: false,
      input: { raw: value },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
