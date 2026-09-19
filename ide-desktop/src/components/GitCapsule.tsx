import { useCallback, useEffect, useState } from 'react';
import { GitBranch, GitCommitHorizontal, ListTodo } from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { GitStatus } from '../lib/ipc';
import type { AppState } from '../types';
import { formatGoalElapsed, taskProgress } from '../lib/gitPanelFormat';
import { sessionChangeTotals } from '../lib/state';
import type { InspectorLevel } from '../lib/inspectorNav';

/*
 * GitCapsule — the per-session Git chip in the conversation's top-right.
 *
 * It belongs to the conversation, not to a global Git page: each session shows
 * its own working-tree state, and clicking a segment opens the right-hand
 * inspector directly at that level. The capsule is the entry point, the
 * inspector is where the detail lives.
 *
 * Numbers prefer the working tree (what is uncommitted right now) and fall
 * back to this session's own edits when the tree is clean, so the chip still
 * says something useful after the work is committed.
 */

export function GitCapsule({
  state,
  active,
  onOpen,
}: {
  state: AppState;
  /** True while the inspector is showing, so the chip reads as engaged. */
  active: boolean;
  onOpen: (level: InspectorLevel) => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [stats, setStats] = useState<{ added: number; removed: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([desktop.git.status(), desktop.git.diffStats()]);
      setStatus(s.ok ? s : null);
      if (d.ok) setStats({ added: d.added ?? 0, removed: d.removed ?? 0 });
    } catch { /* the capsule just shows less */ }
  }, []);

  // Poll the tree so the chip tracks edits the agent makes during a turn.
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 6000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const board = state.taskBoard;
  const changedFiles = status
    ? (status.staged?.length ?? 0) + (status.unstaged?.length ?? 0) + (status.untracked?.length ?? 0)
    : 0;
  const sessionTotals = sessionChangeTotals(state.chat);
  const progress = board ? taskProgress(board.tasks).label : null;
  const elapsed = board?.startedAt ? formatGoalElapsed(Date.now() - board.startedAt) : null;

  return (
    <div className={`git-capsule ${active ? 'active' : ''}`} role="group" aria-label="Git 工具">
      <button
        type="button"
        className="git-capsule-seg"
        onClick={() => onOpen({ kind: 'changes' })}
        title={changedFiles > 0 ? `${changedFiles} 个文件已更改` : '查看文件变更'}
      >
        <GitCommitHorizontal size={13} />
        <span className="git-capsule-label">更改</span>
        {changedFiles > 0 ? (
          <span className="git-capsule-nums">
            <span className="insp-add">+{stats?.added ?? changedFiles}</span>
            <span className="insp-del">−{stats?.removed ?? 0}</span>
          </span>
        ) : sessionTotals ? (
          // Tree is clean: show what THIS conversation changed instead.
          <span className="git-capsule-nums" title="本次会话累计改动">
            <span className="insp-add">+{sessionTotals.added}</span>
            <span className="insp-del">−{sessionTotals.removed}</span>
          </span>
        ) : (
          <span className="git-capsule-muted">干净</span>
        )}
      </button>

      <button
        type="button"
        className="git-capsule-seg"
        onClick={() => onOpen({ kind: 'branches' })}
        title={status?.branch ? `分支：${status.branch}` : '查看分支'}
      >
        <GitBranch size={13} />
        <span className="git-capsule-branch">{status?.branch ?? '—'}</span>
        {(status?.ahead ?? 0) > 0 && <span className="git-capsule-badge">↑{status!.ahead}</span>}
        {(status?.behind ?? 0) > 0 && <span className="git-capsule-badge">↓{status!.behind}</span>}
      </button>

      {board && (
        <button
          type="button"
          className="git-capsule-seg"
          onClick={() => onOpen({ kind: 'plan' })}
          title={board.goal || '查看计划'}
        >
          <ListTodo size={13} />
          <span className="git-capsule-label">计划</span>
          <span className="git-capsule-nums">
            {progress}{elapsed ? ` · ${elapsed}` : ''}
          </span>
        </button>
      )}
    </div>
  );
}
