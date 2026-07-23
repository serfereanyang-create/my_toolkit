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

export type { ProjectContextCacheStats, NavCacheStats };
