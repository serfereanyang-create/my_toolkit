import type { ProjectMemoryEntry } from './types.js';

export function formatMemories(entries: ProjectMemoryEntry[]) {
  if (entries.length === 0) return 'Project memory: (none)';
  return [
    'Project memory:',
    ...entries.map((entry) => `- [${entry.kind}] ${entry.summary}`),
  ].join('\n');
}

export function formatMemoryList(entries: ProjectMemoryEntry[]) {
  if (entries.length === 0) return 'No active project memory entries.';
  return entries.map((entry) => `${entry.id} [${entry.kind}] ${entry.summary}`).join('\n');
}
