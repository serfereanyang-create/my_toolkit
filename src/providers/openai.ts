import type { Provider, ProviderRequest, ProviderResponse } from './types.js';
import { buildToolSystemPrompt, fetchWithRetry, parseToolActions, toToolAwareMessages } from './protocol.js';

export type OpenAIProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
};

export function createOpenAIProvider(options: OpenAIProviderOptions): Provider {
  return {
    name: 'openai',
    model: options.model,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error('OPENAI_API_KEY is required for provider openai');
      const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: 'system', content: buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy) }, ...toToolAwareMessages(request.messages)],
          temperature: 0.2,
        }),
      });
      if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
      const json = (await response.json()) as OpenAIChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      return { actions: parseToolActions(content), raw: json };
    },
  };
}

type OpenAIChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};
