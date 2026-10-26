import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { pathScopeFor, resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/**
 * PDF text extraction that works on files people actually download.
 *
 * The previous version scanned the raw bytes for `(… ) Tj` / `[…] TJ` operators.
 * That reads a PDF only when its content streams are stored uncompressed, which
 * no real-world producer does: every page is almost always inside a
 * `FlateDecode` stream. Measured on four ordinary PDFs from the user's Downloads
 * folder, it returned 0 characters for every one, and then told the model the
 * files "may be image-based" — four perfectly textual documents reported as
 * unreadable, because nothing was ever decompressed.
 *
 * Reading real PDFs needs three things beyond inflating the streams:
 *
 *   1. **objects.** Text lives in a content stream that hangs off a page object,
 *      and the page is reached through a page tree. Modern PDFs also pack objects
 *      into compressed object streams (`/ObjStm`), so a plain `N 0 obj` scan
 *      misses the font descriptors entirely.
 *   2. **per-font code maps.** A subsetted font addresses glyphs by its own
 *      codes, and each font ships a `ToUnicode` CMap saying what those codes
 *      mean. Merging all of them into one table is wrong — the same byte means
 *      `A` in one font and a Chinese character in another — so the active font
 *      has to be tracked through the content stream's `Tf` operator.
 *   3. **honest failure.** A scan has no text layer; saying so is different from
 *      returning an empty string that reads like a bug.
 *
 * This is still a bounded reader, not a layout engine: it emits text runs in
 * content-stream order, without positional inference, so columns and tables come
 * out as their reading order in the underlying stream. That is what an agent
 * summarising a downloaded paper needs, and it is a great deal more than the
 * empty result it produced before.
 */

const BS = '\\';
const DEFAULT_MAX_CHARS = 2_000_000;
/** A decoded CMap range larger than this is a malformed range, not a font. */
const MAX_CMAP_RANGE = 65_536;

const DICT_ESCAPES: Record<string, string> = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\',
};

/** One indirect object: its dictionary text and, when present, its stream. */
type PdfObject = { dict: string; stream?: Buffer };

/** Decompress a stream body, tolerating producers that omit the zlib header. */
function inflate(raw: Buffer): Buffer | undefined {
  for (const options of [{}, { finishFlush: 2 /* Z_SYNC_FLUSH */ }] as const) {
    try { return inflateSync(raw, options); } catch { /* try the next mode */ }
  }
  return undefined;
}

/** Byte offset just past `endstream`, or -1 when the stream is unterminated. */
function streamBounds(source: string, from: number): { start: number; end: number; next: number } | null {
  const marker = /stream\r?\n/g;
  marker.lastIndex = from;
  const match = marker.exec(source);
  if (!match) return null;
  const start = match.index + match[0].length;
  const end = source.indexOf('endstream', start);
  if (end < 0) return null;
  return { start, end, next: end + 'endstream'.length };
}

/**
 * Index every direct object, then unpack the compressed object streams.
 *
 * Objects inside an `/ObjStm` share one stream and are addressed by an offset
 * table in the stream's decoded header. They are dictionary-only (a stream
 * cannot contain another stream), which is why the parsed form below leaves
 * `stream` unset for them.
 */
function readObjects(buffer: Buffer): Map<number, PdfObject> {
  const source = buffer.toString('latin1');
  const objects = new Map<number, PdfObject>();

  const header = /(\d+)\s+\d+\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(source)) !== null) {
    const number = Number.parseInt(match[1], 10);
    const bodyStart = match.index + match[0].length;
    const bounds = streamBounds(source, bodyStart);
    const endobj = source.indexOf('endobj', bodyStart);
    if (!bounds || (endobj >= 0 && bounds.start > endobj)) {
      // Dictionary-only object.
      const dict = source.slice(bodyStart, endobj >= 0 ? endobj : bodyStart + 4096);
      if (!objects.has(number)) objects.set(number, { dict });
      header.lastIndex = endobj >= 0 ? endobj + 'endobj'.length : bodyStart;
      continue;
    }
    const dict = source.slice(bodyStart, bounds.start);
    objects.set(number, { dict, stream: buffer.subarray(bounds.start, bounds.end) });
    header.lastIndex = bounds.next;
  }

  // Unpack object streams. Their headers live in the decoded stream, so this
  // has to run after the direct scan has found the containers themselves.
  for (const object of [...objects.values()]) {
    if (!object.stream || !/\/Type\s*\/ObjStm/.test(object.dict)) continue;
    const decoded = inflate(object.stream);
    if (!decoded) continue;
    const text = decoded.toString('latin1');
    const count = Number.parseInt(/\/N\s+(\d+)/.exec(object.dict)?.[1] ?? '0', 10);
    const first = Number.parseInt(/\/First\s+(\d+)/.exec(object.dict)?.[1] ?? '0', 10);
    if (!Number.isFinite(count) || !Number.isFinite(first) || count <= 0) continue;

    const pairs: Array<[number, number]> = [];
    const pairRe = /(\d+)\s+(\d+)/g;
    let pair: RegExpExecArray | null;
    const headerText = text.slice(0, first);
    while ((pair = pairRe.exec(headerText)) !== null && pairs.length < count) {
      pairs.push([Number.parseInt(pair[1], 10), Number.parseInt(pair[2], 10)]);
    }
    for (let index = 0; index < pairs.length; index += 1) {
      const [number, offset] = pairs[index];
      const from = first + offset;
      const to = index + 1 < pairs.length ? first + pairs[index + 1][1] : text.length;
      if (objects.has(number)) continue; // a direct definition wins
      objects.set(number, { dict: text.slice(from, to) });
    }
  }

  return objects;
}

/** Follow `key N 0 R` (or an inline value) to the dictionary text it names. */
function resolveDict(objects: Map<number, PdfObject>, dict: string, key: string): string | undefined {
  const reference = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  if (reference) return objects.get(Number.parseInt(reference[1], 10))?.dict;
  const inline = new RegExp(`/${key}\\s*<<`).exec(dict);
  if (inline) return balancedDict(dict, inline.index + inline[0].length - 2);
  return undefined;
}

/** The `<< … >>` at `start`, accounting for nested dictionaries. */
function balancedDict(text: string, start: number): string | undefined {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text[i] === '<' && text[i + 1] === '<') { depth += 1; i += 1; continue; }
    if (text[i] === '>' && text[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) return text.slice(start, i + 1);
      continue;
    }
  }
  return undefined;
}

function streamOf(objects: Map<number, PdfObject>, dict: string, key: string): string | undefined {
  const reference = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  if (!reference) return undefined;
  const object = objects.get(Number.parseInt(reference[1], 10));
  if (!object?.stream) return undefined;
  const decoded = inflate(object.stream) ?? object.stream;
  return decoded.toString('latin1');
}

/** Parse a `ToUnicode` CMap into code→text. */
export function parseToUnicodeCMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const hex = (value: string) => Number.parseInt(value, 16);

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const code = hex(pair[1]);
      if (!Number.isFinite(code)) continue;
      let value = '';
      for (let i = 0; i + 4 <= pair[2].length; i += 4) value += String.fromCharCode(hex(pair[2].slice(i, i + 4)));
      // A 2-byte destination that is really one byte (e.g. `<41>`) is common.
      if (!value && pair[2].length === 2) value = String.fromCharCode(hex(pair[2]));
      map.set(code, value);
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const triple of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const low = hex(triple[1]);
      const high = hex(triple[2]);
      const base = hex(triple[3]);
      if (![low, high, base].every(Number.isFinite)) continue;
      for (let code = low; code <= high && code - low < MAX_CMAP_RANGE; code += 1) {
        map.set(code, String.fromCharCode(base + (code - low)));
      }
    }
  }

  return map;
}

/** The font resource names (`/F0` → CMap) for one `/Font << … >>` dictionary. */
function fontMapsFrom(objects: Map<number, PdfObject>, fontDict: string | undefined): Map<string, Map<number, string>> {
  const maps = new Map<string, Map<number, string>>();
  if (!fontDict) return maps;
  for (const entry of fontDict.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const font = objects.get(Number.parseInt(entry[2], 10));
    if (!font) continue;
    const cmapText = streamOf(objects, font.dict, 'ToUnicode');
    if (!cmapText) continue;
    const cmap = parseToUnicodeCMap(cmapText);
    if (cmap.size > 0) maps.set(entry[1], cmap);
  }
  return maps;
}

/** One page: its content-stream text and the font maps those streams use. */
type Page = { content: string; fonts: Map<string, Map<number, string>> };

/** Walk the page tree so each page inherits `/Resources` from its ancestors. */
function readPages(objects: Map<number, PdfObject>): Page[] {
  const pages: Page[] = [];
  const seen = new Set<number>();

  const visit = (number: number, inheritedResources: string | undefined) => {
    if (seen.has(number) || seen.size > 5000) return;
    seen.add(number);
    const object = objects.get(number);
    if (!object) return;
    const resources = resolveDict(objects, object.dict, 'Resources') ?? inheritedResources;

    if (/\/Type\s*\/Pages\b/.test(object.dict)) {
      const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(object.dict)?.[1] ?? '';
      for (const kid of kids.matchAll(/(\d+)\s+\d+\s+R/g)) visit(Number.parseInt(kid[1], 10), resources);
      return;
    }
    if (!/\/Type\s*\/Page\b/.test(object.dict)) return;

    const contents = /\/Contents\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R)/.exec(object.dict)?.[1] ?? '';
    const parts: string[] = [];
    for (const reference of contents.matchAll(/(\d+)\s+\d+\s+R/g)) {
      const object2 = objects.get(Number.parseInt(reference[1], 10));
      if (!object2?.stream) continue;
      const decoded = inflate(object2.stream) ?? object2.stream;
      parts.push(decoded.toString('latin1'));
    }
    if (parts.length === 0) return;
    pages.push({ content: parts.join('\n'), fonts: fontMapsFrom(objects, resolveDict(objects, resources ?? '', 'Font')) });
  };

  // Start from the catalog's page tree, not from "any object with /Type /Page":
  // a linearised file can contain detached page objects that are not part of
  // the visible document.
  let root: number | undefined;
  for (const [, object] of objects) {
    if (!/\/Type\s*\/Catalog\b/.test(object.dict)) continue;
    const reference = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(object.dict);
    if (reference) { root = Number.parseInt(reference[1], 10); break; }
  }
  if (root !== undefined) visit(root, undefined);
  if (pages.length > 0) return pages;

  // No usable catalog: fall back to every page object, which is what a
  // hand-written or truncated file needs to read at all.
  for (const [number, object] of objects) {
    if (/\/Type\s*\/Page\b/.test(object.dict)) visit(number, undefined);
  }
  return pages;
}

function decodeLiteral(raw: string, cmap: Map<number, string> | undefined): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === BS) {
      const next = raw[++i];
      if (next in DICT_ESCAPES) { out += DICT_ESCAPES[next]; continue; }
      if (next >= '0' && next <= '7') {
        let octal = next;
        while (octal.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') octal += raw[++i];
        const code = Number.parseInt(octal, 8);
        out += cmap?.get(code) ?? String.fromCharCode(code);
        continue;
      }
      // A backslash immediately before a newline is a line continuation.
      if (next === '\r' || next === '\n') continue;
      out += next;
      continue;
    }
    const code = char.charCodeAt(0);
    out += cmap?.get(code) ?? char;
  }
  return out;
}

/** Hex strings (`<00410042>`) address glyphs by 2-byte code in CID fonts. */
function decodeHex(raw: string, cmap: Map<number, string> | undefined): string {
  const digits = raw.replace(/[^0-9A-Fa-f]/g, '');
  const even = digits.length % 2 === 0 ? digits : `${digits}0`;
  if (even.length >= 4) {
    let out = '';
    let mapped = false;
    for (let i = 0; i + 4 <= even.length; i += 4) {
      const code = Number.parseInt(even.slice(i, i + 4), 16);
      const value = cmap?.get(code);
      if (value !== undefined) mapped = true;
      out += value ?? String.fromCharCode(code);
    }
    if (mapped || cmap === undefined) return out;
  }
  let out = '';
  for (let i = 0; i + 2 <= even.length; i += 2) {
    const code = Number.parseInt(even.slice(i, i + 2), 16);
    out += cmap?.get(code) ?? String.fromCharCode(code);
  }
  return out;
}

/**
 * Pull the text out of one content stream.
 *
 * Only the string operators (`Tj`, `TJ`, `'`, `"`) are interpreted, and the
 * active font is tracked through `Tf` so each run decodes with its own CMap.
 * Positional operators are ignored on purpose: the run order in the stream is
 * the document's reading order for every producer this reader is meant for.
 */
export function extractPdfContentText(content: string, fonts: Map<string, Map<number, string>> = new Map()): string[] {
  const lines: string[] = [];
  if (!/\bBT\b/.test(content)) return lines;
  const literalRe = /\(((?:[^()\\]|\\[\s\S])*)\)/g;

  for (const block of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
    const body = block[1];
    let currentFont: Map<number, string> | undefined;
    let line = '';
    // One pass over the operators in order, so `Tf` seen before a `Tj` applies
    // to it. Splitting by operator type would decode an earlier run with the
    // font chosen later in the block.
    const tokenRe = /\/([^\s/<>\[\]()]+)\s+[\d.]+\s+Tf|\[((?:[^\[\]\\]|\\[\s\S])*)\]\s*TJ|(\((?:\\.|[^()\\])*\)|<[0-9A-Fa-f\s]*>)\s*(?:Tj|'|")/g;
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(body)) !== null) {
      if (token[1] !== undefined) {
        currentFont = fonts.get(token[1]);
        continue;
      }
      const run = token[2] !== undefined ? token[2] : token[3];
      if (token[2] !== undefined) {
        // TJ: an array of strings with kerning adjustments between them. The
        // adjustment numbers only shift glyphs, so the strings concatenate.
        for (const piece of run.matchAll(literalRe)) line += decodeLiteral(piece[1], currentFont);
        for (const piece of run.matchAll(/<([0-9A-Fa-f\s]+)>/g)) line += decodeHex(piece[1], currentFont);
        continue;
      }
      const literal = /^\(([\s\S]*)\)$/.exec(run);
      if (literal) { line += decodeLiteral(literal[1], currentFont); continue; }
      const hex = /^<([\s\S]*)>$/.exec(run);
      if (hex) line += decodeHex(hex[1], currentFont);
    }
    if (line.trim()) lines.push(line);
  }

  return lines;
}

function tidy(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract text from a PDF buffer. Returns '' when there is no text layer. */
export function extractPdfTextFromBuffer(buffer: Buffer): string {
  const objects = readObjects(buffer);
  const pages = readPages(objects);

  if (pages.length > 0) {
    const lines: string[] = [];
    for (const page of pages) lines.push(...extractPdfContentText(page.content, page.fonts));
    const text = tidy(lines);
    if (text) return text;
  }

  // A file whose page tree could not be resolved (or a hand-written fixture
  // with no tree at all): decode every decompressible stream with a merged
  // CMap. Correct for Western text, best-effort elsewhere — and far better
  // than returning nothing.
  const allText: string[] = [];
  for (const object of objects.values()) {
    if (!object.stream) continue;
    const decoded = inflate(object.stream);
    if (decoded) allText.push(decoded.toString('latin1'));
  }
  if (allText.length === 0) allText.push(buffer.toString('latin1'));

  const merged = new Map<number, string>();
  for (const stream of allText) {
    if (!stream.includes('beginbfchar') && !stream.includes('beginbfrange')) continue;
    for (const [code, value] of parseToUnicodeCMap(stream)) if (!merged.has(code)) merged.set(code, value);
  }
  const fonts = new Map<string, Map<number, string>>([['*', merged]]);
  const lines: string[] = [];
  for (const stream of allText) lines.push(...extractPdfContentText(stream, fonts));
  return tidy(lines);
}

export const pdfToTextTool: ToolDefinition<{ path: string; maxBytes: number; maxChars: number }> = {
  name: 'pdf_to_text',
  description:
    'Extract the readable text of a PDF file: walks the page tree, decompresses each page\'s content streams and applies the active font\'s ToUnicode map, so both Western and Chinese text come out as real characters. Use it to read a downloaded paper, report or manual. Scanned (image-only) PDFs have no text layer and are reported as such; there is no OCR.',
  inputHint: '{ "path": "downloads/paper.pdf" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 64_000_000) : 32_000_000;
    const maxChars = typeof record.maxChars === 'number' && record.maxChars > 0 ? Math.min(Math.floor(record.maxChars), 8_000_000) : DEFAULT_MAX_CHARS;
    return { path: record.path.trim(), maxBytes, maxChars };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const buffer = (await readFile(target)).subarray(0, input.maxBytes);
    const text = extractPdfTextFromBuffer(buffer);
    if (!text) {
      // Name the actual cause: the fix differs between a scan (needs OCR) and
      // an encrypted file (needs the password).
      const looksEncrypted = /\/Encrypt\b/.test(buffer.toString('latin1'));
      const reason = looksEncrypted
        ? 'The PDF is encrypted or password-protected, so its text cannot be read.'
        : 'The PDF has no text layer (it is a scan or an image-only export), and this tool has no OCR.';
      return {
        ok: true,
        output: `No extractable text found in ${input.path}. ${reason}`,
        data: { path: input.path, extracted: false, encrypted: looksEncrypted },
      };
    }
    const truncated = text.length > input.maxChars;
    const slice = truncated ? text.slice(0, input.maxChars) : text;
    return {
      ok: true,
      output: truncated ? `${slice}\n\n[truncated at ${input.maxChars} characters; the full text is ${text.length}]` : slice,
      data: { path: input.path, extracted: true, chars: text.length, truncated },
    };
  },
};
