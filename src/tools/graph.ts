/**
 * tools/graph.ts — 代码关系图谱查询工具
 */

import { GraphStore } from '../graph/store.js';
import { GraphBuilder } from '../graph/builder.js';
import { GraphQueryEngine } from '../graph/query.js';
import type { ToolDefinition } from './types.js';

/**
 * 构建代码关系图谱工具
 *
 * 查询工具（query_call_graph 等）依赖 .aicode/graph 缓存；这里提供真正的
 * 构建入口。GraphStore.load() 在源码指纹变化时返回 null，因此存在且可加载
 * 的缓存即代表"与当前源码一致"，无需重建。
 */
export const buildCodeGraphTool: ToolDefinition<{
  maxFiles: number;
}> = {
  name: 'build_code_graph',
  description: '构建/刷新代码关系图谱缓存（函数调用、类继承、接口实现关系）',
  inputHint: '{ "maxFiles": 500 }',
  risk: 'read',

  validate(input) {
    if (input === undefined || input === null) return { maxFiles: 500 };
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0
        ? Math.min(Math.floor(record.maxFiles), 2000)
        : 500,
    };
  },

  async execute(input, context) {
    const store = new GraphStore(context.workspaceRoot);

    // 指纹一致 → 缓存就是最新的，直接复用（重建纯属浪费）。
    const existing = await store.load();
    if (existing) {
      return {
        ok: true,
        output: `Code graph is up to date: ${existing.stats.nodeCount} nodes, ${existing.stats.edgeCount} edges across ${existing.stats.fileCount} files.`,
        data: { reused: true, stats: existing.stats },
      };
    }

    const started = Date.now();
    const builder = new GraphBuilder(context.workspaceRoot);
    const graph = await builder.build({ maxFiles: input.maxFiles });
    if (graph.stats.nodeCount === 0) {
      return {
        ok: false,
        output: 'Graph build found no TypeScript/JavaScript symbols. Is this a source workspace?',
        data: { error: 'empty_graph' },
      };
    }
    await store.save(graph);
    const durationMs = Date.now() - started;
    const truncated = (graph.sourceFiles?.length ?? 0) >= input.maxFiles;

    const lines = [
      `Code graph built in ${durationMs}ms: ${graph.stats.nodeCount} nodes, ${graph.stats.edgeCount} edges across ${graph.stats.fileCount} files.`,
    ];
    if (truncated) {
      lines.push(`Note: file scan hit the maxFiles limit (${input.maxFiles}); pass a higher maxFiles to widen coverage.`);
    }
    lines.push('Query it with query_call_graph, impact_analysis, or query_type_relations.');
    return {
      ok: true,
      output: lines.join('\n'),
      data: { reused: false, durationMs, truncated, stats: graph.stats },
    };
  },
};

/**
 * 查询调用图工具
 */
export const queryCallGraphTool: ToolDefinition<{
  target: string;
  direction: 'callers' | 'callees' | 'both';
  depth: number;
  maxResults: number;
}> = {
  name: 'query_call_graph',
  description: '查询函数调用图：谁调用了这个函数（callers）或这个函数调用了谁（callees）',
  inputHint: '{ "target": "verifyToken", "direction": "callers", "depth": 2, "maxResults": 50 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.target !== 'string' || !record.target.trim()) {
      throw new Error('target is required');
    }

    const direction = record.direction as string;
    if (direction && !['callers', 'callees', 'both'].includes(direction)) {
      throw new Error('direction must be "callers", "callees", or "both"');
    }

    return {
      target: record.target.trim(),
      direction: (direction || 'callers') as 'callers' | 'callees' | 'both',
      depth: typeof record.depth === 'number' ? Math.min(Math.max(1, Math.floor(record.depth)), 5) : 2,
      maxResults: typeof record.maxResults === 'number' ? Math.min(Math.floor(record.maxResults), 100) : 50,
    };
  },

  async execute(input, context) {
    const store = new GraphStore(context.workspaceRoot);

    // 尝试加载已缓存的图
    const graph = await store.load();
    if (!graph) {
      return {
        ok: false,
        output: 'Code graph not built yet. Run build_code_graph first.',
        data: { error: 'graph_not_found' },
      };
    }

    const engine = new GraphQueryEngine(graph);
    const result = engine.queryCallGraph(
      input.target,
      input.direction,
      input.depth,
      input.maxResults,
    );

    if (result.nodes.length === 0) {
      return {
        ok: true,
        output: `No ${input.direction} found for "${input.target}"`,
        data: { result },
      };
    }

    // 格式化输出
    const output = result.nodes.map(item => {
      const { node, distance, path } = item;
      const pathStr = path.map(id => {
        const parts = id.split('::');
        return parts[parts.length - 1] || id;
      }).join(' → ');

      return `[distance=${distance}] ${node.loc.path}:${node.loc.line} ${node.kind} ${node.name}\n  Path: ${pathStr}`;
    }).join('\n\n');

    return {
      ok: true,
      output: `Found ${result.totalCount} ${input.direction} for "${input.target}":\n\n${output}` +
        (result.truncated ? `\n\n(truncated at maxResults=${input.maxResults}; increase maxResults or narrow with a more specific target)` : ''),
      data: { result },
    };
  },
};

/**
 * 影响范围分析工具
 */
export const impactAnalysisTool: ToolDefinition<{
  target: string;
  maxDepth: number;
}> = {
  name: 'impact_analysis',
  description: '分析修改某个符号会影响哪些代码（调用链分析）',
  inputHint: '{ "target": "getUserById", "maxDepth": 3 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.target !== 'string' || !record.target.trim()) {
      throw new Error('target is required');
    }

    return {
      target: record.target.trim(),
      maxDepth: typeof record.maxDepth === 'number' ? Math.min(Math.floor(record.maxDepth), 5) : 3,
    };
  },

  async execute(input, context) {
    const store = new GraphStore(context.workspaceRoot);
    const graph = await store.load();

    if (!graph) {
      return {
        ok: false,
        output: 'Code graph not built yet. Run build_code_graph first.',
        data: { error: 'graph_not_found' },
      };
    }

    const engine = new GraphQueryEngine(graph);
    const result = engine.analyzeImpact(input.target, input.maxDepth);

    const directCount = result.directImpact.length;
    const indirectCount = result.indirectImpact.length;
    const fileCount = result.affectedFiles.length;

    const output = `Impact Analysis for "${input.target}":

Risk Level: ${result.risk.toUpperCase()}
Direct Impact: ${directCount} callers
Indirect Impact: ${indirectCount} callers
Affected Files: ${fileCount}

Direct Callers:
${result.directImpact.slice(0, 10).map(n => `  - ${n.loc.path}:${n.loc.line} ${n.kind} ${n.name}`).join('\n') || '  (none)'}

${indirectCount > 0 ? `Indirect Callers (sample):
${result.indirectImpact.slice(0, 10).map(n => `  - ${n.loc.path}:${n.loc.line} ${n.kind} ${n.name}`).join('\n')}` : ''}

Affected Files:
${result.affectedFiles.slice(0, 20).map(f => `  - ${f}`).join('\n')}`;

    return {
      ok: true,
      output,
      data: { result },
    };
  },
};

/**
 * 类型关系查询工具
 */
export const queryTypeRelationsTool: ToolDefinition<{ type: string }> = {
  name: 'query_type_relations',
  description: '查询类型关系：接口的实现、类的继承树',
  inputHint: '{ "type": "UserRepository" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.type !== 'string' || !record.type.trim()) {
      throw new Error('type is required');
    }

    return {
      type: record.type.trim(),
    };
  },

  async execute(input, context) {
    const store = new GraphStore(context.workspaceRoot);
    const graph = await store.load();

    if (!graph) {
      return {
        ok: false,
        output: 'Code graph not built yet. Run build_code_graph first.',
        data: { error: 'graph_not_found' },
      };
    }

    const engine = new GraphQueryEngine(graph);
    const result = engine.queryTypeRelations(input.type);

    const parts: string[] = [`Type Relations for "${input.type}":`];

    if (result.implementations && result.implementations.length > 0) {
      parts.push(`\nImplementations (${result.implementations.length}):`);
      parts.push(...result.implementations.map(n => `  - ${n.loc.path}:${n.loc.line} ${n.name}`));
    }

    if (result.subclasses && result.subclasses.length > 0) {
      parts.push(`\nSubclasses (${result.subclasses.length}):`);
      parts.push(...result.subclasses.map(n => `  - ${n.loc.path}:${n.loc.line} ${n.name}`));
    }

    if (result.superTypes && result.superTypes.length > 0) {
      parts.push(`\nExtends/Implements:`);
      parts.push(...result.superTypes.map(n => `  - ${n.loc.path}:${n.loc.line} ${n.name}`));
    }

    if (!result.implementations && !result.subclasses && !result.superTypes) {
      parts.push('\n(No type relations found)');
    }

    return {
      ok: true,
      output: parts.join('\n'),
      data: { result },
    };
  },
};
