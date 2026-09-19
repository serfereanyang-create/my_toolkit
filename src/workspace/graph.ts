/**
 * graph.ts - Workspace package 依赖图构建与导出。
 *
 * 节点 = workspace 内每个包；边 = 包之间的依赖声明。
 * 支持 JSON 结构化输出与 Graphviz DOT 文本。
 */

import type { WorkspacePackage } from './discover.js';

export interface PackageGraphNode {
  id: string;         // 包名（@scope/name）
  label: string;      // 展示用
  version: string;
  dir: string;
  isPrivate: boolean;
}

export interface PackageGraphEdge {
  from: string;       // 依赖者包名
  to: string;         // 被依赖包名
  /** 依赖类别 */
  kind: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
}

export interface PackageGraph {
  nodes: PackageGraphNode[];
  edges: PackageGraphEdge[];
}

export function buildPackageGraph(packages: WorkspacePackage[]): PackageGraph {
  const nodeByName = new Map<string, PackageGraphNode>();
  for (const pkg of packages) {
    nodeByName.set(pkg.name, {
      id: pkg.name,
      label: pkg.name.split('/').pop() ?? pkg.name,
      version: pkg.version,
      dir: pkg.dir,
      isPrivate: pkg.isPrivate,
    });
  }

  const edges: PackageGraphEdge[] = [];
  for (const pkg of packages) {
    const categories: Array<[keyof WorkspacePackage, PackageGraphEdge['kind']]> = [
      ['dependencies', 'dependencies'],
      ['devDependencies', 'devDependencies'],
      ['peerDependencies', 'peerDependencies'],
      ['optionalDependencies', 'optionalDependencies'],
    ];
    for (const [field, kind] of categories) {
      for (const depName of pkg[field] as string[]) {
        if (nodeByName.has(depName)) {
          edges.push({ from: pkg.name, to: depName, kind });
        }
      }
    }
  }

  return { nodes: [...nodeByName.values()], edges };
}

/** Graphviz DOT 输出 */
export function graphToDot(graph: PackageGraph): string {
  const lines: string[] = ['digraph workspace {', '  rankdir=LR;', '  node [shape=box];'];
  for (const node of graph.nodes) {
    const attrs: string[] = [`label="${node.id}\\n(${node.version})"`];
    if (node.isPrivate) attrs.push('style=dashed');
    lines.push(`  ${escapeId(node.id)} [${attrs.join(' ')}];`);
  }
  for (const edge of graph.edges) {
    const style =
      edge.kind === 'peerDependencies'
        ? ' [style=dotted]'
        : edge.kind === 'devDependencies'
          ? ' [style=dashed, color=gray]'
          : '';
    lines.push(`  ${escapeId(edge.from)} -> ${escapeId(edge.to)}${style};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function escapeId(id: string): string {
  // DOT id 需要加引号以防特殊字符
  return `"${id.replace(/"/g, '\\"')}"`;
}

/** 简单 JSON 摘要序列化 */
export function graphToJson(graph: PackageGraph): string {
  return JSON.stringify(graph, null, 2);
}
