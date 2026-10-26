/**
 * code-quality-auditor.ts — 代码质量全面审计工具
 * 
 * 综合所有静态分析、测试覆盖率、性能分析的结果
 * 生成全面的代码质量报告和改进建议
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeFileComplexity } from '../analysis/complexity.js';
import { buildDependencyGraph, detectCircularDependencies } from '../analysis/dependency-graph.js';
import { analyzePerformance } from '../performance/performance-analyzer.js';

export interface QualityMetrics {
  // 代码规模
  totalFiles: number;
  totalLines: number;
  totalFunctions: number;
  
  // 复杂度
  avgComplexity: number;
  maxComplexity: number;
  highComplexityCount: number;
  
  // 代码异味
  totalSmells: number;
  criticalSmells: number;
  majorSmells: number;
  
  // 依赖关系
  totalModules: number;
  circularDependencies: number;
  avgFanOut: number;
  avgInstability: number;
  
  // 性能问题
  performanceIssues: number;
  criticalPerfIssues: number;
  memoryLeakRisks: number;
  
  // 综合评分 (0-100)
  overallScore: number;
  maintainabilityScore: number;
  reliabilityScore: number;
  performanceScore: number;
}

export interface QualityIssue {
  file: string;
  line: number;
  column?: number;
  category: 'complexity' | 'smell' | 'dependency' | 'performance' | 'security';
  severity: 'info' | 'minor' | 'major' | 'critical';
  message: string;
  suggestion: string;
  estimatedEffort?: 'trivial' | 'easy' | 'medium' | 'hard' | 'very-hard';
}

export interface QualityReport {
  metrics: QualityMetrics;
  issues: QualityIssue[];
  recommendations: string[];
  hotspots: HotspotFile[];
  technicalDebt: TechnicalDebtEstimate;
}

export interface HotspotFile {
  file: string;
  score: number; // 越低越差
  issueCount: number;
  complexityScore: number;
  changeFrequency?: number; // 从 git 历史获取
  reason: string;
}

export interface TechnicalDebtEstimate {
  totalHours: number;
  criticalHours: number;
  majorHours: number;
  breakdown: {
    complexity: number;
    smells: number;
    performance: number;
    architecture: number;
  };
}

/**
 * 执行全面质量审计
 */
export async function auditCodeQuality(
  files: string[],
  workspaceRoot: string,
  options: {
    includeTests?: boolean;
    minSeverity?: 'info' | 'minor' | 'major' | 'critical';
  } = {}
): Promise<QualityReport> {
  const { includeTests = false, minSeverity = 'minor' } = options;
  
  // 过滤测试文件
  const targetFiles = includeTests 
    ? files 
    : files.filter(f => !/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f));
  
  // 并行分析
  const [
    complexityResults,
    depGraph,
    perfResults,
  ] = await Promise.all([
    Promise.all(targetFiles.map(async f => {
      const filePath = resolve(workspaceRoot, f);
      const content = await readFile(filePath, 'utf-8');
      const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
      return analyzeFileComplexity(sourceFile);
    })),
    buildDependencyGraph(targetFiles, workspaceRoot),
    Promise.all(targetFiles.map(f => analyzePerformance(f, workspaceRoot))),
  ]);
  
  const cycles = detectCircularDependencies(depGraph);
  
  // 尚未接入：analyzeProject 返回的是项目级结果，这里还没有转成文件级，
  // 所以恒为空数组，报告里的 smell 统计（totalSmells）永远是 0。
  const smellResults = targetFiles.map(() => ({ smells: [] as any[] }));
  
  // 收集所有问题
  const issues: QualityIssue[] = [];
  
  // 复杂度问题
  complexityResults.forEach((result, i) => {
    result.functions.forEach((func: any) => {
      if (func.cyclomaticComplexity > 10) {
        issues.push({
          file: targetFiles[i],
          line: func.line,
          category: 'complexity',
          severity: func.cyclomaticComplexity > 20 ? 'critical' : 
                   func.cyclomaticComplexity > 15 ? 'major' : 'minor',
          message: `函数 ${func.name} 复杂度过高 (${func.cyclomaticComplexity})`,
          suggestion: '考虑拆分为多个小函数，提取条件分支逻辑',
          estimatedEffort: func.cyclomaticComplexity > 20 ? 'hard' : 
                          func.cyclomaticComplexity > 15 ? 'medium' : 'easy',
        });
      }
    });
  });
  
  // 代码异味问题
  smellResults.forEach((result: any, i: number) => {
    result.smells.forEach((smell: any) => {
      issues.push({
        file: targetFiles[i],
        line: smell.line,
        column: smell.column,
        category: 'smell',
        severity: smell.severity,
        message: smell.message,
        suggestion: smell.suggestion,
        estimatedEffort: estimateEffort(smell.type),
      });
    });
  });
  
  // 循环依赖问题
  cycles.forEach(cycle => {
    const mainFile = cycle.cycle[0];
    issues.push({
      file: mainFile,
      line: 1,
      category: 'dependency',
      severity: cycle.severity as any,
      message: `检测到循环依赖: ${cycle.cycle.join(' → ')}`,
      suggestion: '引入依赖倒置原则，或合并为单一模块',
      estimatedEffort: cycle.cycle.length <= 3 ? 'medium' : 'hard',
    });
  });
  
  // 性能问题
  perfResults.forEach((result: any, i: number) => {
    result.issues.forEach((issue: any) => {
      issues.push({
        file: targetFiles[i],
        line: issue.line,
        column: issue.column,
        category: 'performance',
        severity: issue.severity,
        message: issue.message,
        suggestion: issue.suggestion,
        estimatedEffort: issue.severity === 'critical' ? 'hard' : 
                        issue.severity === 'major' ? 'medium' : 'easy',
      });
    });
    
    result.memoryLeakRisks.forEach((risk: any) => {
      issues.push({
        file: targetFiles[i],
        line: risk.line,
        category: 'performance',
        severity: 'major',
        message: `内存泄漏风险: ${risk.type}`,
        suggestion: risk.description,
        estimatedEffort: 'medium',
      });
    });
  });
  
  // 按严重性过滤
  const severityOrder = { info: 0, minor: 1, major: 2, critical: 3 };
  const minLevel = severityOrder[minSeverity];
  const filteredIssues = issues.filter(i => severityOrder[i.severity] >= minLevel);
  
  // 计算指标
  const metrics = calculateMetrics(
    targetFiles,
    complexityResults,
    smellResults,
    depGraph,
    cycles,
    perfResults,
    filteredIssues
  );
  
  // 识别热点文件
  const hotspots = identifyHotspots(
    targetFiles,
    complexityResults,
    filteredIssues
  );
  
  // 估算技术债务
  const technicalDebt = estimateTechnicalDebt(filteredIssues);
  
  // 生成改进建议
  const recommendations = generateRecommendations(metrics, hotspots, technicalDebt);
  
  return {
    metrics,
    issues: filteredIssues.sort((a, b) => 
      severityOrder[b.severity] - severityOrder[a.severity]
    ),
    recommendations,
    hotspots: hotspots.sort((a, b) => a.score - b.score).slice(0, 10),
    technicalDebt,
  };
}

/**
 * 计算质量指标
 */
function calculateMetrics(
  files: string[],
  complexityResults: Awaited<ReturnType<typeof analyzeFileComplexity>>[],
  smellResults: any[],
  depGraph: Awaited<ReturnType<typeof buildDependencyGraph>>,
  cycles: Awaited<ReturnType<typeof detectCircularDependencies>>,
  perfResults: Awaited<ReturnType<typeof analyzePerformance>>[],
  issues: QualityIssue[]
): QualityMetrics {
  const totalFunctions = complexityResults.reduce((sum, r) => sum + r.functions.length, 0);
  const totalLines = complexityResults.reduce((sum, r) => sum + r.totalLoc, 0);
  
  const allComplexities = complexityResults.flatMap(r => 
    r.functions.map((f: any) => f.cyclomaticComplexity)
  );
  const avgComplexity = allComplexities.length > 0
    ? allComplexities.reduce((a, b) => a + b, 0) / allComplexities.length
    : 0;
  const maxComplexity = Math.max(0, ...allComplexities);
  const highComplexityCount = allComplexities.filter(c => c > 10).length;
  
  const totalSmells = smellResults.reduce((sum, r) => sum + r.smells.length, 0);
  const criticalSmells = issues.filter(i => i.category === 'smell' && i.severity === 'critical').length;
  const majorSmells = issues.filter(i => i.category === 'smell' && i.severity === 'major').length;
  
  const fanOuts = Array.from(depGraph.nodes.values()).map(n => n.imports.length);
  const avgFanOut = fanOuts.length > 0
    ? fanOuts.reduce((a, b) => a + b, 0) / fanOuts.length
    : 0;
  
  const instabilities = Array.from(depGraph.nodes.values()).map(n => {
    const fanIn = n.importedBy.length;
    const fanOut = n.imports.length;
    return fanIn + fanOut > 0 ? fanOut / (fanIn + fanOut) : 0;
  });
  const avgInstability = instabilities.length > 0
    ? instabilities.reduce((a, b) => a + b, 0) / instabilities.length
    : 0;
  
  const performanceIssues = perfResults.reduce((sum, r) => sum + r.issues.length, 0);
  const criticalPerfIssues = issues.filter(i => 
    i.category === 'performance' && i.severity === 'critical'
  ).length;
  const memoryLeakRisks = perfResults.reduce((sum, r) => sum + r.memoryLeakRisks.length, 0);
  
  // 计算综合评分
  const maintainabilityScore = calculateMaintainabilityScore(
    avgComplexity,
    highComplexityCount,
    totalFunctions,
    totalSmells,
    totalLines
  );
  
  const reliabilityScore = calculateReliabilityScore(
    criticalSmells,
    majorSmells,
    cycles.length,
    totalFunctions
  );
  
  const performanceScore = calculatePerformanceScore(
    performanceIssues,
    criticalPerfIssues,
    memoryLeakRisks,
    totalFunctions
  );
  
  const overallScore = (
    maintainabilityScore * 0.4 +
    reliabilityScore * 0.35 +
    performanceScore * 0.25
  );
  
  return {
    totalFiles: files.length,
    totalLines,
    totalFunctions,
    avgComplexity: Math.round(avgComplexity * 10) / 10,
    maxComplexity,
    highComplexityCount,
    totalSmells,
    criticalSmells,
    majorSmells,
    totalModules: depGraph.nodes.size,
    circularDependencies: cycles.length,
    avgFanOut: Math.round(avgFanOut * 10) / 10,
    avgInstability: Math.round(avgInstability * 100) / 100,
    performanceIssues,
    criticalPerfIssues,
    memoryLeakRisks,
    overallScore: Math.round(overallScore),
    maintainabilityScore: Math.round(maintainabilityScore),
    reliabilityScore: Math.round(reliabilityScore),
    performanceScore: Math.round(performanceScore),
  };
}

function calculateMaintainabilityScore(
  avgComplexity: number,
  highComplexityCount: number,
  totalFunctions: number,
  totalSmells: number,
  totalLines: number
): number {
  let score = 100;
  
  // 平均复杂度惩罚
  if (avgComplexity > 5) {
    score -= (avgComplexity - 5) * 3;
  }
  
  // 高复杂度函数比例惩罚
  const highComplexityRatio = totalFunctions > 0 
    ? highComplexityCount / totalFunctions 
    : 0;
  score -= highComplexityRatio * 30;
  
  // 代码异味密度惩罚
  const smellDensity = totalLines > 0 ? (totalSmells / totalLines) * 1000 : 0;
  score -= smellDensity * 5;
  
  return Math.max(0, Math.min(100, score));
}

function calculateReliabilityScore(
  criticalSmells: number,
  majorSmells: number,
  circularDeps: number,
  totalFunctions: number
): number {
  let score = 100;
  
  // 严重问题惩罚
  score -= criticalSmells * 10;
  score -= majorSmells * 3;
  
  // 循环依赖惩罚
  score -= circularDeps * 5;
  
  // 问题密度惩罚
  const issueDensity = totalFunctions > 0
    ? (criticalSmells + majorSmells) / totalFunctions
    : 0;
  score -= issueDensity * 20;
  
  return Math.max(0, Math.min(100, score));
}

function calculatePerformanceScore(
  performanceIssues: number,
  criticalPerfIssues: number,
  memoryLeakRisks: number,
  totalFunctions: number
): number {
  let score = 100;
  
  // 严重性能问题惩罚
  score -= criticalPerfIssues * 15;
  score -= memoryLeakRisks * 8;
  
  // 性能问题密度惩罚
  const perfIssueDensity = totalFunctions > 0
    ? performanceIssues / totalFunctions
    : 0;
  score -= perfIssueDensity * 25;
  
  return Math.max(0, Math.min(100, score));
}

/**
 * 识别热点文件（问题最多的文件）
 */
function identifyHotspots(
  files: string[],
  complexityResults: Awaited<ReturnType<typeof analyzeFileComplexity>>[],
  issues: QualityIssue[]
): HotspotFile[] {
  return files.map((file, i) => {
    const fileIssues = issues.filter(issue => issue.file === file);
    const result = complexityResults[i];
    
    const avgComplexity = result.functions.length > 0
      ? result.functions.reduce((sum: number, f: any) => sum + f.cyclomaticComplexity, 0) / result.functions.length
      : 0;
    
    // 评分：复杂度 + 问题数量
    const complexityScore = Math.max(0, 100 - avgComplexity * 5);
    const issueScore = Math.max(0, 100 - fileIssues.length * 10);
    const score = (complexityScore + issueScore) / 2;
    
    const reasons: string[] = [];
    if (avgComplexity > 10) reasons.push('高复杂度');
    if (fileIssues.length > 5) reasons.push('问题较多');
    if (fileIssues.some(i => i.severity === 'critical')) reasons.push('严重问题');
    
    return {
      file,
      score: Math.round(score),
      issueCount: fileIssues.length,
      complexityScore: Math.round(avgComplexity * 10) / 10,
      reason: reasons.join(', ') || '轻微问题',
    };
  }).filter(h => h.issueCount > 0 || h.complexityScore > 5);
}

/**
 * 估算技术债务
 */
function estimateTechnicalDebt(issues: QualityIssue[]): TechnicalDebtEstimate {
  const effortHours: Record<string, number> = {
    'trivial': 0.5,
    'easy': 2,
    'medium': 4,
    'hard': 8,
    'very-hard': 16,
  };
  
  let totalHours = 0;
  let criticalHours = 0;
  let majorHours = 0;
  
  const breakdown = {
    complexity: 0,
    smells: 0,
    performance: 0,
    architecture: 0,
  };
  
  issues.forEach(issue => {
    const hours = effortHours[issue.estimatedEffort || 'medium'];
    totalHours += hours;
    
    if (issue.severity === 'critical') criticalHours += hours;
    if (issue.severity === 'major') majorHours += hours;
    
    if (issue.category === 'complexity') breakdown.complexity += hours;
    else if (issue.category === 'smell') breakdown.smells += hours;
    else if (issue.category === 'performance') breakdown.performance += hours;
    else if (issue.category === 'dependency') breakdown.architecture += hours;
  });
  
  return {
    totalHours: Math.round(totalHours * 10) / 10,
    criticalHours: Math.round(criticalHours * 10) / 10,
    majorHours: Math.round(majorHours * 10) / 10,
    breakdown,
  };
}

/**
 * 生成改进建议
 */
function generateRecommendations(
  metrics: QualityMetrics,
  hotspots: HotspotFile[],
  debt: TechnicalDebtEstimate
): string[] {
  const recommendations: string[] = [];
  
  // 维护性建议
  if (metrics.maintainabilityScore < 70) {
    if (metrics.avgComplexity > 8) {
      recommendations.push('⚠️ 平均复杂度偏高，建议重构复杂函数，拆分为小函数');
    }
    if (metrics.highComplexityCount > metrics.totalFunctions * 0.2) {
      recommendations.push('⚠️ 20% 以上的函数复杂度过高，建议系统性降低复杂度');
    }
    if (metrics.totalSmells > metrics.totalLines * 0.05) {
      recommendations.push('⚠️ 代码异味密度较高，建议清理重复代码和过长函数');
    }
  }
  
  // 可靠性建议
  if (metrics.reliabilityScore < 70) {
    if (metrics.circularDependencies > 0) {
      recommendations.push(`🚨 检测到 ${metrics.circularDependencies} 个循环依赖，建议引入依赖倒置或合并模块`);
    }
    if (metrics.criticalSmells > 0) {
      recommendations.push(`🚨 存在 ${metrics.criticalSmells} 个严重代码异味，建议优先修复`);
    }
  }
  
  // 性能建议
  if (metrics.performanceScore < 70) {
    if (metrics.criticalPerfIssues > 0) {
      recommendations.push(`🚨 检测到 ${metrics.criticalPerfIssues} 个严重性能问题，建议立即优化`);
    }
    if (metrics.memoryLeakRisks > 0) {
      recommendations.push(`⚠️ 存在 ${metrics.memoryLeakRisks} 个内存泄漏风险，建议添加清理逻辑`);
    }
  }
  
  // 热点文件建议
  if (hotspots.length > 0) {
    const worst = hotspots[0];
    recommendations.push(`🔥 热点文件 ${worst.file} 需要重点关注（${worst.issueCount} 个问题）`);
  }
  
  // 技术债务建议
  if (debt.totalHours > 40) {
    recommendations.push(`💰 预估技术债务 ${debt.totalHours} 小时，建议分阶段偿还`);
    if (debt.criticalHours > debt.totalHours * 0.3) {
      recommendations.push(`🚨 优先偿还关键债务（${debt.criticalHours} 小时）`);
    }
  }
  
  // 架构建议
  if (metrics.avgFanOut > 5) {
    recommendations.push('⚠️ 模块耦合度较高，建议引入中间层降低依赖');
  }
  if (metrics.avgInstability > 0.7) {
    recommendations.push('⚠️ 平均不稳定性较高，建议稳定核心接口');
  }
  
  // 成功状态
  if (recommendations.length === 0) {
    recommendations.push('✅ 代码质量良好，继续保持！');
  }
  
  return recommendations;
}

/**
 * 估算问题修复工作量
 */
function estimateEffort(smellType: string): QualityIssue['estimatedEffort'] {
  const effortMap: Record<string, QualityIssue['estimatedEffort']> = {
    'magic-number': 'trivial',
    'long-parameter-list': 'easy',
    'long-method': 'medium',
    'large-class': 'hard',
    'duplicated-code': 'medium',
    'dead-code': 'trivial',
    'commented-code': 'trivial',
    'complex-condition': 'easy',
    'nested-callback': 'medium',
    'god-class': 'very-hard',
    'feature-envy': 'medium',
    'data-clump': 'easy',
  };
  
  return effortMap[smellType] || 'medium';
}
