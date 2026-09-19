/**
 * depTools.ts — 依赖审计工具注册
 */

import type { ToolDefinition } from '../tools/types.js';
import { readDependencies, auditDependencies, summarize, type DepAudit } from './dependencyAudit.js';

export const auditDependenciesTool: ToolDefinition<{
  registry?: string;
  concurrency?: number;
  includeDev?: boolean;
}> = {
  name: 'audit_dependencies',
  description: '审计 package.json 依赖的最新性与弃用状况，输出 outdated/major-behind/deprecated 分类统计',
  inputHint: '{ "registry": "https://registry.npmjs.org", "concurrency": 8, "includeDev": true }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const registry = typeof record.registry === 'string' ? record.registry : undefined;
    if (registry && !/^https?:\/\//.test(registry)) {
      throw new Error('registry must be an http(s) URL');
    }
    return {
      registry,
      concurrency: typeof record.concurrency === 'number' && record.concurrency > 0 ? Math.floor(record.concurrency) : 8,
      includeDev: record.includeDev !== false,
    };
  },

  async execute(input, context) {
    let entries;
    try {
      entries = await readDependencies(context.workspaceRoot);
    } catch (err) {
      return {
        ok: false,
        output: `读取 package.json 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!input.includeDev) {
      entries = entries.filter((e) => !e.isDev);
    }
    if (entries.length === 0) {
      return { ok: true, output: 'package.json 中没有依赖项。' };
    }
    const audits = await auditDependencies(entries, {
      registry: input.registry,
      concurrency: input.concurrency,
    });
    const summary = summarize(audits);

    const lines: string[] = [
      `## 依赖审计（共 ${summary.total} 项）`,
      '',
      `- 最新：${summary.upToDate}`,
      `- patch 落后：${summary.patchBehind}`,
      `- minor 落后：${summary.minorBehind}`,
      `- major 落后：${summary.majorBehind}`,
      `- 已弃用：${summary.deprecated}`,
      `- 查询失败：${summary.unknown}`,
      '',
    ];

    const interesting: DepAudit[] = audits.filter((a) => a.risk !== 'up-to-date');
    if (interesting.length > 0) {
      lines.push('### 需要关注');
      for (const a of interesting) {
        const latest = a.latest ?? '?';
        lines.push(`- **${a.name}**: ${a.current} → ${latest} (${a.risk})${a.message ? ` — ${a.message}` : ''}`);
      }
    }
    return { ok: true, output: lines.join('\n'), data: { summary, audits } };
  },
};

export const dependencyTools = [auditDependenciesTool];
