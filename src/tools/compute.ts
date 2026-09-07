import type { ToolDefinition } from './types.js';

/*
 * Date/time and safe arithmetic utilities. All read-only and pure — no file or
 * network access.
 */

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

export const currentDatetimeTool: ToolDefinition<{ timezone?: string }> = {
  name: 'current_datetime',
  description: 'Return the current date and time (ISO 8601 UTC plus local), and a Unix timestamp. Read-only.',
  inputHint: '{}',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return {};
    const record = asRecord(input);
    return { timezone: typeof record.timezone === 'string' ? record.timezone : undefined };
  },
  async execute(input) {
    const now = new Date();
    let local: string;
    try {
      local = input.timezone
        ? now.toLocaleString('sv-SE', { timeZone: input.timezone })
        : now.toLocaleString('sv-SE');
    } catch {
      local = now.toLocaleString('sv-SE');
    }
    const iso = now.toISOString();
    const unix = Math.floor(now.getTime() / 1000);
    return {
      ok: true,
      output: `iso_utc: ${iso}\nlocal: ${local}${input.timezone ? ` (${input.timezone})` : ''}\nunix: ${unix}`,
      data: { iso, local, unix },
    };
  },
};

export const dateDiffTool: ToolDefinition<{ from: string; to: string }> = {
  name: 'date_diff',
  description: 'Compute the difference between two dates (ISO 8601 or any Date-parsable string) in days/hours/minutes. Read-only.',
  inputHint: '{ "from": "2024-01-01", "to": "2024-03-01" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.from !== 'string' || typeof record.to !== 'string') throw new Error('from and to are required');
    return { from: record.from, to: record.to };
  },
  async execute(input) {
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return { ok: false, output: 'invalid date: could not parse from/to', data: { from: input.from, to: input.to } };
    }
    const ms = to.getTime() - from.getTime();
    const days = ms / 86400000;
    const hours = ms / 3600000;
    const minutes = ms / 60000;
    return {
      ok: true,
      output: `days: ${days.toFixed(2)}\nhours: ${hours.toFixed(2)}\nminutes: ${minutes.toFixed(0)}\nms: ${ms}`,
      data: { ms, days, hours, minutes },
    };
  },
};

export const calculateTool: ToolDefinition<{ expression: string }> = {
  name: 'calculate',
  description: 'Evaluate a basic arithmetic expression with + - * / % ( ) and decimals. No variables or functions. Read-only and sandboxed (no eval of arbitrary code).',
  inputHint: '{ "expression": "(3 + 4) * 2 / 7" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.expression !== 'string' || record.expression.trim() === '') throw new Error('expression is required');
    return { expression: record.expression.trim() };
  },
  async execute(input) {
    // Reject anything outside the safe arithmetic character set so this can
    // never become an arbitrary-code eval. Only digits, operators, dots,
    // parentheses and whitespace are allowed.
    if (!/^[0-9+\-*/%.()\s]+$/.test(input.expression)) {
      return { ok: false, output: 'expression contains unsupported characters (only 0-9 + - * / % ( ) . allowed)', data: { expression: input.expression } };
    }
    try {
      const value = evalArithmetic(input.expression);
      if (!Number.isFinite(value)) return { ok: false, output: 'result is not finite (division by zero?)', data: { expression: input.expression } };
      return { ok: true, output: String(value), data: { expression: input.expression, value } };
    } catch (error) {
      return { ok: false, output: `could not evaluate: ${error instanceof Error ? error.message : String(error)}`, data: { expression: input.expression } };
    }
  },
};

/*
 * A tiny recursive-descent arithmetic evaluator. Deliberately hand-written (no
 * Function/eval) so a validated arithmetic string cannot execute code.
 * Grammar:  expr = term (('+'|'-') term)*   term = factor (('*'|'/'|'%') factor)*
 *           factor = number | '(' expr ')' | ('-'|'+') factor
 */
function evalArithmetic(input: string): number {
  let pos = 0;
  const s = input.replace(/\s+/g, '');

  function peek(): string { return s[pos] ?? ''; }

  function parseExpr(): number {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = s[pos++];
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[pos++];
      const rhs = parseFactor();
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
    return value;
  }

  function parseFactor(): number {
    if (peek() === '+') { pos++; return parseFactor(); }
    if (peek() === '-') { pos++; return -parseFactor(); }
    if (peek() === '(') {
      pos++;
      const value = parseExpr();
      if (peek() !== ')') throw new Error('missing closing parenthesis');
      pos++;
      return value;
    }
    const start = pos;
    while (/[0-9.]/.test(peek())) pos++;
    if (pos === start) throw new Error(`unexpected character at ${pos}: "${peek()}"`);
    const num = Number(s.slice(start, pos));
    if (Number.isNaN(num)) throw new Error(`invalid number: ${s.slice(start, pos)}`);
    return num;
  }

  const result = parseExpr();
  if (pos !== s.length) throw new Error(`unexpected trailing input at ${pos}`);
  return result;
}
