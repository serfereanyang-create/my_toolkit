/**
 * performanceAudit.test.ts — degenerate samples and analyzer false positives.
 *
 * benchmark(): empty runs used to produce NaN statistics that crashed
 * generateComparisonReport (`toFixed` on undefined); a zero-length baseline made
 * percentChange Infinity; stressTest with a too-short window divided by zero.
 * performance-analyzer: method names were read from the object text
 * (`.endsWith('.concat')` never matched), `setInterval` cleaned up in a sibling
 * method was reported as a leak, and a plain two-level loop was reported as
 * three levels because forEachChild re-entered the nested loop.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  benchmark,
  compareBenchmarks,
  generateComparisonReport,
  stressTest,
  type BenchmarkResult,
} from '../src/performance/benchmark.js';
import { analyzePerformance } from '../src/performance/performance-analyzer.js';

function synthetic(mean: number, options: { variance?: number; runs?: number; ips?: number } = {}): BenchmarkResult {
  const runs = options.runs ?? 5;
  const stats = {
    mean,
    median: mean,
    min: mean,
    max: mean,
    stdDev: Math.sqrt(options.variance ?? 0),
    variance: options.variance ?? 0,
    p95: mean,
    p99: mean,
  };
  return {
    name: 'synthetic',
    runs: Array.from({ length: runs }, () => ({ duration: mean })),
    statistics: stats,
    iterationsPerSecond: options.ips ?? 1,
    totalIterations: runs,
    totalTime: mean * runs,
  };
}

test('benchmark with iterations: 0 returns finite zero statistics', async () => {
  let calls = 0;
  const result = await benchmark('empty', () => { calls += 1; }, { iterations: 0, warmupRuns: 0 });
  assert.equal(calls, 0, 'zero iterations must not run the function');
  assert.equal(result.runs.length, 0);
  for (const value of Object.values(result.statistics)) assert.ok(Number.isFinite(value), `NaN statistic: ${value}`);
  assert.equal(result.iterationsPerSecond, 0);
});

test('comparison with an empty baseline renders instead of throwing', async () => {
  const empty = await benchmark('empty', () => {}, { iterations: 0, warmupRuns: 0 });
  const real = synthetic(2);
  const report = generateComparisonReport(compareBenchmarks(empty, real));
  assert.doesNotMatch(report, /Infinity|NaN|undefined/);
  assert.match(report, /n\/a/);
});

test('comparison with two empty samples is "similar", not a regression', () => {
  const emptyA = synthetic(0);
  const emptyB = synthetic(0);
  const cmp = compareBenchmarks(emptyA, emptyB);
  assert.equal(cmp.percentChange, 0);
  assert.equal(cmp.speedup, 1);
  assert.equal(cmp.verdict, 'similar');
});

test('zero-variance samples do not divide by a zero standard error', () => {
  const cmp = compareBenchmarks(synthetic(100), synthetic(200));
  assert.ok(Number.isFinite(cmp.speedup));
  assert.ok(Number.isFinite(cmp.percentChange));
  assert.ok(!Number.isNaN(cmp.percentChange));
});

test('minTime backfill only runs when explicitly requested', async () => {
  let calls = 0;
  await benchmark('n', () => { calls += 1; }, { iterations: 5, warmupRuns: 0 });
  assert.equal(calls, 5, 'no minTime means exactly the requested iterations');

  calls = 0;
  await benchmark('n', () => { calls += 1; }, { iterations: 5, warmupRuns: 0, minTime: 5, maxTime: 10_000 });
  assert.ok(calls > 5, `minTime should backfill, got ${calls}`);
});

test('stressTest with a zero-length window returns zeros, not NaN', async () => {
  const result = await stressTest(async () => {}, { duration: 0 });
  assert.equal(result.totalRuns, 0);
  assert.equal(result.avgLatency, 0);
  assert.ok(Number.isFinite(result.throughput));
  assert.equal(result.successRate, 0);
});

// ─── Analyzer ───────────────────────────────────────────────────────────────

async function withSource(source: string, fn: (dir: string, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'perf-audit-'));
  try {
    await writeFile(join(dir, 'target.ts'), source, 'utf8');
    await fn(dir, 'target.ts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('concat/indexOf inside a loop are detected by method name', async () => {
  await withSource(
    `export function build(a: string[], b: string[]) {
  let out: string[] = [];
  for (const item of a) {
    out = out.concat([item]);
    if (b.indexOf(item) >= 0) out.push(item);
  }
  return out;
}`,
    async (dir, file) => {
      const result = await analyzePerformance(file, dir);
      assert.ok(result.issues.some((issue) => issue.message.includes('concat')), 'concat should be flagged');
      assert.ok(result.issues.some((issue) => issue.message.includes('indexOf/includes')), 'indexOf should be flagged');
    },
  );
});

test('a plain double loop is reported as O(n^2), not O(n^3)', async () => {
  await withSource(
    `export function pairs(a: number[]) {
  for (const x of a) {
    for (const y of a) {
      console.log(x, y);
    }
  }
}`,
    async (dir, file) => {
      const result = await analyzePerformance(file, dir);
      const messages = result.issues.filter((issue) => issue.category === 'algorithm').map((issue) => issue.message);
      assert.ok(messages.some((message) => message.includes('2 层')), messages.join('\n'));
      assert.ok(!messages.some((message) => message.includes('3 层')), 'must not over-count nesting');
    },
  );
});

test('setInterval cleaned up in a sibling method is not reported as a leak', async () => {
  await withSource(
    `export class Ticker {
  private timer?: ReturnType<typeof setInterval>;
  start() {
    this.timer = setInterval(() => {}, 32);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}`,
    async (dir, file) => {
      const result = await analyzePerformance(file, dir);
      assert.deepEqual(result.memoryLeakRisks.filter((risk) => risk.type === 'timer'), []);
    },
  );
});

test('a genuinely uncleaned setInterval is still reported', async () => {
  await withSource(
    `export function poll() {
  setInterval(() => { console.log('tick'); }, 1000);
}`,
    async (dir, file) => {
      const result = await analyzePerformance(file, dir);
      assert.ok(result.memoryLeakRisks.some((risk) => risk.type === 'timer'));
    },
  );
});

test('regex flags are read from the literal, not the pattern text', async () => {
  await withSource(
    `export function scan(lines: string[]) {
  const hits: string[] = [];
  for (const line of lines) {
    const re = /getUser/g;
    if (re.test(line)) hits.push(line);
  }
  return hits;
}`,
    async (dir, file) => {
      const result = await analyzePerformance(file, dir);
      assert.ok(result.issues.some((issue) => issue.message.includes('循环内创建正则')), 'global regex in loop should be flagged');
      assert.ok(!result.issues.some((issue) => issue.message.includes('灾难性回溯')), 'a plain /g/ regex is not catastrophic');
    },
  );
});

test('nested quantifier regex is flagged as catastrophic', async () => {
  await withSource(
    `export const pattern = /(.+)+/;
`,
    async (dir, file) => {
      const result = await analyzePerformance(file, dir);
      assert.ok(result.issues.some((issue) => issue.message.includes('灾难性回溯')));
    },
  );
});

test('a regex word ending in g is not mistaken for the global flag', async () => {
  await withSource(
    `export function scan(lines: string[]) {
  for (const line of lines) {
    if (/gg/.test(line)) return true;
  }
  return false;
}`,
    async (dir, file) => {
      const result = await analyzePerformance(file, dir);
      assert.ok(!result.issues.some((issue) => issue.message.includes('循环内创建正则')), 'pattern letters are not flags');
    },
  );
});

test('a global regex inside for-of is still flagged', async () => {
  await withSource(
    `export function scan(lines: string[]) {
  for (const line of lines) {
    if (/x/g.test(line)) return true;
  }
  return false;
}`,
    async (dir, file) => {
      const result = await analyzePerformance(file, dir);
      assert.ok(result.issues.some((issue) => issue.message.includes('循环内创建正则')), 'for-of is a loop');
    },
  );
});
