import type { AgentAction, Provider, ProviderRequest, ProviderResponse } from './types.js';
import { controlledProvider } from './requestControl.js';
import { fetchWithRetry, iterateSseDataLines, readProviderJson, resolveProviderBodyKind, toOpenAIResponsesTools, buildToolSystemPromptParts } from './protocol.js';
import { isReasoningParamRejection, openaiReasoningEffort } from './reasoning.js';
import { createStreamMetrics } from './streamMetrics.js';
import { parseToolArguments } from './toolArguments.js';

export type OpenAIResponsesProviderOptions = { apiKey?: string; baseUrl?: string; model: string };

function collectText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.text === 'string') parts.push(obj.text);
    if (Array.isArray(obj.content)) for (const content of obj.content) {
      if (content && typeof content === 'object' && typeof (content as Record<string, unknown>).text === 'string') parts.push((content as Record<string, string>).text);
    }
  }
  return parts.join('');
}

function collectThinking(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.reasoning_content === 'string') parts.push(obj.reasoning_content);
    if (Array.isArray(obj.summary)) for (const summary of obj.summary) {
      if (summary && typeof summary === 'object' && typeof (summary as Record<string, unknown>).text === 'string') parts.push((summary as Record<string, string>).text);
    }
  }
  return parts.join('') || undefined;
}

function usageFromResponse(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const details = usage.input_tokens_details;
  const cached = details && typeof details === 'object' && typeof (details as Record<string, unknown>).cached_tokens === 'number'
    ? (details as Record<string, number>).cached_tokens : undefined;
  if (promptTokens <= 0 && outputTokens <= 0) return undefined;
  // `input_tokens` includes the cached part; see usageFromOpenAI for why the
  // shared shape is net-of-cache.
  const inputTokens = cached === undefined ? promptTokens : Math.max(0, promptTokens - cached);
  return { inputTokens, outputTokens, ...(cached !== undefined ? { cacheReadTokens: cached } : {}) };
}

function parseResponseActions(output: unknown): AgentAction[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const obj = item as Record<string, unknown>;
    if (obj.type !== 'function_call' || typeof obj.name !== 'string' || typeof obj.arguments !== 'string') return [];
    const input = parseToolArguments(obj.arguments).input;
    return [{ type: 'tool' as const, tool: obj.name, input, callId: typeof obj.call_id === 'string' ? obj.call_id : undefined }];
  });
}

export function createOpenAIResponsesProvider(options: OpenAIResponsesProviderOptions): Provider {
  const provider: Provider = {
    name: 'openai-responses',
    model: options.model,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error('OPENAI_API_KEY is required for provider openai-responses');
      const base = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      // previous_response_id continuation is an OpenAI first-party feature:
      // custom endpoints (proxy/relay gateways) reject it with 400. For those,
      // replay the whole conversation from request.messages instead — tool
      // results are already appended there, so context stays complete.
      const officialOpenAI = !options.baseUrl || options.baseUrl.startsWith('https://api.openai.com');
      const useServerContinuation = Boolean(request.continuation?.responseId)
        && request.customProvider !== true
        && officialOpenAI;
      // Responses API: instructions 是独立于 input 的稳定前缀段（自动缓存）。
      // 只放 stable 部分；每轮变化的 toolStrategy 尾置为最后一条 input 项，
      // 否则 instructions 每轮字节变化 → 自动前缀缓存整体失效。
      const systemParts = buildToolSystemPromptParts(request.tools, request.projectContext, request.toolStrategy, {
        workspaceRoot: request.workspaceRoot,
        desktopBridge: request.desktopBridge,
        delegation: request.delegation,
      });
      const input: unknown[] = useServerContinuation && request.continuation?.toolOutputs?.length
        ? request.continuation.toolOutputs.map((item) => ({ type: 'function_call_output', call_id: item.callId, output: item.output }))
        : request.messages.filter((message) => message.role !== 'system').flatMap((message) => {
          const items: unknown[] = [{
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: message.name ? `[tool:${message.name}] ${message.content}` : message.content,
          }];
          // Computer-control screenshots ride on tool messages; the Responses
          // API takes images as a separate user input_image item.
          if ((message.role === 'user' || message.role === 'tool') && message.parts) {
            for (const part of message.parts) {
              if (part.type === 'image') {
                items.push({ role: 'user', content: [{ type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` }] });
              }
            }
          }
          return items;
        });
      if (systemParts.dynamic && systemParts.dynamic.trim()) {
        input.push({ role: 'system', content: systemParts.dynamic });
      }
      const body: Record<string, unknown> = {
        model: options.model,
        input,
        tools: toOpenAIResponsesTools(request.tools),
        tool_choice: 'auto',
      };
      // Same contract as chat/completions: the shared system prompt asks for
      // one tool call per turn, and only this field makes that true on the wire.
      // Only sent when there are tools, so a strict gateway sees no stray field.
      if (request.tools.length > 0) body.parallel_tool_calls = false;
      if (useServerContinuation) body.previous_response_id = request.continuation!.responseId;
      // Caller-supplied system messages are session-stable instructions: keep
      // them at the head of the stable prefix instead of silently dropping
      // them, so custom deployments that pass a system message are honored.
      const callerSystem = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => (typeof message.content === 'string' ? message.content.trim() : ''))
        .filter(Boolean)
        .join('\n\n');
      const instructions = [callerSystem, systemParts.stable].filter((part) => part && part.trim()).join('\n\n');
      if (instructions) body.instructions = instructions;
      const effort = openaiReasoningEffort(request.reasoningEffort);
      if (effort) body.reasoning = { effort };
      body.stream = true;
      const requestMetrics = createStreamMetrics('sse');
      const postResponses = () => fetchWithRetry(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify(body), signal: request.signal });
      let response = await postResponses();
      if (!response.ok) {
        const errorText = await response.text();
        // 未知自定义端点可能不认 reasoning 参数：4xx 点名 reasoning 时降级一次
        // （去掉档位重发），而不是让整轮失败。
        if (isReasoningParamRejection(response.status, errorText) && body.reasoning) {
          delete body.reasoning;
          response = await postResponses();
          if (!response.ok) throw new Error(`OpenAI Responses request failed: ${response.status} ${await response.text()}`);
        } else {
          throw new Error(`OpenAI Responses request failed: ${response.status} ${errorText}`);
        }
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream') && await resolveProviderBodyKind(response) !== 'sse') {
        const metrics = createStreamMetrics('json');
        const json = await readProviderJson(response, 'OpenAI Responses') as Record<string, unknown>;
        metrics.event();
        const toolActions = parseResponseActions(json.output);
        const text = typeof json.output_text === 'string' ? json.output_text : collectText(json.output);
        const thinking = typeof json.reasoning_content === 'string' ? json.reasoning_content : collectThinking(json.output);
        metrics.output(text || thinking || '');
        const continuation = typeof json.id === 'string' && toolActions.length > 0 ? { responseId: json.id, status: 'pending' as const, updatedAt: new Date().toISOString() } : undefined;
        return { actions: toolActions.length ? toolActions : [{ type: 'message', content: text || '(empty response)' }], thinking, continuation, usage: usageFromResponse(json.usage), streamMetrics: metrics.finish(), raw: json };
      }

      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      // Keyed by the function-call item's `call_id` when known, otherwise by its
      // `item_id`. The delta events carry `item_id` (not `call_id`) and used to
      // be looked up by `call_id`, so no delta ever landed: every tool call whose
      // arguments streamed in was dropped and the turn ended on "(empty
      // response)". A final `arguments` payload from *.done is authoritative.
      const calls = new Map<string, { callId?: string; name: string; args: string; complete: boolean }>();
      const itemKeys = new Map<string, string>();
      const attribute = (event: Record<string, unknown>): { callId?: string; name: string; args: string; complete: boolean } | undefined => {
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        if (itemId && itemKeys.has(itemId)) return calls.get(itemKeys.get(itemId)!);
        if (typeof event.call_id === 'string' && calls.has(event.call_id)) return calls.get(event.call_id);
        if (itemId && calls.has(itemId)) return calls.get(itemId);
        return undefined;
      };
      const recordItem = (item: Record<string, unknown>, complete: boolean) => {
        if (item.type !== 'function_call' || typeof item.name !== 'string') return;
        const key = typeof item.call_id === 'string' && item.call_id ? item.call_id
          : typeof item.id === 'string' && item.id ? item.id : '';
        if (!key) return;
        const entry = calls.get(key) ?? { name: '', args: '', complete: false };
        entry.name = item.name;
        if (typeof item.call_id === 'string' && item.call_id) entry.callId = item.call_id;
        if (typeof item.arguments === 'string' && item.arguments) entry.args = item.arguments;
        entry.complete = entry.complete || complete;
        calls.set(key, entry);
        if (typeof item.id === 'string' && item.id) itemKeys.set(item.id, key);
      };
      const events: unknown[] = [];
      let responseId: string | undefined;
      let usage: ProviderResponse['usage'];
      const metrics = requestMetrics;
      for await (const data of iterateSseDataLines(response, undefined, request.signal, (data) => { if (data && data !== '[DONE]') metrics.event(); })) {
        if (data === '[DONE]') break;
        if (!data) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
        events.push(event);
        const type = typeof event.type === 'string' ? event.type : '';
        if (type === 'response.output_text.delta') {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          if (delta) { textParts.push(delta); metrics.output(delta); request.onTextDelta?.(delta); }
        } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
          if (typeof event.delta === 'string' && event.delta) {
            thinkingParts.push(event.delta);
            metrics.output(event.delta);
            request.onThinkingDelta?.(event.delta);
          }
        } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : {};
          if (item.type === 'function_call') recordItem(item, type.endsWith('done'));
        } else if (type === 'response.function_call_arguments.delta') {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          let current = attribute(event);
          if (!current) {
            // Some relays announce deltas before (or without) output_item.added.
            const key = typeof event.item_id === 'string' ? event.item_id : typeof event.call_id === 'string' ? event.call_id : '';
            if (!key) continue;
            current = { name: '', args: '', complete: false };
            calls.set(key, current);
            if (typeof event.item_id === 'string') itemKeys.set(event.item_id, key);
          }
          current.args += delta;
          if (delta) metrics.output(delta);
        } else if (type === 'response.function_call_arguments.done') {
          const current = attribute(event);
          // The done payload repeats the complete argument string; take it
          // verbatim so a dropped delta cannot leave truncated JSON behind.
          if (current) {
            if (typeof event.arguments === 'string') current.args = event.arguments;
            current.complete = true;
          }
        } else if (type === 'response.completed') {
          const result = event.response && typeof event.response === 'object' ? event.response as Record<string, unknown> : {};
          if (typeof result.id === 'string') responseId = result.id;
          usage = usageFromResponse(result.usage);
        } else if (type === 'response.failed' || type === 'error') {
          throw new Error(`OpenAI Responses stream failed: ${typeof event.message === 'string' ? event.message : type}`);
        }
      }
      const toolActions: AgentAction[] = [];
      for (const [key, call] of calls) {
        if (!call.complete || !call.name) continue;
        const input = parseToolArguments(call.args || '{}').input;
        toolActions.push({ type: 'tool', tool: call.name, input, callId: call.callId ?? key });
      }
      const text = textParts.join('');
      const continuation = responseId && toolActions.length > 0 ? { responseId, pendingCalls: toolActions.filter((a): a is Extract<AgentAction, { type: 'tool' }> => a.type === 'tool').map((a) => ({ callId: a.callId!, name: a.tool })), status: 'pending' as const, updatedAt: new Date().toISOString() } : undefined;
      return { actions: toolActions.length ? toolActions : [{ type: 'message', content: text || '(empty response)' }], thinking: thinkingParts.join('') || undefined, continuation, usage, streamMetrics: metrics.finish(), raw: { events, responseId } };
    },
  };
  return controlledProvider(provider);
}
