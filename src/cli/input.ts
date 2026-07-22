import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { assertUserTextWithinLimit, formatByteSize, utf8ByteLength } from './limits.js';

export type ReadTurnResult = {
  text: string;
  bytes: number;
  multiline: boolean;
};

/**
 * Read one user turn.
 * - Normal: single line, Enter submits (not bash line-continuation).
 * - Multiline: line that is only """ starts a block; next """ alone ends.
 * - /paste mode: collect until a line that is only "." or "/end".
 * Preserves original newlines; does not reflow or force-wrap input.
 */
export async function readUserTurn(rl: ReadlineInterface, prompt = 'aicode> '): Promise<ReadTurnResult | null> {
  const first = await rl.question(prompt);
  if (first === undefined || first === null) return null;
  const trimmedStart = first.trim();

  if (trimmedStart === '"""') {
    return readUntilMarker(rl, '"""', { includePromptLines: true });
  }
  if (trimmedStart === '/paste') {
    return readUntilMarker(rl, ['.', '/end'], { includePromptLines: true, pasteBanner: true });
  }

  // Single-line turn: keep full line including intentional trailing spaces except outer trim for empty check
  const text = first.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return { text: '', bytes: 0, multiline: false };
  const bytes = assertUserTextWithinLimit(text);
  return { text, bytes, multiline: false };
}

async function readUntilMarker(
  rl: ReadlineInterface,
  endMarkers: string | string[],
  options: { includePromptLines?: boolean; pasteBanner?: boolean } = {},
): Promise<ReadTurnResult> {
  const markers = Array.isArray(endMarkers) ? endMarkers : [endMarkers];
  if (options.pasteBanner) {
    process.stdout.write('(paste mode: keep original newlines; end with a line containing only . or /end)\n');
  } else {
    process.stdout.write('(multiline: keep original newlines; end with a line containing only """)\n');
  }
  const lines: string[] = [];
  while (true) {
    const line = await rl.question('... ');
    const normalized = line.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (markers.includes(normalized.trim())) break;
    lines.push(normalized);
  }
  const text = lines.join('\n');
  const bytes = assertUserTextWithinLimit(text);
  return { text, bytes, multiline: true };
}

export function foldTextByLines(text: string, maxLines = 12): { display: string; collapsed: boolean; totalLines: number; bytes: number } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // IMPORTANT: do not column-wrap (no bash-style forced reflow). Split only on real newlines.
  const lines = normalized.split('\n');
  const bytes = utf8ByteLength(normalized);
  if (lines.length <= maxLines) {
    return { display: normalized, collapsed: false, totalLines: lines.length, bytes };
  }
  const head = lines.slice(0, maxLines).join('\n');
  const more = lines.length - maxLines;
  return {
    display: `${head}\n… ${more} more line(s), total ${formatByteSize(bytes)} (original newlines preserved, not reflowed)`,
    collapsed: true,
    totalLines: lines.length,
    bytes,
  };
}

export function isSlashCommandLine(text: string) {
  const first = text.replace(/^\uFEFF/, '').trimStart();
  return first.startsWith('/');
}
