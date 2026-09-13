/**
 * usage/cacheHealth.ts — 提示缓存健康诊断
 *
 * 把实战验证过的诊断法产品化：读 usage.jsonl 真实台账，按厂商缓存机制
 * 分类命中模式，定位"缓存杀手"。识别的模式（对应已知根因）：
 * - cacheRead≈0（非首轮）：前缀不稳定 —— strategy/时间戳等动态内容混入头部
 * - cacheRead≈cacheCreation 交替出现：前缀被整体重建
 * - 命中率随轮次缓慢上升后骤降：滑动断点正常，但中途出现前缀改写
 * - 全程高命中：滑动断点 + 尾置动态内容工作正常
 */

import { readFile } from 'node:fs/promises';
import { resolveUsageLogPath, type UsageLedgerEntry } from './ledger.js';

export type TurnPattern = 'cold-start' | 'healthy' | 'prefix-rebuild' | 'unstable-prefix' | 'no-cache-data';

export type TurnDiagnosis = {
  ts: string;
  provider: string;
  model: string;
  /** provider@host grouping key — cache behavior is per-endpoint, not global. */
  endpoint: string;
  pattern: TurnPattern;
  cacheEfficiency?: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type EndpointHealth = {
  endpoint: string;
  turns: number;
  cacheReadTurns: number;
  sumInput: number;
  sumCacheRead: number;
  sumCacheCreation: number;
  hitRate: number | null;
  /** 'not-reporting' = the endpoint returns zero cache counters on every turn. */
  status: 'reporting' | 'not-reporting' | 'partial';
};

export type CacheHealthReport = {
  totalTurns: number;
  analyzedTurns: number;
  avgEfficiency: number;
  last10AvgEfficiency: number;
  patternCounts: Record<TurnPattern, number>;
  turns: TurnDiagnosis[];
  findings: string[];
  endpoints: EndpointHealth[];
};

/**
 * 单轮模式判定（阈值来自实测台账模式）：
 * - 首轮（本会话第一条）cacheRead=0 是冷启动，不是问题
 * - 非首轮 cacheRead=0 且 input>2K：前缀不稳定（缓存杀手模式）
 * - cacheCreation 与 cacheRead 同量级且 >1K：前缀重建（写一笔读一笔）
 * - cacheRead>0：健康
 */
export function classifyTurn(entry: UsageLedgerEntry, isFirstOfSession: boolean): TurnPattern {
  const cacheRead = entry.cacheReadTokens ?? 0;
  const cacheCreation = entry.cacheCreationTokens ?? 0;

  if (cacheRead === 0 && cacheCreation === 0) {
    return entry.inputTokens > 0 ? 'no-cache-data' : 'no-cache-data';
  }
  if (cacheRead === 0) {
    return isFirstOfSession ? 'cold-start' : 'unstable-prefix';
  }
  if (cacheCreation > 1000 && cacheRead < cacheCreation * 0.5) {
    return 'prefix-rebuild';
  }
  return 'healthy';
}

/** Grouping key: cache behavior is a property of the endpoint, not the CLI. */
export function endpointKey(entry: UsageLedgerEntry): string {
  let host = '';
  try {
    host = entry.baseUrl ? new URL(entry.baseUrl).host : '';
  } catch {
    host = entry.baseUrl ?? '';
  }
  return host ? `${entry.provider}@${host}` : String(entry.provider);
}

export async function analyzeCacheHealth(options?: { logPath?: string; limit?: number }): Promise<CacheHealthReport> {
  const logPath = options?.logPath ?? resolveUsageLogPath();
  const limit = options?.limit ?? 60;

  let entries: UsageLedgerEntry[] = [];
  try {
    const raw = await readFile(logPath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as UsageLedgerEntry);
      } catch {
        // 跳过损坏行
      }
    }
  } catch {
    // 台账不存在
  }

  entries = entries.slice(-limit);

  const seenSessions = new Set<string>();
  const turns: TurnDiagnosis[] = [];
  const patternCounts: Record<TurnPattern, number> = {
    'cold-start': 0, healthy: 0, 'prefix-rebuild': 0, 'unstable-prefix': 0, 'no-cache-data': 0,
  };

  for (const entry of entries) {
    const isFirst = !seenSessions.has(entry.sessionId);
    seenSessions.add(entry.sessionId);
    const pattern = classifyTurn(entry, isFirst);
    patternCounts[pattern]++;
    turns.push({
      ts: entry.ts,
      provider: entry.provider,
      model: entry.model,
      endpoint: endpointKey(entry),
      pattern,
      cacheEfficiency: entry.cacheEfficiency,
      inputTokens: entry.inputTokens,
      cacheReadTokens: entry.cacheReadTokens ?? 0,
      cacheCreationTokens: entry.cacheCreationTokens ?? 0,
    });
  }

  // Per-endpoint rollup: a weak relay that never reports cache counters must
  // not drag a healthy endpoint's numbers into a single misleading average.
  const endpointMap = new Map<string, { turns: number; cacheReadTurns: number; sumInput: number; sumRead: number; sumWrite: number }>();
  for (const turn of turns) {
    const g = endpointMap.get(turn.endpoint) ?? { turns: 0, cacheReadTurns: 0, sumInput: 0, sumRead: 0, sumWrite: 0 };
    g.turns++;
    if (turn.cacheReadTokens > 0) g.cacheReadTurns++;
    g.sumInput += turn.inputTokens;
    g.sumRead += turn.cacheReadTokens;
    g.sumWrite += turn.cacheCreationTokens;
    endpointMap.set(turn.endpoint, g);
  }
  const endpoints: EndpointHealth[] = Array.from(endpointMap.entries()).map(([endpoint, g]) => ({
    endpoint,
    turns: g.turns,
    cacheReadTurns: g.cacheReadTurns,
    sumInput: g.sumInput,
    sumCacheRead: g.sumRead,
    sumCacheCreation: g.sumWrite,
    hitRate: g.sumInput + g.sumRead > 0 ? g.sumRead / (g.sumInput + g.sumRead) : null,
    status: g.cacheReadTurns > 0
      ? 'reporting' as const
      : g.sumWrite > 0 ? 'partial' as const : 'not-reporting' as const,
  })).sort((a, b) => b.turns - a.turns);

  const withEfficiency = turns.filter((t) => typeof t.cacheEfficiency === 'number');
  const avgEfficiency = withEfficiency.length > 0
    ? withEfficiency.reduce((sum, t) => sum + (t.cacheEfficiency ?? 0), 0) / withEfficiency.length
    : 0;
  const last10 = withEfficiency.slice(-10);
  const last10AvgEfficiency = last10.length > 0
    ? last10.reduce((sum, t) => sum + (t.cacheEfficiency ?? 0), 0) / last10.length
    : 0;

  const findings: string[] = [];

  const notReporting = endpoints.filter((e) => e.status === 'not-reporting');
  const reporting = endpoints.filter((e) => e.status !== 'not-reporting');
  for (const e of notReporting) {
    findings.push(
      `端点 ${e.endpoint} 的 ${e.turns} 轮全部零缓存回报（cacheRead=0 且 cacheCreation=0）：` +
      '该中转剥除或未透传 cache_control（或未启用上游缓存）。客户端策略对它无效，这些轮次按全价计费——这是端点属性，不是本地前缀问题。',
    );
  }
  if (patternCounts['unstable-prefix'] > 0) {
    findings.push(
      '发现 ' + patternCounts['unstable-prefix'] + ' 轮非首轮零命中（端点有缓存能力）：前缀不稳定。' +
      '检查 toolStrategy 是否已尾置（自动缓存厂商）或混入缓存段（显式断点厂商），' +
      '以及时间戳/随机内容是否进入头部。可用 diffCacheSegments 做分段哈希定位。'
    );
  }
  if (patternCounts['prefix-rebuild'] > 1) {
    findings.push(
      '发现 ' + patternCounts['prefix-rebuild'] + ' 轮前缀重建（写≈读交替）：缓存段被整体重写，' +
      '通常是 system/tools 段变化或断点位置错误导致分段失效。'
    );
  }
  if (patternCounts['no-cache-data'] === turns.length && turns.length > 0) {
    findings.push('所有轮次均无缓存字段：当前使用的端点全部不回报缓存用量（常见于 mock 或剥字段的自定义网关）。');
  }
  if (patternCounts['cold-start'] > 0) {
    findings.push(patternCounts['cold-start'] + ' 个会话首轮冷启动属正常现象（会话级缓存），无需修复。');
  }
  // Only vouch for prefix stability when some endpoint actually reports cache
  // data: silence from a not-reporting relay is not evidence of stability.
  if (
    patternCounts['unstable-prefix'] === 0 && patternCounts['prefix-rebuild'] === 0 &&
    reporting.length > 0
  ) {
    findings.push('回报缓存的端点里未发现前缀不稳定/重建模式，滑动断点 + 尾置动态内容布局工作正常。');
  }

  return {
    totalTurns: turns.length,
    analyzedTurns: turns.length,
    avgEfficiency,
    last10AvgEfficiency,
    patternCounts,
    turns: turns.slice(-20),
    findings,
    endpoints,
  };
}

export function formatCacheHealth(report: CacheHealthReport): string {
  if (report.totalTurns === 0) {
    return '台账为空：还没有完成过任何计费轮次。';
  }

  const pct = (value: number) => Math.round(value * 100) + '%';
  const lines = [
    '缓存健康（最近 ' + report.totalTurns + ' 轮）:',
    '  平均命中率: ' + pct(report.avgEfficiency) + '，最近10轮: ' + pct(report.last10AvgEfficiency),
    '  模式分布: ' + Object.entries(report.patternCounts)
      .filter(([, n]) => n > 0)
      .map(([pattern, n]) => pattern + '=' + n)
      .join(', '),
  ];

  if (report.endpoints.length > 0) {
    lines.push('', '按端点（缓存行为是端点属性，混合平均会互相污染）:');
    for (const e of report.endpoints) {
      const rate = e.hitRate === null ? 'n/a' : pct(e.hitRate);
      const tag = e.status === 'not-reporting' ? ' [端点不回报缓存]' : e.status === 'partial' ? ' [部分轮次有命中]' : '';
      lines.push('  - ' + e.endpoint + ': ' + rate + '，命中轮 ' + e.cacheReadTurns + '/' + e.turns +
        '，输入 ' + e.sumInput + ' tok，读 ' + e.sumCacheRead + ' tok' + tag);
    }
  }

  if (report.findings.length > 0) {
    lines.push('', '诊断:');
    for (const finding of report.findings) {
      lines.push('  - ' + finding);
    }
  }

  return lines.join('\n');
}
