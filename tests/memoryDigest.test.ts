import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectMemoryEntry } from '../src/memory/types.js';
import { planDigest, mergeSummaries } from '../src/memory/memoryDigest.js';

const mk = (overrides: Partial<ProjectMemoryEntry>): ProjectMemoryEntry => ({
  id: 'id',
  kind: 'note',
  summary: 's',
  keywords: [],
  source: { type: 'system' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  ...overrides,
});

test('planDigest merges same-group entries into the newest', () => {
  const e1 = mk({ id: 'old', kind: 'convention', summary: 'always use tabs；旧写法', keywords: ['tabs'], updatedAt: '2026-01-01T00:00:00Z' });
  const e2 = mk({ id: 'new', kind: 'convention', summary: 'always use tabs；新写法', keywords: ['tabs'], updatedAt: '2026-06-01T00:00:00Z' });
  const plan = planDigest([e1, e2]);
  const oldPlan = plan.entries.find((p) => p.id === 'old')!;
  const newPlan = plan.entries.find((p) => p.id === 'new')!;
  assert.equal(oldPlan.action, 'merge');
  assert.equal(oldPlan.mergeInto, 'new');
  assert.equal(newPlan.action, 'keep');
  assert.equal(plan.stats.merge, 1);
});

test('planDigest archives stale notes but keeps fresh conventions', () => {
  const stale = mk({ id: 'stale', kind: 'note', summary: '很久以前的笔记', keywords: ['stale-topic'], createdAt: '2024-01-01T00:00:00Z' });
  const fresh = mk({ id: 'fresh', kind: 'note', summary: '最近笔记', keywords: ['fresh-topic'], createdAt: new Date().toISOString() });
  const conv = mk({ id: 'conv', kind: 'convention', summary: '约定', keywords: ['conv-topic'], createdAt: '2024-01-01T00:00:00Z' });
  const plan = planDigest([stale, fresh, conv], { staleNoteDays: 120 });
  assert.equal(plan.entries.find((p) => p.id === 'stale')!.action, 'archive');
  assert.equal(plan.entries.find((p) => p.id === 'fresh')!.action, 'keep');
  // convention 不因陈旧归档
  assert.equal(plan.entries.find((p) => p.id === 'conv')!.action, 'keep');
});

test('planDigest archives oversized single entries', () => {
  const huge = mk({ id: 'huge', kind: 'decision', summary: 'x'.repeat(500) });
  const plan = planDigest([huge], { oversizedSummary: 480 });
  assert.equal(plan.entries[0]!.action, 'archive');
});

test('mergeSummaries dedupes sentences and truncates', () => {
  const keeper = mk({ id: 'k', summary: '统一用 tabs；缩进 2 空格' });
  const source = mk({ id: 's', summary: '统一用 tabs；行尾不留空白' });
  const merged = mergeSummaries(keeper, [source]);
  assert.equal(merged.split('；').length, 3, '重复句段去重');
  assert.ok(merged.includes('行尾不留空白'));

  const long = mergeSummaries(mk({ id: 'k', summary: 'y'.repeat(200) }), [mk({ id: 's', summary: 'z'.repeat(200) })]);
  assert.ok(long.length <= 240);
  assert.ok(long.endsWith('...'));
});
