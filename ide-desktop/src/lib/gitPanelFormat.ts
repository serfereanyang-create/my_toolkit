/**
 * gitPanelFormat — pure display helpers for the Codex-style Git tools card.
 * Kept separate so the elapsed-time and progress formatting is unit-testable
 * without rendering React.
 */

import type { GitStatus } from './ipc';

export function gitChangedFileCount(status: GitStatus | null): number {
  return new Set([
    ...(status?.staged ?? []).map((file) => file.path),
    ...(status?.unstaged ?? []).map((file) => file.path),
    ...(status?.untracked ?? []),
  ]).size;
}

/** Format ms as the Codex goal timer: "6小时 38分 50秒" / "38分 50秒" / "50秒". */
export function formatGoalElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}小时 ${m}分 ${s}秒`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}

/** "4/4" progress for a task list: done counts as done or skipped. */
export function taskProgress(tasks: Array<{ status: string }>): { done: number; total: number; label: string } {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  return { done, total, label: `${done}/${total}` };
}

/**
 * Sub-task progress for one stage row: children of a stage are its tasks.
 * Returns the same "n/m" shape; empty lists render "0/0".
 */
export function stageProgress(tasks: Array<{ status: string }>): string {
  return taskProgress(tasks).label;
}

/**
 * Group tasks into stages by dependency depth (same algorithm as TaskBoardCard):
 * a task with no deps is stage 1; otherwise 1 + max(parent stages), capped at 4.
 */
export function computeStages(
  tasks: Array<{ id: string; title: string; status: string; dependsOn: string[] }>,
): Array<{ stage: number; tasks: Array<{ id: string; title: string; status: string; dependsOn: string[] }> }> {
  const depth = (task: { id: string; dependsOn: string[] }, seen: Set<string>): number => {
    if (!task.dependsOn.length) return 1;
    if (seen.has(task.id)) return 1; // cycle guard
    seen.add(task.id);
    return Math.min(4, 1 + Math.max(...task.dependsOn.map((id) => {
      const parent = tasks.find((t) => t.id === id);
      return parent ? depth(parent, seen) : 0;
    })));
  };
  const grouped = new Map<number, Array<{ id: string; title: string; status: string; dependsOn: string[] }>>();
  for (const t of tasks) {
    const s = depth(t, new Set());
    grouped.set(s, [...(grouped.get(s) ?? []), t]);
  }
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([stage, items]) => ({ stage, tasks: items }));
}
