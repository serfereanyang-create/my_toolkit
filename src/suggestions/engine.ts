/**
 * suggestions/engine.ts — 智能代码建议引擎
 *
 * 汇聚多路分析器输出 → 归并去重 → 评分排序 → 快赢识别。
 * 评分模型：impact 反映严重度与量化指标，排序 = impact / 工作量权重，
 * 让"高收益低成本"的建议排前面。
 */

import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { relative, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzeProject as analyzeComplexity, DEFAULT_THRESHOLDS } from '../analysis/complexity.js';
import { analyzeProject as analyzeSmells, DEFAULT_SMELL_THRESHOLDS } from '../analysis/smells.js';
import { scanSecurity } from '../audit/security-scanner.js';
import type {
  Suggestion,
  SuggestionCategory,
  SuggestionEffort,
  SuggestionFilter,
  SuggestionPriority,
  SuggestionReport,
} from './types.js';
import { EFFORT_WEIGHT, PRIORITY_ORDER } from './types.js';
import { isIgnoredDirName } from '../workspace/ignored.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const MAX_FILES = 5000;

/** 严重度 → 优先级与收益基数 */
const SEVERITY_MAP: Record<string, { priority: SuggestionPriority; baseImpact: number }> = {
  critical: { priority: 'critical', baseImpact: 90 },
  high: { priority: 'high', baseImpact: 70 },
  major: { priority: 'high', baseImpact: 60 },
  medium: { priority: 'medium', baseImpact: 45 },
  minor: { priority: 'medium', baseImpact: 35 },
  low: { priority: 'low', baseImpact: 20 },
  info: { priority: 'low', baseImpact: 10 },
};

async function walkSourceFiles(current: string, root: string, files: string[]): Promise<void> {
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
      if (isIgnoredDirName(entry.name) || entry.name.startsWith('.')) continue;
      await walkSourceFiles(join(current, entry.name), root, files);
    }
  } catch {
    // Skip unreadable entries
  }
}

async function collectSourceFiles(workspaceRoot: string): Promise<string[]> {
  const files: string[] = [];
  await walkSourceFiles(workspaceRoot, workspaceRoot, files);
  return files.filter((f) => !f.includes('.test.') && !f.includes('.spec.'));
}

function suggestionId(category: SuggestionCategory, file: string, line: number, kind: string): string {
  const raw = category + '|' + file + '|' + line + '|' + kind;
  return 'sug_' + createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/** 由数值指标推导工作量档位。 */
function effortFromMetrics(functionCount: number, lines: number): SuggestionEffort {
  if (functionCount <= 1 && lines <= 20) return 'trivial';
  if (functionCount <= 3 && lines <= 60) return 'easy';
  if (lines <= 200) return 'medium';
  return 'hard';
}

export class SuggestionEngine {
  /** 主入口：扫描工作区并产出排序后的建议报告。 */
  async generate(workspaceRoot: string, filter: SuggestionFilter = {}): Promise<SuggestionReport> {
    const startedAt = Date.now();
    const files = await collectSourceFiles(workspaceRoot);

    const [complexity, smells] = await Promise.all([
      analyzeComplexity(files, workspaceRoot, DEFAULT_THRESHOLDS),
      analyzeSmells(files, workspaceRoot, DEFAULT_SMELL_THRESHOLDS),
    ]);

    const suggestions: Suggestion[] = [];

    // ---- 复杂度建议：高风险函数 → 提取方法 ----
    for (const file of complexity.files) {
      for (const fn of file.functions) {
        if (fn.risk === 'critical' || fn.risk === 'high') {
          const severity = fn.risk === 'critical' ? 'critical' : 'high';
          const mapped = SEVERITY_MAP[severity];
          const effort = effortFromMetrics(1, fn.metrics.loc ?? 50);
          suggestions.push({
            id: suggestionId('refactor', file.path, fn.line, 'extract-method'),
            title: '提取或拆分函数 ' + fn.name,
            category: 'refactor',
            priority: mapped.priority,
            file: file.path,
            line: fn.line,
            description:
              '函数 ' + fn.name + ' 的圈复杂度为 ' + fn.metrics.cyclomatic +
              '、认知复杂度为 ' + fn.metrics.cognitive + '，属于 ' + fn.risk +
              ' 风险。建议按职责拆分为多个小函数，优先抽出深层嵌套的分支逻辑。',
            rationale: '圈复杂度 ' + fn.metrics.cyclomatic + '（阈值 ' + DEFAULT_THRESHOLDS.cyclomatic.critical + '）',
            effort,
            impact: Math.min(95, mapped.baseImpact + fn.metrics.cyclomatic),
            automatable: true,
            suggestedTool: 'extract_method',
          });
        }
      }
    }

    // ---- 异味建议：按异味类型映射类别 ----
    for (const smell of smells.topSmells) {
      const mapped = SEVERITY_MAP[smell.severity] ?? SEVERITY_MAP.info;
      const category = categorizeSmell(smell.type);
      suggestions.push({
        id: suggestionId(category, smell.file, smell.line, smell.type),
        title: smellTitle(smell.type, smell.symbol),
        category,
        priority: mapped.priority,
        file: smell.file,
        line: smell.line,
        description: smell.message + (smell.suggestions.length > 0 ? ' 建议：' + smell.suggestions[0] : ''),
        rationale: '异味类型 ' + smell.type + '，严重度 ' + smell.severity,
        effort: smell.severity === 'critical' ? 'medium' : 'easy',
        impact: mapped.baseImpact,
        automatable: category === 'refactor',
        suggestedTool: category === 'refactor' ? 'quick_rename' : undefined,
      });
    }

    // ---- 安全建议 ----
    for (const file of files.slice(0, 500)) {
      try {
        const scan = await scanSecurity(join(workspaceRoot, file));
        for (const issue of scan.issues) {
          if (issue.severity === 'info' || issue.severity === 'low') continue;
          const mapped = SEVERITY_MAP[issue.severity] ?? SEVERITY_MAP.high;
          suggestions.push({
            id: suggestionId('security', file, issue.line, issue.category),
            title: '修复安全问题：' + issue.category,
            category: 'security',
            priority: mapped.priority,
            file,
            line: issue.line,
            description: issue.description + ' 修复建议：' + issue.recommendation,
            rationale: '类别 ' + issue.category + (issue.cwe ? '，CWE-' + issue.cwe : ''),
            effort: 'easy',
            impact: mapped.baseImpact,
            automatable: false,
          });
        }
      } catch {
        // 单文件扫描失败不影响整体
      }
    }

    // ---- 测试建议：无测试覆盖的源文件 ----
    const allFiles = await (async () => {
      const all: string[] = [];
      await walkSourceFiles(workspaceRoot, workspaceRoot, all);
      return all;
    })();
    const testedBases = new Set(
      allFiles
        .filter((f) => f.includes('.test.') || f.includes('.spec.'))
        .map((f) => f.replace(/\.test\.(ts|tsx)$/, '.ts').replace(/\.spec\.(ts|tsx)$/, '.ts'))
    );
    for (const file of files) {
      const base = file.replace(/\.(ts|tsx)$/, '');
      const hasTest = testedBases.has(base + '.ts') || testedBases.has(base + '.tsx');
      if (!hasTest && !file.endsWith('.d.ts')) {
        suggestions.push({
          id: suggestionId('testing', file, 1, 'missing-test'),
          title: '为 ' + file + ' 补充单元测试',
          category: 'testing',
          priority: 'low',
          file,
          line: 1,
          description: '该文件没有对应的 .test/.spec 文件。补充测试可以锁定当前行为，为后续重构兜底。',
          rationale: '无匹配测试文件',
          effort: 'medium',
          impact: 30,
          automatable: true,
          suggestedTool: 'generate_tests',
        });
      }
    }

    const filtered = this.applyFilter(suggestions, filter);
    const ranked = this.rank(filtered);

    const stats = emptyStats();
    for (const s of ranked) {
      stats[s.category]++;
    }

    return {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      totalFiles: files.length,
      suggestions: ranked.slice(0, filter.maxResults ?? 50),
      stats,
      quickWins: this.findQuickWins(ranked),
    };
  }

  private applyFilter(suggestions: Suggestion[], filter: SuggestionFilter): Suggestion[] {
    let result = suggestions;

    if (filter.categories && filter.categories.length > 0) {
      const wanted = new Set(filter.categories);
      result = result.filter((s) => wanted.has(s.category));
    }
    if (filter.minPriority) {
      const cutoff = PRIORITY_ORDER[filter.minPriority];
      result = result.filter((s) => PRIORITY_ORDER[s.priority] <= cutoff);
    }
    if (filter.filePattern) {
      const pattern = filter.filePattern.toLowerCase();
      result = result.filter((s) => s.file.toLowerCase().includes(pattern));
    }
    if (filter.onlyAutomatable) {
      result = result.filter((s) => s.automatable);
    }
    return result;
  }

  /** 排序：收益/成本 比 降序，同级按优先级。 */
  private rank(suggestions: Suggestion[]): Suggestion[] {
    return [...suggestions].sort((a, b) => {
      const scoreA = a.impact / EFFORT_WEIGHT[a.effort];
      const scoreB = b.impact / EFFORT_WEIGHT[b.effort];
      if (scoreB !== scoreA) return scoreB - scoreA;
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    });
  }

  /** 快赢：高收益 + 低工作量，最多 5 条。 */
  private findQuickWins(ranked: Suggestion[]): Suggestion[] {
    return ranked
      .filter((s) => (s.effort === 'trivial' || s.effort === 'easy') && s.impact >= 40)
      .slice(0, 5);
  }
}

function emptyStats(): Record<SuggestionCategory, number> {
  return { refactor: 0, security: 0, performance: 0, testing: 0, architecture: 0 };
}

function categorizeSmell(smellType: string): SuggestionCategory {
  if (smellType.includes('performance') || smellType.includes('perf')) return 'performance';
  if (smellType.includes('god_class') || smellType.includes('circular') || smellType.includes('layer')) {
    return 'architecture';
  }
  return 'refactor';
}

function smellTitle(smellType: string, symbol: string): string {
  const target = symbol || '该符号';
  switch (smellType) {
    case 'long_method': return '缩短过长方法 ' + target;
    case 'long_parameter_list': return '收敛 ' + target + ' 的过长参数列表';
    case 'large_class': return '拆分大类 ' + target;
    case 'god_class': return '拆分上帝类 ' + target;
    case 'duplicate_code': return '合并重复代码';
    case 'switch_statements': return '用多态/查表替换 ' + target + ' 的 switch';
    case 'dead_code': return '删除死代码';
    case 'magic_number': return '为魔法数字命名';
    case 'deep_nesting': return '拍平 ' + target + ' 的深层嵌套';
    case 'message_chains': return '缩短 ' + target + ' 的消息链';
    case 'feature_envy': return '让 ' + target + ' 回到归属的数据旁';
    default: return '处理代码异味 ' + smellType;
  }
}
