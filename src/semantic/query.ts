/**
 * query.ts — 语义搜索查询引擎
 *
 * 提供语义相似度搜索、相似代码发现等功能
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CodeEmbedder, createDefaultEmbedder } from './embedder.js';
import { SemanticStore } from './store.js';
import type { SemanticSearchResult, CodeEmbedding } from './types.js';

/**
 * 语义查询引擎
 */
export class SemanticQueryEngine {
  private store: SemanticStore;
  private embedder: CodeEmbedder;
  private workspaceRoot: string;

  constructor(workspaceRoot: string, embedder?: CodeEmbedder) {
    this.workspaceRoot = workspaceRoot;
    this.store = new SemanticStore(workspaceRoot);
    this.embedder = embedder || createDefaultEmbedder();
    const metadata = this.embedder.getMetadata();
    this.store.setMetadata({
      provider: metadata.name,
      model: metadata.model,
      dimensions: metadata.dimensions,
      fallback: metadata.fallback || 'none',
      lastUpdated: Date.now(),
    });
  }

  /**
   * 语义搜索：将查询文本转换为向量，然后搜索相似代码
   */
  async search(
    query: string,
    options: {
      maxResults?: number;
      minSimilarity?: number;
      kind?: 'function' | 'class' | 'method' | 'interface';
      pathPrefix?: string;
    } = {},
  ): Promise<SemanticSearchResult> {
    // 1. 将查询文本转换为向量
    const embedResponse = await this.embedder.embed({
      texts: [query],
    });

    if (embedResponse.vectors.length === 0) {
      return {
        query,
        matches: [],
        totalCount: 0,
      };
    }

    const queryVector = embedResponse.vectors[0]!;

    // 2. 维度一致性守卫：索引用不同 provider/model 构建时，静默返回空结果
    //    会误导调用方，必须明确要求重建。
    const stats = this.store.getStats();
    if (stats.dimensions > 0 && queryVector.length !== stats.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: the index was built with ${stats.dimensions} dims ` +
        `(provider ${stats.provider}) but the current embedder produced ${queryVector.length} dims. ` +
        'Rebuild the index with build_semantic_index.',
      );
    }

    // 3. 向量搜索
    const matches = this.store.search(queryVector, options);

    return {
      query,
      matches,
      totalCount: matches.length,
    };
  }

  /**
   * 查找与给定代码片段相似的其他代码
   */
  async findSimilarCode(
    targetId: string,
    options: {
      maxResults?: number;
      minSimilarity?: number;
      excludeSelf?: boolean;
    } = {},
  ): Promise<SemanticSearchResult['matches']> {
    const { maxResults = 10, minSimilarity = 0.7, excludeSelf = true } = options;

    // 1. 获取目标代码的 embedding
    const targetEmbedding = this.store.getById(targetId);
    if (!targetEmbedding) {
      return [];
    }

    // 2. 向量搜索
    const matches = this.store.search(targetEmbedding.vector, {
      maxResults: maxResults + (excludeSelf ? 1 : 0),
      minSimilarity,
    });

    // 3. 排除自身
    const filtered = excludeSelf
      ? matches.filter(m => m.embedding.id !== targetId)
      : matches;

    return filtered.slice(0, maxResults);
  }

  /**
   * 按文件路径查找相似代码（用于"在这个文件里找相似的函数"）
   */
  async findSimilarInFile(
    targetId: string,
    filePath: string,
    options: {
      maxResults?: number;
      minSimilarity?: number;
    } = {},
  ): Promise<SemanticSearchResult['matches']> {
    const targetEmbedding = this.store.getById(targetId);
    if (!targetEmbedding) {
      return [];
    }

    const matches = this.store.search(targetEmbedding.vector, {
      ...options,
      pathPrefix: filePath,
    });

    return matches.filter(m => m.embedding.id !== targetId);
  }

  /**
   * 批量查找多个代码片段的相似代码（用于去重、重构建议）
   */
  async batchFindSimilar(
    targetIds: string[],
    options: {
      minSimilarity?: number;
    } = {},
  ): Promise<Map<string, SemanticSearchResult['matches']>> {
    const results = new Map<string, SemanticSearchResult['matches']>();

    for (const id of targetIds) {
      const similar = await this.findSimilarCode(id, {
        ...options,
        maxResults: 5,
      });
      results.set(id, similar);
    }

    return results;
  }

  /**
   * 聚类：找出语义相似的代码簇（用于识别重复逻辑）
   */
  async clusterSimilarCode(options: {
    minSimilarity?: number;
    minClusterSize?: number;
  } = {}): Promise<Array<{ representative: CodeEmbedding; similar: CodeEmbedding[] }>> {
    const { minSimilarity = 0.8, minClusterSize = 2 } = options;

    const allEmbeddings = this.store.getAll();
    const visited = new Set<string>();
    const clusters: Array<{ representative: CodeEmbedding; similar: CodeEmbedding[] }> = [];

    for (const embedding of allEmbeddings) {
      if (visited.has(embedding.id)) continue;

      // 查找与当前 embedding 相似的所有代码
      const matches = this.store.search(embedding.vector, {
        maxResults: 100,
        minSimilarity,
      });

      const similarIds = matches
        .filter(m => m.embedding.id !== embedding.id && !visited.has(m.embedding.id))
        .map(m => m.embedding);

      if (similarIds.length >= minClusterSize - 1) {
        // 形成一个簇
        clusters.push({
          representative: embedding,
          similar: similarIds,
        });

        visited.add(embedding.id);
        similarIds.forEach(emb => visited.add(emb.id));
      }
    }

    return clusters;
  }

  /**
   * 获取存储统计
   */
  getStats() {
    return this.store.getStats();
  }

  /** 更新存储的 provider/model metadata。 */
  setMetadata(metadata: Record<string, string | number>): void {
    this.store.setMetadata(metadata);
  }

  /**
   * 关闭存储
   */
  close(): void {
    this.store.close();
  }
}

/**
 * 辅助函数：从代码内容提取摘要（前 3 行非空行）
 */
export function extractCodeSummary(code: string): string {
  const lines = code
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('//') && !line.startsWith('/*'));

  return lines.slice(0, 3).join(' ').slice(0, 200);
}

/**
 * 辅助函数：判断是否应该为这个符号生成 embedding
 */
export function shouldEmbed(options: {
  kind: string;
  exported: boolean;
  name: string;
  bodyLines: number;
}): boolean {
  const { kind, exported, name, bodyLines } = options;

  // 只索引导出的函数/类（减少 70% 体积）
  if (!exported) return false;

  // 排除私有成员（以 _ 开头）
  if (name.startsWith('_')) return false;

  // 排除过短的函数（< 5 行）
  if (bodyLines < 5) return false;

  // 只支持特定类型
  const supportedKinds = ['function', 'class', 'method', 'interface'];
  if (!supportedKinds.includes(kind)) return false;

  return true;
}
