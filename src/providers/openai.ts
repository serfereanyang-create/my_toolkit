import type { Provider, ProviderRequest, ProviderResponse } from './types.js';
import {
  buildToolSystemPrompt,
  fetchWithRetry,
  parseOpenAIToolCalls,
  toOpenAITools,
  toToolAwareMessages,
} from './protocol.js';

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
      const tools = toOpenAITools(request.tools);
      const body: Record<string, unknown> = {
        model: options.model,
        messages: [
          {
            role: 'system',
            content: buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy),
          },
          ...toToolAwareMessages(request.messages),
        ],
        temperature: 0.2,
      };
      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
      const json = (await response.json()) as OpenAIChatResponse;
      const message = json.choices?.[0]?.message ?? {};
      return { actions: parseOpenAIToolCalls(message), raw: json };
    },
  };
}

type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};
