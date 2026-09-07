import type { ToolDefinition } from './types.js';

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

function parseNumbers(input: { numbers?: number[]; text?: string }): number[] {
  if (Array.isArray(input.numbers)) return input.numbers.filter((item) => typeof item === 'number' && Number.isFinite(item));
  if (typeof input.text === 'string') {
    return input.text
      .split(/[\s,;|]+/)
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
  }
  throw new Error('provide either numbers or text');
}

function median(numbers: number[]) {
  if (numbers.length === 0) return NaN;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b);
}

function parseByteSize(text: string) {
  const match = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) throw new Error('could not parse byte size');
  const value = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const scale = unit === 'tb' ? 1024 ** 4 : unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
  return Math.round(value * scale);
}

function humanDuration(ms: number) {
  const sign = ms < 0 ? '-' : '';
  let remaining = Math.abs(ms);
  const days = Math.floor(remaining / 86400000); remaining -= days * 86400000;
  const hours = Math.floor(remaining / 3600000); remaining -= hours * 3600000;
  const minutes = Math.floor(remaining / 60000); remaining -= minutes * 60000;
  const seconds = Math.floor(remaining / 1000); remaining -= seconds * 1000;
  const parts = [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    minutes ? `${minutes}m` : '',
    seconds ? `${seconds}s` : '',
    remaining ? `${remaining}ms` : '',
  ].filter(Boolean);
  return sign + (parts.join(' ') || '0ms');
}

function numbersInput(input: unknown) {
  const record = asRecord(input);
  const numbers = Array.isArray(record.numbers) ? record.numbers as number[] : undefined;
  const text = typeof record.text === 'string' ? record.text : undefined;
  if (!numbers && !text) throw new Error('provide either numbers or text');
  return { numbers, text };
}

export const numberSumTool: ToolDefinition<{ numbers?: number[]; text?: string }> = {
  name: 'number_sum',
  description: 'Sum a list of numbers given directly or as whitespace/comma-separated text. Read-only.',
  inputHint: '{ "numbers": [1,2,3] } or { "text": "1, 2, 3" }',
  risk: 'read', validate: numbersInput,
  async execute(input) {
    const numbers = parseNumbers(input); const value = numbers.reduce((sum, n) => sum + n, 0);
    return { ok: true, output: String(value), data: { count: numbers.length, value } };
  },
};

export const numberAverageTool: ToolDefinition<{ numbers?: number[]; text?: string }> = {
  name: 'number_average', description: 'Compute the arithmetic mean of numbers. Read-only.', inputHint: '{ "numbers": [1,2,3] }', risk: 'read', validate: numbersInput,
  async execute(input) { const numbers = parseNumbers(input); const value = numbers.length ? numbers.reduce((s, n) => s + n, 0) / numbers.length : NaN; return Number.isFinite(value) ? { ok: true, output: String(value), data: { count: numbers.length, value } } : { ok: false, output: 'no numbers provided' }; },
};

export const numberMedianTool: ToolDefinition<{ numbers?: number[]; text?: string }> = {
  name: 'number_median', description: 'Compute the median of numbers. Read-only.', inputHint: '{ "numbers": [1,3,2] }', risk: 'read', validate: numbersInput,
  async execute(input) { const numbers = parseNumbers(input); const value = median(numbers); return Number.isFinite(value) ? { ok: true, output: String(value), data: { count: numbers.length, value } } : { ok: false, output: 'no numbers provided' }; },
};

export const numberMinMaxTool: ToolDefinition<{ numbers?: number[]; text?: string }> = {
  name: 'number_min_max', description: 'Return the minimum and maximum values from a number list. Read-only.', inputHint: '{ "numbers": [5,1,9] }', risk: 'read', validate: numbersInput,
  async execute(input) { const numbers = parseNumbers(input); if (numbers.length === 0) return { ok: false, output: 'no numbers provided' }; const min = Math.min(...numbers); const max = Math.max(...numbers); return { ok: true, output: `min: ${min}\nmax: ${max}`, data: { min, max } }; },
};

export const numberStatsTool: ToolDefinition<{ numbers?: number[]; text?: string }> = {
  name: 'number_stats', description: 'Compute count, sum, average, median, min, max, and range for numbers. Read-only.', inputHint: '{ "text": "1 2 3 4" }', risk: 'read', validate: numbersInput,
  async execute(input) {
    const numbers = parseNumbers(input);
    if (numbers.length === 0) return { ok: false, output: 'no numbers provided' };
    const sum = numbers.reduce((s, n) => s + n, 0);
    const avg = sum / numbers.length;
    const med = median(numbers);
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    return { ok: true, output: `count: ${numbers.length}\nsum: ${sum}\navg: ${avg}\nmedian: ${med}\nmin: ${min}\nmax: ${max}\nrange: ${max - min}`, data: { count: numbers.length, sum, avg, median: med, min, max, range: max - min } };
  },
};

export const roundNumberTool: ToolDefinition<{ value: number; digits: number; mode: 'round' | 'floor' | 'ceil' | 'trunc' }> = {
  name: 'round_number', description: 'Round a number to a fixed number of decimal digits using round/floor/ceil/trunc. Read-only.', inputHint: '{ "value": 3.14159, "digits": 2 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.value !== 'number') throw new Error('value is required'); return { value: record.value, digits: typeof record.digits === 'number' ? Math.max(0, Math.min(12, Math.floor(record.digits))) : 0, mode: record.mode === 'floor' || record.mode === 'ceil' || record.mode === 'trunc' ? record.mode : 'round' }; },
  async execute(input) { const factor = 10 ** input.digits; const raw = input.value * factor; const value = input.mode === 'floor' ? Math.floor(raw) / factor : input.mode === 'ceil' ? Math.ceil(raw) / factor : input.mode === 'trunc' ? Math.trunc(raw) / factor : Math.round(raw) / factor; return { ok: true, output: String(value), data: { value } }; },
};

export const clampNumberTool: ToolDefinition<{ value: number; min: number; max: number }> = {
  name: 'clamp_number', description: 'Clamp a value into a [min, max] range. Read-only.', inputHint: '{ "value": 15, "min": 0, "max": 10 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.value !== 'number' || typeof record.min !== 'number' || typeof record.max !== 'number') throw new Error('value, min, and max are required'); return { value: record.value, min: record.min, max: record.max }; },
  async execute(input) { const min = Math.min(input.min, input.max); const max = Math.max(input.min, input.max); const value = Math.min(max, Math.max(min, input.value)); return { ok: true, output: String(value), data: { value, min, max } }; },
};

export const percentageOfTool: ToolDefinition<{ part: number; whole: number; digits: number }> = {
  name: 'percentage_of', description: 'Compute part/whole as a percentage. Read-only.', inputHint: '{ "part": 25, "whole": 80, "digits": 1 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.part !== 'number' || typeof record.whole !== 'number') throw new Error('part and whole are required'); return { part: record.part, whole: record.whole, digits: typeof record.digits === 'number' ? Math.max(0, Math.min(8, Math.floor(record.digits))) : 1 }; },
  async execute(input) { if (input.whole === 0) return { ok: false, output: 'whole cannot be zero' }; const value = (input.part / input.whole) * 100; return { ok: true, output: `${value.toFixed(input.digits)}%`, data: { value } }; },
};

export const sequenceGenerateTool: ToolDefinition<{ start: number; end: number; step: number }> = {
  name: 'sequence_generate', description: 'Generate a numeric sequence from start to end inclusive by step. Read-only.', inputHint: '{ "start": 1, "end": 10, "step": 2 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.start !== 'number' || typeof record.end !== 'number') throw new Error('start and end are required'); const step = typeof record.step === 'number' && record.step !== 0 ? record.step : (record.end as number) >= (record.start as number) ? 1 : -1; return { start: record.start, end: record.end, step }; },
  async execute(input) { const values: number[] = []; if (input.step > 0) for (let n = input.start; n <= input.end && values.length < 100000; n += input.step) values.push(n); else for (let n = input.start; n >= input.end && values.length < 100000; n += input.step) values.push(n); return { ok: true, output: values.join('\n'), data: { count: values.length, values } }; },
};

export const baseConvertTool: ToolDefinition<{ value: string; fromBase: number; toBase: number }> = {
  name: 'base_convert', description: 'Convert an integer string from one base to another (2..36). Read-only.', inputHint: '{ "value": "ff", "fromBase": 16, "toBase": 10 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.value !== 'string') throw new Error('value is required'); const fromBase = typeof record.fromBase === 'number' ? Math.max(2, Math.min(36, Math.floor(record.fromBase))) : 10; const toBase = typeof record.toBase === 'number' ? Math.max(2, Math.min(36, Math.floor(record.toBase))) : 10; return { value: record.value.trim(), fromBase, toBase }; },
  async execute(input) { const parsed = parseInt(input.value, input.fromBase); if (Number.isNaN(parsed)) return { ok: false, output: 'could not parse value in fromBase' }; return { ok: true, output: parsed.toString(input.toBase), data: { decimal: parsed } }; },
};

export const parseByteSizeTool: ToolDefinition<{ text: string }> = {
  name: 'parse_byte_size', description: 'Parse byte-size text like 1.5GB, 256KB, or 42B into bytes. Read-only.', inputHint: '{ "text": "1.5GB" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.text !== 'string' || !record.text.trim()) throw new Error('text is required'); return { text: record.text.trim() }; },
  async execute(input) { const bytes = parseByteSize(input.text); return { ok: true, output: String(bytes), data: { bytes } }; },
};

export const formatDurationTool: ToolDefinition<{ ms?: number; seconds?: number }> = {
  name: 'format_duration', description: 'Format milliseconds or seconds into a readable duration like 1h 2m 3s. Read-only.', inputHint: '{ "seconds": 3661 }', risk: 'read',
  validate(input) { const record = asRecord(input); const ms = typeof record.ms === 'number' ? record.ms : typeof record.seconds === 'number' ? record.seconds * 1000 : undefined; if (ms === undefined) throw new Error('provide ms or seconds'); return { ms }; },
  async execute(input) { return { ok: true, output: humanDuration(input.ms!), data: { ms: input.ms } }; },
};

export const ratioSimplifyTool: ToolDefinition<{ left: number; right: number }> = {
  name: 'ratio_simplify', description: 'Simplify a numeric ratio using the greatest common divisor. Read-only.', inputHint: '{ "left": 1920, "right": 1080 }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.left !== 'number' || typeof record.right !== 'number') throw new Error('left and right are required'); return { left: Math.round(record.left), right: Math.round(record.right) }; },
  async execute(input) { if (input.left === 0 && input.right === 0) return { ok: false, output: 'ratio 0:0 is undefined' }; const d = gcd(input.left, input.right) || 1; const left = input.left / d; const right = input.right / d; return { ok: true, output: `${left}:${right}`, data: { left, right } }; },
};
