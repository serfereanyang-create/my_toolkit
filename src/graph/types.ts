/**
 * types.ts — 代码关系图谱类型定义
 */

export type NodeKind = 'function' | 'class' | 'interface' | 'type' | 'method' | 'const';
export type EdgeType = 'call' | 'implements' | 'extends' | 'imports' | 'exports';

/**
 * 图节点 - 代表代码中的一个符号（函数/类/接口等）
 */
export interface GraphNode {
  /** 唯一标识符，格式: "file.ts::symbolName" */
  id: string;
  /** 符号类型 */
  kind: NodeKind;
  /** 符号名称 */
  name: string;
  /** 是否导出 */
  exported: boolean;
  /** 函数签名或类型声明 */
  signature: string;
  /** 源码位置 */
  loc: {
    path: string;
    line: number;
    column?: number;
  };
  /** 所属容器（方法所属的类名） */
  container?: string;
}

/**
 * 图边 - 代表符号之间的关系
 */
export interface GraphEdge {
  /** 起点节点 ID */
  from: string;
  /** 终点节点 ID */
  to: string;
  /** 关系类型 */
  type: EdgeType;
  /** 关系发生的位置（用于调试） */
  loc?: {
    path: string;
    line: number;
  };
}

/**
 * 完整的代码关系图
 */
export interface CodeGraph {
  /** 图版本（用于缓存失效） */
  version: number;
  /** 生成时间戳 */
  generated: number;
  /** 项目根目录 */
  root: string;
  /** 所有节点，key 为节点 ID */
  nodes: Record<string, GraphNode>;
  /** 所有边 */
  edges: GraphEdge[];
  /** 统计信息 */
  stats: {
    nodeCount: number;
    edgeCount: number;
    fileCount: number;
  };
  /** 构建时纳入图的源文件（相对于 root） */
  sourceFiles?: string[];
  /** 源文件快照指纹，由 GraphStore 保存时生成 */
  fingerprint?: string;
}

/**
 * 图查询结果 - BFS/DFS 遍历的结果
 */
export interface GraphQueryResult {
  /** 查询的起始节点 */
  target: string;
  /** 查询方向 */
  direction: 'callers' | 'callees' | 'both';
  /** 匹配的节点列表 */
  nodes: Array<{
    node: GraphNode;
    /** 距离起始节点的距离 */
    distance: number;
    /** 从起始节点到该节点的路径（节点 ID 列表） */
    path: string[];
  }>;
  /** 总命中数（可能被 maxResults 截断） */
  totalCount: number;
  /** true 表示命中数达到 maxResults 上限，可能还有更多未列出的节点 */
  truncated?: boolean;
}

/**
 * 影响范围分析结果
 */
export interface ImpactAnalysisResult {
  /** 被分析的符号 */
  symbol: string;
  /** 直接影响的符号（调用者） */
  directImpact: GraphNode[];
  /** 间接影响的符号（调用者的调用者） */
  indirectImpact: GraphNode[];
  /** 影响的文件列表 */
  affectedFiles: string[];
  /** 风险等级 */
  risk: 'low' | 'moderate' | 'high' | 'critical';
}

/**
 * 类型关系查询结果
 */
export interface TypeRelationsResult {
  /** 被查询的类型 */
  type: string;
  /** 实现该接口的类 */
  implementations?: GraphNode[];
  /** 继承该类的子类 */
  subclasses?: GraphNode[];
  /** 父类/父接口 */
  superTypes?: GraphNode[];
}
