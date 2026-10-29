/**
 * benchmark.ts — 性能基准测试工具
 * 
 * 提供性能基准测试功能：
 * - 函数执行时间测量
 * - 内存使用分析
 * - 吞吐量测试
 * - 性能回归检测
 * - 对比测试
 */

import { performance } from 'node:perf_hooks';

/**
 * 基准测试配置
 */
export interface BenchmarkOptions {
  /** 预热次数 */
  warmupRuns?: number;
  /** 测试迭代次数 */
  iterations?: number;
  /** 最小运行时间（毫秒） */
  minTime?: number;
  /** 最大运行时间（毫秒） */
  maxTime?: number;
  /** 是否测量内存 */
  measureMemory?: boolean;
}

/**
 * 单次测试结果
 */
export interface BenchmarkRun {
  duration: number;        // 毫秒
  memoryUsed?: number;     // 字节
  iterationsPerSecond?: number;
}

/**
 * 基准测试结果
 */
export interface BenchmarkResult {
  name: string;
  runs: BenchmarkRun[];
  statistics: {
    mean: number;
    median: number;
    min: number;
    max: number;
    stdDev: number;
    variance: number;
    p95: number;
    p99: number;
  };
  memoryStatistics?: {
    mean: number;
    max: number;
    peak: number;
  };
  iterationsPerSecond: number;
  totalIterations: number;
  totalTime: number;
}

/**
 * 对比测试结果
 */
export interface ComparisonResult {
  baseline: BenchmarkResult;
  candidate: BenchmarkResult;
  speedup: number;           // 倍数，> 1 表示候选更快
  percentChange: number;     // 百分比变化
  isSignificant: boolean;    // 是否有统计显著性差异
  verdict: 'faster' | 'slower' | 'similar';
}

/**
 * 性能回归检测结果
 */
export interface RegressionResult {
  hasRegression: boolean;
  threshold: number;         // 阈值百分比
  actualChange: number;      // 实际变化百分比
  severity: 'none' | 'minor' | 'major' | 'critical';
  message: string;
}

/**
 * 统计计算
 *
 * 空样本（iterations: 0，或 warmup 后立刻命中 maxTime）以前会产出
 * `mean: NaN / min: undefined / p95: undefined`，这些值一路流到
 * generateComparisonReport 的 `toFixed()` 上直接抛异常。现在空样本返回
 * 全 0 统计，百分位改用 nearest-rank 且夹在 [0, n-1]。
 */
function calculateStatistics(values: number[]): BenchmarkResult['statistics'] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  if (n === 0) {
    return { mean: 0, median: 0, min: 0, max: 0, stdDev: 0, variance: 0, p95: 0, p99: 0 };
  }

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 0
    ? ((sorted[n / 2 - 1] ?? 0) + (sorted[n / 2] ?? 0)) / 2
    : sorted[Math.floor(n / 2)] ?? 0;

  const min = sorted[0] ?? 0;
  const max = sorted[n - 1] ?? 0;

  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  const percentile = (p: number) => sorted[Math.max(0, Math.min(n - 1, Math.ceil(p * n) - 1))] ?? max;
  const p95 = percentile(0.95);
  const p99 = percentile(0.99);

  return { mean, median, min, max, stdDev, variance, p95, p99 };
}

/**
 * 执行基准测试
 *
 * minTime 以前是个死参数：循环只跑 `iterations` 次，`if (totalTime < minTime
 * && i === iterations - 1) { // 不增加 i }` 什么也不做。现在真正按 minTime
 * 补跑到上限（额外样本封顶，避免 1µs 级函数把 runs 数组撑爆内存）。
 */
export async function benchmark(
  name: string,
  fn: () => void | Promise<void>,
  options: BenchmarkOptions = {}
): Promise<BenchmarkResult> {
  const {
    warmupRuns = 5,
    iterations = 100,
    maxTime = 30000,
    measureMemory = false,
  } = options;
  // minTime 只在调用方显式给出时生效（默认值以前形同虚设，补跑会让
  // 只想要 N 次样本的调用方慢一个量级）。
  const minTime = options.minTime;

  const runs: BenchmarkRun[] = [];
  let totalIterations = 0;
  let totalTime = 0;

  // 显式 iterations <= 0 表示"不采样"：返回全 0 的空结果，而不是被 minTime
  // 再补跑出上千条样本（以前这条路径产出 NaN，报告层直接崩）。
  if (iterations <= 0) {
    return {
      name,
      runs,
      statistics: calculateStatistics(runs.map((run) => run.duration)),
      iterationsPerSecond: 0,
      totalIterations: 0,
      totalTime: 0,
    };
  }

  // 预热
  for (let i = 0; i < warmupRuns; i++) {
    await fn();
  }

  // 清理垃圾
  if (global.gc) {
    global.gc();
  }

  const startTime = performance.now();
  const maxRuns = Math.max(iterations, 1) + 1000;

  // 运行测试
  for (let i = 0; i < iterations; i++) {
    await runOnce();
  }
  // minTime 补跑：样本封顶 maxRuns，maxTime 仍优先。
  while (minTime !== undefined && totalTime < minTime && runs.length < maxRuns && totalTime < maxTime) {
    await runOnce();
  }

  async function runOnce() {
    const memBefore = measureMemory ? process.memoryUsage().heapUsed : 0;
    const runStart = performance.now();

    // 以前是 `await fn()`：同步函数每一次迭代都白付一个微任务，测出来的
    // "函数耗时" 其实是调度开销。同步路径保持直调；只有真正返回 Promise
    // 时才等它结束（否则统计的只是 Promise 的创建开销）。
    const value = fn();
    if (value && typeof (value as Promise<void>).then === 'function') {
      await (value as Promise<void>);
    }
    record(runStart, memBefore);
  }

  function record(runStart: number, memBefore: number) {
    const runEnd = performance.now();
    const memAfter = measureMemory ? process.memoryUsage().heapUsed : 0;
    const duration = runEnd - runStart;
    runs.push({
      duration,
      memoryUsed: measureMemory ? Math.max(0, memAfter - memBefore) : undefined,
      iterationsPerSecond: duration > 0 ? 1000 / duration : 0,
    });
    totalIterations++;
    totalTime = runEnd - startTime;
  }
  
  // 计算统计
  const durations = runs.map(r => r.duration);
  const statistics = calculateStatistics(durations);
  
  let memoryStatistics: BenchmarkResult['memoryStatistics'];
  if (measureMemory) {
    const memoryValues = runs.map(r => r.memoryUsed || 0);
    memoryStatistics = {
      mean: memoryValues.length > 0 ? memoryValues.reduce((a, b) => a + b, 0) / memoryValues.length : 0,
      max: memoryValues.length > 0 ? memoryValues.reduce((a, b) => Math.max(a, b), 0) : 0,
      peak: process.memoryUsage().heapUsed,
    };
  }

  // totalTime 为 0（空样本或首轮即 maxTime 中断）时以前是 Infinity/NaN。
  const iterationsPerSecond = totalTime > 0 ? totalIterations / (totalTime / 1000) : 0;
  
  return {
    name,
    runs,
    statistics,
    memoryStatistics,
    iterationsPerSecond,
    totalIterations,
    totalTime,
  };
}

/**
 * 对比两个基准测试
 *
 * baselineMean 为 0 时 percentChange 以前是 NaN/Infinity，detectRegression
 * 会据此判出 "critical 回归"；两边都是 0（例如 iterations: 0 的空样本）
 * 时又是 NaN。现在：两边都为 0 视为无变化；只有一侧为 0 用一个显式的
 * 无穷大/负无穷大表示，报告层格式化成文字而不是 "Infinity%"。
 */
export function compareBenchmarks(
  baseline: BenchmarkResult,
  candidate: BenchmarkResult
): ComparisonResult {
  const baselineMean = baseline.statistics.mean;
  const candidateMean = candidate.statistics.mean;

  let speedup: number;
  let percentChange: number;
  if (baselineMean === 0 && candidateMean === 0) {
    speedup = 1;
    percentChange = 0;
  } else if (baselineMean === 0) {
    speedup = Number.POSITIVE_INFINITY;
    percentChange = Number.POSITIVE_INFINITY;
  } else {
    speedup = baselineMean / candidateMean;
    percentChange = ((candidateMean - baselineMean) / baselineMean) * 100;
  }

  // 简单的统计显著性检验（t-test 简化版）
  const pooledStdDev = Math.sqrt(
    (baseline.statistics.variance + candidate.statistics.variance) / 2
  );
  const standardError = pooledStdDev * Math.sqrt(
    1 / Math.max(1, baseline.runs.length) + 1 / Math.max(1, candidate.runs.length)
  );
  const tStat = standardError > 0
    ? Math.abs(baselineMean - candidateMean) / standardError
    : (baselineMean === candidateMean ? 0 : Number.POSITIVE_INFINITY);
  const isSignificant = tStat > 2;

  let verdict: ComparisonResult['verdict'] = 'similar';

  if (isSignificant && Number.isFinite(speedup)) {
    if (speedup > 1.05) {
      verdict = 'faster';
    } else if (speedup < 0.95) {
      verdict = 'slower';
    }
  } else if (isSignificant) {
    verdict = 'slower'; // 基准为 0、候选非 0：只能确定"变慢了"
  }

  return {
    baseline,
    candidate,
    speedup,
    percentChange,
    isSignificant,
    verdict,
  };
}

/**
 * 检测性能回归
 */
export function detectRegression(
  baseline: BenchmarkResult,
  current: BenchmarkResult,
  thresholdPercent: number = 10
): RegressionResult {
  const comparison = compareBenchmarks(baseline, current);
  const actualChange = comparison.percentChange;
  
  // 正值表示变慢
  const hasRegression = actualChange > thresholdPercent && comparison.isSignificant;
  
  let severity: RegressionResult['severity'] = 'none';
  
  if (hasRegression) {
    if (actualChange > 50) {
      severity = 'critical';
    } else if (actualChange > 30) {
      severity = 'major';
    } else {
      severity = 'minor';
    }
  }
  
  let message = '';
  
  if (hasRegression) {
    message = `⚠️ 性能回归：执行时间增加 ${actualChange.toFixed(2)}%（阈值 ${thresholdPercent}%）`;
  } else if (actualChange < -thresholdPercent && comparison.isSignificant) {
    message = `✅ 性能提升：执行时间减少 ${Math.abs(actualChange).toFixed(2)}%`;
  } else {
    message = `✓ 性能无明显变化（${actualChange.toFixed(2)}%）`;
  }
  
  return {
    hasRegression,
    threshold: thresholdPercent,
    actualChange,
    severity,
    message,
  };
}

/**
 * 批量基准测试
 */
export async function benchmarkSuite(
  tests: Array<{ name: string; fn: () => void | Promise<void> }>,
  options: BenchmarkOptions = {}
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  
  for (const test of tests) {
    console.log(`运行基准测试: ${test.name}...`);
    const result = await benchmark(test.name, test.fn, options);
    results.push(result);
  }
  
  return results;
}

/**
 * 生成基准测试报告
 */
export function generateBenchmarkReport(results: BenchmarkResult[]): string {
  const lines: string[] = [];
  
  lines.push('# 性能基准测试报告\n');
  lines.push(`**测试时间:** ${new Date().toISOString()}\n`);
  
  // 排序：从快到慢
  const sorted = [...results].sort((a, b) => a.statistics.mean - b.statistics.mean);
  
  lines.push('## 测试结果排名\n');
  lines.push('| 排名 | 测试名称 | 平均耗时 | 中位数 | P95 | 吞吐量 (ops/s) |');
  lines.push('|------|----------|----------|--------|-----|----------------|');
  
  for (let i = 0; i < sorted.length; i++) {
    const result = sorted[i];
    const rank = i + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`;
    
    lines.push(
      `| ${medal} | ${result.name} | ` +
      `${result.statistics.mean.toFixed(3)} ms | ` +
      `${result.statistics.median.toFixed(3)} ms | ` +
      `${result.statistics.p95.toFixed(3)} ms | ` +
      `${result.iterationsPerSecond.toFixed(0)} |`
    );
  }
  
  lines.push('');
  
  // 详细统计
  lines.push('## 详细统计\n');
  
  for (const result of results) {
    lines.push(`### ${result.name}\n`);
    lines.push(`- **平均耗时:** ${result.statistics.mean.toFixed(3)} ms`);
    lines.push(`- **中位数:** ${result.statistics.median.toFixed(3)} ms`);
    lines.push(`- **最小值:** ${result.statistics.min.toFixed(3)} ms`);
    lines.push(`- **最大值:** ${result.statistics.max.toFixed(3)} ms`);
    lines.push(`- **标准差:** ${result.statistics.stdDev.toFixed(3)} ms`);
    lines.push(`- **P95:** ${result.statistics.p95.toFixed(3)} ms`);
    lines.push(`- **P99:** ${result.statistics.p99.toFixed(3)} ms`);
    lines.push(`- **吞吐量:** ${result.iterationsPerSecond.toFixed(0)} ops/s`);
    lines.push(`- **总迭代次数:** ${result.totalIterations}`);
    lines.push(`- **总耗时:** ${result.totalTime.toFixed(0)} ms`);
    
    if (result.memoryStatistics) {
      lines.push(`- **平均内存:** ${(result.memoryStatistics.mean / 1024 / 1024).toFixed(2)} MB`);
      lines.push(`- **峰值内存:** ${(result.memoryStatistics.peak / 1024 / 1024).toFixed(2)} MB`);
    }
    
    lines.push('');
  }
  
  // 性能对比
  if (results.length > 1) {
    lines.push('## 性能对比\n');
    
    const fastest = sorted[0];
    
    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const comparison = compareBenchmarks(fastest, current);
      
      lines.push(`- **${current.name}** vs **${fastest.name}**: ` +
                `${comparison.speedup < 1 ? '慢' : '快'} ` +
                `${Math.abs(1 - comparison.speedup).toFixed(2)}x ` +
                `(${comparison.percentChange > 0 ? '+' : ''}${comparison.percentChange.toFixed(2)}%)`);
    }
    
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * 生成对比报告
 *
 * 数字一律经过 `fixed()`：Infinity / NaN（基准耗时为 0 等退化样本）以前会
 * 原样进模板，产出 "Infinity%" 或直接抛异常。
 */
export function generateComparisonReport(comparison: ComparisonResult): string {
  const lines: string[] = [];
  const fixed = (value: number, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a');
  const pct = (value: number) => (Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}%` : 'n/a');

  lines.push('# 性能对比报告\n');

  lines.push(`**基准:** ${comparison.baseline.name}`);
  lines.push(`**候选:** ${comparison.candidate.name}\n`);

  // 结论
  const icon = comparison.verdict === 'faster' ? '✅' :
               comparison.verdict === 'slower' ? '❌' : 'ℹ️';

  let conclusionText = '';
  if (comparison.verdict === 'faster') {
    conclusionText = Number.isFinite(comparison.speedup)
      ? `候选版本更快，提升 ${((comparison.speedup - 1) * 100).toFixed(2)}%`
      : '候选版本更快（基准耗时为 0，无法计算倍数）';
  } else if (comparison.verdict === 'slower') {
    conclusionText = Number.isFinite(comparison.speedup)
      ? `候选版本更慢，下降 ${((1 - comparison.speedup) * 100).toFixed(2)}%`
      : '候选版本更慢（基准耗时为 0，候选未能保持）';
  } else {
    conclusionText = '两者性能相近，无显著差异';
  }

  lines.push(`## ${icon} 结论\n`);
  lines.push(conclusionText);
  lines.push('');

  // 详细数据
  lines.push('## 详细数据\n');
  lines.push('| 指标 | 基准 | 候选 | 变化 |');
  lines.push('|------|------|------|------|');

  const metrics = [
    { name: '平均耗时', baseline: comparison.baseline.statistics.mean, candidate: comparison.candidate.statistics.mean, unit: 'ms' },
    { name: '中位数', baseline: comparison.baseline.statistics.median, candidate: comparison.candidate.statistics.median, unit: 'ms' },
    { name: 'P95', baseline: comparison.baseline.statistics.p95, candidate: comparison.candidate.statistics.p95, unit: 'ms' },
    { name: '吞吐量', baseline: comparison.baseline.iterationsPerSecond, candidate: comparison.candidate.iterationsPerSecond, unit: 'ops/s' },
  ];

  for (const metric of metrics) {
    const change = metric.baseline === 0
      ? Number.NaN
      : ((metric.candidate - metric.baseline) / metric.baseline) * 100;

    lines.push(
      `| ${metric.name} | ${fixed(metric.baseline)} ${metric.unit} | ` +
      `${fixed(metric.candidate)} ${metric.unit} | ${pct(change)} |`
    );
  }

  lines.push('');

  // 统计显著性
  lines.push('## 统计分析\n');
  lines.push(`- **速度倍数:** ${fixed(comparison.speedup)}x`);
  lines.push(`- **百分比变化:** ${pct(comparison.percentChange)}`);
  lines.push(`- **统计显著性:** ${comparison.isSignificant ? '是' : '否'}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * 压力测试
 */
export async function stressTest(
  fn: () => void | Promise<void>,
  options: {
    duration: number;      // 持续时间（毫秒）
    concurrency?: number;  // 并发数
  }
): Promise<{
  totalRuns: number;
  successRate: number;
  throughput: number;
  avgLatency: number;
  errors: Error[];
}> {
  const { duration, concurrency = 1 } = options;
  
  const results: { success: boolean; latency: number }[] = [];
  const errors: Error[] = [];
  
  const startTime = performance.now();
  const endTime = startTime + duration;
  
  const workers: Promise<void>[] = [];
  
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (performance.now() < endTime) {
          const runStart = performance.now();
          try {
            await fn();
            results.push({ success: true, latency: performance.now() - runStart });
          } catch (error) {
            results.push({ success: false, latency: performance.now() - runStart });
            errors.push(error as Error);
          }
        }
      })()
    );
  }
  
  await Promise.all(workers);
  
  const totalRuns = results.length;
  const successCount = results.filter(r => r.success).length;
  const successRate = totalRuns > 0 ? (successCount / totalRuns) * 100 : 0;
  
  const totalTime = (performance.now() - startTime) / 1000; // 秒
  const throughput = totalTime > 0 ? totalRuns / totalTime : 0;

  const latencies = results.map(r => r.latency);
  // 零轮（duration 比一次 fn() 还短）时以前是 0/0 = NaN。
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  
  return {
    totalRuns,
    successRate,
    throughput,
    avgLatency,
    errors,
  };
}
