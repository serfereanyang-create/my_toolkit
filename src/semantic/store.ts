/**
 * store.ts — 语义向量存储（基于 SQLite）
 *
 * 使用纯 JavaScript 实现向量搜索，避免 native 模块依赖
 */

// better-sqlite3 必须是 13.x 及以上：11.x 的预编译二进制在 Node 24 上，只要
// 「写库 + 同进程再做一批 AST 分配」就会在 GC 阶段原生崩溃（断言
// node::RemoveEnvironmentCleanupHook env != nullptr，进程直接死，不是异常）。
// `tests/semantic-space.test.ts` 里「同一进程连续建两次索引」那条用例就是它的
// 回归哨兵——升级前它是必崩的。
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { CodeEmbedding, SemanticSearchResult, SemanticIndexStats } from './types.js';
import { CodeEmbedder } from './embedder.js';

const CACHE_DIR = '.aicode/semantic';
const DB_FILE = 'vectors.db';
const MAX_EMBEDDINGS = 100_000;
const MAX_VECTOR_DIMENSIONS = 4096;
const METADATA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS semantic_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/**
 * 向量存储（SQLite + 纯 JS 向量搜索）
 */
export class SemanticStore {
  private db: Database.Database;
  private workspaceRoot: string;
  private dbPath: string;
  private readonly maxEmbeddings = MAX_EMBEDDINGS;
  private readonly maxVectorDimensions = MAX_VECTOR_DIMENSIONS;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.dbPath = resolve(this.workspaceRoot, CACHE_DIR, DB_FILE);
    this.db = this.initDatabase();
  }

  /** 初始化/迁移数据库结构 */
  private initDatabase(): Database.Database {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');

    // 创建表
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_embeddings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        name TEXT NOT NULL,
        signature TEXT NOT NULL,
        summary TEXT NOT NULL,
        vector BLOB NOT NULL,
        mtime INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        fingerprint TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_path ON code_embeddings(path);
      CREATE INDEX IF NOT EXISTS idx_name ON code_embeddings(name);
      CREATE INDEX IF NOT EXISTS idx_mtime ON code_embeddings(mtime);
    `);
    db.exec(METADATA_SCHEMA);
    return db;
  }

  /** 校验向量和规模，拒绝不可控的索引输入。 */
  private validateEmbedding(embedding: CodeEmbedding): void {
    if (embedding.vector.length === 0 || embedding.vector.length > this.maxVectorDimensions) {
      throw new Error(`Embedding dimensions must be between 1 and ${this.maxVectorDimensions}`);
    }
    const count = (this.db.prepare('SELECT COUNT(*) as count FROM code_embeddings').get() as { count: number }).count;
    if (count >= this.maxEmbeddings && !this.getById(embedding.id)) {
      throw new Error(`Semantic index limit reached (${MAX_EMBEDDINGS} embeddings)`);
    }
    for (const value of embedding.vector) {
      if (!Number.isFinite(value)) throw new Error('Embedding vector contains a non-finite value');
    }
  }

  private vectorBuffer(vector: Float32Array): Buffer {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  }

  /** 插入或更新 embedding */
  upsert(embedding: CodeEmbedding): void {
    this.validateEmbedding(embedding);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO code_embeddings
      (id, kind, path, line, name, signature, summary, vector, mtime, token_count, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      embedding.id,
      embedding.kind,
      embedding.path,
      embedding.line,
      embedding.name,
      embedding.signature,
      embedding.summary,
      this.vectorBuffer(embedding.vector),
      embedding.mtime,
      embedding.tokenCount,
      embedding.fingerprint || null,
      Date.now(),
    );
  }

  /** 批量插入 */
  batchUpsert(embeddings: CodeEmbedding[]): void {
    if (embeddings.length > this.maxEmbeddings) throw new Error(`Batch exceeds ${this.maxEmbeddings} embeddings`);
    for (const embedding of embeddings) this.validateEmbedding(embedding);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO code_embeddings
      (id, kind, path, line, name, signature, summary, vector, mtime, token_count, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((embeddings: CodeEmbedding[]) => {
      for (const emb of embeddings) {
        stmt.run(
          emb.id,
          emb.kind,
          emb.path,
          emb.line,
          emb.name,
          emb.signature,
          emb.summary,
          this.vectorBuffer(emb.vector),
          emb.mtime,
          emb.tokenCount,
          Date.now(),
        );
      }
    });

    transaction(embeddings);
  }

  /** 根据 ID 查询 */
  getById(id: string): CodeEmbedding | null {
    const row = this.db.prepare('SELECT * FROM code_embeddings WHERE id = ?').get(id) as any;
    return row ? this.rowToEmbedding(row) : null;
  }

  /** 根据文件路径查询 */
  getByPath(path: string): CodeEmbedding[] {
    const rows = this.db.prepare('SELECT * FROM code_embeddings WHERE path = ?').all(path) as any[];
    return rows.map(row => this.rowToEmbedding(row));
  }

  /**
   * 删除指定文件的所有 embeddings
   */
  deleteByPath(path: string): void {
    this.db.prepare('DELETE FROM code_embeddings WHERE path = ?').run(path);
  }

  /**
   * 删除指定 ID
   */
  deleteById(id: string): void {
    this.db.prepare('DELETE FROM code_embeddings WHERE id = ?').run(id);
  }

  /**
   * 语义搜索（暴力搜索，适合中小型项目）
   */
  search(
    queryVector: Float32Array,
    options: {
      maxResults?: number;
      minSimilarity?: number;
      kind?: string;
      pathPrefix?: string;
    } = {},
  ): SemanticSearchResult['matches'] {
    if (queryVector.length === 0 || queryVector.length > MAX_VECTOR_DIMENSIONS) {
      throw new Error(`Query vector dimensions must be between 1 and ${MAX_VECTOR_DIMENSIONS}`);
    }
    if (queryVector.some((value) => !Number.isFinite(value))) throw new Error('Query vector contains a non-finite value');
    const { maxResults = 20, minSimilarity = 0.5, kind, pathPrefix } = options;

    // 构建查询条件
    let sql = 'SELECT * FROM code_embeddings';
    const conditions: string[] = [];
    const params: any[] = [];

    if (kind) {
      conditions.push('kind = ?');
      params.push(kind);
    }

    if (pathPrefix) {
      conditions.push('path LIKE ?');
      params.push(`${pathPrefix}%`);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const rows = this.db.prepare(sql).all(...params) as any[];

    // 计算相似度
    const results: SemanticSearchResult['matches'] = [];

    for (const row of rows) {
      const embedding = this.rowToEmbedding(row);
      if (queryVector.length !== embedding.vector.length) continue;
      const similarity = CodeEmbedder.cosineSimilarity(queryVector, embedding.vector);

      if (similarity >= minSimilarity) {
        results.push({
          embedding,
          similarity,
          distance: 1 - similarity,
        });
      }
    }

    // 按相似度降序排序
    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, maxResults);
  }

  /**
   * 获取所有 embeddings（用于增量更新检查）
   */
  getAll(): CodeEmbedding[] {
    const rows = this.db.prepare('SELECT * FROM code_embeddings').all() as any[];
    return rows.map(row => this.rowToEmbedding(row));
  }

  /** 更新索引元数据，供统计和兼容性检查使用。 */
  setMetadata(metadata: Record<string, string | number>): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO semantic_metadata(key, value) VALUES (?, ?)');
    const transaction = this.db.transaction(() => {
      for (const [key, value] of Object.entries(metadata)) stmt.run(key, String(value));
    });
    transaction();
  }

  getMetadata(key?: string): string | Record<string, string> | null {
    if (key) {
      const row = this.db.prepare('SELECT value FROM semantic_metadata WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value || null;
    }
    const rows = this.db.prepare('SELECT key, value FROM semantic_metadata').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  /** 获取统计信息 */
  getStats(): SemanticIndexStats {
    const countRow = this.db.prepare('SELECT COUNT(*) as count, SUM(token_count) as tokens FROM code_embeddings').get() as any;
    const filesRow = this.db.prepare('SELECT COUNT(DISTINCT path) as files FROM code_embeddings').get() as any;

    // 估算数据库大小
    const stats = this.db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as any;
    const sizeInBytes = stats?.size || 0;

    return {
      embeddingCount: countRow.count || 0,
      fileCount: filesRow.files || 0,
      totalTokens: countRow.tokens || 0,
      sizeInMB: Math.round((sizeInBytes / 1024 / 1024) * 100) / 100,
      lastUpdated: Number(this.getMetadata('lastUpdated') || 0) || 0,
      provider: String(this.getMetadata('provider') || 'unknown'),
      model: String(this.getMetadata('model') || 'unknown'),
      dimensions: Number(this.getMetadata('dimensions') || this.getAll()[0]?.vector.length || 0),
    };
  }

  async initialize(): Promise<void> {
    if (this.db.open) return;
    this.db = this.initDatabase();
  }

  /** 用元数据标记当前索引。 */
  markUpdated(): void {
    this.setMetadata({ lastUpdated: Date.now() });
  }

  /** 清空所有数据 */
  clear(): void {
    if (!this.db.open) return;
    this.db.prepare('DELETE FROM code_embeddings').run();
  }

  /** 安全关闭（允许重复调用）。 */
  close(): void {
    if (this.db.open) this.db.close();
  }

  /** 数据库行转 CodeEmbedding 对象 */
  private rowToEmbedding(row: any): CodeEmbedding {
    const vectorBuffer = row.vector as Buffer;
    const vector = new Float32Array(
      vectorBuffer.buffer,
      vectorBuffer.byteOffset,
      vectorBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );

    return {
      id: row.id,
      kind: row.kind,
      path: row.path,
      line: row.line,
      name: row.name,
      signature: row.signature,
      summary: row.summary,
      vector,
      mtime: row.mtime,
      fingerprint: row.fingerprint || undefined,
      tokenCount: row.token_count,
    };
  }

  /** 检查文件是否需要重新索引 */
  needsReindex(path: string, currentMtime: number, fingerprint?: string): boolean {
    const embeddings = this.getByPath(path);
    if (embeddings.length === 0) return true;
    return embeddings.some((emb) => emb.mtime !== currentMtime || (fingerprint !== undefined && emb.fingerprint !== fingerprint));
  }
}
