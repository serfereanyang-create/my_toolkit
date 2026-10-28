import { readFile } from 'node:fs/promises';
import { pathScopeFor, resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/**
 * Markdown tools (markdown_to_html, markdown_outline, markdown_links, markdown_code_blocks).
 *
 * Supports:
 *   - Headers (# ## ###), including headings inside blockquotes (> ## Title)
 *   - Bold (**text** or __text__)
 *   - Italic (*text* or _text_)
 *   - Links ([text](url))
 *   - Images (![alt](url))
 *   - Inline code (`code`)
 *   - Code blocks (```lang ... ```), also inside blockquotes (> ```lang)
 *   - Lists (-, * or + or 1.)
 *   - Task lists (- [ ] / - [x], in unordered or ordered lists)
 *   - Footnotes ([^1] references + [^1]: definitions, one line plus
 *     continuation lines indented by four spaces or a tab)
 *   - Blockquotes (>, nested > >)
 *   - Horizontal rules (--- or ***)
 *   - Backslash escapes for inline punctuation (\* \_ \` \[ \] ...)
 *
 * Literal text is HTML-escaped, so `<`, `>` and `&` typed in the source show up
 * as text; Markdown is the only input format here, raw HTML is not passed
 * through.
 *
 * Not supported (and not claimed by the tool description): tables, setext
 * headings, reference links, hard line breaks (double space / trailing
 * backslash) — every source line is rendered as its own block. Block-level
 * escapes (`\# heading`) are not special either, because escaping runs at the
 * inline level only.
 *
 * This is a lightweight parser — not full CommonMark compliance, but good
 * enough for most use cases and zero dependencies.
 *
 * Footnotes are intentionally NOT part of the heading outline: they are
 * anchored notes, not document structure, and their numbering depends on
 * reference order, which would make the outline ordering unstable.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type FootnoteDefinition = {
  label: string;
  /**
   * 1-based number in the rendered footnote list. Numbers are handed out in
   * definition order among the definitions that are actually referenced; an
   * unreferenced definition keeps 0 because it never reaches the output (a
   * gap in the visible numbering would look like a broken document).
   */
  number: number;
  text: string;
  line: number;
};

type InlineContext = {
  footnotes: Map<string, FootnoteDefinition>;
  /** Labels actually referenced from body text. */
  referenced: Set<string>;
  /** How many times each label has been referenced so far (for unique ids). */
  occurrences: Map<string, number>;
  undefinedRefs: Array<{ label: string; line: number }>;
};

/**
 * Byte markers that survive every later replacement. Inline markup is emitted
 * as HTML strings long before the literal text is restored, so anything that
 * must stay literal (code spans, URLs, whole `<img>` tags, escaped characters)
 * is parked behind a marker that no markup regex can match.
 */
function marker(kind: string, index: number): string {
  return `\x00${kind}${index}\x00`;
}

function processInline(text: string, context?: InlineContext, line = 0): string {
  // The output is HTML, so literal text is escaped up front: a bare `<`, `>`
  // or `&` in the Markdown must not reach the page as markup. Everything below
  // generates tags on top of this escaped text.
  text = escapeHtml(text);

  const codeSpans: string[] = [];
  const images: string[] = [];
  const urls: string[] = [];
  const literals: string[] = [];

  // Inline code spans and backslash escapes share one left-to-right pass,
  // because they constrain each other: a code span is literal text (so links,
  // footnote references and emphasis inside it are not interpreted, and a
  // backslash in it stays literal), while `\`` must produce a literal backtick
  // instead of opening a span. Escapes must be resolved before the emphasis and
  // link regexes run — that is the whole point of escaping. Code content is
  // already escaped above, hence no second escapeHtml here.
  text = text.replace(/\\([^\p{L}\p{N}\s\x00])|`([^`]+)`/gu, (_match, escaped: string | undefined, code: string | undefined) => {
    if (escaped !== undefined) {
      literals.push(escaped);
      return marker('LIT', literals.length - 1);
    }
    codeSpans.push(`<code>${code}</code>`);
    return marker('CODE', codeSpans.length - 1);
  });

  // Images: the complete tag is parked, so a footnote-looking `[^1]` in the alt
  // text can never be rewritten into a `<sup>` *inside* an attribute.
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
    images.push(`<img src="${src}" alt="${alt}" />`);
    return marker('IMG', images.length - 1);
  });

  // Links: the href is parked (an underscore in a URL is not emphasis), the
  // link label stays inline so bold/italic/footnote refs still apply to it.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    urls.push(url);
    return `<a href="${marker('URL', urls.length - 1)}">${label}</a>`;
  });

  // Footnote references (after inline code and URLs are protected)
  if (context) {
    text = text.replace(/\[\^([^\]\s]+)\]/g, (match, label: string) => {
      const definition = context.footnotes.get(label);
      if (!definition) {
        context.undefinedRefs.push({ label, line });
        return match; // leave the literal text in place
      }
      context.referenced.add(label);
      const count = (context.occurrences.get(label) ?? 0) + 1;
      context.occurrences.set(label, count);
      const id = count === 1 ? `fnref:${definition.number}` : `fnref:${definition.number}-${count}`;
      return `<sup id="${id}"><a href="#fn:${definition.number}">${definition.number}</a></sup>`;
    });
  }

  // Bold (** or __)
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic (* or _)
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/_(.+?)_/g, '<em>$1</em>');

  // Restore in reverse order of masking.
  text = text.replace(/\x00LIT(\d+)\x00/g, (_match, index) => literals[parseInt(index, 10)]);
  text = text.replace(/\x00URL(\d+)\x00/g, (_match, index) => urls[parseInt(index, 10)]);
  text = text.replace(/\x00IMG(\d+)\x00/g, (_match, index) => images[parseInt(index, 10)]);
  text = text.replace(/\x00CODE(\d+)\x00/g, (_match, index) => codeSpans[parseInt(index, 10)]);

  return text;
}

type LineEntry = { text: string; line: number };

/**
 * Split the leading blockquote markers off a line.
 *
 * `> > ## Title` → `{ text: '## Title', quoteDepth: 2 }`. Leading whitespace
 * before a marker is tolerated (`  > text`), matching CommonMark's 0–3 space
 * allowance loosely. `>` characters that are not part of the leading run are
 * left alone, so `> a > b` stays depth 1 with `a > b` as content.
 */
function stripQuoteMarkers(line: string): { text: string; quoteDepth: number } {
  const match = line.match(/^(?:[ \t]*>[ \t]?)+/);
  if (!match) return { text: line, quoteDepth: 0 };
  return {
    text: line.slice(match[0].length),
    quoteDepth: (match[0].match(/>/g) ?? []).length,
  };
}

/**
 * Pull footnote definitions out of the document before block rendering.
 *
 * A definition is `[^label]: text` indented by at most three spaces (as in
 * CommonMark; four spaces would make it an indented code block), followed by
 * continuation lines indented by four spaces or a tab. Continuation lines are
 * folded into the definition text with a single space, so the note renders as
 * one paragraph and can carry inline markup across the fold. A blank line ends
 * the definition.
 *
 * Definitions are recognized outside fenced code only. A definition written
 * inside a blockquote (`> [^1]: note`) is still a definition: the leading `>`
 * markers are stripped, the whole line is consumed, and the surrounding quote
 * simply loses that line. This is friendlier than treating the line as quote
 * prose and then reporting the reference as undefined.
 *
 * Numbering is assigned later (see `renderMarkdown`) because it must skip
 * definitions that are never referenced.
 */
function collectFootnoteDefinitions(
  lines: string[],
): { definitions: Map<string, FootnoteDefinition>; order: FootnoteDefinition[]; consumed: Set<number> } {
  const definitions = new Map<string, FootnoteDefinition>();
  const order: FootnoteDefinition[] = [];
  const consumed = new Set<number>();
  // Quote depth at which the open fence lives; `null` means no fence.
  // A top-level fence (depth 0) swallows everything until its closing ```,
  // matching renderBlocks. A fence opened inside `> ...` ends when the quote
  // ends, because the next unquoted line is outside that blockquote.
  let fenceDepth: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const { text: stripped, quoteDepth } = stripQuoteMarkers(line);

    if (fenceDepth !== null) {
      if (fenceDepth > 0 && quoteDepth < fenceDepth) {
        // The quote ended, and the fence ended with it. This line is outside
        // the fence, so fall through and examine it.
        fenceDepth = null;
      } else {
        if (stripped.startsWith('```')) fenceDepth = null; // closing fence
        // Either still inside the fence, or this line was the closing one; in
        // both cases it can never be a definition.
        continue;
      }
    }

    if (stripped.startsWith('```')) {
      fenceDepth = quoteDepth;
      continue;
    }

    const match = stripped.match(/^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/);
    if (!match) continue;

    // Every definition line is removed from the body, including duplicate
    // labels — the first definition wins so a stray repeat cannot resurrect
    // literal `[^x]:` text in a paragraph.
    consumed.add(i);
    const parts = [match[2].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      // A quoted definition (`> [^1]: note`) keeps its continuation lines inside
      // the quote, so the markers have to come off before the indent is checked.
      const source = quoteDepth > 0 ? stripQuoteMarkers(lines[j]).text : lines[j];
      const continuation = source.match(/^(?: {4,}|\t)[ \t]*(.*)$/);
      if (!continuation || !continuation[1].trim()) break;
      consumed.add(j);
      parts.push(continuation[1].trim());
      i = j;
    }

    // A duplicated label still consumes its continuation lines above, but its
    // text is thrown away: the first definition wins.
    if (definitions.has(match[1])) continue;

    const definition: FootnoteDefinition = {
      label: match[1],
      number: 0,
      text: parts.join(' '),
      line: i + 1 - (parts.length - 1),
    };
    definitions.set(definition.label, definition);
    order.push(definition);
  }

  return { definitions, order, consumed };
}

/** Render a run of lines into HTML blocks. Called recursively for blockquotes. */
function renderBlocks(entries: LineEntry[], context: InlineContext): string[] {
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let inList = false;
  let listType = '';

  const closeList = () => {
    if (inList) {
      html.push(`</${listType}>`);
      inList = false;
    }
  };

  for (let i = 0; i < entries.length; i++) {
    const line = entries[i].text;
    const lineNumber = entries[i].line;

    // Code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html.push('</code></pre>');
        inCodeBlock = false;
        codeBlockLang = '';
      } else {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        const langAttr = codeBlockLang ? ` class="language-${escapeHtml(codeBlockLang)}"` : '';
        html.push(`<pre><code${langAttr}>`);
      }
      continue;
    }

    if (inCodeBlock) {
      html.push(escapeHtml(line));
      continue;
    }

    // Blockquote — gather the contiguous run, strip one marker level, recurse.
    // Nested quotes (`> > text`) fall out of the recursion naturally. Lazy
    // continuation is not supported: an unmarked line ends the quote.
    if (stripQuoteMarkers(line).quoteDepth > 0) {
      closeList();
      const inner: LineEntry[] = [];
      let cursor = i;
      while (cursor < entries.length && stripQuoteMarkers(entries[cursor].text).quoteDepth > 0) {
        inner.push({
          text: entries[cursor].text.replace(/^[ \t]*>[ \t]?/, ''),
          line: entries[cursor].line,
        });
        cursor++;
      }
      const innerHtml = renderBlocks(inner, context);
      // A quote holding a single plain paragraph keeps the old inline shape
      // (`<blockquote>text</blockquote>`); anything with real block structure
      // (headings, lists, nested quotes) is emitted as blocks.
      const singleParagraph = innerHtml.length === 1 && /^<p>[\s\S]*<\/p>$/.test(innerHtml[0]);
      html.push(
        singleParagraph
          ? `<blockquote>${innerHtml[0].slice(3, -4)}</blockquote>`
          : `<blockquote>${innerHtml.join('\n')}</blockquote>`,
      );
      i = cursor - 1;
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      closeList();
      const level = headerMatch[1].length;
      const text = processInline(headerMatch[2], context, lineNumber);
      html.push(`<h${level}>${text}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^(\*\*\*+|---+|___+)\s*$/.test(line)) {
      closeList();
      html.push('<hr />');
      continue;
    }

    // Unordered list (including task list items). All three bullet characters
    // `-`, `*` and `+` are list markers, as documented.
    const ulMatch = line.match(/^[*\-+]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) html.push(`</${listType}>`);
        html.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      html.push(renderListItem(ulMatch[1], context, lineNumber));
      continue;
    }

    // Ordered list (task items are accepted here too, mirroring GitHub)
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) html.push(`</${listType}>`);
        html.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      html.push(renderListItem(olMatch[1], context, lineNumber));
      continue;
    }

    // Close list if we hit non-list content
    if (inList && line.trim()) {
      closeList();
    }

    // Empty line
    if (!line.trim()) {
      closeList();
      html.push('');
      continue;
    }

    // Paragraph
    const text = processInline(line, context, lineNumber);
    html.push(`<p>${text}</p>`);
  }

  // Close any open blocks
  if (inCodeBlock) {
    html.push('</code></pre>');
  }
  closeList();

  return html;
}

/**
 * One list item. `- [ ] text` / `- [x] text` become disabled checkboxes, the
 * same semantic GitHub's task lists use; everything else is ordinary inline
 * content. Only the leading marker is special — `[x]` later in the line stays
 * literal text.
 */
function renderListItem(rawText: string, context: InlineContext, lineNumber: number): string {
  const taskMatch = rawText.match(/^\[([ xX])\](?:\s+(.*))?$/);
  if (!taskMatch) {
    return `<li>${processInline(rawText, context, lineNumber)}</li>`;
  }
  const checked = taskMatch[1] === 'x' || taskMatch[1] === 'X';
  const text = processInline(taskMatch[2] ?? '', context, lineNumber);
  // `- [x]` with no text must not leave a dangling space after the checkbox.
  const body = text ? ` ${text}` : '';
  return `<li><input type="checkbox" disabled${checked ? ' checked' : ''}>${body}</li>`;
}

/**
 * Render the footnote section: definitions that were actually referenced, in
 * definition order. Orphan definitions (declared but never referenced) are
 * dropped from the HTML but stay visible in the tool's `data`.
 */
function renderFootnotes(order: FootnoteDefinition[], context: InlineContext): string[] {
  const used = order.filter((definition) => context.referenced.has(definition.label));
  if (used.length === 0) return [];

  const items = used.map((definition) => {
    const backrefs = renderFootnoteBackrefs(definition, context);
    const text = processInline(definition.text, context, definition.line);
    return `<li id="fn:${definition.number}"><p>${text} ${backrefs}</p></li>`;
  });

  return ['<section class="footnotes">', '<ol>', ...items, '</ol>', '</section>'];
}

function renderFootnoteBackrefs(definition: FootnoteDefinition, context: InlineContext): string {
  const count = context.occurrences.get(definition.label) ?? 1;
  const links: string[] = [];
  for (let n = 1; n <= count; n++) {
    const refId = n === 1 ? `fnref:${definition.number}` : `fnref:${definition.number}-${n}`;
    links.push(`<a href="#${refId}" class="footnote-backref">↩</a>`);
  }
  return links.join(' ');
}

export function markdownToHtml(markdown: string): string {
  return renderMarkdown(markdown).html;
}

function newInlineContext(footnotes: Map<string, FootnoteDefinition>): InlineContext {
  return {
    footnotes,
    referenced: new Set(),
    occurrences: new Map(),
    undefinedRefs: [],
  };
}

/**
 * Cheap first guess at which labels the body references. Code spans are literal
 * text, so they are removed before scanning; anything else the guess gets wrong
 * (a `[^1]` sitting inside a fenced block or a link URL) is caught by the
 * verification step in `renderMarkdown`.
 */
function scanReferencedLabels(entries: LineEntry[]): Set<string> {
  const labels = new Set<string>();
  for (const entry of entries) {
    const visible = entry.text.replace(/`[^`]+`/g, '');
    for (const match of visible.matchAll(/\[\^([^\]\s]+)\]/g)) labels.add(match[1]);
  }
  return labels;
}

/**
 * Hand out footnote numbers in definition order, but only to definitions that
 * are referenced: an unreferenced definition would otherwise burn a number and
 * leave the rendered list starting at 2. Unreferenced definitions keep 0.
 */
function assignFootnoteNumbers(order: FootnoteDefinition[], referenced: Set<string>): void {
  let next = 1;
  for (const definition of order) {
    definition.number = referenced.has(definition.label) ? next++ : 0;
  }
}

/**
 * Render a document and keep the parse metadata (footnotes, undefined refs).
 * Split out from `markdownToHtml` so the tool can report footnotes in `data`
 * without re-parsing.
 */
function renderMarkdown(markdown: string): { html: string; context: InlineContext; order: FootnoteDefinition[] } {
  const lines = markdown.split('\n');
  const { definitions, order, consumed } = collectFootnoteDefinitions(lines);

  const bodyEntries: LineEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!consumed.has(i)) bodyEntries.push({ text: lines[i], line: i + 1 });
  }

  // Numbers have to exist before the body is rendered (the references carry
  // them), so they come from the scan; the render then tells us which labels
  // really were referenced. Only when the two disagree does the body get
  // rendered a second time with corrected numbers.
  assignFootnoteNumbers(order, scanReferencedLabels(bodyEntries));
  let context = newInlineContext(definitions);
  let html = renderBlocks(bodyEntries, context);

  const numbersAreStale = order.some(
    (definition) => (definition.number > 0) !== context.referenced.has(definition.label),
  );
  if (numbersAreStale) {
    assignFootnoteNumbers(order, context.referenced);
    context = newInlineContext(definitions);
    html = renderBlocks(bodyEntries, context);
  }

  // Blank source lines render as empty strings; a run of them at either end
  // would leave a dangling newline (before the footnote section, for instance),
  // so trim them off the body before the section is appended.
  while (html.length > 0 && html[html.length - 1] === '') html.pop();
  while (html.length > 0 && html[0] === '') html.shift();

  html.push(...renderFootnotes(order, context));

  return { html: html.join('\n'), context, order };
}

/** Footnote metadata surfaced in the tool's `data` payload. */
function footnoteReport(context: InlineContext, order: FootnoteDefinition[]) {
  // The same missing label can appear several times; report each distinct
  // reference once so the list stays useful rather than repetitive.
  const seen = new Set<string>();
  const undefinedRefs = context.undefinedRefs.filter((ref) => {
    const key = `${ref.line}\u0000${ref.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    defined: order.map((definition) => ({
      label: definition.label,
      number: definition.number,
      text: definition.text,
      line: definition.line,
      referenced: context.referenced.has(definition.label),
    })),
    /** References with no matching definition; their literal text is kept. */
    undefined: undefinedRefs,
    /** True when at least one reference had no definition. */
    hasUndefined: undefinedRefs.length > 0,
  };
}

export const markdownToHtmlTool: ToolDefinition<{ markdown?: string; path?: string; maxBytes: number }> = {
  name: 'markdown_to_html',
  description:
    'Convert Markdown to HTML. Supports headers (including inside blockquotes), bold, italic, links, images, code blocks, bullet lists (-, * or +), ordered lists, task lists (checkboxes), nested blockquotes, horizontal rules, backslash escapes, and footnotes ([^1] references render as superscript links plus a footnotes section; a definition is one line plus continuation lines indented four spaces; an undefined reference is left as literal text and reported in data.footnotes.undefined). Literal text is HTML-escaped, so raw HTML in the Markdown is shown as text instead of being passed through. Lightweight parser with zero dependencies. Accepts a Markdown string directly or reads from a file path.',
  inputHint: '{ "markdown": "# Title\\n\\nHello **world**!" } or { "path": "desktop/README.md" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const markdown = typeof record.markdown === 'string' ? record.markdown : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!markdown && !path) throw new Error('either markdown or path is required');
    if (markdown && path) throw new Error('provide either markdown or path, not both');
    
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 
      ? Math.min(Math.floor(record.maxBytes), 10_000_000) 
      : 1_000_000;
    
    return { markdown, path, maxBytes };
  },
  async execute(input, context) {
    let markdown: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
      const raw = await readFile(target, 'utf8');
      markdown = raw.slice(0, input.maxBytes);
      source = input.path;
    } else {
      markdown = input.markdown!.slice(0, input.maxBytes);
      source = 'input';
    }
    
    const rendered = renderMarkdown(markdown);
    const html = rendered.html;
    const truncated = markdown.length >= input.maxBytes ? ' (truncated)' : '';

    return {
      ok: true,
      output: `${html}${truncated}`,
      data: {
        source,
        markdownBytes: markdown.length,
        htmlLength: html.length,
        truncated: markdown.length >= input.maxBytes,
        footnotes: footnoteReport(rendered.context, rendered.order),
      },
    };
  },
};

export const markdownOutlineTool: ToolDefinition<{
  markdown?: string;
  path?: string;
  maxBytes?: number;
}> = {
  name: 'markdown_outline',
  description:
    'Extract the heading outline from Markdown. Returns all headers with their level, text, and line number; headings inside blockquotes are included with inQuote: true. Also returns task list items (- [ ] / - [x], unordered or ordered) as { text, checked, line }, with inQuote: true when the item sits inside a blockquote. Footnotes are not headings and never appear here.',
  inputHint: '{ "path": "README.md" } or { "markdown": "# Title\\n## Section" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const markdown = typeof record.markdown === 'string' ? record.markdown : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!markdown && !path) throw new Error('either markdown or path is required');
    
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(10_000_000, Math.max(1000, record.maxBytes)) : 1_000_000;
    
    return { markdown, path, maxBytes };
  },
  async execute(input, context) {
    let markdown: string;
    let source: string;

    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
      const raw = await readFile(target, 'utf8');
      markdown = raw.slice(0, input.maxBytes!);
      source = input.path;
    } else {
      markdown = input.markdown!.slice(0, input.maxBytes!);
      source = 'inline markdown';
    }

    const lines = markdown.split('\n');
    const headings: Array<{ level: number; text: string; line: number; inQuote?: boolean }> = [];
    const tasks: Array<{ text: string; checked: boolean; line: number; inQuote?: boolean }> = [];

    // Tracks a fenced block opened at a given quote depth, so a fence inside
    // `> ...` does not leak code state into the surrounding document and vice
    // versa. `null` means not inside a fence.
    let fenceDepth: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const { text: stripped, quoteDepth } = stripQuoteMarkers(lines[i]);

      if (fenceDepth !== null) {
        if (fenceDepth > 0 && quoteDepth < fenceDepth) {
          // Quote ended; so did its fence. Examine this line normally.
          fenceDepth = null;
        } else {
          if (stripped.startsWith('```')) fenceDepth = null; // closing fence
          continue;
        }
      }

      if (stripped.startsWith('```')) {
        fenceDepth = quoteDepth;
        continue;
      }

      const headerMatch = stripped.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        const heading: { level: number; text: string; line: number; inQuote?: boolean } = {
          level: headerMatch[1].length,
          text: headerMatch[2].trim(),
          line: i + 1,
        };
        // A heading inside a blockquote still counts as structure, but the
        // outline marks it so a consumer can tell it from a top-level heading
        // with the same level.
        if (quoteDepth > 0) heading.inQuote = true;
        headings.push(heading);
        continue;
      }

      // Task items must use the same shape renderListItem accepts: a bullet
      // (`-`, `*`, `+`) or an ordered marker, then `[ ]` / `[x]` followed by a
      // space or end of line. Anything else is plain list text in the HTML, so
      // it must not be reported here either.
      const taskMatch = stripped.match(/^(?:[*\-+]|\d+\.)\s+\[([ xX])\](?:\s+(.*))?$/);
      if (taskMatch) {
        const task: { text: string; checked: boolean; line: number; inQuote?: boolean } = {
          text: (taskMatch[2] ?? '').trim(),
          checked: taskMatch[1] === 'x' || taskMatch[1] === 'X',
          line: i + 1,
        };
        // Mirrors headings: a task inside a blockquote is a different thing
        // from a top-level task with the same text.
        if (quoteDepth > 0) task.inQuote = true;
        tasks.push(task);
      }
    }

    if (headings.length === 0) {
      return {
        ok: true,
        output: `No headings found in ${source}`,
        data: { source, headings: [], tasks },
      };
    }

    const outline = headings
      .map(h => `${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text} (line ${h.line})${h.inQuote ? ' [quote]' : ''}`)
      .join('\n');
    
    return {
      ok: true,
      output: `Outline of ${source}:\n\n${outline}`,
      data: {
        source,
        headings,
        headingCount: headings.length,
        tasks,
      },
    };
  },
};

export const markdownLinksTool: ToolDefinition<{
  markdown?: string;
  path?: string;
  includeImages?: boolean;
  maxBytes?: number;
}> = {
  name: 'markdown_links',
  description:
    'Extract all links and optionally images from Markdown. Returns link text, URL, type (link/image), and line number. Use to audit external references or build a link index.',
  inputHint: '{ "path": "README.md", "includeImages": true }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const markdown = typeof record.markdown === 'string' ? record.markdown : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!markdown && !path) throw new Error('either markdown or path is required');
    
    const includeImages = record.includeImages === true;
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(10_000_000, Math.max(1000, record.maxBytes)) : 1_000_000;
    
    return { markdown, path, includeImages, maxBytes };
  },
  async execute(input, context) {
    let markdown: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
      const raw = await readFile(target, 'utf8');
      markdown = raw.slice(0, input.maxBytes!);
      source = input.path;
    } else {
      markdown = input.markdown!.slice(0, input.maxBytes!);
      source = 'inline markdown';
    }
    
    const lines = markdown.split('\n');
    const links: Array<{ text: string; url: string; type: 'link' | 'image'; line: number }> = [];

    // Fences are tracked at their quote depth, so a link inside a fenced block
    // that lives in a blockquote (`> ``` `) is not reported as a real link.
    let fenceDepth: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const { text: line, quoteDepth } = stripQuoteMarkers(lines[i]);

      if (fenceDepth !== null) {
        if (fenceDepth > 0 && quoteDepth < fenceDepth) {
          fenceDepth = null; // quote ended, and the fence with it
        } else {
          if (line.startsWith('```')) fenceDepth = null; // closing fence
          continue;
        }
      }

      if (line.startsWith('```')) {
        fenceDepth = quoteDepth;
        continue;
      }

      if (input.includeImages) {
        const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
        for (const match of line.matchAll(imagePattern)) {
          links.push({
            text: match[1],
            url: match[2],
            type: 'image',
            line: i + 1,
          });
        }
      }
      
      const linkPattern = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
      for (const match of line.matchAll(linkPattern)) {
        links.push({
          text: match[1],
          url: match[2],
          type: 'link',
          line: i + 1,
        });
      }
    }
    
    if (links.length === 0) {
      return {
        ok: true,
        output: `No ${input.includeImages ? 'links or images' : 'links'} found in ${source}`,
        data: { source, links: [], count: 0 },
      };
    }
    
    const linkList = links
      .map(l => `  [${l.type}] ${l.text || '(no text)'} → ${l.url} (line ${l.line})`)
      .join('\n');
    
    return {
      ok: true,
      output: `Links in ${source}:\n\n${linkList}`,
      data: {
        source,
        links,
        count: links.length,
      },
    };
  },
};

export const markdownCodeBlocksTool: ToolDefinition<{
  markdown?: string;
  path?: string;
  maxBytes?: number;
}> = {
  name: 'markdown_code_blocks',
  description:
    'Extract all fenced code blocks from Markdown, including fences inside blockquotes (reported without the quote prefixes). Returns language, content, and line number for each block. Use to extract code examples or analyze code snippets in documentation.',
  inputHint: '{ "path": "README.md" } or { "markdown": "```js\\nconsole.log(1);\\n```" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    const markdown = typeof record.markdown === 'string' ? record.markdown : undefined;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    
    if (!markdown && !path) throw new Error('either markdown or path is required');
    
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(10_000_000, Math.max(1000, record.maxBytes)) : 1_000_000;
    
    return { markdown, path, maxBytes };
  },
  async execute(input, context) {
    let markdown: string;
    let source: string;
    
    if (input.path) {
      const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
      const raw = await readFile(target, 'utf8');
      markdown = raw.slice(0, input.maxBytes!);
      source = input.path;
    } else {
      markdown = input.markdown!.slice(0, input.maxBytes!);
      source = 'inline markdown';
    }
    
    const lines = markdown.split('\n');
    const codeBlocks: Array<{ language: string; content: string; lineStart: number; lineEnd: number }> = [];

    // `null` means "not inside a fence", otherwise the quote depth the fence was
    // opened at: a fence inside a blockquote (`> ``` `) only covers that quote,
    // and its content is reported without the `>` prefixes.
    let fenceDepth: number | null = null;
    let currentLang = '';
    let currentContent: string[] = [];
    let blockStart = 0;
    let lastLine = 0;

    const flush = () => {
      codeBlocks.push({
        language: currentLang || 'plain',
        content: currentContent.join('\n'),
        lineStart: blockStart,
        lineEnd: lastLine,
      });
      fenceDepth = null;
      currentContent = [];
      currentLang = '';
    };

    for (let i = 0; i < lines.length; i++) {
      const { text: line, quoteDepth } = stripQuoteMarkers(lines[i]);

      if (fenceDepth !== null) {
        if (fenceDepth > 0 && quoteDepth < fenceDepth) {
          // The quote ended, so the fence ended with it: report what we have
          // and treat this line as ordinary content.
          flush();
        } else {
          if (line.startsWith('```')) {
            lastLine = i + 1;
            flush();
            continue;
          }
          currentContent.push(line);
          lastLine = i + 1;
          continue;
        }
      }

      if (line.startsWith('```')) {
        fenceDepth = quoteDepth;
        currentLang = line.slice(3).trim();
        blockStart = i + 1;
        lastLine = i + 1;
        currentContent = [];
        continue;
      }
    }

    // An unterminated fence still holds code, so report it rather than losing it.
    if (fenceDepth !== null) flush();
    
    if (codeBlocks.length === 0) {
      return {
        ok: true,
        output: `No code blocks found in ${source}`,
        data: { source, codeBlocks: [], count: 0 },
      };
    }
    
    const summary = codeBlocks
      .map((block, idx) => `  Block ${idx + 1}: ${block.language} (lines ${block.lineStart}-${block.lineEnd}, ${block.content.split('\n').length} lines)`)
      .join('\n');
    
    return {
      ok: true,
      output: `Code blocks in ${source}:\n\n${summary}`,
      data: {
        source,
        codeBlocks,
        count: codeBlocks.length,
      },
    };
  },
};
