/**
 * langStatsTool.ts - language histogram tool registration
 */

import type { ToolDefinition } from '../tools/types.js';
import { analyzeLanguages } from './langStats.js';

export const langHistogramTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  top: number;
}> = {
  name: 'lang_histogram',
  description: '分析源码语言分布：文件数 / LOC / 字节数 / 注释-空行-代码-重复 比例',
  inputHint: '{ "pattern": "**/*", "maxFiles": 3000, "top": 15 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    return {
      pattern: typeof r.pattern === 'string' && r.pattern.trim() ? r.pattern.trim() : '**/*',
      maxFiles: typeof r.maxFiles === 'number' && r.maxFiles > 0 ? Math.floor(r.maxFiles) : 3000,
      top: typeof r.top === 'number' && r.top > 0 ? Math.floor(r.top) : 15,
    };
  },

  async execute(input, context) {
    const report = await analyzeLanguages(context.workspaceRoot, input.pattern, input.maxFiles);
    const lines: string[] = [
      `## 语言分布（${report.scannedFiles} 个文件）`,
      '',
      `- 总行数：${report.totalLines.toLocaleString()}`,
      `- 总字节：${(report.totalBytes / 1024).toFixed(1)} KiB`,
      '',
      `### Top ${input.top} 语言（按代码行数）`,
      '',
      '| 语言 | 文件数 | LOC | 代码 | 注释 | 空行 | 重复行 | 字节 |',
      '|---|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const b of report.buckets.slice(0, input.top)) {
      lines.push(
        `| ${b.language} | ${b.fileCount} | ${b.totalLines.toLocaleString()} | ${b.codeLines.toLocaleString()} | ${b.commentLines.toLocaleString()} | ${b.blankLines.toLocaleString()} | ${b.repeatedLines.toLocaleString()} | ${(b.bytes / 1024).toFixed(1)} KiB |`,
      );
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const langStatsTools = [langHistogramTool];
