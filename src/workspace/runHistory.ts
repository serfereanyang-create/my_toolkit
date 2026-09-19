/**
 * runHistory.ts - Workspace run 结果持久化与历史 diff 对比。
 *
 * 在 workspaceRoot/.aicode/workspace-history/ 下追加 JSONL，保留最近 200 条。
 */

import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary, RunPlan } from './runner.js';

const HISTORY_DIR = '.aicode/workspace-history';
const HISTORY_FILE = 'runs.jsonl';
const HISTORY_LIMIT = 200;

export interface RunRecord {
  schemaVersion: 1;
  recordedAt: string;
  /** 入参摘要 */
  request: {
    script: string;
    filter?: string;
    concurrency: number;
    continueOnError: boolean;
  };
  /** 拓扑计划（各包顺序 + scriptAvailability） */
  plan: Array<{ name: string; dir: string; scriptAvailable: boolean; order: number }>;
  /** 汇总 */
  summary: {
    ok: number;
    failed: number;
    skipped: number;
    totalDurationMs: number;
  };
  /** 逐包结果 */
  artifacts: Array<{
    pkg: string;
    exitCode: number;
    durationMs: number;
    skipped?: boolean;
    skipReason?: string;
    /** 截断到 500 字符的最后输出 */
    tail: string;
  }>;
}

/** 将单次 workspace_run 结果追加持久化；并裁剪到上限条数 */
export async function recordWorkspaceRun(
  workspaceRoot: string,
  plan: RunPlan,
  summary: RunSummary,
  request: RunRecord['request'],
): Promise<{ path: string; totalEntries: number }> {
  const dir = join(workspaceRoot, HISTORY_DIR);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const filePath = join(dir, HISTORY_FILE);

  const record: RunRecord = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    request,
    plan: plan.queue.map((step) => ({
      name: step.package.name,
      dir: step.package.dir,
      scriptAvailable: step.scriptAvailable,
      order: step.order,
    })),
    summary: {
      ok: summary.ok,
      failed: summary.failed,
      skipped: summary.skipped,
      totalDurationMs: summary.totalDurationMs,
    },
    artifacts: summary.artifacts.map((a) => ({
      pkg: a.pkg,
      exitCode: a.exitCode,
      durationMs: a.durationMs,
      skipped: a.skipped,
      skipReason: a.skipReason,
      tail: [...(a.stderr || '').split('\n'), ...(a.stdout || '').split('\n')]
        .slice(-8)
        .join('\n')
        .slice(0, 500),
    })),
  };

  await appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8');

  // 裁剪：保留最近 N 条
  const all = await readHistory(workspaceRoot);
  let totalEntries = all.length;
  if (totalEntries > HISTORY_LIMIT) {
    const keep = all.slice(-HISTORY_LIMIT);
    await writeFile(
      filePath,
      keep.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
    totalEntries = keep.length;
  }
  return { path: filePath, totalEntries };
}

export async function readHistory(workspaceRoot: string): Promise<RunRecord[]> {
  const filePath = join(workspaceRoot, HISTORY_DIR, HISTORY_FILE);
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, 'utf-8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as RunRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is RunRecord => r !== null);
}

export interface RunDiff {
  prev: RunRecord | null;
  latest: RunRecord | null;
  sameScript: boolean;
  prevSummary?: { ok: number; failed: number; skipped: number; durationMs: number };
  latestSummary?: { ok: number; failed: number; skipped: number; durationMs: number };
  /** exitCode 由 0 → 非 0（新失败） */
  regression: string[];
  /** exitCode 由非 0 → 0（修复） */
  recovered: string[];
  /** exitCode 都失败但内容变了 */
  fluctuations: string[];
  durationDeltaMs: number;
}

export function diffRuns(latest: RunRecord, prev: RunRecord | null): RunDiff {
  if (!prev) {
    return {
      prev: null,
      latest,
      sameScript: false,
      prevSummary: undefined,
      latestSummary: {
        ok: latest.summary.ok,
        failed: summaryFailed(latest),
        skipped: latest.summary.skipped,
        durationMs: latest.summary.totalDurationMs,
      },
      regression: [],
      recovered: [],
      fluctuations: [],
      durationDeltaMs: 0,
    };
  }
  const regression: string[] = [];
  const recovered: string[] = [];
  const fluctuations: string[] = [];

  const prevByPkg = new Map(prev.artifacts.map((a) => [a.pkg, a]));
  const latestByPkg = new Map(latest.artifacts.map((a) => [a.pkg, a]));

  for (const [name, prevArt] of prevByPkg) {
    const curArt = latestByPkg.get(name);
    if (!curArt) continue;
    if (prevArt.exitCode === 0 && curArt.exitCode !== 0) regression.push(name);
    else if (prevArt.exitCode !== 0 && curArt.exitCode === 0) recovered.push(name);
    else if (prevArt.exitCode !== 0 && curArt.exitCode !== 0 && prevArt.exitCode !== curArt.exitCode) {
      fluctuations.push(name);
    }
  }
  return {
    prev,
    latest,
    sameScript: prev.request.script === latest.request.script,
    prevSummary: {
      ok: prev.summary.ok,
      failed: prev.summary.failed,
      skipped: prev.summary.skipped,
      durationMs: prev.summary.totalDurationMs,
    },
    latestSummary: {
      ok: latest.summary.ok,
      failed: latest.summary.failed,
      skipped: latest.summary.skipped,
      durationMs: latest.summary.totalDurationMs,
    },
    regression,
    recovered,
    fluctuations,
    durationDeltaMs: latest.summary.totalDurationMs - prev.summary.totalDurationMs,
  };
}

function summaryFailed(r: RunRecord): number {
  return r.summary.failed;
}
