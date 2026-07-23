/**
 * Strip common Markdown decorations from terminal-facing text.
 * Users asked not to see **bold** or ## headings in CLI output.
 */
export function stripMarkdownDecorations(text: string): string {
  if (!text) return text;
  let out = text;
  // Fenced code blocks: keep inner text, drop ``` fences
  out = out.replace(/```[a-zA-Z0-9_-]*\r?\n?([\s\S]*?)```/g, '$1');
  // Bold / strong (repeat until stable for nested-ish cases)
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
    if (next === out) break;
    out = next;
  }
  // Headings at line start: ## Title -> Title
  out = out.replace(/^#{1,6}[ \t]+/gm, '');
  // Inline leftover heading markers users dislike seeing: "和 ## 标题" -> "和 标题"
  out = out.replace(/(^|[\s，。；;:：])#{1,6}[ \t]+/g, '$1');
  // Any remaining ** markers
  out = out.replace(/\*\*/g, '');
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
    // Keep a short tail that might be an incomplete marker (** or ## at EOL).
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
  const match = text.match(/(\*{1,2}|#{1,6})$/);
  if (!match) return '';
  return match[1] ?? '';
}
