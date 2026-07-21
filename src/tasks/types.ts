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
