/**
 * tools/codebase.ts — 统一代码库搜索工具
 *
 * 智能级联查询：符号搜索 → 关系图扩展 → 语义排序
 */

import { NavIndexStore } from '../nav/store.js';
import { findSymbols } from '../nav/query.js';
import { GraphStore } from '../graph/store.js';
import { GraphQueryEngine } from '../graph/query.js';
import { SemanticQueryEngine } from '../semantic/query.js';
import { createDefaultEmbedder } from '../semantic/embedder.js';
import type { ToolDefinition } from './types.js';

/**
 * 统一代码库搜索工具
 */
export const codebaseSearchTool: ToolDefinition<{
  query: string;
  mode: 'auto' | 'symbol' | 'graph' | 'semantic' | 'cascade';
  maxResults: number;
}> = {
  name: 'codebase_search',
  description: '智能代码库搜索，自动选择最优索引策略（符号/关系图/语义）或级联查询',
  inputHint: '{ "query": "authentication flow", "mode": "auto", "maxResults": 20 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.query !== 'string' || !record.query.trim()) {
      throw new Error('query is required');
    }

    const mode = record.mode as string;
    if (mode && !['auto', 'symbol', 'graph', 'semantic', 'cascade'].includes(mode)) {
      throw new Error('mode must be "auto", "symbol", "graph", "semantic", or "cascade"');
    }

    return {
      query: record.query.trim(),
      mode: (mode || 'auto') as any,
      maxResults: typeof record.maxResults === 'number' ? Math.min(Math.floor(record.maxResults), 50) : 20,
    };
  },

  async execute(input, context) {
    const { query, mode, maxResults } = input;

    try {
      // Auto 模式：智能路由
      if (mode === 'auto') {
        const selectedMode = selectSearchMode(query);
        return await executeSearch(selectedMode, query, maxResults, context.workspaceRoot);
      }

      // Cascade 模式：三层级联
      if (mode === 'cascade') {
        return await cascadeSearch(query, maxResults, context.workspaceRoot);
      }

      // 单层模式
      return await executeSearch(mode, query, maxResults, context.workspaceRoot);
    } catch (error: any) {
      return {
        ok: false,
        output: `Codebase search failed: ${error.message}`,
        data: { error: error.message },
      };
    }
  },
};

/**
 * 智能选择搜索模式
 */
function selectSearchMode(query: string): 'symbol' | 'graph' | 'semantic' {
  const lowerQuery = query.toLowerCase();

  // 符号查询特征：单个标识符、驼峰命名
  if (/^[a-z_][a-z0-9_]*$/i.test(query) || /^[A-Z][a-zA-Z0-9]+$/.test(query)) {
    return 'symbol';
  }

  // 关系查询特征：包含 "caller", "callee", "implement", "extend" 等关键词
  if (/\b(caller|callee|call|implement|extend|inherit|use|depend)\b/i.test(lowerQuery)) {
    return 'graph';
  }

  // 语义查询特征：自然语言描述、短语
  if (query.split(' ').length > 2) {
    return 'semantic';
  }

  // 默认使用符号搜索（速度快）
  return 'symbol';
}

/**
 * 执行单层搜索
 */
async function executeSearch(
  mode: 'symbol' | 'graph' | 'semantic',
  query: string,
  maxResults: number,
  workspaceRoot: string,
) {
  if (mode === 'symbol') {
    return await symbolSearch(query, maxResults, workspaceRoot);
  }

  if (mode === 'graph') {
    return await graphSearch(query, maxResults, workspaceRoot);
  }

  if (mode === 'semantic') {
    return await semanticOnlySearch(query, maxResults, workspaceRoot);
  }

  throw new Error(`Unknown mode: ${mode}`);
}

/**
 * 符号搜索（Layer 1）
 */
async function symbolSearch(query: string, maxResults: number, workspaceRoot: string) {
  const navStore = new NavIndexStore(workspaceRoot);
  const index = await navStore.loadOrBuild();
  const hits = findSymbols(index, query, { maxResults });

  if (hits.length === 0) {
    return {
      ok: true,
      output: `No symbols matched "${query}"`,
      data: { layer: 'symbol', hits: [] },
    };
  }

  const output = hits.map((hit, i) => {
    const exp = hit.exported ? 'export ' : '';
    return `${i + 1}. ${hit.path}:${hit.line} [${exp}${hit.kind}] ${hit.name} (score=${hit.score.toFixed(1)})`;
  }).join('\n');

  return {
    ok: true,
    output: `Found ${hits.length} symbols (BM25 search):\n\n${output}`,
    data: { layer: 'symbol', hits },
  };
}

/**
 * 关系图搜索（Layer 2）
 */
async function graphSearch(query: string, maxResults: number, workspaceRoot: string) {
  const graphStore = new GraphStore(workspaceRoot);
  const graph = await graphStore.load();

  if (!graph) {
    return {
      ok: false,
      output: 'Code graph not built yet. Run query_call_graph tool instead.',
      data: { error: 'graph_not_found' },
    };
  }

  const engine = new GraphQueryEngine(graph);

  // 尝试提取目标符号（简单启发式）
  const match = query.match(/\b([a-z_][a-z0-9_]*)\b/i);
  const target = match ? match[1] : query;

  const result = engine.queryCallGraph(target, 'both', 2, maxResults);

  if (result.nodes.length === 0) {
    return {
      ok: true,
      output: `No call graph results for "${query}"`,
      data: { layer: 'graph', result },
    };
  }

  const output = result.nodes.slice(0, 10).map((item, i) => {
    const { node, distance } = item;
    return `${i + 1}. [dist=${distance}] ${node.loc.path}:${node.loc.line} ${node.kind} ${node.name}`;
  }).join('\n');

  return {
    ok: true,
    output: `Found ${result.totalCount} nodes in call graph:\n\n${output}`,
    data: { layer: 'graph', result },
  };
}

/**
 * 语义搜索（Layer 3）
 */
async function semanticOnlySearch(query: string, maxResults: number, workspaceRoot: string) {
  const embedder = createDefaultEmbedder();
  const engine = new SemanticQueryEngine(workspaceRoot, embedder);

  const result = await engine.search(query, { maxResults, minSimilarity: 0.5 });
  engine.close();

  if (result.matches.length === 0) {
    return {
      ok: true,
      output: `No semantic matches for "${query}"`,
      data: { layer: 'semantic', result },
    };
  }

  const output = result.matches.slice(0, 10).map((match, i) => {
    const { embedding, similarity } = match;
    return `${i + 1}. [sim=${similarity.toFixed(3)}] ${embedding.path}:${embedding.line} ${embedding.kind} ${embedding.name}`;
  }).join('\n');

  return {
    ok: true,
    output: `Found ${result.totalCount} semantic matches:\n\n${output}`,
    data: { layer: 'semantic', result },
  };
}

/**
 * 级联搜索：Layer 1 → Layer 2 → Layer 3
 */
async function cascadeSearch(query: string, maxResults: number, workspaceRoot: string) {
  const results = {
    layer1: [] as any[],
    layer2: [] as any[],
    layer3: [] as any[],
  };

  // Layer 1: 符号搜索
  try {
    const navStore = new NavIndexStore(workspaceRoot);
    const index = await navStore.loadOrBuild();
    results.layer1 = findSymbols(index, query, { maxResults: 50 });
  } catch (error) {
    console.warn('[Cascade] Layer 1 failed:', error);
  }

  // Layer 2: 图谱扩展（基于 Layer 1 结果）
  try {
    const graphStore = new GraphStore(workspaceRoot);
    const graph = await graphStore.load();

    if (graph && results.layer1.length > 0) {
      const engine = new GraphQueryEngine(graph);
      const expanded = new Set<string>();

      // 对前 5 个符号搜索结果进行调用图扩展
      for (const hit of results.layer1.slice(0, 5)) {
        const callees = engine.queryCallGraph(hit.name, 'callees', 1, 10);
        callees.nodes.forEach(n => expanded.add(JSON.stringify(n.node)));
      }

      results.layer2 = Array.from(expanded).map(s => JSON.parse(s));
    }
  } catch (error) {
    console.warn('[Cascade] Layer 2 failed:', error);
  }

  // Layer 3: 语义重排
  try {
    const embedder = createDefaultEmbedder();
    const engine = new SemanticQueryEngine(workspaceRoot, embedder);
    const semanticResult = await engine.search(query, { maxResults, minSimilarity: 0.4 });
    results.layer3 = semanticResult.matches.map(m => m.embedding);
    engine.close();
  } catch (error) {
    console.warn('[Cascade] Layer 3 failed:', error);
  }

  // 合并去重
  const combined = new Map<string, any>();

  for (const item of results.layer1) {
    combined.set(`${item.path}:${item.line}:${item.name}`, { ...item, source: 'symbol' });
  }

  for (const item of results.layer2) {
    const key = `${item.loc.path}:${item.loc.line}:${item.name}`;
    if (!combined.has(key)) {
      combined.set(key, { ...item, source: 'graph' });
    }
  }

  for (const item of results.layer3) {
    const key = `${item.path}:${item.line}:${item.name}`;
    if (!combined.has(key)) {
      combined.set(key, { ...item, source: 'semantic' });
    } else {
      // 标记为多层命中
      const existing = combined.get(key)!;
      existing.multiLayer = true;
    }
  }

  const finalResults = Array.from(combined.values()).slice(0, maxResults);

  if (finalResults.length === 0) {
    return {
      ok: true,
      output: `No results found for "${query}" (searched across all layers)`,
      data: { results: { layer1: [], layer2: [], layer3: [], combined: [] } },
    };
  }

  const output = finalResults.map((item, i) => {
    const path = item.path || item.loc?.path;
    const line = item.line || item.loc?.line;
    const name = item.name;
    const source = item.source;
    const multi = item.multiLayer ? ' ⭐' : '';

    return `${i + 1}. [${source}${multi}] ${path}:${line} ${name}`;
  }).join('\n');

  return {
    ok: true,
    output: `Cascade search results (${finalResults.length} total):\n\n${output}\n\n⭐ = Found in multiple layers`,
    data: {
      results: {
        layer1: results.layer1.slice(0, 5),
        layer2: results.layer2.slice(0, 5),
        layer3: results.layer3.slice(0, 5),
        combined: finalResults,
      },
    },
  };
}
