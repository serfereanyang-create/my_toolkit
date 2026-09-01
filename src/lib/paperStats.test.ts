import { describe, expect, it } from 'vitest';
import { buildPaperStats, STATUS_ORDER, RELIABILITY_ORDER } from './paperStats';
import type { Paper, Evidence } from '../types/paperApp';

const ev = (reliability: Evidence['reliability']): Evidence => ({
  id: `e-${Math.random()}`, claim: 'c', support: '', locator: '', reliability, tags: [],
});

const paper = (overrides: Partial<Paper> = {}): Paper => ({
  id: 'p1', title: 'T', authors: 'A', year: '2026', source: 'S', doi: '', url: 'https://x',
  status: '未读', tags: [], question: '', method: '', dataset: '', findings: '',
  limitations: '', credibility: '', evidence: [], checklist: {},
  ...overrides,
});

describe('buildPaperStats', () => {
  it('returns zeroed structure for empty library', () => {
    const stats = buildPaperStats([]);
    expect(stats.total).toBe(0);
    expect(stats.evidenceTotal).toBe(0);
    expect(stats.issueTotal).toBe(0);
    expect(stats.checklistCompletion).toBe(0);
    expect(stats.byStatus.map((s) => s.status)).toEqual([...STATUS_ORDER]);
    expect(stats.byStatus.every((s) => s.count === 0)).toBe(true);
    expect(stats.byReliability.map((r) => r.level)).toEqual([...RELIABILITY_ORDER]);
    expect(stats.byYear).toEqual([]);
    expect(stats.topTags).toEqual([]);
  });

  it('counts status distribution in fixed order', () => {
    const stats = buildPaperStats([
      paper({ id: '1', status: '精读' }),
      paper({ id: '2', status: '精读' }),
      paper({ id: '3', status: '未读' }),
    ]);
    expect(stats.byStatus.find((s) => s.status === '精读')?.count).toBe(2);
    expect(stats.byStatus.find((s) => s.status === '未读')?.count).toBe(1);
    expect(stats.byStatus.map((s) => s.status)).toEqual([...STATUS_ORDER]);
  });

  it('aggregates evidence reliability across papers', () => {
    const stats = buildPaperStats([
      paper({ id: '1', evidence: [ev('高'), ev('中')] }),
      paper({ id: '2', evidence: [ev('高')] }),
    ]);
    expect(stats.evidenceTotal).toBe(3);
    expect(stats.byReliability.find((r) => r.level === '高')?.count).toBe(2);
    expect(stats.byReliability.find((r) => r.level === '中')?.count).toBe(1);
    expect(stats.byReliability.find((r) => r.level === '低')?.count).toBe(0);
  });

  it('sorts years ascending and puts invalid years under 未标注 last', () => {
    const stats = buildPaperStats([
      paper({ id: '1', year: '2024' }),
      paper({ id: '2', year: '2020' }),
      paper({ id: '3', year: '' }),
      paper({ id: '4', year: 'n/a' }),
    ]);
    expect(stats.byYear.map((y) => y.year)).toEqual(['2020', '2024', '未标注']);
    expect(stats.byYear.find((y) => y.year === '未标注')?.count).toBe(2);
  });

  it('ranks tags by frequency then zh name, dedupes within a paper, caps at 10', () => {
    const stats = buildPaperStats([
      paper({ id: '1', tags: ['nlp', 'nlp', '机器学习'] }),
      paper({ id: '2', tags: ['nlp'] }),
      paper({ id: '3', tags: ['  '] }),
      ...Array.from({ length: 12 }, (_, i) => paper({ id: `x${i}`, tags: [`t${i}`] })),
    ]);
    expect(stats.topTags[0]).toEqual({ tag: 'nlp', count: 2 });
    expect(stats.topTags.length).toBeLessThanOrEqual(10);
    expect(stats.topTags.some((t) => t.tag.trim() === '')).toBe(false);
  });

  it('averages checklist completion across papers', () => {
    const stats = buildPaperStats([
      paper({ id: '1', checklist: { 研究问题明确: true, 方法可复现: true } }),
      paper({ id: '2', checklist: {} }),
    ]);
    expect(stats.checklistCompletion).toBeGreaterThan(0);
    expect(stats.checklistCompletion).toBeLessThan(1);
  });

  it('counts citation issues using shared inspectCitation', () => {
    const stats = buildPaperStats([paper({ id: '1', authors: '', doi: '', url: '' })]);
    expect(stats.issueTotal).toBeGreaterThanOrEqual(2);
  });
});
