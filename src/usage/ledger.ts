import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Real token-usage ledger. Every completed agent turn appends ONE line of
 * newline-delimited JSON with the genuine token counts the provider reported.
 * There is no estimation and no backfill: if a provider returns no usage (e.g.
 * the mock provider), nothing is written. The desktop app reads this file to
 * render per-day, per-model statistics.
 *
 * The ledger is global (shared by the CLI and the desktop app) so usage from
 * every workspace lands in one place. Resolution order:
 *   explicit path arg  >  AICODE_USAGE_LOG env  >  ~/.aicode/usage.jsonl
 */

export type UsageLedgerEntry = {
  /** ISO timestamp of when the turn completed. */
  ts: string;
  sessionId: string;
  provider: string;
  model: string;
  /** Base URL of the provider endpoint — used to identify custom providers. */
  baseUrl?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  localCachePredictedRate?: number;
  reasoningEffort?: string;
  /** Real provider cache efficiency this turn: cacheRead/(cacheRead+input). */
  cacheEfficiency?: number;
  /** 关联字段：本次 turn 的标识（桌面/日志下钻用）。 */
  turnId?: string;
  /** 本 turn 的工具调用次数与去重后的工具名（截断到 12 个）。 */
  toolCalls?: number;
  toolsUsed?: string[];
  /**
   * 本 turn 解析出的工具作用域与送出的工具数。
   *
   * 工具数组排在 prompt 最前面、且落在缓存段之内，所以它每轮变化就是缓存
   * 杀手。记下来才能从台账直接判断"命中率低是不是工具面在漂"，而不是靠猜。
   */
  toolScope?: string;
  toolCount?: number;
  /**
   * 本 turn 里"被折叠掉的"自动压缩支出（真实 token，非估算）。
   *
   * 自动压缩不走主循环——它直接调 `provider.complete` 拿摘要，所以它的
   * usage 不会累进 `usageTotals`。不单独记的话，这一段就是看不见的支出：
   * 一个大型会话每跨一次窗口就多花一次全量的输入 token，而台账里一行都
   * 没有。存在此字段即表示该 turn 触发过至少一次自动压缩。
   */
  autoCompact?: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /**
     * completed = 历史已替换；failed = 摘要失败，历史原样保留，钱照样花了；
     * cancelled = 用户在摘要请求进行中取消。取消与失败分开记，因为它们对成本
     * 分析的含义不同：取消不是供应商故障，也不会在下一轮重演。
     * （runAutoCompact 本身分不出这两者——它把两者都报成 failed 再抛 abort，
     * 由 agent 的 turn 取消路径折成 cancelled。）
     */
    outcome: 'completed' | 'failed' | 'cancelled';
  };
  /** 任务板关联：turn 属于某个任务板的任务时填充。 */
  boardId?: string;
  taskId?: string;
  /** 本 turn 总耗时（毫秒）。 */
  durationMs?: number;
};

export function resolveUsageLogPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = explicit ?? env.AICODE_USAGE_LOG;
  if (chosen && chosen.trim()) return resolve(chosen);
  return resolve(homedir(), '.aicode', 'usage.jsonl');
}

/**
 * Append one real-usage entry. Silent no-op when there is nothing to record so
 * we never pollute the ledger with empty rows. Never throws into the agent
 * loop: a logging failure must not break a turn.
 *
 * "Nothing to record" used to mean "no main-loop tokens". A turn whose only
 * spend was an auto-compaction summary has main-loop tokens of 0 and would
 * have been dropped, which is precisely the invisible spend this field exists
 * to surface — so a compaction block with calls > 0 also counts as content.
 */
export async function appendUsage(logPath: string, entry: UsageLedgerEntry): Promise<void> {
  if (!entry) return;
  const hasTurnTokens = entry.inputTokens > 0 || entry.outputTokens > 0;
  const hasCompactSpend = (entry.autoCompact?.calls ?? 0) > 0;
  if (!hasTurnTokens && !hasCompactSpend) return;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Usage logging is best-effort; swallow errors so a turn still completes.
  }
}
