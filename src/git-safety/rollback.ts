import { rmdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { GitAuditLog } from './audit.js';
import type { GitSnapshotDiff } from './diff.js';
import type { GitRepository } from './repository.js';
import type { GitSnapshotStore } from './snapshot.js';
import type {
  GitAuditEvent,
  GitPathChange,
  GitSnapshot,
  GitUnitOutcome,
  GitUnitRequest,
  GitUnitResult,
} from './types.js';
import { applyRestorePlan, type RestorePlanStep } from './restore.js';

export type RollbackPreview = {
  unitId: string;
  allowed: boolean;
  changes: GitPathChange[];
  conflicts: Array<{ path: string; reason: string }>;
};

export class GitRollbackService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly repository: GitRepository,
    private readonly snapshots: GitSnapshotStore,
    private readonly diff: GitSnapshotDiff,
    private readonly audit: GitAuditLog,
  ) {}

  async list(): Promise<GitUnitResult[]> {
    const { events } = await this.audit.read();
    return events
      .filter((event) => event.type === 'unit_finished' && event.unitId)
      .map((event) => eventToUnitResult(event))
      .filter((item): item is GitUnitResult => item !== undefined)
      .reverse();
  }

  async show(unitId: string): Promise<GitUnitResult | undefined> {
    return (await this.list()).find((item) => item.unitId === unitId);
  }

  async preview(unitId: string): Promise<RollbackPreview> {
    const unit = await this.show(unitId);
    if (!unit?.baseline || !unit.result || !unit.repository) {
      return {
        unitId,
        allowed: false,
        changes: [],
        conflicts: [{ path: unitId, reason: 'Missing completed baseline/result snapshots for unit.' }],
      };
    }

    const conflicts = await this.conflictsFor(unit);
    const preview: RollbackPreview = {
      unitId,
      allowed: conflicts.length === 0,
      changes: unit.changes,
      conflicts,
    };

    await this.append({
      type: conflicts.length ? 'rollback_conflicted' : 'rollback_previewed',
      unitId,
      sessionId: unit.request.sessionId,
      boardId: unit.request.kind === 'task' ? unit.request.boardId : undefined,
      taskId: unit.request.kind === 'task' ? unit.request.taskId : undefined,
      turnId: unit.request.kind === 'turn' ? unit.request.turnId : undefined,
      changes: unit.changes,
      conflicts: conflicts.map((item) => `${item.path}: ${item.reason}`),
    });
    return preview;
  }

  /**
   * Conflict detection.
   *
   * A file counts as "still at the unit's result" when its worktree hash is
   * ANY of the recorded result ids (see `GitPathChange.resultOids`). The old
   * comparison used only the clean blob id, which never matches a CRLF
   * worktree on `core.autocrlf=true` — every Windows user saw a phantom
   * conflict and could not roll back at all.
   *
   * `allowRestoredIndex` is used by {@link apply}: applying the plan rewrites
   * the worktree first and leaves the index alone, so the per-step guard would
   * otherwise see the index of files already restored and abort the very
   * transaction it is guarding.
   */
  private async conflictsFor(unit: GitUnitResult, options: { allowRestoredIndex?: ReadonlySet<string> } = {}): Promise<Array<{ path: string; reason: string }>> {
    const conflicts: Array<{ path: string; reason: string }> = [];
    if (!unit.repository) return conflicts;
    const symlinks = await this.diff.symlinksSupported();
    for (const change of unit.changes) {
      const current = await this.diff.worktreeState(unit.repository, change.path);
      if (!matchesResult(change, current, symlinks)) {
        conflicts.push({ path: change.path, reason: 'Worktree no longer matches recorded result state.' });
        continue;
      }
      if (options.allowRestoredIndex?.has(change.path)) continue;
      const currentIndex = await this.diff.indexState(unit.repository, change.path);
      if (!sameIndex(currentIndex, change.resultIndex)) {
        conflicts.push({ path: change.path, reason: 'Index no longer matches recorded result index state.' });
      }
    }
    return conflicts;
  }

  async apply(unitId: string): Promise<{
    ok: boolean;
    preview: RollbackPreview;
    snapshot?: GitSnapshot;
    reason?: string;
    /** Present when the rollback failed AND the undo also failed: the
     *  workspace may be in an intermediate state. */
    intermediateState?: string;
  }> {
    const preview = await this.preview(unitId);
    if (!preview.allowed) {
      return { ok: false, preview, reason: 'Rollback blocked by conflicts.' };
    }

    const unit = await this.show(unitId);
    if (!unit?.baseline || !unit.result || !unit.repository) {
      return { ok: false, preview, reason: 'Unit snapshots are unavailable.' };
    }
    const repository = unit.repository;

    let preRollback: GitSnapshot | undefined;
    try {
      preRollback = await this.snapshots.create(repository, unit.unitId, 'pre-rollback');
      const planned = await this.loadRestorePlan(unit);
      const result = await applyRestorePlan({
        repositoryRoot: repository.root,
        steps: planned,
        // Re-check every target immediately before it is touched. Two turns
        // that overlap on one file both pass the preview; without this guard
        // the second rollback silently undoes the first one's restore.
        guard: async (context) => {
          const change = unit.changes.find((item) => item.path === context.path);
          if (!change) return;
          const current = await this.diff.worktreeState(repository, change.path);
          if (!matchesResult(change, current, await this.diff.symlinksSupported())) {
            throw new Error(`Worktree changed while rollback was running: ${change.path}`);
          }
        },
      });
      if (!result.ok) {
        const intermediate = result.undoError
          ? `Rollback failed (${result.error}) and the automatic undo also failed (${result.undoError}). The workspace may be in an intermediate state.`
          : `Rollback failed (${result.error}); all previously restored files were reverted, so the workspace is unchanged.`;
        await this.append({
          type: 'rollback_failed',
          unitId,
          sessionId: unit.request.sessionId,
          boardId: unit.request.kind === 'task' ? unit.request.boardId : undefined,
          taskId: unit.request.kind === 'task' ? unit.request.taskId : undefined,
          turnId: unit.request.kind === 'turn' ? unit.request.turnId : undefined,
          error: intermediate,
          snapshot: preRollback,
        });
        return {
          ok: false,
          preview,
          snapshot: preRollback,
          reason: `${intermediate} pre-rollback snapshot retained at ${preRollback.ref}`,
          ...(result.undoError ? { intermediateState: intermediate } : {}),
        };
      }
      await this.pruneEmptyDirs(unit);
      const rollbackSnapshot = await this.snapshots.create(repository, unit.unitId, 'rollback-result');
      await this.append({
        type: 'rollback_applied',
        unitId,
        sessionId: unit.request.sessionId,
        boardId: unit.request.kind === 'task' ? unit.request.boardId : undefined,
        taskId: unit.request.kind === 'task' ? unit.request.taskId : undefined,
        turnId: unit.request.kind === 'turn' ? unit.request.turnId : undefined,
        changes: unit.changes,
        snapshot: rollbackSnapshot,
        result: rollbackSnapshot,
      });
      return { ok: true, preview, snapshot: rollbackSnapshot };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.append({
        type: 'rollback_failed',
        unitId,
        sessionId: unit.request.sessionId,
        boardId: unit.request.kind === 'task' ? unit.request.boardId : undefined,
        taskId: unit.request.kind === 'task' ? unit.request.taskId : undefined,
        turnId: unit.request.kind === 'turn' ? unit.request.turnId : undefined,
        error: reason,
        snapshot: preRollback,
      });
      return {
        ok: false,
        preview,
        snapshot: preRollback,
        reason: preRollback
          ? `${reason}; pre-rollback snapshot retained at ${preRollback.ref}`
          : reason,
      };
    }
  }

  private async loadRestorePlan(unit: GitUnitResult): Promise<RestorePlanStep[]> {
    const plan: RestorePlanStep[] = [];
    const symlinks = await this.diff.symlinksSupported();
    for (const change of unit.changes) {
      if (!change.baseline.oid) {
        plan.push({ action: 'delete', path: change.path });
        continue;
      }
      const contents = await this.diff.worktreeBlob(unit.repository!, change.sourcePath ?? change.path, change.baseline.oid);
      plan.push(stepForBaseline(change.path, change.baseline.mode, contents, symlinks));
      if (change.sourcePath && change.sourcePath !== change.path) {
        // rename: the destination is new (delete), the source is restored.
        plan.push({ action: 'delete', path: change.path });
        plan.push(stepForBaseline(change.sourcePath, change.baseline.mode, contents, symlinks));
      }
    }
    return plan;
  }
  /**
   * Git itself leaves empty directories behind: a tree cannot store them. When
   * the only reason a directory exists is files the turn created, removing
   * those files must also remove the directory — otherwise the "byte for byte
   * like before the turn" promise is visibly false (`newdir/` still there).
   */
  private async pruneEmptyDirs(unit: GitUnitResult): Promise<void> {
    if (!unit.repository) return;
    const dirs = new Set<string>();
    for (const change of unit.changes) {
      if (change.baseline.oid) continue;
      let dir = dirname(change.path);
      while (dir && dir !== '.' && dir !== '/') {
        dirs.add(dir);
        dir = dirname(dir);
      }
    }
    const deepestFirst = [...dirs].sort((left, right) => right.length - left.length);
    for (const dir of deepestFirst) {
      // `rmdir` refuses non-empty directories; that is the safety we want.
      await rmdir(resolve(unit.repository.root, dir)).catch(() => undefined);
    }
  }

  private async append(partial: Partial<GitAuditEvent> & Pick<GitAuditEvent, 'type'>): Promise<void> {
    await this.audit.append({
      version: 1,
      id: `event_${cryptoRandomId()}`,
      timestamp: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      ...partial,
    });
  }
}

/**
 * Build one restore step. A symlink is only recreated as a real link when the
 * platform supports them; otherwise writing the target bytes is exactly what
 * `git checkout` does with `core.symlinks=false`, and both produce the same
 * clean-filtered blob.
 */
function stepForBaseline(path: string, mode: string | undefined, contents: Buffer, symlinks: boolean): RestorePlanStep {
  if (mode === '120000' && symlinks) {
    return { action: 'symlink', path, contents: contents.toString('utf8'), mode };
  }
  return { action: 'write', path, contents, mode };
}

function matchesResult(
  change: GitPathChange,
  current: { oid?: string; mode?: string; candidateOids?: string[] },
  symlinksSupported: boolean,
): boolean {
  const expectedMode = change.result.mode ?? null;
  const actualMode = current.mode ?? null;
  // `core.symlinks=false`: Git checks a 120000 entry out as a regular file, so
  // a recorded 120000 result legitimately appears as 100644 on disk. The
  // content identity below is what matters in that case.
  const modeEquivalent = actualMode === expectedMode
    || (!symlinksSupported && expectedMode === '120000' && actualMode === '100644');
  if (!modeEquivalent) return false;
  if (!change.result.oid) return !current.oid;
  if (!current.oid) return false;
  if (current.oid === change.result.oid) return true;
  return (change.resultOids ?? []).includes(current.oid);
}

function eventToUnitResult(event: GitAuditEvent): GitUnitResult | undefined {
  if (!event.unitId || !event.unitKind || !event.sessionId || !event.outcome) return undefined;
  const request = toRequest(event);
  if (!request) return undefined;
  return {
    unitId: event.unitId,
    request,
    protectionMode: event.protectionMode ?? 'file-checkpoint-only',
    repository: event.baseline?.repository ?? event.result?.repository,
    baseline: event.baseline,
    warnings: [],
    finished: true,
    outcome: event.outcome as GitUnitOutcome,
    result: event.result,
    changes: event.changes ?? [],
  };
}

function toRequest(event: GitAuditEvent): GitUnitRequest | undefined {
  if (!event.sessionId || !event.unitKind) return undefined;
  if (event.unitKind === 'turn') {
    if (!event.turnId) return undefined;
    return { kind: 'turn', sessionId: event.sessionId, turnId: event.turnId };
  }
  if (!event.boardId || !event.taskId) return undefined;
  return { kind: 'task', sessionId: event.sessionId, boardId: event.boardId, taskId: event.taskId };
}

function sameIndex(left: Array<{ path: string; mode: string; oid: string; stage: number }>, right: Array<{ path: string; mode: string; oid: string; stage: number }>) {
  if (left.length !== right.length) return false;
  const normalize = (items: typeof left) => items
    .map((item) => `${item.stage}:${item.mode}:${item.oid}:${item.path}`)
    .sort()
    .join('|');
  return normalize(left) === normalize(right);
}

function cryptoRandomId(): string {
  return `${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
}
