export type BoardStatus = 'draft' | 'active' | 'completed' | 'blocked' | 'cancelled';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled' | 'skipped';

export type TaskVerificationAttempt = {
  id: string;
  phase: 'initial' | 'repair';
  status: 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled' | 'incomplete';
  startedAt: string;
  finishedAt?: string;
  summary: string;
  results: import('./verify.js').VerifyCommandResult[];
};

export type TaskItem = {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  dependsOn: string[];
  acceptance?: string;
  resultSummary?: string;
  verification?: TaskVerificationAttempt[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  /** 本任务使用的专家 ID（用于调试和日志） */
  expertId?: string;
  /** 专家路由置信度 (0-1) */
  expertConfidence?: number;
};

export type TaskBoard = {
  error?: string;
  id: string;
  title: string;
  goal: string;
  status: BoardStatus;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  gitBranch?: string;
  gitCommitSha?: string;
  /**
   * The plan document the model wrote, in Markdown.
   *
   * Written by `propose_plan` when the model genuinely plans the work. Absent on
   * boards built from the fallback template (`planBoardFromGoal`), which has no
   * prose body — the desktop renders the plan section only when this is present.
   */
  planMarkdown?: string;
  tasks: TaskItem[];
};

export type TaskRuntimeMode = 'idle' | 'planning' | 'awaiting_confirm' | 'executing' | 'paused';

export type TaskRuntimeState = {
  boardId?: string;
  activeTaskId?: string;
  mode: TaskRuntimeMode;
  lastSyncAt?: string;
};

export type TaskBoardIndexEntry = {
  id: string;
  title: string;
  status: BoardStatus;
  updatedAt: string;
};
