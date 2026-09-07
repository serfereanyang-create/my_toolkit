import type { ToolDefinition } from './types.js';

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

function listInput(input: unknown) {
  const record = asRecord(input);
  if (!Array.isArray(record.items)) throw new Error('items must be an array');
  return { items: record.items };
}

function asStrings(items: unknown[]) {
  return items.map((item) => typeof item === 'string' ? item : JSON.stringify(item));
}

export const listCountTool: ToolDefinition<{ items: unknown[] }> = {
  name: 'list_count', description: 'Count the number of items in an array. Read-only.', inputHint: '{ "items": [1,2,3] }', risk: 'read', validate: listInput,
  async execute(input) { return { ok: true, output: String(input.items.length), data: { count: input.items.length } }; },
};

export const listUniqueTool: ToolDefinition<{ items: unknown[] }> = {
  name: 'list_unique', description: 'Deduplicate array items by JSON/string value while preserving order. Read-only.', inputHint: '{ "items": ["a","b","a"] }', risk: 'read', validate: listInput,
  async execute(input) { const seen = new Set<string>(); const out: unknown[] = []; for (const item of input.items) { const key = typeof item === 'string' ? `s:${item}` : JSON.stringify(item); if (seen.has(key)) continue; seen.add(key); out.push(item); } return { ok: true, output: JSON.stringify(out, null, 2), data: { count: out.length, items: out } }; },
};

export const listSortTool: ToolDefinition<{ items: unknown[]; numeric: boolean; reverse: boolean }> = {
  name: 'list_sort', description: 'Sort array items lexicographically or numerically. Read-only.', inputHint: '{ "items": [3,1,2], "numeric": true }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.items)) throw new Error('items must be an array'); return { items: record.items, numeric: record.numeric === true, reverse: record.reverse === true }; },
  async execute(input) { const out = [...input.items]; out.sort(input.numeric ? (a, b) => Number(a) - Number(b) : (a, b) => String(a).localeCompare(String(b))); if (input.reverse) out.reverse(); return { ok: true, output: JSON.stringify(out, null, 2), data: { items: out } }; },
};

export const listReverseTool: ToolDefinition<{ items: unknown[] }> = {
  name: 'list_reverse', description: 'Reverse the order of array items. Read-only.', inputHint: '{ "items": [1,2,3] }', risk: 'read', validate: listInput,
  async execute(input) { const out = [...input.items].reverse(); return { ok: true, output: JSON.stringify(out, null, 2), data: { items: out } }; },
};

export const listSliceTool: ToolDefinition<{ items: unknown[]; start: number; end?: number }> = {
  name: 'list_slice', description: 'Slice an array by start/end indexes. Read-only.', inputHint: '{ "items": [1,2,3,4], "start": 1, "end": 3 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.items) || typeof record.start !== 'number') throw new Error('items and start are required'); return { items: record.items, start: Math.floor(record.start), end: typeof record.end === 'number' ? Math.floor(record.end) : undefined }; },
  async execute(input) { const out = input.items.slice(input.start, input.end); return { ok: true, output: JSON.stringify(out, null, 2), data: { items: out } }; },
};

export const listChunkTool: ToolDefinition<{ items: unknown[]; size: number }> = {
  name: 'list_chunk', description: 'Split an array into fixed-size chunks. Read-only.', inputHint: '{ "items": [1,2,3,4], "size": 2 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.items)) throw new Error('items must be an array'); const size = typeof record.size === 'number' && record.size > 0 ? Math.min(Math.floor(record.size), 10000) : 10; return { items: record.items, size }; },
  async execute(input) { const chunks: unknown[][] = []; for (let i = 0; i < input.items.length; i += input.size) chunks.push(input.items.slice(i, i + input.size)); return { ok: true, output: JSON.stringify(chunks, null, 2), data: { chunks } }; },
};

export const listUnionTool: ToolDefinition<{ left: unknown[]; right: unknown[] }> = {
  name: 'list_union', description: 'Return the union of two arrays, preserving first-seen order. Read-only.', inputHint: '{ "left": [1,2], "right": [2,3] }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.left) || !Array.isArray(record.right)) throw new Error('left and right must be arrays'); return { left: record.left, right: record.right }; },
  async execute(input) { const seen = new Set<string>(); const out: unknown[] = []; for (const item of [...input.left, ...input.right]) { const key = typeof item === 'string' ? `s:${item}` : JSON.stringify(item); if (seen.has(key)) continue; seen.add(key); out.push(item); } return { ok: true, output: JSON.stringify(out, null, 2), data: { items: out } }; },
};

export const listIntersectTool: ToolDefinition<{ left: unknown[]; right: unknown[] }> = {
  name: 'list_intersect', description: 'Return items that appear in both arrays. Read-only.', inputHint: '{ "left": [1,2], "right": [2,3] }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.left) || !Array.isArray(record.right)) throw new Error('left and right must be arrays'); return { left: record.left, right: record.right }; },
  async execute(input) { const right = new Set(input.right.map((item) => typeof item === 'string' ? `s:${item}` : JSON.stringify(item))); const out = input.left.filter((item) => right.has(typeof item === 'string' ? `s:${item}` : JSON.stringify(item))); return { ok: true, output: JSON.stringify(out, null, 2), data: { items: out } }; },
};

export const listDiffTool: ToolDefinition<{ left: unknown[]; right: unknown[] }> = {
  name: 'list_diff', description: 'Return items from the left array that do not appear in the right array. Read-only.', inputHint: '{ "left": [1,2,3], "right": [2] }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.left) || !Array.isArray(record.right)) throw new Error('left and right must be arrays'); return { left: record.left, right: record.right }; },
  async execute(input) { const right = new Set(input.right.map((item) => typeof item === 'string' ? `s:${item}` : JSON.stringify(item))); const out = input.left.filter((item) => !right.has(typeof item === 'string' ? `s:${item}` : JSON.stringify(item))); return { ok: true, output: JSON.stringify(out, null, 2), data: { items: out } }; },
};

export const listContainsTool: ToolDefinition<{ items: unknown[]; value: unknown }> = {
  name: 'list_contains', description: 'Check whether an array contains a value. Read-only.', inputHint: '{ "items": [1,2,3], "value": 2 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.items) || !('value' in record)) throw new Error('items and value are required'); return { items: record.items, value: record.value }; },
  async execute(input) { const target = typeof input.value === 'string' ? `s:${input.value}` : JSON.stringify(input.value); const contains = input.items.some((item) => (typeof item === 'string' ? `s:${item}` : JSON.stringify(item)) === target); return { ok: true, output: contains ? 'true' : 'false', data: { contains } }; },
};

export const listFrequencyTool: ToolDefinition<{ items: unknown[]; topN: number }> = {
  name: 'list_frequency', description: 'Count the most frequent values in an array. Read-only.', inputHint: '{ "items": ["a","b","a"], "topN": 10 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.items)) throw new Error('items must be an array'); return { items: record.items, topN: typeof record.topN === 'number' && record.topN > 0 ? Math.min(Math.floor(record.topN), 500) : 20 }; },
  async execute(input) { const counts = new Map<string, { value: unknown; count: number }>(); for (const item of input.items) { const key = typeof item === 'string' ? `s:${item}` : JSON.stringify(item); const entry = counts.get(key) ?? { value: item, count: 0 }; entry.count += 1; counts.set(key, entry); } const ranked = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, input.topN); return { ok: true, output: ranked.map((item) => `${item.count}\t${typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}`).join('\n') || '(no items)', data: { ranked } }; },
};

export const listJoinTool: ToolDefinition<{ items: unknown[]; separator: string }> = {
  name: 'list_join', description: 'Join array items into a string with a separator. Read-only transform.', inputHint: '{ "items": ["a","b"], "separator": ", " }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.items)) throw new Error('items must be an array'); return { items: record.items, separator: typeof record.separator === 'string' ? record.separator : '\n' }; },
  async execute(input) { return { ok: true, output: asStrings(input.items).join(input.separator) }; },
};

export const listIndexOfTool: ToolDefinition<{ items: unknown[]; value: unknown; last: boolean }> = {
  name: 'list_index_of', description: 'Find the first or last index of a value in an array. Read-only.', inputHint: '{ "items": ["a","b","a"], "value": "a", "last": true }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.items) || !('value' in record)) throw new Error('items and value are required'); return { items: record.items, value: record.value, last: record.last === true }; },
  async execute(input) { const target = typeof input.value === 'string' ? `s:${input.value}` : JSON.stringify(input.value); const indexes = input.items.map((item) => typeof item === 'string' ? `s:${item}` : JSON.stringify(item)); const index = input.last ? indexes.lastIndexOf(target) : indexes.indexOf(target); return { ok: true, output: String(index), data: { index } }; },
};

export const listFlattenTool: ToolDefinition<{ items: unknown[]; depth: number }> = {
  name: 'list_flatten', description: 'Flatten nested arrays to the given depth. Read-only transform.', inputHint: '{ "items": [1,[2,[3]]], "depth": 2 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.items)) throw new Error('items must be an array'); return { items: record.items, depth: typeof record.depth === 'number' && record.depth >= 0 ? Math.min(Math.floor(record.depth), 20) : 1 }; },
  async execute(input) { const output = input.items.flat(input.depth); return { ok: true, output: JSON.stringify(output, null, 2), data: { items: output } }; },
};

export const listZipTool2: ToolDefinition<{ left: unknown[]; right: unknown[] }> = {
  name: 'list_zip_pairs', description: 'Zip two arrays into index-aligned pairs. Read-only transform.', inputHint: '{ "left": [1,2], "right": ["a","b"] }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.left) || !Array.isArray(record.right)) throw new Error('left and right must be arrays'); return { left: record.left, right: record.right }; },
  async execute(input) { const length = Math.min(input.left.length, input.right.length); const pairs = Array.from({ length }, (_v, i) => [input.left[i], input.right[i]]); return { ok: true, output: JSON.stringify(pairs, null, 2), data: { pairs } }; },
};
