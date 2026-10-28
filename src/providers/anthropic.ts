import type { AgentAction, AgentMessage, Provider, ProviderRequest, ProviderResponse } from './types.js';
import { controlledProvider } from './requestControl.js';
import { anthropicThinking, openaiReasoningEffort } from './reasoning.js';
import {
  buildToolSystemPromptParts,
  fetchWithRetry,
  iterateSseDataLines,
  parseAnthropicContentBlocks,
  parseToolActions,
  toAnthropicAwareMessages,
  toAnthropicTools,
} from './protocol.js';
import { cacheControl } from './cacheStrategy.js';
import { parseToolArguments } from './toolArguments.js';
import { createStreamMetrics } from './streamMetrics.js';

export type AnthropicProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
};

export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  const provider: Provider = {
    name: 'anthropic',
    model: options.model,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error('ANTHROPIC_API_KEY is required for provider anthropic');
      const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
      const tools = toAnthropicTools(request.tools);
      const systemParts = buildToolSystemPromptParts(request.tools, request.projectContext, request.toolStrategy, {
        workspaceRoot: request.workspaceRoot,
        desktopBridge: request.desktopBridge,
        delegation: request.delegation,
      });
      const buildBody = (thinking: ReturnType<typeof anthropicThinking>): Record<string, unknown> => {
        // When extended thinking is enabled, Anthropic requires temperature=1 and
        // max_tokens > budget_tokens. Otherwise keep the tight defaults.
        const body: Record<string, unknown> = {
          model: options.model,
          max_tokens: thinking ? thinking.budget_tokens + 2048 : 2048,
          temperature: thinking ? 1 : 0.2,
          stream: true,
          // Anthropic evaluates the prompt prefix in order: tools → system →
          // messages. Everything in `system` is therefore INSIDE the range the
          // sliding message breakpoint covers — so the per-turn tool strategy
          // must not go here. It used to, and because the strategy is
          // regenerated every turn, the conversation history could never be
          // cached: the cache covered only tools + the stable system block, and
          // every turn re-paid for the whole transcript. That is the ~70%
          // plateau measured in the usage ledger.
          //
          // It now rides on the last message (see `trailingStrategy`), which is
          // new input every request anyway.
          system: [
            { type: 'text', text: systemParts.stable, cache_control: cacheControl() },
          ],
          // Sliding message breakpoint: cache the entire conversation prefix so
          // each turn only pays for the newest messages (Claude Code-style 97%+
          // hit rate on long sessions).
          messages: toAnthropicAwareMessages(request.messages, {
            slidingCacheBreakpoint: true,
            trailingStrategy: systemParts.dynamic,
          }),
        };
        if (tools.length > 0) body.tools = tools;
        if (thinking) body.thinking = thinking;
        // Custom Anthropic-compatible gateways often expose reasoning under
        // the OpenAI-compatible field name; keep the native field too.
        if (request.customProvider) {
          const effort = openaiReasoningEffort(request.reasoningEffort);
          if (effort) body.reasoning_effort = effort;
        }
        return body;
      };

      // Real transparent passthrough with automatic downgrade: try the requested
      // thinking budget first; if the endpoint rejects the thinking param (custom
      // proxies often don't support it), retry once without it rather than failing.
      const thinking = anthropicThinking(request.reasoningEffort);
      const requestMetrics = createStreamMetrics('sse');
      let response = await fetchWithRetry(`${baseUrl}/messages`, {
        signal: request.signal,
        method: 'POST',
        headers: buildAnthropicHeaders(options.apiKey, request.customProvider),
        body: JSON.stringify(buildBody(thinking)),
      });
      if (!response.ok && thinking && isThinkingRejection(response.status)) {
        response = await fetchWithRetry(`${baseUrl}/messages`, {
          signal: request.signal,
          method: 'POST',
          headers: buildAnthropicHeaders(options.apiKey, request.customProvider),
          body: JSON.stringify(buildBody(undefined)),
        });
      }
      if (!response.ok) throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);

      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolBlocks = new Map<number, { id?: string; name?: string; inputJson: string }>();
      const events: unknown[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens: number | undefined;
      let cacheCreationTokens: number | undefined;
      const applyUsage = (value: unknown) => {
        const usage = normalizeAnthropicUsage(value);
        if (!usage) return;
        if (usage.inputTokens !== undefined) inputTokens = usage.inputTokens;
        if (usage.outputTokens !== undefined) outputTokens = usage.outputTokens;
        if (usage.cacheReadTokens !== undefined) cacheReadTokens = usage.cacheReadTokens;
        if (usage.cacheCreationTokens !== undefined) cacheCreationTokens = usage.cacheCreationTokens;
      };

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType.includes('application/json')) {
        const metrics = createStreamMetrics('json');
        const json = await response.json() as Record<string, unknown>;
        metrics.event();
        events.push(json);
        applyUsage(json.usage ?? (json.message as Record<string, unknown> | undefined)?.usage);
        const content = Array.isArray(json.content) ? json.content as Array<Record<string, unknown>> : [];

        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
          if (block.type === 'thinking' && typeof block.thinking === 'string') thinkingParts.push(block.thinking);
        }
        metrics.output(textParts.join('') || thinkingParts.join(''));
        const actions = parseAnthropicContentBlocks(content);
        const usage = buildProviderUsage(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
        return { actions, thinking: thinkingParts.join('') || undefined, usage, streamMetrics: metrics.finish(), raw: { response: json, text: textParts.join('') } };
      }

      const metrics = requestMetrics;
      for await (const data of iterateSseDataLines(response, undefined, request.signal, (data) => { if (data && data !== '[DONE]') metrics.event(); })) {
        if (data === '[DONE]') break;
        if (!data) continue;
        let json: AnthropicStreamEvent;
        try {
          json = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          continue;
        }
        events.push(json);

        if (json.type === 'message_start' && json.message?.usage) {
          applyUsage(json.message?.usage);
          continue;
        }
        if (json.type === 'message_delta' && json.usage) {
          applyUsage(json.usage);
          continue;
        }

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
            metrics.output(json.delta.text);
            request.onTextDelta?.(json.delta.text);
          }
          if (json.delta.type === 'thinking_delta' && typeof json.delta.thinking === 'string' && json.delta.thinking) {
            thinkingParts.push(json.delta.thinking);
            metrics.output(json.delta.thinking);
            request.onThinkingDelta?.(json.delta.thinking);
          }
          if (json.delta.type === 'input_json_delta' && typeof json.delta.partial_json === 'string') {
            const index = typeof json.index === 'number' ? json.index : 0;
            const current = toolBlocks.get(index) ?? { inputJson: '' };
            current.inputJson += json.delta.partial_json;
            toolBlocks.set(index, current);
          }
        }
      }

      const usage = buildProviderUsage(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);

      if (toolBlocks.size > 0) {
        const actions: AgentAction[] = [...toolBlocks.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, block]) => ({
            type: 'tool' as const,
            tool: block.name ?? 'unknown_tool',
            input: parseToolArguments(block.inputJson).input,
          }))
          .filter((action) => action.tool !== 'unknown_tool');
        if (actions.length > 0) return { actions, thinking: thinkingParts.join('') || undefined, usage, streamMetrics: metrics.finish(), raw: { stream: events, text: textParts.join('') } };
      }

      const text = textParts.join('');
      if (text) return { actions: parseToolActions(text), thinking: thinkingParts.join('') || undefined, usage, streamMetrics: metrics.finish(), raw: { stream: events, text } };
      return { actions: parseAnthropicContentBlocks([]), thinking: thinkingParts.join('') || undefined, usage, streamMetrics: metrics.finish(), raw: { stream: events, text } };
    },
  };
  return controlledProvider(provider);
}

function buildAnthropicHeaders(apiKey: string, customProvider?: boolean): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    ...(customProvider ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}),
    accept: 'text/event-stream',
  };
}

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_hit_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    cache_hit_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    cache_hit_tokens?: number;
  };
};

export function normalizeAnthropicUsage(value: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
} | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as AnthropicUsage;
  const inputTokens = firstNumber(usage.input_tokens, usage.prompt_tokens);
  const outputTokens = firstNumber(usage.output_tokens, usage.completion_tokens);
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details;
  const cacheReadTokens = firstNumber(
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.cache_hit_tokens,
    usage.prompt_cache_hit_tokens,
    details?.cached_tokens,
    details?.cache_read_tokens,
    details?.cache_hit_tokens,
  );
  const cacheCreationTokens = firstNumber(
    usage.cache_creation_input_tokens,
    usage.cache_creation_tokens,
    details?.cache_creation_tokens,
  );
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheCreationTokens === undefined) return undefined;
  // Anthropic's own `input_tokens` is NET of the cached part, but an
  // OpenAI-compatible proxy speaking this protocol only has `prompt_tokens`,
  // which INCLUDES it. Every consumer adds input + cacheRead, so the inclusive
  // number must be adjusted or the cached tokens are counted twice. A relay
  // that also reports cache creation includes that too
  // (prompt_tokens = read + creation + fresh input), so both are removed —
  // but only when they actually fit inside prompt_tokens; some relays report
  // creation outside it, and clamping to 0 would invent a wrong total.
  let netInput = inputTokens;
  if (usage.input_tokens === undefined && usage.prompt_tokens !== undefined) {
    const read = cacheReadTokens ?? 0;
    const creation = cacheCreationTokens ?? 0;
    if (read + creation <= usage.prompt_tokens) netInput = usage.prompt_tokens - read - creation;
    else if (read <= usage.prompt_tokens) netInput = usage.prompt_tokens - read;
  }
  return { inputTokens: netInput, outputTokens, cacheReadTokens, cacheCreationTokens };
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function buildProviderUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
) {
  return (inputTokens > 0 || outputTokens > 0 || cacheReadTokens !== undefined || cacheCreationTokens !== undefined)
    ? {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      }
    : undefined;
}

/**
 * Whether an error status likely means the endpoint rejected the `thinking`
 * parameter (unsupported by the proxy/model), so we can retry once without it.
 * 400/404/422 are the common "bad param / not found / unprocessable" codes.
 */
function isThinkingRejection(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  message?: {
    usage?: AnthropicUsage;
  };
  usage?: AnthropicUsage;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
};
