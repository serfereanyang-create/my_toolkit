import { useCallback, useEffect, useState } from 'react';
import { GitBranch, GitCommitHorizontal, ListTodo } from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { GitStatus } from '../lib/ipc';
import type { AppState } from '../types';
import { formatGoalElapsed, taskProgress, gitChangedFileCount } from '../lib/gitPanelFormat';
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

  const refresh = useCallback(async () => {
    try {
      // Only the tree's status is needed here; the diff totals belonged to the
      // chip before it became per-conversation, and polling them every 6s for
      // numbers nobody renders was pure waste.
      const s = await desktop.git.status();
      setStatus(s.ok ? s : null);
    } catch { /* the capsule just shows less */ }
  }, []);

  // Poll the tree so the chip tracks edits the agent makes during a turn.
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 6000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const board = state.taskBoard;
  const changedFiles = gitChangedFileCount(status);
  const sessionTotals = sessionChangeTotals(state.chat);
  const progress = board ? taskProgress(board.tasks).label : null;
  const elapsed = board?.startedAt ? formatGoalElapsed(Date.now() - board.startedAt) : null;

  return (
    <div className={`git-capsule ${active ? 'active' : ''}`} role="group" aria-label="Git 工具">
      <button
        type="button"
        className="git-capsule-seg"
        onClick={() => onOpen({ kind: 'changes' })}
        title={sessionTotals
          ? `本会话改动：+${sessionTotals.added} −${sessionTotals.removed}${changedFiles > 0 ? `；工作区另有 ${changedFiles} 个未提交文件` : ''}`
          : changedFiles > 0 ? `${changedFiles} 个未提交文件（本会话未改动）` : '查看文件变更'}
      >
        <GitCommitHorizontal size={13} />
        <span className="git-capsule-label">更改</span>
        {/* The chip is per-conversation, so it shows only this conversation's
            numbers — never the repository's. A fresh chat used to inherit the
            working tree's totals and therefore showed the same +2945 −212 in
            every new conversation, which read as if that chat had done the
            work. Uncommitted work from outside this chat is still discoverable:
            it is named in the tooltip and listed in the 更改 inspector. */}
        {sessionTotals ? (
          <span className="git-capsule-nums" title="本次会话累计改动">
            <span className="insp-add">+{sessionTotals.added}</span>
            <span className="insp-del">−{sessionTotals.removed}</span>
          </span>
        ) : changedFiles > 0 ? (
          <span className="git-capsule-muted" title={`工作区有 ${changedFiles} 个未提交文件，不属于本会话`}>
            工作区 {changedFiles}
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
