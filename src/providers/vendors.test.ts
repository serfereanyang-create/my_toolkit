/**
 * vendors.test.ts — 六家厂商适配测试
 * 覆盖：推理参数构造、端点/环境变量、模型识别、用量归一化、能力钳制。
 */

import { describe, it, expect } from 'vitest';
import {
  VENDOR_PROFILES,
  detectVendor,
  firstEnv,
  grokReasoningEffort,
  glmThinkingParam,
  isGlm53,
  isKimiThinkingModel,
  isDeepseekReasoner,
  deepseekCacheReadTokens,
} from './vendors.js';
import { getReasoningCapability, clampReasoningEffort } from './capabilities.js';

describe('VENDOR_PROFILES 基础档案', () => {
  it('六家厂商默认端点正确', () => {
    expect(VENDOR_PROFILES.grok.defaultBaseUrl).toBe('https://api.x.ai/v1');
    expect(VENDOR_PROFILES.glm.defaultBaseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(VENDOR_PROFILES.kimi.defaultBaseUrl).toBe('https://api.moonshot.cn/v1');
    expect(VENDOR_PROFILES.deepseek.defaultBaseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('API Key 环境变量含双名回退（XAI/GROK、ZHIPU/GLM、MOONSHOT/KIMI）', () => {
    expect(VENDOR_PROFILES.grok.apiKeyEnvVars).toEqual(['XAI_API_KEY', 'GROK_API_KEY']);
    expect(VENDOR_PROFILES.glm.apiKeyEnvVars).toEqual(['ZHIPU_API_KEY', 'GLM_API_KEY', 'ZAI_API_KEY']);
    expect(VENDOR_PROFILES.kimi.apiKeyEnvVars).toEqual(['MOONSHOT_API_KEY', 'KIMI_API_KEY']);
    expect(VENDOR_PROFILES.deepseek.apiKeyEnvVars).toEqual(['DEEPSEEK_API_KEY']);
  });

  it('firstEnv 按优先级取第一个非空值', () => {
    const env = { GROK_API_KEY: 'g', XAI_API_KEY: 'x' };
    expect(firstEnv(['XAI_API_KEY', 'GROK_API_KEY'], env)).toBe('x');
    expect(firstEnv(['XAI_API_KEY', 'GROK_API_KEY'], { GROK_API_KEY: 'g' })).toBe('g');
    expect(firstEnv(['XAI_API_KEY'], {})).toBeUndefined();
  });
});

describe('grok 推理参数', () => {
  it('reasoning_effort 只接受 low|high，中档映射到 high', () => {
    expect(grokReasoningEffort('low')).toBe('low');
    expect(grokReasoningEffort('medium')).toBe('high');
    expect(grokReasoningEffort('high')).toBe('high');
    expect(grokReasoningEffort('max')).toBe('high');
    expect(grokReasoningEffort('off')).toBeUndefined();
  });

  it('grok-4 系固定推理不发 effort 参数，grok-3 发', () => {
    expect(VENDOR_PROFILES.grok.reasoningBodyParam('high', 'grok-4')).toBeUndefined();
    expect(VENDOR_PROFILES.grok.reasoningBodyParam('high', 'grok-4-fast')).toBeUndefined();
    expect(VENDOR_PROFILES.grok.reasoningBodyParam('medium', 'grok-3-mini')).toEqual({ reasoning_effort: 'high' });
    expect(VENDOR_PROFILES.grok.reasoningBodyParam('off', 'grok-3-mini')).toBeUndefined();
  });
});

describe('glm 推理参数', () => {
  it('GLM-4.5+/5 走 thinking 开关：off 必须显式 disabled', () => {
    expect(VENDOR_PROFILES.glm.reasoningBodyParam('off', 'glm-4.6')).toEqual({ thinking: { type: 'disabled' } });
    expect(VENDOR_PROFILES.glm.reasoningBodyParam('high', 'glm-4.6')).toEqual({ thinking: { type: 'enabled' } });
  });

  it('GLM-5.3 推理常开：thinking enabled + reasoning_effort 档位', () => {
    const body = VENDOR_PROFILES.glm.reasoningBodyParam('high', 'glm-5.3');
    expect(body).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });

    const offBody = VENDOR_PROFILES.glm.reasoningBodyParam('off', 'glm-5.3');
    // 5.3 不能关闭思考，off 也保持 enabled
    expect(offBody).toEqual({ thinking: { type: 'enabled' } });
  });

  it('isGlm53 与非 5.3 模型区分', () => {
    expect(isGlm53('glm-5.3')).toBe(true);
    expect(isGlm53('GLM_5.3')).toBe(true);
    expect(isGlm53('glm-4.6')).toBe(false);
    expect(isGlm53('glm-5')).toBe(false);
  });
});

describe('kimi 推理模型识别', () => {
  it('k2-thinking / k2.5 为思考模型，k2 非思考系不是', () => {
    expect(isKimiThinkingModel('kimi-k2-thinking')).toBe(true);
    expect(isKimiThinkingModel('kimi-k2.5')).toBe(true);
    expect(isKimiThinkingModel('kimi-k2-0905-preview')).toBe(false);
    expect(isKimiThinkingModel('kimi-k2-turbo-preview')).toBe(false);
  });

  it('kimi 不发推理参数（思考由服务端固定控制）', () => {
    expect(VENDOR_PROFILES.kimi.reasoningBodyParam('high', 'kimi-k2-thinking')).toBeUndefined();
    expect(VENDOR_PROFILES.kimi.reasoningBodyParam('off', 'kimi-k2-0905-preview')).toBeUndefined();
  });
});

describe('deepseek 用量与推理识别', () => {
  it('prompt_cache_hit_tokens 提取为缓存命中', () => {
    expect(deepseekCacheReadTokens({ prompt_cache_hit_tokens: 5120 })).toBe(5120);
    // 没有专有字段时回退到标准 OpenAI 字段
    expect(deepseekCacheReadTokens({ prompt_tokens_details: { cached_tokens: 256 } })).toBe(256);
    expect(deepseekCacheReadTokens({})).toBeUndefined();
  });

  it('deepseek 不发推理参数', () => {
    expect(VENDOR_PROFILES.deepseek.reasoningBodyParam('high', 'deepseek-reasoner')).toBeUndefined();
    expect(VENDOR_PROFILES.deepseek.reasoningBodyParam('off', 'deepseek-chat')).toBeUndefined();
  });

  it('reasoner/r 系识别为推理模型', () => {
    expect(isDeepseekReasoner('deepseek-reasoner')).toBe(true);
    expect(isDeepseekReasoner('deepseek-r1')).toBe(true);
    expect(isDeepseekReasoner('deepseek-chat')).toBe(false);
  });
});

describe('detectVendor 自动识别', () => {
  it('按端点识别', () => {
    expect(detectVendor('https://api.x.ai/v1', 'any')).toBe('grok');
    expect(detectVendor('https://open.bigmodel.cn/api/paas/v4', 'any')).toBe('glm');
    expect(detectVendor('https://api.moonshot.cn/v1', 'any')).toBe('kimi');
    expect(detectVendor('https://api.deepseek.com/v1', 'any')).toBe('deepseek');
  });

  it('无端点特征时按模型名识别', () => {
    expect(detectVendor('https://proxy.example.com/v1', 'grok-4')).toBe('grok');
    expect(detectVendor(undefined, 'glm-4.6')).toBe('glm');
    expect(detectVendor(undefined, 'kimi-k2-thinking')).toBe('kimi');
    expect(detectVendor(undefined, 'deepseek-reasoner')).toBe('deepseek');
  });

  it('无法识别时返回 undefined（走纯 OpenAI 兼容路径）', () => {
    expect(detectVendor('https://relay.example.com/v1', 'gpt-5.5')).toBeUndefined();
  });
});

describe('六厂商推理能力', () => {
  it('anthropic claude-4 用 thinking budget，claude-3-5 不支持', () => {
    expect(getReasoningCapability('anthropic', 'claude-sonnet-4-5').nativeMode).toBe('anthropic-thinking');
    expect(getReasoningCapability('anthropic', 'claude-3-5-sonnet').support).toBe('unsupported');
  });

  it('openai gpt-5/o 系用 reasoning_effort', () => {
    expect(getReasoningCapability('openai', 'gpt-5.5').nativeMode).toBe('openai-reasoning-effort');
    expect(getReasoningCapability('openai', 'gpt-4o').support).toBe('unsupported');
  });

  it('grok-4 固定推理，grok-3 两档', () => {
    const grok4 = getReasoningCapability('grok', 'grok-4');
    expect(grok4.nativeMode).toBe('reasoning-content');
    expect(grok4.fallbackAllowed).toBe(false);

    const grok3 = getReasoningCapability('grok', 'grok-3-mini');
    expect(grok3.nativeMode).toBe('openai-reasoning-effort');
    expect(grok3.maxTier).toBe('high');
  });

  it('glm-5.3 用档位，glm-4.6 用开关', () => {
    expect(getReasoningCapability('glm', 'glm-5.3').nativeMode).toBe('openai-reasoning-effort');
    expect(getReasoningCapability('glm', 'glm-4.6').nativeMode).toBe('glm-thinking-toggle');
  });

  it('kimi/deepseek 思考模型固定推理，非思考不支持', () => {
    expect(getReasoningCapability('kimi', 'kimi-k2-thinking').nativeMode).toBe('reasoning-content');
    expect(getReasoningCapability('kimi', 'kimi-k2-0905-preview').support).toBe('unsupported');
    expect(getReasoningCapability('deepseek', 'deepseek-reasoner').nativeMode).toBe('reasoning-content');
    expect(getReasoningCapability('deepseek', 'deepseek-chat').support).toBe('unsupported');
  });

  it('clampReasoningEffort：固定推理模型保持请求档位（思考无法关），不支持模型降到 off', () => {
    const fixed = getReasoningCapability('grok', 'grok-4');
    expect(clampReasoningEffort('high', fixed)).toBe('high');
    expect(clampReasoningEffort('off', fixed)).toBe('off');

    const unsupported = getReasoningCapability('deepseek', 'deepseek-chat');
    expect(clampReasoningEffort('high', unsupported)).toBe('off');
  });
});
