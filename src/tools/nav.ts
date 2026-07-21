import { NavIndexStore } from '../nav/store.js';
import { findReferences, findSymbols } from '../nav/query.js';
import type { SymbolKind } from '../nav/types.js';
import type { ToolDefinition } from './types.js';

const kindSet = new Set<SymbolKind>(['function', 'class', 'interface', 'type', 'enum', 'const', 'export', 'method']);

export const findSymbolTool: ToolDefinition<{ query: string; kind?: SymbolKind; path?: string; maxResults: number }> = {
  name: 'find_symbol',
  description: 'Find TS/JS symbol definitions using a cached heuristic project index.',
  inputHint: '{ "query": "runTaskBoardLoop", "kind": "function", "path": ".", "maxResults": 20 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.query !== 'string' || !record.query.trim()) throw new Error('query is required');
    const kind = typeof record.kind === 'string' && kindSet.has(record.kind as SymbolKind)
      ? record.kind as SymbolKind
      : undefined;
    return {
      query: record.query.trim(),
      kind,
      path: typeof record.path === 'string' ? record.path : undefined,
      maxResults: typeof record.maxResults === 'number' && record.maxResults > 0
        ? Math.min(Math.floor(record.maxResults), 50)
        : 20,
    };
  },
  async execute(input, context) {
    const store = new NavIndexStore(context.workspaceRoot);
    const index = await store.loadOrBuild();
    const pathPrefix = input.path && input.path !== '.' ? input.path.replace(/\\/g, '/').replace(/^\.\//, '') : undefined;
    const hits = findSymbols(index, input.query, {
      kind: input.kind,
      pathPrefix,
      maxResults: input.maxResults,
    });
    if (hits.length === 0) {
      return { ok: true, output: `(no symbols matched ${input.query})`, data: { hits: [] } };
    }
    const output = hits.map((hit) => {
      const exportMark = hit.exported ? 'export ' : '';
      const container = hit.container ? ` in ${hit.container}` : '';
      return `${hit.path}:${hit.line} [${exportMark}${hit.kind}] ${hit.name}${container} score=${hit.score}${hit.signature ? ` :: ${hit.signature}` : ''}`;
    }).join('\n');
    return { ok: true, output, data: { hits } };
  },
};

export const findReferencesTool: ToolDefinition<{ query: string; maxResults: number }> = {
  name: 'find_references',
  description: 'Approximate references to a symbol name across the indexed workspace.',
  inputHint: '{ "query": "runTaskBoardLoop", "maxResults": 50 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.query !== 'string' || !record.query.trim()) throw new Error('query is required');
    return {
      query: record.query.trim(),
      maxResults: typeof record.maxResults === 'number' && record.maxResults > 0
        ? Math.min(Math.floor(record.maxResults), 100)
        : 50,
    };
  },
  async execute(input, context) {
    const store = new NavIndexStore(context.workspaceRoot);
    const index = await store.loadOrBuild();
    const refs = await findReferences(index, context.workspaceRoot, input.query, { maxResults: input.maxResults });
    if (refs.length === 0) {
      return { ok: true, output: `(no references matched ${input.query})`, data: { refs: [] } };
    }
    const output = refs.map((ref) => `${ref.path}:${ref.line}:${ref.isDefinition ? ' def' : ' ref'}: ${ref.text}`).join('\n');
    return { ok: true, output, data: { refs } };
  },
};
