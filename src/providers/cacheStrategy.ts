/**
 * cacheStrategy.ts — 跨厂商提示缓存策略层
 *
 * 行业主流方案分两类：
 * 1. 显式断点（Anthropic cache_control，可配 5m/1h TTL）——断点标记"缓存到哪里"，
 *    我们用单一链尾断点 + 滑动消息断点保证 tools+system+历史是一个连续缓存段。
 * 2. 自动前缀缓存（OpenAI / DeepSeek / Kimi / GLM / Gemini 隐式）——无参数可发，
 *    唯一杠杆是让提示前缀逐字节稳定：稳定 system 在头部，每轮变化的
 *    toolStrategy 尾置到消息数组末尾，历史部分才可能命中。
 *
 * 诊断方法（实战验证）：对两轮请求的分段做 sha256，哪段哈希变了哪段就是缓存杀手。
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Anthropic 显式断点：TTL 旋钮
// ---------------------------------------------------------------------------

export type CacheTtl = '5m' | '1h';

export type CacheControl = { type: 'ephemeral'; ttl?: '1h' };

/**
 * 读取 AICODE_CACHE_TTL 环境变量（'5m' 默认 / '1h'）。
 * 1h TTL 写入费 2x，适合跨小时的长会话；5m 写入费 1.25x，适合常规 agent 节奏。
 */
export function resolveCacheTtl(env: NodeJS.ProcessEnv = process.env): CacheTtl {
  return env.AICODE_CACHE_TTL === '1h' ? '1h' : '5m';
}

/** 构造 Anthropic cache_control 对象；默认 5m 时不带 ttl 字段（省字节且兼容老网关）。 */
export function cacheControl(ttl: CacheTtl = resolveCacheTtl()): CacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

// ---------------------------------------------------------------------------
// 自动前缀缓存布局：动态内容尾置
// ---------------------------------------------------------------------------

/**
 * 构造自动前缀缓存友好的消息布局：
 * - 头部：稳定 system（tools 说明 + 项目上下文，逐轮字节一致）
 * - 中部：完整对话历史（逐轮只增不改）
 * - 尾部：每轮变化的 toolStrategy 作为最后一条 system 消息
 *
 * 自动前缀缓存按位置从 0 开始做字节比较，strategy 尾置后，
 * 轮与轮之间"strategy 之前"的整段（system + 全部历史）保持一致 → 可命中；
 * strategy 若混在头部 system 里（旧行为），第一处差异就出现在提示开头，
 * 整个历史每轮重付。
 */
export function buildAutoCacheMessages(
  stableSystem: string,
  messages: Array<{ role: string; content: unknown }>,
  dynamicStrategy?: string
): Array<{ role: string; content: unknown }> {
  const result: Array<{ role: string; content: unknown }> = [
    { role: 'system', content: stableSystem },
    ...messages,
  ];
  if (dynamicStrategy && dynamicStrategy.trim()) {
    result.push({
      role: 'system',
      content: `Current-turn tool strategy (dynamic; do not treat as stable project instructions):\n${dynamicStrategy.trim()}`,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 分段哈希诊断（定位缓存杀手的实战方法）
// ---------------------------------------------------------------------------

export function hashSegment(segment: string): string {
  return createHash('sha256').update(segment).digest('hex').slice(0, 16);
}

export type PromptSegments = {
  /** 稳定 system（tools + 项目上下文） */
  stableSystem: string;
  /** 每轮变化的 toolStrategy */
  toolStrategy: string;
  /** 除最后一条外的消息内容（滑动断点覆盖范围） */
  messageHistory: string;
  /** 最后一条消息（唯一的新增量） */
  lastMessage: string;
};

export type CacheSegmentDiff = {
  stableSystemChanged: boolean;
  toolStrategyChanged: boolean;
  messageHistoryChanged: boolean;
  lastMessageChanged: boolean;
  /** 人读诊断结论 */
  verdict: string;
};

/** 对比两轮请求的分段哈希，定位破坏前缀稳定性的段。 */
export function diffCacheSegments(prev: PromptSegments, curr: PromptSegments): CacheSegmentDiff {
  const stableSystemChanged = hashSegment(prev.stableSystem) !== hashSegment(curr.stableSystem);
  const toolStrategyChanged = hashSegment(prev.toolStrategy) !== hashSegment(curr.toolStrategy);
  const messageHistoryChanged = hashSegment(prev.messageHistory) !== hashSegment(curr.messageHistory);
  const lastMessageChanged = hashSegment(prev.lastMessage) !== hashSegment(curr.lastMessage);

  let verdict: string;
  if (stableSystemChanged) {
    verdict = '稳定 system 段变化（缓存杀手）：检查 tools 列表、项目上下文或身份信息是否逐轮变动。';
  } else if (messageHistoryChanged && !lastMessageChanged && !toolStrategyChanged) {
    verdict = '历史消息被改写（追加以外的方式）：检查是否有消息在发出后被编辑或重排。';
  } else if (toolStrategyChanged && !stableSystemChanged) {
    verdict = '仅 strategy 变化：显式断点厂商命中到 system 为止；自动前缀厂商要求 strategy 已尾置。';
  } else {
    verdict = '前缀稳定，符合预期（最后一条消息本就是新增量）。';
  }

  return { stableSystemChanged, toolStrategyChanged, messageHistoryChanged, lastMessageChanged, verdict };
}
