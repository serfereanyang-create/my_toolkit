import type { AppConfig } from '../config/types.js';
import type { Provider } from './types.js';
import { createAnthropicProvider } from './anthropic.js';
import { createMockProvider } from './mock.js';
import { createOpenAIProvider } from './openai.js';

export function createProvider(config: AppConfig): Provider {
  if (config.provider === 'mock') return createMockProvider(config.model);
  if (config.provider === 'openai') return createOpenAIProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
  if (config.provider === 'anthropic') return createAnthropicProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
  throw new Error(`Unsupported provider: ${config.provider satisfies never}`);
}
