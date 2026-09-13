import type { AppConfig } from '../config/types.js';
import type { Provider } from './types.js';
import { AnthropicProvider } from './anthropic.js'; import { MockProvider } from './mock.js'; import { OpenAiProvider } from './openai.js';
export * from './types.js';
export function createProvider(config: AppConfig): Provider { if (config.provider === 'mock') return new MockProvider(); if (config.provider === 'anthropic') return new AnthropicProvider(config); return new OpenAiProvider(config); }
