import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseToolArguments, repairQuasiJson } from '../src/providers/toolArguments.js';

/*
 * Real captures from ~/.aicode/sessions: models that are not strict JSON
 * emitters send structure with bare string values. All four providers used to
 * answer `{ raw: value }`, which no tool reads, so the model got
 * "path is required" and retried the same shape. 102 calls in the ledger, 53 of
 * them hard failures.
 */

test('valid JSON is returned untouched', () => {
  const parsed = parseToolArguments('{"path":"a.ts","limit":3}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { path: 'a.ts', limit: 3 });
  assert.equal(parsed.repaired, false);
});

test('repaired: unquoted Chinese value (the 102-call capture)', () => {
  const parsed = parseToolArguments('{"path": "desktop/CAD.pptx", "title": 计算机辅助设计（CAD）概述}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.repaired, true);
  assert.deepEqual(parsed.input, { path: 'desktop/CAD.pptx', title: '计算机辅助设计（CAD）概述' });
});

test('repaired: unquoted ASCII value', () => {
  const parsed = parseToolArguments('{"pattern": *.ts, "path": src}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { pattern: '*.ts', path: 'src' });
});

test('repaired: unquoted keys', () => {
  const parsed = parseToolArguments('{path: "a.ts", limit: 10}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { path: 'a.ts', limit: 10 });
});

test('repaired: ```json fence plus surrounding prose', () => {
  const parsed = parseToolArguments('Sure, here you go:\n```json\n{"query": 项目结构}\n```\nDone.');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { query: '项目结构' });
});

test('repaired: trailing comma before the closer', () => {
  const parsed = parseToolArguments('{"path": "a.ts",}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { path: 'a.ts' });
});

test('repaired: bare value nested inside an object', () => {
  const parsed = parseToolArguments('{"opts": {"mode": 快速, "deep": true}}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { opts: { mode: '快速', deep: true } });
});

test('repaired: bare values that start with t / f / n are strings, not literals', () => {
  // The single-pass repairer decided from one character, so `npm test` was read
  // as `null` and `todo later` as `true`; both then failed to parse and the call
  // still went out as `{ raw }`.
  const ascii = parseToolArguments('{"cmd": npm test}');
  assert.equal(ascii.ok, true);
  if (!ascii.ok) return;
  assert.deepEqual(ascii.input, { cmd: 'npm test' });

  const note = parseToolArguments('{"note": todo later}');
  assert.equal(note.ok, true);
  if (!note.ok) return;
  assert.deepEqual(note.input, { note: 'todo later' });

  const nullish = parseToolArguments('{"flag": nothing}');
  assert.equal(nullish.ok, true);
  if (!nullish.ok) return;
  assert.deepEqual(nullish.input, { flag: 'nothing' });
});

test('repaired: bare values inside an array', () => {
  const parsed = parseToolArguments('{"paths": [a.ts, b.ts], "mode": fast}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { paths: ['a.ts', 'b.ts'], mode: 'fast' });
});

test('repaired: trailing comma inside an array', () => {
  const parsed = parseToolArguments('{"tags": ["a", b,]}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { tags: ['a', 'b'] });
});

test('literals and numbers keep their type next to bare values', () => {
  const parsed = parseToolArguments('{"ok": true, "off": false, "empty": null, "n": -12.5, "mode": 快速}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { ok: true, off: false, empty: null, n: -12.5, mode: '快速' });
});

test('a date is a string, not a truncated number', () => {
  const parsed = parseToolArguments('{"since": 2024-01-01}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { since: '2024-01-01' });
});

test('repaired: Python-style True / False / None are literals, not strings', () => {
  // A model trained on Python writes the capitalised spelling. Read as a bare
  // string it became "True", and a tool checking `=== true` then did the
  // opposite of what was asked — silently, because nothing failed.
  const parsed = parseToolArguments('{"caseSensitive": True, "deep": False, "note": None}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { caseSensitive: true, deep: false, note: null });
});

test('a word that only starts with a literal name stays a string', () => {
  const parsed = parseToolArguments('{"a": trueish, "b": noneOf, "c": Falsey}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { a: 'trueish', b: 'noneOf', c: 'Falsey' });
});

test('repaired: leading zeros do not invalidate the whole payload', () => {
  // JSON forbids `0644`; a file mode is exactly what a model writes.
  const parsed = parseToolArguments('{"mode": 0644, "path": a.ts}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { mode: 644, path: 'a.ts' });
  assert.equal(repairQuasiJson('{"level": 007}'), '{"level":7}');
});

test('a character class in a bare value is a string, not an array', () => {
  const parsed = parseToolArguments('{"pattern": [tj]s}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { pattern: '[tj]s' });
});

test('an array of bare values is still an array', () => {
  const parsed = parseToolArguments('{"paths": [src, lib], "flags": [true, false], "empty": []}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { paths: ['src', 'lib'], flags: [true, false], empty: [] });
});

test('a value containing a colon and a brace is not rewritten', () => {
  const source = '{"expression": "x.map(a => ({a}))", "note": 说明}';
  const parsed = parseToolArguments(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal((parsed.input as Record<string, unknown>).expression, 'x.map(a => ({a}))');
  assert.equal((parsed.input as Record<string, unknown>).note, '说明');
});

test('hopeless input keeps the raw payload so the error can quote it', () => {
  const parsed = parseToolArguments('not json at all');
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(parsed.input, { raw: 'not json at all' });
  assert.ok(parsed.error.length > 0);
});

test('empty payload is an empty object, not an error', () => {
  const parsed = parseToolArguments('   ');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, {});
});

test('repairQuasiJson refuses to invent structure that is not there', () => {
  assert.equal(repairQuasiJson('hello'), null);
  assert.equal(repairQuasiJson('{"a": }'), null);
});

test('parseToolArguments never throws, however deep or broken the payload', () => {
  // The walk is recursive; without a depth guard a payload nested thousands of
  // levels escaped as RangeError from a function whose job is to return a union.
  const deepObject = `${'{"a":'.repeat(6000)}xyz${'}'.repeat(6000)}`;
  const deepArray = `{"a":${'['.repeat(6000)}xyz${']'.repeat(6000)}}`;
  for (const payload of [deepObject, deepArray]) {
    assert.doesNotThrow(() => parseToolArguments(payload));
    const parsed = parseToolArguments(payload);
    assert.equal(parsed.ok, false);
  }
  // Input that is not a string is passed through instead of throwing TypeError.
  assert.doesNotThrow(() => parseToolArguments({ path: 'a.ts' } as unknown as string));
  assert.deepEqual(parseToolArguments({ path: 'a.ts' } as unknown as string), { ok: true, input: { path: 'a.ts' }, repaired: false });
});

test('CRLF, emoji and escaped quotes survive the repair', () => {
  const parsed = parseToolArguments('{\r\n  "path": a.ts,\r\n  "title": 测试 🚀 "引号"\r\n}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.input, { path: 'a.ts', title: '测试 🚀 "引号"' });
});
