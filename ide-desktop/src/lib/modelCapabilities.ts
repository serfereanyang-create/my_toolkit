import type { ProviderConfig, ReasoningEffort } from '../types';

export type ReasoningUiMode = 'tiers' | 'toggle' | 'budget' | 'always' | 'unknown';
export type ReasoningNativeField = 'thinking' | 'reasoning_effort' | 'thinkingConfig' | 'none' | 'unknown';

export type ModelReasoningCapability = {
  mode: ReasoningUiMode;
  supported: boolean | 'unknown';
  options: ReasoningEffort[];
  nativeField: ReasoningNativeField;
  description: string;
  alwaysOn?: boolean;
};

const TIER_OPTIONS: ReasoningEffort[] = ['auto', 'max', 'high', 'medium', 'low', 'off'];
const SIMPLE_TOGGLE: ReasoningEffort[] = ['auto', 'high', 'off'];
const ALWAYS_TIERS: ReasoningEffort[] = ['auto', 'max', 'high', 'low'];

export function modelReasoningCapability(provider: ProviderConfig | undefined): ModelReasoningCapability {
  const model = (provider?.model ?? '').toLowerCase();
  const vendor = provider?.vendor ?? inferVendor(provider);
  const format = provider?.apiFormat ?? 'openai-chat';

  if (vendor === 'google' || format === 'gemini-generative' || model.includes('gemini')) {
    return { mode: 'budget', supported: true, options: ['auto', 'high', 'medium', 'low', 'off'], nativeField: 'thinkingConfig', description: 'Gemini 使用 thinking budget；不同型号预算上限不同。' };
  }
  if (vendor === 'zhipu' || /(^|[-_])glm[-_]?4\.(5|6)|glm[-_]?5(?!\.3)/.test(model)) {
    return { mode: 'toggle', supported: true, options: SIMPLE_TOGGLE, nativeField: 'thinking', description: 'GLM 当前模型主要使用开启/关闭思考模式。' };
  }
  if (vendor === 'zhipu' || /glm[-_]?5\.3/.test(model)) {
    return { mode: 'tiers', supported: true, options: ['auto', 'max', 'high', 'low'], nativeField: 'reasoning_effort', description: 'GLM-5.3 思考始终开启，不能关闭。' , alwaysOn: true };
  }
  if (vendor === 'deepseek' || model.includes('deepseek')) {
    // deepseek-reasoner 固定推理不能关闭；deepseek-chat 没有推理
    if (/deepseek.*(reasoner|r1|v3\.2|thinking)/.test(model)) {
      return { mode: 'tiers', supported: true, options: ['auto', 'max', 'high', 'low'], nativeField: 'reasoning_effort', description: 'DeepSeek 推理模型固定输出思考，不提供关闭选项（思考内容自动展示）。', alwaysOn: true };
    }
    return { mode: 'toggle', supported: false, options: ['auto', 'off'], nativeField: 'none', description: 'DeepSeek 非推理模型（chat/V3）不输出思考过程。' };
  }
  if (vendor === 'moonshot' || /kimi/i.test(model)) {
    // kimi-k2-thinking 固定推理；k2 非思考系没有推理
    if (/kimi[-_]?k2[^a-z0-9]*(thinking|reasoning)|kimi[-_]?k2\.5/.test(model)) {
      return { mode: 'tiers', supported: true, options: ALWAYS_TIERS, nativeField: 'reasoning_effort', description: 'Kimi 思考模型固定开启推理，思考内容自动展示。', alwaysOn: true };
    }
    return { mode: 'toggle', supported: false, options: ['auto', 'off'], nativeField: 'none', description: 'Kimi K2 非思考模型不输出推理过程。' };
  }
  if (vendor === 'xai' || /grok/i.test(model)) {
    // grok-4 系固定推理；grok-3-mini 接受 low|high 两档
    if (/grok[-_]?4/.test(model)) {
      return { mode: 'tiers', supported: true, options: ['auto', 'max', 'high', 'low'], nativeField: 'reasoning_effort', description: 'Grok-4 固定推理，不接受档位参数（思考内容自动展示）。', alwaysOn: true };
    }
    return { mode: 'tiers', supported: true, options: ['auto', 'high', 'low', 'off'], nativeField: 'reasoning_effort', description: 'Grok-3 系接受 low/high 两档（中档自动映射到 high）。' };
  }
  if (vendor === 'anthropic' || format === 'anthropic' || format === 'anthropic-messages') {
    if (/claude-(3-5|3-haiku|3-sonnet)/.test(model)) return { mode: 'toggle', supported: false, options: ['auto', 'off'], nativeField: 'thinking', description: '该 Claude 型号未确认支持 extended thinking。' };
    return { mode: 'tiers', supported: 'unknown', options: TIER_OPTIONS, nativeField: 'thinking', description: 'Anthropic 使用 thinking budget；未知型号将按 API 能力降级。' };
  }
  if (vendor === 'openai' || format === 'openai-chat' || format === 'openai-responses') {
    if (/^(o1|o3|o4)|gpt-5/.test(model)) return { mode: 'tiers', supported: true, options: ['auto', 'high', 'medium', 'low', 'off'], nativeField: format === 'openai-responses' ? 'reasoning_effort' : 'reasoning_effort', description: 'OpenAI reasoning_effort；max 会映射到 high。' };
    return { mode: 'toggle', supported: 'unknown', options: ['auto', 'high', 'off'], nativeField: 'reasoning_effort', description: '未知 OpenAI 兼容模型：先尝试 reasoning，拒绝后自动降级。' };
  }
  return { mode: 'unknown', supported: 'unknown', options: ['auto', 'off'], nativeField: 'unknown', description: '未知模型仅提供自动尝试和关闭。' };
}

function inferVendor(provider: ProviderConfig | undefined): string {
  if (!provider) return 'custom';
  if (provider.type === 'anthropic') return 'anthropic';
  if (provider.type === 'openai') return 'openai';
  return 'custom';
}

export function normalizeReasoningEffort(value: ReasoningEffort, capability: ModelReasoningCapability): ReasoningEffort {
  return capability.options.includes(value) ? value : capability.options[0] ?? 'off';
}
