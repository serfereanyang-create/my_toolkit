import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertObjectId,
  assertSafeCheckpointRef,
  type GitProcess,
} from './git.js';
import type { GitRepositoryInfo, GitSnapshot, GitSnapshotPhase } from './types.js';

const ZERO_OID = '0'.repeat(40);

export class GitSnapshotStore {
  constructor(
    private readonly git: GitProcess,
    private readonly workspaceRoot: string,
  ) {}

  async create(repository: GitRepositoryInfo, unitId: string, phase: GitSnapshotPhase): Promise<GitSnapshot> {
    const safeUnitId = assertUnitId(unitId);
    const ref = assertSafeCheckpointRef(`refs/aicode/checkpoints/${safeUnitId}/${phaseRefSuffix(phase)}`);
    const tempRoot = await mkdtemp(join(tmpdir(), 'aicode-git-index-'));
    const indexPath = join(tempRoot, 'index');
    const env = {
      GIT_INDEX_FILE: indexPath,
      GIT_AUTHOR_NAME: 'aicode checkpoint',
      GIT_AUTHOR_EMAIL: 'aicode@local.invalid',
      GIT_COMMITTER_NAME: 'aicode checkpoint',
      GIT_COMMITTER_EMAIL: 'aicode@local.invalid',
    };

    try {
      if (repository.head) {
        await this.git.text(['read-tree', repository.head], { env });
      } else {
        await this.git.text(['read-tree', '--empty'], { env });
      }

      const pathspec = repository.workspacePathspec;
      const excludeBase = pathspec === '.' ? '.aicode' : `${pathspec}/.aicode`;
      await this.git.text([
        'add',
        '-A',
        '--',
        pathspec,
        `:(exclude)${excludeBase}`,
        `:(exclude)${excludeBase}/**`,
      ], { env });

      const tree = assertObjectId((await this.git.text(['write-tree'], { env })).trim());
      const commitArgs = repository.head
        ? ['commit-tree', tree, '-p', repository.head]
        : ['commit-tree', tree];
      const commit = assertObjectId((await this.git.text(commitArgs, {
        env,
        stdin: `aicode ${phase} checkpoint for ${safeUnitId}\n`,
      })).trim());

      await this.git.text(['update-ref', ref, commit, ZERO_OID]);
      const createdAt = new Date().toISOString();
      return {
        id: `snap_${safeUnitId}_${phase}`,
        unitId: safeUnitId,
        phase,
        ref,
        commit,
        tree,
        createdAt,
        repository,
      };
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

function assertUnitId(unitId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(unitId)) throw new Error(`Unsafe Git safety unit id: ${unitId}`);
  return unitId;
}

function phaseRefSuffix(phase: GitSnapshotPhase): string {
  switch (phase) {
    case 'baseline':
      return 'baseline';
    case 'result':
      return 'result';
    case 'pre-rollback':
      return 'pre-rollback';
    case 'rollback-result':
      return 'rollback-result';
    default: {
      const exhaustive: never = phase;
      throw new Error(`Unsupported snapshot phase: ${String(exhaustive)}`);
    }
  }
}

export function snapshotTempDirHint(workspaceRoot: string) {
  return resolve(workspaceRoot, '.aicode', 'git-safety', 'tmp');
}
