/**
 * gates.ts — 质量门禁的真实测量实现
 *
 * 供 WorkflowIntegration 和 workflow_execute 工具共用。每个测量都是真实的：
 * coverage 读 istanbul 风格的 coverage-summary.json，complexity 走 AST 分析器，
 * security 跑 npm audit，lint 跑 npm run lint。无法测量时抛出可操作的错误，
 * 由调用方转为 gate 失败原因——绝不返回伪造数值。
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeProject } from '../analysis/complexity.js';
import type { QualityGate } from './types.js';

export type GateMeasurement = { passed: boolean; value: number; error?: string };

function gateError(message: string): GateMeasurement {
  return { passed: false, value: 0, error: message };
}

/** Istanbul 风格的 coverage-summary.json（nyc/c8/vitest --coverage 都会生成）。 */
export async function measureCoverage(workspaceDir: string): Promise<number> {
  const summaryPath = join(workspaceDir, 'coverage', 'coverage-summary.json');
  let raw: string;
  try {
    raw = await readFile(summaryPath, 'utf8');
  } catch {
    throw new Error(
      'Coverage data unavailable: generate coverage/coverage-summary.json ' +
      '(e.g. nyc/c8/vitest --coverage) before this gate runs',
    );
  }
  let summary: unknown;
  try { summary = JSON.parse(raw); } catch {
    throw new Error('coverage/coverage-summary.json is not valid JSON');
  }
  const pct = (summary as { total?: { lines?: { pct?: unknown } } })?.total?.lines?.pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    throw new Error('coverage/coverage-summary.json has no total.lines.pct metric');
  }
  return pct;
}

/** 真实 AST 圈复杂度：对 src/ 下的源文件求平均（有界扫描）。 */
export async function measureComplexity(workspaceDir: string): Promise<number> {
  const { glob } = await import('glob');
  const files = await glob('src/**/*.{ts,tsx,js,jsx}', {
    cwd: workspaceDir,
    ignore: ['**/node_modules/**', '**/dist/**'],
    absolute: true,
  });
  if (files.length === 0) {
    throw new Error('Complexity gate found no source files under src/');
  }
  const report = await analyzeProject(files.slice(0, 500), workspaceDir);
  return report.averageCyclomatic;
}

/** 性能门禁需要真实基准：有 bench/benchmark 脚本就跑并解析毫秒数。 */
export async function measurePerformance(workspaceDir: string): Promise<number> {
  const pkg = await readFile(join(workspaceDir, 'package.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { scripts?: Record<string, string> })
    .catch(() => null);
  const benchScript = pkg?.scripts?.bench ?? pkg?.scripts?.benchmark;
  if (!benchScript) {
    throw new Error('Performance gate requires a "bench" (or "benchmark") npm script to measure');
  }
  const result = spawnSync('npm', ['run', benchScript === 'bench' ? 'bench' : 'benchmark'], {
    cwd: workspaceDir,
    encoding: 'utf-8',
    timeout: 5 * 60_000,
  });
  if (result.error) {
    throw new Error(`Benchmark failed to start: ${result.error.message}`);
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = output.match(/(\d+(?:\.\d+)?)\s*ms/i);
  if (!match) {
    throw new Error('Benchmark output contained no duration in milliseconds');
  }
  return Number(match[1]);
}

/** npm audit 的 high+critical 漏洞计数。 */
export async function scanSecurity(workspaceDir: string): Promise<number> {
  const result = spawnSync('npm', ['audit', '--json'], {
    cwd: workspaceDir,
    encoding: 'utf-8',
    timeout: 2 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || !result.stdout) {
    throw new Error(
      `Security scan unavailable: npm audit failed${result.error ? ` (${result.error.message})` : ' with no output'}`,
    );
  }
  let report: unknown;
  try { report = JSON.parse(result.stdout); } catch {
    throw new Error('npm audit produced unparseable JSON output');
  }
  const vulns = (report as { metadata?: { vulnerabilities?: Record<string, number> } })?.metadata?.vulnerabilities;
  if (!vulns) throw new Error('npm audit report has no metadata.vulnerabilities section');
  return Number(vulns.high ?? 0) + Number(vulns.critical ?? 0);
}

export async function runLint(workspaceDir: string, autoFix: boolean = false): Promise<number> {
  const args = ['run', 'lint'];
  if (autoFix) args.push('--', '--fix');
  const result = spawnSync('npm', args, {
    cwd: workspaceDir,
    encoding: 'utf-8',
    timeout: 5 * 60_000,
  });
  if (result.error) {
    throw new Error(`Lint gate unavailable: ${result.error.message}`);
  }
  if (result.status === 0) return 0;
  const output = result.stdout ?? '';
  const matches = output.match(/(\d+)\s+problem/i);
  return matches ? parseInt(matches[1], 10) : 1;
}

/**
 * 评估单个质量门禁。测量失败（数据缺失、命令不可用）一律返回
 * passed:false + 可操作的 error 原因，门禁绝不静默通过。
 */
export async function measureGate(gate: QualityGate, workspaceDir: string): Promise<GateMeasurement> {
  try {
    switch (gate.type) {
      case 'coverage': {
        const coverage = await measureCoverage(workspaceDir);
        return { passed: coverage >= gate.threshold, value: coverage };
      }
      case 'complexity': {
        const complexity = await measureComplexity(workspaceDir);
        return { passed: complexity <= gate.threshold, value: complexity };
      }
      case 'performance': {
        const duration = await measurePerformance(workspaceDir);
        return { passed: duration <= gate.threshold, value: duration };
      }
      case 'security': {
        const issues = await scanSecurity(workspaceDir);
        return { passed: issues <= gate.threshold, value: issues };
      }
      case 'lint': {
        const issues = await runLint(workspaceDir, gate.autoFix);
        return { passed: issues <= gate.threshold, value: issues };
      }
      default:
        return gateError(`Unknown gate type: ${gate.type}`);
    }
  } catch (error) {
    return gateError(error instanceof Error ? error.message : String(error));
  }
}
