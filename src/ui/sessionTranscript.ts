import type { SessionRecord } from '../session/store.js';
import { stripMarkdownDecorations } from '../ui/markdown.js';

/**
 * Compact plain transcript rebuilt from session — used when full-screen
 * painting the single Ask card so history never relies on fragile cursor math.
 */
export function formatSessionTranscript(session: SessionRecord, options?: { maxLines?: number; noColor?: boolean }): string {
  const maxLines = options?.maxLines ?? 36;
  const lines: string[] = [];

  for (const message of session.messages) {
    if (message.role === 'user') {
      const body = plain(message.content);
      if (!body.trim()) continue;
      lines.push('┌ you');
      for (const row of body.split('\n').slice(0, 8)) lines.push(`│ ${row}`);
      lines.push('└');
      lines.push('');
      continue;
    }
    if (message.role === 'assistant') {
      const body = plain(message.content);
      if (!body.trim()) continue;
      // Skip meta noise
      if (/^Model request failed/i.test(body)) {
        lines.push(`! ${body.split('\n')[0]}`);
        lines.push('');
        continue;
      }
      lines.push('· assistant');
      for (const row of body.split('\n').slice(0, 20)) lines.push(`  ${row}`);
      lines.push('');
      continue;
    }
    if (message.role === 'tool') {
      const name = message.name ?? 'tool';
      const preview = plain(message.content).split('\n').find((row) => row.trim()) ?? '';
      const short = preview.length > 90 ? `${preview.slice(0, 87)}...` : preview;
      lines.push(`· ${name}${short ? `  ${short}` : ''}`);
    }
  }

  // Keep only the newest window so the Ask card always fits.
  const clipped = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  return clipped.join('\n').replace(/\n+$/g, '');
}

function plain(text: string) {
  return stripMarkdownDecorations(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
