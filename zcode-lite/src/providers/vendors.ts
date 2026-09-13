import type { ProviderName } from '../config/types.js';
export const openAiCompatibleProviders = new Set<ProviderName>(['openai', 'grok', 'glm', 'kimi', 'deepseek']);
