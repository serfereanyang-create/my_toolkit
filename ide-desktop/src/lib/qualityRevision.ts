/**
 * qualityRevision.ts — 质量分析结果的工作区版本戳
 *
 * 分析完成时捕获工作区 revision（分支 + HEAD + 脏文件数），面板可见期间
 * 轮询比较；一旦工作区前进（新提交/文件状态变化），结果标记为过期，
 * 由面板展示"重新分析"入口，而不是展示悄悄失效的旧数据。
 */
import { useEffect, useState } from 'react';
import { desktop } from './ipc';

export type WorkspaceRevision = {
  branch?: string;
  head?: string;
  dirtyCount: number;
  /** Stable label stamped onto analysis results. */
  label: string;
};

export async function getWorkspaceRevision(): Promise<WorkspaceRevision> {
  const [status, log] = await Promise.all([
    desktop.git.status().catch(() => null),
    desktop.git.log(1).catch(() => null),
  ]);
  const branch = status?.ok ? status.branch : undefined;
  const head = log?.ok && log.commits?.[0] ? log.commits[0].shortHash : undefined;
  const dirtyCount = status?.ok
    ? (status.staged?.length ?? 0) + (status.unstaged?.length ?? 0) + (status.untracked?.length ?? 0)
    : 0;
  return {
    branch,
    head,
    dirtyCount,
    label: `${branch ?? 'no-git'}@${head ?? '-'}@${dirtyCount}`,
  };
}

export function useQualityRevision(active: boolean) {
  const [current, setCurrent] = useState<WorkspaceRevision | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const poll = () => {
      getWorkspaceRevision()
        .then((rev) => { if (!cancelled) setCurrent(rev); })
        .catch(() => { /* git unavailable: revision guard disabled */ });
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active]);

  /** Stamp the freshly-fetched revision onto the just-completed analysis. */
  const capture = async (): Promise<void> => {
    try {
      const rev = await getWorkspaceRevision();
      setCurrent(rev);
      setCaptured(rev.label);
    } catch {
      setCaptured(null);
    }
  };

  return {
    capture,
    current,
    stale: captured !== null && current !== null && current.label !== captured,
  };
}
