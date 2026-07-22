import type { AgentAction, AgentMessage, Provider, ProviderRequest, ProviderResponse } from './types.js';
import {
  buildToolSystemPrompt,
  fetchWithRetry,
  iterateSseDataLines,
  parseAnthropicContentBlocks,
  parseToolActions,
  toAnthropicAwareMessages,
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
        stream: true,
        system: buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy),
        messages: toAnthropicAwareMessages(request.messages),
      };
      if (tools.length > 0) body.tools = tools;

      const response = await fetchWithRetry(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);

      const textParts: string[] = [];
      const toolBlocks = new Map<number, { id?: string; name?: string; inputJson: string }>();
      const events: unknown[] = [];

      for await (const data of iterateSseDataLines(response)) {
        if (!data || data === '[DONE]') continue;
        let json: AnthropicStreamEvent;
        try {
          json = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          continue;
        }
        events.push(json);

        if (json.type === 'content_block_start' && json.content_block) {
          const index = typeof json.index === 'number' ? json.index : 0;
          if (json.content_block.type === 'tool_use') {
            toolBlocks.set(index, {
              id: typeof json.content_block.id === 'string' ? json.content_block.id : undefined,
              name: typeof json.content_block.name === 'string' ? json.content_block.name : undefined,
              inputJson: '',
            });
          }
          continue;
        }

        if (json.type === 'content_block_delta' && json.delta) {
          if (json.delta.type === 'text_delta' && typeof json.delta.text === 'string' && json.delta.text) {
            textParts.push(json.delta.text);
            request.onTextDelta?.(json.delta.text);
          }
          if (json.delta.type === 'input_json_delta' && typeof json.delta.partial_json === 'string') {
            const index = typeof json.index === 'number' ? json.index : 0;
            const current = toolBlocks.get(index) ?? { inputJson: '' };
            current.inputJson += json.delta.partial_json;
            toolBlocks.set(index, current);
          }
        }
      }

      if (toolBlocks.size > 0) {
        const actions: AgentAction[] = [...toolBlocks.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, block]) => ({
            type: 'tool' as const,
            tool: block.name ?? 'unknown_tool',
            input: parseJsonObject(block.inputJson),
          }))
          .filter((action) => action.tool !== 'unknown_tool');
        if (actions.length > 0) return { actions, raw: { stream: events, text: textParts.join('') } };
      }

      const text = textParts.join('');
      if (text) return { actions: parseToolActions(text), raw: { stream: events, text } };
      return { actions: parseAnthropicContentBlocks([]), raw: { stream: events, text } };
    },
  };
}

function parseJsonObject(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
};
