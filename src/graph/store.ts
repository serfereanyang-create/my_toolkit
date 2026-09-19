/**
 * store.ts — 代码关系图谱持久化存储
 *
 * 负责图数据的序列化/反序列化、增量更新、缓存管理
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CodeGraph, GraphNode, GraphEdge } from './types.js';

const GRAPH_VERSION = 1;
const CACHE_DIR = '.aicode/graph';
const GRAPH_FILE = 'relations.json';
const MAX_GRAPH_BYTES = 100 * 1024 * 1024;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function computeFingerprint(root: string, files: string[]): string {
  const hash = createHash('sha256');
  for (const file of [...new Set(files.map(normalizePath))].sort()) {
    const absolute = resolve(root, file);
    try {
      const stat = statSync(absolute) as { size: number; mtimeMs: number };
      hash.update(`${file}\0${stat.size}\0${stat.mtimeMs}\n`);
    } catch {
      hash.update(`${file}\0missing\n`);
    }
  }
  return hash.digest('hex');
}

export class GraphStore {
  private workspaceRoot: string;
  private cachePath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.cachePath = resolve(this.workspaceRoot, CACHE_DIR, GRAPH_FILE);
  }

  /**
   * 加载已缓存的图，如果不存在或版本不匹配则返回 null
   */
  async load(): Promise<CodeGraph | null> {
    if (!existsSync(this.cachePath)) return null;

    try {
      const content = await readFile(this.cachePath, 'utf8');
      const graph: CodeGraph = JSON.parse(content);

      // 版本检查
      if (graph.version !== GRAPH_VERSION) {
        console.warn(`[GraphStore] Version mismatch: expected ${GRAPH_VERSION}, got ${graph.version}`);
        return null;
      }

      // 根目录检查
      if (resolve(graph.root) !== resolve(this.workspaceRoot)) {
        console.warn(`[GraphStore] Root mismatch: expected ${this.workspaceRoot}, got ${graph.root}`);
        return null;
      }

      // 文件快照指纹检查。旧缓存没有 sourceFiles/fingerprint 时保持兼容，
      // 但新缓存会在文件发生变化后立即失效。
      if (graph.sourceFiles && graph.fingerprint &&
          computeFingerprint(this.workspaceRoot, graph.sourceFiles) !== graph.fingerprint) {
        console.warn('[GraphStore] Source files changed; graph cache is stale');
        return null;
      }

      if (!graph.nodes || !Array.isArray(graph.edges)) return null;
      graph.edges = graph.edges.filter((edge) => graph.nodes[edge.from] && graph.nodes[edge.to]);
      return graph;
    } catch (error) {
      console.error('[GraphStore] Failed to load graph:', error);
      return null;
    }
  }

  /**
   * 保存图到磁盘
   */
  async save(graph: CodeGraph): Promise<void> {
    try {
      // 确保缓存目录存在
      const dir = dirname(this.cachePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

    const sourceFiles = graph.sourceFiles || Array.from(new Set(Object.values(graph.nodes).map((node) => normalizePath(node.loc.path))));
      const graphToSave: CodeGraph = {
        ...graph,
        version: GRAPH_VERSION,
        root: this.workspaceRoot,
        sourceFiles,
      };
      graphToSave.fingerprint = computeFingerprint(this.workspaceRoot, sourceFiles);
      const content = JSON.stringify(graphToSave, null, 2);
      if (Buffer.byteLength(content, 'utf8') > MAX_GRAPH_BYTES) {
        throw new Error(`Graph cache exceeds ${MAX_GRAPH_BYTES} byte limit`);
      }
      const temporaryPath = `${this.cachePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporaryPath, content, 'utf8');
      await rename(temporaryPath, this.cachePath).catch(async (error) => {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      });
    } catch (error) {
      console.error('[GraphStore] Failed to save graph:', error);
      throw error;
    }
  }

  /**
   * 创建空图
   */
  createEmpty(): CodeGraph {
    return {
      version: GRAPH_VERSION,
      generated: Date.now(),
      root: this.workspaceRoot,
      nodes: {},
      edges: [],
      sourceFiles: [],
      stats: {
        nodeCount: 0,
        edgeCount: 0,
        fileCount: 0,
      },
    };
  }

  /**
   * 增量更新：合并新构建的子图到现有图中
   *
   * @param existingGraph 现有的完整图
   * @param changedFiles 变更的文件路径列表
   * @param newSubgraph 新构建的子图（仅包含变更文件）
   * @returns 合并后的新图
   */
  mergeSubgraph(
    existingGraph: CodeGraph,
    changedFiles: string[],
    newSubgraph: CodeGraph,
  ): CodeGraph {
    const normalizedChangedFiles = changedFiles.map(normalizePath);
    const changedFileSet = new Set(normalizedChangedFiles);

    // 1. 移除变更文件相关的旧节点和边
    const nodesToKeep: Record<string, GraphNode> = {};
    for (const [id, node] of Object.entries(existingGraph.nodes)) {
      const normalizedPath = node.loc.path.replace(/\\/g, '/');
      if (!changedFileSet.has(normalizedPath)) {
        nodesToKeep[id] = node;
      }
    }

    const keptNodeIds = new Set(Object.keys(nodesToKeep));
    const edgesToKeep = existingGraph.edges.filter(edge => {
      // 保留边的条件：起点和终点都不在变更文件中
      return keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to);
    });

    // 2. 合并新子图的节点
    const mergedNodes = { ...nodesToKeep, ...newSubgraph.nodes };

    // 3. 合并新子图的边（去重，并丢弃任何悬空边）
    const edgeSet = new Set<string>();
    const mergedEdges: GraphEdge[] = [];
    for (const edge of [...edgesToKeep, ...newSubgraph.edges]) {
      if (!mergedNodes[edge.from] || !mergedNodes[edge.to]) continue;
      const key = `${edge.from}::${edge.to}::${edge.type}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        mergedEdges.push(edge);
      }
    }

    // 4. 统计受影响的文件
    const affectedFiles = new Set<string>();
    for (const node of Object.values(mergedNodes)) {
      affectedFiles.add(node.loc.path);
    }

    return {
      version: GRAPH_VERSION,
      generated: Date.now(),
      root: this.workspaceRoot,
      nodes: mergedNodes,
      edges: mergedEdges,
      sourceFiles: Array.from(new Set(Object.values(mergedNodes).map((node) => normalizePath(node.loc.path)))),
      stats: {
        nodeCount: Object.keys(mergedNodes).length,
        edgeCount: mergedEdges.length,
        fileCount: affectedFiles.size,
      },
    };
  }

  /**
   * 从图中移除指定文件相关的所有节点和边
   */
  removeFiles(graph: CodeGraph, filesToRemove: string[]): CodeGraph {
    const normalizedRemoveFiles = new Set(filesToRemove.map(normalizePath));

    const nodesToKeep: Record<string, GraphNode> = {};
    for (const [id, node] of Object.entries(graph.nodes)) {
      const normalizedPath = node.loc.path.replace(/\\/g, '/');
      if (!normalizedRemoveFiles.has(normalizedPath)) {
        nodesToKeep[id] = node;
      }
    }

    const keptNodeIds = new Set(Object.keys(nodesToKeep));
    const edgesToKeep = graph.edges.filter(
      edge => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to),
    );

    const affectedFiles = new Set<string>();
    for (const node of Object.values(nodesToKeep)) {
      affectedFiles.add(node.loc.path);
    }

    return {
      ...graph,
      generated: Date.now(),
      nodes: nodesToKeep,
      edges: edgesToKeep,
      sourceFiles: Array.from(new Set(Object.values(nodesToKeep).map((node) => normalizePath(node.loc.path)))),
      stats: {
        nodeCount: Object.keys(nodesToKeep).length,
        edgeCount: edgesToKeep.length,
        fileCount: affectedFiles.size,
      },
    };
  }

  private static normalizeGraph(graph: CodeGraph, root: string): CodeGraph {
    const nodes = graph.nodes || {};
    const edges = graph.edges.filter((edge) => nodes[edge.from] && nodes[edge.to]);
    return {
      ...graph,
      version: GRAPH_VERSION,
      root,
      nodes,
      edges,
      stats: {
        nodeCount: Object.keys(nodes).length,
        edgeCount: edges.length,
        fileCount: new Set(Object.values(nodes).map((node) => normalizePath(node.loc.path))).size,
      },
    };
  }

  /**
   * 获取缓存文件路径（用于调试）
   */
  getCachePath(): string {
    return this.cachePath;
  }

  /**
   * 清除缓存
   */
  async clear(): Promise<void> {
    if (existsSync(this.cachePath)) {
      const fs = await import('node:fs/promises');
      await fs.unlink(this.cachePath);
    }
  }
}
