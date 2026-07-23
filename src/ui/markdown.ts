/**
 * Strip common Markdown decorations from terminal-facing text.
 * Users asked not to see **bold** or ## headings in CLI output.
 */
export function stripMarkdownDecorations(text: string): string {
  if (!text) return text;
  let out = text.replace(/\r\n/g, '\n');

  // Fenced code blocks: keep inner text, drop ``` fences
  out = out.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1');

  // Bold / strong — also handle fullwidth asterisks sometimes pasted in
  out = out.replace(/＊/g, '*');
  for (let i = 0; i < 6; i += 1) {
    const next = out
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      // ** around CJK/en without needing non-star class greed issues
      .replace(/\*\*((?:[^*\n]|\*(?!\*))+?)\*\*/g, '$1');
    if (next === out) break;
    out = next;
  }

  // Headings: start of line, optional indent
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  // Inline heading leftovers: "和 ## 标题" / "：### A."
  out = out.replace(/(^|[\s，。；;:：、（(【\[])#{1,6}[ \t]+/g, '$1');
  // Table separator rows that look noisy: |---|---:|
  out = out.replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/gm, '');

  // Any remaining ** markers users hate seeing
  out = out.replace(/\*\*/g, '');
  // Lone markdown heading hashes still left at line starts
  out = out.replace(/^[ \t]{0,3}#{1,6}\s*$/gm, '');

  return out;
}

/**
 * Streaming-safe stripper: holds trailing incomplete markdown markers until more text arrives.
 */
export class MarkdownStreamCleaner {
  private pending = '';

  push(chunk: string): string {
    if (!chunk) return '';
    const combined = `${this.pending}${chunk}`;
    const hold = holdTail(combined);
    const ready = combined.slice(0, combined.length - hold.length);
    this.pending = hold;
    return stripMarkdownDecorations(ready);
  }

  flush(): string {
    if (!this.pending) return '';
    const out = stripMarkdownDecorations(this.pending);
    this.pending = '';
    return out;
  }
}

function holdTail(text: string): string {
  // Hold trailing * or # sequences that may complete next chunk.
  const match = text.match(/(\*{1,8}|#{1,6})$/);
  if (!match) return '';
  return match[1] ?? '';
}
