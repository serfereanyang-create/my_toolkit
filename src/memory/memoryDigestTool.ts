/**
 * memoryDigestTool.ts — memory_digest 工具：记忆库整理计划与应用。
 */

import type { ToolDefinition } from '../tools/types.js';
import { ProjectMemoryStore } from './store.js';
import { planDigest, applyDigest, type DigestPlan, type DigestAction } from './memoryDigest.js';

const ACTION_LABEL: Record<DigestAction, string> = { keep: '保留', merge: '合并', archive: '归档' };

export const memoryDigestTool: ToolDefinition<{
  dryRun?: boolean;
  staleNoteDays?: number;
  oversizedSummary?: number;
}> = {
  name: 'memory_digest',
  description: '整理工作区记忆库：同主题条目合并、过时/超长 note 归档（软删除可恢复）。默认 dryRun 只出计划',
  inputHint: '{ "dryRun": true, "staleNoteDays": 120 }',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    const positive = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.floor(v) : undefined);
    return {
      dryRun: r.dryRun !== false,
      staleNoteDays: positive(r.staleNoteDays),
      oversizedSummary: positive(r.oversizedSummary),
    };
  },

  async execute(input, context) {
    const store = new ProjectMemoryStore(context.workspaceRoot);
    const file = await store.load();
    const activeEntries = file.entries.filter((e) => e.active);
    if (activeEntries.length === 0) {
      return { ok: true, output: '记忆库为空（无活跃条目），无需整理。' };
    }

    const plan = planDigest(activeEntries, {
      staleNoteDays: input.staleNoteDays,
      oversizedSummary: input.oversizedSummary,
    });

    const lines: string[] = [
      input.dryRun ? '## 记忆整理计划（dry run，未写入）' : '## 记忆整理已应用',
      '',
      `- 活跃条目：${plan.stats.total} → 预计保留 ${plan.stats.keep - plan.stats.merge >= 0 ? plan.stats.keep : 0}，合并 ${plan.stats.merge}，归档 ${plan.stats.archive}`,
      '',
      '### 动作',
    ];
    for (const p of plan.entries) {
      if (p.action === 'keep' && !p.reason) continue;
      const entry = activeEntries.find((e) => e.id === p.id)!;
      lines.push(`- [${ACTION_LABEL[p.action]}] ${p.reason} — "${entry.summary.slice(0, 50)}"`);
    }

    if (input.dryRun) {
      lines.push('', '传 dryRun: false 应用此计划。');
      return { ok: true, output: lines.join('\n'), data: { plan, applied: false } };
    }

    const result = await applyDigest(file, plan, (next) => store.save(next));
    lines.push(
      '',
      `### 完成：合并 ${result.merged} · 归档 ${result.archived} · 活跃 ${result.totalBefore} → ${result.totalAfter}`,
      '（合并/归档均为软操作：条目保留为 inactive，可用 /memory 查看。）',
    );
    return { ok: true, output: lines.join('\n'), data: { plan, applied: true, result } };
  },
};

export const memoryDigestTools = [memoryDigestTool];
