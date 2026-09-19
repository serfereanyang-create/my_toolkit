/**
 * coverage.ts — 代码覆盖率分析工具
 * 
 * 集成 V8 覆盖率收集，分析测试覆盖情况
 * - 行覆盖率
 * - 分支覆盖率
 * - 函数覆盖率
 * - 未覆盖代码高亮
 */

import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * 覆盖率类型
 */
export type CoverageType = 'line' | 'branch' | 'function' | 'statement';

/**
 * 覆盖范围
 */
export interface CoverageRange {
  start: { line: number; column: number };
  end: { line: number; column: number };
  count: number;
}

/**
 * 文件覆盖率
 */
export interface FileCoverage {
  path: string;
  /** 总行数 */
  totalLines: number;
  /** 已覆盖行数 */
  coveredLines: number;
  /** 行覆盖率百分比 */
  lineCoverage: number;
  /** 总分支数 */
  totalBranches: number;
  /** 已覆盖分支数 */
  coveredBranches: number;
  /** 分支覆盖率百分比 */
  branchCoverage: number;
  /** 总函数数 */
  totalFunctions: number;
  /** 已覆盖函数数 */
  coveredFunctions: number;
  /** 函数覆盖率百分比 */
  functionCoverage: number;
  /** 未覆盖的行号 */
  uncoveredLines: number[];
  /** 未覆盖的函数 */
  uncoveredFunctions: Array<{ name: string; line: number }>;
  /** 覆盖范围详情 */
  ranges: CoverageRange[];
}

/**
 * 项目覆盖率汇总
 */
export interface ProjectCoverage {
  files: FileCoverage[];
  summary: {
    totalFiles: number;
    totalLines: number;
    coveredLines: number;
    lineCoverage: number;
    totalBranches: number;
    coveredBranches: number;
    branchCoverage: number;
    totalFunctions: number;
    coveredFunctions: number;
    functionCoverage: number;
  };
  /** 覆盖率最低的文件 */
  worstFiles: Array<{ path: string; coverage: number }>;
  /** 完全未覆盖的文件 */
  uncoveredFiles: string[];
}

/**
 * V8 覆盖率原始数据（模拟结构）
 */
interface V8Coverage {
  url: string;
  functions: Array<{
    functionName: string;
    ranges: Array<{
      startOffset: number;
      endOffset: number;
      count: number;
    }>;
  }>;
}

/**
 * 计算行号
 */
function offsetToLineColumn(content: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  
  for (let i = 0; i < Math.min(offset, content.length); i++) {
    if (content[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  
  return { line, column };
}

/**
 * 从 V8 覆盖率数据解析文件覆盖率
 */
export function parseV8Coverage(
  v8Data: V8Coverage,
  sourceContent: string
): Omit<FileCoverage, 'path'> {
  const lines = sourceContent.split('\n');
  const totalLines = lines.filter(l => l.trim().length > 0).length;
  
  const coveredLinesSet = new Set<number>();
  const uncoveredLinesSet = new Set<number>();
  const ranges: CoverageRange[] = [];
  
  const functionNames: string[] = [];
  const coveredFunctions = new Set<string>();
  const uncoveredFunctions: Array<{ name: string; line: number }> = [];
  
  // 解析每个函数的覆盖范围
  for (const func of v8Data.functions) {
    functionNames.push(func.functionName || '<anonymous>');
    
    let functionCovered = false;
    
    for (const range of func.ranges) {
      const start = offsetToLineColumn(sourceContent, range.startOffset);
      const end = offsetToLineColumn(sourceContent, range.endOffset);
      
      ranges.push({
        start,
        end,
        count: range.count,
      });
      
      // 标记覆盖的行
      for (let line = start.line; line <= end.line; line++) {
        if (range.count > 0) {
          coveredLinesSet.add(line);
          functionCovered = true;
        } else {
          if (!coveredLinesSet.has(line)) {
            uncoveredLinesSet.add(line);
          }
        }
      }
    }
    
    if (functionCovered) {
      coveredFunctions.add(func.functionName);
    } else {
      const startLine = func.ranges[0] ? 
        offsetToLineColumn(sourceContent, func.ranges[0].startOffset).line : 0;
      uncoveredFunctions.push({
        name: func.functionName || '<anonymous>',
        line: startLine,
      });
    }
  }
  
  // 计算分支覆盖（简化版，基于条件语句）
  const sourceFile = ts.createSourceFile(
    'temp.ts',
    sourceContent,
    ts.ScriptTarget.Latest,
    true
  );
  
  let totalBranches = 0;
  let coveredBranches = 0;
  
  function countBranches(node: ts.Node) {
    if (ts.isIfStatement(node) || 
        ts.isConditionalExpression(node) ||
        ts.isSwitchStatement(node)) {
      totalBranches += 2; // 简化：每个条件有两个分支
      
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      if (coveredLinesSet.has(pos.line + 1)) {
        coveredBranches += 2; // 简化假设
      }
    }
    
    ts.forEachChild(node, countBranches);
  }
  
  countBranches(sourceFile);
  
  const lineCoverage = totalLines > 0 ? (coveredLinesSet.size / totalLines) * 100 : 0;
  const branchCoverage = totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 100;
  const functionCoverage = functionNames.length > 0 
    ? (coveredFunctions.size / functionNames.length) * 100 
    : 100;
  
  return {
    totalLines,
    coveredLines: coveredLinesSet.size,
    lineCoverage,
    totalBranches,
    coveredBranches,
    branchCoverage,
    totalFunctions: functionNames.length,
    coveredFunctions: coveredFunctions.size,
    functionCoverage,
    uncoveredLines: Array.from(uncoveredLinesSet).sort((a, b) => a - b),
    uncoveredFunctions,
    ranges,
  };
}

/**
 * 分析单个文件的覆盖率（基于 lcov 或 v8 数据）
 */
export async function analyzeFileCoverage(
  filePath: string,
  workspaceRoot: string,
  v8Data?: V8Coverage
): Promise<FileCoverage> {
  const absolutePath = resolve(workspaceRoot, filePath);
  const content = await readFile(absolutePath, 'utf-8');
  
  if (v8Data) {
    const coverage = parseV8Coverage(v8Data, content);
    return {
      path: relative(workspaceRoot, absolutePath),
      ...coverage,
    };
  }
  
  // 如果没有覆盖率数据，返回零覆盖
  const lines = content.split('\n');
  const totalLines = lines.filter(l => l.trim().length > 0).length;
  
  // 分析函数
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  
  const functions: Array<{ name: string; line: number }> = [];
  
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      functions.push({
        name: node.name.text,
        line: pos.line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  
  return {
    path: relative(workspaceRoot, absolutePath),
    totalLines,
    coveredLines: 0,
    lineCoverage: 0,
    totalBranches: 0,
    coveredBranches: 0,
    branchCoverage: 0,
    totalFunctions: functions.length,
    coveredFunctions: 0,
    functionCoverage: 0,
    uncoveredLines: Array.from({ length: totalLines }, (_, i) => i + 1),
    uncoveredFunctions: functions,
    ranges: [],
  };
}

/**
 * 分析项目覆盖率
 */
export async function analyzeProjectCoverage(
  files: string[],
  workspaceRoot: string,
  coverageData?: Map<string, V8Coverage>
): Promise<ProjectCoverage> {
  const fileCoverages: FileCoverage[] = [];
  
  for (const file of files) {
    const v8Data = coverageData?.get(file);
    const coverage = await analyzeFileCoverage(file, workspaceRoot, v8Data);
    fileCoverages.push(coverage);
  }
  
  // 计算汇总
  const summary = {
    totalFiles: fileCoverages.length,
    totalLines: 0,
    coveredLines: 0,
    lineCoverage: 0,
    totalBranches: 0,
    coveredBranches: 0,
    branchCoverage: 0,
    totalFunctions: 0,
    coveredFunctions: 0,
    functionCoverage: 0,
  };
  
  for (const fc of fileCoverages) {
    summary.totalLines += fc.totalLines;
    summary.coveredLines += fc.coveredLines;
    summary.totalBranches += fc.totalBranches;
    summary.coveredBranches += fc.coveredBranches;
    summary.totalFunctions += fc.totalFunctions;
    summary.coveredFunctions += fc.coveredFunctions;
  }
  
  summary.lineCoverage = summary.totalLines > 0 
    ? (summary.coveredLines / summary.totalLines) * 100 
    : 0;
  summary.branchCoverage = summary.totalBranches > 0
    ? (summary.coveredBranches / summary.totalBranches) * 100
    : 100;
  summary.functionCoverage = summary.totalFunctions > 0
    ? (summary.coveredFunctions / summary.totalFunctions) * 100
    : 100;
  
  // 找出覆盖率最低的文件
  const worstFiles = fileCoverages
    .map(fc => ({ path: fc.path, coverage: fc.lineCoverage }))
    .sort((a, b) => a.coverage - b.coverage)
    .slice(0, 10);
  
  // 完全未覆盖的文件
  const uncoveredFiles = fileCoverages
    .filter(fc => fc.lineCoverage === 0)
    .map(fc => fc.path);
  
  return {
    files: fileCoverages,
    summary,
    worstFiles,
    uncoveredFiles,
  };
}

/**
 * 生成覆盖率报告（Markdown）
 */
export function generateCoverageReport(coverage: ProjectCoverage): string {
  const lines: string[] = [];
  
  lines.push('# 代码覆盖率报告\n');
  
  // 总体摘要
  lines.push('## 总体摘要\n');
  lines.push(`| 指标 | 覆盖数 / 总数 | 百分比 |`);
  lines.push(`|------|---------------|--------|`);
  lines.push(`| 行覆盖率 | ${coverage.summary.coveredLines} / ${coverage.summary.totalLines} | ${coverage.summary.lineCoverage.toFixed(2)}% |`);
  lines.push(`| 分支覆盖率 | ${coverage.summary.coveredBranches} / ${coverage.summary.totalBranches} | ${coverage.summary.branchCoverage.toFixed(2)}% |`);
  lines.push(`| 函数覆盖率 | ${coverage.summary.coveredFunctions} / ${coverage.summary.totalFunctions} | ${coverage.summary.functionCoverage.toFixed(2)}% |`);
  lines.push('');
  
  // 可视化进度条
  const lineBar = '█'.repeat(Math.floor(coverage.summary.lineCoverage / 5)) + 
                  '░'.repeat(20 - Math.floor(coverage.summary.lineCoverage / 5));
  lines.push(`**行覆盖率:** ${lineBar} ${coverage.summary.lineCoverage.toFixed(1)}%`);
  lines.push('');
  
  // 覆盖率最低的文件
  if (coverage.worstFiles.length > 0) {
    lines.push('## 覆盖率最低的文件\n');
    lines.push('| 文件 | 覆盖率 |');
    lines.push('|------|--------|');
    for (const file of coverage.worstFiles) {
      const icon = file.coverage < 50 ? '🔴' : file.coverage < 80 ? '🟡' : '🟢';
      lines.push(`| ${icon} ${file.path} | ${file.coverage.toFixed(2)}% |`);
    }
    lines.push('');
  }
  
  // 完全未覆盖的文件
  if (coverage.uncoveredFiles.length > 0) {
    lines.push('## ⚠️ 完全未覆盖的文件\n');
    for (const file of coverage.uncoveredFiles.slice(0, 20)) {
      lines.push(`- ${file}`);
    }
    if (coverage.uncoveredFiles.length > 20) {
      lines.push(`- ... 还有 ${coverage.uncoveredFiles.length - 20} 个文件`);
    }
    lines.push('');
  }
  
  // 文件详情（前10个）
  lines.push('## 文件详情\n');
  for (const file of coverage.files.slice(0, 10)) {
    lines.push(`### ${file.path}\n`);
    lines.push(`- 行覆盖率: ${file.lineCoverage.toFixed(2)}% (${file.coveredLines}/${file.totalLines})`);
    lines.push(`- 函数覆盖率: ${file.functionCoverage.toFixed(2)}% (${file.coveredFunctions}/${file.totalFunctions})`);
    
    if (file.uncoveredFunctions.length > 0) {
      lines.push(`- 未覆盖函数: ${file.uncoveredFunctions.map(f => f.name).join(', ')}`);
    }
    
    if (file.uncoveredLines.length > 0 && file.uncoveredLines.length <= 20) {
      lines.push(`- 未覆盖行: ${file.uncoveredLines.join(', ')}`);
    } else if (file.uncoveredLines.length > 20) {
      lines.push(`- 未覆盖行: ${file.uncoveredLines.length} 行 (过多，不列出)`);
    }
    
    lines.push('');
  }
  
  // 建议
  lines.push('## 改进建议\n');
  
  if (coverage.summary.lineCoverage < 80) {
    lines.push('- 🎯 **目标:** 将整体行覆盖率提升至 80% 以上');
  }
  
  if (coverage.uncoveredFiles.length > 0) {
    lines.push(`- ⚠️ 有 ${coverage.uncoveredFiles.length} 个文件完全没有测试，优先为这些文件添加测试`);
  }
  
  if (coverage.worstFiles.length > 0 && coverage.worstFiles[0].coverage < 50) {
    lines.push(`- 🔴 文件 '${coverage.worstFiles[0].path}' 覆盖率仅 ${coverage.worstFiles[0].coverage.toFixed(1)}%，需要重点关注`);
  }
  
  lines.push('');
  
  return lines.join('\n');
}

/**
 * 计算增量覆盖率（仅统计变更的代码）
 */
export async function analyzeIncrementalCoverage(
  changedFiles: string[],
  changedLines: Map<string, number[]>,
  workspaceRoot: string,
  coverageData?: Map<string, V8Coverage>
): Promise<{
  changedLinesCovered: number;
  changedLinesTotal: number;
  incrementalCoverage: number;
}> {
  let changedLinesCovered = 0;
  let changedLinesTotal = 0;
  
  for (const file of changedFiles) {
    const coverage = await analyzeFileCoverage(file, workspaceRoot, coverageData?.get(file));
    const lines = changedLines.get(file) || [];
    
    changedLinesTotal += lines.length;
    
    for (const line of lines) {
      if (!coverage.uncoveredLines.includes(line)) {
        changedLinesCovered++;
      }
    }
  }
  
  const incrementalCoverage = changedLinesTotal > 0
    ? (changedLinesCovered / changedLinesTotal) * 100
    : 100;
  
  return {
    changedLinesCovered,
    changedLinesTotal,
    incrementalCoverage,
  };
}

/**
 * 生成覆盖率徽章 SVG
 */
export function generateCoverageBadge(coverage: number): string {
  const color = coverage >= 90 ? 'brightgreen' :
                coverage >= 80 ? 'green' :
                coverage >= 70 ? 'yellowgreen' :
                coverage >= 60 ? 'yellow' :
                coverage >= 50 ? 'orange' : 'red';
  
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20">
  <linearGradient id="a" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <rect rx="3" width="120" height="20" fill="#555"/>
  <rect rx="3" x="63" width="57" height="20" fill="${color}"/>
  <path fill="${color}" d="M63 0h4v20h-4z"/>
  <rect rx="3" width="120" height="20" fill="url(#a)"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="32" y="15" fill="#010101" fill-opacity=".3">coverage</text>
    <text x="32" y="14">coverage</text>
    <text x="90" y="15" fill="#010101" fill-opacity=".3">${coverage.toFixed(0)}%</text>
    <text x="90" y="14">${coverage.toFixed(0)}%</text>
  </g>
</svg>`;
}

/**
 * 解析 lcov 格式覆盖率数据
 */
export function parseLcovCoverage(lcovContent: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  
  const sections = lcovContent.split('end_of_record');
  
  for (const section of sections) {
    const lines = section.trim().split('\n');
    if (lines.length === 0) continue;
    
    let currentFile = '';
    let totalLines = 0;
    let coveredLines = 0;
    let totalFunctions = 0;
    let coveredFunctions = 0;
    let totalBranches = 0;
    let coveredBranches = 0;
    const uncoveredLines: number[] = [];
    
    for (const line of lines) {
      if (line.startsWith('SF:')) {
        currentFile = line.substring(3);
      } else if (line.startsWith('DA:')) {
        const [lineNum, count] = line.substring(3).split(',').map(Number);
        totalLines++;
        if (count > 0) {
          coveredLines++;
        } else {
          uncoveredLines.push(lineNum);
        }
      } else if (line.startsWith('FN:')) {
        totalFunctions++;
      } else if (line.startsWith('FNDA:')) {
        const count = parseInt(line.split(',')[0].substring(5));
        if (count > 0) coveredFunctions++;
      } else if (line.startsWith('BRDA:')) {
        totalBranches++;
        const taken = line.split(',')[3];
        if (taken !== '0' && taken !== '-') coveredBranches++;
      }
    }
    
    if (currentFile) {
      files.set(currentFile, {
        path: currentFile,
        totalLines,
        coveredLines,
        lineCoverage: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
        totalBranches,
        coveredBranches,
        branchCoverage: totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 100,
        totalFunctions,
        coveredFunctions,
        functionCoverage: totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 100,
        uncoveredLines,
        uncoveredFunctions: [],
        ranges: [],
      });
    }
  }
  
  return files;
}
