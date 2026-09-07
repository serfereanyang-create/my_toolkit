import type { ToolDefinition } from './types.js';

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

function parseNumbers(input: { numbers?: number[]; text?: string }): number[] {
  if (Array.isArray(input.numbers)) return input.numbers.filter((item) => typeof item === 'number' && Number.isFinite(item));
  if (typeof input.text === 'string') {
    return input.text.split(/[\s,;|]+/).map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  throw new Error('provide either numbers or text');
}

function numbersInput(input: unknown) {
  const record = asRecord(input);
  const numbers = Array.isArray(record.numbers) ? record.numbers as number[] : undefined;
  const text = typeof record.text === 'string' ? record.text : undefined;
  if (!numbers && !text) throw new Error('provide either numbers or text');
  return { numbers, text };
}

function quantile(sorted: number[], p: number) {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function parseDurationText(text: string) {
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi;
  let total = 0;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    total += unit === 'd' ? value * 86400000 : unit === 'h' ? value * 3600000 : unit === 'm' ? value * 60000 : unit === 's' ? value * 1000 : value;
  }
  return total;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const numberAbsTool: ToolDefinition<{ value: number }> = {
  name: 'number_abs', description: 'Return the absolute value of a number. Read-only.', inputHint: '{ "value": -3 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.value !== 'number') throw new Error('value is required'); return { value: record.value }; },
  async execute(input) { return { ok: true, output: String(Math.abs(input.value)) }; },
};

export const numberSignTool: ToolDefinition<{ value: number }> = {
  name: 'number_sign', description: 'Return the sign of a number as -1, 0, or 1. Read-only.', inputHint: '{ "value": -3 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.value !== 'number') throw new Error('value is required'); return { value: record.value }; },
  async execute(input) { return { ok: true, output: String(Math.sign(input.value)), data: { sign: Math.sign(input.value) } }; },
};

export const numberCompareTool: ToolDefinition<{ left: number; right: number }> = {
  name: 'number_compare', description: 'Compare two numbers and report whether left is less, equal, or greater. Read-only.', inputHint: '{ "left": 2, "right": 3 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.left !== 'number' || typeof record.right !== 'number') throw new Error('left and right are required'); return { left: record.left, right: record.right }; },
  async execute(input) { const relation = input.left < input.right ? 'less' : input.left > input.right ? 'greater' : 'equal'; return { ok: true, output: relation, data: { relation } }; },
};

export const numberSortTool: ToolDefinition<{ numbers?: number[]; text?: string; desc: boolean; unique: boolean }> = {
  name: 'number_sort', description: 'Sort a list of numbers ascending or descending, optionally deduplicated. Read-only.', inputHint: '{ "text": "3 1 2", "desc": false }', risk: 'read',
  validate(input) { const record = asRecord(input); return { ...numbersInput(input), desc: record.desc === true, unique: record.unique === true }; },
  async execute(input) { let numbers = parseNumbers(input).sort((a, b) => a - b); if (input.desc) numbers.reverse(); if (input.unique) numbers = [...new Set(numbers)]; return { ok: true, output: numbers.join('\n'), data: { count: numbers.length } }; },
};

export const numberUniqueTool: ToolDefinition<{ numbers?: number[]; text?: string }> = {
  name: 'number_unique', description: 'Deduplicate a list of numbers while preserving first-seen order. Read-only.', inputHint: '{ "numbers": [1,2,1] }', risk: 'read', validate: numbersInput,
  async execute(input) { const numbers = [...new Set(parseNumbers(input))]; return { ok: true, output: numbers.join('\n'), data: { count: numbers.length } }; },
};

export const numberProductTool: ToolDefinition<{ numbers?: number[]; text?: string }> = {
  name: 'number_product', description: 'Multiply a list of numbers together. Read-only.', inputHint: '{ "numbers": [2,3,4] }', risk: 'read', validate: numbersInput,
  async execute(input) { const numbers = parseNumbers(input); if (numbers.length === 0) return { ok: false, output: 'no numbers provided' }; const value = numbers.reduce((product, item) => product * item, 1); return { ok: true, output: String(value), data: { value } }; },
};

export const percentageChangeTool: ToolDefinition<{ from: number; to: number; digits: number }> = {
  name: 'percentage_change', description: 'Compute percentage change from one value to another. Read-only.', inputHint: '{ "from": 100, "to": 125 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.from !== 'number' || typeof record.to !== 'number') throw new Error('from and to are required'); return { from: record.from, to: record.to, digits: typeof record.digits === 'number' ? Math.max(0, Math.min(8, Math.floor(record.digits))) : 2 }; },
  async execute(input) { if (input.from === 0) return { ok: false, output: 'from cannot be zero' }; const value = ((input.to - input.from) / input.from) * 100; return { ok: true, output: `${value.toFixed(input.digits)}%`, data: { value } }; },
};

export const byteSizeFormatTool: ToolDefinition<{ bytes: number }> = {
  name: 'byte_size_format', description: 'Format a byte count into B/KB/MB/GB text. Read-only.', inputHint: '{ "bytes": 1536 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.bytes !== 'number') throw new Error('bytes is required'); return { bytes: record.bytes }; },
  async execute(input) { return { ok: true, output: formatBytes(input.bytes) }; },
};

export const durationParseTool: ToolDefinition<{ text: string }> = {
  name: 'duration_parse', description: 'Parse duration text like 1h 30m 5s into milliseconds. Read-only.', inputHint: '{ "text": "1h 30m" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.text !== 'string' || !record.text.trim()) throw new Error('text is required'); return { text: record.text.trim() }; },
  async execute(input) { const ms = parseDurationText(input.text); return ms > 0 ? { ok: true, output: String(ms), data: { ms } } : { ok: false, output: 'could not parse duration' }; },
};

export const numberRangeCheckTool: ToolDefinition<{ value: number; min: number; max: number }> = {
  name: 'number_range_check', description: 'Check whether a value falls inside an inclusive range. Read-only.', inputHint: '{ "value": 5, "min": 0, "max": 10 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.value !== 'number' || typeof record.min !== 'number' || typeof record.max !== 'number') throw new Error('value, min, and max are required'); return { value: record.value, min: record.min, max: record.max }; },
  async execute(input) { const min = Math.min(input.min, input.max); const max = Math.max(input.min, input.max); const inside = input.value >= min && input.value <= max; return { ok: true, output: inside ? 'true' : 'false', data: { inside, min, max } }; },
};

export const numberScaleTool: ToolDefinition<{ value: number; fromMin: number; fromMax: number; toMin: number; toMax: number }> = {
  name: 'number_scale', description: 'Linearly scale a value from one numeric range into another. Read-only.', inputHint: '{ "value": 5, "fromMin": 0, "fromMax": 10, "toMin": 0, "toMax": 100 }', risk: 'read',
  validate(input) { const record = asRecord(input); const keys = ['value', 'fromMin', 'fromMax', 'toMin', 'toMax'] as const; for (const key of keys) if (typeof record[key] !== 'number') throw new Error(`${key} is required`); return { value: record.value as number, fromMin: record.fromMin as number, fromMax: record.fromMax as number, toMin: record.toMin as number, toMax: record.toMax as number }; },
  async execute(input) { if (input.fromMax === input.fromMin) return { ok: false, output: 'fromMin and fromMax must differ' }; const ratio = (input.value - input.fromMin) / (input.fromMax - input.fromMin); const value = input.toMin + ratio * (input.toMax - input.toMin); return { ok: true, output: String(value), data: { value } }; },
};

export const numberModuloTool: ToolDefinition<{ left: number; right: number }> = {
  name: 'number_modulo', description: 'Compute left modulo right. Read-only.', inputHint: '{ "left": 10, "right": 3 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.left !== 'number' || typeof record.right !== 'number') throw new Error('left and right are required'); return { left: record.left, right: record.right }; },
  async execute(input) { if (input.right === 0) return { ok: false, output: 'right cannot be zero' }; return { ok: true, output: String(input.left % input.right) }; },
};

export const numberHistogramTool: ToolDefinition<{ numbers?: number[]; text?: string; bins: number }> = {
  name: 'number_histogram', description: 'Bucket numbers into N equal-width bins and report counts. Read-only.', inputHint: '{ "text": "1 2 3 4 5", "bins": 3 }', risk: 'read',
  validate(input) { const record = asRecord(input); return { ...numbersInput(input), bins: typeof record.bins === 'number' && record.bins > 0 ? Math.min(Math.floor(record.bins), 100) : 10 }; },
  async execute(input) { const numbers = parseNumbers(input); if (numbers.length === 0) return { ok: false, output: 'no numbers provided' }; const min = Math.min(...numbers); const max = Math.max(...numbers); const width = max === min ? 1 : (max - min) / input.bins; const counts = Array.from({ length: input.bins }, () => 0); for (const value of numbers) { const index = max === min ? 0 : Math.min(input.bins - 1, Math.floor((value - min) / width)); counts[index] += 1; } return { ok: true, output: counts.map((count, index) => `${index}\t${count}`).join('\n'), data: { min, max, counts } }; },
};

export const numberCumsumTool: ToolDefinition<{ numbers?: number[]; text?: string }> = {
  name: 'number_cumsum', description: 'Return cumulative sums for a list of numbers. Read-only.', inputHint: '{ "numbers": [1,2,3] }', risk: 'read', validate: numbersInput,
  async execute(input) { const out: number[] = []; let sum = 0; for (const value of parseNumbers(input)) { sum += value; out.push(sum); } return { ok: true, output: out.join('\n'), data: { values: out } }; },
};

export const numberPercentileTool: ToolDefinition<{ numbers?: number[]; text?: string; p: number }> = {
  name: 'number_percentile', description: 'Compute a percentile (0..100) from a list of numbers. Read-only.', inputHint: '{ "numbers": [1,2,3,4], "p": 90 }', risk: 'read',
  validate(input) { const record = asRecord(input); const p = typeof record.p === 'number' ? Math.max(0, Math.min(100, record.p)) : 50; return { ...numbersInput(input), p }; },
  async execute(input) { const sorted = parseNumbers(input).sort((a, b) => a - b); const value = quantile(sorted, input.p / 100); return Number.isFinite(value) ? { ok: true, output: String(value), data: { value } } : { ok: false, output: 'no numbers provided' }; },
};

export const linearInterpolateTool: ToolDefinition<{ x: number; x0: number; y0: number; x1: number; y1: number }> = {
  name: 'linear_interpolate', description: 'Linearly interpolate a y value at x between two points. Read-only.', inputHint: '{ "x": 5, "x0": 0, "y0": 0, "x1": 10, "y1": 100 }', risk: 'read',
  validate(input) { const record = asRecord(input); const keys = ['x', 'x0', 'y0', 'x1', 'y1'] as const; for (const key of keys) if (typeof record[key] !== 'number') throw new Error(`${key} is required`); return { x: record.x as number, x0: record.x0 as number, y0: record.y0 as number, x1: record.x1 as number, y1: record.y1 as number }; },
  async execute(input) { if (input.x1 === input.x0) return { ok: false, output: 'x0 and x1 must differ' }; const value = input.y0 + ((input.x - input.x0) * (input.y1 - input.y0)) / (input.x1 - input.x0); return { ok: true, output: String(value), data: { value } }; },
};
