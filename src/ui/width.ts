/**
 * width.ts — terminal display-width primitives shared by every aligned UI
 * surface (session header box, exec titles, home screen, overlay, truncation).
 *
 * Node has no wcwidth. Each UI file used to carry its own copy that counted
 * every non-CJK code point as one column, so emoji, flags, combining marks and
 * ZWJ sequences pushed every box edge after them out of alignment, and
 * `String.prototype.length`-based truncation cut ANSI sequences in half.
 *
 * Rules:
 *  - ANSI SGR/CSI/OSC sequences occupy zero columns and are never split by
 *    truncation (they are emitted as whole tokens).
 *  - East Asian Wide/Fullwidth code points occupy two columns.
 *  - Combining marks (e.g. U+0301), ZWJ (U+200D) and variation selectors
 *    occupy zero columns; a base + marks cluster keeps the base width.
 *  - A ZWJ emoji family (👨‍👩‍👧‍👦) and a regional-indicator flag pair (🇨🇳)
 *    render as one two-column glyph, not 2×N.
 *  - Control characters occupy zero columns (they are never printed by the
 *    aligned surfaces).
 */

/* eslint-disable no-control-regex -- ANSI parsing is the whole point here */

/** Matches one complete ANSI escape sequence starting at `lastIndex`. */
const ANSI_STICKY = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*?(?:\u0007|\u001b\\)|[@-Z\\-_])/y;
/** Same grammar, global, for stripping. */
const ANSI_GLOBAL = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*?(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EMOJI = /\p{Emoji}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const IS_EXTEND = /[\p{M}\p{Cf}]/u;

function isRegionalIndicator(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

/** Zero-width code points that are not caught by `\p{M}` / `\p{Cf}`. */
function isZeroWidth(code: number): boolean {
  if (code === 0xfe0e || code === 0xfe0f) return true; // VS15 / VS16
  if (code === 0x20e3) return true; // combining enclosing keycap
  if (code >= 0x1160 && code <= 0x11ff) return true; // Hangul medial/final jamo
  return false;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xa960 && code <= 0xa97f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1b000 && code <= 0x1b001)
    || (code >= 0x1f200 && code <= 0x1f251)
    || (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Width of a single code point (ignoring grapheme clustering). */
export function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (isControlCode(code)) return 0;
  if (isZeroWidth(code)) return 0;
  if (IS_EXTEND.test(char)) return 0; // standalone combining mark / format char
  if (isRegionalIndicator(code)) return 2; // flags are two columns even alone
  if (isWide(code)) return 2;
  if (EMOJI_PRESENTATION.test(char)) return 2;
  return 1;
}

function clusterWidth(cluster: string): number {
  const codes: number[] = [];
  for (const char of cluster) codes.push(char.codePointAt(0) ?? 0);
  if (codes.length === 0) return 0;
  if (codes.length === 2 && codes.every(isRegionalIndicator)) return 2;
  let width = 0;
  for (let i = 0; i < cluster.length;) {
    const code = cluster.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(code);
    width = Math.max(width, charDisplayWidth(char));
    i += char.length;
  }
  if (width === 1 && codes.includes(0xfe0f)) {
    // Text-default glyph promoted to emoji presentation by VS16 (❤️, 1️⃣).
    const base = String.fromCodePoint(codes[0]!);
    if (EMOJI.test(base)) return 2;
  }
  return width;
}

/** One printable cluster or one ANSI escape sequence. */
export type DisplayToken = { text: string; width: number; ansi: boolean };

function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** Split into ANSI tokens and grapheme-ish clusters (base + extend + ZWJ). */
export function displayTokens(value: string): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  let i = 0;
  while (i < value.length) {
    if (value.charCodeAt(i) === 0x1b) {
      ANSI_STICKY.lastIndex = i;
      const match = ANSI_STICKY.exec(value);
      if (match) {
        tokens.push({ text: match[0], width: 0, ansi: true });
        i = ANSI_STICKY.lastIndex;
        continue;
      }
      // A bare ESC with no valid sequence: zero width, never emitted as text.
      tokens.push({ text: '\u001b', width: 0, ansi: true });
      i += 1;
      continue;
    }
    const start = i;
    // Base code point.
    const code = value.codePointAt(i) ?? 0;
    i += code > 0xffff ? 2 : 1;
    // A lone ZWJ or combining mark at a cluster start is its own zero-width
    // token; it must not absorb whatever follows.
    if (code === 0x200d || IS_EXTEND.test(String.fromCodePoint(code))) {
      tokens.push({ text: value.slice(start, i), width: charDisplayWidth(value.slice(start, i)), ansi: false });
      continue;
    }
    // GB12/13: a regional-indicator flag is exactly one base + one RI.
    if (isRegionalIndicator(code)) {
      const next = value.codePointAt(i) ?? 0;
      if (isRegionalIndicator(next)) i += 2;
      tokens.push({ text: value.slice(start, i), width: 2, ansi: false });
      continue;
    }
    // Trailing combining marks / variation selectors / ZWJ-linked glyphs.
    // GB11: a ZWJ only extends the cluster into another *pictographic* code
    // point; `👨‍語` is a family emoji followed by a kanji, not one glyph.
    while (i < value.length) {
      const next = value.codePointAt(i) ?? 0;
      const nextChar = String.fromCodePoint(next);
      if (isZeroWidth(next) || IS_EXTEND.test(nextChar)) {
        i += next > 0xffff ? 2 : 1;
        continue;
      }
      const previous = value.codePointAt(i - 1) ?? 0;
      if (previous === 0x200d && EXTENDED_PICTOGRAPHIC.test(nextChar) && !isControlCode(next)) {
        i += next > 0xffff ? 2 : 1;
        continue;
      }
      break;
    }
    const text = value.slice(start, i);
    tokens.push({ text, width: clusterWidth(text), ansi: false });
  }
  return tokens;
}

/** Strip ANSI escape sequences (SGR, CSI including `?`-prefixed, OSC). */
export function stripAnsi(value: string): string {
  if (!value.includes('\u001b')) return value;
  return value.replace(ANSI_GLOBAL, '');
}

/** Display columns of a string, ANSI sequences excluded. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const token of displayTokens(value)) width += token.width;
  return width;
}

/**
 * Take as much of `value` as fits in `max` columns. ANSI sequences are carried
 * whole (they cost zero columns) and a cluster is never split.
 */
export function takeByDisplayWidth(value: string, max: number): string {
  if (max <= 0) return '';
  let output = '';
  let width = 0;
  let truncated = false;
  for (const token of displayTokens(value)) {
    if (!token.ansi && width + token.width > max) {
      truncated = true;
      break;
    }
    output += token.text;
    width += token.width;
  }
  // Drop trailing zero-width escape codes only when we actually cut content;
  // keeping them would leave a dangling SGR on the caller's line.
  if (truncated) output = output.replace(ANSI_GLOBAL, '');
  return output;
}

/**
 * Truncate to `max` display columns, appending `suffix` (default `...`) when
 * anything was cut. The result never exceeds `max` columns, never splits an
 * ANSI sequence, and never cuts a surrogate pair or ZWJ cluster.
 */
export function truncateToWidth(value: string, max: number, suffix = '...'): string {
  if (max < 0) return '';
  if (displayWidth(value) <= max) return value;
  if (max === 0) return '';
  const suffixWidth = displayWidth(suffix);
  if (suffixWidth >= max) return takeByDisplayWidth(suffix, max);
  return `${takeByDisplayWidth(value, max - suffixWidth)}${suffix}`;
}
