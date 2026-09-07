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

function splitWords(text: string) {
  return text.match(/[A-Za-z0-9_\u4e00-\u9fff]+/g) ?? [];
}

function toTitleCase(text: string) {
  return text.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}

function toWordParts(text: string) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9\u4e00-\u9fff]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function toCase(text: string, mode: string) {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  if (mode === 'title') return toTitleCase(text);
  const parts = toWordParts(text).map((part) => part.toLowerCase());
  if (mode === 'snake') return parts.join('_');
  if (mode === 'kebab') return parts.join('-');
  if (mode === 'camel') return parts.map((part, index) => index === 0 ? part : part[0].toUpperCase() + part.slice(1)).join('');
  return text;
}

export const trimTextTool: ToolDefinition<{ path?: string; text?: string; side: 'both' | 'start' | 'end' }> = {
  name: 'trim_text',
  description: 'Trim leading and/or trailing whitespace from inline text or a text file. Read-only.',
  inputHint: '{ "text": "  hello  ", "side": "both" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    return {
      ...textOrPath(input),
      side: record.side === 'start' || record.side === 'end' ? record.side : 'both',
    };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const output = input.side === 'start' ? text.trimStart() : input.side === 'end' ? text.trimEnd() : text.trim();
    return { ok: true, output, data: { before: text.length, after: output.length } };
  },
};

export const stripEmptyLinesTool: ToolDefinition<{ path?: string; text?: string }> = {
  name: 'strip_empty_lines',
  description: 'Remove empty or whitespace-only lines from inline text or a file. Read-only.',
  inputHint: '{ "path": "notes.txt" }',
  risk: 'read',
  validate: textOrPath,
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    return { ok: true, output: lines.join('\n'), data: { count: lines.length } };
  },
};

export const dedupeLinesTool: ToolDefinition<{ path?: string; text?: string }> = {
  name: 'dedupe_lines',
  description: 'Remove duplicate lines while preserving first-seen order. Read-only.',
  inputHint: '{ "text": "a\nb\na" }',
  risk: 'read',
  validate: textOrPath,
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const lines = text.split(/\r?\n/);
    const output = [...new Map(lines.map((line) => [line, line])).values()];
    return { ok: true, output: output.join('\n'), data: { count: output.length } };
  },
};

export const filterLinesTool: ToolDefinition<{ path?: string; text?: string; query: string; regex: boolean; invert: boolean; caseSensitive: boolean }> = {
  name: 'filter_lines',
  description: 'Keep or exclude lines matching a substring or regex. Useful for logs, lists, and quick grep-style filtering. Read-only.',
  inputHint: '{ "path": "app.log", "query": "ERROR", "invert": false }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.query !== 'string' || !record.query) throw new Error('query is required');
    return {
      ...textOrPath(input),
      query: record.query,
      regex: record.regex === true,
      invert: record.invert === true,
      caseSensitive: record.caseSensitive === true,
    };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const lines = text.split(/\r?\n/);
    const matcher = input.regex
      ? new RegExp(input.query, input.caseSensitive ? '' : 'i')
      : null;
    const kept = lines.filter((line) => {
      const hit = matcher ? matcher.test(line) : (input.caseSensitive ? line.includes(input.query) : line.toLowerCase().includes(input.query.toLowerCase()));
      return input.invert ? !hit : hit;
    });
    return { ok: true, output: kept.join('\n'), data: { count: kept.length } };
  },
};

export const textSliceTool: ToolDefinition<{ path?: string; text?: string; start: number; end?: number }> = {
  name: 'text_slice',
  description: 'Return a character slice from text or a file by start/end offsets. Read-only.',
  inputHint: '{ "text": "abcdef", "start": 1, "end": 4 }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.start !== 'number') throw new Error('start is required');
    return {
      ...textOrPath(input),
      start: Math.max(0, Math.floor(record.start)),
      end: typeof record.end === 'number' ? Math.max(0, Math.floor(record.end)) : undefined,
    };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    return { ok: true, output: text.slice(input.start, input.end), data: { start: input.start, end: input.end ?? text.length } };
  },
};

export const extractBetweenTool: ToolDefinition<{ path?: string; text?: string; startMarker: string; endMarker: string; includeMarkers: boolean; occurrence: number }> = {
  name: 'extract_between',
  description: 'Extract the text between two markers, using the Nth occurrence of the start marker. Read-only.',
  inputHint: '{ "text": "a[one]b[two]", "startMarker": "[", "endMarker": "]", "occurrence": 2 }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.startMarker !== 'string' || record.startMarker === '') throw new Error('startMarker is required');
    if (typeof record.endMarker !== 'string' || record.endMarker === '') throw new Error('endMarker is required');
    return {
      ...textOrPath(input),
      startMarker: record.startMarker,
      endMarker: record.endMarker,
      includeMarkers: record.includeMarkers === true,
      occurrence: typeof record.occurrence === 'number' && record.occurrence > 0 ? Math.floor(record.occurrence) : 1,
    };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    let cursor = 0;
    let start = -1;
    for (let i = 0; i < input.occurrence; i += 1) {
      start = text.indexOf(input.startMarker, cursor);
      if (start === -1) return { ok: false, output: `start marker not found for occurrence ${input.occurrence}` };
      cursor = start + input.startMarker.length;
    }
    const end = text.indexOf(input.endMarker, cursor);
    if (end === -1) return { ok: false, output: 'end marker not found after start marker' };
    const output = input.includeMarkers
      ? text.slice(start, end + input.endMarker.length)
      : text.slice(cursor, end);
    return { ok: true, output, data: { occurrence: input.occurrence } };
  },
};

export const textCaseTool: ToolDefinition<{ path?: string; text?: string; mode: 'upper' | 'lower' | 'title' | 'snake' | 'kebab' | 'camel' }> = {
  name: 'text_case',
  description: 'Convert text to upper/lower/title/snake/kebab/camel case. Read-only transform.',
  inputHint: '{ "text": "Hello world", "mode": "snake" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    const allowed = new Set(['upper', 'lower', 'title', 'snake', 'kebab', 'camel']);
    const mode = typeof record.mode === 'string' && allowed.has(record.mode) ? record.mode as 'upper' | 'lower' | 'title' | 'snake' | 'kebab' | 'camel' : 'lower';
    return { ...textOrPath(input), mode };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    return { ok: true, output: toCase(text, input.mode), data: { mode: input.mode } };
  },
};

export const reverseTextTool: ToolDefinition<{ path?: string; text?: string; mode: 'chars' | 'words' | 'lines' }> = {
  name: 'reverse_text',
  description: 'Reverse characters, words, or lines in text. Read-only transform.',
  inputHint: '{ "text": "a b c", "mode": "words" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    const mode = record.mode === 'words' || record.mode === 'lines' ? record.mode : 'chars';
    return { ...textOrPath(input), mode };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const output = input.mode === 'lines'
      ? text.split(/\r?\n/).reverse().join('\n')
      : input.mode === 'words'
        ? text.split(/\s+/).reverse().join(' ')
        : [...text].reverse().join('');
    return { ok: true, output, data: { mode: input.mode } };
  },
};

export const splitTextTool: ToolDefinition<{ path?: string; text?: string; separator: string; regex: boolean; maxItems: number }> = {
  name: 'split_text',
  description: 'Split text by a separator string or regex and return one item per line. Read-only.',
  inputHint: '{ "text": "a,b,c", "separator": "," }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    const separator = typeof record.separator === 'string' ? record.separator : '\n';
    const maxItems = typeof record.maxItems === 'number' && record.maxItems > 0 ? Math.min(Math.floor(record.maxItems), 10000) : 1000;
    return { ...textOrPath(input), separator, regex: record.regex === true, maxItems };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const pieces = (input.regex ? text.split(new RegExp(input.separator, 'g')) : text.split(input.separator)).slice(0, input.maxItems);
    return { ok: true, output: pieces.join('\n'), data: { count: pieces.length, items: pieces } };
  },
};

export const joinTextTool: ToolDefinition<{ items: string[]; separator: string }> = {
  name: 'join_text',
  description: 'Join an array of strings with a separator. Read-only transform.',
  inputHint: '{ "items": ["a", "b", "c"], "separator": ", " }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (!Array.isArray(record.items)) throw new Error('items must be an array');
    return {
      items: record.items.filter((item): item is string => typeof item === 'string'),
      separator: typeof record.separator === 'string' ? record.separator : '\n',
    };
  },
  async execute(input) {
    return { ok: true, output: input.items.join(input.separator), data: { count: input.items.length } };
  },
};

export const textFrequencyTool: ToolDefinition<{ path?: string; text?: string; mode: 'word' | 'char' | 'line'; topN: number; minLength: number }> = {
  name: 'text_frequency',
  description: 'Count the most frequent words, characters, or lines in text. Useful for quick corpus inspection and cleanup. Read-only.',
  inputHint: '{ "path": "notes.txt", "mode": "word", "topN": 20 }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    const mode = record.mode === 'char' || record.mode === 'line' ? record.mode : 'word';
    const topN = typeof record.topN === 'number' && record.topN > 0 ? Math.min(Math.floor(record.topN), 500) : 20;
    const minLength = typeof record.minLength === 'number' && record.minLength >= 0 ? Math.floor(record.minLength) : 1;
    return { ...textOrPath(input), mode, topN, minLength };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    const items = input.mode === 'char'
      ? [...text]
      : input.mode === 'line'
        ? text.split(/\r?\n/)
        : splitWords(text);
    const counts = new Map<string, number>();
    for (const item of items) {
      if (!item || item.length < input.minLength) continue;
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, input.topN);
    return {
      ok: true,
      output: ranked.length ? ranked.map(([item, count]) => `${count}\t${item}`).join('\n') : '(no items)',
      data: { mode: input.mode, count: ranked.length, ranked },
    };
  },
};

export const linePrefixTool: ToolDefinition<{ path?: string; text?: string; prefix: string }> = {
  name: 'line_prefix',
  description: 'Prefix every line with a string. Useful for quoting, commenting, or indenting text. Read-only transform.',
  inputHint: '{ "text": "a\nb", "prefix": "> " }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.prefix !== 'string') throw new Error('prefix is required');
    return { ...textOrPath(input), prefix: record.prefix };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    return { ok: true, output: text.split(/\r?\n/).map((line) => `${input.prefix}${line}`).join('\n') };
  },
};

export const lineSuffixTool: ToolDefinition<{ path?: string; text?: string; suffix: string }> = {
  name: 'line_suffix',
  description: 'Append a suffix to every line. Useful for adding delimiters, commas, or comments. Read-only transform.',
  inputHint: '{ "text": "a\nb", "suffix": "," }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.suffix !== 'string') throw new Error('suffix is required');
    return { ...textOrPath(input), suffix: record.suffix };
  },
  async execute(input, context) {
    const text = await resolveText(input, context.workspaceRoot);
    return { ok: true, output: text.split(/\r?\n/).map((line) => `${line}${input.suffix}`).join('\n') };
  },
};
