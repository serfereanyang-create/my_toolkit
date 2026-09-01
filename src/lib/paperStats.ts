import type { Paper, PaperStatus, Reliability } from '../types/paperApp';
import { inspectCitation } from './citationIssues';
import { DEFAULT_CHECKLIST_ITEMS } from './checklistItems';

export const STATUS_ORDER: PaperStatus[] = ['未读', '粗读', '精读', '已摘录', '待复核'];
export const RELIABILITY_ORDER: Reliability[] = ['高', '中', '低'];
export const UNSPECIFIED_YEAR = '未标注';
export const MAX_TOP_TAGS = 10;

export type PaperStats = {
  total: number;
  evidenceTotal: number;
  issueTotal: number;
  checklistCompletion: number;
  byStatus: { status: PaperStatus; count: number }[];
  byReliability: { level: Reliability; count: number }[];
  byYear: { year: string; count: number }[];
  topTags: { tag: string; count: number }[];
};

export function buildPaperStats(papers: Paper[]): PaperStats {
  const list = Array.isArray(papers) ? papers : [];

  const statusCounts = new Map<PaperStatus, number>(STATUS_ORDER.map((s) => [s, 0]));
  const reliabilityCounts = new Map<Reliability, number>(RELIABILITY_ORDER.map((r) => [r, 0]));
  const yearCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();

  let evidenceTotal = 0;
  let issueTotal = 0;
  let checklistSum = 0;

  for (const paper of list) {
    if (statusCounts.has(paper.status)) {
      statusCounts.set(paper.status, (statusCounts.get(paper.status) ?? 0) + 1);
    }

    const evidence = Array.isArray(paper.evidence) ? paper.evidence : [];
    evidenceTotal += evidence.length;
    for (const item of evidence) {
      if (reliabilityCounts.has(item.reliability)) {
        reliabilityCounts.set(item.reliability, (reliabilityCounts.get(item.reliability) ?? 0) + 1);
      }
    }

    issueTotal += inspectCitation(paper, list).length;

    const year = String(paper.year ?? '').trim();
    const key = /^\d{4}$/.test(year) ? year : UNSPECIFIED_YEAR;
    yearCounts.set(key, (yearCounts.get(key) ?? 0) + 1);

    const seen = new Set<string>();
    for (const raw of Array.isArray(paper.tags) ? paper.tags : []) {
      const tag = String(raw ?? '').trim();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    const checked = DEFAULT_CHECKLIST_ITEMS.filter((item) => Boolean(paper.checklist?.[item])).length;
    checklistSum += DEFAULT_CHECKLIST_ITEMS.length ? checked / DEFAULT_CHECKLIST_ITEMS.length : 0;
  }

  const byYear = Array.from(yearCounts.entries())
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => {
      if (a.year === UNSPECIFIED_YEAR) return 1;
      if (b.year === UNSPECIFIED_YEAR) return -1;
      return a.year.localeCompare(b.year);
    });

  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, 'zh'))
    .slice(0, MAX_TOP_TAGS);

  return {
    total: list.length,
    evidenceTotal,
    issueTotal,
    checklistCompletion: list.length ? checklistSum / list.length : 0,
    byStatus: STATUS_ORDER.map((status) => ({ status, count: statusCounts.get(status) ?? 0 })),
    byReliability: RELIABILITY_ORDER.map((level) => ({ level, count: reliabilityCounts.get(level) ?? 0 })),
    byYear,
    topTags,
  };
}
