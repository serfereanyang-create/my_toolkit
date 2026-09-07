import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { parseCsv, writeCsv } from '../src/tools/csv.js';

test('parseCsv handles quotes, embedded commas, and newlines', () => {
  const rows = parseCsv('name,note\n"Doe, John","line1\nline2"\nJane,"say ""hi"""');
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['Doe, John', 'line1\nline2'],
    ['Jane', 'say "hi"'],
  ]);
});

test('toCsv quotes fields that need it and round-trips through parseCsv', () => {
  const rows = [
    ['name', 'note'],
    ['Doe, John', 'has "quote"'],
    ['plain', 'multi\nline'],
  ];
  const text = writeCsv(rows);
  assert.deepEqual(parseCsv(text), rows);
});

test('write_csv then read_csv preserves the data on disk', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-csv-'));
  const registry = createDefaultToolRegistry();

  const write = await registry.execute(
    'write_csv',
    { path: '.smoke/data.csv', rows: [['a', 'b'], ['1', '2'], ['x,y', 'z']] },
    { workspaceRoot: workspace, approval: 'auto' },
  );
  assert.equal(write.ok, true);

  const read = await registry.execute(
    'read_csv',
    { path: '.smoke/data.csv' },
    { workspaceRoot: workspace, approval: 'auto' },
  );
  assert.equal(read.ok, true);
  assert.match(read.output, /x,y/);

  await rm(workspace, { recursive: true, force: true });
});

test('read_json returns a value at a dot-path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-json-'));
  await writeFile(join(workspace, 'pkg.json'), JSON.stringify({ a: { b: [10, 20, 30] } }));
  const registry = createDefaultToolRegistry();

  const whole = await registry.execute('read_json', { path: 'pkg.json' }, { workspaceRoot: workspace, approval: 'auto' });
  assert.equal(whole.ok, true);
  assert.match(whole.output, /"b"/);

  const nested = await registry.execute('read_json', { path: 'pkg.json', query: 'a.b.1' }, { workspaceRoot: workspace, approval: 'auto' });
  assert.equal(nested.ok, true);
  assert.match(nested.output, /20/);

  await rm(workspace, { recursive: true, force: true });
});

test('create_xlsx writes a real .xlsx workbook to disk', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-xlsx-'));
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'create_xlsx',
    { 
      path: '.smoke/book.xlsx', 
      sheets: [
        { name: 'Sheet1', headers: ['h1', 'h2'], rows: [['v1', 2]] }
      ]
    },
    { workspaceRoot: workspace, approval: 'auto' },
  );
  assert.equal(result.ok, true);
  const bytes = await readFile(join(workspace, '.smoke', 'book.xlsx'));
  assert.equal(bytes.subarray(0, 2).toString('utf8'), 'PK');

  await rm(workspace, { recursive: true, force: true });
});
