import { readFile } from 'node:fs/promises';
import { pathScopeFor, resolveReadablePath } from '../safety/policy.js';
import { readZipMember } from './zip.js';
import type { ToolDefinition } from './types.js';

/*
 * docx_to_text — read a Word document.
 *
 * The gap this fills: there were tools that *write* .docx (create_docx,
 * create_docx_table, insert_docx_image) and tools that read pdf / rtf / xml /
 * html, but nothing that read a .docx. Asked to "打开这个 word 看看", the agent
 * had to improvise — `read_file` returns ZIP bytes, `run_command` with
 * python-docx or pandoc is not installed on a bare Windows box, `extract_zip`
 * dumps word/document.xml somewhere and then the model is staring at
 * WordprocessingML. Every one of those is a failed tool call in front of the
 * user.
 *
 * A .docx is a ZIP whose main part is word/document.xml, so reading it needs no
 * dependency: inflate that one member (readZipMember) and turn the XML into
 * text — paragraphs, list items, table cells, headings, tabs and breaks.
 */

const MAX_DOCX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 200_000;

/** Decode the XML entities a Word document actually contains. */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&');
}

/**
 * Turn word/document.xml into readable text.
 *
 * Paragraph-level structure is kept (a blank line between paragraphs), headings
 * become `#` markers so a long document keeps its outline, and table rows stay
 * on one line with ` | ` between cells — a table flattened into loose lines is
 * worse than useless for a model trying to reason about it.
 *
 * Tables get their own pass. A real Word table wraps every cell's text in its
 * own <w:p>, so splitting the whole document on `</w:p>` chops a row into
 * "项目" / "值" on separate lines and leaves a dangling `|`; the row only
 * survives if the table block is converted before paragraph splitting.
 */
export function docxXmlToText(xml: string): string {
  const blocks: string[] = [];
  const tables = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
  let consumed = 0;
  for (let match = tables.exec(xml); match !== null; match = tables.exec(xml)) {
    if (match.index > consumed) blocks.push(paragraphsToText(xml.slice(consumed, match.index)));
    blocks.push(tableToText(match[0]));
    consumed = match.index + match[0].length;
  }
  if (consumed < xml.length) blocks.push(paragraphsToText(xml.slice(consumed)));

  return blocks.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** One table: a line per row, cells joined with ` | `. */
function tableToText(tableXml: string): string {
  const rows: string[] = [];
  for (const row of tableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []) {
    const cells = (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? [])
      .map((cell) => inlineText(cell).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (cells.length > 0) rows.push(cells.join(' | '));
  }
  return rows.join('\n');
}

/** Everything a run can carry, without the markup. */
function inlineText(xml: string): string {
  return decodeXml(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/** The prose around the tables: paragraphs, headings, tabs and breaks. */
function paragraphsToText(xml: string): string {
  // Mark heading paragraphs before stripping tags: the style sits at the start
  // of the paragraph, so a unique sentinel can be found after the split.
  const marked = xml.replace(/<w:pStyle w:val="(?:[^"]*?[Hh]eading\s*)([1-6])"\/>/g, (match: string, level: string) => `${match}\u0000H${level}\u0000`);

  const lines: string[] = [];
  let headingLevel = 0;
  for (const rawParagraph of marked.split('</w:p>')) {
    const heading = rawParagraph.match(/\u0000H([1-6])\u0000/);
    headingLevel = heading ? Number(heading[1]) : 0;

    let text = rawParagraph
      .replace(/\u0000H[1-6]\u0000/g, '')
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:tc>/g, ' | ')
      .replace(/<\/w:tr>/g, '\n')
      // Nested paragraph-like containers (text boxes) close with </w:p> too,
      // so their text has already been split out above.
      .replace(/<[^>]+>/g, '');
    text = decodeXml(text)
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, '').replace(/\s*\|\s*$/g, '').trim())
      .filter((line) => line !== '')
      .join('\n');
    if (!text) continue;
    lines.push(headingLevel > 0 ? `${'#'.repeat(headingLevel)} ${text}` : text);
  }

  return lines.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

export type DocxReadResult =
  | { ok: true; text: string; paragraphs: number; chars: number; truncated: boolean }
  | { ok: false; reason: string };

/** Read a .docx buffer into text, with a reason instead of an exception on failure. */
export function docxToText(buffer: Buffer, maxChars = DEFAULT_MAX_CHARS): DocxReadResult {
  // The old binary .doc format (OLE2 compound file) has no XML part at all.
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0xd0cf11e0) {
    return { ok: false, reason: 'this is a legacy .doc (OLE2 binary), not a .docx — open it in Word/WPS and save as .docx, or ask for the text to be pasted in' };
  }
  let xml: Buffer | null = null;
  try {
    xml = readZipMember(buffer, 'word/document.xml');
  } catch (error) {
    return { ok: false, reason: `the file is not a readable ZIP archive (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!xml) {
    return { ok: false, reason: 'no word/document.xml inside the archive — this is not a Word .docx (a .xlsx/.pptx renamed to .docx will look like this)' };
  }
  const text = docxXmlToText(xml.toString('utf8'));
  const truncated = text.length > maxChars;
  // The marker is part of the budget: `maxChars` is a promise to the model
  // about how much text comes back, not a promise about the prose alone.
  const marker = `\n\n[truncated at ${maxChars} characters]`;
  const clipped = truncated
    ? `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`
    : text;
  return {
    ok: true,
    text: clipped,
    paragraphs: text ? text.split(/\n\n/).length : 0,
    chars: text.length,
    truncated,
  };
}

export const docxToTextTool: ToolDefinition<{ path: string; maxChars: number }> = {
  name: 'docx_to_text',
  description:
    'Read a Microsoft Word .docx file and return its text in document order ("#"-prefixed headings, one line per table row with cells separated by " | "). Use this — not read_file, which returns raw ZIP bytes — whenever you need to know what a Word document says.',
  inputHint: '{ "path": "docs/产品需求.docx" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    const maxChars = typeof record.maxChars === 'number' && record.maxChars > 0
      ? Math.min(Math.floor(record.maxChars), DEFAULT_MAX_CHARS)
      : DEFAULT_MAX_CHARS;
    return { path: record.path.trim(), maxChars };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const buffer = await readFile(target);
    if (buffer.length > MAX_DOCX_BYTES) {
      return { ok: false, output: `${input.path} is ${buffer.length} bytes, over the ${MAX_DOCX_BYTES}-byte limit for docx_to_text` };
    }
    const result = docxToText(buffer, input.maxChars);
    if (!result.ok) {
      return { ok: false, output: `Cannot read ${input.path}: ${result.reason}`, data: { path: input.path } };
    }
    return {
      ok: true,
      output: result.text || '(this document has no text — it may contain only images or an embedded object)',
      data: { path: input.path, chars: result.chars, paragraphs: result.paragraphs, truncated: result.truncated },
    };
  },
};
