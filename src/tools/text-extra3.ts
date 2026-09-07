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

function lines(text: string) {
  return text.split(/\r?\n/);
}

function pad(text: string, width: number, side: 'start' | 'end' | 'both', fill: string) {
  if (side === 'start') return text.padStart(width, fill);
  if (side === 'both') {
    const total = Math.max(0, width - text.length);
    const left = Math.floor(total / 2);
    const right = total - left;
    return fill.repeat(Math.ceil(left / fill.length)).slice(0, left) + text + fill.repeat(Math.ceil(right / fill.length)).slice(0, right);
  }
  return text.padEnd(width, fill);
}

function compareText(left: string, right: string, caseSensitive: boolean) {
  const a = caseSensitive ? left : left.toLowerCase();
  const b = caseSensitive ? right : right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
}

export const textEqualsTool: ToolDefinition<{ left: string; right: string; caseSensitive: boolean }> = {
  name: 'text_equals', description: 'Check whether two strings are equal. Read-only.', inputHint: '{ "left": "a", "right": "A", "caseSensitive": false }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.left !== 'string' || typeof record.right !== 'string') throw new Error('left and right are required'); return { left: record.left, right: record.right, caseSensitive: record.caseSensitive === true }; },
  async execute(input) { const equal = compareText(input.left, input.right, input.caseSensitive) === 0; return { ok: true, output: equal ? 'true' : 'false', data: { equal } }; },
};

export const textCompareTool: ToolDefinition<{ left: string; right: string; caseSensitive: boolean }> = {
  name: 'text_compare', description: 'Compare two strings lexicographically and return -1, 0, or 1. Read-only.', inputHint: '{ "left": "a", "right": "b" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.left !== 'string' || typeof record.right !== 'string') throw new Error('left and right are required'); return { left: record.left, right: record.right, caseSensitive: record.caseSensitive === true }; },
  async execute(input) { const value = compareText(input.left, input.right, input.caseSensitive); return { ok: true, output: String(value), data: { value } }; },
};

export const textPadTool: ToolDefinition<{ path?: string; text?: string; width: number; side: 'start' | 'end' | 'both'; fill: string }> = {
  name: 'text_pad', description: 'Pad text to a target width using a fill string. Read-only transform.', inputHint: '{ "text": "7", "width": 3, "side": "start", "fill": "0" }', risk: 'read',
  validate(input) { const record = asRecord(input); const width = typeof record.width === 'number' ? Math.max(0, Math.min(100000, Math.floor(record.width))) : 0; const side = record.side === 'start' || record.side === 'both' ? record.side : 'end'; return { ...textOrPath(input), width, side, fill: typeof record.fill === 'string' && record.fill ? record.fill : ' ' }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); return { ok: true, output: pad(text, input.width, input.side, input.fill) }; },
};

export const textWrapTool: ToolDefinition<{ path?: string; text?: string; width: number }> = {
  name: 'text_wrap', description: 'Soft-wrap text at a fixed width. Read-only transform.', inputHint: '{ "text": "hello world", "width": 5 }', risk: 'read',
  validate(input) { const record = asRecord(input); const width = typeof record.width === 'number' && record.width > 0 ? Math.min(Math.floor(record.width), 10000) : 80; return { ...textOrPath(input), width }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const out: string[] = []; for (const line of lines(text)) { if (line.length <= input.width) { out.push(line); continue; } for (let i = 0; i < line.length; i += input.width) out.push(line.slice(i, i + input.width)); } return { ok: true, output: out.join('\n') }; },
};

export const textUnwrapTool: ToolDefinition<{ path?: string; text?: string }> = {
  name: 'text_unwrap', description: 'Collapse line breaks into spaces, producing a single paragraph. Read-only transform.', inputHint: '{ "path": "notes.txt" }', risk: 'read', validate: textOrPath,
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); return { ok: true, output: text.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim() }; },
};

export const textRemovePrefixTool: ToolDefinition<{ path?: string; text?: string; prefix: string; caseSensitive: boolean }> = {
  name: 'text_remove_prefix', description: 'Remove a prefix if present. Read-only transform.', inputHint: '{ "text": "prefix-value", "prefix": "prefix-" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.prefix !== 'string') throw new Error('prefix is required'); return { ...textOrPath(input), prefix: record.prefix, caseSensitive: record.caseSensitive === true }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const hit = input.caseSensitive ? text.startsWith(input.prefix) : text.toLowerCase().startsWith(input.prefix.toLowerCase()); return { ok: true, output: hit ? text.slice(input.prefix.length) : text }; },
};

export const textRemoveSuffixTool: ToolDefinition<{ path?: string; text?: string; suffix: string; caseSensitive: boolean }> = {
  name: 'text_remove_suffix', description: 'Remove a suffix if present. Read-only transform.', inputHint: '{ "text": "value.txt", "suffix": ".txt" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.suffix !== 'string') throw new Error('suffix is required'); return { ...textOrPath(input), suffix: record.suffix, caseSensitive: record.caseSensitive === true }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const hit = input.caseSensitive ? text.endsWith(input.suffix) : text.toLowerCase().endsWith(input.suffix.toLowerCase()); return { ok: true, output: hit ? text.slice(0, -input.suffix.length) : text }; },
};

export const nthLineTool: ToolDefinition<{ path?: string; text?: string; index: number }> = {
  name: 'nth_line', description: 'Return the Nth line (1-based). Read-only.', inputHint: '{ "path": "notes.txt", "index": 3 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.index !== 'number') throw new Error('index is required'); return { ...textOrPath(input), index: Math.max(1, Math.floor(record.index)) }; },
  async execute(input, context) { const all = lines(await resolveText(input, context.workspaceRoot)); return input.index <= all.length ? { ok: true, output: all[input.index - 1]! } : { ok: false, output: 'line index out of range' }; },
};

export const takeLinesTool: ToolDefinition<{ path?: string; text?: string; count: number }> = {
  name: 'take_lines', description: 'Take the first N lines. Read-only transform.', inputHint: '{ "path": "notes.txt", "count": 5 }', risk: 'read',
  validate(input) { const record = asRecord(input); return { ...textOrPath(input), count: typeof record.count === 'number' && record.count > 0 ? Math.min(Math.floor(record.count), 100000) : 10 }; },
  async execute(input, context) { return { ok: true, output: lines(await resolveText(input, context.workspaceRoot)).slice(0, input.count).join('\n') }; },
};

export const dropLinesTool: ToolDefinition<{ path?: string; text?: string; count: number }> = {
  name: 'drop_lines', description: 'Drop the first N lines and return the rest. Read-only transform.', inputHint: '{ "path": "notes.txt", "count": 5 }', risk: 'read',
  validate(input) { const record = asRecord(input); return { ...textOrPath(input), count: typeof record.count === 'number' && record.count > 0 ? Math.min(Math.floor(record.count), 100000) : 1 }; },
  async execute(input, context) { return { ok: true, output: lines(await resolveText(input, context.workspaceRoot)).slice(input.count).join('\n') }; },
};

export const lineContainsTool: ToolDefinition<{ path?: string; text?: string; needle: string; caseSensitive: boolean }> = {
  name: 'line_contains', description: 'Return only lines containing a substring. Read-only.', inputHint: '{ "path": "notes.txt", "needle": "TODO" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.needle !== 'string') throw new Error('needle is required'); return { ...textOrPath(input), needle: record.needle, caseSensitive: record.caseSensitive === true }; },
  async execute(input, context) { const source = await resolveText(input, context.workspaceRoot); const needle = input.caseSensitive ? input.needle : input.needle.toLowerCase(); const out = lines(source).filter((line) => (input.caseSensitive ? line : line.toLowerCase()).includes(needle)); return { ok: true, output: out.join('\n'), data: { count: out.length } }; },
};

export const textSlugifyTool: ToolDefinition<{ path?: string; text?: string }> = {
  name: 'text_slugify', description: 'Convert text into a URL-safe slug. Read-only transform.', inputHint: '{ "text": "Hello World!" }', risk: 'read', validate: textOrPath,
  async execute(input, context) { return { ok: true, output: slugify(await resolveText(input, context.workspaceRoot)) }; },
};

export const textSurroundTool: ToolDefinition<{ path?: string; text?: string; before: string; after: string }> = {
  name: 'text_surround', description: 'Wrap text with a prefix and suffix. Read-only transform.', inputHint: '{ "text": "name", "before": "[", "after": "]" }', risk: 'read',
  validate(input) { const record = asRecord(input); return { ...textOrPath(input), before: typeof record.before === 'string' ? record.before : '', after: typeof record.after === 'string' ? record.after : '' }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); return { ok: true, output: `${input.before}${text}${input.after}` }; },
};

export const textRepeatLinesTool: ToolDefinition<{ path?: string; text?: string; count: number }> = {
  name: 'text_repeat_lines', description: 'Repeat each line N times before moving to the next line. Read-only transform.', inputHint: '{ "text": "a\nb", "count": 2 }', risk: 'read',
  validate(input) { const record = asRecord(input); return { ...textOrPath(input), count: typeof record.count === 'number' && record.count > 0 ? Math.min(Math.floor(record.count), 1000) : 2 }; },
  async execute(input, context) { const out: string[] = []; for (const line of lines(await resolveText(input, context.workspaceRoot))) for (let i = 0; i < input.count; i += 1) out.push(line); return { ok: true, output: out.join('\n') }; },
};

export const textLengthTool: ToolDefinition<{ path?: string; text?: string; mode: 'chars' | 'bytes' | 'lines' | 'words' }> = {
  name: 'text_length', description: 'Measure text length as chars, bytes, lines, or words. Read-only.', inputHint: '{ "path": "notes.txt", "mode": "bytes" }', risk: 'read',
  validate(input) { const record = asRecord(input); const mode = record.mode === 'bytes' || record.mode === 'lines' || record.mode === 'words' ? record.mode : 'chars'; return { ...textOrPath(input), mode }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const value = input.mode === 'bytes' ? Buffer.byteLength(text, 'utf8') : input.mode === 'lines' ? lines(text).length : input.mode === 'words' ? (text.match(/\S+/g) ?? []).length : text.length; return { ok: true, output: String(value), data: { mode: input.mode, value } }; },
};

export const textIsEmptyTool: ToolDefinition<{ path?: string; text?: string; trim: boolean }> = {
  name: 'text_is_empty', description: 'Check whether text is empty, optionally after trimming whitespace. Read-only.', inputHint: '{ "text": "   ", "trim": true }', risk: 'read',
  validate(input) { const record = asRecord(input); return { ...textOrPath(input), trim: record.trim !== false }; },
  async execute(input, context) { const text = await resolveText(input, context.workspaceRoot); const value = input.trim ? text.trim() === '' : text === ''; return { ok: true, output: value ? 'true' : 'false', data: { empty: value } }; },
};
