/**
 * importCycles.ts — 检测 TS/TSX 模块之间的循环依赖
 *
 * 解析每个文件的 import 路径，构建有向图，跑 Tarjan SCC，
 * 找出所有 size>1 的强连通分量（即循环）。仅纯分析，无副作用。
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { glob } from 'glob';
import { dirname, resolve, sep } from 'node:path';

export interface ImportEdge {
  from: string;
  to: string;
  /** 模块说明符原文（用于排查目录/库 vs 相对） */
  specifier: string;
}

export interface ImportCycle {
  /** 形成环的文件列表（按 SCC 输出顺序） */
  files: string[];
  /** 环内的边数 */
  edgeCount: number;
}

export interface CycleReport {
  scannedFiles: number;
  totalEdges: number;
  cycles: ImportCycle[];
}

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function resolveSpecifier(fromFile: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null; // 第三方依赖不进环分析
  const base = resolve(dirname(fromFile), spec);
  const candidates: string[] = [];
  const hasExt = /\.[a-z]+$/i.test(spec);
  if (!hasExt) {
    for (const ext of TS_EXTS) candidates.push(base + ext);
    for (const ext of TS_EXTS) candidates.push(resolve(base, 'index' + ext));
  } else {
    candidates.push(base);
  }
  for (const cand of candidates) {
    const norm = cand.split(sep).join('/');
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

/** 收集单文件内所有 import/export-from 的相对说明符 */
export function collectImports(filePath: string, source: string): string[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const specs: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return specs;
}

/** 构建依赖图：file -> set(依赖 file) */
export function buildGraph(edges: ImportEdge[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const e of edges) {
    let bucket = graph.get(e.from);
    if (!bucket) {
      bucket = new Set<string>();
      graph.set(e.from, bucket);
    }
    bucket.add(e.to);
    if (!graph.has(e.to)) graph.set(e.to, new Set());
  }
  return graph;
}

/** Tarjan 强连通分量；返回所有 size>1 的 SCC */
export function findStronglyConnected(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function strongconnect(node: string): void {
    indexOf.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!indexOf.has(next)) {
        strongconnect(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indexOf.get(next)!));
      }
    }

    if (low.get(node) === indexOf.get(node)) {
      const scc: string[] = [];
      let cur: string;
      do {
        cur = stack.pop()!;
        onStack.delete(cur);
        scc.push(cur);
      } while (cur !== node);
      if (scc.length > 1) components.push(scc);
    }
  }

  for (const node of graph.keys()) {
    if (!indexOf.has(node)) strongconnect(node);
  }
  return components;
}

export async function detectImportCycles(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<CycleReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);
  const fileSet = new Set(selected.map((f) => f.split(sep).join('/')));

  const edges: ImportEdge[] = [];
  for (const file of selected) {
    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const specs = collectImports(file, source);
    const fromNorm = file.split(sep).join('/');
    for (const spec of specs) {
      const to = resolveSpecifier(file, spec, fileSet);
      if (to) edges.push({ from: fromNorm, to, specifier: spec });
    }
  }

  const graph = buildGraph(edges);
  const sccs = findStronglyConnected(graph);
  const cycles: ImportCycle[] = sccs.map((scc) => {
    const members = new Set(scc);
    const innerEdges = edges.filter((e) => members.has(e.from) && members.has(e.to));
    return { files: scc, edgeCount: innerEdges.length };
  }).sort((a, b) => b.files.length - a.files.length);

  return {
    scannedFiles: selected.length,
    totalEdges: edges.length,
    cycles,
  };
}
