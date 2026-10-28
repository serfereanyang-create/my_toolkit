/**
 * tools.ts — 代码审计工具 CLI 注册
 */

import { defineTool } from '../tools/define.js';
import { auditCodeQuality } from './code-quality-auditor.js';
import { scanSecurity } from './security-scanner.js';
import { globSync } from 'glob';
import { resolve } from 'node:path';

interface AuditQualityArgs {
  pattern?: string;
  includeTests?: boolean;
  minSeverity?: string;
}

interface ScanSecurityArgs {
  file?: string;
  pattern?: string;
  minSeverity?: string;
}

/**
 * 全面质量审计工具
 */
export const auditQualityTool = defineTool({
  name: 'audit_code_quality',
  description: '对代码库进行全面质量审计，包括复杂度、异味、依赖、性能分析，生成综合报告和改进建议',
  risk: 'read',
  input: {
    pattern: {
      type: 'string',
      description: '文件匹配模式 (glob)，例如 "src/**/*.ts"',
      optional: true,
    },
    includeTests: {
      type: 'boolean',
      description: '是否包含测试文件',
      optional: true,
    },
    minSeverity: {
      type: 'string',
      description: '最低严重级别：info, minor, major, critical',
      optional: true,
    },
  },
  examples: [
    { input: { pattern: 'src/**/*.{ts,tsx,js,jsx}' }, output: '审计匹配文件并输出综合质量报告' },
    { input: { pattern: 'src/**/*.ts', includeTests: true, minSeverity: 'major' }, output: '只保留 major 及以上问题' },
  ],
  execute: async (args: AuditQualityArgs, context: any) => {
    const { pattern = 'src/**/*.{ts,tsx,js,jsx}', includeTests = false, minSeverity = 'minor' } = args;
    // No process.cwd() fallback: a missing workspace root must surface as an
    // error, not silently audit the CLI install dir instead of the project.
    if (!context.workspaceRoot) {
      return { ok: false, output: 'audit_code_quality requires a workspace root in the tool context.' };
    }
    const workspaceRoot = context.workspaceRoot;
    
    // 查找文件
    const files = globSync(pattern, {
      cwd: workspaceRoot,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
      absolute: false,
    });
    
    if (files.length === 0) {
      return {
        ok: false,
        output: `未找到匹配的文件: ${pattern}`,
      };
    }
    
    // 执行审计
    try {
      const report = await auditCodeQuality(files, workspaceRoot, {
        includeTests,
        minSeverity: minSeverity as any,
      });
      
      // 格式化输出
      const output = formatQualityReport(report);
      
      return {
        ok: true,
        output,
        data: report,
      };
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * 安全扫描工具
 */
export const scanSecurityTool = defineTool({
  name: 'scan_security',
  description: '扫描代码中的安全漏洞：SQL注入、XSS、不安全加密、敏感信息泄露、路径遍历等',
  risk: 'read',
  input: {
    file: {
      type: 'string',
      description: '要扫描的文件路径',
      optional: true,
    },
    pattern: {
      type: 'string',
      description: '文件匹配模式 (glob)，例如 "src/**/*.ts"',
      optional: true,
    },
    minSeverity: {
      type: 'string',
      description: '最低严重级别：info, low, medium, high, critical',
      optional: true,
    },
  },
  examples: [
    { input: { pattern: 'src/**/*.ts' }, output: '扫描匹配文件的安全问题' },
    { input: { file: 'src/api/user.ts', minSeverity: 'high' }, output: '只扫描单个文件里的高危问题' },
  ],
  execute: async (args: ScanSecurityArgs, context: any) => {
    const { file, pattern, minSeverity = 'low' } = args;
    // No process.cwd() fallback: a missing workspace root must surface as an
    // error, not silently scan the CLI install dir instead of the project.
    if (!context.workspaceRoot) {
      return { ok: false, output: 'scan_security requires a workspace root in the tool context.' };
    }
    const workspaceRoot = context.workspaceRoot;
    
    let files: string[];
    
    if (file) {
      files = [file];
    } else if (pattern) {
      files = globSync(pattern, {
        cwd: workspaceRoot,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
        absolute: false,
      });
    } else {
      return {
        ok: false,
        output: '必须提供 file 或 pattern 参数',
      };
    }
    
    if (files.length === 0) {
      return {
        ok: false,
        output: `未找到匹配的文件: ${pattern || file}`,
      };
    }
    
    try {
      // 扫描所有文件
      const results = await Promise.all(
        files.map(f => scanSecurity(resolve(workspaceRoot, f)))
      );
      
      // 过滤严重级别
      const severityOrder = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
      const minLevel = severityOrder[minSeverity as keyof typeof severityOrder] || 0;
      
      const filteredResults = results.map(r => ({
        ...r,
        issues: r.issues.filter(i => severityOrder[i.severity] >= minLevel),
      }));
      
      // 汇总统计
      const summary = {
        critical: filteredResults.reduce((sum, r) => sum + r.summary.critical, 0),
        high: filteredResults.reduce((sum, r) => sum + r.summary.high, 0),
        medium: filteredResults.reduce((sum, r) => sum + r.summary.medium, 0),
        low: filteredResults.reduce((sum, r) => sum + r.summary.low, 0),
        info: filteredResults.reduce((sum, r) => sum + r.summary.info, 0),
      };
      
      const maxRisk = Math.max(...filteredResults.map(r => r.riskScore));
      
      // 格式化输出
      const output = formatSecurityReport(filteredResults, summary, maxRisk);
      
      return {
        ok: true,
        output,
        data: file ? filteredResults[0] : filteredResults,
      };
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * 格式化质量报告
 */
function formatQualityReport(report: Awaited<ReturnType<typeof auditCodeQuality>>): string {
  const { metrics, issues, recommendations, hotspots, technicalDebt } = report;
  
  let output = '# 代码质量审计报告\n\n';
  
  // 综合评分
  output += '## 📊 综合评分\n\n';
  output += `- **总体得分**: ${metrics.overallScore}/100 ${getScoreEmoji(metrics.overallScore)}\n`;
  output += `- **可维护性**: ${metrics.maintainabilityScore}/100\n`;
  output += `- **可靠性**: ${metrics.reliabilityScore}/100\n`;
  output += `- **性能**: ${metrics.performanceScore}/100\n\n`;
  
  // 关键指标
  output += '## 📈 关键指标\n\n';
  output += `- 总文件数: ${metrics.totalFiles}\n`;
  output += `- 总代码行: ${metrics.totalLines}\n`;
  output += `- 函数总数: ${metrics.totalFunctions}\n`;
  output += `- 平均复杂度: ${metrics.avgComplexity}\n`;
  output += `- 最高复杂度: ${metrics.maxComplexity}\n`;
  output += `- 高复杂度函数: ${metrics.highComplexityCount}\n`;
  output += `- 代码异味: ${metrics.totalSmells} (${metrics.criticalSmells} 严重)\n`;
  output += `- 循环依赖: ${metrics.circularDependencies}\n`;
  output += `- 性能问题: ${metrics.performanceIssues} (${metrics.criticalPerfIssues} 严重)\n\n`;
  
  // 技术债务
  output += '## 💰 技术债务估算\n\n';
  output += `- **总计**: ${technicalDebt.totalHours} 小时\n`;
  output += `- 严重问题: ${technicalDebt.criticalHours} 小时\n`;
  output += `- 重要问题: ${technicalDebt.majorHours} 小时\n`;
  output += `- 分类:\n`;
  output += `  - 复杂度: ${technicalDebt.breakdown.complexity}h\n`;
  output += `  - 异味: ${technicalDebt.breakdown.smells}h\n`;
  output += `  - 性能: ${technicalDebt.breakdown.performance}h\n`;
  output += `  - 架构: ${technicalDebt.breakdown.architecture}h\n\n`;
  
  // 热点文件
  if (hotspots.length > 0) {
    output += '## 🔥 热点文件（需重点关注）\n\n';
    hotspots.slice(0, 5).forEach((h, i) => {
      output += `${i + 1}. **${h.file}** (得分 ${h.score}/100)\n`;
      output += `   - 问题数: ${h.issueCount}\n`;
      output += `   - 复杂度: ${h.complexityScore}\n`;
      output += `   - 原因: ${h.reason}\n\n`;
    });
  }
  
  // 改进建议
  if (recommendations.length > 0) {
    output += '## 💡 改进建议\n\n';
    recommendations.forEach(rec => {
      output += `- ${rec}\n`;
    });
    output += '\n';
  }
  
  // 问题详情（仅显示前10个）
  if (issues.length > 0) {
    output += `## ⚠️ 问题详情（共 ${issues.length} 个，显示前 10）\n\n`;
    issues.slice(0, 10).forEach((issue, i) => {
      output += `### ${i + 1}. ${getSeverityEmoji(issue.severity)} ${issue.message}\n\n`;
      output += `- **文件**: ${issue.file}:${issue.line}\n`;
      output += `- **类别**: ${issue.category}\n`;
      output += `- **严重性**: ${issue.severity}\n`;
      output += `- **建议**: ${issue.suggestion}\n`;
      if (issue.estimatedEffort) {
        output += `- **工作量**: ${issue.estimatedEffort}\n`;
      }
      output += '\n';
    });
  }
  
  return output;
}

/**
 * 格式化安全报告
 */
function formatSecurityReport(
  results: Awaited<ReturnType<typeof scanSecurity>>[],
  summary: any,
  maxRisk: number
): string {
  let output = '# 安全扫描报告\n\n';
  
  // 风险评分
  output += '## 🛡️ 风险评估\n\n';
  output += `- **最高风险评分**: ${maxRisk}/100 ${getRiskEmoji(maxRisk)}\n`;
  output += `- **扫描文件数**: ${results.length}\n\n`;
  
  // 问题汇总
  output += '## 📊 问题统计\n\n';
  output += `- 🔴 严重 (Critical): ${summary.critical}\n`;
  output += `- 🟠 高危 (High): ${summary.high}\n`;
  output += `- 🟡 中危 (Medium): ${summary.medium}\n`;
  output += `- 🟢 低危 (Low): ${summary.low}\n`;
  output += `- ℹ️ 信息 (Info): ${summary.info}\n\n`;
  
  // 按类别统计
  const byCategory: Record<string, number> = {};
  results.forEach(r => {
    r.issues.forEach(i => {
      byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    });
  });
  
  if (Object.keys(byCategory).length > 0) {
    output += '## 📋 问题分类\n\n';
    Object.entries(byCategory).forEach(([cat, count]) => {
      output += `- ${getCategoryName(cat)}: ${count}\n`;
    });
    output += '\n';
  }
  
  // 详细问题
  const allIssues = results.flatMap(r => 
    r.issues.map(i => ({ ...i, file: r.file }))
  );
  
  if (allIssues.length > 0) {
    output += `## ⚠️ 问题详情（共 ${allIssues.length} 个）\n\n`;
    
    // 按严重性排序
    const sorted = allIssues.sort((a, b) => {
      const order = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
      return order[b.severity] - order[a.severity];
    });
    
    sorted.slice(0, 20).forEach((issue, i) => {
      output += `### ${i + 1}. ${getSeverityEmoji(issue.severity)} ${issue.message}\n\n`;
      output += `- **文件**: ${issue.file}:${issue.line}\n`;
      output += `- **类别**: ${getCategoryName(issue.category)}\n`;
      output += `- **严重性**: ${issue.severity.toUpperCase()}\n`;
      if (issue.cwe) {
        output += `- **CWE**: ${issue.cwe}\n`;
      }
      output += `- **描述**: ${issue.description}\n`;
      output += `- **建议**: ${issue.recommendation}\n`;
      if (issue.example) {
        output += `\n\`\`\`typescript\n${issue.example}\n\`\`\`\n`;
      }
      output += '\n';
    });
    
    if (allIssues.length > 20) {
      output += `\n... 还有 ${allIssues.length - 20} 个问题未显示\n`;
    }
  } else {
    output += '✅ 未发现安全问题！\n';
  }
  
  return output;
}

function getScoreEmoji(score: number): string {
  if (score >= 80) return '✅';
  if (score >= 60) return '⚠️';
  return '❌';
}

function getSeverityEmoji(severity: string): string {
  const map: Record<string, string> = {
    critical: '🔴',
    major: '🟠',
    high: '🟠',
    medium: '🟡',
    minor: '🟡',
    low: '🟢',
    info: 'ℹ️',
  };
  return map[severity] || '•';
}

function getRiskEmoji(risk: number): string {
  if (risk >= 70) return '🔴 高风险';
  if (risk >= 40) return '🟡 中风险';
  return '🟢 低风险';
}

function getCategoryName(category: string): string {
  const names: Record<string, string> = {
    injection: 'SQL/命令注入',
    xss: '跨站脚本 (XSS)',
    crypto: '加密安全',
    secrets: '敏感信息泄露',
    'path-traversal': '路径遍历',
    dependency: '依赖安全',
  };
  return names[category] || category;
}

export const auditTools = [auditQualityTool, scanSecurityTool];
