/**
 * lockfileDiffTool.ts — lockfile_diff 工具：对比两份 package-lock。
 */

import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ToolDefinition } from '../tools/types.js';
import { diffLockfiles } from './lockfileDiff.js';

function insideRoot(root: string, target: string): boolean {
  const abs = resolve(root, target);
  return abs === resolve(root) || abs.startsWith(resolve(root) + sep);
}

export const lockfileDiffTool: ToolDefinition<{ before: string; after: string }> = {
  name: 'lockfile_diff',
  description: '对比两份 package-lock.json（工作区相对路径），报告依赖新增/移除/升降级与 major/minor/patch 分布',
  inputHint: '{ "before": ".backups/package-lock.json", "after": "package-lock.json" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    for (const key of ['before', 'after'] as const) {
      if (typeof r[key] !== 'string' || !r[key].trim()) throw new Error(`missing ${key}`);
    }
    return { before: (r.before as string).trim(), after: (r.after as string).trim() };
  },

  async execute(input, context) {
    for (const [label, path] of [['before', input.before], ['after', input.after]] as const) {
      if (!insideRoot(context.workspaceRoot, path)) {
        return { ok: false, output: `${label} 路径越出工作区: ${path}` };
      }
    }
    let beforeText: string;
    let afterText: string;
    try {
      beforeText = await readFile(resolve(context.workspaceRoot, input.before), 'utf-8');
    } catch (err) {
      return { ok: false, output: `读取 ${input.before} 失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      afterText = await readFile(resolve(context.workspaceRoot, input.after), 'utf-8');
    } catch (err) {
      return { ok: false, output: `读取 ${input.after} 失败: ${err instanceof Error ? err.message : String(err)}` };
    }

    const report = diffLockfiles(beforeText, afterText);
    if (!report.ok) return { ok: false, output: `lock 对比失败: ${report.error}` };
    if (report.total === 0) {
      return { ok: true, output: '两份 lock 的依赖集合完全一致。' };
    }

    const lines: string[] = [
      `## Lockfile 差异（${report.total} 项变更）`,
      '',
      `- 新增 ${report.added.length} · 移除 ${report.removed.length} · 变更 ${report.changed.length}`,
    ];
    const major = report.semverHints.filter((h) => h.bump === 'major');
    if (major.length > 0) {
      lines.push('', `### ⚠ major 变更（${major.length}，需重点评审）`);
      for (const h of major.slice(0, 30)) lines.push(`- **${h.name}**: ${h.from} → ${h.to}`);
    }
    if (report.changed.length > 0) {
      lines.push('', '### 版本变更（前 30）');
      for (const c of report.changed.slice(0, 30)) {
        lines.push(`- ${c.name}: ${c.from} → ${c.to}（${c.direction === 'upgrade' ? '↑' : '↓'} ${report.semverHints.find((h) => h.name === c.name)?.bump ?? ''}）`);
      }
    }
    if (report.added.length > 0) {
      lines.push('', `### 新增（${report.added.length}）`);
      for (const c of report.added.slice(0, 20)) lines.push(`- ${c.name}@${c.to}`);
    }
    if (report.removed.length > 0) {
      lines.push('', `### 移除（${report.removed.length}）`);
      for (const c of report.removed.slice(0, 20)) lines.push(`- ${c.name}@${c.from}`);
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const lockfileTools = [lockfileDiffTool];
