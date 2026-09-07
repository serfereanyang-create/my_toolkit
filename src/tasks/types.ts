export type BoardStatus = 'draft' | 'active' | 'completed' | 'blocked' | 'cancelled';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled' | 'skipped';

export type TaskItem = {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  dependsOn: string[];
  acceptance?: string;
  resultSummary?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  /** 本任务使用的专家 ID（用于调试和日志） */
  expertId?: string;
  /** 专家路由置信度 (0-1) */
  expertConfidence?: number;
};

export type TaskBoard = {
  id: string;
  title: string;
  goal: string;
  status: BoardStatus;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  gitBranch?: string;
  gitCommitSha?: string;
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
