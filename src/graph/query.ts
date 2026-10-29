/**
 * query.ts — 代码关系图谱查询引擎
 *
 * 提供 BFS/DFS 遍历、影响范围分析、类型关系查询等功能
 */

import type {
  CodeGraph,
  GraphNode,
  GraphEdge,
  GraphQueryResult,
  ImpactAnalysisResult,
  TypeRelationsResult,
  EdgeType,
} from './types.js';

/**
 * 图查询引擎
 */
export class GraphQueryEngine {
  private graph: CodeGraph;
  /** 邻接表：from -> [edges] */
  private outEdges: Map<string, GraphEdge[]>;
  /** 反向邻接表：to -> [edges] */
  private inEdges: Map<string, GraphEdge[]>;
  /** 名称索引，避免每次查询扫描全部节点 */
  private nameIndex: Map<string, GraphNode[]>;

  constructor(graph: CodeGraph) {
    this.graph = graph;
    this.outEdges = new Map();
    this.inEdges = new Map();
    this.nameIndex = new Map();
    this.buildAdjacencyLists();
    this.buildNameIndex();
  }

  /** 构建名称索引 */
  private buildNameIndex(): void {
    for (const node of Object.values(this.graph.nodes)) {
      const key = node.name.toLowerCase();
      const bucket = this.nameIndex.get(key) || [];
      bucket.push(node);
      this.nameIndex.set(key, bucket);
    }
  }

  /**
   * 构建邻接表以加速查询
   */
  private buildAdjacencyLists(): void {
    for (const edge of this.graph.edges) {
      // 出边（from -> to）
      if (!this.outEdges.has(edge.from)) {
        this.outEdges.set(edge.from, []);
      }
      this.outEdges.get(edge.from)!.push(edge);

      // 入边（to <- from）
      if (!this.inEdges.has(edge.to)) {
        this.inEdges.set(edge.to, []);
      }
      this.inEdges.get(edge.to)!.push(edge);
    }
  }

  /**
   * 按名称查找节点，返回字符串 ID 以便调用方区分歧义。
   *
   * 精确匹配（大小写不敏感）优先；只有精确匹配为空时才退到部分匹配，
   * 并在返回里标明 `partial: true`，调用方可据此提示"可能不是你要的符号"。
   */
  resolveNodeIds(name: string): { ids: GraphNode[]; partial: boolean } {
    const exact = this.findNodesByExactName(name);
    if (exact.length > 0) return { ids: exact, partial: false };
    return { ids: this.findNodesByName(name), partial: true };
  }

  /**
   * 查找调用图：谁调用了这个函数（callers）或这个函数调用了谁（callees）
   *
   * `target` 可以是符号名，也可以是 `file.ts::name` 形式的节点 ID —— 当同名
   * 符号有多个时，用 ID 才能精确指定。
   *
   * @param target 目标符号名称（如 "verifyToken"）
   * @param direction 查询方向
   * @param depth BFS 深度限制
   * @param maxResults 最大结果数
   * @param edgeTypes 限制边类型（默认只查 'call'）
   */
  queryCallGraph(
    target: string,
    direction: 'callers' | 'callees' | 'both' = 'callers',
    depth: number = 2,
    maxResults: number = 50,
    edgeTypes: EdgeType[] = ['call'],
  ): GraphQueryResult {
    // 1. 查找目标节点：节点 ID 优先（同名解歧用），否则精确/部分名称匹配。
    const byId = this.graph.nodes[target];
    const resolved = byId ? { ids: [byId], partial: false } : this.resolveNodeIds(target);
    const targetNodes = resolved.ids;
    if (targetNodes.length === 0) {
      return {
        target,
        direction,
        nodes: [],
        totalCount: 0,
        startNodes: [],
      };
    }

    // 同名符号是常态（每个模块都有自己的 handler）。旧实现只挑一个
    // （exported 优先），其余同名的调用者永远查不到，而输出看起来像完整答案。
    // 现在所有同名节点都是起点，结果里标 ambiguous 让调用方知道名字有歧义。
    const startNodes = targetNodes;
    const startIds = new Set(startNodes.map((node) => node.id));

    // 2. 多源 BFS 遍历
    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; distance: number; path: string[] }> =
      startNodes.map((node) => ({ nodeId: node.id, distance: 0, path: [node.id] }));
    const results: GraphQueryResult['nodes'] = [];

    for (const id of startIds) visited.add(id);

    let cursor = 0;
    while (cursor < queue.length && results.length < maxResults) {
      const current = queue[cursor++]!;

      // 跳过起始节点本身
      if (current.distance > 0) {
        const node = this.graph.nodes[current.nodeId];
        if (node) {
          results.push({
            node,
            distance: current.distance,
            path: current.path,
          });
        }
      }

      // 达到深度限制
      if (current.distance >= depth) continue;

      // 获取邻居节点
      const neighbors = this.getNeighbors(current.nodeId, direction, edgeTypes);

      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push({
            nodeId: neighborId,
            distance: current.distance + 1,
            path: [...current.path, neighborId],
          });
        }
      }
    }

    return {
      target,
      direction,
      nodes: results,
      totalCount: results.length,
      // 队列里还有未展开的节点 = 结果被 maxResults 截断
      ...(cursor < queue.length ? { truncated: true } : {}),
      ...(startNodes.length > 1 ? { ambiguous: startNodes } : {}),
      ...(resolved.partial ? { partialMatch: true } : {}),
      startNodes: [...startIds],
    };
  }

  /**
   * 获取节点的邻居（根据方向和边类型过滤）
   */
  private getNeighbors(
    nodeId: string,
    direction: 'callers' | 'callees' | 'both',
    edgeTypes: EdgeType[],
  ): string[] {
    const neighbors = new Set<string>();
    const edgeTypeSet = new Set(edgeTypes);

    if (direction === 'callees' || direction === 'both') {
      // 出边：找被调用者
      const outEdges = this.outEdges.get(nodeId) || [];
      for (const edge of outEdges) {
        if (edgeTypeSet.has(edge.type)) {
          neighbors.add(edge.to);
        }
      }
    }

    if (direction === 'callers' || direction === 'both') {
      // 入边：找调用者
      const inEdges = this.inEdges.get(nodeId) || [];
      for (const edge of inEdges) {
        if (edgeTypeSet.has(edge.type)) {
          neighbors.add(edge.from);
        }
      }
    }

    return Array.from(neighbors);
  }

  /**
   * 根据名称查找节点（支持部分匹配）
   *
   * 三种匹配口径要能分开：`findNodesByName` 的「部分匹配」只是候选发现，
   * 不能当成"就是它"。`analyzeImpact` 等需要精确集合时用
   * `findNodesByExactName`：大小写精确优先，退一步才做大小写不敏感全等，
   * 绝不把 `HandleRequest` 当成查询 `handle` 的答案。
   */
  findNodesByName(name: string): GraphNode[] {
    const lowerName = name.toLowerCase();
    const exact = this.nameIndex.get(lowerName);
    if (exact) return exact;

    const results: GraphNode[] = [];
    for (const [key, nodes] of this.nameIndex) {
      if (key.includes(lowerName)) results.push(...nodes);
    }
    return results;
  }

  /** 精确名称查找：大小写完全一致 > 大小写不敏感全等 > 空。 */
  findNodesByExactName(name: string): GraphNode[] {
    const all = Array.from(Object.values(this.graph.nodes));
    const exact = all.filter((node) => node.name === name);
    if (exact.length > 0) return exact;
    const lower = name.toLowerCase();
    return all.filter((node) => node.name.toLowerCase() === lower);
  }

  /**
   * 影响范围分析：修改这个符号会影响哪些地方
   */
  analyzeImpact(target: string, maxDepth: number = 3): ImpactAnalysisResult {
    const targetNodes = this.findNodesByExactName(target);
    if (targetNodes.length === 0) {
      return {
        symbol: target,
        directImpact: [],
        indirectImpact: [],
        affectedFiles: [],
        risk: 'low',
      };
    }

    // 同名节点全部纳入：只分析一个会让「影响面」少报，而少报的影响面比
    // 多报更危险（用户据此以为改动是安全的）。matchedNodes 说明匹配了几个。
    const startIds = targetNodes.map((node) => node.id);

    // 查找所有调用者（深度优先遍历）
    const directCallers = new Set<string>();
    for (const id of startIds) {
      for (const caller of this.getNeighbors(id, 'callers', ['call'])) directCallers.add(caller);
    }
    const directImpact = [...directCallers]
      .map(id => this.graph.nodes[id])
      .filter(Boolean) as GraphNode[];

    // 递归查找间接调用者
    const visited = new Set([...startIds, ...directCallers]);
    const indirectImpact: GraphNode[] = [];
    const queue: string[] = [...directCallers];
    let cursor = 0;
    let depth = 1;

    while (cursor < queue.length && depth < maxDepth) {
      const levelEnd = queue.length;
      for (; cursor < levelEnd; cursor++) {
        const currentId = queue[cursor]!;
        const callers = this.getNeighbors(currentId, 'callers', ['call']);

        for (const callerId of callers) {
          if (!visited.has(callerId)) {
            visited.add(callerId);
            queue.push(callerId);
            const node = this.graph.nodes[callerId];
            if (node) {
              indirectImpact.push(node);
            }
          }
        }
      }
      depth++;
    }

    // 收集受影响的文件
    const affectedFiles = new Set<string>();
    for (const node of [...directImpact, ...indirectImpact]) {
      affectedFiles.add(node.loc.path);
    }

    // 评估风险等级
    const totalImpact = directImpact.length + indirectImpact.length;
    let risk: ImpactAnalysisResult['risk'];
    if (totalImpact === 0) risk = 'low';
    else if (totalImpact < 5) risk = 'low';
    else if (totalImpact < 15) risk = 'moderate';
    else if (totalImpact < 30) risk = 'high';
    else risk = 'critical';

    return {
      symbol: target,
      directImpact,
      indirectImpact,
      affectedFiles: Array.from(affectedFiles),
      risk,
      matchedNodes: targetNodes,
      startNodes: startIds,
    };
  }

  /**
   * 查询类型关系：接口的实现、类的继承
   */
  queryTypeRelations(typeName: string): TypeRelationsResult {
    const targetNodes = this.findNodesByExactName(typeName);
    if (targetNodes.length === 0) {
      return { type: typeName };
    }

    const startNode = targetNodes.find(n => n.exported) || targetNodes[0]!;
    const result: TypeRelationsResult = { type: typeName };

    // 查找实现（如果是接口）
    if (startNode.kind === 'interface') {
      const implEdges = this.inEdges.get(startNode.id) || [];
      result.implementations = implEdges
        .filter(e => e.type === 'implements')
        .map(e => this.graph.nodes[e.from])
        .filter(Boolean) as GraphNode[];
    }

    // 查找子类（如果是类）
    if (startNode.kind === 'class') {
      const extendsEdges = this.inEdges.get(startNode.id) || [];
      result.subclasses = extendsEdges
        .filter(e => e.type === 'extends')
        .map(e => this.graph.nodes[e.from])
        .filter(Boolean) as GraphNode[];
    }

    // 查找父类/父接口
    const superEdges = this.outEdges.get(startNode.id) || [];
    result.superTypes = superEdges
      .filter(e => e.type === 'extends' || e.type === 'implements')
      .map(e => this.graph.nodes[e.to])
      .filter(Boolean) as GraphNode[];

    return result;
  }

  /**
   * 查找孤立节点（没有任何边连接的节点）
   */
  findOrphanNodes(): GraphNode[] {
    const connectedNodes = new Set<string>();
    for (const edge of this.graph.edges) {
      connectedNodes.add(edge.from);
      connectedNodes.add(edge.to);
    }

    const orphans: GraphNode[] = [];
    for (const [id, node] of Object.entries(this.graph.nodes)) {
      if (!connectedNodes.has(id)) {
        orphans.push(node);
      }
    }

    return orphans;
  }

  /**
   * 查找最短路径（两个节点之间）
   */
  findShortestPath(fromName: string, toName: string): string[] | null {
    const fromNodes = this.findNodesByExactName(fromName);
    const toNodes = this.findNodesByExactName(toName);

    if (fromNodes.length === 0 || toNodes.length === 0) {
      return null;
    }

    const startId = (fromNodes.find(n => n.exported) || fromNodes[0]!).id;
    const targetId = (toNodes.find(n => n.exported) || toNodes[0]!).id;

    // BFS 查找最短路径
    const queue: Array<{ nodeId: string; path: string[] }> = [
      { nodeId: startId, path: [startId] },
    ];
    const visited = new Set([startId]);

    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor++]!;

      if (current.nodeId === targetId) {
        return current.path;
      }

      const neighbors = this.getNeighbors(current.nodeId, 'both', ['call', 'implements', 'extends']);
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push({
            nodeId: neighborId,
            path: [...current.path, neighborId],
          });
        }
      }
    }

    return null;
  }

  /**
   * 获取图统计信息
   */
  getStats() {
    return {
      ...this.graph.stats,
      orphanCount: this.findOrphanNodes().length,
    };
  }
}
