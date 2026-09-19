/**
 * todoTracker.ts - Aggregate tracking-comment markers across a workspace.
 * Pure read-only text analysis over source files; nothing gets executed.
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export type TodoTag = 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'NOTE' | 'BUG';

export interface TodoItem {
  file: string;
  line: number;
  tag: TodoTag;
  content: string;
  author?: string;
  dateHint?: string;
}

export interface TodoReport {
  scannedFiles: number;
  items: TodoItem[];
  byTag: Record<string, number>;
  byFile: Array<{ file: string; count: number }>;
  byAuthor: Array<{ author: string; count: number }>;
  dated: TodoItem[];
}

const KNOWN_TAGS: TodoTag[] = ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG'];
const STRIP_CHARS = new Set([' ', '\t', ':', '-', '/']);

function isLetterCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function hasBoundary(line: string, start: number, end: number): boolean {
  if (start > 0 && isLetterCode(line.charCodeAt(start - 1))) return false;
  if (end < line.length && isLetterCode(line.charCodeAt(end))) return false;
  return true;
}

function stripLeadMarkers(raw: string): string {
  let p = 0;
  while (p < raw.length && STRIP_CHARS.has(raw[p]!)) p += 1;
  return raw.slice(p).trim();
}

function splitAuthor(after: string): { author: string | undefined; rest: string } {
  const open = after.charCodeAt(0) === 40; // '('
  if (!open) return { author: undefined, rest: after };
  const closeIdx = after.indexOf(')');
  if (closeIdx <= 0) return { author: undefined, rest: after };
  return { author: after.slice(1, closeIdx).trim(), rest: after.slice(closeIdx + 1) };
}

/** Detect YYYY-MM-DD anywhere in the string with manual digit scanning. */
function detectDateHint(line: string): string | undefined {
  for (let i = 0; i + 10 <= line.length; i++) {
    const c0 = line.charCodeAt(i);
    if (c0 < 48 || c0 > 57) continue;
    const seg = line.slice(i, i + 10);
    const isDigit = (ch: string) => ch >= '0' && ch <= '9';
    const valid =
      isDigit(seg[0]!) && isDigit(seg[1]!) && isDigit(seg[2]!) && isDigit(seg[3]!) &&
      (seg[4] === '-' || seg[4] === '/') &&
      isDigit(seg[5]!) && isDigit(seg[6]!) &&
      (seg[7] === '-' || seg[7] === '/') &&
      isDigit(seg[8]!) && isDigit(seg[9]!);
    if (valid) return seg;
  }
  return undefined;
}

function makeItem(filePath: string, lineNo: number, tag: TodoTag, line: string, afterTag: string): TodoItem {
  const parsed = splitAuthor(afterTag);
  return {
    file: filePath,
    line: lineNo,
    tag,
    content: stripLeadMarkers(parsed.rest),
    author: parsed.author,
    dateHint: detectDateHint(line),
  };
}

export function extractTodos(filePath: string, text: string): TodoItem[] {
  const out: TodoItem[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const tag of KNOWN_TAGS) {
      const idx = line.indexOf(tag);
      if (idx < 0) continue;
      if (!hasBoundary(line, idx, idx + tag.length)) continue;
      out.push(makeItem(filePath, i + 1, tag, line, line.slice(idx + tag.length)));
      break;
    }
  }
  return out;
}

export async function scanTodos(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<TodoReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);
  const items: TodoItem[] = [];
  for (const file of selected) {
    let text: string;
    try {
      text = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    items.push(...extractTodos(file, text));
  }

  const byTag: Record<string, number> = {};
  for (const it of items) byTag[it.tag] = (byTag[it.tag] ?? 0) + 1;

  const fileCount = new Map<string, number>();
  for (const it of items) fileCount.set(it.file, (fileCount.get(it.file) ?? 0) + 1);
  const byFile = [...fileCount.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count);

  const authorCount = new Map<string, number>();
  for (const it of items) {
    if (it.author) authorCount.set(it.author, (authorCount.get(it.author) ?? 0) + 1);
  }
  const byAuthor = [...authorCount.entries()]
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count);

  const dated = items
    .filter((it) => it.dateHint)
    .sort((a, b) => (a.dateHint! < b.dateHint! ? -1 : 1));

  return { scannedFiles: selected.length, items, byTag, byFile, byAuthor, dated };
}
