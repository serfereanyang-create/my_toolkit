import type { Paper } from '../types/paperApp';

/**
 * 文献矩阵 Markdown 生成（原 electron/paper-matrix.cjs 的 TypeScript 移植，
 * 现为唯一实现）。单元格转义（| → \|）、换行折叠与页脚语义必须保持一致
 * （由单测锁定）。
 */

const MATRIX_HEADER = '| # | 论文 | 作者 | 年份 | 来源 | DOI | 状态 | 方法 | 数据/样本 | 关键发现 | 局限 |';
const MATRIX_RULE = '|---|---|---|---|---|---|---|---|---|---|---|';

function cell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n+/g, ' ')
    .trim();
}

export function buildLiteratureMatrix(papers: readonly Paper[] | null | undefined): string {
  const list = Array.isArray(papers) ? papers : [];
  if (list.length === 0) {
    return `${MATRIX_HEADER}\n${MATRIX_RULE}\n| - | 没有论文 | | | | | | | | | |\n`;
  }
  const rows = list.map(
    (p, i) =>
      `| ${i + 1} | ${cell(p.title)} | ${cell(p.authors)} | ${cell(p.year)} | ${cell(p.source)} | ${cell(p.doi)} | ${cell(p.status)} | ${cell(p.method)} | ${cell(p.dataset)} | ${cell(p.findings)} | ${cell(p.limitations)} |`,
  );
  const footer = `> 文献矩阵：共 ${list.length} 篇，生成于 ${new Date().toISOString().slice(0, 10)}。`;
  return `${[MATRIX_HEADER, MATRIX_RULE, ...rows, '', footer].join('\n')}\n`;
}
