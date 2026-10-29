/**
 * health/collector.ts — 健康度快照采集器
 *
 * 复用现有分析器（复杂度/异味/安全）与文件遍历，产出一份可持久化的
 * HealthSnapshot。分数模型确定性：同样输入永远得到同样分数。
 *
 * 采集的每一个失败都进 `warnings`。旧实现把「读不了的文件」「分析器抛错」
 * 一律折成 0：一个分析器全挂、或根目录根本不存在时，得分仍是 100/100，
 * 报告却看不出一丝异常（实测：不存在的目录 → overall 100，0 warnings）。
 * 分数本身仍按可用数据计算，但「这次采集不全」必须随快照一起说出来。
 */

import { join, relative, extname } from 'node:path';
import { readdir, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { analyzeProject as analyzeComplexity, DEFAULT_THRESHOLDS } from '../analysis/complexity.js';
import { analyzeProject as analyzeSmells, DEFAULT_SMELL_THRESHOLDS } from '../analysis/smells.js';
import { scanSecurity } from '../audit/security-scanner.js';
import type { HealthMetrics, HealthScores, HealthSnapshot } from './types.js';
import { isIgnoredDirName } from '../workspace/ignored.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const MAX_FILES = 5000;
const MAX_SECURITY_SCAN_FILES = 300;
/** 警告上限：一次遍历能命中几千个坏文件，报告里只留前若干条 + 汇总。 */
const MAX_WARNINGS = 20;

export type HealthCollectOptions = {
  skipSecurity?: boolean;
  skipAnalyzers?: boolean;
};

export class HealthCollector {
  /**
   * 采集一次健康快照。skipSecurity 用于快速模式（安全扫描较慢）。
   */
  async collect(workspaceRoot: string, options: HealthCollectOptions = {}): Promise<HealthSnapshot> {
    const warnings: string[] = [];
    let suppressed = 0;
    const warn = (message: string): void => {
      if (warnings.length < MAX_WARNINGS) warnings.push(message);
      else suppressed += 1;
    };

    const files: string[] = [];
    const walk = await walkFiles(workspaceRoot, workspaceRoot, files);
    if (!walk.readable) {
      warn(`工作区无法读取（${workspaceRoot}）：${walk.reason ?? '未知错误'}。本次快照不代表任何代码。`);
    }
    if (walk.unreadableEntries > 0) warn(`${walk.unreadableEntries} 个目录/文件无法读取，已被跳过。`);
    if (walk.truncated) warn(`文件数达到上限 ${MAX_FILES}，其余文件未统计。`);

    const sourceFiles = files.filter((f) => !f.includes('.test.') && !f.includes('.spec.'));
    const testFiles = files.filter((f) => f.includes('.test.') || f.includes('.spec.'));

    let linesOfCode = 0;
    let unreadableFiles = 0;
    for (const file of sourceFiles) {
      try {
        const content = await readFile(join(workspaceRoot, file), 'utf8');
        // 统计的是代码行，不是换行符个数：末尾带换行的两行文件曾被计成 3 行。
        const lines = content.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        linesOfCode += lines.length;
      } catch {
        unreadableFiles += 1;
      }
    }
    if (unreadableFiles > 0) warn(`${unreadableFiles} 个源文件无法读取，行数统计偏低。`);

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
      } catch (error) {
        // 分析失败按 0 处理，但必须记下来：0 复杂度 + 0 风险函数 = 结构满分。
        warn(`复杂度分析失败，结构分按无风险计算：${errorMessage(error)}`);
      }

      try {
        const smells = await analyzeSmells(sourceFiles, workspaceRoot, DEFAULT_SMELL_THRESHOLDS);
        codeSmells = smells.bySeverity.critical + smells.bySeverity.major;
      } catch (error) {
        warn(`异味分析失败，异味数按 0 计算：${errorMessage(error)}`);
      }
    }

    if (!options.skipSecurity) {
      const scanTargets = sourceFiles.slice(0, MAX_SECURITY_SCAN_FILES);
      let scanFailures = 0;
      for (const file of scanTargets) {
        try {
          const result = await scanSecurity(join(workspaceRoot, file));
          securityIssues += result.summary.critical + result.summary.high;
        } catch {
          scanFailures += 1;
        }
      }
      if (scanFailures > 0) warn(`${scanFailures} 个文件安全扫描失败，安全问题数偏低。`);
      if (sourceFiles.length > MAX_SECURITY_SCAN_FILES) {
        warn(`安全扫描只覆盖前 ${MAX_SECURITY_SCAN_FILES} 个文件（共 ${sourceFiles.length} 个）。`);
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

    if (suppressed > 0) warnings.push(`另有 ${suppressed} 条警告未列出。`);

    return {
      id: 'hs_' + createHash('sha256')
        .update(JSON.stringify(metrics) + (options.skipSecurity ? '|skipsec' : ''))
        .digest('hex')
        .slice(0, 12),
      timestamp: new Date().toISOString(),
      metrics,
      scores,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walk the tree, collecting source files.
 *
 * Returns what went wrong instead of swallowing it: an unreadable ROOT is a
 * configuration error (the caller asked to measure a directory that does not
 * exist), while an unreadable directory deeper in the tree means the snapshot is
 * partial. Both used to be silent, and the resulting all-zero metrics scored 100.
 */
async function walkFiles(
  current: string,
  root: string,
  files: string[],
): Promise<{ readable: boolean; reason?: string; unreadableEntries: number; truncated: boolean }> {
  let unreadableEntries = 0;
  let truncated = false;

  const isRoot = current === root;
  const visit = async (dir: string): Promise<void> => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    let info;
    try {
      info = await stat(dir);
    } catch (error) {
      if (isRoot && dir === root) throw error;
      unreadableEntries += 1;
      return;
    }
    if (info.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(dir))) {
        files.push(relative(root, dir).replace(/\\/g, '/'));
      }
      return;
    }
    if (!info.isDirectory()) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (dir === root) throw error;
      unreadableEntries += 1;
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      if (isIgnoredDirName(entry.name) || entry.name.startsWith('.')) continue;
      await visit(join(dir, entry.name));
    }
  };

  try {
    await visit(current);
  } catch (error) {
    return { readable: false, reason: errorMessage(error), unreadableEntries, truncated };
  }
  return { readable: true, unreadableEntries, truncated };
}

/** 阈值饱和度打分：value 越偏离 ideal 越低分，在 ideal 与 worst 之间线性插值。 */
function clampScore(value: number, ideal: number, worst: number): number {
  if (worst <= ideal) return value <= ideal ? 100 : 0;
  const ratio = (value - ideal) / (worst - ideal);
  const score = 100 * (1 - Math.min(1, Math.max(0, ratio)));
  return Math.round(score);
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
