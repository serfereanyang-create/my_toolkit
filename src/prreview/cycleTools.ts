/**
 * cycleTools.ts - Import cycle detection tool registration.
 */

import type { ToolDefinition } from '../tools/types.js';
import { detectImportCycles } from './importCycles.js';

export const detectImportCyclesTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  showCycles: number;
}> = {
  name: 'detect_import_cycles',
  description: '解析 TS/TSX 依赖图并用 Tarjan SCC 列出所有 import 循环（按大小倒序）',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}", "maxFiles": 400, "showCycles": 10 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      pattern: typeof record.pattern === 'string' && record.pattern.trim()
        ? record.pattern.trim()
        : 'src/**/*.{ts,tsx}',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.floor(record.maxFiles) : 400,
      showCycles: typeof record.showCycles === 'number' && record.showCycles > 0 ? Math.floor(record.showCycles) : 10,
    };
  },

  async execute(input, context) {
    const report = await detectImportCycles(context.workspaceRoot, input.pattern, input.maxFiles);
    const lines: string[] = [
      `## 循环依赖检测`,
      '',
      `- 扫描文件：${report.scannedFiles}`,
      `- 有效依赖边：${report.totalEdges}`,
      `- 检测到 ${report.cycles.length} 个强连通分量（循环）`,
      '',
    ];
    if (report.cycles.length === 0) {
      lines.push('未发现 import 循环。');
    } else {
      for (let i = 0; i < Math.min(input.showCycles, report.cycles.length); i++) {
        const cycle = report.cycles[i]!;
        lines.push(`### Cycle ${i + 1}（${cycle.files.length} 文件，${cycle.edgeCount} 边）`);
        for (const file of cycle.files) {
          lines.push(`- ${file}`);
        }
        lines.push('');
      }
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const cycleTools = [detectImportCyclesTool];
