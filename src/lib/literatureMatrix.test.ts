import { describe, expect, it } from 'vitest';
import { buildLiteratureMatrix } from './literatureMatrix';
import type { Paper } from '../types/paperApp';

const HEADER = '| # | 论文 | 作者 | 年份 | 来源 | DOI | 状态 | 方法 | 数据/样本 | 关键发现 | 局限 |';
const RULE = '|---|---|---|---|---|---|---|---|---|---|---|';

const makePaper = (patch: Partial<Paper> = {}): Paper => ({
  id: 'p1',
  title: 'A',
  authors: 'X',
  year: '2026',
  source: 'J',
  doi: '10.1/x',
  url: '',
  status: '精读',
  tags: [],
  question: '',
  method: 'm',
  dataset: 'd',
  findings: 'f',
  limitations: 'l',
  credibility: '',
  evidence: [],
  checklist: {},
  ...patch,
});

describe('buildLiteratureMatrix', () => {
  it('空列表返回仅表头的矩阵（没有论文占位）', () => {
    expect(buildLiteratureMatrix([])).toBe(`${HEADER}\n${RULE}\n| - | 没有论文 | | | | | | | | | |\n`);
    expect(buildLiteratureMatrix(null)).toContain('没有论文');
    expect(buildLiteratureMatrix(undefined)).toContain('没有论文');
  });

  it('非空结果以精确表头和分隔行开头', () => {
    const md = buildLiteratureMatrix([makePaper()]);
    const lines = md.split('\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(RULE);
  });

  it('单元格中的竖线被转义', () => {
    const md = buildLiteratureMatrix([makePaper({ title: 'A|B' })]);
    expect(md).toContain('A\\|B');
    expect(md).not.toMatch(/(^|\s)A\|B/);
  });

  it('单元格中的换行被折叠为空格', () => {
    const md = buildLiteratureMatrix([makePaper({ method: 'm1\nm2', findings: 'f1\r\nf2' })]);
    expect(md).toContain('m1 m2');
    expect(md).toContain('f1 f2');
    expect(md).not.toContain('m1\nm2');
  });

  it('页脚包含共 N 篇与日期，末尾保留换行', () => {
    const md = buildLiteratureMatrix([makePaper({ id: 'p1' }), makePaper({ id: 'p2' })]);
    expect(md).toContain('共 2 篇');
    expect(md).toMatch(/> 文献矩阵：共 2 篇，生成于 \d{4}-\d{2}-\d{2}。/);
    expect(md.endsWith('\n')).toBe(true);
  });

  it('行号从 1 开始递增', () => {
    const md = buildLiteratureMatrix([makePaper({ title: 'P1' }), makePaper({ title: 'P2' })]);
    expect(md).toContain('| 1 | P1 |');
    expect(md).toContain('| 2 | P2 |');
  });
});
