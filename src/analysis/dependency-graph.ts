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
 * 检测循环依赖（迭代式 DFS，Tarjan SCC）
 *
 * 旧实现有两处硬伤，都在真实输入上复现过：
 *  1. 找到一条环就 `return true` 一路回溯，把它所在连通分量里其余环全部吞掉
 *     —— `c -> a <-> b` 会报出 `a -> b -> c -> a` 这条根本不存在的「环」，
 *     同时漏掉真正的 `a <-> b`；两个互不相交的环里第二个也直接消失。
 *  2. 递归深度等于依赖链长度；20000 个模块的手拉手链条直接
 *     `RangeError: Maximum call stack size exceeded`（实测 6.5s 后抛错）。
 *
 * 现在改用显式栈的 Tarjan：每个 SCC 内部按起点做一次迭代 DFS 还原基本环，
 * 复杂度 O(V+E)，与链长无关；自环（模块 import 自己）照报。
 */
export function detectCircularDependencies(
  graph: DependencyGraph,
  options: { maxCycles?: number } = {},
): CircularDependency[] {
  const maxCycles = Math.max(1, options.maxCycles ?? 100);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const components: string[][] = [];

  for (const root of graph.nodes.keys()) {
    if (index.has(root)) continue;
    // 显式调用栈：[node, 子节点迭代器, 是否已展开完毕]
    const work: Array<{ node: string; children: string[]; next: number }> = [
      { node: root, children: [...(graph.adjacencyList.get(root) ?? [])], next: 0 },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.next < frame.children.length) {
        const child = frame.children[frame.next++]!;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter++;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, children: [...(graph.adjacencyList.get(child) ?? [])], next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }
      // 子树全部展开：出栈并回填 low-link
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let popped: string | undefined;
        do {
          popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== frame.node);
        if (component.length > 1) components.push(component);
        else if (graph.adjacencyList.get(frame.node)?.has(frame.node)) components.push(component);
      }
    }
  }

  const cycles: CircularDependency[] = [];
  const seen = new Set<string>();
  for (const component of components) {
    // 找环本身也要有配额：10 个模块两两互相 import 时基本环数量是阶乘级
    // （实测 maxCycles=5 仍耗时 20s、堆 2.8GB），旧实现会先生成全部环再截断。
    // 这里把剩余配额传进 SCC 内搜索，凑满即停。
    const remaining = maxCycles - cycles.length;
    if (remaining <= 0) return cycles;
    for (const cycle of extractElementaryCycles(graph, component, remaining + seen.size)) {
      const key = canonicalCycleKey(cycle);
      if (seen.has(key)) continue;
      seen.add(key);
      cycles.push({
        cycle,
        severity: cycle.length <= 3 ? 'error' : 'warning',
        suggestions: [
          '将共享逻辑提取到第三个模块',
          '使用依赖注入打破循环',
          '重新设计模块边界',
        ],
      });
      if (cycles.length >= maxCycles) return cycles;
    }
  }
  return cycles;
}

/**
 * 在单个 SCC 内从每个节点出发，迭代 DFS 找回到自身的简单环（限定组件内）。
 *
 * `limit` 是生成上限：稠密 SCC 的简单环数量是阶乘级，必须边找边停，
 * 不能全部生成后再截断（否则 10 节点完全图要 20s / 2.8GB）。去重交给调用方，
 * 因此这里按「已生成条数」而不是「已去重条数」计数，宁可多给几条。
 */
function extractElementaryCycles(graph: DependencyGraph, component: string[], limit: number): string[][] {
  const inComponent = new Set(component);
  const found: string[][] = [];
  for (const start of component) {
    if (found.length >= limit) break;
    // 栈帧记录当前路径；深度 <= 组件大小，因此最多 component.length 次扩展。
    const path: string[] = [start];
    const onPath = new Set<string>([start]);
    const frames: Array<{ node: string; children: string[]; next: number }> = [
      { node: start, children: [...(graph.adjacencyList.get(start) ?? [])].filter((n) => inComponent.has(n)), next: 0 },
    ];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.next >= frame.children.length) {
        frames.pop();
        path.pop();
        onPath.delete(frame.node);
        continue;
      }
      const child = frame.children[frame.next++]!;
      if (child === start) {
        found.push([...path, start]);
        if (found.length >= limit) return found;
        continue;
      }
      if (onPath.has(child)) continue;
      path.push(child);
      onPath.add(child);
      frames.push({ node: child, children: [...(graph.adjacencyList.get(child) ?? [])].filter((n) => inComponent.has(n)), next: 0 });
    }
  }
  return found;
}

/** 环的规范化 key：旋转到最小字典序起点，消除同一个环的不同起点写法。 */
function canonicalCycleKey(cycle: string[]): string {
  const nodes = cycle.slice(0, -1);
  if (nodes.length === 0) return '';
  let best = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i]!.localeCompare(nodes[best]!) < 0) best = i;
  }
  return [...nodes.slice(best), ...nodes.slice(0, best)].join('\u0000');
}

/**
 * 计算模块依赖深度
 *
 * 与环检测同因：递归 DFS 在长依赖链上会爆栈。改为显式栈，语义不变——
 * 只沿未访问节点前进（同一节点不会被重复展开），返回从起点可达的最大层数。
 */
export function calculateDependencyDepth(
  graph: DependencyGraph,
  startNode: string
): number {
  const visited = new Set<string>();
  let maxDepth = 0;
  const stack: Array<{ node: string; depth: number }> = [{ node: startNode, depth: 0 }];

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (depth > maxDepth) maxDepth = depth;

    for (const neighbor of graph.adjacencyList.get(node) ?? []) {
      if (!neighbor.startsWith('external:') && !visited.has(neighbor)) {
        stack.push({ node: neighbor, depth: depth + 1 });
      }
    }
  }
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
