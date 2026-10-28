import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { slugifyHeading } from '../lib/markdownOutline';

/*
 * Minimal, dependency-free markdown renderer for assistant messages.
 * Supports fenced code blocks, inline code, bold/italic, six heading levels,
 * nested unordered/ordered lists, `>` blockquotes (up to four levels, with
 * paragraphs, lists and fences inside), links and paragraphs. All text is
 * rendered through React children (never dangerouslySetInnerHTML), so raw HTML
 * in the model output is shown as literal text rather than being injected into
 * the DOM.
 *
 * Iteration 12: headings get GitHub-style anchor ids (deduplicated per
 * document) so the outline panel's links can scroll to them.
 */

/** One list item. A plain string is a leaf; the object form carries the nested
 *  lists written under it. Flat lists keep the string shape they have always
 *  had, so output without indentation did not change when nesting landed. */
type ListItem = string | { text: string; children: ListBlock[] };

type ListBlock =
  | { kind: 'ul'; items: ListItem[] }
  /** `start` preserves the number the model wrote — a loose list split by
   *  blank lines used to render every block from 1. */
  | { kind: 'ol'; items: ListItem[]; start?: number };

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | ListBlock
  /** `>` quote. `blocks` is the body re-parsed after one marker level was
   *  stripped, so a quote can hold paragraphs, lists, fences and further
   *  quotes without a second parser. */
  | { kind: 'quote'; blocks: Block[] }
  /** `mono` keeps the source line breaks: column-aligned output (a table the
   *  model typed with spaces, a file listing) collapses into one unreadable
   *  run if it is joined into a paragraph. */
  | { kind: 'p'; text: string; mono?: boolean }
  | { kind: 'table'; header: string[]; align: Array<'left' | 'center' | 'right' | null>; rows: string[][] };

/** Split a GFM table row on unescaped pipes. */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { cell += '|'; i += 1; continue; }
    if (ch === '|') { cells.push(cell); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell);
  // A leading/trailing pipe produces an empty first/last cell; drop those.
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** `| --- | :--: |` under a header row — the marker that makes it a table. */
function tableAlignments(line: string): Array<'left' | 'center' | 'right' | null> | null {
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const align: Array<'left' | 'center' | 'right' | null> = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell.replace(/\s/g, ''))) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}

/**
 * Is this paragraph column-aligned output rather than prose?
 *
 * Models frequently type a small table with spaces (`行数    文件    1885`),
 * and GitHub-flavoured markdown keeps that inside one paragraph. Joining the
 * lines with " " — which is right for wrapped prose — runs every column
 * together, which is exactly how the answer to a "top 5 by line count"
 * question came out unreadable.
 */
function looksColumnar(lines: string[]): boolean {
  if (lines.length < 2) return false;
  return lines.some((line) => /\S {3,}\S/.test(line));
}

/** Assign unique anchor ids to a batch of heading texts, GitHub style. */
export function headingAnchors(headings: string[]): string[] {
  const used = new Map<string, number>();
  return headings.map((raw, idx) => {
    const base = slugifyHeading(raw) || `heading-${idx}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  });
}

/** Heading texts in document order, quotes included, so anchor ids stay lined
 *  up with the order the renderer emits its headings in. */
function collectHeadingTexts(blocks: Block[], into: string[] = []): string[] {
  for (const block of blocks) {
    if (block.kind === 'heading') into.push(block.text);
    else if (block.kind === 'quote') collectHeadingTexts(block.blocks, into);
  }
  return into;
}

/** Item line: indent, marker (`-`/`*`/`+` or `1.`), then the text. */
const LIST_ITEM = /^([ \t]*)([-*+]|\d+\.)[ \t]+(.*)$/;

/** Visible list levels: depth 0, 1, 2. Deeper input renders at the third. */
const MAX_LIST_LEVELS = 3;

/** Quote levels the renderer will nest. Past this the markers stay literal
 *  text: a line made of `>` must not recurse without bound. */
const MAX_QUOTE_LEVELS = 4;

/** Leading whitespace as a width; a tab advances to the next multiple of 4. */
function indentWidth(prefix: string): number {
  let width = 0;
  for (const ch of prefix) width += ch === '\t' ? 4 - (width % 4) : 1;
  return width;
}

function newListBlock(kind: 'ul' | 'ol', start: number): ListBlock {
  if (kind === 'ol') return start === 1 ? { kind: 'ol', items: [] } : { kind: 'ol', items: [], start };
  return { kind: 'ul', items: [] };
}

/**
 * Parse one list run into a tree.
 *
 * Indentation is the nesting signal: an item indented past the level it
 * follows becomes that item's child list, which is how models write 2-space,
 * 4-space and tab nesting. Deeper than MAX_LIST_LEVELS is clamped onto the
 * deepest level rather than thrown away — a card holding a plan should still
 * show the fourth level's text, just without another indent step.
 *
 * A marker change at the same depth (a `-` run followed by a `1.` run) starts a
 * new list: at depth 0 that ends this block so the caller opens the next one,
 * deeper it hangs off the same parent item as an additional child list.
 */
function parseList(lines: string[], start: number): { block: ListBlock; next: number } {
  const stack: Array<{ block: ListBlock; indent: number }> = [];
  let root: ListBlock | null = null;
  let i = start;

  while (i < lines.length) {
    const match = lines[i].match(LIST_ITEM);
    if (!match) {
      // A blank line between bullets keeps the list; a blank line before
      // anything else ends it, so `- item\n\n普通段落` stays two blocks.
      if (!lines[i].trim() && i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) { i += 1; continue; }
      break;
    }
    const indent = indentWidth(match[1]);
    const ordered = !/^[-*+]/.test(match[2]);
    const kind = ordered ? 'ol' : 'ul';
    const number = ordered ? Number(match[2].slice(0, -1)) : 1;
    const text = match[3];

    // Back out to the level this line aligns with. Equal indents are siblings,
    // so only strictly shallower lines pop.
    while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
    let level = stack[stack.length - 1];
    const deeper = level ? indent > level.indent : false;

    if (!level || (deeper && stack.length < MAX_LIST_LEVELS)) {
      const block = newListBlock(kind, number);
      if (level) {
        // Widen the parent item so it can hold a child list.
        const parentItem = level.block.items[level.block.items.length - 1];
        const holder = typeof parentItem === 'string' ? { text: parentItem, children: [] } : parentItem;
        if (typeof parentItem === 'string') level.block.items[level.block.items.length - 1] = holder;
        holder.children.push(block);
      } else {
        root = block;
      }
      stack.push({ block, indent });
      level = stack[stack.length - 1];
    } else if (level.block.kind !== kind) {
      if (stack.length === 1) break;
      const parent = stack[stack.length - 2];
      const parentItem = parent.block.items[parent.block.items.length - 1];
      const holder = typeof parentItem === 'string' ? { text: parentItem, children: [] } : parentItem;
      if (typeof parentItem === 'string') parent.block.items[parent.block.items.length - 1] = holder;
      const block = newListBlock(kind, number);
      holder.children.push(block);
      stack[stack.length - 1] = { block, indent: level.indent };
      level = stack[stack.length - 1];
    }

    level.block.items.push(text);
    i += 1;
  }

  // `root` is set by the first item; the caller only calls us on a list line.
  return { block: root as ListBlock, next: i };
}

export function parseBlocks(src: string, quoteDepth = 0): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      // An unterminated fence is a code block still being streamed, not prose.
      // Treating it as a paragraph joined every line with a space, so a reply
      // mid-code rendered as one unreadable run of text until the closing
      // fence arrived. Keeping the line breaks makes the partial code look
      // like code from the first token.
      if (i < lines.length) i++; // skip closing fence
      blocks.push({ kind: 'code', lang, text: body.join('\n') });
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    // Blockquote. One marker level is stripped and the remainder re-parsed, so
    // nesting (`>>` / `> >`), lists and fences inside a quote all fall out of
    // this same function. Lazy continuation (an unmarked line following a
    // quoted one) is not supported — it ends the quote.
    if (/^ {0,3}>/.test(line)) {
      if (quoteDepth >= MAX_QUOTE_LEVELS) {
        blocks.push({ kind: 'p', text: line.replace(/^ {0,3}>\s?/, '') });
        i++;
        continue;
      }
      const inner: string[] = [];
      while (i < lines.length) {
        const quoted = lines[i].match(/^ {0,3}>\s?(.*)$/);
        if (quoted) { inner.push(quoted[1]); i++; continue; }
        // A blank line continues the quote only when the next line is quoted;
        // `>` on its own already arrives as an empty match above.
        if (!lines[i].trim() && i + 1 < lines.length && /^ {0,3}>/.test(lines[i + 1])) { inner.push(''); i++; continue; }
        break;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner.join('\n'), quoteDepth + 1) });
      continue;
    }

    // GFM table: a row containing pipes followed by a delimiter row.
    if (line.includes('|') && i + 1 < lines.length) {
      const align = tableAlignments(lines[i + 1]);
      if (align) {
        const header = splitTableRow(line);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const row = splitTableRow(lines[i]);
          // Pad short rows so every cell index exists at render time.
          while (row.length < header.length) row.push('');
          rows.push(row.slice(0, header.length));
          i += 1;
        }
        blocks.push({ kind: 'table', header, align, rows });
        continue;
      }
    }

    // Unordered / ordered list. Both markers share one parser: indentation is
    // what nests a list, and a nested list may switch marker kind.
    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    // Paragraph (gather consecutive non-blank, non-structural lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !/^ {0,3}>/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && tableAlignments(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    // Prose wraps: joining its lines with a space is correct. Column-aligned
    // output does not — keep the line breaks and render it monospace.
    blocks.push(looksColumnar(para)
      ? { kind: 'p', text: para.join('\n'), mono: true }
      : { kind: 'p', text: para.join(' ') });
  }

  return blocks;
}

// Render inline spans: `code`, **bold**, *italic*, [text](url).
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Split on inline code first so we never format inside it.
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((part, idx) => {
    if (!part) return;
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      nodes.push(<code key={`${keyPrefix}-c${idx}`} className="md-code-inline">{part.slice(1, -1)}</code>);
      return;
    }
    nodes.push(...renderEmphasis(part, `${keyPrefix}-e${idx}`));
  });
  return nodes;
}

function renderEmphasis(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Links: [label](url)
  const linkSplit = text.split(/(\[[^\]]+\]\([^)]+\))/g);
  linkSplit.forEach((chunk, li) => {
    if (!chunk) return;
    const link = chunk.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = link[2];
      // Only allow http(s) links; otherwise render as text.
      if (/^https?:\/\//i.test(href)) {
        nodes.push(<a key={`${keyPrefix}-l${li}`} href={href} target="_blank" rel="noreferrer">{link[1]}</a>);
      } else {
        nodes.push(<Fragment key={`${keyPrefix}-l${li}`}>{chunk}</Fragment>);
      }
      return;
    }
    // Bold then italic
    const boldSplit = chunk.split(/(\*\*[^*]+\*\*)/g);
    boldSplit.forEach((b, bi) => {
      if (!b) return;
      if (b.startsWith('**') && b.endsWith('**') && b.length >= 4) {
        nodes.push(<strong key={`${keyPrefix}-b${li}-${bi}`}>{b.slice(2, -2)}</strong>);
        return;
      }
      const italicSplit = b.split(/(\*[^*]+\*)/g);
      italicSplit.forEach((it, ii) => {
        if (!it) return;
        if (it.startsWith('*') && it.endsWith('*') && it.length >= 2) {
          nodes.push(<em key={`${keyPrefix}-i${li}-${bi}-${ii}`}>{it.slice(1, -1)}</em>);
        } else {
          nodes.push(<Fragment key={`${keyPrefix}-t${li}-${bi}-${ii}`}>{it}</Fragment>);
        }
      });
    });
  });
  return nodes;
}

/** `<li>`s for one list level, each item's child lists rendered inside it. */
function renderListItems(items: ListItem[], keyPrefix: string): ReactNode[] {
  return items.map((item, idx) => {
    const node = typeof item === 'string' ? { text: item, children: [] as ListBlock[] } : item;
    const key = `${keyPrefix}-i${idx}`;
    return (
      <li key={key}>
        {renderInline(node.text, key)}
        {node.children.map((child, childIdx) => renderList(child, `${key}-${childIdx}`))}
      </li>
    );
  });
}

function renderList(block: ListBlock, key: string): ReactNode {
  if (block.kind === 'ol') {
    return <ol key={key} className="md-list" start={block.start}>{renderListItems(block.items, key)}</ol>;
  }
  return <ul key={key} className="md-list">{renderListItems(block.items, key)}</ul>;
}

function renderBlocks(
  blocks: Block[],
  keyPrefix: string,
  anchorPrefix: string | undefined,
  anchors: string[],
  cursor: { at: number },
): ReactNode[] {
  return blocks.map((block, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (block.kind) {
      case 'code':
        return (
          <pre key={key} className="md-code-block" data-lang={block.lang || undefined}>
            <code>{block.text}</code>
          </pre>
        );
      case 'heading': {
        // The tag keeps the shift the renderer has always applied (source h1
        // lands on <h3>, so a reply cannot out-rank the app's own titles) and
        // caps at <h6>; the size now comes from the level's class, because two
        // source levels share the <h6> tag and a tag rule cannot tell them
        // apart.
        const Tag = (`h${Math.min(block.level + 2, 6)}`) as keyof JSX.IntrinsicElements;
        const base = anchors[cursor.at++] ?? `heading-${idx}`;
        const id = anchorPrefix ? `${anchorPrefix}--${base}` : base;
        const levelClass = `md-h${Math.min(Math.max(block.level, 1), 6)}`;
        return (
          <Tag key={key} id={id} className={`md-heading ${levelClass}`}>
            {renderInline(block.text, key)}
          </Tag>
        );
      }
      case 'ul':
      case 'ol':
        return renderList(block, key);
      case 'quote':
        return (
          <blockquote key={key} className="md-quote">
            {renderBlocks(block.blocks, key, anchorPrefix, anchors, cursor)}
          </blockquote>
        );
      case 'table':
        return (
          <div className="md-table-wrap" key={key}>
            <table className="md-table">
              <thead>
                <tr>
                  {block.header.map((cell, j) => (
                    <th key={j} style={block.align[j] ? { textAlign: block.align[j]! } : undefined}>
                      {renderInline(cell, `th${idx}-${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, j) => (
                      <td key={j} style={block.align[j] ? { textAlign: block.align[j]! } : undefined}>
                        {renderInline(cell, `td${idx}-${r}-${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return block.mono
          ? <pre key={key} className="md-pre-text">{block.text}</pre>
          : <p key={key} className="md-p">{renderInline(block.text, key)}</p>;
    }
  });
}

export function Markdown({ text, anchorPrefix }: { text: string; anchorPrefix?: string }) {
  const blocks = parseBlocks(text);
  // Precompute stable anchor ids for headings (iteration 12) so the outline
  // sidebar can deep-link into a rendered document. anchorPrefix keeps ids
  // unique across multiple Markdown instances in one transcript.
  const anchors = headingAnchors(collectHeadingTexts(blocks));
  const cursor = { at: 0 };
  return <div className="md">{renderBlocks(blocks, 'md', anchorPrefix, anchors, cursor)}</div>;
}
