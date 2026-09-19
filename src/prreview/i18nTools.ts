/**
 * i18nTools.ts — 硬编码文本扫描工具注册
 */

import type { ToolDefinition } from '../tools/types.js';
import { scanWorkspace } from './hardcodedText.js';

export const scanHardcodedTextTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  jsxOnly?: boolean;
}> = {
  name: 'scan_hardcoded_text',
  description: '扫描 TS/TSX 源码中的硬编码中文字符串，评估 i18n 迁移工作量（默认排除 t()/i18n.t() 包裹）',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}", "maxFiles": 200, "jsxOnly": false }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      pattern: typeof record.pattern === 'string' && record.pattern.trim()
        ? record.pattern.trim()
        : 'src/**/*.{ts,tsx}',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.floor(record.maxFiles) : 200,
      jsxOnly: record.jsxOnly === true,
    };
  },

  async execute(input, context) {
    const report = await scanWorkspace(context.workspaceRoot, input.pattern, input.maxFiles);
    const hits = input.jsxOnly ? report.hits.filter((h) => h.inJsx) : report.hits;

    if (hits.length === 0) {
      return {
        ok: true,
        output: `扫描 ${report.scanned} 个文件，未发现硬编码中文。`,
      };
    }

    const lines: string[] = [
      `## 硬编码文本扫描（${report.scanned} 个文件，${hits.length} 处命中${input.jsxOnly ? '，仅 JSX' : ''}）`,
      '',
      '### 按文件统计',
    ];
    for (const item of report.byFile.slice(0, 20)) {
      lines.push(`- ${item.file}: ${item.count} 处（${item.jsxCount} 处于 JSX）`);
    }
    lines.push('', '### 前 30 条命中');
    for (const h of hits.slice(0, 30)) {
      const preview = h.text.length > 40 ? h.text.slice(0, 40) + '…' : h.text;
      const marker = h.inJsx ? ' [JSX]' : '';
      lines.push(`- ${h.filePath}:${h.line}:${h.column}${marker} — "${preview}"`);
    }
    return { ok: true, output: lines.join('\n'), data: { total: hits.length, hits: hits.slice(0, 200) } };
  },
};

export const i18nTools = [scanHardcodedTextTool];
