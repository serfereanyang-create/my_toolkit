import type { ChatItem, ContextStats } from '../types';

/**
 * 常驻侧栏「上下文」面板的取数与取整规则。
 *
 * 这里一个数都不许编：窗口和自动压缩阈值来自 CLI 的 `context_stats` 载荷
 * （`buildContextStats` 里由 `resolveContextWindowTokens` /
 * `autoCompactTokenLimit` 算出），分类 token 是把**真实输入 token** 按各组件
 * 字符占比摊开的——CLI 那边已经摊好，界面只负责显示和排版。
 *
 * 拿不到窗口就说拿不到（`window: null` → 百分比显示 "—"），而不是自己乘一个
 * 0.9 或者猜 128k：那样的数字看起来精确，实际上和真实策略无关。
 */

export type ContextSegmentKey = 'messages' | 'mcpTools' | 'systemTools' | 'systemPrompt' | 'skills' | 'other';

export type ContextSegment = {
  key: ContextSegmentKey;
  label: string;
  tokens: number;
  /** 占**窗口**的百分比；窗口未知时为 null（不显示 0%）。 */
  percent: number | null;
  color: string;
};

/** 顺序照抄 Claude Code 那张卡片，颜色则是本应用自己的调色板。 */
const SEGMENT_META: Array<{ key: ContextSegmentKey; label: string; color: string }> = [
  { key: 'messages', label: '消息', color: '#3b82f6' },
  { key: 'mcpTools', label: 'MCP 工具', color: '#f97316' },
  { key: 'systemTools', label: '系统工具', color: '#10b981' },
  { key: 'systemPrompt', label: '系统提示词', color: '#f59e0b' },
  { key: 'skills', label: '技能', color: '#8b5cf6' },
  { key: 'other', label: '项目说明与策略', color: '#94a3b8' },
];

export type ContextPanelModel = {
  provider: string | null;
  model: string | null;
  /** 模型上下文窗口；拿不到就是 null。 */
  window: number | null;
  /** 本次请求真正占用的上下文 token（含缓存命中的那部分）。 */
  used: number;
  /** 占用比例（0-100，一位小数）；窗口未知时 null。 */
  percent: number | null;
  /** 自动压缩阈值（窗口的 90%，由 CLI 报）；未知 null。 */
  limit: number | null;
  /** 距离自动压缩还有多少 token；已达或未知 null。 */
  untilCompact: number | null;
  /** 窗口里留给自动压缩的余量（窗口 - 阈值）。 */
  buffer: number | null;
  /** 窗口剩余（窗口 - 已用）。 */
  free: number | null;
  segments: ContextSegment[];
};

const round1 = (value: number) => Math.round(value * 10) / 10;

export function buildContextPanel(
  stats: ContextStats | null | undefined,
  fallbackWindow?: number | null,
): ContextPanelModel {
  if (!stats) {
    return {
      provider: null, model: null, window: fallbackWindow ?? null,
      used: 0, percent: null, limit: null, untilCompact: null, buffer: null, free: null,
      segments: [],
    };
  }

  const categories = stats.categories;
  const categorySum = categories
    ? SEGMENT_META.reduce((sum, meta) => sum + (categories[meta.key] ?? 0), 0)
    : 0;
  // 分类之和就是这次请求的输入总量（CLI 把余数塞进 other，保证不重不漏）。
  // 旧载荷没有 categories 时才退回 usage 字段。
  const used = categorySum > 0 ? categorySum : stats.inputTokens + stats.cacheReadTokens;

  const window = stats.contextWindow ?? fallbackWindow ?? null;
  const limit = stats.autoCompactLimit ?? null;
  const percent = window && window > 0 ? round1((used / window) * 100) : null;

  const segments: ContextSegment[] = categories
    ? SEGMENT_META
        .map((meta) => {
          const tokens = categories[meta.key] ?? 0;
          return {
            key: meta.key,
            label: meta.label,
            tokens,
            percent: window && window > 0 ? round1((tokens / window) * 100) : null,
            color: meta.color,
          };
        })
        .filter((segment) => segment.tokens > 0)
    : [];

  return {
    provider: stats.provider,
    model: stats.model,
    window,
    used,
    percent,
    limit,
    untilCompact: limit !== null ? Math.max(0, limit - used) : null,
    buffer: window !== null && limit !== null ? Math.max(0, window - limit) : null,
    free: window !== null ? Math.max(0, window - used) : null,
    segments,
  };
}

/** 154.6k / 4.9k / 580 —— 和卡片上的写法一致。 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${round1(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${round1(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

export type OutputFile = {
  path: string;
  added: number;
  removed: number;
  /** 这个文件被改过几个回合（同一回合改两次只算一次）。 */
  turns: number;
};

/**
 * 本会话写过的文件，最近改的排在前面。
 *
 * 数据来自每个回合自己记的「真实改动的文件」（`turn.files`，带 +/- 行数与
 * 检查点 id），不是从工具参数里猜的路径——猜出来的清单会把失败的写入也算进去。
 */
export function sessionOutputs(chat: ChatItem[]): OutputFile[] {
  const byPath = new Map<string, OutputFile & { lastSeen: number }>();
  chat.forEach((item, index) => {
    if (item.kind !== 'turn') return;
    const seenThisTurn = new Set<string>();
    for (const file of item.files ?? []) {
      if (!file?.path) continue;
      const current = byPath.get(file.path) ?? { path: file.path, added: 0, removed: 0, turns: 0, lastSeen: index };
      current.added += Number.isFinite(file.added) ? file.added : 0;
      current.removed += Number.isFinite(file.removed) ? file.removed : 0;
      if (!seenThisTurn.has(file.path)) {
        current.turns += 1;
        seenThisTurn.add(file.path);
      }
      current.lastSeen = index;
      byPath.set(file.path, current);
    }
  });
  return [...byPath.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(({ lastSeen: _lastSeen, ...file }) => file);
}

/** 工作区根目录 → 侧栏上那一行短名字（末级目录名）。 */
export function workspaceLabel(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : root;
}
