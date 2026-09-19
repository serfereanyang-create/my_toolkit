/**
 * analysis-tools.test.ts — 代码分析模块测试
 * 
 * 覆盖 complexity/smells/dependency-graph 三个分析器的核心行为
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as ts from 'typescript';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeFileComplexity,
  analyzeFunctionComplexity,
  DEFAULT_THRESHOLDS,
} from '../src/analysis/complexity.js';
import {
  analyzeFileSmells,
  DEFAULT_SMELL_THRESHOLDS,
} from '../src/analysis/smells.js';
import {
  buildDependencyGraph,
  detectCircularDependencies,
  calculateInstability,
} from '../src/analysis/dependency-graph.js';

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);
}

describe('complexity analyzer', () => {
  it('simple function has cyclomatic complexity 1', () => {
    const sf = parse(`function simple(a: number) { return a + 1; }`);
    const result = analyzeFileComplexity(sf);
    assert.strictEqual(result.functions.length, 1);
    assert.strictEqual(result.functions[0].metrics.cyclomatic, 1);
    assert.strictEqual(result.functions[0].risk, 'low');
  });
  
  it('each if/for/&&/|| adds one to cyclomatic complexity', () => {
    const sf = parse(`
function branchy(a: number, b: number) {
  if (a > 0) {              // +1
    for (let i = 0; i < a; i++) {  // +1
      if (b > 0 && a > b) { // +1 if, +1 &&
        return i;
      }
    }
  }
  return a > b ? a : b;     // +1 ternary
}`);
    const result = analyzeFileComplexity(sf);
    // 基础 1 + 5 个决策点 = 6
    assert.strictEqual(result.functions[0].metrics.cyclomatic, 6);
  });
  
  it('cognitive complexity penalizes nesting more than flat branches', () => {
    const flat = parse(`
function flat(a: number) {
  if (a === 1) return 1;
  if (a === 2) return 2;
  if (a === 3) return 3;
  return 0;
}`);
    const nested = parse(`
function nested(a: number) {
  if (a > 0) {
    if (a > 1) {
      if (a > 2) {
        return 3;
      }
    }
  }
  return 0;
}`);
    const flatResult = analyzeFileComplexity(flat);
    const nestedResult = analyzeFileComplexity(nested);
    // 相同数量的 if，嵌套版本认知复杂度更高
    assert.ok(
      nestedResult.functions[0].metrics.cognitive > flatResult.functions[0].metrics.cognitive,
      `nested (${nestedResult.functions[0].metrics.cognitive}) should exceed flat (${flatResult.functions[0].metrics.cognitive})`
    );
  });
  
  it('nesting depth counts loop/if/switch/try levels', () => {
    const sf = parse(`
function deep() {
  for (let i = 0; i < 10; i++) {
    if (i > 5) {
      while (true) {
        break;
      }
    }
  }
}`);
    const result = analyzeFileComplexity(sf);
    assert.strictEqual(result.functions[0].metrics.maxNesting, 3);
  });
  
  it('risk escalates to critical at high cyclomatic threshold', () => {
    // 生成 25 个 if 分支，超过 critical=21
    const branches = Array.from({ length: 25 }, (_, i) => `if (x === ${i}) return ${i};`).join('\n  ');
    const sf = parse(`function monster(x: number) {\n  ${branches}\n  return -1;\n}`);
    const result = analyzeFileComplexity(sf, DEFAULT_THRESHOLDS);
    assert.strictEqual(result.functions[0].risk, 'critical');
    assert.strictEqual(result.highRiskCount, 1);
  });
  
  it('methods and arrow functions are analyzed with names', () => {
    const sf = parse(`
class Service {
  handle(a: number) { return a; }
}
const helper = (x: number) => x * 2;
`);
    const result = analyzeFileComplexity(sf);
    const names = result.functions.map(f => f.name);
    assert.ok(names.includes('handle'));
    assert.ok(names.includes('helper'));
    const kinds = result.functions.map(f => f.kind);
    assert.ok(kinds.includes('method'));
    assert.ok(kinds.includes('arrow'));
  });
});

describe('smell detector', () => {
  it('detects long parameter list', () => {
    const sf = parse(`function many(a: number, b: number, c: number, d: number, e: number, f: number) {}`);
    const result = analyzeFileSmells(sf);
    const smell = result.smells.find(s => s.type === 'long_parameter_list');
    assert.ok(smell, 'should report long_parameter_list');
    assert.strictEqual(smell!.metrics?.parameters, 6);
  });
  
  it('does not flag short parameter lists', () => {
    const sf = parse(`function few(a: number, b: number) {}`);
    const result = analyzeFileSmells(sf);
    assert.ok(!result.smells.some(s => s.type === 'long_parameter_list'));
  });
  
  it('detects long method beyond line threshold', () => {
    const body = Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const sf = parse(`function long() {\n${body}\n}`);
    const result = analyzeFileSmells(sf);
    assert.ok(result.smells.some(s => s.type === 'long_method'));
  });
  
  it('detects magic numbers but allows 0/1/-1/2 and array indices', () => {
    const sf = parse(`
function calc(x: number) {
  const tax = x * 0.35;   // 魔法数字
  const first = arr[0];   // 数组索引，允许
  return x + 1;           // 允许值
}
declare const arr: number[];
`);
    const result = analyzeFileSmells(sf);
    const magics = result.smells.filter(s => s.type === 'magic_number');
    assert.ok(magics.some(s => s.symbol === '0.35'), 'should flag 0.35');
    assert.ok(!magics.some(s => s.symbol === '1'), 'should not flag 1');
  });
  
  it('detects switch with many cases', () => {
    const cases = Array.from({ length: 7 }, (_, i) => `case ${i}: return ${i};`).join('\n    ');
    const sf = parse(`function route(t: number) {\n  switch (t) {\n    ${cases}\n    default: return -1;\n  }\n}`);
    const result = analyzeFileSmells(sf);
    assert.ok(result.smells.some(s => s.type === 'switch_statements'));
  });
  
  it('detects uncalled private method as dead code', () => {
    const sf = parse(`
class Widget {
  render() { this.used(); }
  private used() {}
  private unused() {}
}`);
    const result = analyzeFileSmells(sf);
    const dead = result.smells.filter(s => s.type === 'dead_code');
    assert.strictEqual(dead.length, 1);
    assert.strictEqual(dead[0].symbol, 'unused');
  });
  
  it('severity counters add up to total smells', () => {
    const sf = parse(`function many(a: number, b: number, c: number, d: number, e: number, f: number) { const x = 42; }`);
    const result = analyzeFileSmells(sf);
    const sum = Object.values(result.severityCounts).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, result.smells.length);
  });
});

describe('dependency graph', () => {
  it('builds graph and detects a two-module cycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'depgraph-'));
    try {
      await writeFile(join(dir, 'a.ts'), `import { b } from './b.js';\nexport const a = 1;`);
      await writeFile(join(dir, 'b.ts'), `import { a } from './a.js';\nexport const b = 2;`);
      await writeFile(join(dir, 'c.ts'), `export const c = 3;`);
      
      const graph = await buildDependencyGraph(['a.ts', 'b.ts', 'c.ts'], dir);
      
      assert.strictEqual(graph.nodes.size, 3);
      
      const cycles = detectCircularDependencies(graph);
      assert.ok(cycles.length >= 1, 'should detect a↔b cycle');
      assert.strictEqual(cycles[0].severity, 'error'); // 2 模块循环 = error
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  
  it('isolated module has no imports or importers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'depgraph-'));
    try {
      await writeFile(join(dir, 'main.ts'), `import { util } from './util.js';\nexport const main = util;`);
      await writeFile(join(dir, 'util.ts'), `export const util = 1;`);
      await writeFile(join(dir, 'lonely.ts'), `export const lonely = 1;`);
      
      const graph = await buildDependencyGraph(['main.ts', 'util.ts', 'lonely.ts'], dir);
      
      const lonely = graph.nodes.get('lonely.ts')!;
      assert.strictEqual(lonely.imports.length, 0);
      assert.strictEqual(lonely.importedBy.length, 0);
      
      const util = graph.nodes.get('util.ts')!;
      assert.deepStrictEqual(util.importedBy, ['main.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  
  it('instability is fanOut/(fanIn+fanOut)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'depgraph-'));
    try {
      await writeFile(join(dir, 'app.ts'), `import { x } from './lib.js';\nexport const app = x;`);
      await writeFile(join(dir, 'lib.ts'), `export const x = 1;`);
      
      const graph = await buildDependencyGraph(['app.ts', 'lib.ts'], dir);
      
      // app: fanOut=1, fanIn=0 → 不稳定性 1
      assert.strictEqual(calculateInstability(graph, 'app.ts'), 1);
      // lib: fanOut=0, fanIn=1 → 不稳定性 0（稳定）
      assert.strictEqual(calculateInstability(graph, 'lib.ts'), 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  
  it('external packages are recorded but not graph nodes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'depgraph-'));
    try {
      await writeFile(join(dir, 'entry.ts'), `import * as ts from 'typescript';\nexport const e = 1;`);
      
      const graph = await buildDependencyGraph(['entry.ts'], dir);
      const entry = graph.nodes.get('entry.ts')!;
      
      assert.ok(entry.imports.some(i => i === 'external:typescript'));
      assert.ok(!graph.nodes.has('external:typescript'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  
  it('test files get type "test"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'depgraph-'));
    try {
      await writeFile(join(dir, 'foo.test.ts'), `export const t = 1;`);
      const graph = await buildDependencyGraph(['foo.test.ts'], dir);
      assert.strictEqual(graph.nodes.get('foo.test.ts')!.type, 'test');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
