const assert = require('node:assert/strict');
const { test } = require('node:test');
const { usageToCsv, USAGE_CSV_COLUMNS } = require('../electron/usage-csv.cjs');

test('csv header lists all default columns', () => {
  const out = usageToCsv([]);
  const first = out.split('\r\n')[0];
  assert.equal(first, USAGE_CSV_COLUMNS.join(','));
});

test('plain records render numbers and strings without quoting', () => {
  const out = usageToCsv([
    { id: 'u1', timestamp: 1700000000000, model: 'gpt-x', provider: 'openai', input: 10, output: 5, total: 15 },
  ]);
  const lines = out.trim().split('\r\n');
  assert.equal(lines.length, 2);
  const row = Object.fromEntries(lines[1].split(',').map((c, i) => [USAGE_CSV_COLUMNS[i], c]));
  assert.equal(row.model, 'gpt-x');
  assert.equal(row.input, '10');
  assert.equal(row.iso, new Date(1700000000000).toISOString());
});

test('RFC 4180 quoting for commas quotes and newlines', () => {
  const out = usageToCsv([
    { model: 'a,b', provider: 'he said "hi"', baseUrl: 'line1\nline2' },
  ]);
  assert.ok(out.includes('"a,b"'));
  assert.ok(out.includes('"he said ""hi"""'));
  assert.ok(out.includes('"line1\nline2"'));
});

test('arrays join with pipe', () => {
  const out = usageToCsv([{ toolsUsed: ['read', 'edit'] }]);
  assert.ok(out.includes('read|edit'));
});

test('missing fields render empty, null rows skipped', () => {
  const out = usageToCsv([null, undefined, { model: 'm' }]);
  const lines = out.trim().split('\r\n');
  assert.equal(lines.length, 2); // header + one row
});

test('bom option prefixes UTF-8 BOM', () => {
  assert.ok(usageToCsv([], { bom: true }).startsWith('﻿'));
  assert.ok(!usageToCsv([]).startsWith('﻿'));
});

test('custom column subset', () => {
  const out = usageToCsv([{ model: 'm', input: 3 }], { columns: ['model', 'input'] });
  assert.equal(out, 'model,input\r\nm,3\r\n');
});
