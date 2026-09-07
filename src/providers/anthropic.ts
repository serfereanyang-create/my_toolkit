import type { AgentAction, AgentMessage, Provider, ProviderRequest, ProviderResponse } from './types.js';
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
      const systemParts = buildToolSystemPromptParts(request.tools, request.projectContext, request.toolStrategy, {
        workspaceRoot: request.workspaceRoot,
        desktopBridge: request.desktopBridge,
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
          // messages. The tools block (21K+ tokens for 245 tools) is serialized
          // before system, so its cache_control breakpoint covers tools + system
          // stable prefix as one continuous cached segment. The system-level
          // breakpoint would sit AFTER tools, splitting the cache into
          // "tools-only" and "system-only" entries — the observed pattern of
          // read=14.6K/system-hit + 16.8K/tools-repaid per turn. One breakpoint
          // at the end of system keeps the whole 33K prefix in a single entry.
          system: systemParts.dynamic
            ? [
                { type: 'text', text: systemParts.stable },
                { type: 'text', text: systemParts.dynamic, cache_control: { type: 'ephemeral' } },
              ]
            : [
                { type: 'text', text: systemParts.stable, cache_control: { type: 'ephemeral' } },
              ],
          // Sliding message breakpoint: cache the entire conversation prefix so
          // each turn only pays for the newest messages (Claude Code-style 97%+
          // hit rate on long sessions).
          messages: toAnthropicAwareMessages(request.messages, { slidingCacheBreakpoint: true }),
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
      let response = await fetchWithRetry(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(buildBody(thinking)),
      });
      if (!response.ok && thinking && isThinkingRejection(response.status)) {
        response = await fetchWithRetry(`${baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': '2023-06-01',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(buildBody(undefined)),
        });
      }
      if (!response.ok) throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);

      const textParts: string[] = [];
      const toolBlocks = new Map<number, { id?: string; name?: string; inputJson: string }>();
      const events: unknown[] = [];
      // Real token usage: Anthropic reports input_tokens in message_start and the
      // running output_tokens in message_delta. Capture both so the agent can
      // persist genuine numbers (never estimated).
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens: number | undefined;
      let cacheCreationTokens: number | undefined;

      for await (const data of iterateSseDataLines(response)) {
        if (!data || data === '[DONE]') continue;
        let json: AnthropicStreamEvent;
        try {
          json = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          continue;
        }
        events.push(json);

        if (json.type === 'message_start' && json.message?.usage) {
          const u = json.message.usage;
          if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
          if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
          if (typeof u.cache_read_input_tokens === 'number') cacheReadTokens = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') cacheCreationTokens = u.cache_creation_input_tokens;
          continue;
        }
        if (json.type === 'message_delta' && json.usage) {
          const u = json.usage;
          if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
          if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
          if (typeof u.cache_read_input_tokens === 'number') cacheReadTokens = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') cacheCreationTokens = u.cache_creation_input_tokens;
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

      const usage = (inputTokens > 0 || outputTokens > 0)
        ? {
            inputTokens,
            outputTokens,
            ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
          }
        : undefined;

      if (toolBlocks.size > 0) {
        const actions: AgentAction[] = [...toolBlocks.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, block]) => ({
            type: 'tool' as const,
            tool: block.name ?? 'unknown_tool',
            input: parseJsonObject(block.inputJson),
          }))
          .filter((action) => action.tool !== 'unknown_tool');
        if (actions.length > 0) return { actions, usage, raw: { stream: events, text: textParts.join('') } };
      }

      const text = textParts.join('');
      if (text) return { actions: parseToolActions(text), usage, raw: { stream: events, text } };
      return { actions: parseAnthropicContentBlocks([]), usage, raw: { stream: events, text } };
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

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

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
    partial_json?: string;
  };
};
