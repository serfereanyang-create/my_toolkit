import type { ReasoningEffort, ProviderName } from './types.js';
import { isDeepseekReasoner, isGlm53, isKimiThinkingModel } from './vendors.js';
import { analyzeTaskComplexity } from '../tasks/complexity.js';

export type ReasoningSupport = 'supported' | 'unsupported' | 'unknown';

export type ReasoningCapability = {
  support: ReasoningSupport;
  nativeMode: 'anthropic-thinking' | 'openai-reasoning-effort' | 'glm-thinking-toggle' | 'gemini-thinking-budget' | 'reasoning-content' | 'none';
  maxTier: ReasoningEffort;
  maxBudgetTokens?: number;
  fallbackAllowed: boolean;
};

const OFF: ReasoningCapability = {
  support: 'unsupported', nativeMode: 'none', maxTier: 'off', fallbackAllowed: false,
};

/** 推理文本由服务端固定输出（reasoning_content），客户端只收集不发参数。 */
const FIXED_REASONING: ReasoningCapability = {
  support: 'supported', nativeMode: 'reasoning-content', maxTier: 'max', fallbackAllowed: false,
};

export function getReasoningCapability(provider: ProviderName | string, model: string): ReasoningCapability {
  const id = model.toLowerCase();

  if (provider === 'anthropic') {
    if (id.includes('claude-3-7') || id.includes('claude-4') || id.includes('claude-opus-4') || id.includes('claude-sonnet-4')) {
      return { support: 'supported', nativeMode: 'anthropic-thinking', maxTier: 'max', maxBudgetTokens: 24576, fallbackAllowed: true };
    }
    if (id.includes('claude-3-5') || id.includes('claude-3-haiku') || id.includes('claude-3-sonnet')) {
      return { support: 'unsupported', nativeMode: 'none', maxTier: 'off', fallbackAllowed: true };
    }
    return { support: 'unknown', nativeMode: 'anthropic-thinking', maxTier: 'max', maxBudgetTokens: 24576, fallbackAllowed: true };
  }

  if (provider === 'openai') {
    if (/^(o1|o3|o4)([-.]|$)/.test(id) || id.includes('gpt-5')) {
      return { support: 'supported', nativeMode: 'openai-reasoning-effort', maxTier: 'high', fallbackAllowed: true };
    }
    if (id.includes('gpt-4o') || id.includes('gpt-4-turbo') || id.includes('gpt-3.5')) return OFF;
    return { support: 'unknown', nativeMode: 'openai-reasoning-effort', maxTier: 'high', fallbackAllowed: true };
  }

  // Responses 线格式（/v1/responses，含走中转的自定义端点）：同一个 effort 旋钮。
  // 缺这个分支时 openai-responses 落到兜底 OFF，桌面思考强度档位会被静默剥成 off。
  if (provider === 'openai-responses') {
    if (/^(o1|o3|o4)([-.]|$)/.test(id) || id.includes('gpt-5')) {
      return { support: 'supported', nativeMode: 'openai-reasoning-effort', maxTier: 'high', fallbackAllowed: true };
    }
    if (id.includes('gpt-4o') || id.includes('gpt-4-turbo') || id.includes('gpt-3.5')) return OFF;
    return { support: 'unknown', nativeMode: 'openai-reasoning-effort', maxTier: 'high', fallbackAllowed: true };
  }

  // ---- 厂商一等公民：grok / glm / kimi / deepseek ----

  // Gemini 的 thinking 不走 effort 参数，而是 thinkingConfig.thinkingBudget
  // （low 2048 / medium 8192 / high 16384 / max 24576，映射在 gemini.ts）。
  // 缺这个分支时它落到兜底 OFF，用户选的档位被静默剥成 off，而 gemini.ts
  // 只看请求值，于是"界面上是 off、实际发的是 low 预算"，两头对不上。
  if (provider === 'gemini') {
    if (/gemini-2\.5/.test(id) || /gemini-3/.test(id)) {
      return { support: 'supported', nativeMode: 'gemini-thinking-budget', maxTier: 'max', fallbackAllowed: true };
    }
    // gemini 2.0 / 1.5 不接受 thinkingConfig
    if (/gemini-[12]\./.test(id) || /gemini-(pro|flash|flash-lite)/.test(id)) return OFF;
    return { support: 'unknown', nativeMode: 'gemini-thinking-budget', maxTier: 'max', fallbackAllowed: true };
  }

  if (provider === 'grok') {
    // grok-4 系固定推理，不接受 effort 参数；grok-3 系接受 low|high
    if (/grok[-_]?4/.test(id)) return FIXED_REASONING;
    if (/grok[-_]?3/.test(id)) {
      return { support: 'supported', nativeMode: 'openai-reasoning-effort', maxTier: 'high', fallbackAllowed: true };
    }
    return { support: 'unknown', nativeMode: 'openai-reasoning-effort', maxTier: 'high', fallbackAllowed: true };
  }

  if (provider === 'glm') {
    if (isGlm53(id)) {
      // GLM-5.3 推理常开，接受 reasoning_effort 档位（厂商档案把 low/high 两档
      // 映射成 xAI 风格 low|high，所以这里的天花板就是 high，不是 max）。
      return { support: 'supported', nativeMode: 'openai-reasoning-effort', maxTier: 'high', fallbackAllowed: true };
    }
    if (/glm[-_]?[456]/.test(id)) {
      // GLM-4.5+/5 系走 thinking 开关：开或关，无档位。用户选 low/medium/high
      // 落到同一个"开"，选 off 必须显式发 disabled（厂商默认开）。
      return { support: 'supported', nativeMode: 'glm-thinking-toggle', maxTier: 'high', fallbackAllowed: true };
    }
    return { support: 'unknown', nativeMode: 'glm-thinking-toggle', maxTier: 'high', fallbackAllowed: true };
  }

  if (provider === 'kimi') {
    if (isKimiThinkingModel(id)) return FIXED_REASONING;
    // K2 非思考系：没有推理开关
    return OFF;
  }

  if (provider === 'deepseek') {
    if (isDeepseekReasoner(id)) return FIXED_REASONING;
    // deepseek-chat：非推理模型
    return OFF;
  }

  return OFF;
}

export function autoReasoningEffort(prompt: string, taskBoard = false): ReasoningEffort {
  const complexity = analyzeTaskComplexity(prompt).complexity;
  if (taskBoard || complexity === 'large') return 'high';
  if (complexity === 'standard') return 'medium';
  return 'low';
}

export function clampReasoningEffort(requested: ReasoningEffort, capability: ReasoningCapability, prompt = '', taskBoard = false): ReasoningEffort {
  const resolved = requested === 'auto' ? autoReasoningEffort(prompt, taskBoard) : requested;
  if (resolved === 'off' || capability.support === 'unsupported') return 'off';
  if (resolved === 'max' && capability.maxTier === 'high') return 'high';
  if (capability.maxTier === 'low') return 'low';
  return resolved;
}
