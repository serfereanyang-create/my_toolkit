/**
 * tools/semantic.ts — 语义搜索工具
 */

import * as ts from 'typescript';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { globSync } from 'glob';
import { SemanticQueryEngine, shouldEmbed, extractCodeSummary } from '../semantic/query.js';
import { CodeEmbedder, createDefaultEmbedder } from '../semantic/embedder.js';
import { SemanticStore } from '../semantic/store.js';
import type { CodeEmbedding } from '../semantic/types.js';
import type { ToolDefinition } from './types.js';

/** 判断声明是否带 export 修饰符（与 GraphBuilder 口径一致）。 */
function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * 构建语义索引工具：为导出的函数/类/方法/接口生成 embedding 并写入语义库。
 * 增量构建基于符号源码指纹；provider 未配置时诚实失败，不用哈希向量冒充。
 */
export const buildSemanticIndexTool: ToolDefinition<{
  maxFiles: number;
  maxSymbols: number;
  force: boolean;
}> = {
  name: 'build_semantic_index',
  description: '构建/增量更新语义索引（导出符号的 embedding，写入 .aicode 语义库）',
  inputHint: '{ "maxFiles": 400, "maxSymbols": 300, "force": false }',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;
    const clamp = (value: unknown, fallback: number, min: number, max: number) =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.floor(value)))
        : fallback;
    return {
      maxFiles: clamp(record.maxFiles, 400, 1, 2000),
      maxSymbols: clamp(record.maxSymbols, 300, 1, 2000),
      force: record.force === true,
    };
  },

  async execute(input, context) {
    const workspaceRoot = context.workspaceRoot;
    let store: SemanticStore | undefined;
    try {
      // 1. 收集源文件（有界扫描）
      const files = globSync('**/*.{ts,tsx,js,jsx}', {
        cwd: workspaceRoot,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/coverage/**'],
        absolute: true,
        nodir: true,
      }).slice(0, input.maxFiles);
      if (files.length === 0) {
        return {
          ok: false,
          output: 'No TypeScript/JavaScript source files found in the workspace.',
          data: { error: 'no_sources' },
        };
      }

      // 2. 单个 Program 提取可索引符号（Windows 下 glob 反斜杠与编译器正斜杠需归一化后比较）
      const program = ts.createProgram(files, {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
        skipDefaultLibCheck: true,
      });
      const fileSet = new Set(files.map((file) => file.replace(/\\/g, '/')));

      type Candidate = {
        id: string;
        kind: CodeEmbedding['kind'];
        name: string;
        signature: string;
        path: string;
        line: number;
        text: string;
        fingerprint: string;
      };
      const candidates: Candidate[] = [];
      const seenIds = new Set<string>();

      const collect = (node: ts.Node, sourceFile: ts.SourceFile, relativePath: string, container?: string) => {
        let kind: CodeEmbedding['kind'] | undefined;
        let name: string | undefined;
        let exported = false;
        if (ts.isFunctionDeclaration(node) && node.name && node.body) {
          kind = 'function';
          name = node.name.text;
          exported = hasExportModifier(node);
        } else if (ts.isClassDeclaration(node) && node.name) {
          kind = 'class';
          name = node.name.text;
          exported = hasExportModifier(node);
        } else if (ts.isInterfaceDeclaration(node)) {
          kind = 'interface';
          name = node.name.text;
          exported = hasExportModifier(node);
        } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.body && container) {
          kind = 'method';
          name = node.name.text;
        }

        if (kind && name) {
          const text = node.getText(sourceFile).slice(0, 4000);
          const bodyLines = text.split('\n').length;
          if (shouldEmbed({ kind, exported, name, bodyLines })) {
            const id = container ? `${relativePath}::${container}.${name}` : `${relativePath}::${name}`;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              candidates.push({
                id,
                kind,
                name,
                signature: (text.split('\n')[0] ?? '').trim().slice(0, 120),
                path: relativePath,
                // Explicit sourceFile: parents are not bound in this read-only
                // walk (no getTypeChecker call), so getStart() cannot resolve
                // the file by walking node.parent.
                line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
                text,
                fingerprint: createHash('sha256').update(text).digest('hex').slice(0, 16),
              });
            }
          }
        }

        // 方法归属于最近的 enclosing class；类成员经由泛化递归访问时携带容器名。
        const nextContainer = ts.isClassDeclaration(node) && node.name
          ? node.name.text
          : container;
        ts.forEachChild(node, (child) => collect(child, sourceFile, relativePath, nextContainer));
      };

      for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.fileName.includes('node_modules')) continue;
        if (!fileSet.has(sourceFile.fileName.replace(/\\/g, '/'))) continue;
        const relativePath = relative(workspaceRoot, sourceFile.fileName).replace(/\\/g, '/');
        collect(sourceFile, sourceFile, relativePath);
      }

      if (candidates.length === 0) {
        return {
          ok: true,
          output: `Scanned ${files.length} file(s) but found no embeddable symbols ` +
            '(need exported function/class/interface or class method with ≥5 body lines).',
          data: { files: files.length, candidates: 0 },
        };
      }
      const selected = candidates.slice(0, input.maxSymbols);

      // 3. 增量：指纹未变的符号跳过，避免重复支付 embedding 成本
      const embedder = createDefaultEmbedder();
      const metadata = embedder.getMetadata();
      store = new SemanticStore(workspaceRoot);

      // 换 embedder 必须整库重建。指纹只认源码、不认向量空间，增量更新会把两套
      // 空间的向量混进同一张表 —— 之后每次相似度都是噪声，而且看不出原因。
      const before = store.getStats();
      const switchingModel = before.embeddingCount > 0
        && (before.provider !== metadata.name || before.model !== metadata.model);
      if (switchingModel && !input.force) {
        return {
          ok: false,
          output:
            `Semantic index was built with ${before.provider}/${before.model} (${before.dimensions}d) ` +
            `but the current embedder is ${metadata.name}/${metadata.model} (${metadata.dimensions}d). ` +
            'Re-run with force: true to rebuild every symbol in the new vector space — an incremental ' +
            'update would leave two incompatible spaces in one table.',
          data: {
            error: 'embedder_changed',
            previous: { provider: before.provider, model: before.model, dimensions: before.dimensions },
            current: { provider: metadata.name, model: metadata.model, dimensions: metadata.dimensions },
          },
        };
      }
      if (switchingModel) store.clear();
      store.setMetadata({
        provider: metadata.name,
        model: metadata.model,
        dimensions: metadata.dimensions,
        fallback: metadata.fallback || 'none',
        lastUpdated: Date.now(),
      });

      const existing = new Map(store.getAll().map((item) => [item.id, item]));
      const pending = selected.filter((candidate) => {
        if (input.force) return true;
        return existing.get(candidate.id)?.fingerprint !== candidate.fingerprint;
      });
      const unchanged = selected.length - pending.length;

      // 4. 分批 embedding；provider 不可用时 embed() 会抛错并如实上报
      const BATCH = 50;
      let embedded = 0;
      let tokenCount = 0;
      for (let start = 0; start < pending.length; start += BATCH) {
        const batch = pending.slice(start, start + BATCH);
        const response = await embedder.embed({
          texts: batch.map((candidate) => CodeEmbedder.prepareCodeText({
            name: candidate.name,
            signature: candidate.signature,
            path: candidate.path,
            body: candidate.text,
          })),
        });
        for (let index = 0; index < batch.length; index += 1) {
          const candidate = batch[index];
          const vector = response.vectors[index];
          if (!vector) continue;
          const statInfo = await stat(join(workspaceRoot, candidate.path)).catch(() => undefined);
          store.upsert({
            id: candidate.id,
            kind: candidate.kind,
            path: candidate.path,
            line: candidate.line,
            name: candidate.name,
            signature: candidate.signature,
            summary: extractCodeSummary(candidate.text),
            vector,
            mtime: statInfo?.mtimeMs ?? Date.now(),
            fingerprint: candidate.fingerprint,
            tokenCount: Math.max(1, Math.round(response.tokenCount / batch.length)),
          });
          embedded += 1;
        }
        tokenCount += response.tokenCount;
      }

      const lexical = metadata.name === 'local' || metadata.fallback === 'local';
      const lines = [
        `Semantic index build complete — embedder ${metadata.name}/${metadata.model} (${metadata.dimensions}d, ` +
        `${lexical ? 'lexical approximation' : 'neural embeddings'}).`,
        `Files scanned: ${files.length}; embeddable symbols: ${candidates.length} (indexed up to ${selected.length}).`,
        `Embedded now: ${embedded}; unchanged (skipped): ${unchanged}; tokens: ${tokenCount}.`,
      ];
      if (lexical) {
        lines.push(
          'Note: local hash embeddings are approximate lexical features, not a neural embedding model. ' +
          'OpenAI-compatible embeddings are used automatically when OPENAI_API_KEY is set ' +
          '(AICODE_EMBED_BASE_URL points at a relay, AICODE_EMBED_MODEL overrides the model); ' +
          'set AICODE_EMBED_PROVIDER=local to force this offline mode.',
        );
      }
      return {
        ok: true,
        output: lines.join('\n'),
        data: {
          files: files.length,
          candidates: candidates.length,
          embedded,
          unchanged,
          tokenCount,
          provider: metadata.name,
          model: metadata.model,
          dimensions: metadata.dimensions,
          lexical,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack?.split('\n').slice(1, 4).join('\n') : undefined;
      return {
        ok: false,
        output: `Semantic index build failed: ${message}`,
        data: { error: message, ...(stack ? { stack } : {}) },
      };
    } finally {
      store?.close();
    }
  },
};

/**
 * 语义搜索工具
 */
export const semanticSearchTool: ToolDefinition<{
  query: string;
  maxResults: number;
  minSimilarity: number;
  kind?: 'function' | 'class' | 'method' | 'interface';
  pathPrefix?: string;
}> = {
  name: 'semantic_search',
  description: '语义搜索代码库：找到与查询文本语义相关的函数/类（即使命名不同）',
  inputHint: '{ "query": "parse JWT token", "maxResults": 20, "minSimilarity": 0.6 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.query !== 'string' || !record.query.trim()) {
      throw new Error('query is required');
    }

    const kind = record.kind as string;
    if (kind && !['function', 'class', 'method', 'interface'].includes(kind)) {
      throw new Error('kind must be "function", "class", "method", or "interface"');
    }

    return {
      query: record.query.trim(),
      maxResults: typeof record.maxResults === 'number' ? Math.min(Math.floor(record.maxResults), 50) : 20,
      minSimilarity: typeof record.minSimilarity === 'number' ? Math.max(0, Math.min(1, record.minSimilarity)) : 0.6,
      kind: kind as any,
      pathPrefix: typeof record.pathPrefix === 'string' ? record.pathPrefix : undefined,
    };
  },

  async execute(input, context) {
    try {
      const embedder = createDefaultEmbedder();
      const metadata = embedder.getMetadata();
      const engine = new SemanticQueryEngine(context.workspaceRoot, embedder);
      // 索引是哪个 embedder 建的、多少维，必须跟着结果一起报：用户看到相似度
      // 之前就该知道这是神经向量还是词法近似。
      const lexical = metadata.name === 'local' || metadata.fallback === 'local';
      const profile = () => {
        const stats = engine.getStats();
        return `index ${stats.provider}/${stats.model} ${stats.dimensions}d` +
          `${lexical ? ' (lexical approximation)' : ''}`;
      };

      const result = await engine.search(input.query, {
        maxResults: input.maxResults,
        minSimilarity: input.minSimilarity,
        kind: input.kind,
        pathPrefix: input.pathPrefix,
      });

      if (result.matches.length === 0) {
        const stats = engine.getStats();
        const badge = profile();
        engine.close();

        if (stats.embeddingCount === 0) {
          return {
            ok: false,
            output: 'Semantic index is empty. Run build_semantic_index first.',
            data: { error: 'index_empty' },
          };
        }

        return {
          ok: true,
          output: `No matches found for query: "${input.query}" (${badge})`,
          data: { result },
        };
      }

      // 格式化输出
      const output = result.matches.map((match, index) => {
        const { embedding, similarity, distance } = match;
        return `${index + 1}. [similarity=${similarity.toFixed(3)}] ${embedding.path}:${embedding.line}
   ${embedding.kind} ${embedding.name}
   ${embedding.signature}
   Summary: ${embedding.summary}`;
      }).join('\n\n');

      const badge = profile();
      engine.close();

      return {
        ok: true,
        output: `Found ${result.totalCount} semantic matches for "${input.query}" (${badge}):\n\n${output}`,
        data: { result },
      };
    } catch (error: any) {
      return {
        ok: false,
        output: `Semantic search failed: ${error.message}`,
        data: { error: error.message },
      };
    }
  },
};

/**
 * 查找相似代码工具
 */
export const findSimilarCodeTool: ToolDefinition<{
  targetId: string;
  maxResults: number;
  minSimilarity: number;
}> = {
  name: 'find_similar_code',
  description: '查找与给定代码片段功能相似的其他代码',
  inputHint: '{ "targetId": "src/auth.ts::verifyToken", "maxResults": 10, "minSimilarity": 0.7 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.targetId !== 'string' || !record.targetId.trim()) {
      throw new Error('targetId is required (format: "path::symbolName")');
    }

    return {
      targetId: record.targetId.trim(),
      maxResults: typeof record.maxResults === 'number' ? Math.min(Math.floor(record.maxResults), 20) : 10,
      minSimilarity: typeof record.minSimilarity === 'number' ? Math.max(0, Math.min(1, record.minSimilarity)) : 0.7,
    };
  },

  async execute(input, context) {
    try {
      const embedder = createDefaultEmbedder();
      const engine = new SemanticQueryEngine(context.workspaceRoot, embedder);

      const matches = await engine.findSimilarCode(input.targetId, {
        maxResults: input.maxResults,
        minSimilarity: input.minSimilarity,
        excludeSelf: true,
      });

      engine.close();

      if (matches.length === 0) {
        return {
          ok: true,
          output: `No similar code found for "${input.targetId}"`,
          data: { matches: [] },
        };
      }

      // 格式化输出
      const output = matches.map((match, index) => {
        const { embedding, similarity } = match;
        return `${index + 1}. [similarity=${similarity.toFixed(3)}] ${embedding.path}:${embedding.line}
   ${embedding.kind} ${embedding.name}
   ${embedding.signature}`;
      }).join('\n\n');

      return {
        ok: true,
        output: `Found ${matches.length} similar code fragments:\n\n${output}`,
        data: { matches },
      };
    } catch (error: any) {
      return {
        ok: false,
        output: `Failed to find similar code: ${error.message}`,
        data: { error: error.message },
      };
    }
  },
};

/**
 * 代码克隆检测工具
 */
export const detectCodeClonesTool: ToolDefinition<{
  minSimilarity: number;
  minClusterSize: number;
}> = {
  name: 'detect_code_clones',
  description: '检测代码库中的重复代码（功能相似的代码簇）',
  inputHint: '{ "minSimilarity": 0.85, "minClusterSize": 2 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    return {
      minSimilarity: typeof record.minSimilarity === 'number' ? Math.max(0.5, Math.min(1, record.minSimilarity)) : 0.85,
      minClusterSize: typeof record.minClusterSize === 'number' ? Math.max(2, Math.floor(record.minClusterSize)) : 2,
    };
  },

  async execute(input, context) {
    try {
      const embedder = createDefaultEmbedder();
      const engine = new SemanticQueryEngine(context.workspaceRoot, embedder);

      const clusters = await engine.clusterSimilarCode({
        minSimilarity: input.minSimilarity,
        minClusterSize: input.minClusterSize,
      });

      engine.close();

      if (clusters.length === 0) {
        return {
          ok: true,
          output: 'No code clones detected.',
          data: { clusters: [] },
        };
      }

      // 格式化输出
      const output = clusters.slice(0, 10).map((cluster, index) => {
        const { representative, similar } = cluster;
        const clusterSize = similar.length + 1;

        return `Cluster ${index + 1} (${clusterSize} similar code fragments):

Representative:
  ${representative.path}:${representative.line} ${representative.kind} ${representative.name}
  ${representative.signature}

Similar:
${similar.slice(0, 5).map(s => `  - ${s.path}:${s.line} ${s.kind} ${s.name}`).join('\n')}${similar.length > 5 ? `\n  ... and ${similar.length - 5} more` : ''}`;
      }).join('\n\n' + '='.repeat(60) + '\n\n');

      return {
        ok: true,
        output: `Detected ${clusters.length} code clone clusters:\n\n${output}`,
        data: { clusters: clusters.slice(0, 10) },
      };
    } catch (error: any) {
      return {
        ok: false,
        output: `Code clone detection failed: ${error.message}`,
        data: { error: error.message },
      };
    }
  },
};

/**
 * 语义索引统计工具
 */
export const semanticIndexStatsTool: ToolDefinition<{}> = {
  name: 'semantic_index_stats',
  description: '查看语义索引的统计信息（索引数量、token 消耗、大小等）',
  inputHint: '{}',
  risk: 'read',

  validate() {
    return {};
  },

  async execute(_input, context) {
    try {
      const embedder = createDefaultEmbedder();
      const engine = new SemanticQueryEngine(context.workspaceRoot, embedder);
      const stats = engine.getStats();
      engine.close();

      const output = `Semantic Index Statistics:

Embeddings: ${stats.embeddingCount}
Files: ${stats.fileCount}
Total Tokens: ${stats.totalTokens.toLocaleString()}
Size: ${stats.sizeInMB} MB
Provider: ${stats.provider}
Dimensions: ${stats.dimensions}
Last Updated: ${new Date(stats.lastUpdated).toLocaleString()}`;

      return {
        ok: true,
        output,
        data: { stats },
      };
    } catch (error: any) {
      return {
        ok: false,
        output: `Failed to get stats: ${error.message}`,
        data: { error: error.message },
      };
    }
  },
};
