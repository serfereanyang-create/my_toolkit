import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';

/*
 * End-to-end coverage for the tools added in the 27→60 expansion. Each test
 * runs the tool through the real registry (validate → approval → execute) in a
 * throwaway workspace, so it exercises the same path the agent uses. Read/text
 * tools use approval 'auto'; write tools also run under 'auto' (workspace-local).
 */

const ctx = (workspaceRoot: string) => ({ workspaceRoot, approval: 'auto' as const });

test('encoding: base64 round-trips and hash is stable', async () => {
  const registry = createDefaultToolRegistry();
  const enc = await registry.execute('base64_encode', { text: 'héllo 世界' }, ctx(process.cwd()));
  assert.equal(enc.ok, true);
  const encoded = enc.output;
  const dec = await registry.execute('base64_decode', { data: encoded }, ctx(process.cwd()));
  assert.equal(dec.ok, true);
  assert.equal(dec.output, 'héllo 世界');

  const h = await registry.execute('hash_text', { text: 'abc', algorithm: 'sha256' }, ctx(process.cwd()));
  assert.equal(h.ok, true);
  // Known SHA-256 of "abc".
  assert.match(h.output, /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/);
});

test('encoding: url encode/decode and uuid shape', async () => {
  const registry = createDefaultToolRegistry();
  const enc = await registry.execute('url_encode', { text: 'a b&c', component: true }, ctx(process.cwd()));
  assert.equal(enc.ok, true);
  assert.match(enc.output, /a%20b%26c/);

  const uuid = await registry.execute('uuid_generate', { count: 2 }, ctx(process.cwd()));
  assert.equal(uuid.ok, true);
  const ids = (uuid.data as { ids: string[] }).ids;
  assert.equal(ids.length, 2);
  assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('compute: calculate evaluates a safe arithmetic expression', async () => {
  const registry = createDefaultToolRegistry();
  const r = await registry.execute('calculate', { expression: '(2 + 3) * 4 - 6 / 2' }, ctx(process.cwd()));
  assert.equal(r.ok, true);
  assert.match(r.output, /17/);
});

test('compute: calculate rejects non-math input', async () => {
  const registry = createDefaultToolRegistry();
  const r = await registry.execute('calculate', { expression: 'process.exit(1)' }, ctx(process.cwd()));
  assert.equal(r.ok, false);
});

test('text: word_count and sort_lines on inline text', async () => {
  const registry = createDefaultToolRegistry();
  const wc = await registry.execute('word_count', { text: 'one two three\nfour' }, ctx(process.cwd()));
  assert.equal(wc.ok, true);
  const d = wc.data as { words: number; lines: number };
  assert.equal(d.words, 4);

  const sorted = await registry.execute('sort_lines', { text: 'banana\napple\ncherry', unique: false, numeric: false, reverse: false }, ctx(process.cwd()));
  assert.equal(sorted.ok, true);
  assert.equal(sorted.output.split('\n')[0], 'apple');
});

test('text: replace_text with regex', async () => {
  const registry = createDefaultToolRegistry();
  const r = await registry.execute('replace_text', { text: 'a1b2c3', search: '[0-9]', replace: '#', regex: true }, ctx(process.cwd()));
  assert.equal(r.ok, true);
  assert.equal(r.output, 'a#b#c#');
});

test('fs: write_json then read it back, and format_json minify', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-newtools-'));
  const registry = createDefaultToolRegistry();
  const w = await registry.execute('write_json', { path: '.smoke/data.json', value: { a: 1, b: [2, 3] }, pretty: true }, ctx(workspace));
  assert.equal(w.ok, true);
  const onDisk = await readFile(join(workspace, '.smoke', 'data.json'), 'utf8');
  assert.match(onDisk, /"a": 1/);

  const fmt = await registry.execute('format_json', { json: '{ "x":  1 }', minify: true }, ctx(workspace));
  assert.equal(fmt.ok, true);
  assert.equal(fmt.output, '{"x":1}');

  await rm(workspace, { recursive: true, force: true });
});

test('data: json_to_csv and csv_to_json round-trip', async () => {
  const registry = createDefaultToolRegistry();
  const j2c = await registry.execute('json_to_csv', { json: JSON.stringify([{ name: 'a', n: 1 }, { name: 'b', n: 2 }]) }, ctx(process.cwd()));
  assert.equal(j2c.ok, true);
  assert.match(j2c.output, /name,n/);

  const c2j = await registry.execute('csv_to_json', { csv: 'name,n\na,1\nb,2', header: true }, ctx(process.cwd()));
  assert.equal(c2j.ok, true);
  const rows = JSON.parse(c2j.output) as Array<Record<string, string>>;
  assert.equal(rows[0].name, 'a');
});

test('fs: read_lines returns an inclusive range', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-readlines-'));
  await writeFile(join(workspace, 'f.txt'), 'l1\nl2\nl3\nl4\nl5');
  const registry = createDefaultToolRegistry();
  const r = await registry.execute('read_lines', { path: 'f.txt', start: 2, end: 4 }, ctx(workspace));
  assert.equal(r.ok, true);
  assert.match(r.output, /l2/);
  assert.match(r.output, /l4/);
  assert.doesNotMatch(r.output, /l5/);
  await rm(workspace, { recursive: true, force: true });
});

test('fs: append_file creates then appends', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-append-'));
  const registry = createDefaultToolRegistry();
  await registry.execute('append_file', { path: '.smoke/log.txt', content: 'line1\n' }, ctx(workspace));
  await registry.execute('append_file', { path: '.smoke/log.txt', content: 'line2\n' }, ctx(workspace));
  const onDisk = await readFile(join(workspace, '.smoke', 'log.txt'), 'utf8');
  assert.equal(onDisk, 'line1\nline2\n');
  await rm(workspace, { recursive: true, force: true });
});

test('data: edit_lines replaces a range with checkpoint-backed write', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-editlines-'));
  await writeFile(join(workspace, 'f.txt'), 'a\nb\nc\nd');
  const registry = createDefaultToolRegistry();
  const r = await registry.execute('edit_lines', { path: 'f.txt', start: 2, end: 3, mode: 'replace', text: 'X\nY' }, ctx(workspace));
  assert.equal(r.ok, true);
  const onDisk = await readFile(join(workspace, 'f.txt'), 'utf8');
  assert.equal(onDisk.replace(/\r\n/g, '\n'), 'a\nX\nY\nd');
  await rm(workspace, { recursive: true, force: true });
});

test('typescript language tools resolve NodeNext imports and CRLF positions precisely', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-ts-language-'));
  const sourceDir = join(workspace, 'src');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true }, include: ['src/**/*.ts'] }), 'utf8');
  await writeFile(join(sourceDir, 'defs.ts'), 'export function answer(value: number): number {\r\n  return value + 1;\r\n}\r\n', 'utf8');
  await writeFile(join(sourceDir, 'use.ts'), 'import { answer } from \'./defs.js\';\r\nexport const result = answer(1);\r\n// answer in a comment must not become a reference\r\n', 'utf8');
  const registry = createDefaultToolRegistry();
  const context = ctx(workspace);

  const hover = await registry.execute('ts_hover', { path: 'src/use.ts', line: 2, column: 23 }, context);
  const definition = await registry.execute('ts_goto_definition', { path: 'src/use.ts', line: 2, column: 23 }, context);
  const references = await registry.execute('ts_exact_references', { path: 'src/defs.ts', line: 1, column: 17 }, context);

  assert.equal(hover.ok, true);
  assert.match(hover.output, /answer/);
  assert.match(hover.output, /number/);
  assert.equal(definition.ok, true);
  assert.match(definition.output, /src[\\/]defs\.ts:1:17/);
  assert.equal(references.ok, true);
  assert.match(references.output, /共 3 处引用/);
  assert.doesNotMatch(references.output, /comment/);
  await rm(workspace, { recursive: true, force: true });
});

test('env_get scrubs secret-looking variables', async () => {
  const registry = createDefaultToolRegistry();
  process.env.AICODE_TEST_TOKEN = 'super-secret-value';
  try {
    const r = await registry.execute('env_get', { name: 'AICODE_TEST_TOKEN' }, ctx(process.cwd()));
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.output, /super-secret-value/);
  } finally {
    delete process.env.AICODE_TEST_TOKEN;
  }
});

test('patch: apply_patch rejects ambiguous multi-match targets', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'patch-multi-'));
  const testFile = join(workspace, 'repeat.txt');
  // File with repeated text
  await writeFile(testFile, 'line one\nrepeat\nline three\nrepeat\nline five', 'utf8');
  
  const registry = createDefaultToolRegistry();
  const result = await registry.execute('apply_patch', {
    path: 'repeat.txt',
    oldText: 'repeat',
    newText: 'CHANGED'
  }, ctx(workspace));
  
  assert.equal(result.ok, false);
  assert.match(result.output, /Ambiguous match/);
  assert.match(result.output, /2 times/);
  assert.match(result.output, /edit_lines/);
  
  // Verify file unchanged
  const content = await readFile(testFile, 'utf8');
  assert.equal(content, 'line one\nrepeat\nline three\nrepeat\nline five');
  
  await rm(workspace, { recursive: true, force: true });
});

test('patch: apply_patch succeeds on single match', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'patch-single-'));
  const testFile = join(workspace, 'unique.txt');
  await writeFile(testFile, 'before text\nunique target\nafter text', 'utf8');
  
  const registry = createDefaultToolRegistry();
  const result = await registry.execute('apply_patch', {
    path: 'unique.txt',
    oldText: 'unique target',
    newText: 'REPLACED'
  }, ctx(workspace));
  
  assert.equal(result.ok, true);
  assert.match(result.output, /Patched/);
  
  const content = await readFile(testFile, 'utf8');
  assert.equal(content, 'before text\nREPLACED\nafter text');
  
  await rm(workspace, { recursive: true, force: true });
});
