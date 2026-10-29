export type GitUnitKind = 'turn' | 'task';
export type GitUnitOutcome = 'done' | 'blocked' | 'failed' | 'cancelled';
export type GitProtectionMode = 'git' | 'file-checkpoint-only';
export type GitSnapshotPhase = 'baseline' | 'result' | 'pre-rollback' | 'rollback-result';
export type GitMode = '100644' | '100755' | '120000';

export type GitUnitRequest =
  | {
    kind: 'turn';
    sessionId: string;
    turnId: string;
    boardId?: never;
    taskId?: never;
  }
  | {
    kind: 'task';
    sessionId: string;
    boardId: string;
    taskId: string;
    turnId?: never;
  };

export type GitRepositoryInfo = {
  root: string;
  workspaceRoot: string;
  workspacePathspec: string;
  head?: string;
  branch?: string;
};

export type GitIndexEntry = {
  path: string;
  mode: string;
  oid: string;
  stage: number;
};

export type GitPathState = {
  path: string;
  oid?: string;
  mode?: GitMode;
};

export type GitPathChange = {
  kind: 'add' | 'modify' | 'delete' | 'rename' | 'type-change' | 'mode-change';
  path: string;
  sourcePath?: string;
  baseline: GitPathState;
  result: GitPathState;
  resultIndex: GitIndexEntry[];
  /**
   * Object ids that may describe the recorded RESULT state. The canonical
   * {@link GitPathState.oid} is the blob hash Git stored; a CRLF worktree
   * hashes to a different id than its clean-filtered blob, so the raw worktree
   * hash is carried here too. A worktree whose hash equals ANY candidate is
   * "unchanged since the unit ran".
   */
  resultOids?: string[];
};

export type GitSnapshot = {
  id: string;
  unitId: string;
  phase: GitSnapshotPhase;
  ref: string;
  commit: string;
  tree: string;
  createdAt: string;
  repository: GitRepositoryInfo;
};

export type GitUnitContext = {
  unitId: string;
  request: GitUnitRequest;
  protectionMode: GitProtectionMode;
  repository?: GitRepositoryInfo;
  baseline?: GitSnapshot;
  warnings: string[];
  finished?: boolean;
};

export type GitUnitResult = Omit<GitUnitContext, 'finished'> & {
  finished: true;
  outcome: GitUnitOutcome;
  result?: GitSnapshot;
  changes: GitPathChange[];
};

export type GitAuditEventType =
  | 'repository_init_requested'
  | 'repository_initialized'
  | 'repository_init_declined'
  | 'unit_started'
  | 'snapshot_created'
  | 'snapshot_failed'
  | 'unit_finished'
  | 'rollback_previewed'
  | 'rollback_conflicted'
  | 'rollback_applied'
  | 'rollback_failed'
  | 'push_requested'
  | 'push_declined'
  | 'push_succeeded'
  | 'push_failed';

export type GitAuditEvent = {
  version: 1;
  id: string;
  type: GitAuditEventType;
  timestamp: string;
  workspaceRoot: string;
  sessionId?: string;
  unitId?: string;
  unitKind?: GitUnitKind;
  turnId?: string;
  boardId?: string;
  taskId?: string;
  outcome?: GitUnitOutcome;
  protectionMode?: GitProtectionMode;
  baseline?: GitSnapshot;
  result?: GitSnapshot;
  snapshot?: Partial<GitSnapshot>;
  changes?: GitPathChange[];
  conflicts?: string[];
  remote?: string;
  localRef?: string;
  remoteBranch?: string;
  error?: string;
  errorTruncated?: boolean;
};
