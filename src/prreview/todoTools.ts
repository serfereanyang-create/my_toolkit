/**
 * todoTools.ts - Tracking-comment scanner tool registration.
 */

import type { ToolDefinition } from '../tools/types.js';
import { scanTodos } from './todoTracker.js';

export const todoReportTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  showItems: number;
}> = {
  name: 'todo_report',
  description: '汇总源码中的 TODO/FIXME/HACK/XXX/NOTE/BUG 注释，按 tag/文件/作者聚合',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx,js,md}", "maxFiles": 400, "showItems": 30 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      pattern: typeof record.pattern === 'string' && record.pattern.trim()
        ? record.pattern.trim()
        : 'src/**/*.{ts,tsx,js,md}',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.floor(record.maxFiles) : 400,
      showItems: typeof record.showItems === 'number' && record.showItems > 0 ? Math.floor(record.showItems) : 30,
    };
  },

  async execute(input, context) {
    const report = await scanTodos(context.workspaceRoot, input.pattern, input.maxFiles);
    const { items, byTag, byFile, byAuthor, dated } = report;

    const lines: string[] = [
      `## 注释标记汇总（${report.scannedFiles} 个文件，共 ${items.length} 条）`,
      '',
      '### 按标签',
    ];
    for (const tag of Object.keys(byTag).sort()) {
      lines.push(`- ${tag}: ${byTag[tag]}`);
    }

    if (byFile.length > 0) {
      lines.push('', '### 文件分布 Top 10');
      for (const f of byFile.slice(0, 10)) {
        lines.push(`- ${f.file}: ${f.count} 条`);
      }
    }
    if (byAuthor.length > 0) {
      lines.push('', '### 按作者');
      for (const a of byAuthor.slice(0, 10)) {
        lines.push(`- ${a.author}: ${a.count} 条`);
      }
    }
    if (dated.length > 0) {
      lines.push('', '### 最旧（按日期推断）');
      for (const it of dated.slice(0, 10)) {
        lines.push(`- [${it.dateHint}] ${it.tag} — ${it.file}:${it.line} — ${it.content.slice(0, 60)}`);
      }
    }
    if (items.length > 0) {
      lines.push('', `### 前 ${input.showItems} 条明细`);
      for (const it of items.slice(0, input.showItems)) {
        const loc = `${it.file}:${it.line}`;
        const authorSuffix = it.author ? ` (@${it.author})` : '';
        lines.push(`- [${it.tag}]${authorSuffix} ${loc} — ${it.content.slice(0, 80)}`);
      }
    }

    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const todoTools = [todoReportTool];
