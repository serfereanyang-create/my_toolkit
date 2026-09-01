import { describe, expect, it } from 'vitest';
import { inspectCitation } from './citationIssues';
import type { Paper } from '../types/paperApp';

const paper = (overrides: Partial<Paper> = {}): Paper => ({
  id: 'p1', title: 'T', authors: 'A', year: '2026', source: 'S', doi: '10.1/a', url: '',
  status: '未读', tags: [], question: '', method: '', dataset: '', findings: '',
  limitations: '', credibility: '', evidence: [], checklist: {},
  ...overrides,
});

describe('inspectCitation', () => {
  it('reports nothing when required fields are present', () => {
    expect(inspectCitation(paper(), [paper()])).toEqual([]);
  });

  it('reports missing author, year and source', () => {
    const issues = inspectCitation(paper({ authors: ' ', year: '', source: '' }), []);
    expect(issues.some((i) => i.includes('缺少作者'))).toBe(true);
    expect(issues.some((i) => i.includes('缺少年份'))).toBe(true);
    expect(issues.some((i) => i.includes('缺少来源'))).toBe(true);
  });

  it('requires at least one of DOI or URL', () => {
    const issues = inspectCitation(paper({ doi: '', url: '' }), []);
    expect(issues.some((i) => i.includes('DOI 和 URL 至少补一个'))).toBe(true);
    expect(inspectCitation(paper({ doi: '', url: 'https://x' }), []).length).toBe(0);
  });

  it('flags duplicate DOI across other papers (case-insensitive)', () => {
    const a = paper({ id: 'a', doi: '10.1/X' });
    const b = paper({ id: 'b', doi: '10.1/x' });
    expect(inspectCitation(a, [a, b]).some((i) => i.includes('DOI 与其他卡片重复'))).toBe(true);
  });

  it('uses 未命名论文 prefix when title empty', () => {
    const issues = inspectCitation(paper({ title: '', authors: '' }), []);
    expect(issues[0].startsWith('未命名论文:')).toBe(true);
  });
});
