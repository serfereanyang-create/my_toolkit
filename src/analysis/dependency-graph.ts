/**
 * dependency-graph.ts — 模块依赖图分析器
 * 
 * 分析项目中模块间的依赖关系，检测循环依赖、分层架构违规等问题
 * 基于 import/export 语句构建依赖图
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, dirname, join, extname } from 'node:path';

/**
 * 模块节点
 */
export interface ModuleNode {
  /** 模块路径（相对于工作区根目录） */
  path: string;
  /** 导入的模块列表 */
  imports: string[];
  /** 被哪些模块导入 */
  importedBy: string[];
  /** 所属层级（如果定义了分层） */
  layer?: string;
  /** 模块类型 */
  type: 'source' | 'test' | 'config' | 'external';
}

/**
 * 依赖图
 */
export interface DependencyGraph {
  /** 所有模块节点 */
  nodes: Map<string, ModuleNode>;
  /** 邻接表（用于图遍历） */
  adjacencyList: Map<string, Set<string>>;
  /** 反向邻接表（被依赖关系） */
  reverseAdjacencyList: Map<string, Set<string>>;
}

/**
 * 循环依赖
 */
export interface CircularDependency {
  /** 循环依赖路径 */
  cycle: string[];
  /** 严重级别 */
  severity: 'warning' | 'error';
  /** 建议 */
  suggestions: string[];
}

/**
 * 依赖违规（分层架构）
 */
export interface LayerViolation {
  /** 违规的导入 */
  from: string;
  /** 被导入的模块 */
  to: string;
  /** 违规原因 */
  reason: string;
  /** 建议 */
  suggestions: string[];
}

/**
 * 依赖分析报告
 */
export interface DependencyReport {
  /** 总模块数 */
  totalModules: number;
  /** 外部依赖数 */
  externalDependencies: number;
  /** 循环依赖 */
  circularDependencies: CircularDependency[];
  /** 分层违规 */
  layerViolations: LayerViolation[];
  /** 孤岛模块（没有任何依赖和被依赖） */
  isolatedModules: string[];
  /** 上帝模块（被过多模块依赖） */
  godModules: Array<{ module: string; dependentCount: number }>;
  /** 不稳定模块（依赖过多但不被依赖） */
  unstableModules: Array<{ module: string; instability: number }>;
  /** 依赖深度统计 */
  depthStats: {
    max: number;
    average: number;
    distribution: Record<number, number>;
  };
}

/**
 * 架构层定义
 */
export interface LayerDefinition {
  name: string;
  /** 层级路径模式（glob） */
  patterns: string[];
  /** 允许依赖的层 */
  allowedDependencies: string[];
}

/**
 * 常见的分层架构配置
 */
export const COMMON_LAYER_CONFIGS = {
  /** 三层架构 */
  threeLayer: [
    {
      name: 'presentation',
      patterns: ['**/components/**', '**/views/**', '**/pages/**'],
      allowedDependencies: ['business', 'data', 'util'],
    },
    {
      name: 'business',
      patterns: ['**/services/**', '**/models/**', '**/domain/**'],
      allowedDependencies: ['data', 'util'],
    },
    {
      name: 'data',
      patterns: ['**/repositories/**', '**/api/**', '**/db/**'],
      allowedDependencies: ['util'],
    },
    {
      name: 'util',
      patterns: ['**/utils/**', '**/helpers/**', '**/lib/**'],
      allowedDependencies: [],
    },
  ] as LayerDefinition[],
  
  /** 清洁架构 */
  cleanArchitecture: [
    {
      name: 'presentation',
      patterns: ['**/ui/**', '**/controllers/**', '**/presenters/**'],
      allowedDependencies: ['application', 'domain'],
    },
    {
      name: 'application',
      patterns: ['**/use-cases/**', '**/application/**'],
      allowedDependencies: ['domain'],
    },
    {
      name: 'domain',
      patterns: ['**/domain/**', '**/entities/**'],
      allowedDependencies: [],
    },
    {
      name: 'infrastructure',
      patterns: ['**/infrastructure/**', '**/persistence/**', '**/external/**'],
      allowedDependencies: ['domain', 'application'],
    },
  ] as LayerDefinition[],
};

/**
 * 解析模块导入语句
 */
function extractImports(sourceFile: ts.SourceFile): string[] {
  const imports: string[] = [];
  
  function visit(node: ts.Node) {
    // import ... from '...'
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    
    // require('...')
    if (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    
    // import('...')
    if (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    
    // export ... from '...'
    if (ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return imports;
}

/**
 * 解析相对路径导入为绝对路径
 * 
 * 支持 NodeNext 风格：`./b.js` 导入优先解析到 `b.ts`/`b.tsx` 源文件。
 */
function resolveImportPath(
  importSpecifier: string,
  currentFile: string,
  workspaceRoot: string,
  extensions: string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
): string | null {
  // 外部包（非相对路径）
  if (!importSpecifier.startsWith('.') && !importSpecifier.startsWith('/')) {
    return null; // 标记为外部依赖
  }
  
  const currentDir = dirname(resolve(workspaceRoot, currentFile));
  const targetPath = resolve(currentDir, importSpecifier);
  const ext = extname(targetPath);
  
  // NodeNext：.js/.mjs/.cjs 导入映射回 TS 源文件
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const base = targetPath.slice(0, -ext.length);
    const tsCandidates = ext === '.mjs' ? ['.mts', '.ts'] : ext === '.cjs' ? ['.cts', '.ts'] : ['.ts', '.tsx'];
    for (const tsExt of tsCandidates) {
      if (existsSync(base + tsExt)) {
        return relative(workspaceRoot, base + tsExt).replace(/\\/g, '/');
      }
    }
    // .js 文件本身存在则用它
    if (existsSync(targetPath)) {
      return relative(workspaceRoot, targetPath).replace(/\\/g, '/');
    }
  }
  
  // 无扩展名：尝试补全扩展名
  if (!ext) {
    for (const tryExt of extensions) {
      if (existsSync(targetPath + tryExt)) {
        return relative(workspaceRoot, targetPath + tryExt).replace(/\\/g, '/');
      }
    }
    
    // 尝试 index 文件
    for (const tryExt of extensions) {
      const indexPath = join(targetPath, 'index' + tryExt);
      if (existsSync(indexPath)) {
        return relative(workspaceRoot, indexPath).replace(/\\/g, '/');
      }
    }
  }
  
  return relative(workspaceRoot, targetPath).replace(/\\/g, '/');
}

/**
 * 判断模块类型
 */
function getModuleType(path: string): ModuleNode['type'] {
  if (path.includes('/test/') || path.includes('/tests/') || path.includes('.test.') || path.includes('.spec.')) {
    return 'test';
  }
  if (path.endsWith('.config.ts') || path.endsWith('.config.js') || path.includes('/config/')) {
    return 'config';
  }
  return 'source';
}

/**
 * 构建依赖图
 */
export async function buildDependencyGraph(
  files: string[],
  workspaceRoot: string
): Promise<DependencyGraph> {
  const nodes = new Map<string, ModuleNode>();
  const adjacencyList = new Map<string, Set<string>>();
  const reverseAdjacencyList = new Map<string, Set<string>>();
  
  // 第一遍：收集所有模块
  for (const file of files) {
    const normalizedPath = file.replace(/\\/g, '/');
    nodes.set(normalizedPath, {
      path: normalizedPath,
      imports: [],
      importedBy: [],
      type: getModuleType(normalizedPath),
    });
    adjacencyList.set(normalizedPath, new Set());
    reverseAdjacencyList.set(normalizedPath, new Set());
  }
  
  // 第二遍：解析导入关系
  for (const file of files) {
    try {
      const absolutePath = resolve(workspaceRoot, file);
      const content = await readFile(absolutePath, 'utf-8');
      
      const sourceFile = ts.createSourceFile(
        file,
        content,
        ts.ScriptTarget.Latest,
        true
      );
      
      const imports = extractImports(sourceFile);
      const normalizedPath = file.replace(/\\/g, '/');
      const node = nodes.get(normalizedPath)!;
      
      for (const importSpec of imports) {
        const resolvedPath = resolveImportPath(importSpec, file, workspaceRoot);
        
        if (resolvedPath) {
          // 内部模块
          if (nodes.has(resolvedPath)) {
            node.imports.push(resolvedPath);
            adjacencyList.get(normalizedPath)!.add(resolvedPath);
            reverseAdjacencyList.get(resolvedPath)!.add(normalizedPath);
          }
        } else {
          // 外部依赖，记录但不加入图
          node.imports.push(`external:${importSpec}`);
        }
      }
    } catch (err) {
      // 跳过无法解析的文件
      continue;
    }
  }
  
  // 填充 importedBy
  for (const [path, node] of nodes) {
    node.importedBy = Array.from(reverseAdjacencyList.get(path) || []);
  }
  
  return { nodes, adjacencyList, reverseAdjacencyList };
}

/**
 * 检测循环依赖（使用 DFS）
 */
export function detectCircularDependencies(graph: DependencyGraph): CircularDependency[] {
  const cycles: CircularDependency[] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const pathStack: string[] = [];
  
  function dfs(node: string): boolean {
    visited.add(node);
    recursionStack.add(node);
    pathStack.push(node);
    
    const neighbors = graph.adjacencyList.get(node) || new Set();
    
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) {
          return true;
        }
      } else if (recursionStack.has(neighbor)) {
        // 找到循环
        const cycleStartIndex = pathStack.indexOf(neighbor);
        const cycle = pathStack.slice(cycleStartIndex);
        cycle.push(neighbor); // 闭合循环
        
        cycles.push({
          cycle,
          // cycle 数组含闭合重复节点：两模块互相依赖时长度为 3
          severity: cycle.length <= 3 ? 'error' : 'warning',
          suggestions: [
            '将共享逻辑提取到第三个模块',
            '使用依赖注入打破循环',
            '重新设计模块边界',
          ],
        });
        
        return true;
      }
    }
    
    recursionStack.delete(node);
    pathStack.pop();
    return false;
  }
  
  for (const node of graph.nodes.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }
  
  return cycles;
}

/**
 * 计算模块依赖深度
 */
export function calculateDependencyDepth(
  graph: DependencyGraph,
  startNode: string
): number {
  const visited = new Set<string>();
  let maxDepth = 0;
  
  function dfs(node: string, depth: number) {
    if (visited.has(node)) return;
    visited.add(node);
    maxDepth = Math.max(maxDepth, depth);
    
    const neighbors = graph.adjacencyList.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (!neighbor.startsWith('external:')) {
        dfs(neighbor, depth + 1);
      }
    }
  }
  
  dfs(startNode, 0);
  return maxDepth;
}

/**
 * 检测分层架构违规
 */
export function detectLayerViolations(
  graph: DependencyGraph,
  layers: LayerDefinition[]
): LayerViolation[] {
  const violations: LayerViolation[] = [];
  
  // 为每个模块分配层级
  for (const [path, node] of graph.nodes) {
    for (const layer of layers) {
      const matches = layer.patterns.some(pattern => {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(path);
      });
      if (matches) {
        node.layer = layer.name;
        break;
      }
    }
  }
  
  // 检查依赖是否违反层级规则
  for (const [path, node] of graph.nodes) {
    if (!node.layer) continue;
    
    const layerDef = layers.find(l => l.name === node.layer);
    if (!layerDef) continue;
    
    for (const importPath of node.imports) {
      if (importPath.startsWith('external:')) continue;
      
      const importedNode = graph.nodes.get(importPath);
      if (!importedNode?.layer) continue;
      
      if (!layerDef.allowedDependencies.includes(importedNode.layer)) {
        violations.push({
          from: path,
          to: importPath,
          reason: `层 '${node.layer}' 不应依赖层 '${importedNode.layer}'`,
          suggestions: [
            `重构代码使 '${node.layer}' 层不直接依赖 '${importedNode.layer}' 层`,
            '考虑引入接口抽象，通过依赖倒置原则解耦',
            '检查是否应该将功能移到更低层',
          ],
        });
      }
    }
  }
  
  return violations;
}

/**
 * 计算模块不稳定性
 * Instability = Fan-out / (Fan-in + Fan-out)
 * Fan-out: 依赖的模块数
 * Fan-in: 被依赖的模块数
 */
export function calculateInstability(graph: DependencyGraph, module: string): number {
  const node = graph.nodes.get(module);
  if (!node) return 0;
  
  const fanOut = node.imports.filter(i => !i.startsWith('external:')).length;
  const fanIn = node.importedBy.length;
  
  if (fanIn + fanOut === 0) return 0;
  return fanOut / (fanIn + fanOut);
}

/**
 * 生成依赖分析报告
 */
export async function analyzeDependencies(
  files: string[],
  workspaceRoot: string,
  layers?: LayerDefinition[]
): Promise<DependencyReport> {
  const graph = await buildDependencyGraph(files, workspaceRoot);
  
  // 统计外部依赖
  const externalDeps = new Set<string>();
  for (const node of graph.nodes.values()) {
    for (const imp of node.imports) {
      if (imp.startsWith('external:')) {
        externalDeps.add(imp.substring(9));
      }
    }
  }
  
  // 循环依赖
  const circularDependencies = detectCircularDependencies(graph);
  
  // 分层违规
  const layerViolations = layers ? detectLayerViolations(graph, layers) : [];
  
  // 孤岛模块
  const isolatedModules = Array.from(graph.nodes.values())
    .filter(node => node.imports.length === 0 && node.importedBy.length === 0)
    .map(node => node.path);
  
  // 上帝模块（被超过10个模块依赖）
  const godModules = Array.from(graph.nodes.values())
    .filter(node => node.importedBy.length > 10)
    .map(node => ({ module: node.path, dependentCount: node.importedBy.length }))
    .sort((a, b) => b.dependentCount - a.dependentCount)
    .slice(0, 10);
  
  // 不稳定模块（不稳定性 > 0.8 且被依赖数 < 2）
  const unstableModules = Array.from(graph.nodes.keys())
    .map(module => ({ module, instability: calculateInstability(graph, module) }))
    .filter(item => item.instability > 0.8 && (graph.nodes.get(item.module)?.importedBy.length || 0) < 2)
    .sort((a, b) => b.instability - a.instability)
    .slice(0, 10);
  
  // 依赖深度统计
  const depths = Array.from(graph.nodes.keys())
    .map(node => calculateDependencyDepth(graph, node));
  
  const maxDepth = Math.max(...depths, 0);
  const avgDepth = depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : 0;
  
  const distribution: Record<number, number> = {};
  for (const depth of depths) {
    distribution[depth] = (distribution[depth] || 0) + 1;
  }
  
  return {
    totalModules: graph.nodes.size,
    externalDependencies: externalDeps.size,
    circularDependencies,
    layerViolations,
    isolatedModules,
    godModules,
    unstableModules,
    depthStats: {
      max: maxDepth,
      average: avgDepth,
      distribution,
    },
  };
}

/**
 * 导出为 DOT 格式（用于 Graphviz 可视化）
 */
export function exportToDot(graph: DependencyGraph, options?: {
  highlightCycles?: string[][];
  showExternalDeps?: boolean;
}): string {
  const lines: string[] = [];
  lines.push('digraph Dependencies {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box];');
  
  const cycleEdges = new Set<string>();
  if (options?.highlightCycles) {
    for (const cycle of options.highlightCycles) {
      for (let i = 0; i < cycle.length - 1; i++) {
        cycleEdges.add(`${cycle[i]}->${cycle[i + 1]}`);
      }
    }
  }
  
  // 节点
  for (const [path, node] of graph.nodes) {
    const label = path.split('/').pop() || path;
    const color = node.type === 'test' ? 'lightblue' : node.type === 'config' ? 'lightyellow' : 'white';
    lines.push(`  "${path}" [label="${label}", fillcolor=${color}, style=filled];`);
  }
  
  // 边
  for (const [from, neighbors] of graph.adjacencyList) {
    for (const to of neighbors) {
      if (!to.startsWith('external:')) {
        const key = `${from}->${to}`;
        const color = cycleEdges.has(key) ? 'red' : 'black';
        lines.push(`  "${from}" -> "${to}" [color=${color}];`);
      } else if (options?.showExternalDeps) {
        const extName = to.substring(9);
        lines.push(`  "${extName}" [shape=ellipse, color=gray];`);
        lines.push(`  "${from}" -> "${extName}" [style=dashed, color=gray];`);
      }
    }
  }
  
  lines.push('}');
  return lines.join('\n');
}
