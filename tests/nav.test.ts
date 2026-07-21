import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractSymbolsFromSource } from '../src/nav/extract.js';
import { findReferences, findSymbols } from '../src/nav/query.js';
import { NavIndexStore } from '../src/nav/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { planToolStrategy } from '../src/agent/toolStrategy.js';

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `aicode-nav-${name}-`));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('extractSymbolsFromSource finds functions classes and exports', () => {
  const source = `
export function runTaskBoardLoop() {}
export class BoardStore {}
export interface TaskItem { id: string }
export type BoardStatus = 'active'
export const MAX = 1
class Local {
  start() {}
}
`;
  const symbols = extractSymbolsFromSource('src/demo.ts', source);
  const names = symbols.map((symbol) => `${symbol.kind}:${symbol.name}`);
  assert.ok(names.includes('function:runTaskBoardLoop'));
  assert.ok(names.includes('class:BoardStore'));
  assert.ok(names.includes('interface:TaskItem'));
  assert.ok(names.includes('type:BoardStatus'));
  assert.ok(names.includes('const:MAX'));
  assert.ok(names.includes('method:start'));
});

test('NavIndexStore caches unchanged files and refreshes after edit', async () => {
  const dir = await fixture('cache');
  try {
    await mkdir(join(dir.root, 'src'), { recursive: true });
    const file = join(dir.root, 'src', 'a.ts');
    await writeFile(file, 'export function alpha() {}\n', 'utf8');
    const past = new Date('2020-01-01T00:00:00.000Z');
    await utimes(file, past, past);

    const store = new NavIndexStore(dir.root);
    const first = await store.loadOrBuild();
    assert.ok(first.files.some((entry) => entry.path === 'src/a.ts' && entry.symbols.some((symbol) => symbol.name === 'alpha')));

    const second = await store.loadOrBuild();
    const firstEntry = first.files.find((entry) => entry.path === 'src/a.ts');
    const secondEntry = second.files.find((entry) => entry.path === 'src/a.ts');
    assert.deepEqual(secondEntry?.symbols, firstEntry?.symbols);
    assert.equal(secondEntry?.mtimeMs, firstEntry?.mtimeMs);

    await writeFile(file, 'export function alpha() {}\nexport function beta() {}\n', 'utf8');
    const third = await store.loadOrBuild();
    const thirdEntry = third.files.find((entry) => entry.path === 'src/a.ts');
    assert.ok(thirdEntry?.symbols.some((symbol) => symbol.name === 'beta'));
  } finally {
    await dir.cleanup();
  }
});

test('findSymbols ranks exact exported names highest', async () => {
  const dir = await fixture('find');
  try {
    await mkdir(join(dir.root, 'src'), { recursive: true });
    await writeFile(join(dir.root, 'src', 'one.ts'), 'export function locateMe() {}\nfunction locateMeHelper() {}\n', 'utf8');
    await writeFile(join(dir.root, 'src', 'two.ts'), 'export function locateMeToo() {}\n', 'utf8');
    const index = await new NavIndexStore(dir.root).loadOrBuild();
    const hits = findSymbols(index, 'locateMe');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.name, 'locateMe');
    assert.equal(hits[0]?.path, 'src/one.ts');
  } finally {
    await dir.cleanup();
  }
});

test('findReferences returns definition and usage lines', async () => {
  const dir = await fixture('refs');
  try {
    await mkdir(join(dir.root, 'src'), { recursive: true });
    await writeFile(join(dir.root, 'src', 'def.ts'), 'export function targetFn() { return 1 }\n', 'utf8');
    await writeFile(join(dir.root, 'src', 'use.ts'), 'import { targetFn } from "./def.js"\ntargetFn()\n', 'utf8');
    const store = new NavIndexStore(dir.root);
    const index = await store.loadOrBuild();
    const refs = await findReferences(index, dir.root, 'targetFn');
    assert.ok(refs.some((ref) => ref.path === 'src/def.ts' && ref.isDefinition));
    assert.ok(refs.some((ref) => ref.path === 'src/use.ts' && !ref.isDefinition));
  } finally {
    await dir.cleanup();
  }
});

test('find_symbol tool is registered and returns hits', async () => {
  const dir = await fixture('tool');
  try {
    await mkdir(join(dir.root, 'src'), { recursive: true });
    await writeFile(join(dir.root, 'src', 'tool.ts'), 'export function toolSymbol() {}\n', 'utf8');
    const tools = createDefaultToolRegistry();
    const names = tools.list().map((tool) => tool.name);
    assert.ok(names.includes('find_symbol'));
    assert.ok(names.includes('find_references'));
    const result = await tools.execute('find_symbol', { query: 'toolSymbol' }, {
      workspaceRoot: dir.root,
      approval: 'auto',
    });
    assert.equal(result.ok, true);
    assert.match(result.output, /toolSymbol/);
  } finally {
    await dir.cleanup();
  }
});

test('tool strategy prefers find_symbol for code edit and search', () => {
  const edit = planToolStrategy({ prompt: '修复登录按钮', recentTools: [], workspaceRoot: process.cwd() });
  assert.ok(edit.recommendedTools.includes('find_symbol'));
  const search = planToolStrategy({ prompt: '查找 runTaskBoardLoop 在哪里', recentTools: [], workspaceRoot: process.cwd() });
  assert.ok(search.recommendedTools.includes('find_symbol'));
});
