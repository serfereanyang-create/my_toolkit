/**
 * embedder.ts — Embedding 生成器
 *
 * 负责将代码片段转换为语义向量。
 * openai：真实的 /embeddings API 调用（text-embedding-3-* 或任何兼容端点）；
 * anthropic：无 embedding API，诚实报错（不可伪装）；
 * local：显式 opt-in 的特征哈希，仅用于离线/测试，输出中必须注明。
 */

import { fetchWithRetry } from '../providers/protocol.js';
import type { EmbeddingProvider, EmbedRequest, EmbedResponse } from './types.js';

/**
 * Embedding 生成器（支持多个提供商）
 */
export class CodeEmbedder {
  private provider: EmbeddingProvider;
  private fallback: boolean;
  private warnedFallback = false;

  constructor(provider?: Partial<EmbeddingProvider>) {
    const name = provider?.name || (process.env.AICODE_EMBED_PROVIDER as EmbeddingProvider['name'] | undefined) || 'local';
    const defaults: Record<EmbeddingProvider['name'], Pick<EmbeddingProvider, 'model' | 'dimensions' | 'batchSize'>> = {
      local: { model: 'local-hash-v1', dimensions: 768, batchSize: 100 },
      openai: { model: 'text-embedding-3-small', dimensions: 1536, batchSize: 100 },
      anthropic: { model: 'unsupported-anthropic-embedding', dimensions: 768, batchSize: 100 },
    };
    this.provider = { name, ...defaults[name], fallback: 'none', ...provider };
    this.fallback = this.provider.name === 'local' || this.provider.fallback === 'local';

    if ((this.provider.name === 'openai' || this.provider.name === 'anthropic') && !this.provider.apiKey) {
      if (this.provider.fallback === 'local') this.fallback = true;
      else throw new Error(`${this.provider.name.toUpperCase()} embedding provider requires an API key; configure fallback: 'local' to use local embeddings`);
    }
  }

  /** Provider metadata, useful for stores and diagnostics. */
  getMetadata(): EmbeddingProvider {
    return { ...this.provider };
  }

  /**
   * 生成 embeddings
   */
  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    if (request.texts.length === 0) {
      return {
        vectors: [],
        tokenCount: 0,
        model: this.provider.model,
      };
    }

    // 分批处理
    const batches = this.splitIntoBatches(request.texts, this.provider.batchSize);
    const allVectors: Float32Array[] = [];
    let totalTokens = 0;

    for (const batch of batches) {
      const batchResult = await this.embedBatch(batch);
      allVectors.push(...batchResult.vectors);
      totalTokens += batchResult.tokenCount;
    }

    return {
      vectors: allVectors,
      tokenCount: totalTokens,
      model: this.provider.model,
    };
  }

  /**
   * 单批 embedding
   */
  private async embedBatch(texts: string[]): Promise<EmbedResponse> {
    if (this.provider.name === 'openai') {
      if (this.fallback) return this.embedLocally(texts);
      return this.embedWithOpenAI(texts);
    }
    if (this.provider.name === 'local' || this.fallback) {
      return this.embedLocally(texts);
    }

    throw new Error(`${this.provider.name} embedding API is not implemented; no embedding was generated`);
  }

  /**
   * 真实的 OpenAI /embeddings 调用（也适用于任何 OpenAI 兼容端点）。
   * 返回向量按 API 的 index 字段重排，保证与输入顺序一一对应。
   */
  private async embedWithOpenAI(texts: string[]): Promise<EmbedResponse> {
    const base = (this.provider.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await fetchWithRetry(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.provider.apiKey ?? ''}`,
      },
      body: JSON.stringify({ model: this.provider.model, input: texts }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI embeddings request failed: ${response.status} ${detail.slice(0, 200)}`);
    }
    const json = await response.json() as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      usage?: { prompt_tokens?: number };
    };
    const rows = Array.isArray(json.data) ? [...json.data] : [];
    if (rows.length !== texts.length) {
      throw new Error(`OpenAI embeddings returned ${rows.length} vectors for ${texts.length} inputs`);
    }
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors: Float32Array[] = rows.map((row) => {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new Error('OpenAI embeddings response is missing an embedding array');
      }
      return new Float32Array(row.embedding);
    });
    return {
      vectors,
      tokenCount: Number(json.usage?.prompt_tokens ?? 0),
      model: this.provider.model,
    };
  }

  private embedLocally(texts: string[]): EmbedResponse {
    if (!this.warnedFallback && this.provider.name !== 'local') {
      console.warn(`[CodeEmbedder] ${this.provider.name} embedding is unavailable; explicitly using local fallback`);
      this.warnedFallback = true;
    }
    const vectors = texts.map(text => this.fallbackEmbed(text));
    return {
      vectors,
      tokenCount: texts.reduce((sum, text) => sum + this.estimateTokens(text), 0),
      model: 'local-hash-v1',
    };
  }

  /**
   * 旧 API 名保留以尽可能兼容调用方，但不再伪装为 Anthropic API。
   */
  private async embedWithAnthropic(texts: string[]): Promise<EmbedResponse> {
    if (this.fallback) return this.embedLocally(texts);
    throw new Error('Anthropic does not provide an embedding API in this integration');
  }

  /**
   * 降级方案：简单的特征哈希（仅用于开发测试）
   */
  private fallbackEmbed(text: string): Float32Array {
    const dim = this.provider.dimensions;
    const vector = new Float32Array(dim);

    // 简单的字符级哈希
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const index = (charCode * (i + 1)) % dim;
      vector[index] += 1;
    }

    // 归一化
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  /**
   * 估算文本的 token 数
   */
  private estimateTokens(text: string): number {
    // 粗略估算：英文 ~4 字符/token，中文 ~2 字符/token
    return Math.ceil(text.length / 3.5);
  }

  /**
   * 将文本列表分批
   */
  private splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * 为代码片段准备 embedding 输入文本
   */
  static prepareCodeText(options: {
    name: string;
    signature: string;
    path: string;
    body: string;
  }): string {
    const { name, signature, path, body } = options;

    // 截取函数体前 20 行
    const lines = body.split('\n').slice(0, 20);
    const truncatedBody = lines.join('\n');

    return `Function: ${name}
Signature: ${signature}
Context: Located in ${path}
Body:
${truncatedBody}`;
  }

  /**
   * 计算余弦相似度
   */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /**
   * 计算余弦距离（1 - 相似度）
   */
  static cosineDistance(a: Float32Array, b: Float32Array): number {
    return 1 - CodeEmbedder.cosineSimilarity(a, b);
  }
}

/**
 * 创建默认的 embedder
 */
/**
 * 按环境挑选默认 embedder。
 *
 * 顺序是「显式 > 有能力 > 离线」：`AICODE_EMBED_PROVIDER` 说了算；没说但配了
 * `OPENAI_API_KEY` 就走真实 embedding —— 语义检索的价值全在向量质量上，明明有
 * key 却默认拿特征哈希凑，等于把能力挂在那儿不用；两者都没有才退回 local，
 * 且 build 的输出会写明这是词法近似。想强制离线检索就显式
 * `AICODE_EMBED_PROVIDER=local`。
 */
export function createDefaultEmbedder(): CodeEmbedder {
  const providerName = process.env.AICODE_EMBED_PROVIDER as EmbeddingProvider['name'] | undefined;
  const fallback = process.env.AICODE_EMBED_FALLBACK === 'local' ? 'local' : 'none';
  const name = providerName || (process.env.OPENAI_API_KEY ? 'openai' : 'local');
  const apiKey = name === 'openai' ? process.env.OPENAI_API_KEY : name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined;
  const model = process.env.AICODE_EMBED_MODEL;
  const baseUrl = process.env.AICODE_EMBED_BASE_URL;

  return new CodeEmbedder({
    name,
    apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });
}
