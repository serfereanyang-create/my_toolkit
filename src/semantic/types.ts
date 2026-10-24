/**
 * types.ts — 语义索引类型定义
 */

/**
 * 代码片段的语义向量表示
 */
export interface CodeEmbedding {
  /** 唯一标识符，格式: "file.ts::symbolName" */
  id: string;
  /** 符号类型 */
  kind: 'function' | 'class' | 'method' | 'interface';
  /** 源码位置 */
  path: string;
  line: number;
  /** 符号名称 */
  name: string;
  /** 函数签名 */
  signature: string;
  /** 代码摘要（用于展示） */
  summary: string;
  /** 768 维向量 */
  vector: Float32Array;
  /** 文件修改时间（增量更新用） */
  mtime: number;
  /** 文件内容指纹（mtime 不可靠时用于检测变更） */
  fingerprint?: string;
  /** embedding 消耗的 token 数 */
  tokenCount: number;
}

/**
 * 语义搜索结果
 */
export interface SemanticSearchResult {
  /** 查询文本 */
  query: string;
  /** 匹配的代码片段 */
  matches: Array<{
    embedding: CodeEmbedding;
    /** 相似度分数（0-1，越高越相似） */
    similarity: number;
    /** 距离（余弦距离，越小越相似） */
    distance: number;
  }>;
  /** 总命中数 */
  totalCount: number;
}

/**
 * Embedding 提供商配置
 */
export interface EmbeddingProvider {
  /** 提供商名称 */
  name: 'anthropic' | 'openai' | 'local';
  /** API key（如果需要） */
  apiKey?: string;
  /** 兼容端点覆盖（openai 默认 https://api.openai.com/v1） */
  baseUrl?: string;
  /** 模型名称 */
  model: string;
  /** 向量维度 */
  dimensions: number;
  /** 每批最大文本数 */
  batchSize: number;
  /** 不支持 embedding 的 provider 是否明确降级到本地实现 */
  fallback?: 'local' | 'none';
}

/** 用于索引元数据和诊断的 provider 描述。 */
export interface EmbeddingMetadata {
  provider: string;
  model: string;
  dimensions: number;
  fallback?: string;
}

/**
 * Embedding 生成请求
 */
export interface EmbedRequest {
  /** 要 embed 的文本列表 */
  texts: string[];
  /** 元数据（与 texts 数组对应） */
  metadata?: Array<{
    id: string;
    kind: string;
    path: string;
    line: number;
  }>;
}

/**
 * Embedding 生成响应
 */
export interface EmbedResponse {
  /** 生成的向量（与输入 texts 对应） */
  vectors: Float32Array[];
  /** 消耗的 token 数 */
  tokenCount: number;
  /** 模型名称 */
  model: string;
}

/**
 * 语义索引统计
 */
export interface SemanticIndexStats {
  /** 索引的代码片段数 */
  embeddingCount: number;
  /** 索引的文件数 */
  fileCount: number;
  /** 总 token 消耗 */
  totalTokens: number;
  /** 索引大小（MB） */
  sizeInMB: number;
  /** 最后更新时间 */
  lastUpdated: number;
  /** Embedding 提供商 */
  provider: string;
  /** Embedding 模型：换模型等于换向量空间，查询时要跟它对齐 */
  model: string;
  /** 向量维度 */
  dimensions: number;
}
