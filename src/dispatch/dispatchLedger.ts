import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DISPATCH_TIER_LABELS } from './tierRouter.js';
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
 * The 省钱分级 usage ledger the /省钱分级 spec names
 * (`<workspace>/.shengqian-logs/usage-ledger.jsonl`).
 *
 * The spec requires every tiered call to append here, and the desktop settings
 * panel tells the user their calls are recorded — but nothing ever wrote to
 * either that file or the .aicode one. This is the workspace-scoped path the
 * dispatcher is contracted to use; the .aicode path stays for the legacy
 * global view.
 */
export function shengqianLedgerPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, '.shengqian-logs', 'usage-ledger.jsonl');
}

/**
 * Append one dispatch row. Never throws into the agent loop: losing a ledger
 * line must not fail a turn that already produced a result.
 *
 * Writes both the global .aicode ledger and, when a workspace is known, the
 * spec's per-workspace .shengqian-logs ledger.
 */
export function recordDispatch(
  entry: DispatchLedgerEntry,
  path = dispatchLedgerPath(),
  workspaceRoot?: string,
): void {
  const targets = workspaceRoot ? [path, shengqianLedgerPath(workspaceRoot)] : [path];
  for (const target of targets) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch {
      // Accounting is best-effort by design.
    }
  }
}

/**
 * The status line the command prints before dispatching.
 *
 * Reads the label from the router's own table rather than hardcoding two of
 * the three tiers: the ternary this replaced rendered `standard` as "便宜档".
 */
export function formatDispatchStatus(stage: string, tier: DispatchTier, provider: string, model: string): string {
  return `[${stage}] ${DISPATCH_TIER_LABELS[tier]} · ${provider}/${model}`;
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
