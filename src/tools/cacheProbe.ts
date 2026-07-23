import { collectCacheProbe, formatCacheProbe } from '../probe/cacheProbe.js';
import type { ToolDefinition } from './types.js';

/**
 * Read-only in-process cache probe (project-context + nav-index).
 * Powers NL "缓存命中" / slash /cache without shell or code search.
 */
export const cacheProbeTool: ToolDefinition<Record<string, never>> = {
  name: 'cache_probe',
  description: 'Report average cache hit rate for project-context and nav-index in this CLI process.',
  inputHint: '{}',
  risk: 'read',
  validate() {
    return {};
  },
  async execute() {
    const report = collectCacheProbe();
    return {
      ok: true,
      output: formatCacheProbe(report),
      data: report,
    };
  },
};
