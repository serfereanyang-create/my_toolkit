/**
 * vendors.ts — 六家厂商的一等公民适配档案
 *
 * anthropic / openai 走各自的原生协议实现；grok(xAI) / glm(智谱) /
 * kimi(Moonshot) / deepseek 都是 OpenAI 兼容协议，但各家在推理参数、
 * 缓存用量字段、默认端点、模型命名上有真实差异，这里逐一建模。
 */

import type { ReasoningEffort } from './types.js';

export type VendorId = 'grok' | 'glm' | 'kimi' | 'deepseek';

/** 推理参数的原生形态 */
export type ReasoningParamMode =
  | 'reasoning-effort'      // OpenAI 风格 reasoning_effort: low|medium|high
  | 'thinking-budget'       // Anthropic 风格 thinking.budget_tokens
  | 'glm-thinking-toggle'   // 智谱 thinking: {type: enabled|disabled}
  | 'reasoning-content-only'; // 服务端固定输出 reasoning_content，客户端只管收集，不发参数

export type VendorOpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek 专有：缓存命中/未命中 token 数 */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

export type VendorProfile = {
  id: VendorId;
  displayName: string;
  /** 官方默认 API 端点（OpenAI 兼容根路径） */
  defaultBaseUrl: string;
  /** 国际版备用端点（部分厂商国内外双域名） */
  altBaseUrl?: string;
  /** 识别 API Key 的环境变量，按优先级排列 */
  apiKeyEnvVars: string[];
  /** 识别模型的环境变量，按优先级排列 */
  modelEnvVars: string[];
  /** 未指定模型时的默认模型 */
  defaultModel: string;
  reasoningMode: ReasoningParamMode;
  /**
   * 构造该厂商推理请求体片段。返回 undefined 表示此 tier 下不发参数
   * （例如固定推理模型不发、关闭时智谱要显式发 disabled）。
   */
  reasoningBodyParam: (effort: ReasoningEffort, model: string) => Record<string, unknown> | undefined;
  /** 厂商专有用量块 → 统一 ProviderUsage 的缓存字段提取 */
  extractCacheReadTokens?: (usage: VendorOpenAIUsage) => number | undefined;
  /** 模型名 → 是否推理模型（始终输出 reasoning_content） */
  isReasoningModel: (model: string) => boolean;
};

// ---------------------------------------------------------------------------
// grok (xAI) — https://api.x.ai/v1，OpenAI 兼容
// reasoning_content 出现在 delta；reasoning_effort 仅接受 low|high
// （grok-3-mini / grok-4 系）。grok-4 固定推理，不接受 effort 参数。
// ---------------------------------------------------------------------------

export function grokReasoningEffort(effort: ReasoningEffort | undefined): 'low' | 'high' | undefined {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
    case 'high':
    case 'max':
      // xAI 无 medium 档：中/高/极高都映射到它的最高实值 high
      return 'high';
    case 'off':
    case undefined:
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// glm (智谱) — https://open.bigmodel.cn/api/paas/v4，OpenAI 兼容
// GLM-4.5+/5 系用 thinking 开关；GLM-5.3 推理常开并接受 reasoning_effort。
// ---------------------------------------------------------------------------

export function glmThinkingParam(effort: ReasoningEffort | undefined): Record<string, unknown> | undefined {
  switch (effort) {
    case 'off':
      // 智谱必须显式关闭：不发会被默认开启
      return { thinking: { type: 'disabled' } };
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
    case 'auto':
    case undefined:
      return { thinking: { type: 'enabled' } };
  }
}

export function isGlm53(model: string): boolean {
  const id = model.toLowerCase();
  return /glm[-_]?5\.3/.test(id);
}

// ---------------------------------------------------------------------------
// kimi (Moonshot) — https://api.moonshot.cn/v1（国内）/ api.moonshot.ai（国际）
// K2 系非推理模型不输出思考；k2-thinking 系固定输出 reasoning_content。
// ---------------------------------------------------------------------------

export function isKimiThinkingModel(model: string): boolean {
  const id = model.toLowerCase();
  return /k2[^a-z0-9]*(thinking|reasoning)|(^|[-_])thinking([-_]|$)/.test(id) || id.includes('k2.5');
}

// ---------------------------------------------------------------------------
// deepseek — https://api.deepseek.com/v1，OpenAI 兼容
// deepseek-reasoner 固定推理（reasoning_content），deepseek-chat 非推理。
// 用量块带 prompt_cache_hit_tokens（上下文缓存命中），这是 DeepSeek 专有字段。
// ---------------------------------------------------------------------------

export function isDeepseekReasoner(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes('reasoner') || /deepseek[-_]?r\d/.test(id);
}

export function deepseekCacheReadTokens(usage: VendorOpenAIUsage): number | undefined {
  if (typeof usage.prompt_cache_hit_tokens === 'number' && usage.prompt_cache_hit_tokens > 0) {
    return usage.prompt_cache_hit_tokens;
  }
  // 新版 V3.x 也可能走标准 OpenAI 字段
  return usage.prompt_tokens_details?.cached_tokens;
}

// ---------------------------------------------------------------------------
// 档案表
// ---------------------------------------------------------------------------

export const VENDOR_PROFILES: Record<VendorId, VendorProfile> = {
  grok: {
    id: 'grok',
    displayName: 'xAI Grok',
    defaultBaseUrl: 'https://api.x.ai/v1',
    apiKeyEnvVars: ['XAI_API_KEY', 'GROK_API_KEY'],
    modelEnvVars: ['XAI_MODEL', 'GROK_MODEL'],
    defaultModel: 'grok-4-fast',
    reasoningMode: 'reasoning-effort',
    reasoningBodyParam(effort, model) {
      // grok-4 / grok-4-fast 固定推理：不发 effort 参数（发了会被 xAI 拒绝）
      if (/grok[-_]?4/.test(model.toLowerCase())) return undefined;
      const mapped = grokReasoningEffort(effort);
      return mapped ? { reasoning_effort: mapped } : undefined;
    },
    isReasoningModel(model) {
      return /grok[-_]?(3|4)/.test(model.toLowerCase());
    },
  },

  glm: {
    id: 'glm',
    displayName: '智谱 GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    altBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKeyEnvVars: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'ZAI_API_KEY'],
    modelEnvVars: ['ZHIPU_MODEL', 'GLM_MODEL'],
    defaultModel: 'glm-5.3',
    reasoningMode: 'glm-thinking-toggle',
    reasoningBodyParam(effort, model) {
      // GLM-5.3 推理常开：接受 reasoning_effort 档位，同时保持 thinking 开启
      if (isGlm53(model)) {
        const mapped = grokReasoningEffort(effort); // 同样的 low/high 压缩规则
        return { thinking: { type: 'enabled' }, ...(mapped ? { reasoning_effort: mapped } : {}) };
      }
      return glmThinkingParam(effort);
    },
    isReasoningModel(model) {
      const id = model.toLowerCase();
      return /glm[-_]?[456]/.test(id) ? !/flash|air|flashx/.test(id) : false;
    },
  },

  kimi: {
    id: 'kimi',
    displayName: 'Kimi (Moonshot)',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    altBaseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnvVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    modelEnvVars: ['MOONSHOT_MODEL', 'KIMI_MODEL'],
    defaultModel: 'kimi-k2-thinking',
    reasoningMode: 'reasoning-content-only',
    reasoningBodyParam(effort, model) {
      // K2 非 thinking 系没有思考开关也没有档位；thinking 系固定开启。
      // 唯一需要发参数的场景：非 thinking 模型上用户想开思考 → 换模型名，
      // 参数层面无能为力，所以始终返回 undefined（不发参数）。
      void effort;
      void model;
      return undefined;
    },
    isReasoningModel(model) {
      return isKimiThinkingModel(model);
    },
  },

  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvVars: ['DEEPSEEK_API_KEY'],
    modelEnvVars: ['DEEPSEEK_MODEL'],
    defaultModel: 'deepseek-chat',
    reasoningMode: 'reasoning-content-only',
    reasoningBodyParam(effort, model) {
      // deepseek-reasoner 固定推理不能关闭；deepseek-chat 没有推理。
      // 两者都不接受 effort 参数 —— 唯一映射：chat 模型上请求推理档位时
      // 切不出去，返回 undefined 让请求按普通 chat 走。
      void effort;
      void model;
      return undefined;
    },
    isReasoningModel(model) {
      return isDeepseekReasoner(model);
    },
  },
};

export const VENDOR_IDS: VendorId[] = ['grok', 'glm', 'kimi', 'deepseek'];

export function isVendorId(value: string | undefined): value is VendorId {
  return Boolean(value && (VENDOR_IDS as string[]).includes(value));
}

/**
 * 从 baseUrl / 模型名猜测厂商，用于桌面自定义 provider 的自动识别。
 * 优先 URL 特征，其次模型名特征。
 */
export function detectVendor(baseUrl: string | undefined, model: string): VendorId | undefined {
  const url = (baseUrl ?? '').toLowerCase();
  const id = model.toLowerCase();

  if (url.includes('x.ai') || url.includes('xai')) return 'grok';
  if (url.includes('bigmodel.cn') || url.includes('zhipu')) return 'glm';
  if (url.includes('moonshot')) return 'kimi';
  if (url.includes('deepseek')) return 'deepseek';

  if (/^grok[-_]?\d/.test(id)) return 'grok';
  if (/glm[-_]?\d/.test(id)) return 'glm';
  if (/kimi[-_]?k\d|^k2[-_.]/.test(id)) return 'kimi';
  if (id.includes('deepseek')) return 'deepseek';

  return undefined;
}

/** 从环境变量组里取第一个非空值。 */
export function firstEnv(envVars: string[], env: Record<string, string | undefined>): string | undefined {
  for (const name of envVars) {
    const value = env[name];
    if (value && value.trim() !== '') return value;
  }
  return undefined;
}
