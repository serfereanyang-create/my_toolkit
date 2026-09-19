import type { ToolDefinition } from '../tools/types.js';
import { analyzeWorkspaceComments } from './commentDensity.js';

export const commentDensityTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  topN: number;
}> = {
  name: 'comment_density',
  description: '代码注释密度分析（注释行数占比 / 缺注释文件 / 过度注释文件）',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}", "maxFiles": 400, "topN": 10 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    return {
      pattern: typeof r.pattern === 'string' && r.pattern.trim() ? r.pattern.trim() : 'src/**/*.{ts,tsx}',
      maxFiles: typeof r.maxFiles === 'number' && r.maxFiles > 0 ? Math.floor(r.maxFiles) : 400,
      topN: typeof r.topN === 'number' && r.topN > 0 ? Math.floor(r.topN) : 10,
    };
  },

  async execute(input, context) {
    const report = await analyzeWorkspaceComments(context.workspaceRoot, input.pattern, input.maxFiles);
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const lines: string[] = [
      `## 注释密度报告（${report.scannedFiles} 文件）`,
      '',
      `- 总行数: ${report.totals.lines.toLocaleString()}`,
      `- 注释行: ${report.totals.comments.toLocaleString()} (${pct(report.totals.comments / Math.max(report.totals.lines, 1))})`,
      `- 空行: ${report.totals.blanks.toLocaleString()} (${pct(report.totals.blanks / Math.max(report.totals.lines, 1))})`,
      `- 代码行: ${report.totals.code.toLocaleString()}`,
      `- 平均密度（每文件均值）: ${pct(report.avgDensity)}`,
    ];
    if (report.underDocumented.length > 0) {
      lines.push('', `### 注释密度过低的较大文件（Top ${input.topN}）`);
      for (const f of report.underDocumented.slice(0, input.topN)) {
        lines.push(`- ${f.file}: ${f.codeLines} 行代码，注释 ${pct(f.commentDensity)}`);
      }
    }
    if (report.overDocumented.length > 0) {
      lines.push('', `### 注释占比很高（Top ${input.topN}，可能冗余或保留块）`);
      for (const f of report.overDocumented.slice(0, input.topN)) {
        lines.push(`- ${f.file}: ${pct(f.commentDensity)}, ${f.totalLines} 行`);
      }
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const commentTools = [commentDensityTool];
