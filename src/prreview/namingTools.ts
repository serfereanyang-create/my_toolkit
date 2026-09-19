import type { ToolDefinition } from '../tools/types.js';
import { analyzeWorkspaceNaming } from './namingRules.js';

export const namingCheckTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  maxShow: number;
}> = {
  name: 'naming_check',
  description: '扫描命名规范违规：function camelCase、class PascalCase、const UPPER_SNAKE 等',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}", "maxFiles": 400, "maxShow": 40 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      pattern: typeof record.pattern === 'string' && record.pattern.trim()
        ? record.pattern.trim()
        : 'src/**/*.{ts,tsx}',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.floor(record.maxFiles) : 400,
      maxShow: typeof record.maxShow === 'number' && record.maxShow > 0 ? Math.floor(record.maxShow) : 40,
    };
  },

  async execute(input, context) {
    const report = await analyzeWorkspaceNaming(context.workspaceRoot, input.pattern, input.maxFiles);
    if (report.violations.length === 0) {
      return {
        ok: true,
        output: `扫描 ${report.scannedFiles} 个文件，未发现命名违规。`,
      };
    }
    const lines: string[] = [
      `## 命名规范报告（${report.scannedFiles} 文件 / ${report.violations.length} 违规）`,
      '',
      '### 按类别',
    ];
    for (const kind of Object.keys(report.byKind).sort()) {
      lines.push(`- ${kind}: ${report.byKind[kind]}`);
    }
    lines.push('', `### 违规明细（前 ${input.maxShow} 条）`);
    for (const v of report.violations.slice(0, input.maxShow)) {
      lines.push(`- [${v.kind}] ${v.file}:${v.line} — \`${v.name}\` — ${v.message}`);
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const namingTools = [namingCheckTool];
