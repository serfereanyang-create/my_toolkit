/**
 * hotspotTools.ts - Complexity hotspot report tool registration.
 */

import type { ToolDefinition } from '../tools/types.js';
import { analyzeWorkspace, type FunctionComplexity } from './complexityHotspot.js';

function formatRow(f: FunctionComplexity): string {
  return `- \`${f.name}\` (${f.file}:${f.startLine}) — ${f.linesOfCode} 行, cyclo=${f.cyclomatic}, cog=${f.cognitive}, params=${f.params}`;
}

export const complexityHotspotsTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  topN: number;
}> = {
  name: 'complexity_hotspots',
  description: '扫描工作区 TS/TSX 函数级 cyclomatic/cognitive 复杂度并排序报告 Top N',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}", "maxFiles": 400, "topN": 10 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      pattern: typeof record.pattern === 'string' && record.pattern.trim()
        ? record.pattern.trim()
        : 'src/**/*.{ts,tsx}',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.floor(record.maxFiles) : 400,
      topN: typeof record.topN === 'number' && record.topN > 0 ? Math.floor(record.topN) : 10,
    };
  },

  async execute(input, context) {
    const report = await analyzeWorkspace(context.workspaceRoot, input.pattern, input.maxFiles);
    if (report.totalFunctions === 0) {
      return {
        ok: true,
        output: `扫描 ${report.scannedFiles} 个文件，未发现可分析的函数。`,
      };
    }

    const lines: string[] = [
      `## 复杂度热点报告（${report.scannedFiles} 个文件 / ${report.totalFunctions} 个函数）`,
      '',
      `- 平均 cyclomatic: ${report.summary.avgCyclomatic}`,
      `- 平均 cognitive: ${report.summary.avgCognitive}`,
      `- cyclomatic > 10 的函数数: ${report.summary.over10Cyclomatic}`,
      `- cognitive > 10 的函数数: ${report.summary.over10Cognitive}`,
      '',
      `### Top ${input.topN} 按 cyclomatic`,
      ...report.worstByCyclomatic.slice(0, input.topN).map(formatRow),
      '',
      `### Top ${input.topN} 按 cognitive`,
      ...report.worstByCognitive.slice(0, input.topN).map(formatRow),
      '',
      `### Top ${input.topN} 按函数长度（行）`,
      ...report.largestFunctions.slice(0, input.topN).map(formatRow),
    ];
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const hotspotTools = [complexityHotspotsTool];
