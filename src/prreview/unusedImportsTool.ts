import type { ToolDefinition } from '../tools/types.js';
import { findUnusedImports } from './unusedImports.js';

export const findUnusedImportsTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  maxShow: number;
}> = {
  name: 'find_unused_imports',
  description: '扫描 TS/TSX 文件中未被使用的 import 绑定，按文件聚合报告',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}", "maxFiles": 400, "maxShow": 40 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    return {
      pattern: typeof r.pattern === 'string' && r.pattern.trim() ? r.pattern.trim() : 'src/**/*.{ts,tsx}',
      maxFiles: typeof r.maxFiles === 'number' && r.maxFiles > 0 ? Math.floor(r.maxFiles) : 400,
      maxShow: typeof r.maxShow === 'number' && r.maxShow > 0 ? Math.floor(r.maxShow) : 40,
    };
  },

  async execute(input, context) {
    const report = await findUnusedImports(context.workspaceRoot, input.pattern, input.maxFiles);
    if (report.unusedCount === 0) {
      return {
        ok: true,
        output: `扫描 ${report.scannedFiles} 个文件，未发现未使用的 import。`,
      };
    }
    const lines: string[] = [
      `## 未使用 import 报告（${report.scannedFiles} 文件 / 共 ${report.unusedCount} 处）`,
      '',
      '### 按文件（Top 20）',
    ];
    for (const f of report.byFile.slice(0, 20)) {
      lines.push(`- ${f.file}: ${f.count} 处`);
    }
    lines.push('', `### 明细（前 ${input.maxShow} 条）`);
    for (const u of report.unused.slice(0, input.maxShow)) {
      lines.push(`- [${u.kind}] ${u.file}:${u.line} — \`${u.localName}\` from "${u.moduleSpecifier}"`);
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const unusedImportTools = [findUnusedImportsTool];
