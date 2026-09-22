import type { AgentAction, Provider, ProviderRequest, ProviderResponse, ReasoningEffort } from './types.js';
import { openaiReasoningEffort } from './reasoning.js';
import {
  fetchWithRetry,
  iterateSseDataLines,
  parseOpenAIToolCalls,
  parseToolActions,
  toOpenAITools,
  toToolAwareMessages,
} from './protocol.js';
import type { VendorProfile, VendorOpenAIUsage } from './vendors.js';
import { VENDOR_PROFILES, detectVendor } from './vendors.js';
import { buildToolSystemPromptParts } from './protocol.js';
import { buildAutoCacheMessages } from './cacheStrategy.js';

export type OpenAIProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  /** 厂商档案：grok/glm/kimi/deepseek 等 OpenAI 兼容厂商的差异化行为 */
  vendor?: VendorProfile;
};

export function createOpenAIProvider(options: OpenAIProviderOptions): Provider {
  return {
    name: 'openai',
    model: options.model,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error('OPENAI_API_KEY is required for provider openai');
      // 桌面自定义 provider 没有显式 vendor：按端点/模型名自动识别，
      // 让 x.ai / bigmodel.cn / moonshot / deepseek 的自定义配置自动获得厂商适配。
      const detectedVendorId = detectVendor(options.baseUrl, options.model);
      const vendor = options.vendor
        ?? (request.customProvider && detectedVendorId
          ? VENDOR_PROFILES[detectedVendorId]
          : undefined);
      const baseUrl = (options.baseUrl ?? vendor?.defaultBaseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      const tools = toOpenAITools(request.tools);
      // 自动前缀缓存布局（OpenAI/DeepSeek/Kimi/GLM/Grok 均为自动缓存，无参数可发）：
      // 稳定 system 在头部；每轮变化的 toolStrategy 尾置为最后一条 system 消息，
      // 使轮与轮之间 strategy 之前的整段字节一致 → 历史可命中。
      // 若 strategy 混入头部 system（旧行为），第一处字节差异就在提示开头，历史每轮重付。
      const systemParts = buildToolSystemPromptParts(request.tools, request.projectContext, request.toolStrategy, {
        workspaceRoot: request.workspaceRoot,
        desktopBridge: request.desktopBridge,
        delegation: request.delegation,
      });
      const messages = buildAutoCacheMessages(
        systemParts.stable,
        toToolAwareMessages(request.messages),
        systemParts.dynamic,
      );

      // Real transparent passthrough with automatic downgrade: map the requested
      // effort tier to reasoning_effort. If the endpoint rejects it (custom
      // proxies / non-reasoning models often 400), retry once without it.
      // Vendor-aware mode: the vendor profile builds the native body param instead.
      const effort = vendor ? undefined : openaiReasoningEffort(request.reasoningEffort);
      const vendorExtra = vendor
        ? vendor.reasoningBodyParam(request.reasoningEffort ?? 'auto', options.model)
        : undefined;

      try {
        return await completeStreaming({
          baseUrl,
          apiKey: options.apiKey,
          model: options.model,
          messages,
          tools,
          onTextDelta: request.onTextDelta,
          onThinkingDelta: request.onThinkingDelta,
          reasoningEffort: effort,
          vendorExtra,
          vendor,
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
            vendorExtra,
            vendor,
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
  onThinkingDelta?: (delta: string) => void;
  reasoningEffort?: 'low' | 'medium' | 'high';
  vendorExtra?: Record<string, unknown>;
  vendor?: VendorProfile;
}): Promise<ProviderResponse> {
  const buildBody = (withExtras: boolean): Record<string, unknown> => {
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
    if (withExtras && options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
    if (withExtras && options.vendorExtra) Object.assign(body, options.vendorExtra);
    return body;
  };

  const post = (withExtras: boolean) => fetchWithRetry(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(buildBody(withExtras)),
  });

  // Transparent passthrough with automatic downgrade. Two attempts:
  // 1. reasoning/厂商参数 + strategy 尾置（缓存最优布局）
  // 2. 去掉推理参数（自定义网关/非推理模型 400 时）
  const hasExtras = Boolean(options.reasoningEffort || options.vendorExtra);
  let response = await post(hasExtras);
  if (!response.ok && hasExtras && isParamRejection(response.status)) {
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
      if (json.usage) usage = usageFromOpenAI(json.usage, options.vendor);
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      const reasoning = typeof (delta as { reasoning_content?: unknown }).reasoning_content === 'string'
        ? (delta as { reasoning_content: string }).reasoning_content : '';
      if (reasoning) {
        reasoningParts.push(reasoning);
        options.onThinkingDelta?.(reasoning);
      }
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
  vendorExtra?: Record<string, unknown>;
  vendor?: VendorProfile;
}): Promise<ProviderResponse> {
  const buildBody = (withExtras: boolean): Record<string, unknown> => {
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
    if (withExtras && options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
    if (withExtras && options.vendorExtra) Object.assign(body, options.vendorExtra);
    return body;
  };

  const post = (withExtras: boolean) => fetchWithRetry(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(buildBody(withExtras)),
  });

  // Transparent passthrough + automatic downgrade. Two attempts:
  // 1. reasoning/厂商参数 + strategy 尾置（缓存最优布局）
  // 2. 去掉推理参数（自定义网关/非推理模型 400 时）
  const hasExtras = Boolean(options.reasoningEffort || options.vendorExtra);
  let response = await post(hasExtras);
  if (!response.ok && hasExtras && isParamRejection(response.status)) {
    response = await post(false);
  }
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  const json = (await response.json()) as {
    usage?: VendorOpenAIUsage;
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const usage = usageFromOpenAI(json.usage, options.vendor);
  const message = json.choices?.[0]?.message;
  const content = typeof message?.content === 'string' ? message.content : '';
  // 非流式下部分厂商把推理文本放在 message.reasoning_content
  const thinking = typeof message?.reasoning_content === 'string' && message.reasoning_content
    ? message.reasoning_content : undefined;
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
  for (const [index, call] of (message?.tool_calls ?? []).entries()) {
    toolCalls.set(index, {
      id: call.id,
      name: call.function?.name,
      arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '',
    });
  }
  const fromTools = actionsFromToolCalls(toolCalls);
  if (fromTools.length > 0) return { actions: fromTools, usage, thinking, raw: { nonStream: json, content } };
  return {
    actions: content ? parseToolActions(content) : parseOpenAIToolCalls({ content }),
    usage,
    thinking,
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

// Normalize OpenAI's usage block to our real-token shape. Returns undefined when
// no usage was reported so we never persist fabricated zeros.
// Vendor-aware: DeepSeek 等厂商的缓存命中在专有字段 prompt_cache_hit_tokens。
function usageFromOpenAI(
  usage: VendorOpenAIUsage | undefined,
  vendor?: VendorProfile
): { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined {
  if (!usage) return undefined;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;

  const cacheReadTokens = vendor?.extractCacheReadTokens
    ? vendor.extractCacheReadTokens(usage)
    : typeof usage.prompt_tokens_details?.cached_tokens === 'number'
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
  usage?: VendorOpenAIUsage;
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
