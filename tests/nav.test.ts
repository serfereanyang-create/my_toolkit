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

test('extractSymbolsFromSource supports python go rust java kotlin', () => {
  const py = extractSymbolsFromSource('svc/app.py', `
class Worker:
    def run(self):
        pass

async def boot():
    pass
`);
  assert.ok(py.some((s) => s.kind === 'class' && s.name === 'Worker'));
  assert.ok(py.some((s) => s.kind === 'method' && s.name === 'run' && s.container === 'Worker'));
  assert.ok(py.some((s) => s.kind === 'function' && s.name === 'boot'));

  const go = extractSymbolsFromSource('pkg/main.go', `
package main
func Helper() {}
func (s *Server) Start() {}
type Server struct {}
type Handler interface {}
const MaxOpen = 1
`);
  assert.ok(go.some((s) => s.kind === 'function' && s.name === 'Helper' && s.exported));
  assert.ok(go.some((s) => s.kind === 'method' && s.name === 'Start'));
  assert.ok(go.some((s) => s.kind === 'struct' && s.name === 'Server'));
  assert.ok(go.some((s) => s.kind === 'interface' && s.name === 'Handler'));

  const rs = extractSymbolsFromSource('src/lib.rs', `
pub fn boot() {}
pub struct Config {}
pub enum Mode { A }
pub trait Runner {}
mod internal {}
`);
  assert.ok(rs.some((s) => s.kind === 'function' && s.name === 'boot' && s.exported));
  assert.ok(rs.some((s) => s.kind === 'struct' && s.name === 'Config'));
  assert.ok(rs.some((s) => s.kind === 'enum' && s.name === 'Mode'));
  assert.ok(rs.some((s) => s.kind === 'trait' && s.name === 'Runner'));
  assert.ok(rs.some((s) => s.kind === 'module' && s.name === 'internal'));

  const java = extractSymbolsFromSource('App.java', `
public class App {
  public void start() {}
}
public interface Service {}
`);
  assert.ok(java.some((s) => s.kind === 'class' && s.name === 'App'));
  assert.ok(java.some((s) => s.kind === 'method' && s.name === 'start'));
  assert.ok(java.some((s) => s.kind === 'interface' && s.name === 'Service'));

  const kt = extractSymbolsFromSource('Main.kt', `
class Board
object Defaults
fun main() {}
`);
  assert.ok(kt.some((s) => s.kind === 'class' && s.name === 'Board'));
  assert.ok(kt.some((s) => s.kind === 'class' && s.name === 'Defaults'));
  assert.ok(kt.some((s) => s.kind === 'function' && s.name === 'main'));
});

test('NavIndexStore indexes multi-language source files', async () => {
  const dir = await fixture('poly');
  try {
    await mkdir(join(dir.root, 'src'), { recursive: true });
    await writeFile(join(dir.root, 'src', 'worker.py'), 'def poly_worker():\n    return 1\n', 'utf8');
    await writeFile(join(dir.root, 'src', 'worker.go'), 'package main\nfunc PolyWorker() {}\n', 'utf8');
    await writeFile(join(dir.root, 'src', 'worker.rs'), 'pub fn poly_worker() {}\n', 'utf8');
    const index = await new NavIndexStore(dir.root).loadOrBuild();
    const langs = new Set(index.files.map((file) => file.language));
    assert.ok(langs.has('python'));
    assert.ok(langs.has('go'));
    assert.ok(langs.has('rust'));
    const hits = findSymbols(index, 'poly_worker');
    assert.ok(hits.some((hit) => hit.path.endsWith('.py')));
    assert.ok(hits.some((hit) => hit.path.endsWith('.rs')) || hits.some((hit) => hit.name === 'PolyWorker'));
  } finally {
    await dir.cleanup();
  }
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
