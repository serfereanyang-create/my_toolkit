/**
 * query.ts — 语义搜索查询引擎
 *
 * 提供语义相似度搜索、相似代码发现等功能
 */

import { readFile, stat } from 'node:fs/promises';
import { CodeEmbedder, createDefaultEmbedder } from './embedder.js';
import { SemanticStore } from './store.js';
import type { SemanticSearchResult, CodeEmbedding } from './types.js';

/**
 * 语义查询引擎
 */
export class SemanticQueryEngine {
  private store: SemanticStore;
  private embedder: CodeEmbedder;

  constructor(workspaceRoot: string, embedder?: CodeEmbedder) {
    this.store = new SemanticStore(workspaceRoot);
    this.embedder = embedder || createDefaultEmbedder();
    // 这里**不能**回写元数据。索引的 provider/model/维度是「建库那一刻」的事实，
    // 查询方一写就把别人的事实改成了自己的，之后所有不一致都查不出来——守卫
    // 比的是自己刚写进去的数字，等于永远通过。读到的才算证据。
  }

  /**
   * 索引与当前 embedder 必须是同一个向量空间，否则相似度是没有意义的数。
   *
   * 两种不一致都要响亮地失败：维度不同（local 768 vs openai 1536）会直接算错，
   * 维度相同但模型不同（text-embedding-3-small vs 3-large）会静默给出看似合理的
   * 乱七八糟排名——后者比前者更危险。
   *
   * 先按声明比对再发请求：一次 embedding 调用是要花钱的，发现空间不对就该在
   * 花钱之前失败。拿到向量之后再按实际长度复核一遍，防的是 provider 谎报维度。
   */
  private assertEmbedderMatchesIndex(): void {
    const stats = this.store.getStats();
    if (stats.embeddingCount === 0) return;
    const meta = this.embedder.getMetadata();
    if (stats.dimensions > 0 && meta.dimensions !== stats.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: the index holds ${stats.dimensions} dims ` +
        `(built with ${stats.provider}/${stats.model}) but the current embedder is ` +
        `${meta.name}/${meta.model} at ${meta.dimensions} dims. Rebuild the index with ` +
        'build_semantic_index (force: true).',
      );
    }
    if (stats.provider !== 'unknown' && (stats.provider !== meta.name || stats.model !== meta.model)) {
      throw new Error(
        `Embedding model mismatch: the index was built with ${stats.provider}/${stats.model} but the ` +
        `current embedder is ${meta.name}/${meta.model}. Same-dimension vectors from different models ` +
        'are not comparable, so results would be nonsense. Rebuild with build_semantic_index (force: true).',
      );
    }
  }

  /** 向量到手后的复核：provider 可能声明 1536 维却返回别的长度。 */
  private assertVectorFitsIndex(queryVector: Float32Array): void {
    const stats = this.store.getStats();
    if (stats.embeddingCount === 0 || stats.dimensions === 0) return;
    if (queryVector.length !== stats.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: the index holds ${stats.dimensions} dims ` +
        `(built with ${stats.provider}/${stats.model}) but the current embedder produced ` +
        `${queryVector.length} dims. Rebuild the index with build_semantic_index (force: true).`,
      );
    }
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
    // 1. 先确认索引和当前 embedder 是同一个空间：不对就别花这次 embedding 的钱
    this.assertEmbedderMatchesIndex();

    // 2. 将查询文本转换为向量
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

    // 3. 拿到向量后按实际长度复核
    this.assertVectorFitsIndex(queryVector);

    // 4. 向量搜索
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
