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
      const messages = [
        {
          role: 'system',
          content: buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy),
        },
        ...toToolAwareMessages(request.messages),
      ];

      try {
        return await completeStreaming({
          baseUrl,
          apiKey: options.apiKey,
          model: options.model,
          messages,
          tools,
          onTextDelta: request.onTextDelta,
        });
      } catch (streamError) {
        // Stream drops (undici "terminated", proxy idle kill) are common on long tool turns.
        // Retry once non-streaming so the agent can still finish after tools ran.
        try {
          return await completeNonStreaming({
            baseUrl,
            apiKey: options.apiKey,
            model: options.model,
            messages,
            tools,
          });
        } catch {
          throw streamError instanceof Error ? streamError : new Error(String(streamError));
        }
      }
    },
  };
}

async function completeStreaming(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  tools: ReturnType<typeof toOpenAITools>;
  onTextDelta?: (delta: string) => void;
}): Promise<ProviderResponse> {
  const body: Record<string, unknown> = {
    model: options.model,
    stream: true,
    messages: options.messages,
    temperature: 0.2,
  };
  if (options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }

  const response = await fetchWithRetry(`${options.baseUrl}/chat/completions`, {
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
  let streamError: unknown;

  try {
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
        options.onTextDelta?.(delta.content);
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
  } catch (error) {
    streamError = error;
  }

  const content = contentParts.join('');
  const fromTools = actionsFromToolCalls(toolCalls);
  if (fromTools.length > 0) {
    return { actions: fromTools, raw: { stream: events, content, partial: Boolean(streamError) } };
  }
  if (content.trim()) {
    return {
      actions: parseToolActions(content),
      raw: { stream: events, content, partial: Boolean(streamError) },
    };
  }
  if (streamError) {
    throw streamError instanceof Error ? streamError : new Error(String(streamError));
  }
  return {
    actions: parseOpenAIToolCalls({ content }),
    raw: { stream: events, content },
  };
}

async function completeNonStreaming(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  tools: ReturnType<typeof toOpenAITools>;
}): Promise<ProviderResponse> {
  const body: Record<string, unknown> = {
    model: options.model,
    stream: false,
    messages: options.messages,
    temperature: 0.2,
  };
  if (options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }

  const response = await fetchWithRetry(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const message = json.choices?.[0]?.message;
  const content = typeof message?.content === 'string' ? message.content : '';
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
  for (const [index, call] of (message?.tool_calls ?? []).entries()) {
    toolCalls.set(index, {
      id: call.id,
      name: call.function?.name,
      arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '',
    });
  }
  const fromTools = actionsFromToolCalls(toolCalls);
  if (fromTools.length > 0) return { actions: fromTools, raw: { nonStream: json, content } };
  return {
    actions: content ? parseToolActions(content) : parseOpenAIToolCalls({ content }),
    raw: { nonStream: json, content },
  };
}

function actionsFromToolCalls(toolCalls: Map<number, { id?: string; name?: string; arguments: string }>): AgentAction[] {
  return [...toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, call]) => ({
      type: 'tool' as const,
      tool: call.name ?? 'unknown_tool',
      input: parseArgs(call.arguments),
    }))
    .filter((action) => action.tool !== 'unknown_tool');
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
