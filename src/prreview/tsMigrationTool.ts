import type { ToolDefinition } from '../tools/types.js';
import { assessTsMigration } from './tsMigration.js';

export const tsMigrationTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
}> = {
  name: 'ts_migration_status',
  description: 'JS → TS 迁移进度评估：文件分布、ts 占比、最大待迁 .js 文件',
  inputHint: '{ "pattern": "src/**/*.{js,jsx,ts,tsx}", "maxFiles": 500 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    return {
      pattern: typeof r.pattern === 'string' && r.pattern.trim()
        ? r.pattern.trim()
        : 'src/**/*.{js,jsx,ts,tsx}',
      maxFiles: typeof r.maxFiles === 'number' && r.maxFiles > 0 ? Math.floor(r.maxFiles) : 500,
    };
  },

  async execute(input, context) {
    const r = await assessTsMigration(context.workspaceRoot, input.pattern, input.maxFiles);
    const lines: string[] = [
      `## TypeScript 迁移进度`,
      '',
      `- 扫描文件: ${r.scanned}`,
      `- TS/TSX: ${r.tsFiles + r.tsxFiles}  / JS/JSX: ${r.jsFiles + r.jsxFiles}`,
      `- TS 占比: ${(r.tsRatio * 100).toFixed(1)}%`,
      '',
      '### 明细',
      `- .ts: ${r.tsFiles}`,
      `- .tsx: ${r.tsxFiles}`,
      `- .js: ${r.jsFiles}`,
      `- .jsx: ${r.jsxFiles}`,
    ];
    if (r.largestJs.length > 0) {
      lines.push('', '### 最大的待迁移 JS/JSX 文件');
      for (const e of r.largestJs.slice(0, 15)) {
        lines.push(`- ${e.file}（${e.lines} 行）`);
      }
    }
    if (r.suggestions.length > 0) {
      lines.push('', '### 建议');
      for (const s of r.suggestions) lines.push(`- ${s}`);
    }
    return { ok: true, output: lines.join('\n'), data: r };
  },
};

export const tsMigrationTools = [tsMigrationTool];
