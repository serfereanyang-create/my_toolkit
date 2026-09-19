/**
 * tools.ts — 性能工具集成（CLI 工具注册）
 * 
 * 将性能分析、基准测试等功能注册为 CLI 工具
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import { globSync } from 'glob';
import {
  analyzePerformance,
  type PerformanceIssueSeverity,
} from './performance-analyzer.js';
import {
  benchmark,
  compareBenchmarks,
  detectRegression,
  generateComparisonReport,
  stressTest,
  type BenchmarkResult,
} from './benchmark.js';

/**
 * 性能分析工具
 */
export const analyzePerformanceTool = defineTool({
  name: 'analyze_performance',
  description: '静态分析代码性能问题（算法复杂度、同步I/O、内存泄漏等）',
  risk: 'read',
  input: {
    file: {
      type: 'string',
      description: '要分析的文件路径',
      optional: true,
    },
    pattern: {
      type: 'string',
      description: 'Glob 模式匹配多个文件',
      optional: true,
    },
    severity: {
      type: 'string',
      description: '最低严重级别: info | minor | major | critical。默认 minor',
      optional: true,
    },
  },
  examples: [
    {
      input: { file: 'src/api/handler.ts' },
      output: '分析单个文件的性能问题',
    },
    {
      input: { pattern: 'src/**/*.ts', severity: 'major' },
      output: '分析所有文件，仅显示重大问题',
    },
  ],
  
  async execute({ file, pattern, severity = 'minor' }, context): Promise<ToolResult> {
    try {
      const files: string[] = [];
      
      if (file) {
        files.push(file);
      } else if (pattern) {
        files.push(...globSync(pattern, {
          cwd: context.cwd,
          ignore: ['**/node_modules/**', '**/dist/**'],
        }));
      } else {
        return {
          ok: false,
          output: '必须提供 file 或 pattern 参数',
        };
      }
      
      if (files.length === 0) {
        return {
          ok: true,
          output: '未找到匹配的文件',
        };
      }
      
      const severityLevels: PerformanceIssueSeverity[] = ['info', 'minor', 'major', 'critical'];
      const minIndex = severityLevels.indexOf(severity as PerformanceIssueSeverity);
      
      const allResults = [];
      
      for (const filePath of files) {
        const result = await analyzePerformance(filePath, context.cwd);
        
        // 过滤严重级别
        result.issues = result.issues.filter(issue => 
          severityLevels.indexOf(issue.severity) >= minIndex
        );
        
        if (result.issues.length > 0 || result.memoryLeakRisks.length > 0) {
          allResults.push({ file: filePath, result });
        }
      }
      
      if (allResults.length === 0) {
        return {
          ok: true,
          output: '✅ 未发现性能问题',
        };
      }
      
      const lines: string[] = [];
      lines.push('# 性能分析报告\n');
      
      let totalIssues = 0;
      let criticalCount = 0;
      let majorCount = 0;
      
      for (const { file: filePath, result } of allResults) {
        totalIssues += result.issues.length;
        criticalCount += result.issues.filter(i => i.severity === 'critical').length;
        majorCount += result.issues.filter(i => i.severity === 'major').length;
        
        lines.push(`## ${filePath}\n`);
        lines.push(`**性能评分:** ${result.estimatedScore}/100\n`);
        
        // 算法复杂度
        if (result.algorithmComplexities.size > 0) {
          lines.push('### 算法复杂度\n');
          for (const [funcName, complexity] of result.algorithmComplexities) {
            lines.push(`- **${funcName}**: ${complexity.timeComplexity} 时间，${complexity.spaceComplexity} 空间`);
            lines.push(`  - ${complexity.reasoning}`);
          }
          lines.push('');
        }
        
        // 性能问题
        if (result.issues.length > 0) {
          lines.push('### 性能问题\n');
          
          for (const issue of result.issues) {
            const icon = 
              issue.severity === 'critical' ? '🔴' :
              issue.severity === 'major' ? '🟠' :
              issue.severity === 'minor' ? '🟡' : 'ℹ️';
            
            lines.push(`${icon} **行 ${issue.line}** [${issue.severity}] ${issue.message}`);
            lines.push(`  - **问题:** ${issue.explanation}`);
            lines.push(`  - **建议:** ${issue.suggestion}`);
            
            if (issue.estimatedImpact) {
              lines.push(`  - **影响:** ${issue.estimatedImpact}`);
            }
            
            if (issue.example) {
              lines.push('  - **示例:**');
              lines.push('    ```typescript');
              lines.push(`    ${issue.example.split('\n').join('\n    ')}`);
              lines.push('    ```');
            }
            
            lines.push('');
          }
        }
        
        // 内存泄漏风险
        if (result.memoryLeakRisks.length > 0) {
          lines.push('### ⚠️ 内存泄漏风险\n');
          for (const risk of result.memoryLeakRisks) {
            lines.push(`- **行 ${risk.line}** [${risk.type}]: ${risk.description}`);
          }
          lines.push('');
        }
        
        // 优化建议
        if (result.optimizationSuggestions.length > 0) {
          lines.push('### 💡 优化建议\n');
          for (const suggestion of result.optimizationSuggestions) {
            lines.push(`- ${suggestion}`);
          }
          lines.push('');
        }
      }
      
      // 总结
      lines.push('## 总结\n');
      lines.push(`- 总问题数: ${totalIssues}`);
      lines.push(`- 严重问题: ${criticalCount}`);
      lines.push(`- 重大问题: ${majorCount}`);
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: allResults,
      };
    } catch (error) {
      return {
        ok: false,
        output: `性能分析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 基准测试工具（仅用于从文件导入的函数）
 */
export const benchmarkFileTool = defineTool({
  name: 'benchmark_file_function',
  description: '对文件中的函数进行基准测试（安全：仅支持从项目文件导入）',
  risk: 'read',
  input: {
    file: {
      type: 'string',
      description: '包含函数的文件路径',
    },
    functionName: {
      type: 'string',
      description: '要测试的导出函数名',
    },
    iterations: {
      type: 'number',
      description: '迭代次数，默认 100',
      optional: true,
    },
  },
  examples: [
    {
      input: { file: 'src/utils.ts', functionName: 'calculate', iterations: 100 },
      output: '测试 utils.ts 中 calculate 函数的性能',
    },
  ],
  
  async execute({ file, functionName, iterations = 100 }, context): Promise<ToolResult> {
    return {
      ok: false,
      output: '基准测试功能需要在沙箱环境中执行，暂不支持动态代码执行。\n' +
              '建议：在项目中创建独立的基准测试文件，使用 Vitest bench 或类似工具。',
    };
  },
});

/**
 * 性能回归检测工具（基于历史数据）
 */
export const detectRegressionFromHistoryTool = defineTool({
  name: 'detect_regression_from_history',
  description: '基于历史性能数据检测回归（需要先有基准数据）',
  risk: 'read',
  input: {
    currentFile: {
      type: 'string',
      description: '当前版本文件路径',
    },
    threshold: {
      type: 'number',
      description: '回归阈值（百分比），默认 10%',
      optional: true,
    },
  },
  examples: [
    {
      input: { currentFile: 'src/processor.ts', threshold: 10 },
      output: '检测 processor.ts 性能是否回归',
    },
  ],
  
  async execute({ currentFile, threshold = 10 }, context): Promise<ToolResult> {
    return {
      ok: false,
      output: '性能回归检测需要历史基准数据。\n' +
              '建议：\n' +
              '1. 使用 analyze_performance 进行静态分析\n' +
              '2. 在 CI/CD 中集成性能测试并记录历史数据\n' +
              '3. 使用专业的性能监控工具（如 Clinic.js、0x）',
    };
  },
});

/**
 * 性能建议工具
 */
export const performanceSuggestionsTool = defineTool({
  name: 'performance_suggestions',
  description: '为项目生成性能优化建议',
  risk: 'read',
  input: {
    pattern: {
      type: 'string',
      description: 'Glob 模式，默认 "src/**/*.{ts,tsx,js,jsx}"',
      optional: true,
    },
  },
  examples: [
    {
      input: { pattern: 'src/**/*.ts' },
      output: '分析项目并生成优化建议',
    },
  ],
  
  async execute({ pattern = 'src/**/*.{ts,tsx,js,jsx}' }, context): Promise<ToolResult> {
    try {
      const files = globSync(pattern, {
        cwd: context.cwd,
        ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.*'],
      });
      
      if (files.length === 0) {
        return {
          ok: true,
          output: '未找到匹配的文件',
        };
      }
      
      const allResults = [];
      const issuesByCategory = new Map<string, number>();
      let totalScore = 0;
      
      for (const file of files.slice(0, 20)) { // 限制最多20个文件
        const result = await analyzePerformance(file, context.cwd);
        allResults.push({ file, result });
        totalScore += result.estimatedScore;
        
        for (const issue of result.issues) {
          issuesByCategory.set(
            issue.category,
            (issuesByCategory.get(issue.category) || 0) + 1
          );
        }
      }
      
      const avgScore = totalScore / allResults.length;
      
      const lines: string[] = [];
      lines.push('# 项目性能优化建议\n');
      lines.push(`**平均性能评分:** ${avgScore.toFixed(1)}/100\n`);
      
      // 主要问题类别
      if (issuesByCategory.size > 0) {
        lines.push('## 主要问题分布\n');
        const sorted = Array.from(issuesByCategory.entries())
          .sort((a, b) => b[1] - a[1]);
        
        for (const [category, count] of sorted) {
          lines.push(`- **${category}**: ${count} 个问题`);
        }
        lines.push('');
      }
      
      // 通用建议
      lines.push('## 优化建议\n');
      
      if (issuesByCategory.get('algorithm')) {
        lines.push('### 算法优化');
        lines.push('- 使用 Map/Set 替代数组查找，降低时间复杂度');
        lines.push('- 减少嵌套循环，考虑预处理或缓存');
        lines.push('- 对大数据量使用分页或虚拟滚动\n');
      }
      
      if (issuesByCategory.get('io')) {
        lines.push('### I/O 优化');
        lines.push('- 将同步 I/O 替换为异步 API');
        lines.push('- 使用 Promise.all 并发处理多个 I/O');
        lines.push('- 考虑缓存频繁读取的数据\n');
      }
      
      if (issuesByCategory.get('memory')) {
        lines.push('### 内存优化');
        lines.push('- 及时清理定时器和事件监听器');
        lines.push('- 避免在全局作用域积累大对象');
        lines.push('- 使用 WeakMap/WeakSet 避免内存泄漏\n');
      }
      
      if (issuesByCategory.get('computation')) {
        lines.push('### 计算优化');
        lines.push('- 将不变的计算移到循环外');
        lines.push('- 使用 Web Worker 处理密集计算');
        lines.push('- 考虑使用 memoization 缓存结果\n');
      }
      
      // 最需要优化的文件
      const worst = allResults
        .sort((a, b) => a.result.estimatedScore - b.result.estimatedScore)
        .slice(0, 5);
      
      if (worst.length > 0) {
        lines.push('## 优先优化的文件\n');
        for (const { file, result } of worst) {
          lines.push(`- **${file}** (评分: ${result.estimatedScore}/100)`);
          lines.push(`  问题: ${result.issues.length} 个`);
        }
      }
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: { avgScore, issuesByCategory, worst },
      };
    } catch (error) {
      return {
        ok: false,
        output: `建议生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

export const performanceTools = [
  analyzePerformanceTool,
  benchmarkFileTool,
  detectRegressionFromHistoryTool,
  performanceSuggestionsTool,
];
