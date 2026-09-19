/**
 * unusedExportTools.ts - Unused export report tool registration.
 */

import type { ToolDefinition } from '../tools/types.js';
import { findUnusedExports } from './unusedExports.js';

export const unusedExportsTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  maxReport: number;
}> = {
  name: 'find_unused_exports',
  description: '扫描 TS/TSX 源码，列出未被任何文件 import 的导出符号（候选删除或 API 重构）',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}", "maxFiles": 400, "maxReport": 50 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      pattern: typeof record.pattern === 'string' && record.pattern.trim()
        ? record.pattern.trim()
        : 'src/**/*.{ts,tsx}',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.floor(record.maxFiles) : 400,
      maxReport: typeof record.maxReport === 'number' && record.maxReport > 0 ? Math.floor(record.maxReport) : 50,
    };
  },

  async execute(input, context) {
    const report = await findUnusedExports(context.workspaceRoot, input.pattern, input.maxFiles);

    const lines: string[] = [
      `## 未使用导出扫描`,
      '',
      `- 扫描 ${report.scannedFiles} 个文件`,
      `- 导出符号总数: ${report.exportedCount}`,
      `- 未被 import 的导出: ${report.unusedCount}`,
      '',
    ];
    if (report.unusedCount === 0) {
      lines.push('未发现未使用导出。');
    } else {
      lines.push('### 候选精简清单（前 ' + input.maxReport + ' 项）');
      for (const u of report.unused.slice(0, input.maxReport)) {
        lines.push(`- \`${u.exportedName}\` (${u.kind}) — ${u.file}:${u.line}`);
      }
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const unusedExportTools = [unusedExportsTool];
