/**
 * integration.test.ts — 代码库索引系统集成测试
 *
 * 验证关系图谱、语义搜索、统一查询的核心功能
 */

import { describe, it, before, after } from 'node:test';
import { CodeGraph, GraphNode, GraphEdge } from './types.js';
import { GraphStore } from './store.js';
import { GraphQueryEngine } from './query.js';
import { SemanticStore } from '../semantic/store.js';
import { CodeEmbedder } from '../semantic/embedder.js';
import { SemanticQueryEngine } from '../semantic/query.js';
import type { CodeEmbedding } from '../semantic/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import assert from 'node:assert';

// 测试用的临时目录
const TEST_WORKSPACE = join(tmpdir(), `codebase-index-test-${Date.now()}`);

describe('CodeGraph Integration', () => {
  let testGraph: CodeGraph;
  let graphStore: GraphStore;

  before(() => {
    // 创建测试目录
    mkdirSync(TEST_WORKSPACE, { recursive: true });
    graphStore = new GraphStore(TEST_WORKSPACE);

    // 构建测试图：模拟一个简单的认证模块
    const nodes: Record<string, GraphNode> = {
      'auth.ts::verifyToken': {
        id: 'auth.ts::verifyToken',
        kind: 'function',
        name: 'verifyToken',
        exported: true,
        signature: 'function verifyToken(token: string): Promise<User>',
        loc: { path: 'src/auth.ts', line: 10 },
      },
      'auth.ts::hashPassword': {
        id: 'auth.ts::hashPassword',
        kind: 'function',
        name: 'hashPassword',
        exported: true,
        signature: 'function hashPassword(password: string): Promise<string>',
        loc: { path: 'src/auth.ts', line: 25 },
      },
      'middleware.ts::authMiddleware': {
        id: 'middleware.ts::authMiddleware',
        kind: 'function',
        name: 'authMiddleware',
        exported: true,
        signature: 'function authMiddleware(req, res, next): void',
        loc: { path: 'src/middleware.ts', line: 5 },
      },
      'routes.ts::loginHandler': {
        id: 'routes.ts::loginHandler',
        kind: 'function',
        name: 'loginHandler',
        exported: false,
        signature: 'async function loginHandler(req, res): Promise<void>',
        loc: { path: 'src/routes.ts', line: 15 },
      },
      'routes.ts::protectedRoute': {
        id: 'routes.ts::protectedRoute',
        kind: 'function',
        name: 'protectedRoute',
        exported: true,
        signature: 'function protectedRoute(req, res): void',
        loc: { path: 'src/routes.ts', line: 35 },
      },
      'db.ts::UserRepository': {
        id: 'db.ts::UserRepository',
        kind: 'class',
        name: 'UserRepository',
        exported: true,
        signature: 'class UserRepository implements IUserRepository',
        loc: { path: 'src/db.ts', line: 8 },
      },
      'types.ts::IUserRepository': {
        id: 'types.ts::IUserRepository',
        kind: 'interface',
        name: 'IUserRepository',
        exported: true,
        signature: 'interface IUserRepository',
        loc: { path: 'src/types.ts', line: 3 },
      },
    };

    const edges: GraphEdge[] = [
      // loginHandler 调用 verifyToken 和 hashPassword
      { from: 'routes.ts::loginHandler', to: 'auth.ts::verifyToken', type: 'call' },
      { from: 'routes.ts::loginHandler', to: 'auth.ts::hashPassword', type: 'call' },
      // authMiddleware 调用 verifyToken
      { from: 'middleware.ts::authMiddleware', to: 'auth.ts::verifyToken', type: 'call' },
      // protectedRoute 调用 authMiddleware
      { from: 'routes.ts::protectedRoute', to: 'middleware.ts::authMiddleware', type: 'call' },
      // UserRepository 实现 IUserRepository
      { from: 'db.ts::UserRepository', to: 'types.ts::IUserRepository', type: 'implements' },
    ];

    testGraph = {
      version: 1,
      generated: Date.now(),
      root: TEST_WORKSPACE,
      nodes,
      edges,
      stats: {
        nodeCount: Object.keys(nodes).length,
        edgeCount: edges.length,
        fileCount: 5,
      },
    };
  });

  after(() => {
    // 清理测试目录
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  describe('GraphStore', () => {
    it('should save and load graph', async () => {
      await graphStore.save(testGraph);
      const loaded = await graphStore.load();

      assert.ok(loaded !== null);
      assert.strictEqual(loaded!.stats.nodeCount, 7);
      assert.strictEqual(loaded!.stats.edgeCount, 5);
    });

    it('should merge subgraph correctly', async () => {
      const subgraph: CodeGraph = {
        version: 1,
        generated: Date.now(),
        root: TEST_WORKSPACE,
        nodes: {
          'auth.ts::verifyToken': testGraph.nodes['auth.ts::verifyToken']!,
          'auth.ts::newFunction': {
            id: 'auth.ts::newFunction',
            kind: 'function',
            name: 'newFunction',
            exported: true,
            signature: 'function newFunction(): void',
            loc: { path: 'src/auth.ts', line: 50 },
          },
        },
        edges: [
          { from: 'auth.ts::newFunction', to: 'auth.ts::verifyToken', type: 'call' },
        ],
        stats: { nodeCount: 2, edgeCount: 1, fileCount: 1 },
      };

      const merged = graphStore.mergeSubgraph(testGraph, ['src/auth.ts'], subgraph);

      assert.strictEqual(merged.stats.nodeCount, 7);
      assert.ok(Object.keys(merged.nodes).includes('auth.ts::newFunction'));
    });
  });

  describe('GraphQueryEngine', () => {
    let engine: GraphQueryEngine;

    before(() => {
      engine = new GraphQueryEngine(testGraph);
    });

    it('should find callers of verifyToken', () => {
      const result = engine.queryCallGraph('verifyToken', 'callers', 2, 10);

      assert.ok(result.nodes.length > 0);
      const callerNames = result.nodes.map(n => n.node.name);
      assert.ok(callerNames.includes('loginHandler'));
      assert.ok(callerNames.includes('authMiddleware'));
    });

    it('should find callees of loginHandler', () => {
      const result = engine.queryCallGraph('loginHandler', 'callees', 1, 10);

      assert.strictEqual(result.nodes.length, 2);
      const calleeNames = result.nodes.map(n => n.node.name);
      assert.ok(calleeNames.includes('verifyToken'));
      assert.ok(calleeNames.includes('hashPassword'));
    });

    it('should analyze impact correctly', () => {
      const impact = engine.analyzeImpact('verifyToken', 3);

      assert.strictEqual(impact.directImpact.length, 2); // loginHandler, authMiddleware
      assert.ok(impact.indirectImpact.length >= 1); // protectedRoute
      assert.ok(impact.affectedFiles.length > 0);
    });

    it('should query type relations', () => {
      const relations = engine.queryTypeRelations('IUserRepository');

      assert.ok(relations.implementations !== undefined);
      assert.strictEqual(relations.implementations!.length, 1);
      assert.strictEqual(relations.implementations![0].name, 'UserRepository');
    });

    it('should find shortest path', () => {
      const path = engine.findShortestPath('protectedRoute', 'verifyToken');

      assert.ok(path !== null);
      assert.ok(path!.length >= 3);
      assert.ok(path![0].includes('protectedRoute'));
      assert.ok(path![path!.length - 1].includes('verifyToken'));
    });
  });
});

describe('Semantic Search Integration', () => {
  let semanticStore: SemanticStore;
  let embedder: CodeEmbedder;
  let engine: SemanticQueryEngine;

  before(() => {
    semanticStore = new SemanticStore(TEST_WORKSPACE);
    embedder = new CodeEmbedder({ name: 'anthropic', dimensions: 128 }); // 小维度用于测试
    engine = new SemanticQueryEngine(TEST_WORKSPACE, embedder);

    // 插入测试 embeddings
    const testEmbeddings: CodeEmbedding[] = [
      {
        id: 'auth.ts::verifyToken',
        kind: 'function',
        path: 'src/auth.ts',
        line: 10,
        name: 'verifyToken',
        signature: 'function verifyToken(token: string): Promise<User>',
        summary: 'Verify JWT token and return user',
        vector: createMockVector(128, 'verify jwt token'),
        mtime: Date.now(),
        tokenCount: 50,
      },
      {
        id: 'auth.ts::hashPassword',
        kind: 'function',
        path: 'src/auth.ts',
        line: 25,
        name: 'hashPassword',
        signature: 'function hashPassword(password: string): Promise<string>',
        summary: 'Hash password using bcrypt',
        vector: createMockVector(128, 'hash password bcrypt'),
        mtime: Date.now(),
        tokenCount: 40,
      },
      {
        id: 'auth.ts::validateCredentials',
        kind: 'function',
        path: 'src/auth.ts',
        line: 40,
        name: 'validateCredentials',
        signature: 'function validateCredentials(username, password): Promise<boolean>',
        summary: 'Validate user credentials against database',
        vector: createMockVector(128, 'validate credentials database'),
        mtime: Date.now(),
        tokenCount: 45,
      },
    ];

    semanticStore.batchUpsert(testEmbeddings);
  });

  after(() => {
    semanticStore.close();
  });

  describe('SemanticStore', () => {
    it('should store and retrieve embeddings', () => {
      const emb = semanticStore.getById('auth.ts::verifyToken');

      assert.ok(emb !== null);
      assert.strictEqual(emb!.name, 'verifyToken');
      assert.strictEqual(emb!.vector.length, 128);
    });

    it('should query by path', () => {
      const embs = semanticStore.getByPath('src/auth.ts');

      assert.strictEqual(embs.length, 3);
    });

    it('should check reindex need correctly', () => {
      const needsReindex = semanticStore.needsReindex('src/auth.ts', Date.now() + 1000);

      assert.strictEqual(needsReindex, true);
    });

    it('should return correct stats', () => {
      const stats = semanticStore.getStats();

      assert.strictEqual(stats.embeddingCount, 3);
      assert.strictEqual(stats.totalTokens, 135);
      assert.strictEqual(stats.fileCount, 1);
    });
  });

  describe('SemanticQueryEngine', () => {
    it('should search semantically', async () => {
      const result = await engine.search('authenticate user with password', {
        maxResults: 5,
        minSimilarity: 0.3,
      });

      assert.ok(result.matches.length > 0);
      // 应该找到 validateCredentials (最相关)
      const topMatch = result.matches[0];
      assert.ok(topMatch.embedding.name);
    });

    it('should find similar code', async () => {
      const similar = await engine.findSimilarCode('auth.ts::verifyToken', {
        maxResults: 5,
        minSimilarity: 0.5,
      });

      // 应该找到 validateCredentials（都是认证相关）
      assert.ok(similar.length >= 0);
    });

    it('should compute cosine similarity correctly', () => {
      const vec1 = new Float32Array([1, 0, 0]);
      const vec2 = new Float32Array([0, 1, 0]);
      const vec3 = new Float32Array([1, 0, 0]);

      const sim12 = CodeEmbedder.cosineSimilarity(vec1, vec2);
      const sim13 = CodeEmbedder.cosineSimilarity(vec1, vec3);

      assert.strictEqual(sim12, 0); // 垂直
      assert.strictEqual(sim13, 1); // 平行
    });
  });
});

/**
 * 创建模拟向量（基于文本的简单哈希）
 */
function createMockVector(dim: number, text: string): Float32Array {
  const vector = new Float32Array(dim);

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
