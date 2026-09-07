import {
  getProjectContextCacheStats,
  type ProjectContextCacheStats,
} from '../agent/context.js';
import {
  getNavCacheStats,
  type NavCacheStats,
} from '../nav/store.js';

export type CacheBucketStats = {
  name: string;
  hits: number;
  misses: number;
  entries?: number;
  filesCached?: number;
  filesParsed?: number;
};

export type CacheProbeReport = {
  buckets: CacheBucketStats[];
  totalHits: number;
  totalMisses: number;
  totalLookups: number;
  averageHitRate: number | null;
  averageHitRatePercent: string;
};

export function hitRate(hits: number, misses: number): number | null {
  const total = hits + misses;
  if (total <= 0) return null;
  return hits / total;
}

export function formatHitRate(hits: number, misses: number): string {
  const rate = hitRate(hits, misses);
  if (rate === null) return 'n/a (no samples)';
  return `${(rate * 100).toFixed(1)}% (${hits}/${hits + misses})`;
}

export function collectCacheProbe(): CacheProbeReport {
  const project = getProjectContextCacheStats();
  const nav = getNavCacheStats();

  const buckets: CacheBucketStats[] = [
    {
      name: 'project-context',
      hits: project.hits,
      misses: project.misses,
      entries: project.entries,
    },
    {
      name: 'nav-index',
      hits: nav.hits,
      misses: nav.misses,
      filesCached: nav.filesCached,
      filesParsed: nav.filesParsed,
    },
  ];

  const totalHits = buckets.reduce((sum, bucket) => sum + bucket.hits, 0);
  const totalMisses = buckets.reduce((sum, bucket) => sum + bucket.misses, 0);
  const totalLookups = totalHits + totalMisses;
  const averageHitRate = hitRate(totalHits, totalMisses);

  return {
    buckets,
    totalHits,
    totalMisses,
    totalLookups,
    averageHitRate,
    averageHitRatePercent: formatHitRate(totalHits, totalMisses),
  };
}

export function formatCacheProbe(report: CacheProbeReport = collectCacheProbe()): string {
  const lines = [
    'Cache probe',
    `average hit rate: ${report.averageHitRatePercent}`,
    `lookups: ${report.totalLookups} (hits=${report.totalHits}, misses=${report.totalMisses})`,
  ];

  for (const bucket of report.buckets) {
    const rate = formatHitRate(bucket.hits, bucket.misses);
    const extras: string[] = [];
    if (typeof bucket.entries === 'number') extras.push(`entries=${bucket.entries}`);
    if (typeof bucket.filesCached === 'number') extras.push(`filesCached=${bucket.filesCached}`);
    if (typeof bucket.filesParsed === 'number') extras.push(`filesParsed=${bucket.filesParsed}`);
    lines.push(`- ${bucket.name}: ${rate}${extras.length ? ` [${extras.join(', ')}]` : ''}`);
  }

  lines.push('Tip: project-context hits rise with repeated turns; nav-index hits rise after first symbol scan.');
  return lines.join('\n');
}

/**
 * Decide whether the agent should proactively surface cache health at the end
 * of a reply. This is the "self-awareness" path: the agent already holds the
 * numbers (buildContextStats collects the same report), so instead of waiting
 * for the user to ask, we flag a clearly-unhealthy cache — but only.
 *
 * Guards against noise:
 *   - Needs a real sample (`totalLookups >= minLookups`), so brand-new sessions
 *     with 1–2 lookups never nag.
 *   - Only fires when the average hit rate is meaningfully low
 *     (`averageHitRate < threshold`), not for a merely imperfect cache.
 */
export function shouldHintLowCache(
  report: CacheProbeReport = collectCacheProbe(),
  options: { threshold?: number; minLookups?: number } = {},
): boolean {
  const threshold = options.threshold ?? 0.5;
  const minLookups = options.minLookups ?? 5;
  if (report.averageHitRate === null) return false;
  if (report.totalLookups < minLookups) return false;
  return report.averageHitRate < threshold;
}

/**
 * One-line, locale-aware proactive note appended to a reply when the local
 * cache is clearly cold. Kept short so it never overwhelms the real answer.
 * Returns null when no hint is warranted.
 */
export function buildLowCacheHint(
  locale: 'zh' | 'en',
  report: CacheProbeReport = collectCacheProbe(),
  options: { threshold?: number; minLookups?: number } = {},
): string | null {
  if (!shouldHintLowCache(report, options)) return null;
  const pct = report.averageHitRatePercent;
  return locale === 'zh'
    ? `提示：本地缓存命中率偏低（${pct}），随着后续轮次复用项目上下文与符号索引会自然回升；如需明细可用 /cache 或 cache_probe 查看。`
    : `Note: local cache hit rate is low (${pct}); it should recover as later turns reuse project context and the symbol index. Run /cache or cache_probe for details.`;
}

export type { ProjectContextCacheStats, NavCacheStats };
