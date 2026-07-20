import { chmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { GitAuditLog } from './audit.js';
import type { GitSnapshotDiff } from './diff.js';
import { assertSafeRelativePath } from './git.js';
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

    const conflicts: Array<{ path: string; reason: string }> = [];
    for (const change of unit.changes) {
      const current = await this.diff.currentState(unit.repository, change.path);
      const expected = change.result;
      if ((current.oid ?? null) !== (expected.oid ?? null) || (current.mode ?? null) !== (expected.mode ?? null)) {
        conflicts.push({ path: change.path, reason: 'Worktree no longer matches recorded result state.' });
      }

      const currentIndex = await this.diff.indexState(unit.repository, change.path);
      if (!sameIndex(currentIndex, change.resultIndex)) {
        conflicts.push({ path: change.path, reason: 'Index no longer matches recorded result index state.' });
      }

      if (change.sourcePath) {
        const sourceCurrent = await this.diff.currentState(unit.repository, change.sourcePath);
        if (sourceCurrent.oid || sourceCurrent.mode) {
          // source may already be absent after rename; only conflict if unexpected content differs from baseline absence and baseline expected.
        }
      }
    }

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

  async apply(unitId: string): Promise<{ ok: boolean; preview: RollbackPreview; snapshot?: GitSnapshot; reason?: string }> {
    const preview = await this.preview(unitId);
    if (!preview.allowed) {
      return { ok: false, preview, reason: 'Rollback blocked by conflicts.' };
    }

    const unit = await this.show(unitId);
    if (!unit?.baseline || !unit.repository) {
      return { ok: false, preview, reason: 'Unit snapshots are unavailable.' };
    }

    let preRollback: GitSnapshot | undefined;
    try {
      preRollback = await this.snapshots.create(unit.repository, unit.unitId, 'pre-rollback');
      const planned = await this.loadRestorePlan(unit);
      for (const step of planned) {
        await this.applyStep(unit.repository.root, step);
      }
      const rollbackSnapshot = await this.snapshots.create(unit.repository, unit.unitId, 'rollback-result');
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

  private async loadRestorePlan(unit: GitUnitResult): Promise<Array<{ path: string; action: 'write' | 'delete' | 'symlink'; mode?: string; contents?: Buffer }>> {
    const plan: Array<{ path: string; action: 'write' | 'delete' | 'symlink'; mode?: string; contents?: Buffer }> = [];
    for (const change of unit.changes) {
      const targetPath = assertSafeRelativePath(change.path);
      if (!change.baseline.oid) {
        plan.push({ path: targetPath, action: 'delete' });
        continue;
      }
      const contents = await this.diff.blob(change.baseline.oid);
      if (change.baseline.mode === '120000') {
        plan.push({ path: targetPath, action: 'symlink', contents, mode: change.baseline.mode });
      } else {
        plan.push({ path: targetPath, action: 'write', contents, mode: change.baseline.mode });
      }
      if (change.sourcePath && change.sourcePath !== change.path && change.baseline.oid) {
        // rename: restore source if needed and delete destination handled above via path.
        const sourcePath = assertSafeRelativePath(change.sourcePath);
        plan.push({ path: sourcePath, action: change.baseline.mode === '120000' ? 'symlink' : 'write', contents, mode: change.baseline.mode });
        plan.push({ path: targetPath, action: 'delete' });
      }
    }
    return plan;
  }

  private async applyStep(repositoryRoot: string, step: { path: string; action: 'write' | 'delete' | 'symlink'; mode?: string; contents?: Buffer }) {
    const absolute = resolve(repositoryRoot, step.path);
    if (step.action === 'delete') {
      await rm(absolute, { force: true });
      return;
    }
    await mkdir(dirname(absolute), { recursive: true });
    if (step.action === 'symlink') {
      await rm(absolute, { force: true });
      await symlink(step.contents?.toString('utf8') ?? '', absolute);
      return;
    }
    await writeFile(absolute, step.contents ?? Buffer.alloc(0));
    if (step.mode === '100755') {
      try {
        await chmod(absolute, 0o755);
      } catch {
        // Windows may not support executable bit.
      }
    }
    // Ensure we did not leave a directory conflict.
    await lstat(absolute);
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
