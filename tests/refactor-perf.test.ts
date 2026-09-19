/**
 * refactor-perf.test.ts — 重构引擎与性能分析测试
 * 
 * 覆盖 extract-method、rename、performance-analyzer、benchmark、
 * test-generator、coverage、doc-generator、changelog 的核心行为
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMethod, previewExtractMethod } from '../src/refactor/extract-method.js';
import { quickRename } from '../src/refactor/rename.js';
import { analyzePerformance } from '../src/performance/performance-analyzer.js';
import {
  benchmark,
  compareBenchmarks,
  detectRegression,
} from '../src/performance/benchmark.js';
import { generateTests } from '../src/testing/test-generator.js';
import {
  parseLcovCoverage,
  generateCoverageBadge,
} from '../src/testing/coverage.js';
import { extractAPIFromFile, generateAPIDocumentation } from '../src/docs/doc-generator.js';
import { parseConventionalCommit, recommendNextVersion } from '../src/docs/changelog.js';

async function withTempFile(content: string, fn: (dir: string, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'refactor-'));
  try {
    await writeFile(join(dir, 'target.ts'), content);
    await fn(dir, 'target.ts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('extract method', () => {
  it('infers input parameters from outer variables read inside', async () => {
    await withTempFile(
      `function outer() {
  const base = 10;
  const factor = 2;
  const result = base * factor;
  console.log(result);
}`,
      async (dir, file) => {
        const result = await extractMethod(file, dir, {
          methodName: 'compute',
          startLine: 4,
          endLine: 4,
        });
        // base 和 factor 在外部声明、内部读取 → 应成为参数
        assert.ok(result.variableAnalysis.inputs.includes('base'));
        assert.ok(result.variableAnalysis.inputs.includes('factor'));
      }
    );
  });
  
  it('flags return statements inside selection as unsafe', async () => {
    await withTempFile(
      `function calc(x: number) {
  if (x > 0) {
    return x * 2;
  }
  return 0;
}`,
      async (dir, file) => {
        const result = await extractMethod(file, dir, {
          methodName: 'positive',
          startLine: 2,
          endLine: 4,
        });
        assert.strictEqual(result.isSafe, false);
        assert.ok(result.warnings.some(w => w.includes('return')));
      }
    );
  });
  
  it('preview produces both original and modified content', async () => {
    await withTempFile(
      `function work() {
  const a = 1;
  const b = a + 1;
  console.log(b);
}`,
      async (dir, file) => {
        const preview = await previewExtractMethod(file, dir, {
          methodName: 'step',
          startLine: 3,
          endLine: 3,
        });
        assert.ok(preview.original.includes('const b = a + 1'));
        assert.ok(preview.modified.includes('step'));
        assert.notStrictEqual(preview.original, preview.modified);
      }
    );
  });
});

describe('quick rename', () => {
  it('renames all occurrences in a single file', async () => {
    await withTempFile(
      `const counter = 0;
function bump() { return counter + 1; }
export { counter };`,
      async (dir, file) => {
        const result = await quickRename(file, dir, 1, 7, 'total');
        assert.strictEqual(result.success, true);
        assert.ok(result.modified!.includes('const total = 0'));
        assert.ok(result.modified!.includes('return total + 1'));
        assert.ok(!result.modified!.includes('counter'));
      }
    );
  });
  
  it('word boundary prevents partial matches', async () => {
    await withTempFile(
      `const item = 1;
const items = [item];`,
      async (dir, file) => {
        const result = await quickRename(file, dir, 1, 7, 'entry');
        assert.strictEqual(result.success, true);
        // items 不应被改成 entrys
        assert.ok(result.modified!.includes('const items ='));
        assert.ok(result.modified!.includes('[entry]'));
      }
    );
  });
});

describe('performance analyzer', () => {
  it('flags nested loops as O(n^2) issue', async () => {
    await withTempFile(
      `function pairs(arr: number[]) {
  const out: number[][] = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length; j++) {
      out.push([arr[i], arr[j]]);
    }
  }
  return out;
}`,
      async (dir, file) => {
        const result = await analyzePerformance(file, dir);
        assert.ok(result.issues.some(i => i.category === 'algorithm' && i.message.includes('嵌套循环')));
        const complexity = result.algorithmComplexities.get('pairs');
        assert.ok(complexity);
        assert.strictEqual(complexity!.timeComplexity, 'O(n²)');
      }
    );
  });
  
  it('flags readFileSync as blocking sync I/O', async () => {
    await withTempFile(
      `import { readFileSync } from 'node:fs';
export function load(path: string) {
  return readFileSync(path, 'utf-8');
}`,
      async (dir, file) => {
        const result = await analyzePerformance(file, dir);
        const ioIssue = result.issues.find(i => i.category === 'io');
        assert.ok(ioIssue, 'should flag sync IO');
        assert.strictEqual(ioIssue!.severity, 'critical');
      }
    );
  });
  
  it('flags includes() inside loop as O(n^2)', async () => {
    await withTempFile(
      `export function intersect(a: string[], b: string[]) {
  const out: string[] = [];
  for (const item of a) {
    if (b.includes(item)) out.push(item);
  }
  return out;
}`,
      async (dir, file) => {
        const result = await analyzePerformance(file, dir);
        assert.ok(result.issues.some(i => i.message.includes('indexOf/includes')));
      }
    );
  });
  
  it('flags setInterval without clearInterval as leak risk', async () => {
    await withTempFile(
      `export function poll() {
  setInterval(() => { console.log('tick'); }, 1000);
}`,
      async (dir, file) => {
        const result = await analyzePerformance(file, dir);
        assert.ok(result.memoryLeakRisks.some(r => r.type === 'timer'));
      }
    );
  });
  
  it('clean code scores higher than problem code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perf-'));
    try {
      await writeFile(join(dir, 'clean.ts'), `export const add = (a: number, b: number) => a + b;`);
      await writeFile(join(dir, 'dirty.ts'), `import { readFileSync } from 'node:fs';
export function bad(paths: string[]) {
  for (const p of paths) {
    for (const q of paths) {
      readFileSync(p + q);
    }
  }
}`);
      const clean = await analyzePerformance('clean.ts', dir);
      const dirty = await analyzePerformance('dirty.ts', dir);
      assert.ok(clean.estimatedScore > dirty.estimatedScore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('benchmark', () => {
  it('produces statistics with expected shape', async () => {
    const result = await benchmark('noop', () => { Math.sqrt(2); }, {
      iterations: 20,
      warmupRuns: 2,
    });
    assert.strictEqual(result.name, 'noop');
    assert.ok(result.runs.length > 0);
    assert.ok(result.statistics.mean >= 0);
    assert.ok(result.statistics.min <= result.statistics.max);
    assert.ok(result.statistics.p95 >= result.statistics.median);
  });
  
  it('compareBenchmarks computes speedup ratio', async () => {
    const fast = await benchmark('fast', () => {}, { iterations: 20, warmupRuns: 1 });
    const slow = await benchmark('slow', () => {
      let s = 0;
      for (let i = 0; i < 100000; i++) s += i;
      void s;
    }, { iterations: 20, warmupRuns: 1 });
    
    const cmp = compareBenchmarks(slow, fast);
    assert.ok(cmp.speedup > 1, 'fast candidate vs slow baseline should have speedup > 1');
  });
  
  it('detectRegression is quiet when both are the same fn', async () => {
    const fn = () => { Math.sqrt(123); };
    const a = await benchmark('a', fn, { iterations: 30, warmupRuns: 2 });
    const b = await benchmark('b', fn, { iterations: 30, warmupRuns: 2 });
    const reg = detectRegression(a, b, 300); // 巨大阈值确保不误报
    assert.strictEqual(reg.hasRegression, false);
  });
});

describe('test generator', () => {
  it('generates cases for each function with boundary values', async () => {
    await withTempFile(
      `export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}`,
      async (dir, file) => {
        const result = await generateTests(file, dir, { framework: 'node-test' });
        assert.strictEqual(result.functions.length, 1);
        const func = result.functions[0];
        assert.strictEqual(func.name, 'clamp');
        assert.strictEqual(func.parameters.length, 3);
        assert.ok(func.testCases.length > 0);
        assert.ok(func.testCases.some(c => c.isBoundary), 'should include boundary cases');
        assert.ok(result.testCode.includes("describe('clamp'"));
        assert.ok(result.suggestedPath.endsWith('target.test.ts'));
      }
    );
  });
  
  it('marks console-using function as impure', async () => {
    await withTempFile(
      `export function log(msg: string) { console.log(msg); }
export function pure(x: number) { return x * 2; }`,
      async (dir, file) => {
        const result = await generateTests(file, dir);
        const logFn = result.functions.find(f => f.name === 'log')!;
        const pureFn = result.functions.find(f => f.name === 'pure')!;
        assert.strictEqual(logFn.isPure, false);
        assert.strictEqual(pureFn.isPure, true);
      }
    );
  });
});

describe('coverage utilities', () => {
  it('parses lcov format into file coverage map', () => {
    const lcov = `SF:src/a.ts
FN:1,foo
FNDA:3,foo
DA:1,3
DA:2,0
DA:3,1
end_of_record`;
    const map = parseLcovCoverage(lcov);
    const fc = map.get('src/a.ts')!;
    assert.strictEqual(fc.totalLines, 3);
    assert.strictEqual(fc.coveredLines, 2);
    assert.deepStrictEqual(fc.uncoveredLines, [2]);
    assert.strictEqual(fc.totalFunctions, 1);
    assert.strictEqual(fc.coveredFunctions, 1);
  });
  
  it('badge SVG reflects coverage color tier', () => {
    const green = generateCoverageBadge(95);
    const red = generateCoverageBadge(30);
    assert.ok(green.includes('brightgreen'));
    assert.ok(red.includes('red'));
    assert.ok(green.includes('95%'));
  });
});

describe('doc generator', () => {
  it('extracts exported function with JSDoc description and params', async () => {
    await withTempFile(
      `/**
 * Adds two numbers.
 * @param a first operand
 * @param b second operand
 * @returns the sum
 */
export function add(a: number, b: number): number {
  return a + b;
}
function hidden() {}`,
      async (dir, file) => {
        const apis = await extractAPIFromFile(file, dir);
        const add = apis.find(a => a.name === 'add')!;
        assert.strictEqual(add.exported, true);
        assert.ok(add.description?.includes('Adds two numbers'));
        assert.strictEqual(add.parameters?.length, 2);
        assert.strictEqual(add.parameters![0].description, 'first operand');
        
        const hiddenFn = apis.find(a => a.name === 'hidden')!;
        assert.strictEqual(hiddenFn.exported, false);
        
        const doc = generateAPIDocumentation([add]);
        assert.ok(doc.includes('### add'));
        assert.ok(doc.includes('**参数:**'));
      }
    );
  });
});

describe('changelog', () => {
  it('parses conventional commit with scope', () => {
    const parsed = parseConventionalCommit('feat(editor): add hover support');
    assert.ok(parsed);
    assert.strictEqual(parsed!.type, 'feat');
    assert.strictEqual(parsed!.scope, 'editor');
    assert.strictEqual(parsed!.subject, 'add hover support');
    assert.strictEqual(parsed!.breaking, false);
  });
  
  it('rejects non-conventional messages', () => {
    assert.strictEqual(parseConventionalCommit('random commit message'), null);
    assert.strictEqual(parseConventionalCommit('updated stuff'), null);
  });
  
  it('detects breaking change via bang', () => {
    const parsed = parseConventionalCommit('feat(api): !drop legacy endpoints');
    assert.ok(parsed);
    assert.strictEqual(parsed!.breaking, true);
  });
  
  it('recommendNextVersion follows semver rules', () => {
    const mk = (type: string, breaking = false) => ({
      hash: 'abc1234', type: type as any, subject: 's', breaking,
      date: new Date(), author: 'dev',
    });
    
    assert.strictEqual(recommendNextVersion('1.2.3', [mk('feat', true)]), '2.0.0');
    assert.strictEqual(recommendNextVersion('1.2.3', [mk('feat')]), '1.3.0');
    assert.strictEqual(recommendNextVersion('1.2.3', [mk('fix')]), '1.2.4');
    assert.strictEqual(recommendNextVersion('1.2.3', [mk('chore')]), '1.2.3');
    assert.strictEqual(recommendNextVersion('v2.0.0', [mk('fix')]), '2.0.1');
  });
});
