/**
 * analysis.ts — 代码分析工具集成（CLI 工具注册）
 * 
 * 将代码分析功能注册为 CLI 工具，供 agent 调用
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import {
  analyzeProject as analyzeComplexity,
  DEFAULT_THRESHOLDS as COMPLEXITY_THRESHOLDS,
  type ComplexityThresholds,
} from './complexity.js';
import {
  analyzeProject as analyzeSmells,
} from './smells.js';
import {
  analyzeDependencies,
  COMMON_LAYER_CONFIGS,
  exportToDot,
  type LayerDefinition,
} from './dependency-graph.js';
import { globSync } from 'glob';

/** 单次分析工具调用的文件数上限；超过部分截断并如实报告。 */
const MAX_ANALYZE_FILES = 800;
/** 导出供测试与外部调用方使用。 */
export const ANALYZE_FILE_BUDGET = MAX_ANALYZE_FILES;

/**
 * 按确定性顺序截断文件列表到预算内，返回 { files, truncated, total }。
 * 排序保证同一输入的选择稳定，避免截断结果每次不同。
 */
export function applyFileBudget(files: string[], maxFiles: number = MAX_ANALYZE_FILES): {
  files: string[];
  total: number;
  truncated: boolean;
} {
  const sorted = [...new Set(files)].sort();
  return {
    files: sorted.slice(0, maxFiles),
    total: sorted.length,
    truncated: sorted.length > maxFiles,
  };
}

/**
 * thresholds 深合并：只接受与默认值同形的键，嵌套对象逐层合并（而不是被
 * 整体替换），未知键或非有限数值一律忽略并收集名称，由调用方如实报告。
 */
export function mergeThresholds(defaults: Record<string, unknown>, override: unknown): { merged: Record<string, unknown>; ignored: string[] } {
  if (typeof override !== 'object' || override === null || Array.isArray(override)) {
    return { merged: { ...defaults }, ignored: [] };
  }
  const ignored: string[] = [];
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (!(key in defaults)) {
      ignored.push(key);
      continue;
    }
    const base = defaults[key]!;
    if (typeof base === 'object' && base !== null && !Array.isArray(base)) {
      // 只有覆盖值也是对象时才递归合并；否则类型不符，记录并跳过。
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const nested = mergeThresholds(base as Record<string, unknown>, value);
        out[key] = nested.merged;
        // 嵌套里的未知键也要上报，不能静默丢弃。
        ignored.push(...nested.ignored.map((entry) => `${key}.${entry}`));
      } else {
        ignored.push(key);
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else {
      ignored.push(key);
    }
  }
  return { merged: out, ignored };
}

function formatIgnored(ignored: string[], label: string): string {
  return ignored.length > 0
    ? `\n\n⚠️ 忽略了无效的 ${label} 项: ${ignored.join(', ')}（未知键或非有限数值）`
    : '';
}

/**
 * 代码复杂度分析工具
 */
export const analyzeComplexityTool = defineTool({
  name: 'analyze_complexity',
  description: '分析代码复杂度（圈复杂度、认知复杂度、嵌套深度等），识别高风险函数',
  risk: 'read',
  input: {
    pattern: { 
      type: 'string', 
      description: 'Glob 模式匹配文件，例如 "src/**/*.ts"。默认 "**/*.{ts,tsx,js,jsx}"' 
    },
    thresholds: {
      type: 'object',
      description: '自定义阈值（可选）。例如 {"cyclomatic":{"moderate":6,"high":11,"critical":21}}',
      optional: true,
    },
  },
  examples: [
    {
      input: { pattern: 'src/**/*.ts' },
      output: '分析 src 目录下所有 TypeScript 文件的复杂度',
    },
    {
      input: { pattern: 'src/services/*.ts', thresholds: { cyclomatic: { moderate: 4, high: 8, critical: 15 } } },
      output: '使用更严格的阈值分析服务层代码',
    },
  ],
  
  async execute({ pattern = '**/*.{ts,tsx,js,jsx}', thresholds }, context): Promise<ToolResult> {
    try {
      const workspaceRoot = context.cwd;
      const allFiles = globSync(pattern, {
        cwd: workspaceRoot,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts'],
      });
      const budget = applyFileBudget(allFiles);
      const files = budget.files;

      if (files.length === 0) {
        return {
          ok: true,
          output: `未找到匹配的文件：${pattern}`,
        };
      }

      const { merged: rawThresholds, ignored } = thresholds !== undefined
        ? mergeThresholds(COMPLEXITY_THRESHOLDS as unknown as Record<string, unknown>, thresholds)
        : { merged: COMPLEXITY_THRESHOLDS as unknown as Record<string, unknown>, ignored: [] as string[] };
      // 合并严格按 defaults 的键结构展开，结构化转换是安全的。
      const mergedThresholds = rawThresholds as unknown as ComplexityThresholds;

      const result = await analyzeComplexity(files, workspaceRoot, mergedThresholds);

      const lines: string[] = [];
      lines.push('# 代码复杂度分析报告\n');
      lines.push(`**分析范围:** ${pattern}`);
      lines.push(`**文件总数:** ${result.totalFiles}${budget.truncated ? `（匹配 ${budget.total} 个，已达 ${files.length} 上限，其余截断）` : ''}`);
      lines.push(`**函数总数:** ${result.totalFunctions}`);
      lines.push(`**平均圈复杂度:** ${result.averageCyclomatic.toFixed(2)}`);
      lines.push(`**平均认知复杂度:** ${result.averageCognitive.toFixed(2)}\n`);
      
      lines.push('## 风险分布\n');
      lines.push(`- 低风险: ${result.distribution.low}`);
      lines.push(`- 中等风险: ${result.distribution.moderate}`);
      lines.push(`- 高风险: ${result.distribution.high}`);
      lines.push(`- 严重风险: ${result.distribution.critical}\n`);
      
      if (result.hotspots.length > 0) {
        lines.push('## 复杂度热点（前10个最复杂函数）\n');
        for (const func of result.hotspots) {
          const file = result.files.find(f => 
            f.functions.some(fn => fn.name === func.name && fn.line === func.line)
          );
          lines.push(`### ${func.name} (${func.kind})`);
          lines.push(`**位置:** ${file?.path || '?'}:${func.line}`);
          lines.push(`**风险等级:** ${func.risk}`);
          lines.push(`**圈复杂度:** ${func.metrics.cyclomatic}`);
          lines.push(`**认知复杂度:** ${func.metrics.cognitive}`);
          lines.push(`**最大嵌套:** ${func.metrics.maxNesting}`);
          lines.push(`**参数数量:** ${func.metrics.parameters}`);
          lines.push(`**代码行数:** ${func.metrics.loc}\n`);
        }
      }
      
      // 高风险文件
      const highRiskFiles = result.files.filter(f => f.highRiskCount > 0);
      if (highRiskFiles.length > 0) {
        lines.push('## 高风险文件\n');
        for (const file of highRiskFiles.slice(0, 10)) {
          lines.push(`- **${file.path}**: ${file.highRiskCount} 个高风险函数`);
        }
        lines.push('');
      }
      
      lines.push('## 建议\n');
      if (result.distribution.critical > 0) {
        lines.push('- ⚠️ **严重复杂度问题：** 优先重构严重风险函数，使用 Extract Method 拆分逻辑');
      }
      if (result.distribution.high > 5) {
        lines.push('- 📊 **高复杂度较多：** 考虑制定重构计划，逐步降低复杂度');
      }
      if (result.averageCyclomatic > 8) {
        lines.push('- 📈 **平均复杂度偏高：** 团队应加强代码审查，控制新增代码复杂度');
      }
      
      return {
        ok: true,
        output: lines.join('\n') + formatIgnored(ignored, 'thresholds'),
        data: { ...result, truncated: budget.truncated, totalMatches: budget.total },
      };
    } catch (error) {
      return {
        ok: false,
        output: `复杂度分析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 代码异味检测工具
 */
export const analyzeSmellsTool = defineTool({
  name: 'detect_code_smells',
  description: '检测代码异味（长方法、上帝类、重复代码、魔法数字等），提供重构建议',
  risk: 'read',
  input: {
    pattern: { 
      type: 'string', 
      description: 'Glob 模式匹配文件，例如 "src/**/*.ts"。默认 "**/*.{ts,tsx,js,jsx}"' 
    },
    severity: {
      type: 'string',
      description: '筛选严重级别: all | critical | major | minor | info。默认 all',
      optional: true,
    },
  },
  examples: [
    {
      input: { pattern: 'src/**/*.ts' },
      output: '检测所有代码异味',
    },
    {
      input: { pattern: 'src/**/*.ts', severity: 'major' },
      output: '仅显示 major 和 critical 级别的异味',
    },
  ],
  
  async execute({ pattern = '**/*.{ts,tsx,js,jsx}', severity = 'all' }, context): Promise<ToolResult> {
    try {
      const workspaceRoot = context.cwd;
      const allFiles = globSync(pattern, {
        cwd: workspaceRoot,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts'],
      });
      const budget = applyFileBudget(allFiles);
      const files = budget.files;

      if (files.length === 0) {
        return {
          ok: true,
          output: `未找到匹配的文件：${pattern}`,
        };
      }

      const result = await analyzeSmells(files, workspaceRoot);
      
      // 筛选严重级别
      const severityFilter = ['critical', 'major', 'minor', 'info'];
      const minIndex = severity === 'all' ? 3 : 
                      severity === 'critical' ? 0 :
                      severity === 'major' ? 1 :
                      severity === 'minor' ? 2 : 3;
      
      const filteredSmells = result.topSmells.filter(smell => 
        severityFilter.indexOf(smell.severity) <= minIndex
      );
      
      const lines: string[] = [];
      lines.push('# 代码异味检测报告\n');
      lines.push(`**分析范围:** ${pattern}`);
      lines.push(`**异味总数:** ${result.totalSmells}`);
      lines.push(`**筛选级别:** ${severity}\n`);
      
      lines.push('## 严重级别分布\n');
      lines.push(`- Critical: ${result.bySeverity.critical}`);
      lines.push(`- Major: ${result.bySeverity.major}`);
      lines.push(`- Minor: ${result.bySeverity.minor}`);
      lines.push(`- Info: ${result.bySeverity.info}\n`);
      
      lines.push('## 异味类型分布\n');
      const sortedTypes = Object.entries(result.byType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [type, count] of sortedTypes) {
        lines.push(`- ${type}: ${count}`);
      }
      lines.push('');
      
      if (filteredSmells.length > 0) {
        lines.push('## 最严重的代码异味\n');
        for (const smell of filteredSmells.slice(0, 15)) {
          lines.push(`### [${smell.severity.toUpperCase()}] ${smell.type}`);
          lines.push(`**位置:** ${smell.file}:${smell.line}`);
          lines.push(`**符号:** ${smell.symbol}`);
          lines.push(`**问题:** ${smell.message}\n`);
          
          if (smell.metrics) {
            lines.push('**指标:**');
            for (const [key, value] of Object.entries(smell.metrics)) {
              lines.push(`- ${key}: ${value}`);
            }
            lines.push('');
          }
          
          lines.push('**建议:**');
          for (const suggestion of smell.suggestions) {
            lines.push(`- ${suggestion}`);
          }
          lines.push('');
          
          if (smell.example) {
            lines.push('**示例:**');
            lines.push('```typescript');
            lines.push(smell.example);
            lines.push('```\n');
          }
        }
      }
      
      return {
        ok: true,
        output: lines.join('\n') + (budget.truncated
          ? `\n\n⚠️ 匹配 ${budget.total} 个文件，已达 ${files.length} 上限，其余截断`
          : ''),
        data: { ...result, truncated: budget.truncated, totalMatches: budget.total },
      };
    } catch (error) {
      return {
        ok: false,
        output: `异味检测失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 依赖分析工具
 */
export const analyzeDependenciesTool = defineTool({
  name: 'analyze_dependencies',
  description: '分析模块依赖关系，检测循环依赖、分层架构违规、上帝模块等问题',
  risk: 'read',
  input: {
    pattern: { 
      type: 'string', 
      description: 'Glob 模式匹配文件，例如 "src/**/*.ts"。默认 "**/*.{ts,tsx,js,jsx}"' 
    },
    layerConfig: {
      type: 'string',
      description: '分层架构配置: threeLayer | cleanArchitecture | none。默认 none',
      optional: true,
    },
    exportGraph: {
      type: 'boolean',
      description: '是否导出 DOT 格式依赖图（用于 Graphviz 可视化）。默认 false',
      optional: true,
    },
  },
  examples: [
    {
      input: { pattern: 'src/**/*.ts' },
      output: '分析依赖关系，检测循环依赖',
    },
    {
      input: { pattern: 'src/**/*.ts', layerConfig: 'threeLayer' },
      output: '使用三层架构验证依赖合规性',
    },
  ],
  
  async execute({ pattern = '**/*.{ts,tsx,js,jsx}', layerConfig = 'none', exportGraph = false }, context): Promise<ToolResult> {
    try {
      const workspaceRoot = context.cwd;
      const allFiles = globSync(pattern, {
        cwd: workspaceRoot,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts'],
      });
      const budget = applyFileBudget(allFiles);
      const files = budget.files;

      if (files.length === 0) {
        return {
          ok: true,
          output: `未找到匹配的文件：${pattern}`,
        };
      }
      
      const layers: LayerDefinition[] | undefined = 
        layerConfig === 'threeLayer' ? COMMON_LAYER_CONFIGS.threeLayer :
        layerConfig === 'cleanArchitecture' ? COMMON_LAYER_CONFIGS.cleanArchitecture :
        undefined;
      
      const result = await analyzeDependencies(files, workspaceRoot, layers);
      
      const lines: string[] = [];
      lines.push('# 依赖关系分析报告\n');
      lines.push(`**分析范围:** ${pattern}`);
      lines.push(`**模块总数:** ${result.totalModules}`);
      lines.push(`**外部依赖数:** ${result.externalDependencies}\n`);
      
      lines.push('## 依赖深度统计\n');
      lines.push(`- 最大深度: ${result.depthStats.max}`);
      lines.push(`- 平均深度: ${result.depthStats.average.toFixed(2)}\n`);
      
      // 循环依赖
      if (result.circularDependencies.length > 0) {
        lines.push(`## ⚠️ 循环依赖 (${result.circularDependencies.length})\n`);
        for (const cycle of result.circularDependencies.slice(0, 10)) {
          lines.push(`### [${cycle.severity.toUpperCase()}] ${cycle.cycle.length - 1} 个模块的循环`);
          lines.push('**路径:**');
          for (let i = 0; i < cycle.cycle.length; i++) {
            const arrow = i < cycle.cycle.length - 1 ? ' →' : '';
            lines.push(`  ${i + 1}. ${cycle.cycle[i]}${arrow}`);
          }
          lines.push('\n**建议:**');
          for (const suggestion of cycle.suggestions) {
            lines.push(`- ${suggestion}`);
          }
          lines.push('');
        }
      } else {
        lines.push('## ✅ 无循环依赖\n');
      }
      
      // 分层违规
      if (layers && result.layerViolations.length > 0) {
        lines.push(`## ⚠️ 分层架构违规 (${result.layerViolations.length})\n`);
        for (const violation of result.layerViolations.slice(0, 10)) {
          lines.push(`### ${violation.from}`);
          lines.push(`**依赖:** ${violation.to}`);
          lines.push(`**原因:** ${violation.reason}\n`);
          lines.push('**建议:**');
          for (const suggestion of violation.suggestions) {
            lines.push(`- ${suggestion}`);
          }
          lines.push('');
        }
      } else if (layers) {
        lines.push('## ✅ 无分层架构违规\n');
      }
      
      // 上帝模块
      if (result.godModules.length > 0) {
        lines.push('## 上帝模块（高耦合）\n');
        for (const god of result.godModules) {
          lines.push(`- **${god.module}**: 被 ${god.dependentCount} 个模块依赖`);
        }
        lines.push('');
      }
      
      // 不稳定模块
      if (result.unstableModules.length > 0) {
        lines.push('## 不稳定模块（依赖多但不被依赖）\n');
        for (const unstable of result.unstableModules) {
          lines.push(`- **${unstable.module}**: 不稳定性 ${(unstable.instability * 100).toFixed(1)}%`);
        }
        lines.push('');
      }
      
      // 孤岛模块
      if (result.isolatedModules.length > 0) {
        lines.push(`## 孤岛模块 (${result.isolatedModules.length})\n`);
        for (const isolated of result.isolatedModules.slice(0, 5)) {
          lines.push(`- ${isolated}`);
        }
        if (result.isolatedModules.length > 5) {
          lines.push(`- ... 还有 ${result.isolatedModules.length - 5} 个`);
        }
        lines.push('');
      }
      
      // 导出依赖图
      if (exportGraph) {
        const { buildDependencyGraph } = await import('./dependency-graph.js');
        const graph = await buildDependencyGraph(files, workspaceRoot);
        const dot = exportToDot(graph, {
          highlightCycles: result.circularDependencies.map(c => c.cycle),
          showExternalDeps: false,
        });
        lines.push('## 依赖图 (DOT 格式)\n');
        lines.push('使用 Graphviz 可视化: `dot -Tpng -o graph.png graph.dot`\n');
        lines.push('```dot');
        lines.push(dot);
        lines.push('```\n');
      }
      
      return {
        ok: true,
        output: lines.join('\n') + (budget.truncated
          ? `\n\n⚠️ 匹配 ${budget.total} 个文件，已达 ${files.length} 上限，其余截断`
          : ''),
        data: { ...result, truncated: budget.truncated, totalMatches: budget.total },
      };
    } catch (error) {
      return {
        ok: false,
        output: `依赖分析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

export const analysisTools = [
  analyzeComplexityTool,
  analyzeSmellsTool,
  analyzeDependenciesTool,
];
