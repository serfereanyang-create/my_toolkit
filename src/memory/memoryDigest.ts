/**
 * memoryDigest.ts — 记忆库整理（digest）计划与应用。
 *
 * 参考分层记忆管理的"压缩/归档"操作：
 *  - merge:   同 kind + 首关键词重复的条目 → 合并到最新一条
 *  - archive: 超长、空泛或过旧的 note 类条目 → 软归档（active=false，可逆）
 * 计划与执行分离：planDigest 是纯函数（可单测），applyDigest 写 store。
 */

import type { ProjectMemoryEntry, ProjectMemoryFile } from './types.js';

export type DigestAction = 'keep' | 'merge' | 'archive';

export interface DigestPlanEntry {
  id: string;
  action: DigestAction;
  reason: string;
  /** merge 时指向保留的条目 id */
  mergeInto?: string;
}

export interface DigestPlan {
  entries: DigestPlanEntry[];
  stats: { total: number; keep: number; merge: number; archive: number };
}

export interface DigestOptions {
  /** 多少天前的 note 视为过旧可归档，默认 120 */
  staleNoteDays?: number;
  /** 摘要长度超过该值提示归档（截断上限的 2 倍），默认 480 */
  oversizedSummary?: number;
}

/** 分组键：kind + 排序后的前两个关键词。键相同 → 语义相近的候选。 */
export function groupKey(entry: ProjectMemoryEntry): string {
  const kw = [...entry.keywords].sort().slice(0, 2).join(',');
  return `${entry.kind}|${kw}`;
}

/** 是否过旧（createdAt 早于阈值）。 */
function isStale(entry: ProjectMemoryEntry, days: number, nowMs: number): boolean {
  const at = Date.parse(entry.createdAt);
  if (!Number.isFinite(at)) return false;
  return nowMs - at > days * 86_400_000;
}

/** 生成整理计划：纯函数，不写任何东西。 */
export function planDigest(entries: ProjectMemoryEntry[], options: DigestOptions = {}): DigestPlan {
  const staleNoteDays = options.staleNoteDays ?? 120;
  const oversized = options.oversizedSummary ?? 480;
  const nowMs = Date.now();

  const byGroup = new Map<string, ProjectMemoryEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const list = byGroup.get(key) ?? [];
    list.push(entry);
    byGroup.set(key, list);
  }

  const plans = new Map<string, DigestPlanEntry>();
  for (const [, group] of byGroup) {
    if (group.length === 1) {
      const only = group[0]!;
      if (only.kind === 'note' && isStale(only, staleNoteDays, nowMs)) {
        plans.set(only.id, { id: only.id, action: 'archive', reason: `note 类记忆超过 ${staleNoteDays} 天未更新，建议归档` });
      } else if (only.summary.length > oversized) {
        plans.set(only.id, { id: only.id, action: 'archive', reason: `摘要超长（${only.summary.length} 字符），建议重写后归档` });
      } else {
        plans.set(only.id, { id: only.id, action: 'keep', reason: '' });
      }
      continue;
    }
    // 多条同组：保留最新 updatedAt，其余合并入它
    const sorted = [...group].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const [keeper, ...rest] = sorted;
    plans.set(keeper!.id, { id: keeper!.id, action: 'keep', reason: `同组 ${group.length} 条中的最新条目，保留并吸收其余` });
    for (const dup of rest) {
      plans.set(dup.id, { id: dup.id, action: 'merge', mergeInto: keeper!.id, reason: `与 "${keeper!.summary.slice(0, 30)}…" 同主题` });
    }
  }

  const ordered: DigestPlanEntry[] = [];
  for (const entry of entries) {
    ordered.push(plans.get(entry.id) ?? { id: entry.id, action: 'keep', reason: '' });
  }
  const stats = {
    total: ordered.length,
    keep: ordered.filter((p) => p.action === 'keep').length,
    merge: ordered.filter((p) => p.action === 'merge').length,
    archive: ordered.filter((p) => p.action === 'archive').length,
  };
  return { entries: ordered, stats };
}

/** 合并摘要文本（去重句段，上限截断）。 */
export function mergeSummaries(keeper: ProjectMemoryEntry, sources: ProjectMemoryEntry[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const entry of [keeper, ...sources]) {
    for (const sentence of entry.summary.split(/；|;|\n/)) {
      const trimmed = sentence.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        parts.push(trimmed);
      }
    }
  }
  const merged = parts.join('；');
  return merged.length > 240 ? merged.slice(0, 237) + '...' : merged;
}

export interface ApplyDigestResult {
  kept: number;
  merged: number;
  archived: number;
  totalBefore: number;
  totalAfter: number;
}

/**
 * 应用计划：merge 的目标保留并把被合并条目置 inactive；archive 置 inactive。
 * 只走 store.save（原子写由 store 负责），返回前后统计。
 */
export async function applyDigest(
  file: ProjectMemoryFile,
  plan: DigestPlan,
  save: (file: ProjectMemoryFile) => Promise<void>,
): Promise<ApplyDigestResult> {
  const byId = new Map(file.entries.map((e) => [e.id, e]));
  const mergeSources = new Map<string, ProjectMemoryEntry[]>();
  let merged = 0;
  let archived = 0;

  for (const p of plan.entries) {
    const entry = byId.get(p.id);
    if (!entry) continue;
    if (p.action === 'merge' && p.mergeInto) {
      const keeper = byId.get(p.mergeInto);
      if (keeper) {
        const bucket = mergeSources.get(keeper.id) ?? [];
        bucket.push(entry);
        mergeSources.set(keeper.id, bucket);
      }
      entry.active = false;
      merged += 1;
    } else if (p.action === 'archive') {
      entry.active = false;
      archived += 1;
    }
  }

  for (const [keeperId, sources] of mergeSources) {
    const keeper = byId.get(keeperId);
    if (!keeper) continue;
    keeper.summary = mergeSummaries(keeper, sources);
    keeper.keywords = [...new Set([...keeper.keywords, ...sources.flatMap((s) => s.keywords)])].slice(0, 12);
    keeper.updatedAt = new Date().toISOString();
  }

  const totalBefore = file.entries.length;
  const totalAfter = file.entries.filter((e) => e.active).length;
  const next: ProjectMemoryFile = { ...file, updatedAt: new Date().toISOString() };
  await save(next);
  return { kept: plan.stats.keep, merged, archived, totalBefore, totalAfter };
}
