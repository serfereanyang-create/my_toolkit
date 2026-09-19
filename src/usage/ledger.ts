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
 * Append one real-usage entry. Silent no-op when both token counts are zero so
 * we never pollute the ledger with empty rows. Never throws into the agent
 * loop: a logging failure must not break a turn.
 */
export async function appendUsage(logPath: string, entry: UsageLedgerEntry): Promise<void> {
  if (!entry || (entry.inputTokens <= 0 && entry.outputTokens <= 0)) return;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Usage logging is best-effort; swallow errors so a turn still completes.
  }
}
