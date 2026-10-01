import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DispatchTier } from './tierRouter.js';

export type DispatchLedgerEntry = {
  ts: string;
  task: string;
  stage: string;
  tier: DispatchTier;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  ok: boolean;
  note?: string;
};

export function dispatchLedgerPath(): string {
  return resolve(homedir(), '.aicode', 'dispatch.jsonl');
}

/**
 * Append one dispatch row. Never throws into the agent loop: losing a ledger
 * line must not fail a turn that already produced a result.
 */
export function recordDispatch(entry: DispatchLedgerEntry, path = dispatchLedgerPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    // Accounting is best-effort by design.
  }
}

/** The status line the command prints before dispatching. */
export function formatDispatchStatus(stage: string, tier: DispatchTier, provider: string, model: string): string {
  const label = tier === 'expensive' ? '贵档' : '便宜档';
  return `[${stage}] ${label} · ${provider}/${model}`;
}

/** Read the ledger back, newest last. Missing file yields an empty list. */
export function readDispatchHistory(path = dispatchLedgerPath()): DispatchLedgerEntry[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line: string) => line.trim())
      .map((line: string) => JSON.parse(line) as DispatchLedgerEntry);
  } catch {
    // A corrupt ledger must not take the command down; the user still gets
    // the config echo, just without history.
    return [];
  }
}
