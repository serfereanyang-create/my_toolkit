/**
 * quality/gates.ts — 质量门禁评估器
 *
 * 每类门禁对接一个现有分析器：
 * - complexity → analysis/complexity.ts 的 analyzeProject(files, root)
 * - smells     → analysis/smells.ts 的 analyzeProject(files, root)
 * - security   → audit/security-scanner.ts 的 scanSecurity
 * - quality    → audit/code-quality-auditor.ts 的 auditCodeQuality
 * - test_ratio → 测试文件 / 源文件 比例代理指标
 * - declared   → 调用方直接声明的指标值（如真实覆盖率）
 */

import { join, relative, extname } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { analyzeProject as analyzeComplexity } from '../analysis/complexity.js';
import { analyzeProject as analyzeSmells } from '../analysis/smells.js';
import { scanSecurity } from '../audit/security-scanner.js';
import { auditCodeQuality } from '../audit/code-quality-auditor.js';
import {
  DEFAULT_GATE_PATTERN,
  type GateResult,
  type GateType,
  type QualityGate,
  type QualityGateReport,
} from './types.js';
import { isIgnoredDirName } from '../workspace/ignored.js';

const MAX_EVIDENCE = 5;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * 收集参与门禁检查的源文件（相对路径，向下遍历工作区）。
 * 不用 glob 包：vitest 的 ESM 解析下 glob 无命名 globSync 导出，
 * 且自遍历与 cli/src/workflow/incremental.ts 的已验证模式一致。
 */
async function walkSourceFiles(current: string, root: string, files: string[], maxFiles: number): Promise<void> {
  if (files.length >= maxFiles) return;

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
      if (files.length >= maxFiles) break;
      if (isIgnoredDirName(entry.name) || entry.name.startsWith('.')) continue;
      await walkSourceFiles(join(current, entry.name), root, files, maxFiles);
    }
  } catch {
    // Skip unreadable entries
  }
}

/** 收集源文件；根目录不存在视为配置错误（抛出→门禁失败），嵌套条目错误静默跳过。 */
async function collectFiles(_pattern: string, workspaceRoot: string): Promise<string[]> {
  const rootInfo = await stat(workspaceRoot);
  if (!rootInfo.isDirectory()) {
    throw new Error('workspace root is not a directory: ' + workspaceRoot);
  }
  const files: string[] = [];
  await walkSourceFiles(workspaceRoot, workspaceRoot, files, 5000);
  return files;
}

/** 收集源文件并排除测试文件。 */
async function collectSourceFiles(pattern: string, workspaceRoot: string): Promise<string[]> {
  const files = await collectFiles(pattern, workspaceRoot);
  return files.filter((f) => !f.includes('.test.') && !f.includes('.spec.'));
}

/** 评估单个门禁。分析器抛错按门禁失败处理（阻断语义由调用方解释）。 */
export async function evaluateQualityGate(gate: QualityGate, workspaceRoot: string): Promise<GateResult> {
  const startedAt = Date.now();
  const direction: GateResult['direction'] =
    gate.type === 'complexity' || gate.type === 'smells' || gate.type === 'security' ? 'max' : 'min';

  try {
    const { value, evidence } = await measureGate(gate, workspaceRoot);
    const passed = direction === 'max' ? value <= gate.threshold : value >= gate.threshold;

    return {
      name: gate.name,
      type: gate.type,
      passed,
      value,
      threshold: gate.threshold,
      direction,
      blocking: gate.blocking,
      message: formatGateMessage(gate, value, passed, direction),
      evidence: passed ? undefined : evidence,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name: gate.name,
      type: gate.type,
      passed: false,
      value: -1,
      threshold: gate.threshold,
      direction,
      blocking: gate.blocking,
      message: '门禁执行失败: ' + (error instanceof Error ? error.message : String(error)),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function measureGate(gate: QualityGate, workspaceRoot: string): Promise<{ value: number; evidence: string[] }> {
  const pattern = gate.pattern ?? DEFAULT_GATE_PATTERN;

  switch (gate.type) {
    case 'complexity': {
      const files = await collectSourceFiles(pattern, workspaceRoot);
      const report = await analyzeComplexity(files, workspaceRoot);

      let criticalCount = 0;
      const evidence: string[] = [];
      for (const file of report.files) {
        for (const fn of file.functions) {
          if (fn.risk === 'critical' || fn.risk === 'high') {
            criticalCount++;
            if (evidence.length < MAX_EVIDENCE) {
              evidence.push('[' + fn.risk + '] ' + file.path + ' — ' + fn.name + ' 圈复杂度 ' + fn.metrics.cyclomatic);
            }
          }
        }
      }
      return { value: criticalCount, evidence };
    }

    case 'smells': {
      const files = await collectSourceFiles(pattern, workspaceRoot);
      const report = await analyzeSmells(files, workspaceRoot);
      const value = report.bySeverity.critical + report.bySeverity.major;
      const evidence = report.topSmells
        .filter((s) => s.severity === 'critical' || s.severity === 'major')
        .slice(0, MAX_EVIDENCE)
        .map((s) => '[' + s.severity + '] ' + s.file + ':' + s.line + ' — ' + s.message);
      return { value, evidence };
    }

    case 'security': {
      const files = await collectSourceFiles(pattern, workspaceRoot);
      let criticalHigh = 0;
      const evidence: string[] = [];

      for (const file of files) {
        const result = await scanSecurity(join(workspaceRoot, file));
        criticalHigh += result.summary.critical + result.summary.high;
        for (const issue of result.issues) {
          if ((issue.severity === 'critical' || issue.severity === 'high') && evidence.length < MAX_EVIDENCE) {
            evidence.push('[' + issue.severity + '] ' + file + ':' + issue.line + ' — ' + issue.message);
          }
        }
      }
      return { value: criticalHigh, evidence };
    }

    case 'test_ratio': {
      const allFiles = await collectFiles('**/*.{ts,tsx}', workspaceRoot);
      const sourceFiles = allFiles.filter((f) => !f.includes('.test.') && !f.includes('.spec.'));
      const testFiles = allFiles.filter((f) => f.includes('.test.') || f.includes('.spec.'));
      const ratio = sourceFiles.length > 0 ? (testFiles.length / sourceFiles.length) * 100 : 0;
      return {
        value: Math.round(ratio * 10) / 10,
        evidence: ['测试文件 ' + testFiles.length + ' / 源文件 ' + sourceFiles.length],
      };
    }

    case 'quality': {
      const files = await collectSourceFiles(pattern, workspaceRoot);
      const report = await auditCodeQuality(files, workspaceRoot, { includeTests: false });
      const evidence = report.issues
        .filter((i) => i.severity === 'critical' || i.severity === 'major')
        .slice(0, MAX_EVIDENCE)
        .map((i) => '[' + i.severity + '] ' + i.file + ' — ' + i.message);
      return { value: report.metrics.overallScore, evidence };
    }

    case 'declared': {
      const value = typeof gate.declaredValue === 'number' ? gate.declaredValue : 0;
      return { value, evidence: ['外部声明值: ' + value] };
    }
  }
}

function formatGateMessage(gate: QualityGate, value: number, passed: boolean, direction: 'max' | 'min'): string {
  const comparison = direction === 'max' ? '≤' : '≥';
  const verdict = passed ? '通过' : (gate.blocking ? '阻断失败' : '非阻断告警');
  return gate.name + ': ' + value + ' ' + comparison + ' ' + gate.threshold + ' — ' + verdict;
}

/** 顺序评估一组门禁并汇总报告。 */
export async function runQualityGates(gates: QualityGate[], workspaceRoot: string): Promise<QualityGateReport> {
  const startedAt = Date.now();
  const results: GateResult[] = [];

  for (const gate of gates) {
    results.push(await evaluateQualityGate(gate, workspaceRoot));
  }

  const failed = results.filter((r) => !r.passed);
  const blockingFailures = failed.filter((r) => r.blocking).length;

  return {
    passed: failed.length === 0,
    blocked: blockingFailures > 0,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    results,
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      blockingFailures,
    },
  };
}

/** 把报告渲染成给 agent/用户看的文本。 */
export function formatGateReport(report: QualityGateReport): string {
  const status = report.blocked
    ? '⛔ 阻断'
    : report.passed
      ? '✅ 全部通过'
      : '⚠️ 有非阻断告警';

  const lines = [
    '质量门禁: ' + status + '（' + report.summary.passed + '/' + report.summary.total + ' 通过，耗时 ' + report.durationMs + 'ms）',
    '',
  ];

  for (const result of report.results) {
    const mark = result.passed ? '✅' : (result.blocking ? '⛔' : '⚠️');
    lines.push(mark + ' ' + result.message);
    if (result.evidence) {
      for (const line of result.evidence) {
        lines.push('     ' + line);
      }
    }
  }

  return lines.join('\n');
}

/** 便捷构造：各类门禁的最简写法。 */
export function makeGate(type: GateType, threshold: number, options: Partial<QualityGate> = {}): QualityGate {
  const defaults: Record<GateType, string> = {
    complexity: '圈复杂度门禁',
    smells: '代码异味门禁',
    security: '安全门禁',
    test_ratio: '测试比例门禁',
    quality: '综合质量门禁',
    declared: '外部指标门禁',
  };
  const blockingByDefault: GateType[] = ['security', 'complexity'];

  return {
    name: options.name ?? defaults[type],
    type,
    threshold,
    blocking: options.blocking ?? blockingByDefault.includes(type),
    pattern: options.pattern,
    declaredValue: options.declaredValue,
  };
}
