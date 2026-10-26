import type { AppConfig } from '../config/types.js';
import type { Provider } from './types.js';
import { createAnthropicProvider } from './anthropic.js';
import { createMockProvider } from './mock.js';
import { createOpenAIProvider } from './openai.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAIResponsesProvider } from './openai-responses.js';
import { VENDOR_PROFILES } from './vendors.js';

export function createProvider(config: AppConfig): Provider {
  if (config.provider === 'mock') return createMockProvider(config.model);
  if (config.provider === 'openai') return createOpenAIProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
  if (config.provider === 'openai-responses') return createOpenAIResponsesProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
  if (config.provider === 'anthropic') return createAnthropicProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
  if (config.provider === 'gemini') return createGeminiProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
  // 厂商一等公民：grok / glm / kimi / deepseek 都走 OpenAI 兼容协议，
  // 但推理参数、默认端点、用量字段按各自档案适配。
  if (config.provider === 'grok' || config.provider === 'glm' || config.provider === 'kimi' || config.provider === 'deepseek') {
    return createOpenAIProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      vendor: VENDOR_PROFILES[config.provider],
    });
  }
  const _exhaustive: never = config.provider;
  throw new Error(`Unsupported provider: ${_exhaustive}`);
}
