import type { AgentMessage, Provider, ProviderRequest, ProviderResponse } from './types.js';
import {
  buildToolSystemPrompt,
  fetchWithRetry,
  parseAnthropicContentBlocks,
  toAnthropicTools,
} from './protocol.js';

export type AnthropicProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
};

export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  return {
    name: 'anthropic',
    model: options.model,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error('ANTHROPIC_API_KEY is required for provider anthropic');
      const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
      const tools = toAnthropicTools(request.tools);
      const body: Record<string, unknown> = {
        model: options.model,
        max_tokens: 2048,
        temperature: 0.2,
        system: buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy),
        messages: toAnthropicMessages(request.messages),
      };
      if (tools.length > 0) body.tools = tools;

      const response = await fetchWithRetry(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);
      const json = (await response.json()) as AnthropicMessagesResponse;
      return {
        actions: parseAnthropicContentBlocks(json.content as Array<Record<string, unknown>> | undefined),
        raw: json,
      };
    },
  };
}

function toAnthropicMessages(messages: AgentMessage[]) {
  const converted = messages.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.name ? `[tool:${message.name}] ${message.content}` : message.content,
  }));
  return converted.length > 0 ? converted : [{ role: 'user', content: 'Start.' }];
}

type AnthropicMessagesResponse = {
  content?: Array<Record<string, unknown>>;
};
