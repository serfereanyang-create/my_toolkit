import type { ProjectMemoryEntry } from './types.js';

const kindWeight: Record<ProjectMemoryEntry['kind'], number> = {
  convention: 3,
  decision: 3,
  pitfall: 2,
  note: 1,
};

export function selectRelevantMemories(input: {
  entries: ProjectMemoryEntry[];
  goal: string;
  taskTitle?: string;
  taskDetail?: string;
  limit?: number;
}): ProjectMemoryEntry[] {
  const limit = input.limit ?? 5;
  const active = input.entries.filter((entry) => entry.active);
  const queryTokens = tokenize(`${input.goal} ${input.taskTitle ?? ''} ${input.taskDetail ?? ''}`);

  const scored = active.map((entry) => {
    const summaryTokens = tokenize(entry.summary);
    const keywordHits = entry.keywords.reduce((count, keyword) => count + (queryTokens.has(keyword) ? 1 : 0), 0);
    const summaryHits = [...queryTokens].reduce((count, token) => count + (summaryTokens.has(token) ? 1 : 0), 0);
    const score = keywordHits * 5 + summaryHits + kindWeight[entry.kind] + recencyBoost(entry.updatedAt);
    return { entry, score, keywordHits: keywordHits + summaryHits };
  });

  const hits = scored.filter((item) => item.keywordHits > 0).sort(compareScore);
  if (hits.length > 0) return hits.slice(0, limit).map((item) => item.entry);

  return scored
    .filter((item) => item.entry.kind === 'convention' || item.entry.kind === 'decision')
    .sort(compareScore)
    .slice(0, Math.min(2, limit))
    .map((item) => item.entry);
}

function tokenize(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  );
}

function recencyBoost(updatedAt: string) {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  return Math.max(0, 2 - ageDays / 30);
}

function compareScore(a: { score: number; entry: ProjectMemoryEntry }, b: { score: number; entry: ProjectMemoryEntry }) {
  if (b.score !== a.score) return b.score - a.score;
  const byDate = b.entry.updatedAt.localeCompare(a.entry.updatedAt);
  if (byDate !== 0) return byDate;
  return b.entry.id.localeCompare(a.entry.id);
}
