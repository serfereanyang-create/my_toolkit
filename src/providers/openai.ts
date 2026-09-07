import type { AgentAction, Provider, ProviderRequest, ProviderResponse, ReasoningEffort } from './types.js';
import { openaiReasoningEffort } from './reasoning.js';
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
          content: buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy, {
            workspaceRoot: request.workspaceRoot,
            desktopBridge: request.desktopBridge,
          }),
        },
        ...toToolAwareMessages(request.messages),
      ];

      // Real transparent passthrough with automatic downgrade: map the requested
      // effort tier to reasoning_effort. If the endpoint rejects it (custom
      // proxies / non-reasoning models often 400), retry once without it.
      const effort = openaiReasoningEffort(request.reasoningEffort);

      try {
        return await completeStreaming({
          baseUrl,
          apiKey: options.apiKey,
          model: options.model,
          messages,
          tools,
          onTextDelta: request.onTextDelta,
          reasoningEffort: effort,
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
            reasoningEffort: effort,
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
  reasoningEffort?: 'low' | 'medium' | 'high';
}): Promise<ProviderResponse> {
  const buildBody = (withEffort: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: options.model,
      stream: true,
      // Ask the API to emit a final usage chunk in stream mode so we can persist
      // real token counts (OpenAI omits usage from streams unless requested).
      stream_options: { include_usage: true },
      messages: options.messages,
      temperature: 0.2,
    };
    if (options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = 'auto';
    }
    if (withEffort && options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
    return body;
  };

  const post = (withEffort: boolean) => fetchWithRetry(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(buildBody(withEffort)),
  });

  // Transparent passthrough with automatic downgrade: try reasoning_effort first;
  // if the endpoint rejects the param, retry once without it rather than failing.
  let response = await post(Boolean(options.reasoningEffort));
  if (!response.ok && options.reasoningEffort && isParamRejection(response.status)) {
    response = await post(false);
  }
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
  const events: unknown[] = [];
  let usage: ProviderResponse['usage'];
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
      if (json.usage) usage = usageFromOpenAI(json.usage);
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      const reasoning = typeof (delta as { reasoning_content?: unknown }).reasoning_content === 'string'
        ? (delta as { reasoning_content: string }).reasoning_content : '';
      if (reasoning) reasoningParts.push(reasoning);
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
      return { actions: fromTools, usage, thinking: reasoningParts.join('') || undefined, raw: { stream: events, content, partial: Boolean(streamError) } };
  }
  if (content.trim()) {
    return {
      actions: parseToolActions(content),
      usage,
      thinking: reasoningParts.join('') || undefined,
      raw: { stream: events, content, partial: Boolean(streamError) },
    };
  }
  if (streamError) {
    throw streamError instanceof Error ? streamError : new Error(String(streamError));
  }
  return {
    actions: parseOpenAIToolCalls({ content }),
    usage,
    raw: { stream: events, content },
  };
}

async function completeNonStreaming(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  tools: ReturnType<typeof toOpenAITools>;
  reasoningEffort?: 'low' | 'medium' | 'high';
}): Promise<ProviderResponse> {
  const buildBody = (withEffort: boolean): Record<string, unknown> => {
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
    if (withEffort && options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
    return body;
  };

  const post = (withEffort: boolean) => fetchWithRetry(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(buildBody(withEffort)),
  });

  // Transparent passthrough + automatic downgrade: retry without reasoning_effort
  // if the endpoint rejects it.
  let response = await post(Boolean(options.reasoningEffort));
  if (!response.ok && options.reasoningEffort && isParamRejection(response.status)) {
    response = await post(false);
  }
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  const json = (await response.json()) as {
    usage?: OpenAIUsage;
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
  const usage = usageFromOpenAI(json.usage);
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
  if (fromTools.length > 0) return { actions: fromTools, usage, raw: { nonStream: json, content } };
  return {
    actions: content ? parseToolActions(content) : parseOpenAIToolCalls({ content }),
    usage,
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

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

// Normalize OpenAI's usage block to our real-token shape. Returns undefined when
// no usage was reported so we never persist fabricated zeros.
function usageFromOpenAI(usage: OpenAIUsage | undefined): { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined {
  if (!usage) return undefined;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  // OpenAI reports prompt-cache hits under prompt_tokens_details.cached_tokens.
  const cacheReadTokens = typeof usage.prompt_tokens_details?.cached_tokens === 'number'
    ? usage.prompt_tokens_details.cached_tokens
    : undefined;
  return cacheReadTokens !== undefined ? { inputTokens, outputTokens, cacheReadTokens } : { inputTokens, outputTokens };
}

// A custom proxy or non-reasoning model rejects unknown params with 400/404/422.
// Treat those as "downgrade" signals so we retry once without the extra param.
function isParamRejection(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

type OpenAIStreamChunk = {
  usage?: OpenAIUsage;
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
