import { deriveKeywords, truncateSummary } from './store.js';
import type { MemoryKind, NewMemoryInput, ProjectMemoryEntry } from './types.js';

export function extractMemoryCandidates(input: {
  boardId: string;
  taskId: string;
  status: 'done' | 'blocked';
  resultSummary?: string;
  error?: string;
  existing: ProjectMemoryEntry[];
  nowIso?: string;
}): NewMemoryInput[] {
  const text = input.status === 'done' ? input.resultSummary ?? '' : input.error ?? '';
  const summary = truncateSummary(text.replace(/^TASK_DONE:\s*/i, ''));
  if (!isUsefulMemoryText(summary)) return [];
  if (isDuplicateMemory(input.existing, summary)) return [];

  const kind = input.status === 'blocked' ? 'pitfall' : classifySuccessKind(summary);
  return [{
    kind,
    summary,
    keywords: deriveKeywords(summary),
    source: { type: 'task', boardId: input.boardId, taskId: input.taskId },
    nowIso: input.nowIso,
  }];
}

export function isUsefulMemoryText(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.length < 12) return false;
  if (['ok', 'done', 'completed', 'finished', 'task_done: ok', 'task_done: done'].includes(normalized)) return false;
  if (/^(task_done:\s*)?(ok|done|completed|finished)\.?$/.test(normalized)) return false;
  return true;
}

export function isDuplicateMemory(existing: ProjectMemoryEntry[], summary: string) {
  const normalized = normalizeSummary(summary);
  return existing.some((entry) => {
    if (!entry.active) return false;
    const other = normalizeSummary(entry.summary);
    return other === normalized || other.includes(normalized) || normalized.includes(other);
  });
}

function classifySuccessKind(summary: string): MemoryKind {
  const normalized = summary.toLowerCase();
  if (hasAny(normalized, ['约定', 'convention', 'always use', '必须使用'])) return 'convention';
  if (hasAny(normalized, ['use ', 'must', 'never', '不要', '必须', '测试用', 'prefer'])) return 'decision';
  return 'note';
}

function normalizeSummary(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}
