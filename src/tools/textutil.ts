import { readFile } from 'node:fs/promises';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/*
 * Read-only text analysis tools over workspace/Desktop files or inline text.
 * All accept either { path } (a readable file) or { text } (inline). They never
 * write, so risk is 'read'.
 */

async function resolveText(input: { path?: string; text?: string }, workspaceRoot: string): Promise<string> {
  if (typeof input.text === 'string') return input.text;
  if (typeof input.path === 'string' && input.path.trim()) {
    return await readFile(resolveReadablePath(workspaceRoot, input.path.trim()), 'utf8');
  }
  throw new Error('provide either text or path');
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

function textOrPath(input: unknown): { path?: string; text?: string } {
  const record = asRecord(input);
  const path = typeof record.path === 'string' ? record.path : undefined;
  const text = typeof record.text === 'string' ? record.text : undefined;
  if (!path && text === undefined) throw new Error('provide either text or path');
  return { path, text };
}

export const wordCountTool: ToolDefinition<{ path?: string; text?: string }> = {
  name: 'word_count',
  description: 'Count lines, words, characters (and CJK characters) of inline text or a file. Read-only.',
  inputHint: '{ "path": "README.md" }  or  { "text": "..." }',
  risk: 'read',
  validate: textOrPath,
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const lines = text === '' ? 0 : text.split(/\r?\n/).length;
    const words = (text.match(/\S+/g) ?? []).length;
    const chars = text.length;
    const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    return {
      ok: true,
      output: `lines: ${lines}\nwords: ${words}\nchars: ${chars}\ncjk: ${cjk}`,
      data: { lines, words, chars, cjk },
    };
  },
};

export const headTailTool: ToolDefinition<{ path?: string; text?: string; lines: number; mode: 'head' | 'tail' }> = {
  name: 'head_tail',
  description: 'Return the first or last N lines of text or a file. Read-only.',
  inputHint: '{ "path": "log.txt", "lines": 20, "mode": "tail" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    const base = textOrPath(input);
    const lines = typeof record.lines === 'number' && record.lines > 0 ? Math.min(Math.floor(record.lines), 100000) : 10;
    const mode = record.mode === 'tail' ? 'tail' : 'head';
    return { ...base, lines, mode };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const all = text.split(/\r?\n/);
    const picked = input.mode === 'tail' ? all.slice(-input.lines) : all.slice(0, input.lines);
    return { ok: true, output: picked.join('\n'), data: { mode: input.mode, lines: picked.length } };
  },
};

export const sortLinesTool: ToolDefinition<{ path?: string; text?: string; unique: boolean; numeric: boolean; reverse: boolean }> = {
  name: 'sort_lines',
  description: 'Sort the lines of text or a file, optionally unique/numeric/reverse. Returns the sorted text. Read-only.',
  inputHint: '{ "text": "b\\na\\nb", "unique": true }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    return {
      ...textOrPath(input),
      unique: record.unique === true,
      numeric: record.numeric === true,
      reverse: record.reverse === true,
    };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    let lines = text.split(/\r?\n/);
    lines.sort(input.numeric ? (a, b) => Number(a) - Number(b) : (a, b) => a.localeCompare(b));
    if (input.reverse) lines.reverse();
    if (input.unique) lines = [...new Map(lines.map((l) => [l, l])).values()];
    return { ok: true, output: lines.join('\n'), data: { count: lines.length } };
  },
};

export const replaceTextTool: ToolDefinition<{ text: string; search: string; replace: string; regex: boolean }> = {
  name: 'replace_text',
  description: 'Replace all occurrences of a substring or regex in inline text and return the result. Does not touch files (use apply_patch for that). Read-only.',
  inputHint: '{ "text": "a-b-c", "search": "-", "replace": "_" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.text !== 'string') throw new Error('text is required');
    if (typeof record.search !== 'string' || record.search === '') throw new Error('search is required');
    return {
      text: record.text,
      search: record.search,
      replace: typeof record.replace === 'string' ? record.replace : '',
      regex: record.regex === true,
    };
  },
  async execute(input) {
    let result: string;
    let count = 0;
    if (input.regex) {
      const re = new RegExp(input.search, 'g');
      result = input.text.replace(re, () => { count += 1; return input.replace; });
    } else {
      const parts = input.text.split(input.search);
      count = parts.length - 1;
      result = parts.join(input.replace);
    }
    return { ok: true, output: result, data: { replacements: count } };
  },
};

export const extractMatchesTool: ToolDefinition<{ path?: string; text?: string; pattern: string; maxMatches: number }> = {
  name: 'extract_matches',
  description: 'Extract all regex matches from text or a file (e.g. emails, URLs, numbers). Read-only.',
  inputHint: '{ "path": "page.txt", "pattern": "https?://[^\\\\s]+" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.pattern !== 'string' || record.pattern === '') throw new Error('pattern is required');
    const maxMatches = typeof record.maxMatches === 'number' && record.maxMatches > 0 ? Math.min(Math.floor(record.maxMatches), 5000) : 500;
    return { ...textOrPath(input), pattern: record.pattern, maxMatches };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const re = new RegExp(input.pattern, 'g');
    const found: string[] = [];
    for (const m of text.matchAll(re)) {
      found.push(m[0]);
      if (found.length >= input.maxMatches) break;
    }
    return { ok: true, output: found.length ? found.join('\n') : '(no matches)', data: { count: found.length, matches: found } };
  },
};
