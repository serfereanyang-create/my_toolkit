import { describe, expect, it } from 'vitest';
import { modelReasoningCapability } from './modelCapabilities';

describe('model reasoning capabilities', () => {
  it('uses toggle options for GLM 4.6', () => {
    const result = modelReasoningCapability({ id: 'glm', type: 'custom', label: 'GLM', model: 'glm-4.6', baseUrl: '', vendor: 'zhipu', apiFormat: 'openai-chat' });
    expect(result.mode).toBe('toggle');
    expect(result.options).toEqual(['auto', 'high', 'off']);
  });
  it('does not expose off for always-on DeepSeek reasoning', () => {
    const result = modelReasoningCapability({ id: 'deepseek', type: 'custom', label: 'DeepSeek', model: 'deepseek-reasoner', baseUrl: '', vendor: 'deepseek', apiFormat: 'openai-chat' });
    expect(result.alwaysOn).toBe(true);
    expect(result.options).not.toContain('off');
  });
  it('uses Gemini budget mode', () => {
    const result = modelReasoningCapability({ id: 'gemini', type: 'custom', label: 'Gemini', model: 'gemini-2.5-pro', baseUrl: '', vendor: 'google', apiFormat: 'gemini-generative' });
    expect(result.mode).toBe('budget');
    expect(result.nativeField).toBe('thinkingConfig');
  });
});
