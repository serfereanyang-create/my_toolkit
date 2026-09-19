/**
 * health/collector.ts — 健康度快照采集器
 *
 * 复用现有分析器（复杂度/异味/安全）与文件遍历，产出一份可持久化的
 * HealthSnapshot。分数模型确定性：同样输入永远得到同样分数。
 */

import { join, relative, extname } from 'node:path';
import { readdir, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { analyzeProject as analyzeComplexity, DEFAULT_THRESHOLDS } from '../analysis/complexity.js';
import { analyzeProject as analyzeSmells, DEFAULT_SMELL_THRESHOLDS } from '../analysis/smells.js';
import { scanSecurity } from '../audit/security-scanner.js';
import type { HealthMetrics, HealthScores, HealthSnapshot } from './types.js';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.aicode']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const MAX_FILES = 5000;
const MAX_SECURITY_SCAN_FILES = 300;

async function walkFiles(current: string, root: string, files: string[]): Promise<void> {
  if (files.length >= MAX_FILES) return;

  try {
    const info = await stat(current);
    if (info.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(current))) {
        files.push(relative(root, current).replace(/\\/g, '/'));
      }
      return;
    }
    if (!info.isDirectory()) return;

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkFiles(join(current, entry.name), root, files);
    }
  } catch {
    // Skip unreadable entries
  }
}

/** 阈值饱和度打分：value 越偏离 ideal 越低分，在 ideal 与 worst 之间线性插值。 */
function clampScore(value: number, ideal: number, worst: number): number {
  if (worst <= ideal) return value <= ideal ? 100 : 0;
  const ratio = (value - ideal) / (worst - ideal);
  const score = 100 * (1 - Math.min(1, Math.max(0, ratio)));
  return Math.round(score);
}

export class HealthCollector {
  /**
   * 采集一次健康快照。skipSecurity 用于快速模式（安全扫描较慢）。
   */
  async collect(workspaceRoot: string, options: { skipSecurity?: boolean; skipAnalyzers?: boolean } = {}): Promise<HealthSnapshot> {
    const files: string[] = [];
    await walkFiles(workspaceRoot, workspaceRoot, files);

    const sourceFiles = files.filter((f) => !f.includes('.test.') && !f.includes('.spec.'));
    const testFiles = files.filter((f) => f.includes('.test.') || f.includes('.spec.'));

    let linesOfCode = 0;
    for (const file of sourceFiles) {
      try {
        const content = await readFile(join(workspaceRoot, file), 'utf8');
        linesOfCode += content.split('\n').length;
      } catch {
        // Skip unreadable files
      }
    }

    let avgComplexity = 0;
    let riskyFunctions = 0;
    let codeSmells = 0;
    let securityIssues = 0;

    if (!options.skipAnalyzers && sourceFiles.length > 0) {
      try {
        const complexity = await analyzeComplexity(sourceFiles, workspaceRoot, DEFAULT_THRESHOLDS);
        avgComplexity = complexity.totalFunctions > 0
          ? Math.round((complexity.averageCyclomatic ?? 0) * 100) / 100
          : 0;
        for (const file of complexity.files) {
          for (const fn of file.functions) {
            if (fn.risk === 'critical' || fn.risk === 'high') riskyFunctions++;
          }
        }
      } catch {
        // 分析失败按 0 处理
      }

      try {
        const smells = await analyzeSmells(sourceFiles, workspaceRoot, DEFAULT_SMELL_THRESHOLDS);
        codeSmells = smells.bySeverity.critical + smells.bySeverity.major;
      } catch {
        // 同上
      }
    }

    if (!options.skipSecurity) {
      const scanTargets = sourceFiles.slice(0, MAX_SECURITY_SCAN_FILES);
      for (const file of scanTargets) {
        try {
          const result = await scanSecurity(join(workspaceRoot, file));
          securityIssues += result.summary.critical + result.summary.high;
        } catch {
          // 单文件失败跳过
        }
      }
    }

    const testRatio = sourceFiles.length > 0
      ? Math.round((testFiles.length / sourceFiles.length) * 1000) / 10
      : 0;

    const metrics: HealthMetrics = {
      linesOfCode,
      sourceFiles: sourceFiles.length,
      testFiles: testFiles.length,
      testRatio,
      avgComplexity,
      riskyFunctions,
      securityIssues,
      codeSmells,
    };

    const scores = computeScores(metrics);

    return {
      id: 'hs_' + createHash('sha256')
        .update(JSON.stringify(metrics) + (options.skipSecurity ? '|skipsec' : ''))
        .digest('hex')
        .slice(0, 12),
      timestamp: new Date().toISOString(),
      metrics,
      scores,
    };
  }
}

/** 确定性分数模型：结构 / 安全 / 测试纪律 / 综合。 */
export function computeScores(metrics: HealthMetrics): HealthScores {
  // 结构：复杂度越低越好，风险函数越少越好
  const complexityScore = clampScore(metrics.avgComplexity, 1, 15);
  const riskScore = clampScore(metrics.riskyFunctions, 0, Math.max(10, metrics.sourceFiles * 0.2));
  const structure = Math.round(complexityScore * 0.6 + riskScore * 0.4);

  // 安全：0 问题满分，按源文件规模线性放宽
  const security = clampScore(metrics.securityIssues, 0, Math.max(5, metrics.sourceFiles * 0.1));

  // 测试纪律：比例 40% 满分，0% 零分；没有源文件时不惩罚
  const testDiscipline = metrics.sourceFiles === 0
    ? 100
    : clampScore(-metrics.testRatio, -40, 0);

  const overall = Math.round(structure * 0.4 + security * 0.35 + testDiscipline * 0.25);

  return { overall, structure, security, testDiscipline };
}
