import type { ProjectMemoryEntry } from './types.js';
import { rankMemories } from './tokens.js';

export function selectRelevantMemories(input: {
  entries: ProjectMemoryEntry[];
  goal: string;
  taskTitle?: string;
  taskDetail?: string;
  limit?: number;
}): ProjectMemoryEntry[] {
  const limit = input.limit ?? 5;
  const scored = rankMemories(input.entries, `${input.goal} ${input.taskTitle ?? ''} ${input.taskDetail ?? ''}`);

  const hits = scored.filter((item) => item.hits > 0).sort(compareScore);
  if (hits.length > 0) return hits.slice(0, limit).map((item) => item.entry);

  return scored
    .filter((item) => item.entry.kind === 'convention' || item.entry.kind === 'decision')
    .sort(compareScore)
    .slice(0, Math.min(2, limit))
    .map((item) => item.entry);
}

function compareScore(a: { score: number; entry: ProjectMemoryEntry }, b: { score: number; entry: ProjectMemoryEntry }) {
  if (b.score !== a.score) return b.score - a.score;
  const byDate = b.entry.updatedAt.localeCompare(a.entry.updatedAt);
  if (byDate !== 0) return byDate;
  return b.entry.id.localeCompare(a.entry.id);
}
