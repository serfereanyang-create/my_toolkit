import type { AgentAction, Provider, ProviderRequest, ProviderResponse } from './types.js';
import {
  buildToolSystemPrompt,
  fetchWithRetry,
  iterateSseDataLines,
  parseOpenAIToolCalls,
  parseToolActions,
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
        stream: true,
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
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);

      const contentParts: string[] = [];
      const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
      const events: unknown[] = [];

      for await (const data of iterateSseDataLines(response)) {
        if (!data || data === '[DONE]') continue;
        let json: OpenAIStreamChunk;
        try {
          json = JSON.parse(data) as OpenAIStreamChunk;
        } catch {
          continue;
        }
        events.push(json);
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          contentParts.push(delta.content);
          request.onTextDelta?.(delta.content);
        }
        for (const call of delta.tool_calls ?? []) {
          const index = typeof call.index === 'number' ? call.index : 0;
          const current = toolCalls.get(index) ?? { arguments: '' };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name = `${current.name ?? ''}${call.function.name}`;
          if (typeof call.function?.arguments === 'string') current.arguments += call.function.arguments;
          toolCalls.set(index, current);
        }
      }

      const content = contentParts.join('');
      if (toolCalls.size > 0) {
        const actions: AgentAction[] = [...toolCalls.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, call]) => ({
            type: 'tool' as const,
            tool: call.name ?? 'unknown_tool',
            input: parseArgs(call.arguments),
          }))
          .filter((action) => action.tool !== 'unknown_tool');
        if (actions.length > 0) return { actions, raw: { stream: events, content } };
      }

      return {
        actions: content ? parseToolActions(content) : parseOpenAIToolCalls({ content }),
        raw: { stream: events, content },
      };
    },
  };
}

function parseArgs(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};
