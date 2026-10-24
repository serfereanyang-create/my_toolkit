/**
 * memoryDigestTool.ts — memory_digest 工具：记忆库整理计划与应用。
 */

import type { ToolDefinition } from '../tools/types.js';
import { ProjectMemoryStore } from './store.js';
import { planDigest, applyDigest, type DigestPlan, type ApplyDigestResult } from './memoryDigest.js';
import type { ProjectMemoryEntry } from './types.js';

const ACTION_LABEL: Record<DigestPlan['entries'][number]['action'], string> = { keep: '保留', merge: '合并', archive: '归档' };

const EMPTY_LIBRARY = '记忆库为空（无活跃条目），无需整理。';

function renderPlan(
  plan: DigestPlan,
  activeEntries: ProjectMemoryEntry[],
  options: { applied: boolean; result?: ApplyDigestResult },
): string {
  const lines: string[] = [
    options.applied ? '## 记忆整理已应用' : '## 记忆整理计划（dry run，未写入）',
    '',
    `- 活跃条目：${plan.stats.total} → 预计保留 ${plan.stats.keep - plan.stats.merge >= 0 ? plan.stats.keep : 0}，合并 ${plan.stats.merge}，归档 ${plan.stats.archive}`,
    '',
    '### 动作',
  ];
  for (const action of plan.entries) {
    if (action.action === 'keep' && !action.reason) continue;
    const entry = activeEntries.find((candidate) => candidate.id === action.id);
    lines.push(`- [${ACTION_LABEL[action.action]}] ${action.reason} — "${(entry?.summary ?? '').slice(0, 50)}"`);
  }
  if (!options.applied) {
    lines.push('', '传 dryRun: false 应用此计划。');
    return lines.join('\n');
  }
  const result = options.result;
  lines.push(
    '',
    `### 完成：合并 ${result?.merged ?? 0} · 归档 ${result?.archived ?? 0} · 活跃 ${result?.totalBefore ?? 0} → ${result?.totalAfter ?? 0}`,
    '（合并/归档均为软操作：条目保留为 inactive，可用 /memory 查看。）',
  );
  return lines.join('\n');
}

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
    const options = { staleNoteDays: input.staleNoteDays, oversizedSummary: input.oversizedSummary };

    if (input.dryRun) {
      const file = await store.load();
      const activeEntries = file.entries.filter((entry) => entry.active);
      if (activeEntries.length === 0) return { ok: true, output: EMPTY_LIBRARY };
      const plan = planDigest(activeEntries, options);
      return { ok: true, output: renderPlan(plan, activeEntries, { applied: false }), data: { plan, applied: false } };
    }

    /*
     * 应用路径必须在 store 的写队列里「读—算—写」一次做完。
     * 先在外面 load 一份快照、算完再 save，中间别的会话写进来的条目会被
     * save 覆盖掉——正是 store.mutate 注释里禁止的那件事。
     */
    type DigestOutcome = {
      empty: boolean;
      activeEntries: ProjectMemoryEntry[];
      plan: DigestPlan | null;
      result: ApplyDigestResult | null;
    };
    const outcome = await store.update<DigestOutcome>(async (file) => {
      const activeEntries = file.entries.filter((entry) => entry.active);
      if (activeEntries.length === 0) {
        return { changed: false, value: { empty: true, activeEntries, plan: null, result: null } };
      }
      const plan = planDigest(activeEntries, options);
      let wrote = false;
      const result = await applyDigest(file, plan, async (next) => {
        // applyDigest 已经把条目改在这份 file 上，把信封（updatedAt）合并回来即可；
        // 真正的落盘由外层 update 统一做，避免队列里再发一次写。
        Object.assign(file, next);
        wrote = true;
      });
      const acted = plan.entries.some((entry) => entry.action !== 'keep');
      return { changed: wrote && acted, value: { empty: false, activeEntries, plan, result } };
    });

    if (outcome.empty || !outcome.plan || !outcome.result) return { ok: true, output: EMPTY_LIBRARY };
    return {
      ok: true,
      output: renderPlan(outcome.plan, outcome.activeEntries, { applied: true, result: outcome.result }),
      data: { plan: outcome.plan, applied: true, result: outcome.result },
    };
  },
};

export const memoryDigestTools = [memoryDigestTool];
