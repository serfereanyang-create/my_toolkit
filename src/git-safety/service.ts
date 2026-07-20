import { randomUUID } from 'node:crypto';
import type { GitAuditLog } from './audit.js';
import type { GitSnapshotDiff } from './diff.js';
import type { GitRepository } from './repository.js';
import type { GitSnapshotStore } from './snapshot.js';
import type {
  GitAuditEvent,
  GitPathChange,
  GitSnapshot,
  GitUnitContext,
  GitUnitOutcome,
  GitUnitRequest,
  GitUnitResult,
} from './types.js';

export class GitSafetyService {
  private readonly finished = new Map<string, GitUnitResult>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly repository: GitRepository,
    private readonly snapshots: GitSnapshotStore,
    private readonly diff: GitSnapshotDiff,
    private readonly audit: GitAuditLog,
  ) {}

  async startUnit(
    request: GitUnitRequest,
    options?: { confirm?: (message: string) => Promise<boolean>; onWarning?: (message: string) => void },
  ): Promise<GitUnitContext> {
    validateRequest(request);
    const unitId = `unit_${Date.now()}_${randomUUID().slice(0, 8)}`;
    await this.append({
      type: 'unit_started',
      unitId,
      unitKind: request.kind,
      sessionId: request.sessionId,
      turnId: request.kind === 'turn' ? request.turnId : undefined,
      boardId: request.kind === 'task' ? request.boardId : undefined,
      taskId: request.kind === 'task' ? request.taskId : undefined,
    });

    let repositoryInfo;
    try {
      repositoryInfo = await this.repository.ensure(options?.confirm);
    } catch (error) {
      const message = errorMessage(error);
      options?.onWarning?.(message);
      await this.append({
        type: 'snapshot_failed',
        unitId,
        unitKind: request.kind,
        sessionId: request.sessionId,
        error: message,
      });
      return {
        unitId,
        request,
        protectionMode: 'file-checkpoint-only',
        warnings: [message],
      };
    }

    if (!repositoryInfo) {
      await this.append({
        type: 'repository_init_declined',
        unitId,
        unitKind: request.kind,
        sessionId: request.sessionId,
        protectionMode: 'file-checkpoint-only',
      });
      return {
        unitId,
        request,
        protectionMode: 'file-checkpoint-only',
        warnings: ['Git repository unavailable; using file checkpoints only.'],
      };
    }

    try {
      const baseline = await this.snapshots.create(repositoryInfo, unitId, 'baseline');
      await this.append({
        type: 'snapshot_created',
        unitId,
        unitKind: request.kind,
        sessionId: request.sessionId,
        protectionMode: 'git',
        baseline,
        snapshot: baseline,
      });
      return {
        unitId,
        request,
        protectionMode: 'git',
        repository: repositoryInfo,
        baseline,
        warnings: [],
      };
    } catch (error) {
      const message = errorMessage(error);
      options?.onWarning?.(message);
      await this.append({
        type: 'snapshot_failed',
        unitId,
        unitKind: request.kind,
        sessionId: request.sessionId,
        protectionMode: 'file-checkpoint-only',
        error: message,
      });
      return {
        unitId,
        request,
        protectionMode: 'file-checkpoint-only',
        repository: repositoryInfo,
        warnings: [message],
      };
    }
  }

  async finishUnit(context: GitUnitContext, outcome: GitUnitOutcome): Promise<GitUnitResult> {
    const existing = this.finished.get(context.unitId);
    if (existing || context.finished) {
      return existing ?? {
        ...context,
        finished: true,
        outcome,
        changes: [],
      };
    }

    const warnings = [...context.warnings];
    let resultSnapshot: GitSnapshot | undefined;
    let changes: GitPathChange[] = [];
    let repository = context.repository;

    if (!repository) {
      repository = await this.repository.discover();
    }

    if (repository) {
      try {
        resultSnapshot = await this.snapshots.create(repository, context.unitId, 'result');
        await this.append({
          type: 'snapshot_created',
          unitId: context.unitId,
          unitKind: context.request.kind,
          sessionId: context.request.sessionId,
          protectionMode: context.protectionMode,
          result: resultSnapshot,
          snapshot: resultSnapshot,
        });
        if (context.baseline) {
          changes = await this.diff.manifest(repository, context.baseline, resultSnapshot);
        }
      } catch (error) {
        const message = errorMessage(error);
        warnings.push(message);
        await this.append({
          type: 'snapshot_failed',
          unitId: context.unitId,
          unitKind: context.request.kind,
          sessionId: context.request.sessionId,
          error: message,
        });
      }
    }

    const finished: GitUnitResult = {
      unitId: context.unitId,
      request: context.request,
      protectionMode: context.protectionMode,
      repository,
      baseline: context.baseline,
      warnings,
      finished: true,
      outcome,
      result: resultSnapshot,
      changes,
    };

    await this.append({
      type: 'unit_finished',
      unitId: context.unitId,
      unitKind: context.request.kind,
      sessionId: context.request.sessionId,
      turnId: context.request.kind === 'turn' ? context.request.turnId : undefined,
      boardId: context.request.kind === 'task' ? context.request.boardId : undefined,
      taskId: context.request.kind === 'task' ? context.request.taskId : undefined,
      outcome,
      protectionMode: finished.protectionMode,
      baseline: finished.baseline,
      result: finished.result,
      changes: finished.changes,
    });

    this.finished.set(context.unitId, finished);
    return finished;
  }

  private async append(partial: Partial<GitAuditEvent> & Pick<GitAuditEvent, 'type'>): Promise<void> {
    await this.audit.append({
      version: 1,
      id: `event_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      ...partial,
    });
  }
}

function validateRequest(request: GitUnitRequest): void {
  if (request.kind === 'turn') {
    if (!request.turnId) throw new Error('turn Git safety units require turnId');
    return;
  }
  if (!request.boardId || !request.taskId) throw new Error('task Git safety units require boardId and taskId');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
