function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n+/g, ' ')
    .trim();
}

function buildLiteratureMatrix(papers) {
  const list = Array.isArray(papers) ? papers : [];
  const header = '| # | 论文 | 作者 | 年份 | 来源 | DOI | 状态 | 方法 | 数据/样本 | 关键发现 | 局限 |';
  const rule = '|---|---|---|---|---|---|---|---|---|---|---|';
  if (list.length === 0) {
    return `${header}\n${rule}\n| - | 没有论文 | | | | | | | | | |\n`;
  }
  const rows = list.map((p, i) => `| ${i + 1} | ${cell(p.title)} | ${cell(p.authors)} | ${cell(p.year)} | ${cell(p.source)} | ${cell(p.doi)} | ${cell(p.status)} | ${cell(p.method)} | ${cell(p.dataset)} | ${cell(p.findings)} | ${cell(p.limitations)} |`);
  const footer = `> 文献矩阵：共 ${list.length} 篇，生成于 ${new Date().toISOString().slice(0, 10)}。`;
  return `${[header, rule, ...rows, '', footer].join('\n')}\n`;
}

module.exports = { buildLiteratureMatrix };
