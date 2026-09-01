import type { Paper } from '../types/paperApp';

export function inspectCitation(paper: Paper, papers: Paper[]): string[] {
  const issues: string[] = [];
  const prefix = paper.title || '未命名论文';
  if (!paper.authors.trim()) issues.push(`${prefix}: 缺少作者`);
  if (!paper.year.trim()) issues.push(`${prefix}: 缺少年份`);
  if (!paper.source.trim()) issues.push(`${prefix}: 缺少来源`);
  if (!paper.doi.trim() && !paper.url.trim()) issues.push(`${prefix}: DOI 和 URL 至少补一个`);
  if (paper.doi.trim()) {
    const duplicates = papers.filter((item) => item.id !== paper.id && item.doi.trim().toLowerCase() === paper.doi.trim().toLowerCase());
    if (duplicates.length > 0) issues.push(`${prefix}: DOI 与其他卡片重复`);
  }
  return issues;
}
