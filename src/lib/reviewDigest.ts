import type { Evidence, Paper, PaperStatus } from '../types/paperApp';

/**
 * Renderer-side mirror of electron/paper-digest.cjs.
 * 渲染进程不能 require electron/*.cjs，因此这里用 TypeScript 复刻同一套
 * 截断/分组语义；两个实现需保持一致（由单测锁定）。
 */

export const AI_REVIEW_MAX_PAPERS = 40;
export const AI_FIELD_LIMIT = 400;
export const AI_CLAIM_LIMIT = 200;
export const AI_MAX_EVIDENCE = 8;

const UNGROUPED_TAG = '未分组';

export const REVIEW_SYSTEM_PROMPT =
  '你是科研综述助手。只依据用户提供的论文摘要素材归纳，禁止编造数据或结论；引用发现时标注来源论文标题；用中文输出。';

export type ReviewMessage = { role: 'system' | 'user'; content: string };

export type DigestEvidence = Evidence;

export type DigestPaper = {
  id: string;
  status: PaperStatus;
  title: string;
  authors: string;
  year: string;
  source: string;
  question: string;
  method: string;
  dataset: string;
  findings: string;
  limitations: string;
  credibility: string;
  evidence: DigestEvidence[];
};

export type ReviewDigestGroup = { tag: string; papers: DigestPaper[] };

export type ReviewDigest = {
  totalCount: number;
  selectedCount: number;
  truncated: boolean;
  groups: ReviewDigestGroup[];
};

const cut = (value: unknown, limit: number): string => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.slice(0, limit);
};

const digestEvidence = (evidence: Evidence[] | undefined): DigestEvidence[] => {
  const items = Array.isArray(evidence) ? evidence : [];
  return items.slice(0, AI_MAX_EVIDENCE).map((item) => ({
    ...item,
    claim: cut(item?.claim, AI_CLAIM_LIMIT),
    locator: cut(item?.locator, AI_CLAIM_LIMIT),
  }));
};

const digestPaper = (paper: Paper): DigestPaper => {
  const source = (paper ?? {}) as Partial<Paper>;
  return {
    id: String(source.id ?? ''),
    status: source.status ?? '未读',
    title: cut(source.title, AI_FIELD_LIMIT),
    authors: cut(source.authors, AI_FIELD_LIMIT),
    year: cut(source.year, AI_FIELD_LIMIT),
    source: cut(source.source, AI_FIELD_LIMIT),
    question: cut(source.question, AI_FIELD_LIMIT),
    method: cut(source.method, AI_FIELD_LIMIT),
    dataset: cut(source.dataset, AI_FIELD_LIMIT),
    findings: cut(source.findings, AI_FIELD_LIMIT),
    limitations: cut(source.limitations, AI_FIELD_LIMIT),
    credibility: cut(source.credibility, AI_FIELD_LIMIT),
    evidence: digestEvidence(source.evidence),
  };
};

export function buildReviewDigest(papers: readonly Paper[] | null | undefined): ReviewDigest {
  const list = Array.isArray(papers) ? papers : [];
  const selected = list.slice(0, AI_REVIEW_MAX_PAPERS);
  const groupsByTag = new Map<string, ReviewDigestGroup>();

  for (const paper of selected) {
    const digested = digestPaper(paper);
    const rawTags = (paper as { tags?: unknown } | undefined)?.tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
      : [];
    const groupTags = tags.length > 0 ? tags : [UNGROUPED_TAG];
    for (const tag of groupTags) {
      let group = groupsByTag.get(tag);
      if (!group) {
        group = { tag, papers: [] };
        groupsByTag.set(tag, group);
      }
      group.papers.push(digested);
    }
  }

  const groups = [...groupsByTag.values()].sort((a, b) => a.tag.localeCompare(b.tag, 'zh'));

  return {
    totalCount: list.length,
    selectedCount: selected.length,
    truncated: list.length > AI_REVIEW_MAX_PAPERS,
    groups,
  };
}

export function buildReviewMessages(digest: ReviewDigest | null | undefined): ReviewMessage[] {
  const safeDigest: ReviewDigest = digest ?? { totalCount: 0, selectedCount: 0, truncated: false, groups: [] };
  const lines: string[] = [];

  lines.push(
    `以下是 ${safeDigest.selectedCount} 篇论文的摘要素材（当前筛选共 ${safeDigest.totalCount} 篇${
      safeDigest.truncated ? '，超出上限仅保留前 40 篇，字段与证据内容已截断' : ''
    }），按标签分组提供，分组仅作素材整理，输出时请按主题重新归纳。`,
  );

  for (const group of safeDigest.groups) {
    lines.push('');
    lines.push(`## 分组：${group.tag}（${group.papers.length} 篇）`);
    group.papers.forEach((paper, index) => {
      lines.push('');
      lines.push(`### 论文 ${index + 1}`);
      lines.push(`标题：${paper.title || '（未填写）'}`);
      lines.push(`作者：${paper.authors || '（未填写）'}`);
      lines.push(`年份：${paper.year || '（未填写）'}`);
      lines.push(`来源：${paper.source || '（未填写）'}`);
      lines.push(`研究问题：${paper.question || '（未填写）'}`);
      lines.push(`方法：${paper.method || '（未填写）'}`);
      lines.push(`数据：${paper.dataset || '（未填写）'}`);
      lines.push(`关键发现：${paper.findings || '（未填写）'}`);
      lines.push(`局限性：${paper.limitations || '（未填写）'}`);
      lines.push(`可信度：${paper.credibility || '（未填写）'}`);
      if (paper.evidence.length > 0) {
        lines.push('证据主张：');
        paper.evidence.forEach((item, evidenceIndex) => {
          lines.push(`${evidenceIndex + 1}. ${item.claim}（定位：${item.locator || '未注明'}）`);
        });
      } else {
        lines.push('证据主张：（无）');
      }
    });
  }

  lines.push('');
  lines.push('## 输出要求');
  lines.push('1. 按主题分组综述，不要逐篇罗列；');
  lines.push('2. 每组综合各研究的关键发现，引用时标注来源论文标题；');
  lines.push('3. 指出跨研究之间的分歧或矛盾；');
  lines.push('4. 归纳整体局限；');
  lines.push('5. 文末列出参考文献列表（标题+年份）。');

  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * desktopApi.ai 桥接类型（Task 6 会把同形状加进 App.tsx 的 DesktopApi）。
 * 通过 globalThis 读取，避免依赖 App.tsx 中尚未扩展的 Window 声明。
 */
export type AiReviewApi = {
  getConfig: () => Promise<{ baseUrl: string; model: string; temperature: number; hasKey: boolean }>;
  saveConfig: (input: {
    baseUrl: string;
    model: string;
    temperature: number;
    apiKey?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  testConnection: () => Promise<{ ok: boolean; error?: string }>;
  generateReview: (messages: ReviewMessage[]) => Promise<{ ok: boolean }>;
  cancelReview: () => Promise<{ ok: boolean }>;
  onChunk: (callback: (delta: string) => void) => () => void;
  onDone: (callback: (payload: { full: string; stopped: boolean }) => void) => () => void;
  onError: (callback: (payload: { message: string }) => void) => () => void;
};

export function resolveAiReviewApi(): AiReviewApi | null {
  const desktopApi = (globalThis as { desktopApi?: { ai?: AiReviewApi } }).desktopApi;
  return desktopApi?.ai ?? null;
}
