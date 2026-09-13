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
  | { kind: 'ol'; items: string[] }
  | { kind: 'p'; text: string };

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
      i++; // skip closing fence
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

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ol', items });
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
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', text: para.join(' ') });
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
              <ol key={idx} className="md-list">
                {block.items.map((it, j) => <li key={j}>{renderInline(it, `ol${idx}-${j}`)}</li>)}
              </ol>
            );
          default:
            return <p key={idx} className="md-p">{renderInline(block.text, `p${idx}`)}</p>;
        }
      })}
    </div>
  );
}
