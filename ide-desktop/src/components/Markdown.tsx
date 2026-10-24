import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { slugifyHeading } from '../lib/markdownOutline';

/*
 * Minimal, dependency-free markdown renderer for assistant messages.
 * Supports fenced code blocks, inline code, bold/italic, headings, links,
 * unordered/ordered lists, and paragraphs. All text is rendered through React
 * children (never dangerouslySetInnerHTML), so raw HTML in the model output is
 * shown as literal text rather than being injected into the DOM.
 *
 * Iteration 12: headings get GitHub-style anchor ids (deduplicated per
 * document) so the outline panel's links can scroll to them.
 */

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  /** `start` preserves the number the model wrote — a loose list split by
   *  blank lines used to render every block from 1. */
  | { kind: 'ol'; items: string[]; start?: number }
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

export function parseBlocks(src: string): Block[] {
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

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        if (/^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i++;
          continue;
        }
        // Continue across a blank line only when another bullet follows:
        // models routinely put a blank line between bullets, and stopping
        // there split one list into a stack of one-item lists.
        if (!lines[i].trim() && i + 1 < lines.length && /^\s*[-*+]\s+/.test(lines[i + 1])) { i++; continue; }
        break;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const start = Number(line.match(/^\s*(\d+)\./)?.[1] ?? 1);
      const items: string[] = [];
      while (i < lines.length) {
        if (/^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
          continue;
        }
        if (!lines[i].trim() && i + 1 < lines.length && /^\s*\d+\.\s+/.test(lines[i + 1])) { i++; continue; }
        break;
      }
      blocks.push({ kind: 'ol', items, ...(start !== 1 ? { start } : {}) });
      continue;
    }

    // Paragraph (gather consecutive non-blank, non-structural lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
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

export function Markdown({ text, anchorPrefix }: { text: string; anchorPrefix?: string }) {
  const blocks = parseBlocks(text);
  // Precompute stable anchor ids for headings (iteration 12) so the outline
  // sidebar can deep-link into a rendered document. anchorPrefix keeps ids
  // unique across multiple Markdown instances in one transcript.
  const anchors = headingAnchors(blocks.filter((b): b is Extract<Block, { kind: 'heading' }> => b.kind === 'heading').map((b) => b.text));
  let anchorAt = 0;
  return (
    <div className="md">
      {blocks.map((block, idx) => {
        switch (block.kind) {
          case 'code':
            return (
              <pre key={idx} className="md-code-block" data-lang={block.lang || undefined}>
                <code>{block.text}</code>
              </pre>
            );
          case 'heading': {
            const Tag = (`h${Math.min(block.level + 2, 6)}`) as keyof JSX.IntrinsicElements;
            const base = anchors[anchorAt++] ?? `heading-${idx}`;
            const id = anchorPrefix ? `${anchorPrefix}--${base}` : base;
            return <Tag key={idx} id={id} className="md-heading">{renderInline(block.text, `h${idx}`)}</Tag>;
          }
          case 'ul':
            return (
              <ul key={idx} className="md-list">
                {block.items.map((it, j) => <li key={j}>{renderInline(it, `ul${idx}-${j}`)}</li>)}
              </ul>
            );
          case 'ol':
            return (
              <ol key={idx} className="md-list" start={block.start}>
                {block.items.map((it, j) => <li key={j}>{renderInline(it, `ol${idx}-${j}`)}</li>)}
              </ol>
            );
          case 'table':
            return (
              <div className="md-table-wrap" key={idx}>
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
              ? <pre key={idx} className="md-pre-text">{block.text}</pre>
              : <p key={idx} className="md-p">{renderInline(block.text, `p${idx}`)}</p>;
        }
      })}
    </div>
  );
}
