import type { ReasoningEffort, ProviderName } from './types.js';

export type ReasoningSupport = 'supported' | 'unsupported' | 'unknown';

export type ReasoningCapability = {
  support: ReasoningSupport;
  nativeMode: 'anthropic-thinking' | 'openai-reasoning-effort' | 'none';
  maxTier: ReasoningEffort;
  maxBudgetTokens?: number;
  fallbackAllowed: boolean;
};

const OFF: ReasoningCapability = {
  support: 'unsupported', nativeMode: 'none', maxTier: 'off', fallbackAllowed: false,
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
  return OFF;
}

export function autoReasoningEffort(prompt: string, taskBoard = false): ReasoningEffort {
  const text = prompt.toLowerCase();
  if (taskBoard || /重构|架构|多文件|复杂|深度|refactor|architecture|multi.?file|complex|deep/.test(text)) return 'high';
  if (/修改|修复|实现|测试|edit|fix|implement|test/.test(text)) return 'medium';
  if (/读取|查看|解释|查询|read|show|explain|what|list/.test(text)) return 'low';
  return 'off';
}

export function clampReasoningEffort(requested: ReasoningEffort, capability: ReasoningCapability, prompt = '', taskBoard = false): ReasoningEffort {
  const resolved = requested === 'auto' ? autoReasoningEffort(prompt, taskBoard) : requested;
  if (resolved === 'off' || capability.support === 'unsupported') return 'off';
  if (resolved === 'max' && capability.maxTier === 'high') return 'high';
  if (capability.maxTier === 'low') return 'low';
  return resolved;
}
