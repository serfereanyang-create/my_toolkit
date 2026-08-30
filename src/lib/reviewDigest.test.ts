import { describe, expect, it } from 'vitest';
import {
  AI_CLAIM_LIMIT,
  AI_FIELD_LIMIT,
  AI_MAX_EVIDENCE,
  AI_REVIEW_MAX_PAPERS,
  REVIEW_SYSTEM_PROMPT,
  buildReviewDigest,
  buildReviewMessages,
} from './reviewDigest';
import type { Evidence, Paper } from '../types/paperApp';

let seq = 0;

const makePaper = (overrides: Partial<Paper> = {}): Paper => {
  seq += 1;
  return {
    id: `p${seq}`,
    title: `论文标题 ${seq}`,
    authors: '张三、李四',
    year: '2026',
    source: '示例期刊',
    doi: '',
    url: '',
    status: '已摘录',
    tags: [],
    question: '研究问题',
    method: '研究方法',
    dataset: '数据集',
    findings: '关键发现',
    limitations: '局限性',
    credibility: '高',
    evidence: [],
    checklist: {},
    ...overrides,
  };
};

const makeEvidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: `e${seq += 1}`,
  claim: '证据主张',
  support: '支持内容',
  locator: '第 3 页',
  reliability: '高',
  tags: [],
  ...overrides,
});

describe('buildReviewDigest (renderer mirror)', () => {
  it('truncates to max papers and marks truncated', () => {
    const papers = Array.from({ length: AI_REVIEW_MAX_PAPERS + 1 }, (_, i) =>
      makePaper({ id: `p${i}`, title: `T${i}` }),
    );
    const digest = buildReviewDigest(papers);
    expect(digest.truncated).toBe(true);
    expect(digest.selectedCount).toBe(AI_REVIEW_MAX_PAPERS);
    expect(digest.totalCount).toBe(AI_REVIEW_MAX_PAPERS + 1);
    expect(digest.groups.flatMap((group) => group.papers)).toHaveLength(AI_REVIEW_MAX_PAPERS);
  });

  it('cuts text fields to 400 chars and evidence to 8 items with claims cut to 200', () => {
    const evidence = Array.from({ length: AI_MAX_EVIDENCE + 3 }, (_, i) =>
      makeEvidence({
        id: `e${i}`,
        claim: '主'.repeat(AI_CLAIM_LIMIT + 33),
        locator: '定'.repeat(AI_CLAIM_LIMIT + 11),
      }),
    );
    const digest = buildReviewDigest([
      makePaper({
        question: '问'.repeat(AI_FIELD_LIMIT + 57),
        findings: '发'.repeat(AI_FIELD_LIMIT * 2),
        evidence,
      }),
    ]);

    const paper = digest.groups[0].papers[0];
    expect(paper.question).toHaveLength(AI_FIELD_LIMIT);
    expect(paper.findings).toHaveLength(AI_FIELD_LIMIT);
    expect(paper.evidence).toHaveLength(AI_MAX_EVIDENCE);
    expect(paper.evidence[0].claim).toHaveLength(AI_CLAIM_LIMIT);
    expect(paper.evidence[0].locator).toHaveLength(AI_CLAIM_LIMIT);
  });

  it('places a multi-tag paper into every group and untagged papers into 未分组', () => {
    const multi = makePaper({ id: 'multi', title: '多标签论文', tags: ['深度学习', '评估'] });
    const untagged = makePaper({ id: 'single', title: '无标签论文', tags: [] });
    const digest = buildReviewDigest([multi, untagged]);

    const tags = digest.groups.map((group) => group.tag);
    expect(new Set(tags)).toEqual(new Set(['深度学习', '评估', '未分组']));

    const deep = digest.groups.find((group) => group.tag === '深度学习');
    const evalGroup = digest.groups.find((group) => group.tag === '评估');
    const ungrouped = digest.groups.find((group) => group.tag === '未分组');
    expect(deep?.papers.map((paper) => paper.title)).toEqual(['多标签论文']);
    expect(evalGroup?.papers.map((paper) => paper.title)).toEqual(['多标签论文']);
    expect(ungrouped?.papers.map((paper) => paper.title)).toEqual(['无标签论文']);

    expect(tags).toEqual([...tags].sort((a, b) => a.localeCompare(b, 'zh')));
  });

  it('returns an empty digest for an empty library', () => {
    const digest = buildReviewDigest([]);
    expect(digest).toEqual({ totalCount: 0, selectedCount: 0, truncated: false, groups: [] });
  });
});

describe('buildReviewMessages', () => {
  it('emits a fixed system prompt and a user block with paper titles and output requirements', () => {
    const digest = buildReviewDigest([
      makePaper({
        id: 'm1',
        title: '注意力机制研究',
        tags: ['transformer'],
        evidence: [makeEvidence({ claim: '自注意力提升准确率', locator: '表 2' })],
      }),
    ]);
    const messages = buildReviewMessages(digest);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('科研综述助手');
    expect(messages[0].content).toBe(REVIEW_SYSTEM_PROMPT);

    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('注意力机制研究');
    expect(messages[1].content).toContain('输出要求');
    expect(messages[1].content).toContain('参考文献');
    expect(messages[1].content).toContain('自注意力提升准确率');
    expect(messages[1].content).toContain('定位：表 2');
  });

  it('handles an empty digest without throwing', () => {
    const messages = buildReviewMessages(null);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('输出要求');
  });
});
