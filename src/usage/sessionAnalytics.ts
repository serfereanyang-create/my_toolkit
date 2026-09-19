/**
 * sessionAnalytics.ts — 会话级工具使用与资源分析。
 *
 * 数据源都是真实落盘记录：
 *  - usage.jsonl：每轮 token/cache/耗时/工具数
 *  - session.toolCalls：逐工具调用（工具名/成功/输入/输出）
 * 输出：工具排行（调用/失败/慢）、失败率趋势、token 与缓存效率、时间分布。
 * 纯统计，不触发任何执行。
 */

export interface UsageLedgerEntry {
  ts?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

export interface SessionToolCall {
  tool: string;
  ok: boolean;
  output?: string;
}

export interface ToolUsageStat {
  tool: string;
  calls: number;
  failures: number;
  failureRate: number;
  /** 失败调用的输出样本（最多 3 条，截断） */
  recentFailures: string[];
}

export interface SessionAnalytics {
  ok: boolean;
  error?: string;
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** cacheRead / (cacheRead + input) */
  cacheHitRate: number | null;
  avgTurnDurationMs: number | null;
  totalToolCalls: number;
  toolStats: ToolUsageStat[];
  /** 按小时分布（UTC 小时 → 轮数） */
  hourHistogram: number[];
  topTools: ToolUsageStat[];
  failureRate: number | null;
}

/** 解析 usage.jsonl 文本（坏行跳过不致命）。 */
export function parseUsageLines(text: string): UsageLedgerEntry[] {
  const entries: UsageLedgerEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const input = typeof raw.inputTokens === 'number' ? raw.inputTokens : 0;
      const output = typeof raw.outputTokens === 'number' ? raw.outputTokens : 0;
      if (input + output <= 0) continue;
      entries.push({
        ts: typeof raw.ts === 'string' ? raw.ts : undefined,
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
        provider: typeof raw.provider === 'string' ? raw.provider : undefined,
        model: typeof raw.model === 'string' ? raw.model : undefined,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: typeof raw.cacheReadTokens === 'number' ? raw.cacheReadTokens : undefined,
        cacheCreationTokens: typeof raw.cacheCreationTokens === 'number' ? raw.cacheCreationTokens : undefined,
        toolCalls: typeof raw.toolCalls === 'number' ? raw.toolCalls : undefined,
        durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
      });
    } catch {
      // 跳过损坏行
    }
  }
  return entries;
}

export function computeSessionAnalytics(params: {
  ledgerText: string;
  toolCalls: SessionToolCall[];
  limit?: number;
}): SessionAnalytics {
  const limit = params.limit ?? 200;
  const ledger = parseUsageLines(params.ledgerText).slice(-limit);
  const byTool = new Map<string, ToolUsageStat>();

  for (const call of params.toolCalls) {
    let stat = byTool.get(call.tool);
    if (!stat) {
      stat = { tool: call.tool, calls: 0, failures: 0, failureRate: 0, recentFailures: [] };
      byTool.set(call.tool, stat);
    }
    stat.calls += 1;
    if (!call.ok) {
      stat.failures += 1;
      const sample = String(call.output ?? '').replace(/\s+/g, ' ').slice(0, 100);
      if (stat.recentFailures.length < 3 && sample) stat.recentFailures.push(sample);
    }
    stat.failureRate = stat.calls > 0 ? stat.failures / stat.calls : 0;
  }

  const toolStats = [...byTool.values()].sort((a, b) => b.calls - a.calls || b.failures - a.failures);
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let durations = 0;
  let durationCount = 0;
  const hourHistogram = new Array(24).fill(0);
  for (const entry of ledger) {
    totalInput += entry.inputTokens;
    totalOutput += entry.outputTokens;
    totalCacheRead += entry.cacheReadTokens ?? 0;
    if (typeof entry.durationMs === 'number' && entry.durationMs >= 0) {
      durations += entry.durationMs;
      durationCount += 1;
    }
    if (entry.ts) {
      const hour = new Date(entry.ts).getUTCHours();
      if (Number.isFinite(hour)) hourHistogram[hour] += 1;
    }
  }

  return {
    ok: true,
    turns: ledger.length,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    cacheHitRate: totalInput + totalCacheRead > 0 ? totalCacheRead / (totalInput + totalCacheRead) : null,
    avgTurnDurationMs: durationCount > 0 ? Math.round(durations / durationCount) : null,
    totalToolCalls: params.toolCalls.length,
    toolStats,
    hourHistogram,
    topTools: toolStats.slice(0, 10),
    failureRate: params.toolCalls.length > 0
      ? toolStats.reduce((n, s) => n + s.failures, 0) / params.toolCalls.length
      : null,
  };
}
