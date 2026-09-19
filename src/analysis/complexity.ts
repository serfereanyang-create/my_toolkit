/**
 * complexity.ts — 代码复杂度分析工具
 * 
 * 计算圈复杂度（Cyclomatic Complexity）和认知复杂度（Cognitive Complexity）
 * 基于 TypeScript AST 分析，支持函数级和文件级度量
 */

import * as ts from 'typescript';
import { resolve, relative } from 'node:path';
import { parseSourceFile } from './parseCache.js';

/**
 * 复杂度指标
 */
export interface ComplexityMetrics {
  /** 圈复杂度（McCabe） */
  cyclomatic: number;
  /** 认知复杂度 */
  cognitive: number;
  /** 最大嵌套深度 */
  maxNesting: number;
  /** 参数数量 */
  parameters: number;
  /** 代码行数（不含空行和注释） */
  loc: number;
}

/**
 * 函数复杂度报告
 */
export interface FunctionComplexity {
  name: string;
  kind: 'function' | 'method' | 'arrow' | 'constructor';
  line: number;
  column: number;
  metrics: ComplexityMetrics;
  /** 风险等级 */
  risk: 'low' | 'moderate' | 'high' | 'critical';
}

/**
 * 文件复杂度报告
 */
export interface FileComplexity {
  path: string;
  functions: FunctionComplexity[];
  averageCyclomatic: number;
  averageCognitive: number;
  maxCyclomatic: number;
  maxCognitive: number;
  totalLoc: number;
  /** 高风险函数数量 */
  highRiskCount: number;
}

/**
 * 项目复杂度汇总
 */
export interface ProjectComplexity {
  files: FileComplexity[];
  totalFiles: number;
  totalFunctions: number;
  averageCyclomatic: number;
  averageCognitive: number;
  hotspots: FunctionComplexity[];
  distribution: {
    low: number;
    moderate: number;
    high: number;
    critical: number;
  };
}

/**
 * 复杂度阈值配置
 */
export interface ComplexityThresholds {
  cyclomatic: { moderate: number; high: number; critical: number };
  cognitive: { moderate: number; high: number; critical: number };
  parameters: { moderate: number; high: number };
  nesting: { moderate: number; high: number };
  loc: { moderate: number; high: number };
}

/**
 * 默认阈值（基于行业实践）
 */
export const DEFAULT_THRESHOLDS: ComplexityThresholds = {
  cyclomatic: { moderate: 6, high: 11, critical: 21 },
  cognitive: { moderate: 8, high: 15, critical: 25 },
  parameters: { moderate: 4, high: 7 },
  nesting: { moderate: 3, high: 5 },
  loc: { moderate: 50, high: 100 },
};

/**
 * 圈复杂度计算器
 * 
 * 基于 McCabe 定义：复杂度 = 决策点数量 + 1
 * 决策点包括：if, for, while, case, catch, &&, ||, ?:
 */
class CyclomaticComplexityVisitor {
  complexity = 1; // 基础路径

  visit(node: ts.Node) {
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        this.complexity++;
        break;
      
      case ts.SyntaxKind.BinaryExpression: {
        const binary = node as ts.BinaryExpression;
        if (binary.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            binary.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
          this.complexity++;
        }
        break;
      }
    }

    ts.forEachChild(node, (child) => this.visit(child));
  }
}

/**
 * 认知复杂度计算器
 * 
 * 认知复杂度考虑嵌套层次，更接近人类理解代码的难度
 * 规则：
 * - 基础结构（if, loop, catch）+1
 * - 嵌套每层额外 +1
 * - break/continue 标签 +1
 * - 递归调用 +1
 */
class CognitiveComplexityVisitor {
  complexity = 0;
  private nestingLevel = 0;
  private functionName: string;

  constructor(functionName: string) {
    this.functionName = functionName;
  }

  visit(node: ts.Node) {
    const wasNested = this.nestingLevel > 0;

    // 增加基础复杂度和嵌套惩罚
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        this.complexity += 1 + this.nestingLevel;
        this.nestingLevel++;
        ts.forEachChild(node, (child) => this.visit(child));
        this.nestingLevel--;
        return;

      case ts.SyntaxKind.ConditionalExpression:
        this.complexity += 1 + this.nestingLevel;
        break;

      case ts.SyntaxKind.BinaryExpression: {
        const binary = node as ts.BinaryExpression;
        if (binary.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            binary.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
          this.complexity += 1;
        }
        break;
      }

      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement: {
        const jump = node as ts.BreakOrContinueStatement;
        if (jump.label) {
          this.complexity += 1; // 标签跳转增加复杂度
        }
        break;
      }

      case ts.SyntaxKind.CallExpression: {
        // 检测递归调用
        const call = node as ts.CallExpression;
        if (ts.isIdentifier(call.expression) && 
            call.expression.text === this.functionName) {
          this.complexity += 1;
        }
        break;
      }
    }

    ts.forEachChild(node, (child) => this.visit(child));
  }
}

/**
 * 嵌套深度计算器
 */
class NestingDepthVisitor {
  maxDepth = 0;
  private currentDepth = 0;

  visit(node: ts.Node) {
    const isNestingNode = 
      node.kind === ts.SyntaxKind.IfStatement ||
      node.kind === ts.SyntaxKind.ForStatement ||
      node.kind === ts.SyntaxKind.ForInStatement ||
      node.kind === ts.SyntaxKind.ForOfStatement ||
      node.kind === ts.SyntaxKind.WhileStatement ||
      node.kind === ts.SyntaxKind.DoStatement ||
      node.kind === ts.SyntaxKind.TryStatement ||
      node.kind === ts.SyntaxKind.SwitchStatement;

    if (isNestingNode) {
      this.currentDepth++;
      this.maxDepth = Math.max(this.maxDepth, this.currentDepth);
    }

    ts.forEachChild(node, (child) => this.visit(child));

    if (isNestingNode) {
      this.currentDepth--;
    }
  }
}

/**
 * 计算代码行数（不含空行和注释）
 */
function countLinesOfCode(node: ts.Node, sourceFile: ts.SourceFile): number {
  const start = node.getStart(sourceFile, false);
  const end = node.getEnd();
  const text = sourceFile.text.substring(start, end);
  
  const lines = text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('//'));
  
  return lines.length;
}

/**
 * 获取函数名称
 */
function getFunctionName(node: ts.FunctionLikeDeclaration): string {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
  }
  return '<anonymous>';
}

/**
 * 获取函数类型
 */
function getFunctionKind(node: ts.FunctionLikeDeclaration): FunctionComplexity['kind'] {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isArrowFunction(node)) return 'arrow';
  return 'function';
}

/**
 * 计算风险等级
 */
function calculateRisk(
  metrics: ComplexityMetrics,
  thresholds: ComplexityThresholds
): FunctionComplexity['risk'] {
  const { cyclomatic, cognitive, parameters, maxNesting, loc } = metrics;
  
  // 任一指标达到 critical 阈值则为 critical
  if (cyclomatic >= thresholds.cyclomatic.critical ||
      cognitive >= thresholds.cognitive.critical) {
    return 'critical';
  }
  
  // 多个指标达到 high 阈值则为 high
  const highCount = [
    cyclomatic >= thresholds.cyclomatic.high,
    cognitive >= thresholds.cognitive.high,
    parameters >= thresholds.parameters.high,
    maxNesting >= thresholds.nesting.high,
    loc >= thresholds.loc.high,
  ].filter(Boolean).length;
  
  if (highCount >= 2) return 'high';
  if (highCount >= 1) return 'moderate';
  
  return 'low';
}

/**
 * 分析单个函数的复杂度
 */
export function analyzeFunctionComplexity(
  node: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  thresholds: ComplexityThresholds = DEFAULT_THRESHOLDS
): FunctionComplexity {
  const name = getFunctionName(node);
  
  // 计算圈复杂度
  const cyclomaticVisitor = new CyclomaticComplexityVisitor();
  cyclomaticVisitor.visit(node);
  
  // 计算认知复杂度
  const cognitiveVisitor = new CognitiveComplexityVisitor(name);
  if (node.body) {
    cognitiveVisitor.visit(node.body);
  }
  
  // 计算嵌套深度
  const nestingVisitor = new NestingDepthVisitor();
  if (node.body) {
    nestingVisitor.visit(node.body);
  }
  
  const metrics: ComplexityMetrics = {
    cyclomatic: cyclomaticVisitor.complexity,
    cognitive: cognitiveVisitor.complexity,
    maxNesting: nestingVisitor.maxDepth,
    parameters: node.parameters.length,
    loc: countLinesOfCode(node, sourceFile),
  };
  
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  
  return {
    name,
    kind: getFunctionKind(node),
    line: pos.line + 1,
    column: pos.character + 1,
    metrics,
    risk: calculateRisk(metrics, thresholds),
  };
}

/**
 * 分析文件中所有函数的复杂度
 */
export function analyzeFileComplexity(
  sourceFile: ts.SourceFile,
  thresholds: ComplexityThresholds = DEFAULT_THRESHOLDS
): Omit<FileComplexity, 'path'> {
  const functions: FunctionComplexity[] = [];
  
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node)) {
      const funcNode = node as ts.FunctionLikeDeclaration;
      functions.push(analyzeFunctionComplexity(funcNode, sourceFile, thresholds));
    }
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  
  const cyclomaticValues = functions.map(f => f.metrics.cyclomatic);
  const cognitiveValues = functions.map(f => f.metrics.cognitive);
  
  return {
    functions,
    averageCyclomatic: cyclomaticValues.length > 0 
      ? cyclomaticValues.reduce((a, b) => a + b, 0) / cyclomaticValues.length 
      : 0,
    averageCognitive: cognitiveValues.length > 0
      ? cognitiveValues.reduce((a, b) => a + b, 0) / cognitiveValues.length
      : 0,
    maxCyclomatic: cyclomaticValues.length > 0 ? Math.max(...cyclomaticValues) : 0,
    maxCognitive: cognitiveValues.length > 0 ? Math.max(...cognitiveValues) : 0,
    totalLoc: functions.reduce((sum, f) => sum + f.metrics.loc, 0),
    highRiskCount: functions.filter(f => f.risk === 'high' || f.risk === 'critical').length,
  };
}

/**
 * 分析单个文件（从文件路径）
 */
export async function analyzeFile(
  filePath: string,
  workspaceRoot: string,
  thresholds: ComplexityThresholds = DEFAULT_THRESHOLDS
): Promise<FileComplexity> {
  const absolutePath = resolve(workspaceRoot, filePath);
  const sourceFile = await parseSourceFile(filePath, absolutePath);
  if (!sourceFile) {
    throw new Error(`Cannot read or parse file: ${filePath}`);
  }
  
  const analysis = analyzeFileComplexity(sourceFile, thresholds);
  
  return {
    path: relative(workspaceRoot, absolutePath),
    ...analysis,
  };
}

/**
 * 分析整个项目
 */
export async function analyzeProject(
  files: string[],
  workspaceRoot: string,
  thresholds: ComplexityThresholds = DEFAULT_THRESHOLDS
): Promise<ProjectComplexity> {
  const fileResults: FileComplexity[] = [];
  
  for (const file of files) {
    try {
      const result = await analyzeFile(file, workspaceRoot, thresholds);
      fileResults.push(result);
    } catch (err) {
      // 跳过无法解析的文件
      continue;
    }
  }
  
  const allFunctions = fileResults.flatMap(f => f.functions);
  const cyclomaticValues = allFunctions.map(f => f.metrics.cyclomatic);
  const cognitiveValues = allFunctions.map(f => f.metrics.cognitive);
  
  // 找出前10个最复杂的函数（热点）
  const hotspots = [...allFunctions]
    .sort((a, b) => 
      (b.metrics.cyclomatic + b.metrics.cognitive) - 
      (a.metrics.cyclomatic + a.metrics.cognitive)
    )
    .slice(0, 10);
  
  const distribution = {
    low: allFunctions.filter(f => f.risk === 'low').length,
    moderate: allFunctions.filter(f => f.risk === 'moderate').length,
    high: allFunctions.filter(f => f.risk === 'high').length,
    critical: allFunctions.filter(f => f.risk === 'critical').length,
  };
  
  return {
    files: fileResults,
    totalFiles: fileResults.length,
    totalFunctions: allFunctions.length,
    averageCyclomatic: cyclomaticValues.length > 0
      ? cyclomaticValues.reduce((a, b) => a + b, 0) / cyclomaticValues.length
      : 0,
    averageCognitive: cognitiveValues.length > 0
      ? cognitiveValues.reduce((a, b) => a + b, 0) / cognitiveValues.length
      : 0,
    hotspots,
    distribution,
  };
}
