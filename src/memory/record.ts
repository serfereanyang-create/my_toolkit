import type { TaskItem } from '../tasks/types.js';
import { extractMemoryCandidates } from './extract.js';
import type { ProjectMemoryStore } from './store.js';
import type { ProjectMemoryEntry } from './types.js';

export async function maybeRecordTaskMemory(options: {
  store: ProjectMemoryStore;
  boardId: string;
  task: TaskItem;
  onWarn?: (message: string) => void;
}): Promise<ProjectMemoryEntry[]> {
  if (options.task.status !== 'done' && options.task.status !== 'blocked') return [];
  try {
    const existing = await options.store.list({ includeInactive: true });
    const candidates = extractMemoryCandidates({
      boardId: options.boardId,
      taskId: options.task.id,
      status: options.task.status,
      resultSummary: options.task.resultSummary,
      error: options.task.error,
      existing,
    });
    const created: ProjectMemoryEntry[] = [];
    for (const candidate of candidates) {
      created.push(await options.store.add(candidate));
    }
    return created;
  } catch (error) {
    options.onWarn?.(`Project memory update failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
