export type MemoryKind = 'convention' | 'decision' | 'pitfall' | 'note';

export type MemorySource = {
  type: 'task' | 'user' | 'system';
  boardId?: string;
  taskId?: string;
};

export type ProjectMemoryEntry = {
  id: string;
  kind: MemoryKind;
  summary: string;
  keywords: string[];
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};

export type ProjectMemoryFile = {
  version: 1;
  updatedAt: string;
  entries: ProjectMemoryEntry[];
};

export type NewMemoryInput = {
  kind: MemoryKind;
  summary: string;
  keywords?: string[];
  source: MemorySource;
  nowIso?: string;
};
