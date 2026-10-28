import { readFile } from 'node:fs/promises';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

function textOrPath(input: unknown): { path?: string; text?: string } {
  const record = asRecord(input);
  const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
  const text = typeof record.text === 'string' ? record.text : undefined;
  if (!path && text === undefined) throw new Error('provide either text or path');
  return { path, text };
}

async function resolveText(input: { path?: string; text?: string }, workspaceRoot: string): Promise<string> {
  if (typeof input.text === 'string') return input.text;
  return await readFile(resolveReadablePath(workspaceRoot, input.path!.trim()), 'utf8');
}

function commonPrefix(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return left.slice(0, index);
}

function commonSuffix(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(left.length - 1 - index) === right.charCodeAt(right.length - 1 - index)) index += 1;
  return left.slice(left.length - index);
}

function countOccurrences(haystack: string, needle: string, caseSensitive: boolean, overlap: boolean) {
  if (!needle) return 0;
  const source = caseSensitive ? haystack : haystack.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  let count = 0;
  let index = 0;
  while (index <= source.length - target.length) {
    const found = source.indexOf(target, index);
    if (found === -1) break;
    count += 1;
    index = found + (overlap ? 1 : target.length);
  }
  return count;
}

export const textContainsTool: ToolDefinition<{ path?: string; text?: string; needle: string; caseSensitive: boolean }> = {
  name: 'text_contains', description: 'Check whether text contains a substring. Read-only.', inputHint: '{ "text": "hello", "needle": "ell" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.needle !== 'string') throw new Error('needle is required'); return { ...textOrPath(input), needle: record.needle, caseSensitive: record.caseSensitive === true }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const hit = input.caseSensitive ? text.includes(input.needle) : text.toLowerCase().includes(input.needle.toLowerCase()); return { ok: true, output: hit ? 'true' : 'false', data: { contains: hit } }; },
};

export const textStartsWithTool: ToolDefinition<{ path?: string; text?: string; prefix: string; caseSensitive: boolean }> = {
  name: 'text_starts_with', description: 'Check whether text starts with a prefix. Read-only.', inputHint: '{ "text": "hello", "prefix": "he" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.prefix !== 'string') throw new Error('prefix is required'); return { ...textOrPath(input), prefix: record.prefix, caseSensitive: record.caseSensitive === true }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const value = input.caseSensitive ? text.startsWith(input.prefix) : text.toLowerCase().startsWith(input.prefix.toLowerCase()); return { ok: true, output: value ? 'true' : 'false', data: { startsWith: value } }; },
};

export const textEndsWithTool: ToolDefinition<{ path?: string; text?: string; suffix: string; caseSensitive: boolean }> = {
  name: 'text_ends_with', description: 'Check whether text ends with a suffix. Read-only.', inputHint: '{ "text": "hello", "suffix": "lo" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.suffix !== 'string') throw new Error('suffix is required'); return { ...textOrPath(input), suffix: record.suffix, caseSensitive: record.caseSensitive === true }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const value = input.caseSensitive ? text.endsWith(input.suffix) : text.toLowerCase().endsWith(input.suffix.toLowerCase()); return { ok: true, output: value ? 'true' : 'false', data: { endsWith: value } }; },
};

export const textRepeatTool: ToolDefinition<{ path?: string; text?: string; count: number; separator: string }> = {
  name: 'text_repeat', description: 'Repeat text N times with an optional separator. Read-only transform.', inputHint: '{ "text": "ha", "count": 3 }', risk: 'read',
  validate(input) { const record = asRecord(input); const count = typeof record.count === 'number' && record.count > 0 ? Math.min(Math.floor(record.count), 10000) : 1; return { ...textOrPath(input), count, separator: typeof record.separator === 'string' ? record.separator : '' }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); return { ok: true, output: Array.from({ length: input.count }, () => text).join(input.separator), data: { count: input.count } }; },
};

export const textTruncateTool: ToolDefinition<{ path?: string; text?: string; maxChars: number; ellipsis: string }> = {
  name: 'text_truncate', description: 'Truncate text to a maximum character count, adding an ellipsis suffix if needed. Read-only.', inputHint: '{ "text": "abcdef", "maxChars": 4 }', risk: 'read',
  validate(input) { const record = asRecord(input); const maxChars = typeof record.maxChars === 'number' && record.maxChars >= 0 ? Math.min(Math.floor(record.maxChars), 1000000) : 100; return { ...textOrPath(input), maxChars, ellipsis: typeof record.ellipsis === 'string' ? record.ellipsis : '...' }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); if (text.length <= input.maxChars) return { ok: true, output: text, data: { truncated: false } }; const room = Math.max(0, input.maxChars - input.ellipsis.length); return { ok: true, output: `${text.slice(0, room)}${input.ellipsis}`, data: { truncated: true } }; },
};

export const textIndexOfTool: ToolDefinition<{ path?: string; text?: string; needle: string; fromIndex: number; last: boolean; caseSensitive: boolean }> = {
  name: 'text_index_of', description: 'Find the first or last index of a substring in text. Read-only.', inputHint: '{ "text": "banana", "needle": "an" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.needle !== 'string') throw new Error('needle is required'); return { ...textOrPath(input), needle: record.needle, fromIndex: typeof record.fromIndex === 'number' ? Math.max(0, Math.floor(record.fromIndex)) : 0, last: record.last === true, caseSensitive: record.caseSensitive === true }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const source = input.caseSensitive ? text : text.toLowerCase(); const needle = input.caseSensitive ? input.needle : input.needle.toLowerCase(); const index = input.last ? source.lastIndexOf(needle, input.fromIndex || undefined) : source.indexOf(needle, input.fromIndex); return { ok: true, output: String(index), data: { index } }; },
};

export const charAtTool: ToolDefinition<{ path?: string; text?: string; index: number }> = {
  name: 'char_at', description: 'Return the character at a zero-based index. Read-only.', inputHint: '{ "text": "hello", "index": 1 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.index !== 'number') throw new Error('index is required'); return { ...textOrPath(input), index: Math.floor(record.index) }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); if (input.index < 0 || input.index >= text.length) return { ok: false, output: 'index out of range' }; return { ok: true, output: text[input.index]!, data: { index: input.index } }; },
};

export const commonPrefixTextTool: ToolDefinition<{ left: string; right: string }> = {
  name: 'common_prefix_text', description: 'Return the longest common prefix of two strings. Read-only.', inputHint: '{ "left": "foobar", "right": "foobaz" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.left !== 'string' || typeof record.right !== 'string') throw new Error('left and right are required'); return { left: record.left, right: record.right }; },
  async execute(input) { const output = commonPrefix(input.left, input.right); return { ok: true, output, data: { length: output.length } }; },
};

export const commonSuffixTextTool: ToolDefinition<{ left: string; right: string }> = {
  name: 'common_suffix_text', description: 'Return the longest common suffix of two strings. Read-only.', inputHint: '{ "left": "my-file.txt", "right": "your-file.txt" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.left !== 'string' || typeof record.right !== 'string') throw new Error('left and right are required'); return { left: record.left, right: record.right }; },
  async execute(input) { const output = commonSuffix(input.left, input.right); return { ok: true, output, data: { length: output.length } }; },
};

export const lineNumbersTool: ToolDefinition<{ path?: string; text?: string; start: number }> = {
  name: 'line_numbers', description: 'Prefix each line with a line number. Read-only transform.', inputHint: '{ "text": "a\\nb", "start": 1 }', risk: 'read',
  validate(input) { const record = asRecord(input); return { ...textOrPath(input), start: typeof record.start === 'number' ? Math.floor(record.start) : 1 }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const output = text.split(/\r?\n/).map((line, i) => `${input.start + i}\t${line}`).join('\n'); return { ok: true, output }; },
};

export const lineLengthsTool: ToolDefinition<{ path?: string; text?: string }> = {
  name: 'line_lengths', description: 'Return the character length of each line. Read-only.', inputHint: '{ "path": "notes.txt" }', risk: 'read',
  validate: textOrPath,
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const lines = text.split(/\r?\n/); return { ok: true, output: lines.map((line, i) => `${i + 1}\t${line.length}`).join('\n'), data: { count: lines.length } }; },
};

export const longestLineTool: ToolDefinition<{ path?: string; text?: string }> = {
  name: 'longest_line', description: 'Return the longest line from text. Read-only.', inputHint: '{ "path": "notes.txt" }', risk: 'read', validate: textOrPath,
  async execute(input, context) { const lines = (await resolveText(input, context.workspaceRoot)).split(/\r?\n/); if (lines.length === 0) return { ok: true, output: '' }; let best = lines[0] ?? ''; let index = 0; lines.forEach((line, i) => { if (line.length > best.length) { best = line; index = i; } }); return { ok: true, output: best, data: { line: index + 1, length: best.length } }; },
};

export const shortestLineTool: ToolDefinition<{ path?: string; text?: string; skipEmpty: boolean }> = {
  name: 'shortest_line', description: 'Return the shortest line from text, optionally skipping empty lines. Read-only.', inputHint: '{ "path": "notes.txt", "skipEmpty": true }', risk: 'read',
  validate(input) { const record = asRecord(input); return { ...textOrPath(input), skipEmpty: record.skipEmpty === true }; },
  async execute(input, context) { let lines = (await resolveText(input, context.workspaceRoot)).split(/\r?\n/); if (input.skipEmpty) lines = lines.filter((line) => line.length > 0); if (lines.length === 0) return { ok: false, output: 'no lines available' }; let best = lines[0] ?? ''; lines.forEach((line) => { if (line.length < best.length) best = line; }); return { ok: true, output: best, data: { length: best.length } }; },
};

export const firstNonemptyLineTool: ToolDefinition<{ path?: string; text?: string }> = {
  name: 'first_nonempty_line', description: 'Return the first non-empty line. Read-only.', inputHint: '{ "path": "notes.txt" }', risk: 'read', validate: textOrPath,
  async execute(input, context) { const line = (await resolveText(input, context.workspaceRoot)).split(/\r?\n/).find((item) => item.trim() !== ''); return line !== undefined ? { ok: true, output: line } : { ok: false, output: 'no non-empty line found' }; },
};

export const lastNonemptyLineTool: ToolDefinition<{ path?: string; text?: string }> = {
  name: 'last_nonempty_line', description: 'Return the last non-empty line. Read-only.', inputHint: '{ "path": "notes.txt" }', risk: 'read', validate: textOrPath,
  async execute(input, context) { const lines = (await resolveText(input, context.workspaceRoot)).split(/\r?\n/); for (let i = lines.length - 1; i >= 0; i -= 1) { if (lines[i]!.trim() !== '') return { ok: true, output: lines[i]! }; } return { ok: false, output: 'no non-empty line found' }; },
};

export const countSubstringTool: ToolDefinition<{ path?: string; text?: string; needle: string; caseSensitive: boolean; overlap: boolean }> = {
  name: 'count_substring', description: 'Count how many times a substring appears in text. Read-only.', inputHint: '{ "text": "banana", "needle": "an" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.needle !== 'string' || !record.needle) throw new Error('needle is required'); return { ...textOrPath(input), needle: record.needle, caseSensitive: record.caseSensitive === true, overlap: record.overlap === true }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const count = countOccurrences(text, input.needle, input.caseSensitive, input.overlap); return { ok: true, output: String(count), data: { count } }; },
};
